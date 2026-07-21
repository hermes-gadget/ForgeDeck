import assert from "node:assert/strict";
import test from "node:test";
import { buildClaudeUsageStatus, claudeQuotaSnapshot } from "./claude-rate-limit.js";
import type { QuotaEventStoreRow } from "./store.js";

test("Claude rejected rate-limit events become 100% durable quota snapshots", () => {
  const snapshot = claudeQuotaSnapshot({
    status: "rejected",
    rateLimitType: "five_hour",
    resetsAt: 1_784_300_400,
    overageStatus: "rejected",
    overageDisabledReason: "out_of_credits",
    isUsingOverage: false
  }, 1_784_296_612_000);

  assert.ok(snapshot);
  assert.equal(snapshot.usedPercent, 100);
  assert.equal(snapshot.remainingPercent, 0);
  assert.equal(snapshot.limitId, "claude:five_hour");
  assert.equal(snapshot.resetAt, 1_784_300_400_000);
});

test("current Anthropic exhaustion overrides idle local Claude slots", () => {
  const quota = quotaRow({ usedPercent: 100, remainingPercent: 0, resetAt: 1_784_300_400_000 });
  const status = buildClaudeUsageStatus({
    activeCount: 0,
    maxConcurrent: 4,
    quotaEvents: [quota],
    quotaStaleMs: 300_000,
    now: 1_784_296_612_000
  });

  assert.equal(status.activeCount, 0);
  assert.equal(status.rateLimit.primary.usedPercent, 100);
  assert.equal(status.rateLimit.primary.resetsAt, 1_784_300_400);
  assert.equal(status.rateLimit.rateLimitReachedType, "five_hour");
  assert.equal(status.rateLimit.source, "anthropic_api");
});

test("fresh Claude plan usage overrides idle local concurrency", () => {
  const now = 1_784_296_612_000;
  const status = buildClaudeUsageStatus({
    activeCount: 0,
    maxConcurrent: 4,
    planUsage: { usedPercent: 54, observedAt: now },
    quotaEvents: [],
    quotaStaleMs: 300_000,
    now
  });

  assert.equal(status.activeCount, 0);
  assert.equal(status.rateLimit.primary.usedPercent, 54);
  assert.equal(status.rateLimit.primary.windowDurationMins, 300);
  assert.equal(status.rateLimit.limitId, "claude:five_hour");
  assert.equal(status.rateLimit.source, "anthropic_api");
});

test("stale Claude plan usage falls back to local concurrency", () => {
  const now = 1_784_296_612_000;
  const status = buildClaudeUsageStatus({
    activeCount: 1,
    maxConcurrent: 4,
    planUsage: { usedPercent: 54, observedAt: now - 300_001 },
    quotaEvents: [],
    quotaStaleMs: 300_000,
    now
  });

  assert.equal(status.rateLimit.primary.usedPercent, 25);
  assert.equal(status.rateLimit.source, "local_concurrency");
});

test("a newer Claude plan reading clears an older rejection", () => {
  const rejected = quotaRow({ usedPercent: 100, remainingPercent: 0 });
  const status = buildClaudeUsageStatus({
    activeCount: 0,
    maxConcurrent: 4,
    planUsage: { usedPercent: 54, observedAt: rejected.observedAt + 1 },
    quotaEvents: [rejected],
    quotaStaleMs: 300_000,
    now: rejected.observedAt + 1
  });

  assert.equal(status.rateLimit.primary.usedPercent, 54);
  assert.equal(status.rateLimit.rateLimitReachedType, null);
  assert.equal(status.rateLimit.source, "anthropic_api");
});

test("expired Anthropic quota falls back to local concurrency", () => {
  const quota = quotaRow({ usedPercent: 100, remainingPercent: 0, resetAt: 1_000 });
  const status = buildClaudeUsageStatus({
    activeCount: 1,
    maxConcurrent: 4,
    quotaEvents: [quota],
    quotaStaleMs: 300_000,
    now: 2_000
  });

  assert.equal(status.rateLimit.primary.usedPercent, 25);
  assert.equal(status.rateLimit.source, "local_concurrency");
});

test("reset-less Claude exhaustion expires after at most one hour", () => {
  const observedAt = 1_784_296_612_000;
  const quota = quotaRow({ observedAt, usedPercent: 100, remainingPercent: 0, resetAt: null });
  const status = buildClaudeUsageStatus({
    activeCount: 1,
    maxConcurrent: 4,
    quotaEvents: [quota],
    quotaStaleMs: 24 * 60 * 60_000,
    now: observedAt + 60 * 60_000 + 1
  });

  assert.equal(status.rateLimit.primary.usedPercent, 25);
  assert.equal(status.rateLimit.source, "local_concurrency");
});

test("later allowed Claude event clears an earlier rejection and reveals local concurrency", () => {
  const rejected = quotaRow({ id: "rejected", usedPercent: 100, remainingPercent: 0 });
  const allowed = quotaRow({
    id: "allowed",
    limitId: "claude:seven_day",
    observedAt: rejected.observedAt + 1_000,
    usedPercent: 0,
    remainingPercent: 100
  });
  const status = buildClaudeUsageStatus({
    activeCount: 2,
    maxConcurrent: 4,
    quotaEvents: [rejected, allowed],
    quotaStaleMs: 300_000,
    now: allowed.observedAt
  });

  assert.equal(status.rateLimit.primary.usedPercent, 50);
  assert.equal(status.rateLimit.rateLimitReachedType, null);
  assert.equal(status.rateLimit.limitId, "claude:local-concurrency");
  assert.equal(status.rateLimit.source, "local_concurrency");
});

test("a current allowed Claude event never masks an occupied session slot", () => {
  const allowed = quotaRow({
    limitId: "claude:five_hour",
    usedPercent: 0,
    remainingPercent: 100
  });
  const status = buildClaudeUsageStatus({
    activeCount: 1,
    maxConcurrent: 4,
    quotaEvents: [allowed],
    quotaStaleMs: 300_000,
    now: allowed.observedAt
  });

  assert.equal(status.activeCount, 1);
  assert.equal(status.maxConcurrent, 4);
  assert.equal(status.rateLimit.primary.usedPercent, 25);
  assert.equal(status.rateLimit.source, "local_concurrency");
});

test("an expired latest Claude transition does not reveal an older rejection", () => {
  const rejected = quotaRow({ id: "rejected", observedAt: 1_000, usedPercent: 100, remainingPercent: 0, resetAt: 10_000 });
  const allowed = quotaRow({ id: "allowed", observedAt: 2_000, usedPercent: 0, remainingPercent: 100 });
  const status = buildClaudeUsageStatus({
    activeCount: 1,
    maxConcurrent: 4,
    quotaEvents: [rejected, allowed],
    quotaStaleMs: 1_000,
    now: 3_001
  });

  assert.equal(status.rateLimit.primary.usedPercent, 25);
  assert.equal(status.rateLimit.source, "local_concurrency");
});

function quotaRow(overrides: Partial<QuotaEventStoreRow>): QuotaEventStoreRow {
  return {
    id: "quota-1",
    observedAt: 1_784_296_612_000,
    provider: "claude",
    limitId: "claude:five_hour",
    usedPercent: 0,
    remainingPercent: 100,
    resetAt: null,
    rawJson: "{}",
    ...overrides
  };
}
