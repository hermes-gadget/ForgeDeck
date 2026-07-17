import assert from "node:assert/strict";
import test from "node:test";
import { AsyncTtlCache, KeyedAsyncTtlCache } from "./async-cache.js";

test("async TTL cache coalesces refreshes and expires values", async () => {
  let now = 1_000;
  let loads = 0;
  const cache = new AsyncTtlCache(100, () => now);
  const load = async () => ++loads;

  assert.deepEqual(await Promise.all([cache.get(load), cache.get(load)]), [1, 1]);
  assert.equal(await cache.get(load), 1);
  now += 101;
  assert.equal(await cache.get(load), 2);
});

test("async TTL cache does not retain rejected refreshes", async () => {
  const cache = new AsyncTtlCache<number>(100);
  await assert.rejects(() => cache.get(async () => { throw new Error("temporary"); }), /temporary/);
  assert.equal(await cache.get(async () => 42), 42);
});

test("keyed async TTL cache separates keys and invalidates in-flight loads", async () => {
  let now = 1_000;
  const cache = new KeyedAsyncTtlCache<number>(100, 2, () => now);
  let resolveFirst!: (value: number) => void;
  const first = cache.get("sessions", () => new Promise((resolve) => { resolveFirst = resolve; }));

  await Promise.resolve();
  cache.clear();
  resolveFirst(1);
  assert.equal(await first, 1);
  assert.equal(await cache.get("sessions", async () => 2), 2, "an invalidated in-flight load is not cached");
  assert.equal(await cache.get("other", async () => 3), 3);
  now += 101;
  assert.equal(await cache.get("sessions", async () => 4), 4);
});
