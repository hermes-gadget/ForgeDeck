import { randomUUID } from "node:crypto";
import {
  evalRequestSchema,
  type EvalCriterionResult,
  type EvalModel,
  type EvalScore,
  type EvalSuccessCriteria
} from "../shared/contracts.js";
import { BlueprintManager } from "./blueprints.js";
import { TransactionalStore, type EvalRunStoreStatus } from "./store.js";

const EVAL_SCHEMA_VERSION = 1 as const;
const EVAL_SCORER_VERSION = 1 as const;

type EvalResultStatus = "queued" | "running" | "passed" | "failed" | "error";

export type EvalResult = {
  model: EvalModel;
  status: EvalResultStatus;
  operationId: string | null;
  threadId: string | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  output: string;
  error: string | null;
  score: EvalScore | null;
};

export type EvalRun = {
  schemaVersion: typeof EVAL_SCHEMA_VERSION;
  id: string;
  version: number;
  name: string;
  blueprint: { id: string; version: number; name: string };
  variables: Record<string, string | number | boolean>;
  workspace: string;
  prompt: string;
  successCriteria: EvalSuccessCriteria;
  status: EvalRunStoreStatus;
  passed: boolean | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  results: EvalResult[];
};

export type EvalScoreInput = {
  turnStatus: string;
  output: string;
  durationMs: number;
  totalTokens: number;
  blueprintGates: { status: string; metGateCount: number; requiredGateCount: number };
};

class EvalNotFoundError extends Error {
  constructor(message = "Eval not found") {
    super(message);
    this.name = "EvalNotFoundError";
  }
}

export class EvalManager {
  constructor(
    private readonly store: TransactionalStore,
    private readonly blueprints: BlueprintManager,
    private readonly now: () => number = Date.now
  ) {}

  create(value: unknown): EvalRun {
    const input = evalRequestSchema.parse(value);
    const resolved = this.blueprints.resolve(input.blueprintId, input.blueprintVersion, input.variables);
    const createdAt = timestamp(this.now());
    const candidateVersion = (input.evalId ? this.store.getEvalRun(input.evalId)?.version || 0 : 0) + 1;
    const run: EvalRun = {
      schemaVersion: EVAL_SCHEMA_VERSION,
      id: input.evalId || randomUUID(),
      version: candidateVersion,
      name: input.name,
      blueprint: {
        id: resolved.manifest.id,
        version: resolved.manifest.version,
        name: resolved.manifest.name
      },
      variables: { ...resolved.variables },
      workspace: input.workspace,
      prompt: resolved.prompt,
      successCriteria: cloneCriteria(input.successCriteria),
      status: "queued",
      passed: null,
      createdAt,
      startedAt: null,
      completedAt: null,
      results: input.models.map(emptyResult)
    };
    const stored = this.store.insertEvalRun({
      id: run.id,
      status: run.status,
      payload: JSON.stringify(run),
      createdAt,
      updatedAt: createdAt
    });
    if (stored.version !== run.version) {
      run.version = stored.version;
      this.persist(run);
    }
    return cloneRun(run);
  }

  get(id: string, version?: number): EvalRun | null {
    const row = this.store.getEvalRun(id, version);
    return row ? decodeRun(row.payload) : null;
  }

  list(limit = 100): EvalRun[] {
    return this.store.listEvalRuns(limit).map((row) => decodeRun(row.payload));
  }

  start(id: string, version: number): EvalRun {
    return this.mutate(id, version, (run) => {
      if (run.status !== "queued") return;
      run.status = "running";
      run.startedAt = timestamp(this.now());
    });
  }

  updateResult(id: string, version: number, index: number, update: Partial<EvalResult>): EvalRun {
    return this.mutate(id, version, (run) => {
      const current = run.results[index];
      if (!current) throw new RangeError(`Eval result ${index} was not found`);
      run.results[index] = { ...current, ...structuredClone(update), model: current.model };
    });
  }

  complete(id: string, version: number): EvalRun {
    return this.mutate(id, version, (run) => {
      run.status = "completed";
      run.completedAt = timestamp(this.now());
      run.passed = run.results.length > 0 && run.results.every((result) => result.status === "passed");
    });
  }

  fail(id: string, version: number, error: unknown): EvalRun {
    const message = errorMessage(error);
    return this.mutate(id, version, (run) => {
      run.status = "failed";
      run.completedAt = timestamp(this.now());
      run.passed = false;
      run.results = run.results.map((result) => result.status === "queued" || result.status === "running"
        ? { ...result, status: "error", completedAt: run.completedAt, error: message }
        : result);
    });
  }

  recoverInterrupted(): EvalRun[] {
    return this.list(1_000)
      .filter((run) => run.status === "queued" || run.status === "running")
      .map((run) => this.fail(run.id, run.version, "ForgeDeck stopped before this eval completed"));
  }

  private mutate(id: string, version: number, update: (run: EvalRun) => void): EvalRun {
    const run = this.get(id, version);
    if (!run) throw new EvalNotFoundError();
    update(run);
    this.persist(run);
    return cloneRun(run);
  }

  private persist(run: EvalRun): void {
    if (!this.store.updateEvalRun({
      id: run.id,
      version: run.version,
      status: run.status,
      payload: JSON.stringify(run),
      createdAt: run.createdAt,
      updatedAt: timestamp(this.now())
    })) throw new EvalNotFoundError();
  }
}

export function scoreEval(criteria: EvalSuccessCriteria, input: EvalScoreInput): EvalScore {
  const results: EvalCriterionResult[] = [];
  results.push(criterion("turn completed", "completed", input.turnStatus, input.turnStatus === "completed"));
  const normalizedOutput = input.output.toLocaleLowerCase();
  for (const phrase of criteria.requiredPhrases) {
    const matched = normalizedOutput.includes(phrase.toLocaleLowerCase());
    results.push(criterion(`output contains “${phrase}”`, true, matched, matched));
  }
  for (const phrase of criteria.forbiddenPhrases) {
    const absent = !normalizedOutput.includes(phrase.toLocaleLowerCase());
    results.push(criterion(`output excludes “${phrase}”`, true, absent, absent));
  }
  if (criteria.maxDurationMs !== null) {
    results.push(criterion("duration within limit", criteria.maxDurationMs, input.durationMs, input.durationMs <= criteria.maxDurationMs));
  }
  if (criteria.maxTotalTokens !== null) {
    results.push(criterion("tokens within limit", criteria.maxTotalTokens, input.totalTokens, input.totalTokens <= criteria.maxTotalTokens));
  }
  if (criteria.requireBlueprintGates) {
    const gatesPassed = input.blueprintGates.status === "passed";
    results.push(criterion(
      "blueprint completion gates",
      input.blueprintGates.requiredGateCount,
      input.blueprintGates.metGateCount,
      gatesPassed
    ));
  }
  return {
    scorerVersion: EVAL_SCORER_VERSION,
    passed: results.every((result) => result.passed),
    criteria: results
  };
}

export function evalOutput(thread: Record<string, unknown>): { output: string; turnStatus: string } {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const turn = [...turns].reverse().find((candidate) => candidate && typeof candidate === "object") as Record<string, unknown> | undefined;
  if (!turn) return { output: "", turnStatus: "missing" };
  const items = Array.isArray(turn.items) ? turn.items : [];
  const output = items.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const item = candidate as Record<string, unknown>;
    if (!["agentMessage", "assistantMessage"].includes(String(item.type))) return [];
    const direct = typeof item.text === "string" ? [item.text] : [];
    const content = Array.isArray(item.content)
      ? item.content.flatMap((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : [])
      : [];
    return [...direct, ...content];
  }).join("\n").trim();
  return { output, turnStatus: typeof turn.status === "string" ? turn.status : "unknown" };
}

function emptyResult(model: EvalModel): EvalResult {
  return {
    model: structuredClone(model),
    status: "queued",
    operationId: null,
    threadId: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    output: "",
    error: null,
    score: null
  };
}

function criterion(
  criterionName: string,
  expected: string | number | boolean,
  actual: string | number | boolean,
  passed: boolean
): EvalCriterionResult {
  return { criterion: criterionName, expected, actual, passed };
}

function decodeRun(payload: string): EvalRun {
  const parsed = JSON.parse(payload) as EvalRun;
  if (parsed.schemaVersion !== EVAL_SCHEMA_VERSION || !parsed.id || !Number.isInteger(parsed.version)) {
    throw new Error("Stored eval run is invalid");
  }
  return cloneRun(parsed);
}

function cloneRun(run: EvalRun): EvalRun {
  return structuredClone(run);
}

function cloneCriteria(criteria: EvalSuccessCriteria): EvalSuccessCriteria {
  return structuredClone(criteria);
}

function timestamp(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError("Eval timestamp must be non-negative");
  return Math.round(value);
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 2_000) || "Eval failed";
}
