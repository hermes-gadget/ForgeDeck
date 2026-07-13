import assert from "node:assert/strict";
import test from "node:test";
import { redactLogContext, redactSensitive } from "./logger.js";

test("redactSensitive removes common credential formats", () => {
  assert.equal(redactSensitive("Authorization: Bearer abc.def-123"), "Authorization: [REDACTED]");
  assert.equal(redactSensitive("password=hunter2"), "password=[REDACTED]");
  assert.equal(redactSensitive("token=ghp_1234567890abcdef"), "token=[REDACTED]");
});

test("redactLogContext handles sensitive keys and nested error messages", () => {
  const context = redactLogContext({
    token: "should-not-appear",
    request: { authorization: "Bearer should-not-appear", value: "safe" },
    error: new Error("password=should-not-appear")
  });

  assert.equal(context.token, "[REDACTED]");
  assert.deepEqual(context.request, { authorization: "[REDACTED]", value: "safe" });
  assert.equal((context.error as { message: string }).message, "password=[REDACTED]");
  assert.doesNotMatch(JSON.stringify(context), /should-not-appear/);
});
