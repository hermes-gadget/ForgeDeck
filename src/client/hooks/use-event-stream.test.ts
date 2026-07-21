import assert from "node:assert/strict";
import test from "node:test";
import { LIVE_OUTPUT_BUDGET_BYTES, liveOutputByteSize, threadStore } from "../state/thread-store.js";
import {
  AutomaticErrorGate, effectiveFallbackPollInterval, eventStreamUrl, reconnectBackoffDelay, RevisionSequence,
  RemovedSessionGate, reversesSessionRemoval, shouldRefreshDetailDuringRecovery, type RecoveryReason
} from "./use-event-stream.js";
import type { LiveRecoverySnapshot } from "../types.js";

test("live-only preferences still receive a conservative polling fallback", () => {
  assert.equal(effectiveFallbackPollInterval(0), 10_000);
  assert.equal(effectiveFallbackPollInterval(Number.NaN), 10_000);
  assert.equal(effectiveFallbackPollInterval(4_000), 4_000);
});

test("stream reconnect delay backs off exponentially and stays bounded", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(reconnectBackoffDelay), [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
});

test("automatic refresh failures report once per outage and re-arm after recovery", () => {
  const gate = new AutomaticErrorGate();
  const reported: unknown[] = [];
  const failure = new Error("detail unavailable");

  assert.equal(gate.report("detail:thread-1", failure, (error) => reported.push(error)), true);
  assert.equal(gate.report("detail:thread-1", new Error("detail unavailable"), (error) => reported.push(error)), false);
  assert.equal(reported.length, 1);

  gate.resolve("detail:thread-1");
  assert.equal(gate.report("detail:thread-1", failure, (error) => reported.push(error)), true);
  assert.equal(reported.length, 2);
});

test("intentional session removals suppress late events until the session is restored", () => {
  const gate = new RemovedSessionGate();

  gate.markRemoved("thread-removed");
  assert.equal(gate.has("thread-removed"), true);
  assert.equal(gate.has("thread-other"), false);

  gate.markPresent("thread-removed");
  assert.equal(gate.has("thread-removed"), false);

  assert.equal(reversesSessionRemoval("updated", "completion_gates_unmet"), false);
  assert.equal(reversesSessionRemoval("updated", "archive_failed"), true);
  assert.equal(reversesSessionRemoval("updated", "restored"), true);
  assert.equal(reversesSessionRemoval("created", undefined), true);
});

test("fallback polling does not re-request a broken selected-thread detail", () => {
  assert.equal(shouldRefreshDetailDuringRecovery("poll"), false);
  assert.equal(shouldRefreshDetailDuringRecovery("reconnect"), true);
  assert.equal(shouldRefreshDetailDuringRecovery("gap"), true);
});

test("event stream URLs carry the browser id and a stable unique thread selection", () => {
  assert.equal(
    eventStreamUrl("browser-1", ["thread-22222222", "thread-11111111", "thread-22222222"]),
    "/events?clientId=browser-1&threadId=thread-11111111&threadId=thread-22222222"
  );
});

test("scoped revision sequences accept gaps caused by unsubscribed threads", () => {
  const applied: number[] = [];
  let recoveries = 0;
  const sequence = new RevisionSequence(async () => {
    recoveries += 1;
    return 20;
  }, undefined, true);
  sequence.establish(10);
  sequence.observe(12, () => applied.push(12));
  sequence.observe(15, () => applied.push(15));
  assert.deepEqual(applied, [12, 15]);
  assert.equal(recoveries, 0);
  assert.equal(sequence.currentRevision, 15);
});

test("a revision gap applies an authoritative snapshot before later deltas", async () => {
  const threadId = "revision-gap-thread";
  const recoveries: RecoveryReason[] = [];
  const sequence = new RevisionSequence(async (reason) => {
    recoveries.push(reason);
    const snapshot: LiveRecoverySnapshot = {
      revision: 13,
      threadRevisions: { [threadId]: 13 },
      data: {
        [threadId]: {
          items: {},
          agentText: { message: "authoritative" },
          toolOutput: {},
          active: true,
          completedAt: null,
          updatedAt: new Date(1_000).toISOString(),
          tokenUsage: { totalTokens: 21 },
          truncated: false,
          truncatedItemIds: []
        }
      },
      queues: { [threadId]: [] },
      activeThreadIds: [threadId]
    };
    threadStore.applyRecoverySnapshot(snapshot);
    return snapshot.revision;
  });
  sequence.establish(10);
  sequence.observe(11, () => threadStore.applyEvent({
    type: "live/agent-text", threadId, revision: 11, deltas: { message: "partial" }
  }));
  sequence.observe(13, () => assert.fail("the event covered by the recovery boundary must not replay"));

  await sequence.settled();
  assert.deepEqual(recoveries, ["gap"]);
  assert.equal(sequence.currentRevision, 13);
  assert.equal(threadStore.getLive(threadId).agentText.message, "authoritative");
  assert.equal(threadStore.getLive(threadId).tokenUsage?.totalTokens, 21);

  sequence.observe(14, () => threadStore.applyEvent({
    type: "live/agent-text", threadId, revision: 14, deltas: { message: " + live" }
  }));
  assert.equal(threadStore.getLive(threadId).agentText.message, "authoritative + live");
  threadStore.removeThread(threadId);
});

test("a stale recovery snapshot cannot overwrite a newer item or local UI state", () => {
  const threadId = "stale-snapshot-thread";
  threadStore.applyEvent({
    type: "live/item",
    threadId,
    revision: 20,
    completed: true,
    item: { id: "item-1", type: "agentMessage", text: "newer" }
  });
  threadStore.markCompleted(threadId, 2_000);
  threadStore.markCompletionSeen(threadId);
  threadStore.applyRecoverySnapshot({
    revision: 19,
    threadRevisions: { [threadId]: 19 },
    data: {
      [threadId]: {
        items: { "item-1": { id: "item-1", type: "agentMessage", text: "stale" } },
        agentText: {},
        toolOutput: {},
        active: false,
        completedAt: new Date(2_000).toISOString(),
        updatedAt: new Date(1_900).toISOString(),
        tokenUsage: null,
        truncated: false,
        truncatedItemIds: []
      }
    },
    queues: { [threadId]: [] },
    activeThreadIds: []
  });

  assert.equal(threadStore.getLive(threadId).items["item-1"]?.text, "newer");
  assert.equal(threadStore.getLive(threadId).completed, false);
  assert.equal(threadStore.getDomainSlices(threadId).localUi.completionSeenThrough, 2_000);
  threadStore.removeThread(threadId);
});

test("browser live overlays share one byte budget across all output items", () => {
  const threadId = "client-output-budget-thread";
  for (let index = 0; index < 8; index += 1) {
    threadStore.appendToolOutput(threadId, `command-${index}`, "🙂".repeat(30_000));
  }
  const live = threadStore.getLive(threadId);
  assert.equal(live.truncated, true);
  assert.ok(live.truncatedItemIds.length > 0);
  assert.ok(liveOutputByteSize(live) <= LIVE_OUTPUT_BUDGET_BYTES);
  threadStore.removeThread(threadId);
});

test("authoritative completed items evict browser delta buffers", () => {
  const threadId = "client-authoritative-item-thread";
  threadStore.appendToolOutput(threadId, "command-1", "streamed output");
  threadStore.applyEvent({
    type: "live/item",
    threadId,
    completed: true,
    item: { id: "command-1", type: "commandExecution", status: "completed", aggregatedOutput: "canonical output" }
  });
  assert.equal(threadStore.getLive(threadId).toolOutput["command-1"], undefined);
  threadStore.removeThread(threadId);
});
