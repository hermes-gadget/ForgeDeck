import assert from "node:assert/strict";
import test from "node:test";
import { createRateLimiter } from "./rate-limit.js";
import type { NextFunction, Request, Response } from "express";

test("rate limiter allows requests up to the limit and returns JSON after it", () => {
  const middleware = createRateLimiter({ windowMs: 60_000, max: 2, key: () => "client" });
  let nextCalls = 0;
  let status = 200;
  let payload: unknown;
  const headers = new Map<string, string>();
  const request = { ip: "127.0.0.1", socket: {} } as Request;
  const response = {
    set(values: Record<string, string>) {
      for (const [key, value] of Object.entries(values)) headers.set(key, value);
      return this;
    },
    setHeader(key: string, value: string) { headers.set(key, value); },
    status(value: number) { status = value; return this; },
    json(value: unknown) { payload = value; return this; }
  } as unknown as Response;
  const next = (() => { nextCalls += 1; }) as NextFunction;

  middleware(request, response, next);
  middleware(request, response, next);
  middleware(request, response, next);
  assert.equal(nextCalls, 2);
  assert.equal(status, 429);
  assert.deepEqual(payload, { error: "Too many requests. Try again later.", code: "RATE_LIMITED", retryAfter: 60 });
  assert.equal(headers.get("RateLimit-Remaining"), "0");
  assert.equal(headers.get("Retry-After"), "60");
});
