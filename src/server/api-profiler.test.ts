import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { ApiProfiler } from "./api-profiler.js";

test("API profiler aggregates route timings without request values", async () => {
  const profiler = new ApiProfiler(0);
  const app = express();
  app.use(profiler.middleware);
  app.get("/api/threads/:threadId", (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/threads/private-thread-id`);
    assert.equal(response.status, 200);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const snapshot = profiler.snapshot();
    assert.equal(snapshot["GET /api/threads/:threadId"]?.count, 1);
    assert.equal(Object.keys(snapshot).some((key) => key.includes("private-thread-id")), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("API profiler bounds cardinality from unknown paths", async () => {
  const profiler = new ApiProfiler(0, () => undefined, 2);
  const app = express();
  app.use(profiler.middleware);
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await Promise.all(["one", "two", "three", "four"].map((path) => fetch(`http://127.0.0.1:${address.port}/${path}`)));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(Object.keys(profiler.snapshot()).length <= 2);
    assert.ok((profiler.snapshot()["GET [other routes]"]?.count || 0) >= 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
