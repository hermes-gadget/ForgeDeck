import { randomUUID } from "node:crypto";
import { BackendUnavailableError, serializeError, type SerializedForgeDeckError } from "./errors.js";

export type BackgroundTaskDefinition = {
  name: string;
  safeFailureMessage: string;
  task: () => void | Promise<void>;
  intervalMs: number;
  initialDelayMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
};

type BackgroundTaskHealth = {
  name: string;
  status: "starting" | "ok" | "degraded" | "stopped";
  running: boolean;
  attempts: number;
  consecutiveFailures: number;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  nextRunAt: number | null;
  error: SerializedForgeDeckError | null;
};

export type BackgroundHealthReport = {
  status: "ok" | "degraded" | "starting" | "stopped";
  tasks: BackgroundTaskHealth[];
};

type TaskState = {
  definition: Required<Omit<BackgroundTaskDefinition, "task">> & Pick<BackgroundTaskDefinition, "task">;
  health: BackgroundTaskHealth;
  timer: NodeJS.Timeout | null;
  generation: number;
};

type BackgroundTaskSupervisorOptions = {
  onHealthChange?: (report: BackgroundHealthReport) => void;
  wait?: (delayMs: number) => Promise<void>;
};

/** Runs recurring maintenance without overlap and exposes bounded-retry health. */
export class BackgroundTaskSupervisor {
  private readonly tasks = new Map<string, TaskState>();
  private readonly onHealthChange?: (report: BackgroundHealthReport) => void;
  private readonly wait: (delayMs: number) => Promise<void>;

  constructor(options: BackgroundTaskSupervisorOptions = {}) {
    this.onHealthChange = options.onHealthChange;
    this.wait = options.wait || wait;
  }

  register(definition: BackgroundTaskDefinition): void {
    if (!definition.name.trim() || this.tasks.has(definition.name)) throw new Error(`Background task already registered: ${definition.name}`);
    if (!Number.isFinite(definition.intervalMs) || definition.intervalMs < 1) throw new Error("Background task interval must be positive");
    const normalized = {
      ...definition,
      initialDelayMs: nonNegative(definition.initialDelayMs, 0),
      maxAttempts: positiveInteger(definition.maxAttempts, 3),
      retryBaseDelayMs: positiveInteger(definition.retryBaseDelayMs, 250),
      retryMaxDelayMs: positiveInteger(definition.retryMaxDelayMs, 5_000)
    };
    this.tasks.set(definition.name, {
      definition: normalized,
      timer: null,
      generation: 0,
      health: {
        name: definition.name,
        status: "stopped",
        running: false,
        attempts: 0,
        consecutiveFailures: 0,
        lastRunAt: null,
        lastSuccessAt: null,
        nextRunAt: null,
        error: null
      }
    });
  }

  startAll(): void {
    for (const state of this.tasks.values()) this.start(state);
  }

  stopAll(): void {
    for (const state of this.tasks.values()) {
      state.generation += 1;
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      state.health = { ...state.health, status: "stopped", running: false, nextRunAt: null };
    }
    this.emitHealth();
  }

  async runNow(name: string): Promise<void> {
    const state = this.tasks.get(name);
    if (!state) throw new Error(`Unknown background task: ${name}`);
    await this.execute(state, state.generation);
  }

  getHealth(): BackgroundHealthReport {
    const tasks = [...this.tasks.values()].map(({ health }) => ({
      ...health,
      error: health.error ? { ...health.error } : null
    }));
    const statuses = new Set(tasks.map((task) => task.status));
    const status = statuses.has("degraded") ? "degraded"
      : statuses.has("starting") ? "starting"
        : tasks.length > 0 && tasks.every((task) => task.status === "stopped") ? "stopped" : "ok";
    return { status, tasks };
  }

  private start(state: TaskState): void {
    state.generation += 1;
    if (state.timer) clearTimeout(state.timer);
    state.health = { ...state.health, status: "starting", nextRunAt: Date.now() + state.definition.initialDelayMs };
    this.schedule(state, state.definition.initialDelayMs, state.generation);
    this.emitHealth();
  }

  private schedule(state: TaskState, delayMs: number, generation: number): void {
    state.health.nextRunAt = Date.now() + delayMs;
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.execute(state, generation).finally(() => {
        if (state.generation !== generation || state.health.status === "stopped") return;
        this.schedule(state, state.definition.intervalMs, generation);
        this.emitHealth();
      });
    }, delayMs);
    state.timer.unref();
  }

  private async execute(state: TaskState, generation: number): Promise<void> {
    if (state.health.running || state.generation !== generation) return;
    state.health = { ...state.health, running: true, nextRunAt: null, lastRunAt: Date.now(), attempts: 0 };
    this.emitHealth();
    let lastError: unknown;
    for (let attempt = 1; attempt <= state.definition.maxAttempts; attempt += 1) {
      if (state.generation !== generation) break;
      state.health.attempts = attempt;
      try {
        await state.definition.task();
        state.health = {
          ...state.health,
          status: "ok",
          running: false,
          consecutiveFailures: 0,
          lastSuccessAt: Date.now(),
          error: null
        };
        this.emitHealth();
        return;
      } catch (error) {
        lastError = error;
        if (attempt < state.definition.maxAttempts) {
          const delayMs = Math.min(state.definition.retryMaxDelayMs, state.definition.retryBaseDelayMs * 2 ** (attempt - 1));
          await this.wait(delayMs);
        }
      }
    }
    if (state.generation !== generation) return;
    const typed = new BackendUnavailableError(state.definition.safeFailureMessage, {
      cause: lastError,
      code: "BACKGROUND_TASK_FAILED",
      requestId: randomUUID(),
      scope: "background",
      retryable: true
    });
    state.health = {
      ...state.health,
      status: "degraded",
      running: false,
      consecutiveFailures: state.health.consecutiveFailures + 1,
      error: serializeError(typed)
    };
    this.emitHealth();
  }

  private emitHealth(): void {
    this.onHealthChange?.(this.getHealth());
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref();
  });
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function nonNegative(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : fallback;
}
