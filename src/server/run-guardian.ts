const DEFAULT_GUARDIAN_STALL_TIMEOUT_MS = 10 * 60_000;
const GUARDIAN_MAX_RECOVERY_ATTEMPTS = 3;

type RunGuardianPhase =
  | "idle"
  | "monitoring"
  | "stalled"
  | "retrying"
  | "escalating"
  | "paused"
  | "failed";

export type RunGuardianPolicy = {
  stallTimeoutMs: number;
  escalationModel: string | null;
};

export type RunGuardianState = {
  threadId: string;
  phase: RunGuardianPhase;
  active: boolean;
  recoveryAttempts: number;
  maxRecoveryAttempts: typeof GUARDIAN_MAX_RECOVERY_ATTEMPTS;
  lastActivityAt: number;
  stalledAt: number | null;
  lastActionAt: number | null;
  actionModel: string | null;
  operatorNotifiedAt: number | null;
  recoveredAt: number | null;
  updatedAt: number;
  error: string | null;
  policy: RunGuardianPolicy;
};

export type RunGuardianPersistence = {
  load: () => RunGuardianState[];
  save: (state: RunGuardianState) => void;
  remove: (threadId: string) => boolean;
};

export type RunGuardianActions = {
  retry: (threadId: string) => Promise<void>;
  escalate: (threadId: string, requestedModel: string | null) => Promise<string>;
  pause: (threadId: string) => Promise<void>;
};

export type RunGuardianOptions = {
  now?: () => number;
  checkIntervalMs?: number;
  persistenceIntervalMs?: number;
  defaultPolicy?: Partial<RunGuardianPolicy>;
  onChange?: (state: RunGuardianState, reason: string) => void;
};

/**
 * Supervises active runs with a deliberately small deterministic state machine.
 * It does not choose tools, permissions, or prompts: recovery actions are
 * supplied by the server adapter and are always bounded by this class.
 */
export class RunGuardian {
  private readonly states = new Map<string, RunGuardianState>();
  private readonly confirmedActive = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly lastPersistedAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly checkIntervalMs: number;
  private readonly persistenceIntervalMs: number;
  private readonly defaultPolicy: RunGuardianPolicy;
  private readonly onChange: (state: RunGuardianState, reason: string) => void;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly persistence: RunGuardianPersistence,
    private readonly actions: RunGuardianActions,
    options: RunGuardianOptions = {}
  ) {
    this.now = options.now || Date.now;
    this.checkIntervalMs = positiveInteger(options.checkIntervalMs, 5_000, "Guardian check interval");
    this.persistenceIntervalMs = positiveInteger(options.persistenceIntervalMs, 5_000, "Guardian persistence interval");
    this.defaultPolicy = normalizeGuardianPolicy(options.defaultPolicy, {
      stallTimeoutMs: DEFAULT_GUARDIAN_STALL_TIMEOUT_MS,
      escalationModel: null
    });
    this.onChange = options.onChange || (() => undefined);
    for (const candidate of persistence.load()) {
      const state = normalizeStoredState(candidate, this.defaultPolicy, this.now());
      this.states.set(state.threadId, state);
      this.lastPersistedAt.set(state.threadId, state.updatedAt);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.checkNow().catch(() => undefined);
    }, this.checkIntervalMs);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const state of this.states.values()) this.persist(state, false, true);
  }

  get(threadId: string): RunGuardianState {
    return cloneState(this.states.get(threadId) || this.initialState(threadId));
  }

  list(): RunGuardianState[] {
    return [...this.states.values()].map(cloneState);
  }

  configure(threadId: string, policy: Partial<RunGuardianPolicy>): RunGuardianState {
    const state = this.mutableState(threadId);
    state.policy = normalizeGuardianPolicy(policy, state.policy);
    state.updatedAt = this.timestamp();
    this.persist(state, true, true, "configured");
    return cloneState(state);
  }

  /** Confirms provider-side activity, including after a server restart. */
  activate(threadId: string, policy?: Partial<RunGuardianPolicy>): RunGuardianState {
    const state = this.mutableState(threadId);
    const wasConfirmed = this.confirmedActive.has(threadId);
    const recovered = state.active && !wasConfirmed;
    if (wasConfirmed && state.active && !policy) return cloneState(state);
    if (policy) state.policy = normalizeGuardianPolicy(policy, state.policy);
    state.active = true;
    if (!["paused", "failed", "retrying", "escalating"].includes(state.phase)) state.phase = "monitoring";
    if (recovered) state.recoveredAt = this.timestamp();
    if (!state.lastActivityAt) state.lastActivityAt = this.timestamp();
    state.updatedAt = this.timestamp();
    this.confirmedActive.add(threadId);
    this.persist(state, recovered, true, recovered ? "recovered" : "activated");
    return cloneState(state);
  }

  /** Starts a user- or queue-requested run as a fresh bounded incident. */
  beginRun(threadId: string, policy?: Partial<RunGuardianPolicy>): RunGuardianState {
    const state = this.mutableState(threadId);
    if (policy) state.policy = normalizeGuardianPolicy(policy, state.policy);
    state.active = true;
    state.phase = "monitoring";
    state.recoveryAttempts = 0;
    state.lastActivityAt = this.timestamp();
    state.stalledAt = null;
    state.lastActionAt = null;
    state.actionModel = null;
    state.operatorNotifiedAt = null;
    state.error = null;
    state.updatedAt = state.lastActivityAt;
    this.confirmedActive.add(threadId);
    this.persist(state, true, true, "run-started");
    return cloneState(state);
  }

  /**
   * Records output or a meaningful state transition. Recovery counters reset
   * only when the run completes, so intermittent output cannot create an
   * unbounded retry loop.
   */
  activity(threadId: string, progress = false): RunGuardianState | null {
    const state = this.states.get(threadId);
    if (!state || !state.active) return null;
    const previousPhase = state.phase;
    state.lastActivityAt = this.timestamp();
    state.updatedAt = state.lastActivityAt;
    state.error = null;
    if (!this.inFlight.has(threadId) && !["paused", "failed"].includes(state.phase)) state.phase = "monitoring";
    if (progress && !this.inFlight.has(threadId)) {
      state.stalledAt = null;
      state.actionModel = null;
    }
    const changed = previousPhase !== state.phase;
    this.persist(state, changed, changed, progress ? "progress" : "activity");
    return cloneState(state);
  }

  /** Marks a provider run terminal. Terminal events during recovery are from the interrupted run. */
  complete(threadId: string): RunGuardianState | null {
    const state = this.states.get(threadId);
    if (!state) return null;
    state.lastActivityAt = this.timestamp();
    state.updatedAt = state.lastActivityAt;
    if (this.inFlight.has(threadId)) {
      this.persist(state, false, true);
      return cloneState(state);
    }
    this.confirmedActive.delete(threadId);
    state.active = false;
    state.phase = "idle";
    state.recoveryAttempts = 0;
    state.stalledAt = null;
    state.lastActionAt = null;
    state.actionModel = null;
    state.operatorNotifiedAt = null;
    state.error = null;
    this.persist(state, true, true, "completed");
    return cloneState(state);
  }

  remove(threadId: string): boolean {
    this.confirmedActive.delete(threadId);
    this.inFlight.delete(threadId);
    this.lastPersistedAt.delete(threadId);
    const removed = this.states.delete(threadId);
    return this.persistence.remove(threadId) || removed;
  }

  async checkNow(): Promise<void> {
    const timestamp = this.timestamp();
    const work: Promise<unknown>[] = [];
    for (const state of this.states.values()) {
      if (!state.active || !this.confirmedActive.has(state.threadId) || this.inFlight.has(state.threadId)) continue;
      if (["idle", "paused", "failed", "stalled"].includes(state.phase)) continue;
      const baseline = Math.max(state.lastActivityAt, state.lastActionAt || 0);
      if (timestamp - baseline < state.policy.stallTimeoutMs) continue;
      state.phase = "stalled";
      state.stalledAt = timestamp;
      state.updatedAt = timestamp;
      this.persist(state, true, true, "stalled");
      if (state.recoveryAttempts < 2) work.push(this.performRetry(state, false));
      else if (state.recoveryAttempts < GUARDIAN_MAX_RECOVERY_ATTEMPTS) work.push(this.performEscalation(state, null, false));
      else work.push(this.performPause(state));
    }
    await Promise.allSettled(work);
  }

  retryNow(threadId: string): Promise<RunGuardianState> {
    const state = this.mutableState(threadId);
    if (this.inFlight.has(threadId)) return Promise.resolve(cloneState(state));
    state.recoveryAttempts = 0;
    state.operatorNotifiedAt = null;
    state.error = null;
    state.active = true;
    this.confirmedActive.add(threadId);
    return this.performRetry(state, true);
  }

  escalateNow(threadId: string, model: string | null = null): Promise<RunGuardianState> {
    const state = this.mutableState(threadId);
    if (this.inFlight.has(threadId)) return Promise.resolve(cloneState(state));
    state.recoveryAttempts = 2;
    state.operatorNotifiedAt = null;
    state.error = null;
    state.active = true;
    this.confirmedActive.add(threadId);
    return this.performEscalation(state, model, true);
  }

  private async performRetry(state: RunGuardianState, manual: boolean): Promise<RunGuardianState> {
    const threadId = state.threadId;
    this.inFlight.add(threadId);
    state.phase = "retrying";
    state.recoveryAttempts += 1;
    state.lastActionAt = this.timestamp();
    state.lastActivityAt = state.lastActionAt;
    state.updatedAt = state.lastActionAt;
    state.actionModel = null;
    state.error = null;
    this.persist(state, true, true, manual ? "manual-retry" : "retrying");
    try {
      await this.actions.retry(threadId);
      state.lastActivityAt = this.timestamp();
      state.updatedAt = state.lastActivityAt;
      this.persist(state, true, true, "retry-submitted");
    } catch (error) {
      this.fail(state, error, "retry-failed");
    } finally {
      this.inFlight.delete(threadId);
    }
    return cloneState(state);
  }

  private async performEscalation(state: RunGuardianState, model: string | null, manual: boolean): Promise<RunGuardianState> {
    const threadId = state.threadId;
    this.inFlight.add(threadId);
    state.phase = "escalating";
    state.recoveryAttempts = GUARDIAN_MAX_RECOVERY_ATTEMPTS;
    state.lastActionAt = this.timestamp();
    state.lastActivityAt = state.lastActionAt;
    state.updatedAt = state.lastActionAt;
    state.actionModel = model || state.policy.escalationModel;
    state.error = null;
    this.persist(state, true, true, manual ? "manual-escalation" : "escalating");
    try {
      const selectedModel = await this.actions.escalate(threadId, state.actionModel);
      state.actionModel = selectedModel;
      state.lastActivityAt = this.timestamp();
      state.updatedAt = state.lastActivityAt;
      this.persist(state, true, true, "escalation-submitted");
    } catch (error) {
      this.fail(state, error, "escalation-failed");
    } finally {
      this.inFlight.delete(threadId);
    }
    return cloneState(state);
  }

  private async performPause(state: RunGuardianState): Promise<RunGuardianState> {
    const threadId = state.threadId;
    this.inFlight.add(threadId);
    state.phase = "paused";
    state.active = false;
    state.operatorNotifiedAt = this.timestamp();
    state.lastActionAt = state.operatorNotifiedAt;
    state.updatedAt = state.operatorNotifiedAt;
    state.error = null;
    this.confirmedActive.delete(threadId);
    this.persist(state, true, true, "operator-escalation");
    try {
      await this.actions.pause(threadId);
    } catch (error) {
      // The durable paused incident still prevents further automatic actions;
      // expose the adapter error so the operator knows the remote stop may need help.
      state.error = errorMessage(error);
      state.updatedAt = this.timestamp();
      this.persist(state, true, true, "pause-failed");
    } finally {
      this.inFlight.delete(threadId);
    }
    return cloneState(state);
  }

  private fail(state: RunGuardianState, error: unknown, reason: string): void {
    state.phase = "failed";
    state.active = false;
    state.error = errorMessage(error);
    state.updatedAt = this.timestamp();
    this.confirmedActive.delete(state.threadId);
    this.persist(state, true, true, reason);
  }

  private mutableState(threadId: string): RunGuardianState {
    const current = this.states.get(threadId);
    if (current) return current;
    const state = this.initialState(threadId);
    this.states.set(threadId, state);
    return state;
  }

  private initialState(threadId: string): RunGuardianState {
    const timestamp = this.timestamp();
    return {
      threadId,
      phase: "idle",
      active: false,
      recoveryAttempts: 0,
      maxRecoveryAttempts: GUARDIAN_MAX_RECOVERY_ATTEMPTS,
      lastActivityAt: timestamp,
      stalledAt: null,
      lastActionAt: null,
      actionModel: null,
      operatorNotifiedAt: null,
      recoveredAt: null,
      updatedAt: timestamp,
      error: null,
      policy: { ...this.defaultPolicy }
    };
  }

  private persist(state: RunGuardianState, notify: boolean, force = false, reason = "updated"): void {
    const lastPersistedAt = this.lastPersistedAt.get(state.threadId) || 0;
    if (force || state.updatedAt - lastPersistedAt >= this.persistenceIntervalMs) {
      this.persistence.save(cloneState(state));
      this.lastPersistedAt.set(state.threadId, state.updatedAt);
    }
    if (notify) this.onChange(cloneState(state), reason);
  }

  private timestamp(): number {
    const value = this.now();
    if (!Number.isFinite(value) || value < 0) throw new Error("Guardian clock returned an invalid timestamp");
    return Math.round(value);
  }
}

function normalizeGuardianPolicy(
  value: Partial<RunGuardianPolicy> | undefined,
  fallback: RunGuardianPolicy = { stallTimeoutMs: DEFAULT_GUARDIAN_STALL_TIMEOUT_MS, escalationModel: null }
): RunGuardianPolicy {
  const stallTimeoutMs = value?.stallTimeoutMs === undefined
    ? fallback.stallTimeoutMs
    : positiveInteger(value.stallTimeoutMs, fallback.stallTimeoutMs, "Guardian stall timeout");
  const escalationModel = value?.escalationModel === undefined
    ? fallback.escalationModel
    : normalizeModel(value.escalationModel);
  return { stallTimeoutMs, escalationModel };
}

/** Selects a configured target or the highest-ranked available model above the current model. */
export function selectStrongerModel(current: string, available: readonly string[], preferred: string | null = null): string {
  const unique = [...new Set(available.filter((model) => /^[a-zA-Z0-9._:/-]{1,128}$/.test(model)))];
  if (preferred) {
    if (preferred === current) throw new Error("The escalation model must differ from the current model");
    if (!unique.includes(preferred)) throw new Error(`Escalation model ${preferred} is not available`);
    return preferred;
  }
  const currentScore = modelStrength(current);
  const stronger = unique
    .filter((model) => model !== current && modelStrength(model) > currentScore)
    .sort((left, right) => modelStrength(right) - modelStrength(left) || left.localeCompare(right));
  if (!stronger.length) throw new Error(`No stronger model is available for ${current}`);
  return stronger[0];
}

function modelStrength(model: string): number {
  const normalized = model.toLowerCase();
  if (normalized.includes("fable") || normalized.includes("mythos")) return 1_200_000;
  if (normalized === "opus" || normalized.includes("opus")) return 1_000_000;
  if (normalized === "sonnet" || normalized.includes("sonnet")) return 700_000;
  if (normalized === "haiku" || normalized.includes("haiku")) return 300_000;
  const versions = [...normalized.matchAll(/(\d+)(?:\.(\d+))?/g)];
  const last = versions.at(-1);
  const version = last ? Number(last[1]) * 10_000 + Number(last[2] || 0) * 100 : 0;
  const capability = normalized.includes("sol") ? 80
    : normalized.includes("pro") ? 70
      : normalized.includes("codex") ? 60
        : normalized.includes("spark") || normalized.includes("mini") ? 10 : 40;
  return version + capability;
}

function normalizeStoredState(value: RunGuardianState, fallback: RunGuardianPolicy, now: number): RunGuardianState {
  if (!value || typeof value !== "object" || !/^[A-Za-z0-9_-]{8,128}$/.test(String(value.threadId || ""))) {
    throw new Error("Stored guardian state is invalid");
  }
  const phases: RunGuardianPhase[] = ["idle", "monitoring", "stalled", "retrying", "escalating", "paused", "failed"];
  const phase = phases.includes(value.phase) ? value.phase : "idle";
  return {
    threadId: value.threadId,
    phase,
    active: value.active === true,
    recoveryAttempts: boundedAttempts(value.recoveryAttempts),
    maxRecoveryAttempts: GUARDIAN_MAX_RECOVERY_ATTEMPTS,
    lastActivityAt: timestamp(value.lastActivityAt, now),
    stalledAt: nullableTimestamp(value.stalledAt),
    lastActionAt: nullableTimestamp(value.lastActionAt),
    actionModel: normalizeModel(value.actionModel),
    operatorNotifiedAt: nullableTimestamp(value.operatorNotifiedAt),
    recoveredAt: nullableTimestamp(value.recoveredAt),
    updatedAt: timestamp(value.updatedAt, now),
    error: typeof value.error === "string" && value.error ? value.error.slice(0, 2_000) : null,
    policy: normalizeGuardianPolicy(value.policy, fallback)
  };
}

function boundedAttempts(value: unknown): number {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(0, Math.min(GUARDIAN_MAX_RECOVERY_ATTEMPTS, number)) : 0;
}

function timestamp(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : fallback;
}

function nullableTimestamp(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function normalizeModel(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" && /^[a-zA-Z0-9._:/-]{1,128}$/.test(value) ? value : null;
}

function positiveInteger(value: unknown, fallback: number, label: string): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new RangeError(`${label} must be a positive integer`);
  return number;
}

function cloneState(state: RunGuardianState): RunGuardianState {
  return { ...state, policy: { ...state.policy } };
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error || "Guardian recovery failed")).slice(0, 2_000);
}
