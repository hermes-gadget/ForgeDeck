import assert from "node:assert/strict";
import test from "node:test";
import {
  RunGuardian,
  selectStrongerModel,
  type RunGuardianPersistence,
  type RunGuardianState
} from "./run-guardian.js";

test("guardian retries twice, escalates once, then notifies and pauses", async () => {
  let now = 1_000;
  const calls: string[] = [];
  const guardian = new RunGuardian(memoryPersistence(), {
    retry: async (threadId) => { calls.push(`retry:${threadId}`); },
    escalate: async (threadId) => { calls.push(`escalate:${threadId}`); return "gpt-5.6-sol"; },
    pause: async (threadId) => { calls.push(`pause:${threadId}`); }
  }, { now: () => now, checkIntervalMs: 1, persistenceIntervalMs: 1 });

  guardian.configure("thread-guardian", { stallTimeoutMs: 50 });
  guardian.activate("thread-guardian");

  now += 51;
  await guardian.checkNow();
  assert.equal(guardian.get("thread-guardian").phase, "retrying");
  assert.equal(guardian.get("thread-guardian").recoveryAttempts, 1);

  now += 51;
  await guardian.checkNow();
  assert.equal(guardian.get("thread-guardian").recoveryAttempts, 2);

  now += 51;
  await guardian.checkNow();
  assert.equal(guardian.get("thread-guardian").phase, "escalating");
  assert.equal(guardian.get("thread-guardian").actionModel, "gpt-5.6-sol");

  now += 51;
  await guardian.checkNow();
  const paused = guardian.get("thread-guardian");
  assert.equal(paused.phase, "paused");
  assert.equal(paused.active, false);
  assert.equal(paused.operatorNotifiedAt, now);
  assert.deepEqual(calls, [
    "retry:thread-guardian",
    "retry:thread-guardian",
    "escalate:thread-guardian",
    "pause:thread-guardian"
  ]);
});

test("activity moves a recovery back to monitoring without unbounding its counter", async () => {
  let now = 1_000;
  const guardian = new RunGuardian(memoryPersistence(), {
    retry: async () => undefined,
    escalate: async () => "gpt-5.6-sol",
    pause: async () => undefined
  }, { now: () => now, checkIntervalMs: 1, persistenceIntervalMs: 1 });
  guardian.configure("thread-progress", { stallTimeoutMs: 50 });
  guardian.activate("thread-progress");
  now += 51;
  await guardian.checkNow();
  now += 10;
  guardian.activity("thread-progress", true);
  assert.equal(guardian.get("thread-progress").phase, "monitoring");
  assert.equal(guardian.get("thread-progress").recoveryAttempts, 1);
  now += 49;
  await guardian.checkNow();
  assert.equal(guardian.get("thread-progress").phase, "monitoring");
});

test("persisted active guardians resume monitoring with their bounded attempt count", async () => {
  let now = 1_000;
  const persistence = memoryPersistence();
  const first = new RunGuardian(persistence, noActions(), {
    now: () => now,
    checkIntervalMs: 1,
    persistenceIntervalMs: 1
  });
  first.configure("thread-recovery", { stallTimeoutMs: 50 });
  first.activate("thread-recovery");
  now += 51;
  await first.checkNow();
  assert.equal(first.get("thread-recovery").recoveryAttempts, 1);

  let recoveredRetries = 0;
  now += 100;
  const recovered = new RunGuardian(persistence, {
    retry: async () => { recoveredRetries += 1; },
    escalate: async () => "gpt-5.6-sol",
    pause: async () => undefined
  }, { now: () => now, checkIntervalMs: 1, persistenceIntervalMs: 1 });
  recovered.activate("thread-recovery");
  assert.equal(recovered.get("thread-recovery").recoveredAt, now);
  await recovered.checkNow();
  assert.equal(recoveredRetries, 1);
  assert.equal(recovered.get("thread-recovery").recoveryAttempts, 2);
});

test("a failed recovery is terminal and exposes a safe error", async () => {
  let now = 1_000;
  const guardian = new RunGuardian(memoryPersistence(), {
    retry: async () => { throw new Error("last prompt is unavailable"); },
    escalate: async () => "unused",
    pause: async () => undefined
  }, { now: () => now, checkIntervalMs: 1, persistenceIntervalMs: 1 });
  guardian.configure("thread-failure", { stallTimeoutMs: 10 });
  guardian.activate("thread-failure");
  now += 11;
  await guardian.checkNow();
  assert.equal(guardian.get("thread-failure").phase, "failed");
  assert.equal(guardian.get("thread-failure").error, "last prompt is unavailable");
});

test("stronger model selection honors explicit policy and rejects lateral retries", () => {
  const available = ["gpt-5.3-codex", "gpt-5.6-sol", "gpt-5.3-codex-spark"];
  assert.equal(selectStrongerModel("gpt-5.3-codex", available), "gpt-5.6-sol");
  assert.equal(selectStrongerModel("gpt-5.3-codex", available, "gpt-5.6-sol"), "gpt-5.6-sol");
  assert.throws(() => selectStrongerModel("gpt-5.6-sol", available), /No stronger model/);
  assert.throws(() => selectStrongerModel("gpt-5.3-codex", available, "gpt-5.3-codex"), /must differ/);
});

function memoryPersistence(initial: RunGuardianState[] = []): RunGuardianPersistence {
  const states = new Map(initial.map((state) => [state.threadId, structuredClone(state)]));
  return {
    load: () => [...states.values()].map((state) => structuredClone(state)),
    save: (state) => { states.set(state.threadId, structuredClone(state)); },
    remove: (threadId) => states.delete(threadId)
  };
}

function noActions() {
  return {
    retry: async () => undefined,
    escalate: async () => "gpt-5.6-sol",
    pause: async () => undefined
  };
}
