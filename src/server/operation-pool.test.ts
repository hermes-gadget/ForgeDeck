import assert from "node:assert/strict";
import test from "node:test";
import { AdaptiveOperationPool, OperationPoolCancelledError, OperationPoolDeadlineError } from "./operation-pool.js";

test("operation pool bounds concurrency and round-robins between callers", async () => {
  const pool = new AdaptiveOperationPool({ name: "read", maxConcurrency: 2, latencyTargetMs: 10_000 });
  let active = 0;
  let maximum = 0;
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const task = (label: string, fairnessKey: string) => pool.run(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    order.push(label);
    await gate;
    active -= 1;
    return label;
  }, { fairnessKey });

  const running = [task("a1", "a"), task("a2", "a"), task("a3", "a"), task("b1", "b"), task("b2", "b")];
  await waitFor(() => active === 2);
  release();
  assert.deepEqual(await Promise.all(running), ["a1", "a2", "a3", "b1", "b2"]);
  assert.equal(maximum, 2);
  assert.deepEqual(order, ["a1", "a2", "a3", "b1", "b2"]);
  assert.equal(pool.metrics().completed, 5);
});

test("operation pool gives interactive work priority without starving background work", async () => {
  const pool = new AdaptiveOperationPool({ name: "read", maxConcurrency: 1, latencyTargetMs: 10_000, priorityBurst: 2 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const order: string[] = [];
  const first = pool.run(async () => { await gate; order.push("first"); });
  const background = pool.run(() => { order.push("background"); }, { priority: "background" });
  const interactive = [1, 2, 3].map((id) => pool.run(() => { order.push(`interactive-${id}`); }));
  release();
  await Promise.all([first, background, ...interactive]);
  assert.deepEqual(order, ["first", "interactive-1", "background", "interactive-2", "interactive-3"]);
});

test("operation pool reserves headroom for interactive work", async () => {
  const pool = new AdaptiveOperationPool({ name: "read", maxConcurrency: 2, latencyTargetMs: 10_000 });
  let activeBackground = 0;
  let interactiveStarted = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const background = [1, 2].map(() => pool.run(async () => {
    activeBackground += 1;
    await gate;
    activeBackground -= 1;
  }, { priority: "background" }));
  await waitFor(() => activeBackground === 1);
  const interactive = pool.run(() => { interactiveStarted = true; });
  await waitFor(() => interactiveStarted);
  assert.equal(activeBackground, 1);
  assert.equal(pool.metrics().backgroundLimit, 1);
  release();
  await Promise.all([...background, interactive]);
});

test("operation pool removes cancelled and expired queued work", async () => {
  const pool = new AdaptiveOperationPool({ name: "mutation", maxConcurrency: 1, latencyTargetMs: 10_000 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const running = pool.run(() => gate);
  const controller = new AbortController();
  const cancelled = pool.run(() => undefined, { signal: controller.signal });
  const expired = pool.run(() => undefined, { deadline: Date.now() + 5 });
  controller.abort(new Error("client disconnected"));
  await assert.rejects(cancelled, OperationPoolCancelledError);
  await assert.rejects(expired, OperationPoolDeadlineError);
  release();
  await running;
  assert.equal(pool.metrics().waitingCount, 0);
  assert.equal(pool.metrics().cancelled, 1);
  assert.equal(pool.metrics().deadlineExceeded, 1);
});

test("operation pool reduces concurrency on provider errors and reports saturation metrics", async () => {
  const pool = new AdaptiveOperationPool({
    name: "read",
    maxConcurrency: 8,
    minConcurrency: 2,
    latencyTargetMs: 10_000,
    adaptationCooldownMs: 0,
    isBackpressureError: (error) => (error as { status?: number }).status === 429
  });
  await assert.rejects(pool.run(() => Promise.reject(Object.assign(new Error("busy"), { status: 429 }))));
  const metrics = pool.metrics();
  assert.equal(metrics.effectiveLimit, 4);
  assert.equal(metrics.backpressureEvents, 1);
  assert.equal(metrics.adaptiveReductions, 1);
  assert.equal(metrics.recentErrorRate, 1);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Condition was not reached");
}
