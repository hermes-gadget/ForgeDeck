import assert from "node:assert/strict";
import test from "node:test";
import { compactValue, summarizeThread, summarizeTurns } from "./mcp-utils.js";

test("MCP session summaries expose lifecycle and ownership without full payloads", () => {
  const summary = summarizeThread({
    id: "thread-123",
    name: "Audit",
    cwd: "/workspace",
    tags: ["maintenance"],
    category: "Engineering",
    status: { type: "active" }
  }, new Set(), true);

  assert.equal(summary.state, "running");
  assert.equal(summary.mutation_access, "allowed");
  assert.deepEqual(summary.tags, ["maintenance"]);
});

test("MCP turn summaries cap text while retaining complete file diffs", () => {
  const longText = "x".repeat(9_000);
  const diff = "+".repeat(9_000);
  const turns = summarizeTurns([{ id: "turn-1", status: "completed", items: [
    { id: "message-1", type: "agentMessage", text: longText },
    { id: "change-1", type: "fileChange", changes: [{ path: "app.ts", diff }] }
  ] }], 10) as Array<{ items: Array<Record<string, unknown>> }>;

  assert.match(String(turns[0].items[0].text), /\[truncated\]$/);
  assert.equal(((turns[0].items[1].changes as Array<{ diff: string }>)[0].diff), diff);
  assert.equal(String(compactValue(longText)).length < longText.length, true);
});
