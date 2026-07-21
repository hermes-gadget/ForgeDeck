import { quotaObservationLifetimeMs, type QuotaSnapshot } from "./admission-control.js";
import type { ClaudePlanUsage } from "./claude-bridge.js";
import type { ClaudeRateLimitInfo } from "./claude-output.js";
import type { QuotaEventStoreRow } from "./store.js";

const CLAUDE_PLAN_USAGE_MAX_AGE_MS = 5 * 60_000;

export type ClaudeUsageStatus = {
  activeCount: number;
  maxConcurrent: number;
  rateLimit: {
    limitId: string;
    limitName: string;
    primary: {
      usedPercent: number;
      windowDurationMins: number | null;
      resetsAt?: number;
    };
    secondary: null;
    rateLimitReachedType: string | null;
    source: "anthropic_api" | "local_concurrency";
  };
};

/** Converts Claude Code's provider rate-limit event into a durable quota fact. */
export function claudeQuotaSnapshot(info: ClaudeRateLimitInfo, observedAt: number): QuotaSnapshot | null {
  const status = info.status.trim().toLowerCase();
  if (status !== "allowed" && status !== "rejected") return null;
  const rateLimitType = normalizedRateLimitType(info.rateLimitType);
  const usedPercent = status === "rejected" ? 100 : 0;
  return {
    provider: "claude",
    limitId: `claude:${rateLimitType}`,
    observedAt,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetAt: epochMilliseconds(info.resetsAt),
    raw: info
  };
}

/**
 * Claude Code's /usage command supplies continuous plan utilization, while its
 * turn stream supplies discrete admission/rejection facts. Use the freshest
 * provider reading and retain local concurrency only as a bounded fallback.
 */
export function buildClaudeUsageStatus(options: {
  activeCount: number;
  maxConcurrent: number;
  planUsage?: ClaudePlanUsage | null;
  quotaEvents: readonly QuotaEventStoreRow[];
  quotaStaleMs: number;
  now?: number;
}): ClaudeUsageStatus {
  const now = options.now ?? Date.now();
  const activeCount = nonNegativeInteger(options.activeCount);
  const maxConcurrent = positiveInteger(options.maxConcurrent);
  // Claude emits discrete provider admission outcomes, so the newest outcome
  // supersedes older limit IDs. Apply staleness only after selecting it to
  // prevent an expired transition from revealing an older rejection again.
  const latestQuota = options.quotaEvents
    .filter((row) => row.provider === "claude" && row.limitId !== "provider-retry-after")
    .sort((left, right) => right.observedAt - left.observedAt || right.usedPercent - left.usedPercent)[0];
  const currentQuota = latestQuota && isCurrent(latestQuota, now, options.quotaStaleMs) ? latestQuota : undefined;
  const quota = currentQuota && currentQuota.usedPercent >= 100 ? currentQuota : undefined;
  const planUsage = options.planUsage
    && options.planUsage.observedAt <= now
    && now - options.planUsage.observedAt <= Math.min(options.quotaStaleMs, CLAUDE_PLAN_USAGE_MAX_AGE_MS)
    ? options.planUsage
    : undefined;
  const usePlanUsage = Boolean(planUsage && (!quota || planUsage.observedAt >= quota.observedAt));
  const providerUsage = usePlanUsage ? planUsage : quota;
  const rateLimitType = usePlanUsage ? "five_hour" : quota?.limitId.replace(/^claude:/, "") || null;
  const usedPercent = providerUsage
    ? boundedPercent(providerUsage.usedPercent)
    : boundedPercent((activeCount / maxConcurrent) * 100);
  const primary = {
    usedPercent,
    windowDurationMins: windowDurationMins(rateLimitType),
    ...(!usePlanUsage && quota?.resetAt ? { resetsAt: Math.floor(quota.resetAt / 1_000) } : {})
  };
  return {
    activeCount,
    maxConcurrent,
    rateLimit: {
      limitId: usePlanUsage ? "claude:five_hour" : quota?.limitId || "claude:local-concurrency",
      limitName: usePlanUsage ? "Claude current session" : quota ? "Claude API session limit" : "Claude session slots",
      primary,
      secondary: null,
      rateLimitReachedType: providerUsage && providerUsage.usedPercent >= 100 ? rateLimitType : null,
      source: providerUsage ? "anthropic_api" : "local_concurrency"
    }
  };
}

function isCurrent(row: QuotaEventStoreRow, now: number, quotaStaleMs: number): boolean {
  if (row.resetAt !== null) return row.resetAt > now;
  return now - row.observedAt <= quotaObservationLifetimeMs(row, quotaStaleMs);
}

function normalizedRateLimitType(value: string | null): string {
  const normalized = (value || "session").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 64);
  return normalized || "session";
}

function epochMilliseconds(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value < 10_000_000_000 ? value * 1_000 : value);
}

function windowDurationMins(rateLimitType: string | null): number | null {
  if (rateLimitType === "five_hour") return 5 * 60;
  if (rateLimitType?.startsWith("seven_day")) return 7 * 24 * 60;
  return null;
}

function boundedPercent(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function positiveInteger(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}
