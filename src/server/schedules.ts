import { randomUUID } from "node:crypto";
import { BlueprintManager, BlueprintValidationError, type BlueprintVariableValue } from "./blueprints.js";
import {
  TransactionalStore,
  type ScheduleRunStoreRow,
  type ScheduleRunStatus,
  type ScheduleStoreRow
} from "./store.js";

const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 365 * 24 * 60 * 60_000;
const DEFAULT_HISTORY_LIMIT = 20;
const MAX_DUE_PER_TICK = 100;

type ScheduleTiming =
  | { type: "once"; runAt: number }
  | { type: "interval"; intervalMs: number }
  | { type: "cron"; expression: string };

export type ScheduleRun = {
  id: string;
  scheduleId: string;
  scheduledAt: number;
  startedAt: number;
  completedAt: number | null;
  status: ScheduleRunStatus;
  operationId: string | null;
  threadId: string | null;
  error: string | null;
};

export type AgentSchedule = {
  id: string;
  name: string;
  blueprintId: string;
  blueprintVersion: number;
  variables: Record<string, BlueprintVariableValue>;
  workspace: string | null;
  timing: ScheduleTiming;
  createdAt: number;
  updatedAt: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  recentRuns: ScheduleRun[];
};

type ScheduleDraft = {
  name: string;
  blueprintId: string;
  blueprintVersion: number;
  variables: Record<string, BlueprintVariableValue>;
  workspace: string | null;
  timing: ScheduleTiming;
};

export type ScheduledOperation = {
  id: string;
  status: string;
  remoteThreadId: string | null;
  error: Record<string, unknown> | null;
};

export class ScheduleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleValidationError";
  }
}

export class ScheduleConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleConflictError";
  }
}

export class ScheduleManager {
  constructor(
    private readonly store: TransactionalStore,
    private readonly blueprints: BlueprintManager,
    private readonly now: () => number = Date.now
  ) {}

  create(value: unknown): AgentSchedule {
    const timestamp = this.timestamp();
    const draft = this.validateDraft(value);
    const row: ScheduleStoreRow = {
      id: randomUUID(),
      name: draft.name,
      blueprintId: draft.blueprintId,
      blueprintVersion: draft.blueprintVersion,
      variablesJson: JSON.stringify(draft.variables),
      workspace: draft.workspace,
      timingJson: JSON.stringify(draft.timing),
      createdAt: timestamp,
      updatedAt: timestamp,
      lastRunAt: null,
      nextRunAt: firstOccurrence(draft.timing, timestamp)
    };
    try {
      this.store.insertSchedule(row);
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) throw new ScheduleConflictError("Schedule already exists");
      throw error;
    }
    return this.decode(row);
  }

  update(idValue: unknown, value: unknown): AgentSchedule {
    const id = scheduleId(idValue);
    const previous = this.store.getSchedule(id);
    if (!previous) throw new ScheduleValidationError("Schedule was not found");
    const timestamp = this.timestamp();
    const draft = this.validateDraft(value);
    const row: ScheduleStoreRow = {
      ...previous,
      name: draft.name,
      blueprintId: draft.blueprintId,
      blueprintVersion: draft.blueprintVersion,
      variablesJson: JSON.stringify(draft.variables),
      workspace: draft.workspace,
      timingJson: JSON.stringify(draft.timing),
      updatedAt: timestamp,
      nextRunAt: firstOccurrence(draft.timing, timestamp)
    };
    if (!this.store.updateSchedule(row)) throw new ScheduleValidationError("Schedule was not found");
    return this.decode(row);
  }

  get(idValue: unknown, historyLimit = DEFAULT_HISTORY_LIMIT): AgentSchedule | null {
    const row = this.store.getSchedule(scheduleId(idValue));
    return row ? this.decode(row, historyLimit) : null;
  }

  list(historyLimit = DEFAULT_HISTORY_LIMIT): AgentSchedule[] {
    if (!Number.isInteger(historyLimit) || historyLimit < 1 || historyLimit > 100) {
      throw new ScheduleValidationError("Schedule history limit must be between 1 and 100");
    }
    return this.store.listSchedules().map((row) => this.decode(row, historyLimit));
  }

  delete(idValue: unknown): boolean {
    return this.store.deleteSchedule(scheduleId(idValue));
  }

  claimDue(limit = MAX_DUE_PER_TICK): ScheduleRun[] {
    const timestamp = this.timestamp();
    const claimed: ScheduleRun[] = [];
    for (const row of this.store.listDueSchedules(timestamp, limit)) {
      if (row.nextRunAt === null) continue;
      const timing = timingFromJson(row.timingJson);
      const run: ScheduleRunStoreRow = {
        id: randomUUID(),
        scheduleId: row.id,
        scheduledAt: row.nextRunAt,
        startedAt: timestamp,
        completedAt: null,
        status: "pending",
        operationId: null,
        threadId: null,
        error: null
      };
      const nextRunAt = subsequentOccurrence(timing, row.nextRunAt, timestamp);
      if (this.store.claimScheduleRun(run, row.nextRunAt, nextRunAt)) claimed.push(run);
    }
    return claimed;
  }

  unfinishedRuns(limit = MAX_DUE_PER_TICK): ScheduleRun[] {
    return this.store.listUnfinishedScheduleRuns(limit);
  }

  markRunning(run: ScheduleRun, operationId: string): void {
    this.store.updateScheduleRun({ ...run, status: "running", operationId, error: null });
  }

  markSucceeded(run: ScheduleRun, threadId: string | null): void {
    this.store.updateScheduleRun({
      ...run,
      status: "succeeded",
      threadId,
      completedAt: this.timestamp(),
      error: null
    });
  }

  markFailed(run: ScheduleRun, error: unknown): void {
    this.store.updateScheduleRun({
      ...run,
      status: "failed",
      completedAt: this.timestamp(),
      error: errorMessage(error)
    });
  }

  private validateDraft(value: unknown): ScheduleDraft {
    const record = object(value, "Schedule");
    allowedKeys(record, ["name", "blueprintId", "blueprintVersion", "variables", "workspace", "timing"]);
    const blueprintId = identifier(record.blueprintId, "Blueprint ID", 128);
    const requestedVersion = record.blueprintVersion === undefined || record.blueprintVersion === null
      ? undefined
      : positiveInteger(record.blueprintVersion, "Blueprint version");
    const manifest = this.blueprints.get(blueprintId, requestedVersion);
    if (!manifest) throw new ScheduleValidationError("Blueprint version was not found");
    let variables: Record<string, BlueprintVariableValue>;
    try {
      variables = this.blueprints.resolve(blueprintId, manifest.version, record.variables ?? {}).variables;
    } catch (error) {
      if (error instanceof BlueprintValidationError) throw new ScheduleValidationError(error.message);
      throw error;
    }
    const workspace = optionalText(record.workspace, "Schedule workspace", 4_096);
    if (manifest.definition.workspace.selector === "current" && !workspace) {
      throw new ScheduleValidationError("Blueprints using the current workspace require a schedule workspace");
    }
    const timing = validateTiming(record.timing, this.timestamp());
    const name = optionalText(record.name, "Schedule name", 100) || `${manifest.name} schedule`;
    return { name, blueprintId, blueprintVersion: manifest.version, variables, workspace, timing };
  }

  private decode(row: ScheduleStoreRow, historyLimit = DEFAULT_HISTORY_LIMIT): AgentSchedule {
    return {
      id: row.id,
      name: row.name,
      blueprintId: row.blueprintId,
      blueprintVersion: row.blueprintVersion,
      variables: variablesFromJson(row.variablesJson),
      workspace: row.workspace,
      timing: timingFromJson(row.timingJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastRunAt: row.lastRunAt,
      nextRunAt: row.nextRunAt,
      recentRuns: this.store.listScheduleRuns(row.id, historyLimit)
    };
  }

  private timestamp(): number {
    const value = this.now();
    if (!Number.isFinite(value) || value < 0) throw new RangeError("Schedule clock must return a non-negative timestamp");
    return Math.round(value);
  }
}

export class ScheduleRunner {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly schedules: ScheduleManager,
    private readonly fire: (schedule: AgentSchedule, run: ScheduleRun) => Promise<{ operationId: string }>,
    private readonly inspectOperation: (operationId: string) => ScheduledOperation | null,
    private readonly intervalMs = 60_000,
    private readonly onError: (error: unknown) => void = () => undefined
  ) {
    if (!Number.isInteger(intervalMs) || intervalMs <= 0) throw new RangeError("Schedule check interval must be positive");
  }

  start(): void {
    if (this.timer) return;
    void this.tick().catch(this.onError);
    this.timer = setInterval(() => void this.tick().catch(this.onError), this.intervalMs);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.schedules.claimDue();
      const unfinished = this.schedules.unfinishedRuns();
      for (const run of unfinished) {
        const schedule = this.schedules.get(run.scheduleId);
        if (!schedule) continue;
        if (run.status === "pending") {
          try {
            const { operationId } = await this.fire(schedule, run);
            this.schedules.markRunning(run, operationId);
          } catch (error) {
            this.schedules.markFailed(run, error);
          }
          continue;
        }
        if (!run.operationId) {
          this.schedules.markFailed(run, "Scheduled session operation is missing");
          continue;
        }
        const operation = this.inspectOperation(run.operationId);
        if (!operation) continue;
        if (operation.status === "succeeded") this.schedules.markSucceeded(run, operation.remoteThreadId);
        if (operation.status === "failed") this.schedules.markFailed(run, operation.error || "Scheduled session creation failed");
      }
    } finally {
      this.ticking = false;
    }
  }
}

export function nextCronOccurrence(expression: string, after: number): number {
  const fields = parseCron(expression);
  const candidate = new Date(Math.floor(after / MIN_INTERVAL_MS) * MIN_INTERVAL_MS + MIN_INTERVAL_MS);
  candidate.setSeconds(0, 0);
  const maxMinutes = 5 * 366 * 24 * 60;
  for (let count = 0; count < maxMinutes; count += 1) {
    if (cronMatches(fields, candidate)) return candidate.getTime();
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  throw new ScheduleValidationError("Cron expression does not produce a run within five years");
}

function firstOccurrence(timing: ScheduleTiming, now: number): number {
  if (timing.type === "once") return timing.runAt;
  if (timing.type === "interval") return now + timing.intervalMs;
  return nextCronOccurrence(timing.expression, now);
}

function subsequentOccurrence(timing: ScheduleTiming, scheduledAt: number, now: number): number | null {
  if (timing.type === "once") return null;
  if (timing.type === "cron") return nextCronOccurrence(timing.expression, now);
  const skipped = Math.floor(Math.max(0, now - scheduledAt) / timing.intervalMs) + 1;
  return scheduledAt + skipped * timing.intervalMs;
}

function validateTiming(value: unknown, now: number): ScheduleTiming {
  const record = object(value, "Schedule timing");
  const type = record.type;
  if (type === "once") {
    allowedKeys(record, ["type", "runAt"]);
    const runAt = timestamp(record.runAt, "One-shot run time");
    if (runAt < now) throw new ScheduleValidationError("One-shot run time must not be in the past");
    return { type, runAt };
  }
  if (type === "interval") {
    allowedKeys(record, ["type", "intervalMs"]);
    const intervalMs = positiveInteger(record.intervalMs, "Schedule interval");
    if (intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
      throw new ScheduleValidationError("Schedule interval must be between one minute and one year");
    }
    return { type, intervalMs };
  }
  if (type === "cron") {
    allowedKeys(record, ["type", "expression"]);
    const expression = text(record.expression, "Cron expression", 200);
    parseCron(expression);
    return { type, expression };
  }
  throw new ScheduleValidationError("Schedule timing type must be once, interval, or cron");
}

type CronFields = {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  anyDayOfMonth: boolean;
  anyDayOfWeek: boolean;
};

function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new ScheduleValidationError("Cron expressions must contain five fields: minute hour day month weekday");
  return {
    minute: cronField(parts[0]!, 0, 59, "minute"),
    hour: cronField(parts[1]!, 0, 23, "hour"),
    dayOfMonth: cronField(parts[2]!, 1, 31, "day of month"),
    month: cronField(parts[3]!, 1, 12, "month"),
    dayOfWeek: cronField(parts[4]!, 0, 7, "weekday", true),
    anyDayOfMonth: parts[2] === "*",
    anyDayOfWeek: parts[4] === "*"
  };
}

function cronField(source: string, minimum: number, maximum: number, label: string, normalizeSunday = false): Set<number> {
  const values = new Set<number>();
  for (const segment of source.split(",")) {
    if (!segment) throw new ScheduleValidationError(`Cron ${label} field is invalid`);
    const [base, stepSource, extra] = segment.split("/");
    if (extra !== undefined) throw new ScheduleValidationError(`Cron ${label} field is invalid`);
    const step = stepSource === undefined ? 1 : cronInteger(stepSource, 1, maximum - minimum + 1, label);
    let start: number;
    let end: number;
    if (base === "*") {
      start = minimum;
      end = maximum;
    } else if (base?.includes("-")) {
      const range = base.split("-");
      if (range.length !== 2) throw new ScheduleValidationError(`Cron ${label} range is invalid`);
      start = cronInteger(range[0]!, minimum, maximum, label);
      end = cronInteger(range[1]!, minimum, maximum, label);
      if (start > end) throw new ScheduleValidationError(`Cron ${label} range must be ascending`);
    } else {
      start = cronInteger(base || "", minimum, maximum, label);
      end = stepSource === undefined ? start : maximum;
    }
    for (let value = start; value <= end; value += step) values.add(normalizeSunday && value === 7 ? 0 : value);
  }
  return values;
}

function cronInteger(value: string, minimum: number, maximum: number, label: string): number {
  if (!/^\d+$/.test(value)) throw new ScheduleValidationError(`Cron ${label} must be numeric`);
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) throw new ScheduleValidationError(`Cron ${label} must be between ${minimum} and ${maximum}`);
  return parsed;
}

function cronMatches(fields: CronFields, date: Date): boolean {
  if (!fields.minute.has(date.getMinutes()) || !fields.hour.has(date.getHours()) || !fields.month.has(date.getMonth() + 1)) return false;
  const dayOfMonth = fields.dayOfMonth.has(date.getDate());
  const dayOfWeek = fields.dayOfWeek.has(date.getDay());
  const dayMatches = fields.anyDayOfMonth && fields.anyDayOfWeek
    ? true
    : fields.anyDayOfMonth
      ? dayOfWeek
      : fields.anyDayOfWeek
        ? dayOfMonth
        : dayOfMonth || dayOfWeek;
  return dayMatches;
}

function timingFromJson(value: string): ScheduleTiming {
  return validateStoredTiming(JSON.parse(value) as unknown);
}

function validateStoredTiming(value: unknown): ScheduleTiming {
  const record = object(value, "Stored schedule timing");
  if (record.type === "once") return { type: "once", runAt: timestamp(record.runAt, "Stored one-shot time") };
  if (record.type === "interval") return { type: "interval", intervalMs: positiveInteger(record.intervalMs, "Stored interval") };
  if (record.type === "cron") return { type: "cron", expression: text(record.expression, "Stored cron expression", 200) };
  throw new ScheduleValidationError("Stored schedule timing is invalid");
}

function variablesFromJson(value: string): Record<string, BlueprintVariableValue> {
  const record = object(JSON.parse(value) as unknown, "Stored schedule variables");
  const result: Record<string, BlueprintVariableValue> = {};
  for (const [key, candidate] of Object.entries(record)) {
    if (typeof candidate !== "string" && typeof candidate !== "number" && typeof candidate !== "boolean") {
      throw new ScheduleValidationError("Stored schedule variables are invalid");
    }
    result[key] = candidate;
  }
  return result;
}

function scheduleId(value: unknown): string {
  return identifier(value, "Schedule ID", 128);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ScheduleValidationError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function allowedKeys(record: Record<string, unknown>, keys: string[]): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) throw new ScheduleValidationError(`Unexpected schedule field ${unknown}`);
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) throw new ScheduleValidationError(`${label} is required`);
  if (value.length > maximum) throw new ScheduleValidationError(`${label} must be ${maximum} characters or fewer`);
  return value.trim();
}

function optionalText(value: unknown, label: string, maximum: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  return text(value, label, maximum);
}

function identifier(value: unknown, label: string, maximum: number): string {
  const result = text(value, label, maximum);
  if (!/^[a-zA-Z0-9._:-]+$/.test(result)) throw new ScheduleValidationError(`${label} contains invalid characters`);
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new ScheduleValidationError(`${label} must be a positive integer`);
  return value;
}

function timestamp(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) throw new ScheduleValidationError(`${label} must be a valid timestamp`);
  return Math.round(parsed);
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error.slice(0, 2_000);
  if (error instanceof Error) return error.message.slice(0, 2_000);
  try { return JSON.stringify(error).slice(0, 2_000); } catch { return "Scheduled session creation failed"; }
}
