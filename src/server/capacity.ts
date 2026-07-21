export type CapacityBackend = "codex/standard" | "codex/spark" | "claude";

export type CapacityMetrics = {
  limit: number;
  activeCount: number;
  waitingCount: number;
  acquisitions: number;
  reconciliations: number;
  rejections: number;
  cancellations: number;
  waitTimeMs: {
    total: number;
    average: number;
    maximum: number;
    last: number;
  };
};

export type CapacityReservation = {
  backend: CapacityBackend;
  operationId: string;
  acquiredAt: number;
  reconciled: boolean;
};

type MutableMetrics = {
  acquisitions: number;
  reconciliations: number;
  rejections: number;
  cancellations: number;
  completedWaits: number;
  totalWaitMs: number;
  maximumWaitMs: number;
  lastWaitMs: number;
};

type Waiter = {
  operationId: string;
  requestedAt: number;
  deadline: number;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abortListener?: () => void;
  resolve: (reservation: CapacityReservation) => void;
  reject: (error: Error) => void;
};

type Pool = {
  limit: number;
  active: Map<string, CapacityReservation>;
  waiters: Waiter[];
  metrics: MutableMetrics;
};

const BACKENDS: readonly CapacityBackend[] = ["codex/standard", "codex/spark", "claude"];

/** Raised when an atomic capacity reservation cannot be obtained by its deadline. */
export class CapacityUnavailableError extends Error {
  readonly status = 429;
  readonly code = "BACKEND_CAPACITY_EXHAUSTED";
  readonly retryAfter = 1;

  constructor(readonly backend: CapacityBackend, readonly deadline: number) {
    super(`Timed out waiting for ${backend} turn capacity`);
    this.name = "CapacityUnavailableError";
  }
}

export class CapacityCancelledError extends Error {
  readonly status = 499;
  readonly code = "BACKEND_CAPACITY_CANCELLED";

  constructor(readonly backend: CapacityBackend, options?: ErrorOptions) {
    super(`Cancelled while waiting for ${backend} turn capacity`, options);
    this.name = "CapacityCancelledError";
  }
}

/**
 * Atomically accounts for active backend turns and queues bounded reservation
 * attempts. JavaScript execution between capacity checks and reservations is
 * synchronous, so two callers cannot observe and claim the same slot.
 */
export class CapacityManager {
  private readonly pools: Record<CapacityBackend, Pool>;

  constructor(limits: Record<CapacityBackend, number>) {
    for (const backend of BACKENDS) {
      if (!Number.isInteger(limits[backend]) || limits[backend] < 1) {
        throw new Error(`Capacity limit for ${backend} must be a positive integer`);
      }
    }
    this.pools = {
      "codex/standard": createPool(limits["codex/standard"]),
      "codex/spark": createPool(limits["codex/spark"]),
      claude: createPool(limits.claude)
    };
  }

  acquire(backend: CapacityBackend, operationId: string, deadline: number, signal?: AbortSignal): Promise<CapacityReservation> {
    this.validateOperationId(operationId);
    if (!Number.isFinite(deadline)) throw new Error("Capacity reservation deadline must be finite");
    const existing = this.reservationFor(operationId);
    if (existing) {
      if (existing.backend !== backend) throw new Error(`Capacity operation ${operationId} is already reserved in ${existing.backend}`);
      return Promise.resolve(existing);
    }
    const waitingBackend = this.waitingBackendFor(operationId);
    if (waitingBackend) {
      return Promise.reject(new Error(`Capacity operation ${operationId} is already waiting in ${waitingBackend}`));
    }

    const pool = this.pools[backend];
    const now = Date.now();
    if (signal?.aborted) {
      pool.metrics.cancellations += 1;
      return Promise.reject(new CapacityCancelledError(backend, { cause: signal.reason }));
    }
    this.expireWaiters(backend, now);
    if (deadline <= now) {
      this.recordRejectedWait(pool, 0);
      return Promise.reject(new CapacityUnavailableError(backend, deadline));
    }
    if (pool.active.size < pool.limit && pool.waiters.length === 0) {
      return Promise.resolve(this.grant(backend, operationId, now, false));
    }

    return new Promise<CapacityReservation>((resolve, reject) => {
      const waiter: Waiter = {
        operationId,
        requestedAt: now,
        deadline,
        timer: setTimeout(() => this.rejectWaiter(backend, operationId), Math.max(1, deadline - now)),
        signal,
        resolve,
        reject
      };
      waiter.timer.unref();
      if (signal) {
        waiter.abortListener = () => this.cancelWaiter(backend, operationId);
        signal.addEventListener("abort", waiter.abortListener, { once: true });
      }
      pool.waiters.push(waiter);
      this.drain(backend);
    });
  }

  /** Accounts for a turn found already running during startup/reconnect. */
  reconcile(backend: CapacityBackend, operationId: string): CapacityReservation {
    this.validateOperationId(operationId);
    const existing = this.reservationFor(operationId);
    if (existing) {
      if (existing.backend !== backend) throw new Error(`Capacity operation ${operationId} is already reserved in ${existing.backend}`);
      return existing;
    }
    const waitingBackend = this.waitingBackendFor(operationId);
    if (waitingBackend && waitingBackend !== backend) {
      throw new Error(`Capacity operation ${operationId} is already waiting in ${waitingBackend}`);
    }

    const pool = this.pools[backend];
    const waiterIndex = pool.waiters.findIndex((waiter) => waiter.operationId === operationId);
    if (waiterIndex >= 0) {
      const [waiter] = pool.waiters.splice(waiterIndex, 1);
      cleanupWaiter(waiter);
      const reservation = this.grant(backend, operationId, waiter.requestedAt, true);
      waiter.resolve(reservation);
      return reservation;
    }
    return this.grant(backend, operationId, Date.now(), true);
  }

  /** Releases one active operation and atomically hands its slot to the next waiter. */
  release(operationId: string): CapacityBackend | null {
    for (const backend of BACKENDS) {
      const pool = this.pools[backend];
      if (!pool.active.delete(operationId)) continue;
      this.drain(backend);
      return backend;
    }
    return null;
  }

  /** Releases all active reservations for a dead or disconnected backend. */
  releaseBackend(backend: CapacityBackend): number {
    const pool = this.pools[backend];
    const released = pool.active.size;
    pool.active.clear();
    this.drain(backend);
    return released;
  }

  has(operationId: string): boolean {
    return this.reservationFor(operationId) !== null;
  }

  metrics(): Record<CapacityBackend, CapacityMetrics> {
    return Object.fromEntries(BACKENDS.map((backend) => {
      const pool = this.pools[backend];
      const completed = pool.metrics.completedWaits;
      return [backend, {
        limit: pool.limit,
        activeCount: pool.active.size,
        waitingCount: pool.waiters.length,
        acquisitions: pool.metrics.acquisitions,
        reconciliations: pool.metrics.reconciliations,
        rejections: pool.metrics.rejections,
        cancellations: pool.metrics.cancellations,
        waitTimeMs: {
          total: pool.metrics.totalWaitMs,
          average: completed ? Math.round((pool.metrics.totalWaitMs / completed) * 100) / 100 : 0,
          maximum: pool.metrics.maximumWaitMs,
          last: pool.metrics.lastWaitMs
        }
      }];
    })) as Record<CapacityBackend, CapacityMetrics>;
  }

  private grant(backend: CapacityBackend, operationId: string, requestedAt: number, reconciled: boolean): CapacityReservation {
    const pool = this.pools[backend];
    const acquiredAt = Date.now();
    const reservation = { backend, operationId, acquiredAt, reconciled } satisfies CapacityReservation;
    pool.active.set(operationId, reservation);
    if (reconciled) pool.metrics.reconciliations += 1;
    else {
      pool.metrics.acquisitions += 1;
      this.recordWait(pool, Math.max(0, acquiredAt - requestedAt));
    }
    return reservation;
  }

  private drain(backend: CapacityBackend): void {
    const pool = this.pools[backend];
    this.expireWaiters(backend, Date.now());
    while (pool.active.size < pool.limit && pool.waiters.length > 0) {
      const waiter = pool.waiters.shift()!;
      cleanupWaiter(waiter);
      const reservation = this.grant(backend, waiter.operationId, waiter.requestedAt, false);
      waiter.resolve(reservation);
    }
  }

  private expireWaiters(backend: CapacityBackend, now: number): void {
    const pool = this.pools[backend];
    for (let index = pool.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = pool.waiters[index];
      if (waiter.deadline > now) continue;
      pool.waiters.splice(index, 1);
      cleanupWaiter(waiter);
      this.recordRejectedWait(pool, Math.max(0, now - waiter.requestedAt));
      waiter.reject(new CapacityUnavailableError(backend, waiter.deadline));
    }
  }

  private rejectWaiter(backend: CapacityBackend, operationId: string): void {
    const pool = this.pools[backend];
    const index = pool.waiters.findIndex((waiter) => waiter.operationId === operationId);
    if (index < 0) return;
    const [waiter] = pool.waiters.splice(index, 1);
    cleanupWaiter(waiter);
    this.recordRejectedWait(pool, Math.max(0, Date.now() - waiter.requestedAt));
    waiter.reject(new CapacityUnavailableError(backend, waiter.deadline));
  }

  private cancelWaiter(backend: CapacityBackend, operationId: string): void {
    const pool = this.pools[backend];
    const index = pool.waiters.findIndex((waiter) => waiter.operationId === operationId);
    if (index < 0) return;
    const [waiter] = pool.waiters.splice(index, 1);
    cleanupWaiter(waiter);
    pool.metrics.cancellations += 1;
    waiter.reject(new CapacityCancelledError(backend, { cause: waiter.signal?.reason }));
    this.drain(backend);
  }

  private reservationFor(operationId: string): CapacityReservation | null {
    for (const backend of BACKENDS) {
      const reservation = this.pools[backend].active.get(operationId);
      if (reservation) return reservation;
    }
    return null;
  }

  private waitingBackendFor(operationId: string): CapacityBackend | null {
    for (const backend of BACKENDS) {
      if (this.pools[backend].waiters.some((waiter) => waiter.operationId === operationId)) return backend;
    }
    return null;
  }

  private recordRejectedWait(pool: Pool, waitMs: number): void {
    pool.metrics.rejections += 1;
    this.recordWait(pool, waitMs);
  }

  private recordWait(pool: Pool, waitMs: number): void {
    const rounded = Math.round(waitMs * 100) / 100;
    pool.metrics.completedWaits += 1;
    pool.metrics.totalWaitMs += rounded;
    pool.metrics.maximumWaitMs = Math.max(pool.metrics.maximumWaitMs, rounded);
    pool.metrics.lastWaitMs = rounded;
  }

  private validateOperationId(operationId: string): void {
    if (!operationId.trim()) throw new Error("Capacity operation id is required");
  }
}

function createPool(limit: number): Pool {
  return {
    limit,
    active: new Map<string, CapacityReservation>(),
    waiters: [],
    metrics: {
      acquisitions: 0,
      reconciliations: 0,
      rejections: 0,
      cancellations: 0,
      completedWaits: 0,
      totalWaitMs: 0,
      maximumWaitMs: 0,
      lastWaitMs: 0
    }
  };
}

function cleanupWaiter(waiter: Waiter): void {
  clearTimeout(waiter.timer);
  if (waiter.signal && waiter.abortListener) waiter.signal.removeEventListener("abort", waiter.abortListener);
}
