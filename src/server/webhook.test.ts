import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { verifyWebhookSignature, webhookIdempotencyKey, webhookTriggerResource } from "./webhook.js";
import type { SessionOperation } from "./session-manager.js";

test("webhook signatures authenticate the exact raw request bytes", () => {
  const secret = "test-webhook-secret";
  const body = Buffer.from('{"blueprint":"Release agent","variables":{"SERVICE":"checkout"}}');
  const signature = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;

  assert.equal(verifyWebhookSignature(body, signature, secret), true);
  assert.equal(verifyWebhookSignature(Buffer.from(`${body.toString()}\n`), signature, secret), false);
  assert.equal(verifyWebhookSignature(body, "sha256=invalid", secret), false);
  assert.equal(verifyWebhookSignature(body, undefined, secret), false);
});

test("webhook idempotency keys are required, bounded, and namespaced", () => {
  assert.equal(webhookIdempotencyKey(" github-delivery-1 "), "webhook:github-delivery-1");
  assert.throws(() => webhookIdempotencyKey(undefined), /Idempotency-Key/);
  assert.throws(() => webhookIdempotencyKey("x".repeat(201)), /Idempotency-Key/);
  assert.throws(() => webhookIdempotencyKey("line\nbreak"), /Idempotency-Key/);
});

test("webhook resources expose only queued, running, or error states and deep-link sessions", () => {
  const pending = operation({ status: "pending" });
  assert.deepEqual(webhookTriggerResource(pending, "https://deck.example.test"), {
    status: "queued",
    operationId: pending.id,
    operationUrl: `https://deck.example.test/api/operations/${pending.id}`,
    sessionUrl: null,
    error: null
  });

  const running = operation({ status: "succeeded", remoteThreadId: "thread-12345678" });
  assert.equal(webhookTriggerResource(running, "https://deck.example.test").status, "running");
  assert.equal(
    webhookTriggerResource(running, "https://deck.example.test").sessionUrl,
    "https://deck.example.test/?session=thread-12345678"
  );

  const failed = operation({ status: "failed", error: { code: "CREATE_FAILED" } });
  assert.deepEqual(webhookTriggerResource(failed, "https://deck.example.test").error, { code: "CREATE_FAILED" });
  assert.equal(webhookTriggerResource(failed, "https://deck.example.test").status, "error");
});

function operation(overrides: Partial<SessionOperation>): SessionOperation {
  return {
    id: "123e4567-e89b-42d3-a456-426614174000",
    kind: "create",
    idempotencyKey: "webhook:delivery-1",
    requestFingerprint: "fingerprint",
    status: "pending",
    step: "queued",
    remoteThreadId: null,
    attemptCount: 0,
    input: {},
    compensation: {},
    result: null,
    error: null,
    nextAttemptAt: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    completedAt: null,
    ...overrides
  };
}
