import { createHash, randomUUID } from "node:crypto";
import type {
  BudgetExhaustionPolicy,
  BudgetPolicyStoreRow,
  BudgetScopeType,
  CostEstimateStoreRow,
  QuotaEventStoreRow,
  UsageAggregateStoreRow,
  UsageEventStoreRow,
  UsageProvider
} from "./store.js";

export type UsageTokens = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

export type UsageAttribution = {
  provider: UsageProvider;
  model: string;
  runId: string;
  workspaceId?: string | null;
  blueprintId?: string | null;
};

export type BudgetLimit = {
  requestCount?: number;
  totalTokens?: number;
  estimatedCostMicros?: number;
};

export type BudgetPolicy = {
  scopeType: BudgetScopeType;
  scopeId: string;
  softLimit: BudgetLimit | null;
  hardLimit: BudgetLimit | null;
  exhaustionPolicy: BudgetExhaustionPolicy;
  updatedAt: number;
};

export type DeclaredExhaustionPolicy = {
  action: BudgetExhaustionPolicy;
  approved: boolean;
  target?: { provider: UsageProvider; model: string };
};

export type AdmissionProjection = {
  requestCount?: number;
  totalTokens?: number;
  estimatedCostMicros?: number;
};

export type AdmissionContext = UsageAttribution & {
  projection?: AdmissionProjection;
  policy?: DeclaredExhaustionPolicy | null;
};

type AdmissionAlert = {
  severity: "soft" | "hard";
  code: "QUOTA_HEADROOM" | "QUOTA_RESET_NEAR" | "PROVIDER_RETRY_AFTER" | "BUDGET_SOFT" | "BUDGET_HARD" | "COST_CATALOG_UNAVAILABLE" | "SWITCH_APPROVAL_REQUIRED";
  message: string;
  scopeType?: BudgetScopeType;
  scopeId?: string;
  metric?: keyof BudgetLimit;
  current?: number;
  limit?: number;
  resetAt?: number | null;
};

export type AdmissionDecision = {
  admitted: boolean;
  action: "admit" | BudgetExhaustionPolicy;
  alerts: AdmissionAlert[];
  retryAt: number | null;
  target: { provider: UsageProvider; model: string } | null;
};

export type QuotaSnapshot = {
  provider: UsageProvider;
  limitId: string;
  observedAt: number;
  usedPercent: number;
  remainingPercent: number;
  resetAt: number | null;
  raw: unknown;
};

/**
 * A reset-less Claude rejection is an incomplete provider signal, so it must
 * not inherit an unusually long operator-configured quota lifetime forever.
 */
const CLAUDE_RESETLESS_EXHAUSTION_MAX_AGE_MS = 60 * 60_000;

export function quotaObservationLifetimeMs(
  quota: Pick<QuotaSnapshot, "provider" | "usedPercent" | "resetAt">,
  quotaStaleMs: number
): number {
  const configuredLifetime = Math.max(0, quotaStaleMs);
  return quota.provider === "claude" && quota.usedPercent >= 100 && quota.resetAt === null
    ? Math.min(configuredLifetime, CLAUDE_RESETLESS_EXHAUSTION_MAX_AGE_MS)
    : configuredLifetime;
}

export type CostCatalog = {
  version: string;
  currency: string;
  models: Readonly<Record<string, Readonly<Partial<Record<keyof UsageTokens, number>>>>>;
};

export type AdmissionControlOptions = {
  headroomPercent?: number;
  resetProximityMs?: number;
  quotaStaleMs?: number;
  defaultExhaustionPolicy?: "wait" | "pause";
  costCatalog?: CostCatalog | null;
  now?: () => number;
};

export interface UsageBudgetRepository {
  appendUsageEvent(row: UsageEventStoreRow, estimate?: CostEstimateStoreRow | null): boolean;
  latestUsageCumulative(runId: string, provider: UsageProvider, model: string): UsageEventStoreRow | null;
  listUsageEvents(limit?: number, runId?: string): UsageEventStoreRow[];
  listCostEstimates(limit?: number, runId?: string): CostEstimateStoreRow[];
  usageAggregate(scopeType: BudgetScopeType, scopeId: string, catalogVersion?: string | null): UsageAggregateStoreRow;
  appendQuotaEvent(row: QuotaEventStoreRow): boolean;
  latestQuotaEvents(): QuotaEventStoreRow[];
  upsertBudgetPolicy(row: BudgetPolicyStoreRow): void;
  removeBudgetPolicy(scopeType: BudgetScopeType, scopeId: string): boolean;
  listBudgetPolicies(scopeType?: BudgetScopeType, scopeId?: string): BudgetPolicyStoreRow[];
}

export class AdmissionDeniedError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter: number | undefined;

  constructor(readonly decision: AdmissionDecision, now = Date.now()) {
    const switchRequired = decision.action === "downgrade" || decision.action === "fallback";
    super(switchRequired
      ? `Admission requires an explicit ${decision.action} transition`
      : decision.action === "pause" ? "Work is paused by an admission policy" : "Work is waiting for quota or budget headroom");
    this.name = "AdmissionDeniedError";
    this.status = decision.action === "wait" ? 429 : 409;
    this.code = switchRequired ? "ADMISSION_SWITCH_REQUIRED" : decision.action === "pause" ? "ADMISSION_PAUSED" : "ADMISSION_WAITING";
    this.retryAfter = decision.retryAt === null ? undefined : Math.max(1, Math.ceil((decision.retryAt - now) / 1_000));
  }
}

/**
 * Persists attribution facts and evaluates quota/budget policy before work is
 * handed to the concurrency manager. It never changes a provider or model;
 * approved switch decisions are returned to the caller for explicit handling.
 */
export class AdmissionController {
  private readonly headroomPercent: number;
  private readonly resetProximityMs: number;
  private readonly quotaStaleMs: number;
  private readonly defaultExhaustionPolicy: "wait" | "pause";
  private readonly costCatalog: CostCatalog | null;
  private readonly now: () => number;
  private readonly quotas = new Map<string, QuotaSnapshot>();
  private readonly reservations = new Map<string, { context: AdmissionContext; projection: Required<AdmissionProjection> }>();

  constructor(private readonly repository: UsageBudgetRepository, options: AdmissionControlOptions = {}) {
    this.headroomPercent = boundedPercentage(options.headroomPercent ?? 10, "Quota headroom");
    this.resetProximityMs = nonNegativeFinite(options.resetProximityMs ?? 5 * 60_000, "Quota reset proximity");
    this.quotaStaleMs = positiveFinite(options.quotaStaleMs ?? 5 * 60_000, "Quota observation lifetime");
    this.defaultExhaustionPolicy = options.defaultExhaustionPolicy ?? "wait";
    this.costCatalog = options.costCatalog ?? null;
    this.now = options.now ?? Date.now;
    for (const row of repository.latestQuotaEvents()) this.rememberQuota(fromQuotaRow(row));
  }

  get settings() {
    return Object.freeze({
      headroomPercent: this.headroomPercent,
      resetProximityMs: this.resetProximityMs,
      quotaStaleMs: this.quotaStaleMs,
      defaultExhaustionPolicy: this.defaultExhaustionPolicy,
      costCatalogVersion: this.costCatalog?.version ?? null,
      costCurrency: this.costCatalog?.currency ?? null,
      pendingReservations: this.reservations.size
    });
  }

  recordRequest(attribution: UsageAttribution, sourceEventId?: string | null): UsageEventStoreRow {
    const row = usageRow(attribution, this.timestamp(), {
      requestCount: 1,
      tokens: emptyTokens(),
      cumulative: null,
      sourceEventId: sourceEventId ?? null
    });
    this.repository.appendUsageEvent(row, null);
    return row;
  }

  commitRequest(reservationId: string, attribution: UsageAttribution, sourceEventId?: string | null): UsageEventStoreRow | null {
    if (!this.releaseReservation(reservationId)) return null;
    return this.recordRequest(attribution, sourceEventId);
  }

  reserve(reservationId: string, context: AdmissionContext): AdmissionDecision {
    const id = nonEmpty(reservationId, "Admission reservation ID");
    if (this.reservations.has(id)) throw new Error(`Admission reservation ${id} already exists`);
    const decision = this.evaluate(context);
    if (decision.admitted) {
      this.reservations.set(id, { context: { ...context }, projection: reservationProjection(context.projection) });
    }
    return decision;
  }

  releaseReservation(reservationId: string): boolean {
    return this.reservations.delete(reservationId);
  }

  recordTokenSnapshot(attribution: UsageAttribution, cumulative: UsageTokens, sourceEventId?: string | null): UsageEventStoreRow | null {
    const normalized = normalizeTokens(cumulative);
    const normalizedSourceEventId = sourceEventId ?? null;
    const previous = this.repository.latestUsageCumulative(attribution.runId, attribution.provider, attribution.model);
    const delta = tokenDelta(normalized, previous);
    const row = usageRow(attribution, this.timestamp(), {
      requestCount: 0,
      tokens: delta,
      cumulative: normalized,
      sourceEventId: normalizedSourceEventId
    });
    if (!hasTokens(delta) && normalizedSourceEventId === null) return null;
    const estimate = this.estimate(row);
    return this.repository.appendUsageEvent(row, estimate) ? row : null;
  }

  recordTokens(attribution: UsageAttribution, tokens: UsageTokens, sourceEventId?: string | null): UsageEventStoreRow | null {
    const normalized = normalizeTokens(tokens);
    if (!hasTokens(normalized)) return null;
    const row = usageRow(attribution, this.timestamp(), {
      requestCount: 0,
      tokens: normalized,
      cumulative: null,
      sourceEventId: sourceEventId ?? null
    });
    return this.repository.appendUsageEvent(row, this.estimate(row)) ? row : null;
  }

  observeQuota(snapshot: QuotaSnapshot): boolean {
    const normalized = normalizeQuota(snapshot);
    if (this.isRedundantClaudeQuota(normalized)) return false;
    const row = toQuotaRow(normalized);
    this.repository.appendQuotaEvent(row);
    this.rememberQuota(normalized);
    return true;
  }

  observeRetryAfter(provider: UsageProvider, retryAfterSeconds: number, raw: unknown = null): void {
    if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) return;
    const observedAt = this.timestamp();
    this.observeQuota({
      provider,
      limitId: "provider-retry-after",
      observedAt,
      usedPercent: 100,
      remainingPercent: 0,
      resetAt: observedAt + Math.ceil(retryAfterSeconds * 1_000),
      raw: { retryAfterSeconds, providerSignal: raw }
    });
  }

  evaluate(context: AdmissionContext): AdmissionDecision {
    validateAttribution(context);
    const now = this.timestamp();
    const alerts: AdmissionAlert[] = [];
    let quotaRetryAt: number | null = null;
    let exhausted = false;
    for (const quota of this.currentQuotas(context.provider, now)) {
      if (quota.limitId === "provider-retry-after" && quota.resetAt !== null && quota.resetAt > now) {
        exhausted = true;
        quotaRetryAt = maximumNullable(quotaRetryAt, quota.resetAt);
        alerts.push({
          severity: "hard",
          code: "PROVIDER_RETRY_AFTER",
          message: `${context.provider} asked ForgeDeck to retry after ${new Date(quota.resetAt).toISOString()}`,
          resetAt: quota.resetAt
        });
        continue;
      }
      if (quota.remainingPercent <= this.headroomPercent) {
        exhausted = true;
        quotaRetryAt = maximumNullable(quotaRetryAt, quota.resetAt);
        alerts.push({
          severity: "hard",
          code: "QUOTA_HEADROOM",
          message: `${context.provider} ${quota.limitId} has ${round(quota.remainingPercent)}% remaining; ${this.headroomPercent}% is reserved as operator headroom`,
          resetAt: quota.resetAt
        });
      }
      if (quota.resetAt !== null && quota.resetAt > now && quota.resetAt - now <= this.resetProximityMs) {
        alerts.push({
          severity: "soft",
          code: "QUOTA_RESET_NEAR",
          message: `${context.provider} ${quota.limitId} resets soon`,
          resetAt: quota.resetAt
        });
      }
    }

    const scopes = attributionScopes(context);
    let budgetPolicy: BudgetExhaustionPolicy | null = null;
    for (const scope of scopes) {
      const policy = this.getBudget(scope.scopeType, scope.scopeId);
      if (!policy) continue;
      if (!this.costCatalog && (
        policy.softLimit?.estimatedCostMicros !== undefined
        || policy.hardLimit?.estimatedCostMicros !== undefined
      )) {
        exhausted = true;
        budgetPolicy = "pause";
        alerts.push({
          severity: "hard",
          code: "COST_CATALOG_UNAVAILABLE",
          message: `${scope.scopeType} ${scope.scopeId} has a cost budget but no versioned cost catalog is configured`,
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          metric: "estimatedCostMicros"
        });
      }
      const aggregate = addAggregate(
        this.repository.usageAggregate(scope.scopeType, scope.scopeId, this.costCatalog?.version ?? null),
        this.reservedUsage(scope.scopeType, scope.scopeId)
      );
      const projected = addProjection(aggregate, context.projection);
      alerts.push(...limitAlerts("soft", policy.softLimit, aggregate, projected, scope));
      const hardAlerts = limitAlerts("hard", policy.hardLimit, aggregate, projected, scope);
      if (hardAlerts.length) {
        exhausted = true;
        budgetPolicy ??= policy.exhaustionPolicy;
        alerts.push(...hardAlerts);
      }
    }

    if (!exhausted) return { admitted: true, action: "admit", alerts, retryAt: null, target: null };
    const requestedAction = context.policy?.action ?? budgetPolicy ?? this.defaultExhaustionPolicy;
    if (requestedAction === "downgrade" || requestedAction === "fallback") {
      const target = approvedSwitch(context, requestedAction);
      if (target) return { admitted: true, action: requestedAction, alerts, retryAt: quotaRetryAt, target };
      alerts.push({
        severity: "hard",
        code: "SWITCH_APPROVAL_REQUIRED",
        message: `${requestedAction} requires an explicit approved provider and model target`
      });
      return { admitted: false, action: "pause", alerts, retryAt: null, target: null };
    }
    return {
      admitted: false,
      action: requestedAction,
      alerts,
      retryAt: requestedAction === "wait" ? quotaRetryAt : null,
      target: null
    };
  }

  assertAdmitted(context: AdmissionContext): AdmissionDecision {
    const decision = this.evaluate(context);
    if (!decision.admitted) throw new AdmissionDeniedError(decision, this.timestamp());
    return decision;
  }

  setBudget(policy: Omit<BudgetPolicy, "updatedAt"> & { updatedAt?: number }): BudgetPolicy {
    const normalized: BudgetPolicy = {
      scopeType: policy.scopeType,
      scopeId: nonEmpty(policy.scopeId, "Budget scope ID"),
      softLimit: normalizeLimit(policy.softLimit, "Soft budget"),
      hardLimit: normalizeLimit(policy.hardLimit, "Hard budget"),
      exhaustionPolicy: policy.exhaustionPolicy,
      updatedAt: policy.updatedAt ?? this.timestamp()
    };
    if (!this.costCatalog && (
      normalized.softLimit?.estimatedCostMicros !== undefined
      || normalized.hardLimit?.estimatedCostMicros !== undefined
    )) {
      throw new Error("Estimated cost budgets require a versioned cost catalog");
    }
    validateBudgetRelationship(normalized.softLimit, normalized.hardLimit);
    this.repository.upsertBudgetPolicy(toBudgetRow(normalized));
    return normalized;
  }

  removeBudget(scopeType: BudgetScopeType, scopeId: string): boolean {
    return this.repository.removeBudgetPolicy(scopeType, scopeId);
  }

  getBudget(scopeType: BudgetScopeType, scopeId: string): BudgetPolicy | null {
    const row = this.repository.listBudgetPolicies(scopeType, scopeId)[0];
    return row ? fromBudgetRow(row) : null;
  }

  listBudgets(scopeType?: BudgetScopeType, scopeId?: string): BudgetPolicy[] {
    return this.repository.listBudgetPolicies(scopeType, scopeId).map(fromBudgetRow);
  }

  usage(scopeType: BudgetScopeType, scopeId: string): UsageAggregateStoreRow {
    return this.repository.usageAggregate(scopeType, scopeId, this.costCatalog?.version ?? null);
  }

  events(limit = 100, runId?: string): UsageEventStoreRow[] {
    return this.repository.listUsageEvents(limit, runId);
  }

  estimates(limit = 100, runId?: string): CostEstimateStoreRow[] {
    return this.repository.listCostEstimates(limit, runId);
  }

  private estimate(row: UsageEventStoreRow): CostEstimateStoreRow | null {
    if (!this.costCatalog) return null;
    const rates = this.costCatalog.models[row.model];
    if (!rates) return null;
    const billable: UsageTokens = {
      inputTokens: rates.cachedInputTokens === undefined ? row.inputTokens : Math.max(0, row.inputTokens - row.cachedInputTokens),
      outputTokens: rates.reasoningOutputTokens === undefined ? row.outputTokens : Math.max(0, row.outputTokens - row.reasoningOutputTokens),
      cachedInputTokens: row.cachedInputTokens,
      reasoningOutputTokens: row.reasoningOutputTokens,
      totalTokens: row.totalTokens
    };
    let micros = 0;
    let priced = false;
    for (const metric of TOKEN_METRICS) {
      const rate = rates[metric];
      if (rate === undefined) continue;
      priced = true;
      micros += billable[metric] * rate / 1_000_000;
    }
    if (!priced) return null;
    const estimatedMicros = Math.max(0, Math.round(micros));
    if (!Number.isSafeInteger(estimatedMicros)) return null;
    return {
      usageEventId: row.id,
      catalogVersion: this.costCatalog.version,
      currency: this.costCatalog.currency,
      estimatedMicros
    };
  }

  private currentQuotas(provider: UsageProvider, now: number): QuotaSnapshot[] {
    const providerQuotas = [...this.quotas.values()].filter((quota) => quota.provider === provider);
    const retryAfter = providerQuotas.filter((quota) => (
      quota.limitId === "provider-retry-after" && quota.resetAt !== null && quota.resetAt > now
    ));
    const observations = providerQuotas.filter((quota) => quota.limitId !== "provider-retry-after");
    if (provider !== "claude") {
      return [...retryAfter, ...observations.filter((quota) => this.isCurrentQuota(quota, now))];
    }

    // Claude reports discrete provider admission outcomes rather than
    // independent utilization windows. The newest outcome supersedes every
    // older one before its lifetime is evaluated; otherwise an expired or
    // later-allowed transition can reveal an older rejection again.
    const latest = latestQuota(observations);
    return [...retryAfter, ...(latest && this.isCurrentQuota(latest, now) ? [latest] : [])];
  }

  private isCurrentQuota(quota: QuotaSnapshot, now: number): boolean {
    const staleMs = quotaObservationLifetimeMs(quota, this.quotaStaleMs);
    return now - quota.observedAt <= staleMs || (quota.resetAt !== null && quota.resetAt > now);
  }

  private isRedundantClaudeQuota(snapshot: QuotaSnapshot): boolean {
    if (snapshot.provider !== "claude" || snapshot.limitId === "provider-retry-after") return false;
    const previous = latestQuota([...this.quotas.values()].filter((quota) => (
      quota.provider === "claude" && quota.limitId !== "provider-retry-after"
    )));
    if (!previous) return false;

    // observedAt is deliberately excluded. Replaying the same discrete Claude
    // state after a spawn attempt or server recovery must not move the start
    // of its staleness window. A changed outcome or concrete reset is a new
    // transition and is persisted normally.
    return previous.usedPercent === snapshot.usedPercent
      && previous.remainingPercent === snapshot.remainingPercent
      && previous.resetAt === snapshot.resetAt;
  }

  private rememberQuota(snapshot: QuotaSnapshot): void {
    const key = `${snapshot.provider}:${snapshot.limitId}`;
    const previous = this.quotas.get(key);
    if (!previous || previous.observedAt <= snapshot.observedAt) this.quotas.set(key, snapshot);
  }

  private reservedUsage(scopeType: BudgetScopeType, scopeId: string): AdmissionProjection {
    const total: Required<AdmissionProjection> = { requestCount: 0, totalTokens: 0, estimatedCostMicros: 0 };
    for (const reservation of this.reservations.values()) {
      if (!attributionScopes(reservation.context).some((scope) => scope.scopeType === scopeType && scope.scopeId === scopeId)) continue;
      total.requestCount += reservation.projection.requestCount;
      total.totalTokens += reservation.projection.totalTokens;
      total.estimatedCostMicros += reservation.projection.estimatedCostMicros;
    }
    return total;
  }

  private timestamp(): number {
    const value = this.now();
    if (!Number.isFinite(value) || value < 0) throw new RangeError("Admission clock must return a non-negative finite timestamp");
    return Math.round(value);
  }
}

export function normalizeRateLimitSnapshots(provider: UsageProvider, value: unknown, observedAt = Date.now()): QuotaSnapshot[] {
  if (!isRecord(value)) return [];
  const rootName = stringValue(value.limitName) || "default";
  const windows = ["primary", "secondary"].flatMap((key) => isRecord(value[key]) ? [[key, value[key]] as const] : []);
  if (!windows.length && numberValue(value.usedPercent) !== null) windows.push(["primary", value]);
  return windows.flatMap(([windowName, window]) => {
    const usedPercent = numberValue(window.usedPercent);
    if (usedPercent === null) return [];
    const resetAt = timestampValue(window.resetsAt ?? window.resetAt);
    return [{
      provider,
      limitId: `${rootName}:${windowName}`,
      observedAt,
      usedPercent: clamp(usedPercent, 0, 100),
      remainingPercent: clamp(100 - usedPercent, 0, 100),
      resetAt,
      raw: { limitName: rootName, window: windowName, facts: window }
    }];
  });
}

export function normalizeTokenSnapshot(value: unknown): UsageTokens | null {
  if (!isRecord(value)) return null;
  const totalTokens = integerValue(value.totalTokens);
  if (totalTokens === null) return null;
  return normalizeTokens({
    inputTokens: integerValue(value.inputTokens) ?? 0,
    outputTokens: integerValue(value.outputTokens) ?? 0,
    cachedInputTokens: integerValue(value.cachedInputTokens) ?? 0,
    reasoningOutputTokens: integerValue(value.reasoningOutputTokens) ?? 0,
    totalTokens
  });
}

export function parseCostCatalog(value: string | undefined): CostCatalog | null {
  if (!value?.trim()) return null;
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) throw new Error("FORGEDECK_COST_CATALOG_JSON must be a JSON object");
  const version = nonEmpty(parsed.version, "Cost catalog version");
  const currency = nonEmpty(parsed.currency, "Cost catalog currency").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Cost catalog currency must be a three-letter code");
  if (!isRecord(parsed.models)) throw new Error("Cost catalog models must be an object");
  const models: Record<string, Partial<Record<keyof UsageTokens, number>>> = {};
  for (const [model, candidate] of Object.entries(parsed.models)) {
    if (!isRecord(candidate)) throw new Error(`Cost catalog entry ${model} must be an object`);
    const rates: Partial<Record<keyof UsageTokens, number>> = {};
    for (const metric of TOKEN_METRICS) {
      if (candidate[metric] === undefined) continue;
      const rate = numberValue(candidate[metric]);
      if (rate === null || !Number.isSafeInteger(rate) || rate < 0) {
        throw new Error(`Cost catalog ${model}.${metric} must be a non-negative safe integer`);
      }
      rates[metric] = rate;
    }
    if (!Object.keys(rates).length) throw new Error(`Cost catalog entry ${model} has no token rates`);
    if (rates.totalTokens !== undefined && Object.keys(rates).length > 1) {
      throw new Error(`Cost catalog entry ${model} cannot combine totalTokens with component rates`);
    }
    models[nonEmpty(model, "Cost catalog model")] = Object.freeze(rates);
  }
  return Object.freeze({ version, currency, models: Object.freeze(models) });
}

export function retryAfterSecondsFromError(error: unknown): number | null {
  const visited = new Set<unknown>();
  const inspect = (value: unknown, depth: number): number | null => {
    if (value === null || value === undefined || depth > 6 || visited.has(value)) return null;
    if (typeof value === "object") {
      visited.add(value);
      const record = value as Record<string, unknown>;
      for (const key of ["retryAfter", "retry_after", "retryAfterSeconds", "retry_after_seconds"]) {
        const seconds = numberValue(record[key]);
        if (seconds !== null && seconds > 0) return seconds;
      }
      for (const key of ["data", "cause", "error", "details", "headers"]) {
        const nested = inspect(record[key], depth + 1);
        if (nested !== null) return nested;
      }
    }
    const message = value instanceof Error ? value.message : typeof value === "string" ? value : "";
    const match = /retry[- ]after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?)?/i.exec(message);
    if (!match) return null;
    const amount = Number(match[1]);
    return /^m/i.test(match[2] || "") ? amount / 1_000 : amount;
  };
  return inspect(error, 0);
}

const TOKEN_METRICS = ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningOutputTokens", "totalTokens"] as const;
const BUDGET_METRICS = ["requestCount", "totalTokens", "estimatedCostMicros"] as const;

function usageRow(
  attribution: UsageAttribution,
  observedAt: number,
  values: { requestCount: number; tokens: UsageTokens; cumulative: UsageTokens | null; sourceEventId: string | null }
): UsageEventStoreRow {
  validateAttribution(attribution);
  return {
    id: randomUUID(),
    sourceEventId: values.sourceEventId,
    observedAt,
    provider: attribution.provider,
    model: attribution.model,
    runId: attribution.runId,
    workspaceId: attribution.workspaceId || null,
    blueprintId: attribution.blueprintId || null,
    requestCount: values.requestCount,
    ...values.tokens,
    cumulativeInputTokens: values.cumulative?.inputTokens ?? null,
    cumulativeOutputTokens: values.cumulative?.outputTokens ?? null,
    cumulativeCachedInputTokens: values.cumulative?.cachedInputTokens ?? null,
    cumulativeReasoningOutputTokens: values.cumulative?.reasoningOutputTokens ?? null,
    cumulativeTotalTokens: values.cumulative?.totalTokens ?? null
  };
}

function tokenDelta(current: UsageTokens, previous: UsageEventStoreRow | null): UsageTokens {
  return Object.fromEntries(TOKEN_METRICS.map((metric) => {
    const previousValue = previous?.[cumulativeMetric(metric)] ?? null;
    return [metric, previousValue === null || current[metric] < previousValue ? current[metric] : current[metric] - previousValue];
  })) as UsageTokens;
}

function cumulativeMetric(metric: keyof UsageTokens): keyof Pick<UsageEventStoreRow,
  "cumulativeInputTokens" | "cumulativeOutputTokens" | "cumulativeCachedInputTokens" | "cumulativeReasoningOutputTokens" | "cumulativeTotalTokens"> {
  return `cumulative${metric[0].toUpperCase()}${metric.slice(1)}` as ReturnType<typeof cumulativeMetric>;
}

function emptyTokens(): UsageTokens {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
}

function normalizeTokens(tokens: UsageTokens): UsageTokens {
  return Object.fromEntries(TOKEN_METRICS.map((metric) => [metric, nonNegativeInteger(tokens[metric], `Token ${metric}`)])) as UsageTokens;
}

function hasTokens(tokens: UsageTokens): boolean {
  return TOKEN_METRICS.some((metric) => tokens[metric] > 0);
}

function normalizeQuota(snapshot: QuotaSnapshot): QuotaSnapshot {
  const usedPercent = boundedPercentage(snapshot.usedPercent, "Quota used percentage");
  const remainingPercent = boundedPercentage(snapshot.remainingPercent, "Quota remaining percentage");
  return {
    provider: snapshot.provider,
    limitId: nonEmpty(snapshot.limitId, "Quota limit ID"),
    observedAt: nonNegativeFinite(snapshot.observedAt, "Quota observation timestamp"),
    usedPercent,
    remainingPercent,
    resetAt: snapshot.resetAt === null ? null : nonNegativeFinite(snapshot.resetAt, "Quota reset timestamp"),
    raw: snapshot.raw
  };
}

function toQuotaRow(snapshot: QuotaSnapshot): QuotaEventStoreRow {
  const rawJson = safeJson(snapshot.raw);
  const fingerprint = createHash("sha256").update(JSON.stringify({
    provider: snapshot.provider,
    limitId: snapshot.limitId,
    observedMinute: Math.floor(snapshot.observedAt / 60_000),
    usedPercent: snapshot.usedPercent,
    remainingPercent: snapshot.remainingPercent,
    resetAt: snapshot.resetAt,
    rawJson
  })).digest("hex");
  return { id: `quota-${fingerprint}`, ...snapshot, rawJson };
}

function fromQuotaRow(row: QuotaEventStoreRow): QuotaSnapshot {
  return { ...row, raw: JSON.parse(row.rawJson) as unknown };
}

function latestQuota(quotas: readonly QuotaSnapshot[]): QuotaSnapshot | null {
  return quotas.reduce<QuotaSnapshot | null>((latest, quota) => (
    !latest || quota.observedAt > latest.observedAt ? quota : latest
  ), null);
}

function toBudgetRow(policy: BudgetPolicy): BudgetPolicyStoreRow {
  return {
    scopeType: policy.scopeType,
    scopeId: policy.scopeId,
    softLimitJson: policy.softLimit ? JSON.stringify(policy.softLimit) : null,
    hardLimitJson: policy.hardLimit ? JSON.stringify(policy.hardLimit) : null,
    exhaustionPolicy: policy.exhaustionPolicy,
    updatedAt: policy.updatedAt
  };
}

function fromBudgetRow(row: BudgetPolicyStoreRow): BudgetPolicy {
  return {
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    softLimit: row.softLimitJson ? normalizeLimit(JSON.parse(row.softLimitJson), "Stored soft budget") : null,
    hardLimit: row.hardLimitJson ? normalizeLimit(JSON.parse(row.hardLimitJson), "Stored hard budget") : null,
    exhaustionPolicy: row.exhaustionPolicy,
    updatedAt: row.updatedAt
  };
}

function normalizeLimit(value: BudgetLimit | null, label: string): BudgetLimit | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error(`${label} must be an object or null`);
  const unknown = Object.keys(value).filter((key) => !(BUDGET_METRICS as readonly string[]).includes(key));
  if (unknown.length) throw new Error(`${label} contains unknown metrics: ${unknown.join(", ")}`);
  const normalized: BudgetLimit = {};
  for (const metric of BUDGET_METRICS) {
    if (value[metric] === undefined) continue;
    normalized[metric] = nonNegativeInteger(value[metric]!, `${label} ${metric}`);
  }
  return Object.keys(normalized).length ? normalized : null;
}

function validateBudgetRelationship(soft: BudgetLimit | null, hard: BudgetLimit | null): void {
  if (!soft || !hard) return;
  for (const metric of BUDGET_METRICS) {
    if (soft[metric] !== undefined && hard[metric] !== undefined && soft[metric]! > hard[metric]!) {
      throw new Error(`Soft ${metric} budget must not exceed the hard budget`);
    }
  }
}

function attributionScopes(attribution: UsageAttribution): Array<{ scopeType: BudgetScopeType; scopeId: string }> {
  return [
    { scopeType: "run", scopeId: attribution.runId },
    ...(attribution.blueprintId ? [{ scopeType: "blueprint" as const, scopeId: attribution.blueprintId }] : []),
    ...(attribution.workspaceId ? [{ scopeType: "workspace" as const, scopeId: attribution.workspaceId }] : [])
  ];
}

function addProjection(aggregate: UsageAggregateStoreRow, projection: AdmissionProjection | undefined): UsageAggregateStoreRow {
  return {
    ...aggregate,
    requestCount: aggregate.requestCount + nonNegativeProjection(projection?.requestCount ?? 1),
    totalTokens: aggregate.totalTokens + nonNegativeProjection(projection?.totalTokens ?? 0),
    estimatedCostMicros: aggregate.estimatedCostMicros + nonNegativeProjection(projection?.estimatedCostMicros ?? 0)
  };
}

function addAggregate(aggregate: UsageAggregateStoreRow, reserved: AdmissionProjection): UsageAggregateStoreRow {
  return {
    ...aggregate,
    requestCount: aggregate.requestCount + nonNegativeProjection(reserved.requestCount ?? 0),
    totalTokens: aggregate.totalTokens + nonNegativeProjection(reserved.totalTokens ?? 0),
    estimatedCostMicros: aggregate.estimatedCostMicros + nonNegativeProjection(reserved.estimatedCostMicros ?? 0)
  };
}

function reservationProjection(projection: AdmissionProjection | undefined): Required<AdmissionProjection> {
  return {
    requestCount: nonNegativeProjection(projection?.requestCount ?? 1),
    totalTokens: nonNegativeProjection(projection?.totalTokens ?? 0),
    estimatedCostMicros: nonNegativeProjection(projection?.estimatedCostMicros ?? 0)
  };
}

function limitAlerts(
  severity: "soft" | "hard",
  limit: BudgetLimit | null,
  current: UsageAggregateStoreRow,
  projected: UsageAggregateStoreRow,
  scope: { scopeType: BudgetScopeType; scopeId: string }
): AdmissionAlert[] {
  if (!limit) return [];
  return BUDGET_METRICS.flatMap((metric) => {
    const threshold = limit[metric];
    const reached = severity === "soft"
      ? threshold !== undefined && projected[metric] >= threshold
      : threshold !== undefined && (current[metric] >= threshold || projected[metric] > threshold);
    if (!reached) return [];
    return [{
      severity,
      code: severity === "soft" ? "BUDGET_SOFT" as const : "BUDGET_HARD" as const,
      message: `${scope.scopeType} ${scope.scopeId} ${metric} ${severity} budget reached`,
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      metric,
      current: current[metric],
      limit: threshold
    }];
  });
}

function approvedSwitch(context: AdmissionContext, action: "downgrade" | "fallback"): { provider: UsageProvider; model: string } | null {
  const policy = context.policy;
  if (!policy || policy.action !== action || !policy.approved || !policy.target) return null;
  const target = policy.target;
  if (action === "downgrade" && target.provider !== context.provider) return null;
  if (action === "fallback" && target.provider === context.provider) return null;
  if (target.provider === context.provider && target.model === context.model) return null;
  return { provider: target.provider, model: nonEmpty(target.model, "Admission target model") };
}

function validateAttribution(value: UsageAttribution): void {
  if (!(value.provider === "codex" || value.provider === "spark" || value.provider === "claude")) throw new Error("Usage provider is invalid");
  nonEmpty(value.model, "Usage model");
  nonEmpty(value.runId, "Usage run ID");
}

function maximumNullable(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

function timestampValue(value: unknown): number | null {
  const number = numberValue(value);
  if (number === null || number <= 0) return null;
  return number < 10_000_000_000 ? Math.round(number * 1_000) : Math.round(number);
}

function integerValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  return value.trim();
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative safe integer`);
  return value;
}

function nonNegativeProjection(value: number): number {
  return nonNegativeInteger(value, "Admission projection");
}

function boundedPercentage(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new RangeError(`${label} must be between zero and 100`);
  return value;
}

function nonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be non-negative`);
  return value;
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive`);
  return value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify({ unavailable: true });
  }
}
