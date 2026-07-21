import assert from "node:assert/strict";
import test from "node:test";
import { parseClaudeOutput } from "./claude-output.js";

test("Claude single-result JSON remains compatible", () => {
  const parsed = parseClaudeOutput([
    "user@host:~$ claude -p --output-format json ...",
    JSON.stringify({
      type: "result",
      result: "Finished the task",
      session_id: "11111111-1111-4111-8111-111111111111"
    })
  ].join("\n"), "turn-1");

  assert.equal(parsed.structured, true);
  assert.equal(parsed.displayText, "Finished the task");
  assert.equal(parsed.sessionId, "11111111-1111-4111-8111-111111111111");
  assert.equal(parsed.rateLimit, null);
  assert.deepEqual(parsed.items, [{ id: "turn-1-result", type: "agentMessage", text: "Finished the task" }]);
});

test("Claude stream-json becomes agent, command, and file progress items", () => {
  const sessionId = "22222222-2222-4222-8222-222222222222";
  const output = [
    "user@host:~$ claude -p --output-format stream-json ...",
    JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: "message-1",
        content: [
          { type: "text", text: "I’ll inspect the implementation." },
          { type: "tool_use", id: "tool-bash", name: "Bash", input: { command: "rg -n bug src" } }
        ]
      }
    }),
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tool-bash", content: "src/app.ts:10", is_error: false }] }
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: "message-2",
        content: [{
          type: "tool_use",
          id: "tool-edit",
          name: "Edit",
          input: { file_path: "/workspace/src/app.ts", old_string: "old", new_string: "new" }
        }]
      }
    })
  ].join("\n");

  const parsed = parseClaudeOutput(output, "turn-2");
  assert.equal(parsed.structured, true);
  assert.equal(parsed.sessionId, sessionId);
  assert.equal(parsed.displayText, "I’ll inspect the implementation.");
  assert.deepEqual(parsed.items.map((item) => [item.type, item.status]), [
    ["agentMessage", undefined],
    ["commandExecution", "completed"],
    ["fileChange", "inProgress"]
  ]);
  assert.equal(parsed.items[1].aggregatedOutput, "src/app.ts:10");
  assert.equal(parsed.items[2].changes?.[0]?.path, "/workspace/src/app.ts");
  assert.match(String(parsed.items[2].changes?.[0]?.diff), /-old\n\+new/);
});

test("the newest stream-json init excludes retained pane history", () => {
  const parsed = parseClaudeOutput([
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { id: "old", content: [{ type: "text", text: "old turn" }] } }),
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { id: "new", content: [{ type: "text", text: "new turn" }] } })
  ].join("\n"), "turn-3");

  assert.equal(parsed.displayText, "new turn");
  assert.equal(parsed.items.length, 1);
  assert.match(parsed.items[0].id || "", /new/);
});

test("command echoes are not presented as Claude output before structured data arrives", () => {
  const parsed = parseClaudeOutput("user@host:~$ claude -p --output-format stream-json ...", "turn-4");
  assert.equal(parsed.structured, false);
  assert.deepEqual(parsed.items, []);
  assert.equal(parsed.displayText, "");
});

test("Claude stream-json exposes Anthropic session-limit metadata", () => {
  const parsed = parseClaudeOutput([
    JSON.stringify({ type: "system", subtype: "init", session_id: "33333333-3333-4333-8333-333333333333" }),
    JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        resetsAt: 1_784_300_400,
        rateLimitType: "five_hour",
        overageStatus: "rejected",
        overageDisabledReason: "out_of_credits",
        isUsingOverage: false
      }
    }),
    JSON.stringify({
      type: "assistant",
      error: "rate_limit",
      message: { id: "limited", content: [{ type: "text", text: "You've hit your session limit" }] }
    }),
    JSON.stringify({ type: "result", api_error_status: 429, is_error: true, result: "You've hit your session limit" })
  ].join("\n"), "turn-5");

  assert.equal(parsed.displayText, "You've hit your session limit");
  assert.deepEqual(parsed.rateLimit, {
    status: "rejected",
    rateLimitType: "five_hour",
    resetsAt: 1_784_300_400,
    overageStatus: "rejected",
    overageDisabledReason: "out_of_credits",
    isUsingOverage: false
  });
});
