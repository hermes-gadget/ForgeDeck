import assert from "node:assert/strict";
import test from "node:test";
import { CapacityCancelledError, CapacityManager, CapacityUnavailableError } from "./capacity.js";

test("capacity management queues fairly and hands a released slot to the next turn", async () => {
  const capacity = new CapacityManager({ "codex/standard": 1, "codex/spark": 2, claude: 1 });
  const first = await capacity.acquire("codex/standard", "turn-1", Date.now() + 1_000);
  const secondPromise = capacity.acquire("codex/standard", "turn-2", Date.now() + 1_000);

  assert.equal(first.operationId, "turn-1");
  assert.deepEqual(pickCounts(capacity, "codex/standard"), { activeCount: 1, waitingCount: 1 });
  assert.equal(capacity.release("turn-1"), "codex/standard");

  const second = await secondPromise;
  assert.equal(second.operationId, "turn-2");
  assert.equal(capacity.has("turn-1"), false);
  assert.equal(capacity.has("turn-2"), true);
  assert.deepEqual(pickCounts(capacity, "codex/standard"), { activeCount: 1, waitingCount: 0 });
});

test("capacity management rejects expired waits and reconciles recovered turns idempotently", async () => {
  const capacity = new CapacityManager({ "codex/standard": 1, "codex/spark": 1, claude: 1 });

  await assert.rejects(
    capacity.acquire("claude", "expired", Date.now() - 1),
    (error: unknown) => error instanceof CapacityUnavailableError && error.code === "BACKEND_CAPACITY_EXHAUSTED"
  );
  const recovered = capacity.reconcile("claude", "recovered-turn");
  assert.equal(recovered.reconciled, true);
  assert.strictEqual(capacity.reconcile("claude", "recovered-turn"), recovered);

  const metrics = capacity.metrics().claude;
  assert.equal(metrics.activeCount, 1);
  assert.equal(metrics.reconciliations, 1);
  assert.equal(metrics.rejections, 1);
});

test("capacity management removes a cancelled waiter", async () => {
  const capacity = new CapacityManager({ "codex/standard": 1, "codex/spark": 1, claude: 1 });
  await capacity.acquire("claude", "active", Date.now() + 1_000);
  const controller = new AbortController();
  const waiting = capacity.acquire("claude", "waiting", Date.now() + 1_000, controller.signal);
  controller.abort(new Error("request closed"));
  await assert.rejects(waiting, CapacityCancelledError);
  assert.equal(capacity.metrics().claude.waitingCount, 0);
  assert.equal(capacity.metrics().claude.cancellations, 1);
});

test("Claude capacity remains owned until one idempotent terminal release", async () => {
  const capacity = new CapacityManager({ "codex/standard": 1, "codex/spark": 1, claude: 1 });
  const first = await capacity.acquire("claude", "claude-turn-1", Date.now() + 1_000);
  let secondAccepted = false;
  const secondPromise = capacity.acquire("claude", "claude-turn-2", Date.now() + 1_000)
    .then((reservation) => {
      secondAccepted = true;
      return reservation;
    });

  assert.strictEqual(capacity.reconcile("claude", "claude-turn-1"), first);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(secondAccepted, false);
  assert.deepEqual(pickCounts(capacity, "claude"), { activeCount: 1, waitingCount: 1 });

  assert.equal(capacity.release("claude-turn-1"), "claude");
  assert.equal((await secondPromise).operationId, "claude-turn-2");
  assert.equal(capacity.release("claude-turn-1"), null);
  assert.deepEqual(pickCounts(capacity, "claude"), { activeCount: 1, waitingCount: 0 });
});

function pickCounts(capacity: CapacityManager, backend: "codex/standard" | "claude") {
  const { activeCount, waitingCount } = capacity.metrics()[backend];
  return { activeCount, waitingCount };
}
