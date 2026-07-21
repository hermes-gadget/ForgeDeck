import assert from "node:assert/strict";
import test from "node:test";
import {
  boundMcpDiffOutput,
  compactValue,
  MAX_MCP_RESPONSE_DIFF_CHARS,
  summarizeAgentMessages,
  summarizeLastActivity,
  summarizeSessionFiles,
  summarizeSessionHealth,
  summarizeThread,
  summarizeTurns,
  summarizeTurnsPage
} from "./mcp-presenters.js";

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

test("MCP session presenters expose recent agent text and last turn activity", () => {
  const thread = {
    updatedAt: "2026-07-17T12:04:00.000Z",
    turns: [
      { completedAt: "2026-07-17T12:01:00.000Z", items: [{ type: "agentMessage", text: "First" }] },
      { completedAt: "2026-07-17T12:03:00.000Z", items: [
        { type: "fileChange", changes: [{ path: "app.ts", diff: "large" }] },
        { type: "agentMessage", text: "Second" },
        { type: "agentMessage", text: "Latest" }
      ] }
    ]
  };

  assert.deepEqual(summarizeAgentMessages(thread.turns, 2), ["Second", "Latest"]);
  assert.equal(summarizeLastActivity(thread), "2026-07-17T12:03:00.000Z");
});

test("MCP session health distinguishes idle, stalled, failed, and normal sessions", () => {
  const active = new Set(["thread-health"]);
  const now = Date.parse("2026-07-17T12:05:00.000Z");
  const base = {
    id: "thread-health",
    status: { type: "active" },
    updatedAt: "2026-07-17T12:00:00.000Z"
  };

  assert.equal(summarizeSessionHealth({ ...base, turns: [] }, active, now), "idle");
  assert.equal(summarizeSessionHealth({
    ...base,
    turns: [{ status: "inProgress", startedAt: "2026-07-17T12:00:00.000Z", items: [] }]
  }, active, now), "stalled");
  assert.equal(summarizeSessionHealth({
    ...base,
    guardian: { lastActivityAt: "2026-07-17T12:04:30.000Z" },
    turns: [{ status: "inProgress", startedAt: "2026-07-17T12:00:00.000Z", items: [] }]
  }, active, now), "ok");
  assert.equal(summarizeSessionHealth({
    ...base,
    status: { type: "idle" },
    turns: [{ status: "completed", error: { message: "Claude exited with status 1" }, items: [] }]
  }, new Set(), now), "error");
  assert.equal(summarizeSessionHealth({
    ...base,
    status: { type: "idle" },
    turns: [{ status: "interrupted", items: [] }]
  }, new Set(), now), "error");
  assert.equal(summarizeSessionHealth({
    ...base,
    status: { type: "idle" },
    turns: [{ status: "completed", items: [] }]
  }, new Set(), now), "ok");
});

test("MCP session files combine turn changes and artifacts within the workspace", () => {
  const files = summarizeSessionFiles({
    cwd: "/workspace",
    turns: [{ items: [{ changes: [
      { path: "/workspace/src/older.ts" },
      { path: "src/current.ts" },
      { path: "/etc/passwd" }
    ] }] }]
  }, [
    { type: "PatchArtifact", content: { files: ["src/current.ts", "src/patched.ts"] } },
    { type: "FileArtifact", content: { path: "docs/result.md" } }
  ]);

  assert.deepEqual(files, ["docs/result.md", "src/patched.ts", "src/current.ts", "src/older.ts"]);
});

test("MCP turn summaries cap text and individual file diffs", () => {
  const longText = "x".repeat(9_000);
  const diff = "+".repeat(9_000);
  const turns = summarizeTurns([{ id: "turn-1", status: "completed", items: [
    { id: "message-1", type: "agentMessage", text: longText },
    { id: "change-1", type: "fileChange", changes: [{ path: "app.ts", diff }] }
  ] }], 10) as Array<{ items: Array<Record<string, unknown>> }>;

  assert.match(String(turns[0].items[0].text), /truncated for MCP response/);
  assert.equal(((turns[0].items[1].changes as Array<{ diff: string }>)[0].diff).length, 8_000);
  assert.match(((turns[0].items[1].changes as Array<{ diff: string }>)[0].diff), /truncated for MCP response/);
  assert.equal(String(compactValue(longText)).length < longText.length, true);
});

test("MCP turn pages default to recent chronological items and cursor backward without drift", () => {
  const turns = [{ id: "turn-1", status: "completed", items: Array.from({ length: 40 }, (_, index) => ({
    id: `item-${index}`,
    type: "agentMessage",
    text: String(index)
  })) }];
  const first = summarizeTurnsPage(turns, { threadId: "thread-12345678", limit: 30 });
  const firstItems = (first.turns[0] as { items: Array<{ id: string }> }).items;
  assert.deepEqual(firstItems.map((item) => item.id), Array.from({ length: 30 }, (_, index) => `item-${index + 10}`));
  assert.deepEqual(first.pagination, {
    limit: 30,
    offset: 0,
    returned_items: 30,
    total_items: 40,
    has_more: true,
    next_offset: 30,
    next_cursor: first.pagination.next_cursor
  });

  turns[0].items.push({ id: "item-40", type: "agentMessage", text: "40" });
  const second = summarizeTurnsPage(turns, {
    threadId: "thread-12345678",
    limit: 30,
    cursor: first.pagination.next_cursor!
  });
  const secondItems = (second.turns[0] as { items: Array<{ id: string }> }).items;
  assert.deepEqual(secondItems.map((item) => item.id), Array.from({ length: 10 }, (_, index) => `item-${index}`));
  assert.equal(second.pagination.offset, 31, "the cursor remains anchored when a newer item arrives");
  assert.equal(second.pagination.has_more, false);
});

test("MCP response diff and patch fields share one aggregate character budget", () => {
  const bounded = boundMcpDiffOutput({
    changes: Array.from({ length: 10 }, (_, index) => ({ diff: String(index).repeat(10_000) })),
    artifact: { content: { patch: "p".repeat(20_000) } },
    explanation: "e".repeat(50_000)
  }) as { changes: Array<{ diff: string }>; artifact: { content: { patch: string } }; explanation: string };
  const diffChars = bounded.changes.reduce((total, change) => total + change.diff.length, 0)
    + bounded.artifact.content.patch.length;
  assert.equal(diffChars, MAX_MCP_RESPONSE_DIFF_CHARS);
  assert.equal(bounded.explanation.length, 50_000, "non-diff response fields are unaffected by the aggregate patch budget");
});
