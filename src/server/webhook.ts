import crypto from "node:crypto";
import type { SessionOperation } from "./session-manager.js";

type WebhookTriggerStatus = "queued" | "running" | "error";

export type WebhookTriggerResource = {
  status: WebhookTriggerStatus;
  operationId: string;
  operationUrl: string;
  sessionUrl: string | null;
  error: Record<string, unknown> | null;
};

export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  const match = /^sha256=([a-fA-F0-9]{64})$/.exec(signature || "");
  if (!match) return false;
  const supplied = Buffer.from(match[1], "hex");
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

export function webhookIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() || "";
  if (!key || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new Error("Idempotency-Key must contain between 1 and 200 visible characters");
  }
  return `webhook:${key}`;
}

export function webhookTriggerResource(operation: SessionOperation, publicOrigin: string): WebhookTriggerResource {
  const status = triggerStatus(operation);
  const operationUrl = new URL(`/api/operations/${encodeURIComponent(operation.id)}`, publicOrigin).toString();
  const sessionUrl = operation.remoteThreadId
    ? dashboardSessionUrl(publicOrigin, operation.remoteThreadId)
    : null;
  return {
    status,
    operationId: operation.id,
    operationUrl,
    sessionUrl,
    error: status === "error" ? operation.error || { message: "Session creation failed" } : null
  };
}

function triggerStatus(operation: SessionOperation): WebhookTriggerStatus {
  if (operation.status === "failed" || operation.status === "compensating") return "error";
  if (operation.status === "running" || operation.status === "succeeded") return "running";
  return "queued";
}

function dashboardSessionUrl(publicOrigin: string, threadId: string): string {
  const url = new URL("/", publicOrigin);
  url.searchParams.set("session", threadId);
  return url.toString();
}
