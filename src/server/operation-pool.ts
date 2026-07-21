export type OperationPriority = "interactive" | "background";

export type OperationContext = {
  signal: AbortSignal;
  deadline: number;
  remainingMs: () => number;
};

export type OperationOptions = {
  priority?: OperationPriority;
  fairnessKey?: string;
  signal?: AbortSignal;
  deadline?: number;
};

export type OperationPoolMetrics = {
  configuredLimit: number;
  effectiveLimit: number;
  backgroundLimit: number;
  interactiveReserve: number;
  activeCount: number;
  waitingCount: number;
  waitingByPriority: Record<OperationPriority, number>;
  saturation: number;
  saturated: boolean;
  completed: number;
  failed: number;
  cancelled: number;
  deadlineExceeded: number;
  backpressureEvents: number;
  adaptiveReductions: number;
  adaptiveRecoveries: number;
  latencyMs: {
    average: number;
    ewma: number;
    maximum: number;
    last: number;
  };
  queueWaitMs: {
    average: number;
    maximum: number;
    last: number;
  };
  recentErrorRate: number;
};

export type AdaptiveOperationPoolOptions = {
  name: string;
  maxConcurrency: number;
  minConcurrency?: number;
  latencyTargetMs: number;
  priorityBurst?: number;
  interactiveReserve?: number;
  recoverySuccesses?: number;
  adaptationCooldownMs?: number;
  isBackpressureError?: (error: unknown) => boolean;
};

export interface OperationScheduler {
  run<T>(task: (context: OperationContext) => Promise<T> | T, options?: OperationOptions): Promise<T>;
}

type Waiter<T> = {
  task: (context: OperationContext) => Promise<T> | T;
  options: Required<Pick<OperationOptions, "priority" | "fairnessKey">> & Pick<OperationOptions, "signal" | "deadline">;
  queuedAt: number;
  timer: NodeJS.Timeout | null;
  abortListener: (() => void) | null;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type Lane = {
  groups: Map<string, Waiter<unknown>[]>;
  order: string[];
  size: number;
};

const DEFAULT_DEADLINE_MS = 60_000;
const EWMA_ALPHA = 0.2;

export class OperationPoolDeadlineError extends Error {
  readonly status = 503;
  readonly code = "OPERATION_QUEUE_DEADLINE_EXCEEDED";
  readonly retryAfter = 1;

  constructor(readonly pool: string, readonly deadline: number) {
    super(`Timed out waiting for ${pool} operation capacity`);
    this.name = "OperationPoolDeadlineError";
  }
}

export class OperationPoolCancelledError extends Error {
  readonly status = 499;
  readonly code = "OPERATION_CANCELLED";

  constructor(readonly pool: string, options?: ErrorOptions) {
    super(`Cancelled while waiting for ${pool} operation capacity`, options);
    this.name = "OperationPoolCancelledError";
  }
}

/**
 * A bounded, cancellation-aware pool with per-caller round-robin fairness,
 * reserved interactive priority, and conservative adaptive backpressure.
 */
export class AdaptiveOperationPool implements OperationScheduler {
  private readonly name: string;
  private readonly configuredLimit: number;
  private readonly minimumLimit: number;
  private readonly latencyTargetMs: number;
  private readonly priorityBurst: number;
  private readonly interactiveReserve: number;
  private readonly recoverySuccesses: number;
  private readonly adaptationCooldownMs: number;
  private readonly isBackpressureError: (error: unknown) => boolean;
  private readonly lanes: Record<OperationPriority, Lane> = {
    interactive: createLane(),
    background: createLane()
  };
  private effectiveLimit: number;
  private activeCount = 0;
  private interactiveStreak = 0;
  private healthyCompletions = 0;
  private lastAdaptedAt = 0;
  private completed = 0;
  private failed = 0;
  private cancelled = 0;
  private deadlineExceeded = 0;
  private backpressureEvents = 0;
  private adaptiveReductions = 0;
  private adaptiveRecoveries = 0;
  private totalLatencyMs = 0;
  private maximumLatencyMs = 0;
  private lastLatencyMs = 0;
  private latencyEwmaMs = 0;
  private totalQueueWaitMs = 0;
  private maximumQueueWaitMs = 0;
  private lastQueueWaitMs = 0;
  private completedWaits = 0;
  private errorRateEwma = 0;

  constructor(options: AdaptiveOperationPoolOptions) {
    if (!options.name.trim()) throw new TypeError("Operation pool name is required");
    if (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1) {
      throw new RangeError("Operation pool maximum concurrency must be a positive integer");
    }
    const minimum = options.minConcurrency ?? 1;
    if (!Number.isInteger(minimum) || minimum < 1 || minimum > options.maxConcurrency) {
      throw new RangeError("Operation pool minimum concurrency must be between one and its maximum");
    }
    if (!Number.isFinite(options.latencyTargetMs) || options.latencyTargetMs <= 0) {
      throw new RangeError("Operation pool latency target must be positive");
    }
    this.name = options.name;
    this.configuredLimit = options.maxConcurrency;
    this.minimumLimit = minimum;
    this.effectiveLimit = options.maxConcurrency;
    this.latencyTargetMs = options.latencyTargetMs;
    this.priorityBurst = positiveInteger(options.priorityBurst, 4, "Operation pool priority burst");
    this.interactiveReserve = nonNegativeInteger(
      options.interactiveReserve,
      options.maxConcurrency > 1 ? 1 : 0,
      "Operation pool interactive reserve"
    );
    if (this.interactiveReserve >= options.maxConcurrency) {
      throw new RangeError("Operation pool interactive reserve must be below its maximum concurrency");
    }
    this.recoverySuccesses = positiveInteger(options.recoverySuccesses, Math.max(8, options.maxConcurrency * 2), "Operation pool recovery successes");
    this.adaptationCooldownMs = nonNegativeNumber(options.adaptationCooldownMs, 5_000, "Operation pool adaptation cooldown");
    this.isBackpressureError = options.isBackpressureError || (() => false);
  }

  run<T>(task: (context: OperationContext) => Promise<T> | T, options: OperationOptions = {}): Promise<T> {
    const queuedAt = Date.now();
    const priority = options.priority || "interactive";
    const fairnessKey = options.fairnessKey?.trim() || "default";
    const deadline = options.deadline ?? queuedAt + DEFAULT_DEADLINE_MS;
    if (!Number.isFinite(deadline)) throw new RangeError("Operation deadline must be finite");
    if (options.signal?.aborted) {
      this.cancelled += 1;
      return Promise.reject(new OperationPoolCancelledError(this.name, { cause: options.signal.reason }));
    }
    if (deadline <= queuedAt) {
      this.deadlineExceeded += 1;
      return Promise.reject(new OperationPoolDeadlineError(this.name, deadline));
    }

    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter<T> = {
        task,
        options: { priority, fairnessKey, signal: options.signal, deadline },
        queuedAt,
        timer: null,
        abortListener: null,
        resolve,
        reject
      };
      waiter.timer = setTimeout(() => this.rejectQueued(waiter as Waiter<unknown>, "deadline"), Math.max(1, deadline - queuedAt));
      if (options.signal) {
        waiter.abortListener = () => this.rejectQueued(waiter as Waiter<unknown>, "cancelled");
        options.signal.addEventListener("abort", waiter.abortListener, { once: true });
      }
      enqueue(this.lanes[priority], waiter as Waiter<unknown>);
      this.drain();
    });
  }

  metrics(): OperationPoolMetrics {
    const waitingCount = this.waitingCount();
    return {
      configuredLimit: this.configuredLimit,
      effectiveLimit: this.effectiveLimit,
      backgroundLimit: this.backgroundLimit(),
      interactiveReserve: this.interactiveReserve,
      activeCount: this.activeCount,
      waitingCount,
      waitingByPriority: {
        interactive: this.lanes.interactive.size,
        background: this.lanes.background.size
      },
      saturation: round(Math.min(1, (this.activeCount + waitingCount) / Math.max(1, this.effectiveLimit))),
      saturated: this.activeCount >= this.effectiveLimit || waitingCount > 0,
      completed: this.completed,
      failed: this.failed,
      cancelled: this.cancelled,
      deadlineExceeded: this.deadlineExceeded,
      backpressureEvents: this.backpressureEvents,
      adaptiveReductions: this.adaptiveReductions,
      adaptiveRecoveries: this.adaptiveRecoveries,
      latencyMs: {
        average: this.completed ? round(this.totalLatencyMs / this.completed) : 0,
        ewma: round(this.latencyEwmaMs),
        maximum: round(this.maximumLatencyMs),
        last: round(this.lastLatencyMs)
      },
      queueWaitMs: {
        average: this.completedWaits ? round(this.totalQueueWaitMs / this.completedWaits) : 0,
        maximum: round(this.maximumQueueWaitMs),
        last: round(this.lastQueueWaitMs)
      },
      recentErrorRate: round(this.errorRateEwma)
    };
  }

  private drain(): void {
    while (this.activeCount < this.effectiveLimit && this.waitingCount() > 0) {
      const backgroundAllowed = this.activeCount < this.backgroundLimit();
      if (!backgroundAllowed && this.lanes.interactive.size === 0) return;
      const waiter = this.dequeueNext(backgroundAllowed);
      if (!waiter) return;
      if ((waiter.options.deadline ?? 0) <= Date.now()) {
        this.cleanupWaiter(waiter);
        this.deadlineExceeded += 1;
        waiter.reject(new OperationPoolDeadlineError(this.name, waiter.options.deadline!));
        continue;
      }
      if (waiter.options.signal?.aborted) {
        this.cleanupWaiter(waiter);
        this.cancelled += 1;
        waiter.reject(new OperationPoolCancelledError(this.name, { cause: waiter.options.signal.reason }));
        continue;
      }
      this.start(waiter);
    }
  }

  private dequeueNext(backgroundAllowed: boolean): Waiter<unknown> | null {
    const interactive = this.lanes.interactive.size > 0;
    const background = backgroundAllowed && this.lanes.background.size > 0;
    let priority: OperationPriority;
    if (interactive && (!background || this.interactiveStreak < this.priorityBurst)) {
      priority = "interactive";
      this.interactiveStreak += 1;
    } else {
      priority = "background";
      this.interactiveStreak = 0;
    }
    return dequeue(this.lanes[priority]);
  }

  private start(waiter: Waiter<unknown>): void {
    this.cleanupWaiter(waiter);
    this.activeCount += 1;
    const startedAt = Date.now();
    this.recordWait(Math.max(0, startedAt - waiter.queuedAt));
    const deadline = waiter.options.deadline!;
    const deadlineSignal = AbortSignal.timeout(Math.max(1, deadline - startedAt));
    const signal = waiter.options.signal
      ? AbortSignal.any([waiter.options.signal, deadlineSignal])
      : deadlineSignal;
    const context: OperationContext = {
      signal,
      deadline,
      remainingMs: () => Math.max(0, deadline - Date.now())
    };
    void Promise.resolve()
      .then(() => waiter.task(context))
      .then(
        (value) => {
          this.recordCompletion(Date.now() - startedAt, null);
          waiter.resolve(value);
        },
        (error: unknown) => {
          this.recordCompletion(Date.now() - startedAt, error);
          waiter.reject(error);
        }
      )
      .finally(() => {
        this.activeCount -= 1;
        this.drain();
      });
  }

  private rejectQueued(waiter: Waiter<unknown>, reason: "cancelled" | "deadline"): void {
    if (!remove(this.lanes[waiter.options.priority], waiter)) return;
    this.cleanupWaiter(waiter);
    if (reason === "cancelled") {
      this.cancelled += 1;
      waiter.reject(new OperationPoolCancelledError(this.name, { cause: waiter.options.signal?.reason }));
    } else {
      this.deadlineExceeded += 1;
      waiter.reject(new OperationPoolDeadlineError(this.name, waiter.options.deadline!));
    }
    this.drain();
  }

  private cleanupWaiter(waiter: Waiter<unknown>): void {
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.timer = null;
    if (waiter.abortListener && waiter.options.signal) {
      waiter.options.signal.removeEventListener("abort", waiter.abortListener);
    }
    waiter.abortListener = null;
  }

  private recordWait(waitMs: number): void {
    this.completedWaits += 1;
    this.totalQueueWaitMs += waitMs;
    this.maximumQueueWaitMs = Math.max(this.maximumQueueWaitMs, waitMs);
    this.lastQueueWaitMs = waitMs;
  }

  private recordCompletion(latencyMs: number, error: unknown): void {
    this.completed += 1;
    this.totalLatencyMs += latencyMs;
    this.maximumLatencyMs = Math.max(this.maximumLatencyMs, latencyMs);
    this.lastLatencyMs = latencyMs;
    this.latencyEwmaMs = this.completed === 1 ? latencyMs : ewma(this.latencyEwmaMs, latencyMs);
    const failed = error !== null;
    if (failed) this.failed += 1;
    this.errorRateEwma = this.completed === 1 ? Number(failed) : ewma(this.errorRateEwma, Number(failed));

    const providerBackpressure = failed && this.isBackpressureError(error);
    const latencyBackpressure = latencyMs > this.latencyTargetMs
      && this.latencyEwmaMs > this.latencyTargetMs;
    if (providerBackpressure || latencyBackpressure) {
      this.backpressureEvents += 1;
      this.healthyCompletions = 0;
      this.reduceConcurrency();
      return;
    }

    if (failed || latencyMs > this.latencyTargetMs * 0.75) {
      this.healthyCompletions = 0;
      return;
    }
    this.healthyCompletions += 1;
    this.recoverConcurrency();
  }

  private reduceConcurrency(): void {
    const now = Date.now();
    if (this.effectiveLimit <= this.minimumLimit || now - this.lastAdaptedAt < this.adaptationCooldownMs) return;
    this.effectiveLimit = Math.max(this.minimumLimit, Math.floor(this.effectiveLimit / 2));
    this.lastAdaptedAt = now;
    this.adaptiveReductions += 1;
  }

  private recoverConcurrency(): void {
    if (this.effectiveLimit >= this.configuredLimit || this.healthyCompletions < this.recoverySuccesses) return;
    const now = Date.now();
    if (now - this.lastAdaptedAt < this.adaptationCooldownMs) return;
    this.effectiveLimit += 1;
    this.healthyCompletions = 0;
    this.lastAdaptedAt = now;
    this.adaptiveRecoveries += 1;
    this.drain();
  }

  private waitingCount(): number {
    return this.lanes.interactive.size + this.lanes.background.size;
  }

  private backgroundLimit(): number {
    return Math.max(1, this.effectiveLimit - Math.min(this.interactiveReserve, this.effectiveLimit - 1));
  }
}

function createLane(): Lane {
  return { groups: new Map(), order: [], size: 0 };
}

function enqueue(lane: Lane, waiter: Waiter<unknown>): void {
  const key = waiter.options.fairnessKey;
  const group = lane.groups.get(key);
  if (group) group.push(waiter);
  else {
    lane.groups.set(key, [waiter]);
    lane.order.push(key);
  }
  lane.size += 1;
}

function dequeue(lane: Lane): Waiter<unknown> | null {
  while (lane.order.length > 0) {
    const key = lane.order.shift()!;
    const group = lane.groups.get(key);
    if (!group?.length) {
      lane.groups.delete(key);
      continue;
    }
    const waiter = group.shift()!;
    lane.size -= 1;
    if (group.length) lane.order.push(key);
    else lane.groups.delete(key);
    return waiter;
  }
  return null;
}

function remove(lane: Lane, waiter: Waiter<unknown>): boolean {
  const key = waiter.options.fairnessKey;
  const group = lane.groups.get(key);
  if (!group) return false;
  const index = group.indexOf(waiter);
  if (index < 0) return false;
  group.splice(index, 1);
  lane.size -= 1;
  if (!group.length) {
    lane.groups.delete(key);
    const orderIndex = lane.order.indexOf(key);
    if (orderIndex >= 0) lane.order.splice(orderIndex, 1);
  }
  return true;
}

function ewma(previous: number, value: number): number {
  return previous * (1 - EWMA_ALPHA) + value * EWMA_ALPHA;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const number = value ?? fallback;
  if (!Number.isInteger(number) || number < 1) throw new RangeError(`${label} must be a positive integer`);
  return number;
}

function nonNegativeNumber(value: number | undefined, fallback: number, label: string): number {
  const number = value ?? fallback;
  if (!Number.isFinite(number) || number < 0) throw new RangeError(`${label} must be non-negative`);
  return number;
}

function nonNegativeInteger(value: number | undefined, fallback: number, label: string): number {
  const number = value ?? fallback;
  if (!Number.isInteger(number) || number < 0) throw new RangeError(`${label} must be a non-negative integer`);
  return number;
}
