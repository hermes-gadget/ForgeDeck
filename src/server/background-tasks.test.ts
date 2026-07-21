import assert from "node:assert/strict";
import test from "node:test";
import { BackgroundTaskSupervisor } from "./background-tasks.js";

test("background tasks retry within a fixed bound and recover health", async () => {
  let calls = 0;
  const supervisor = new BackgroundTaskSupervisor({ wait: async () => undefined });
  supervisor.register({
    name: "inventory",
    safeFailureMessage: "Inventory refresh is unavailable",
    intervalMs: 1_000,
    maxAttempts: 3,
    task: () => {
      calls += 1;
      if (calls < 3) throw new Error("raw provider failure");
    }
  });

  await supervisor.runNow("inventory");

  assert.equal(calls, 3);
  assert.deepEqual(supervisor.getHealth().tasks[0]?.status, "ok");
  assert.equal(supervisor.getHealth().tasks[0]?.error, null);
});

test("background task health exposes only a typed safe failure", async () => {
  let calls = 0;
  const supervisor = new BackgroundTaskSupervisor({ wait: async () => undefined });
  supervisor.register({
    name: "cleanup",
    safeFailureMessage: "Session cleanup needs attention",
    intervalMs: 1_000,
    maxAttempts: 2,
    task: () => {
      calls += 1;
      throw new Error("/secret/provider/path");
    }
  });

  await supervisor.runNow("cleanup");

  const health = supervisor.getHealth();
  assert.equal(calls, 2);
  assert.equal(health.status, "degraded");
  assert.equal(health.tasks[0]?.error?.type, "BackendUnavailableError");
  assert.equal(health.tasks[0]?.error?.message, "Session cleanup needs attention");
  assert.doesNotMatch(JSON.stringify(health), /secret\/provider/);
});
