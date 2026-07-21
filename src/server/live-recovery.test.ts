import assert from "node:assert/strict";
import test from "node:test";
import { LiveRecoveryStore, liveRecoveryByteSize } from "./live-recovery.js";

test("live recovery enforces one UTF-8 byte budget across every item and delta", () => {
  const recovery = new LiveRecoveryStore({ maxBytes: 2_048, now: () => 1_000 });
  recovery.markViewed("thread-budget");
  recovery.record({ method: "turn/started", params: { threadId: "thread-budget" } }, true);
  for (let index = 0; index < 8; index += 1) {
    recovery.record({
      method: "item/commandExecution/outputDelta",
      params: { threadId: "thread-budget", itemId: `item-${index}`, delta: "🙂".repeat(300) }
    }, true);
  }

  const snapshot = recovery.read("thread-budget");
  assert.ok(snapshot);
  assert.equal(snapshot.truncated, true);
  assert.ok(snapshot.truncatedItemIds.length > 0);
  assert.ok(liveRecoveryByteSize(snapshot) <= 2_048);
});

test("completed authoritative output evicts its transient delta buffer", () => {
  const recovery = new LiveRecoveryStore({ maxBytes: 8_192, now: () => 1_000 });
  recovery.markViewed("thread-complete");
  recovery.record({ method: "turn/started", params: { threadId: "thread-complete" } }, true);
  recovery.record({
    method: "item/commandExecution/outputDelta",
    params: { threadId: "thread-complete", itemId: "command-1", delta: "streamed output" }
  }, true);
  recovery.record({
    method: "item/completed",
    params: { threadId: "thread-complete", item: { id: "command-1", type: "commandExecution", aggregatedOutput: "canonical output" } }
  }, true);

  const snapshot = recovery.read("thread-complete");
  assert.ok(snapshot);
  assert.equal(snapshot.toolOutput["command-1"], undefined);
  assert.equal(snapshot.items["command-1"].aggregatedOutput, "canonical output");
});

test("inactive recovery is retained only for recently viewed threads", () => {
  let now = 1_000;
  const recovery = new LiveRecoveryStore({ maxBytes: 8_192, retentionMs: 500, now: () => now });
  recovery.record({ method: "turn/started", params: { threadId: "unviewed" } }, true);
  recovery.record({ method: "turn/completed", params: { threadId: "unviewed" } }, false);
  assert.equal(recovery.has("unviewed"), false);

  recovery.markViewed("viewed");
  recovery.record({ method: "turn/started", params: { threadId: "viewed" } }, true);
  recovery.record({ method: "turn/completed", params: { threadId: "viewed" } }, false);
  assert.equal(recovery.has("viewed"), true);
  now += 501;
  assert.equal(recovery.prune(), 1);
  assert.equal(recovery.has("viewed"), false);
});
