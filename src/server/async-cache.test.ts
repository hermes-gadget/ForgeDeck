import assert from "node:assert/strict";
import test from "node:test";
import { AsyncTtlCache } from "./async-cache.js";

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
