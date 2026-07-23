import * as z from "zod/v4";

export const CONTRACT_SCHEMA_VERSION = 1 as const;

export const providerSchema = z.literal("codex");
export const sessionClassSchema = z.enum(["standard", "spark"]);
export const modelPresetSchema = z.enum(["quick", "balanced", "deep"]);
export const MODEL_PRESETS = Object.freeze({
  quick: Object.freeze({ label: "Quick", model: "gpt-5.6-luna", effort: "low" }),
  balanced: Object.freeze({ label: "Balanced", model: "gpt-5.6-sol", effort: "medium" }),
  deep: Object.freeze({ label: "Deep", model: "gpt-5.6-sol", effort: "xhigh" })
} as const);
export const artifactTypeSchema = z.enum([
  "FileArtifact", "PatchArtifact", "TestResultArtifact", "CommandArtifact", "ReviewVerdictArtifact"
]);
export const threadIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, "Invalid ForgeDeck thread id");
export const modelNameSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:/-]+$/, "Invalid model name");
export const reasoningEffortSchema = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/, "Invalid reasoning effort");
export const workspacePathSchema = z.string().min(1).max(4_096).refine(
  (value) => value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value),
  "Workspace path must be absolute"
);

export const knowledgePackSourceSchema = z.object({
  type: z.enum(["file", "path", "url"]),
  reference: z.string().trim().min(1).max(8_192)
}).strict();
export const knowledgePackRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scope: z.enum(["global", "workspace"]),
  workspace: workspacePathSchema.nullable().optional(),
  sources: z.array(knowledgePackSourceSchema).min(1).max(50)
}).strict().superRefine((value, context) => {
  if (value.scope === "workspace" && !value.workspace) {
    context.addIssue({ code: "custom", path: ["workspace"], message: "Workspace-scoped knowledge packs require a workspace" });
  }
  if (value.scope === "global" && value.workspace) {
    context.addIssue({ code: "custom", path: ["workspace"], message: "Global knowledge packs cannot select a workspace" });
  }
}).transform((value) => ({ ...value, workspace: value.scope === "workspace" ? value.workspace! : null }));
export type KnowledgePackSource = z.infer<typeof knowledgePackSourceSchema>;
export type KnowledgePackRequest = z.infer<typeof knowledgePackRequestSchema>;

/** Canonical protocol timestamps are ISO 8601. Numeric values remain input-only compatibility aliases. */
export const isoTimestampSchema = z.iso.datetime({ offset: true });
export const timestampSchema = z.union([
  isoTimestampSchema,
  z.number().finite().nonnegative().transform(epochNumberToIso)
]);
export const nullableTimestampSchema = z.union([timestampSchema, z.null()]);
export const workspaceLeaseModeSchema = z.enum(["read-only", "exclusive"]);
export const workspaceFileScopeSchema = z.array(z.string().trim().min(1).max(1_024).refine((value) => {
  const normalized = value.replace(/\\/g, "/");
  return !normalized.startsWith("/")
    && !/^[A-Za-z]:\//.test(normalized)
    && !normalized.split("/").includes("..");
}, "File scope entries must be relative paths within the workspace")).min(1).max(100);
export const workspaceLeaseSchema = z.object({
  sessionId: threadIdSchema,
  root: workspacePathSchema,
  mode: workspaceLeaseModeSchema,
  fileScope: workspaceFileScopeSchema.optional(),
  acquiredAt: timestampSchema
}).strict();
export const workspaceLeaseStatusSchema = z.object({
  root: workspacePathSchema,
  state: z.enum(["available", "read-only", "exclusive"]),
  leases: z.array(workspaceLeaseSchema)
}).strict();
export const workspaceLeaseRequestSchema = z.object({
  mode: workspaceLeaseModeSchema.nullable()
}).strict();
export const workspaceLeaseResponseSchema = z.object({
  lease: workspaceLeaseSchema.nullable(),
  status: workspaceLeaseStatusSchema
}).strict();

export const knowledgePackSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  scope: z.enum(["global", "workspace"]),
  workspace: z.string().nullable(),
  sources: z.array(knowledgePackSourceSchema),
  content: z.string(),
  contentHash: z.string().nullable(),
  status: z.enum(["ready", "partial", "error"]),
  errors: z.array(z.string()),
  charCount: z.number().int().nonnegative(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  refreshedAt: nullableTimestampSchema
}).strict();
export const knowledgePackListSchema = z.object({ data: z.array(knowledgePackSchema) }).strict();
export const knowledgePackResponseSchema = z.object({ pack: knowledgePackSchema }).strict();
export type KnowledgePack = z.infer<typeof knowledgePackSchema>;

export const policyFieldSchema = z.enum([
  "session_class", "model", "reasoning_effort", "workspace", "time_of_day",
  "max_concurrency", "max_tokens_per_session"
]);
export const policyOperatorSchema = z.enum([
  "equals", "not_equals", "contains", "less_than", "less_than_or_equal",
  "greater_than", "greater_than_or_equal"
]);
export const policyActionSchema = z.enum(["allow", "warn", "block"]);
export const policyConditionSchema = z.object({
  field: policyFieldSchema,
  operator: policyOperatorSchema,
  value: z.union([z.string().trim().min(1).max(4_096), z.number().finite().nonnegative()])
}).strict().superRefine((condition, context) => {
  const numeric = condition.field === "max_concurrency" || condition.field === "max_tokens_per_session";
  const time = condition.field === "time_of_day";
  const comparison = ["less_than", "less_than_or_equal", "greater_than", "greater_than_or_equal"].includes(condition.operator);
  if (numeric && (typeof condition.value !== "number" || !Number.isSafeInteger(condition.value))) {
    context.addIssue({ code: "custom", path: ["value"], message: "Numeric policy fields require a non-negative integer" });
  }
  if (!numeric && typeof condition.value !== "string") {
    context.addIssue({ code: "custom", path: ["value"], message: "This policy field requires a text value" });
  }
  if (time && (typeof condition.value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(condition.value))) {
    context.addIssue({ code: "custom", path: ["value"], message: "Time of day must use HH:MM in 24-hour time" });
  }
  if (condition.operator === "contains" && !["model", "reasoning_effort", "workspace"].includes(condition.field)) {
    context.addIssue({ code: "custom", path: ["operator"], message: "Contains is only available for model, reasoning effort, and workspace" });
  }
  if (comparison && !numeric && !time) {
    context.addIssue({ code: "custom", path: ["operator"], message: "Ordering comparisons are only available for time and numeric fields" });
  }
});
export const policyRequestSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(100),
  condition: policyConditionSchema,
  action: policyActionSchema
}).strict();
export const policyDeleteRequestSchema = z.object({ id: z.uuid() }).strict();
export const policyRuleSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  condition: policyConditionSchema,
  action: policyActionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema
}).strict();
export const policyListSchema = z.object({ data: z.array(policyRuleSchema) }).strict();
export const policyResponseSchema = z.object({ policy: policyRuleSchema }).strict();
export type PolicyField = z.infer<typeof policyFieldSchema>;
export type PolicyOperator = z.infer<typeof policyOperatorSchema>;
export type PolicyAction = z.infer<typeof policyActionSchema>;
export type PolicyCondition = z.infer<typeof policyConditionSchema>;
export type PolicyRequest = z.infer<typeof policyRequestSchema>;
export type PolicyRule = z.infer<typeof policyRuleSchema>;

export type Provider = z.infer<typeof providerSchema>;
export type SessionClass = z.infer<typeof sessionClassSchema>;
export type ModelPreset = z.infer<typeof modelPresetSchema>;
export type IsoTimestamp = z.infer<typeof isoTimestampSchema>;

export function timestampToEpochMs(value: string | number): number {
  if (typeof value === "number") return value < 100_000_000_000 ? value * 1_000 : value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function timestampNow(): IsoTimestamp {
  return new Date().toISOString();
}

function epochNumberToIso(value: number): string {
  const milliseconds = value < 100_000_000_000 ? value * 1_000 : value;
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    throw new Error("Timestamp is outside the ISO 8601 range");
  }
}

const jsonObjectSchema = z.record(z.string(), z.unknown());
const nullableStringSchema = z.string().nullable();
const nonnegativeNumberSchema = z.number().finite().nonnegative();

export const serverErrorTypeSchema = z.enum([
  "ValidationError", "NotFoundError", "ConflictError", "CapacityError", "BackendUnavailableError", "InternalError"
]);
export const errorScopeSchema = z.enum([
  "authentication", "runtime", "sessions", "workspace", "approvals", "background", "api"
]);
export const serverErrorSchema = z.object({
  type: serverErrorTypeSchema,
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  requestId: nullableStringSchema,
  scope: errorScopeSchema,
  sessionId: nullableStringSchema,
  status: z.number().int().nonnegative(),
  retryAfter: nonnegativeNumberSchema.optional(),
  error: z.string().optional()
}).passthrough();

export type ServerErrorType = z.infer<typeof serverErrorTypeSchema>;
export type ErrorScope = z.infer<typeof errorScopeSchema>;
export type ServerErrorPayload = z.infer<typeof serverErrorSchema>;

export const reasoningOptionSchema = z.object({
  reasoningEffort: reasoningEffortSchema,
  description: z.string().default("")
}).passthrough();

export const codexModelSchema = z.object({
  id: z.string().min(1),
  model: modelNameSchema,
  displayName: z.string().default(""),
  description: z.string().default(""),
  isDefault: z.boolean().default(false),
  defaultReasoningEffort: reasoningEffortSchema,
  supportedReasoningEfforts: z.array(reasoningOptionSchema),
  serviceTiers: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() }).passthrough()).default([])
}).passthrough();

export const blueprintVariableValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export const blueprintVariableSchema = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "boolean"]),
  description: z.string().optional(),
  required: z.boolean(),
  secret: z.boolean().optional(),
  default: blueprintVariableValueSchema.optional()
}).strict();
const blueprintModelTargetSchema = z.object({
  backend: providerSchema,
  model: modelNameSchema,
  effort: reasoningEffortSchema.nullable().optional(),
  preset: modelPresetSchema.nullable().optional()
}).strict();
export const guardianPolicySchema = z.object({
  stallTimeoutMinutes: z.number().int().min(1).max(24 * 60),
  escalationModel: modelNameSchema.nullable().optional()
}).strict();
export const completionGateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1_000),
  required: z.boolean(),
  artifactType: artifactTypeSchema.optional(),
  artifactName: z.string().min(1).max(200).optional(),
  path: z.string().min(1).max(4_096).optional(),
  schema: jsonObjectSchema.optional(),
  minimumCount: z.number().int().min(1).max(100).optional(),
  mustPass: z.boolean().optional(),
  trust: z.enum(["deterministic", "human", "advisory"]).optional()
}).strict();
export const agentBlueprintDefinitionSchema = z.object({
  promptTemplate: z.string(),
  role: z.string(),
  workspace: z.object({ selector: z.enum(["current", "fixed", "variable"]), value: z.string().optional() }).strict(),
  model: blueprintModelTargetSchema.extend({
    routing: z.enum(["fixed", "fallback"]),
    fallbacks: z.array(blueprintModelTargetSchema).optional()
  }),
  tools: z.object({ enable: z.array(z.string()), disable: z.array(z.string()) }).strict(),
  knowledge: z.array(z.object({ type: z.enum(["file", "url"]), reference: z.string() }).strict()),
  completionGates: z.array(completionGateSchema),
  approvals: z.object({ mode: z.enum(["on-request", "never", "plan"]), requiredFor: z.array(z.string()) }).strict(),
  variables: z.array(blueprintVariableSchema),
  guardian: guardianPolicySchema.optional()
}).strict();
export const agentBlueprintManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.number().int().positive(),
  createdAt: timestampSchema,
  definition: agentBlueprintDefinitionSchema
}).strict();

export const scheduleTimingSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("once"), runAt: timestampSchema }).strict(),
  z.object({ type: z.literal("interval"), intervalMs: z.number().int().min(60_000).max(365 * 24 * 60 * 60_000) }).strict(),
  z.object({ type: z.literal("cron"), expression: z.string().min(1).max(200) }).strict()
]);
export const scheduleRunSchema = z.object({
  id: z.string(),
  scheduleId: z.string(),
  scheduledAt: timestampSchema,
  startedAt: timestampSchema,
  completedAt: nullableTimestampSchema,
  status: z.enum(["pending", "running", "succeeded", "failed"]),
  operationId: z.string().nullable(),
  threadId: z.string().nullable(),
  error: z.string().nullable()
}).strict();
export const agentScheduleSchema = z.object({
  id: z.string(),
  name: z.string(),
  blueprintId: z.string(),
  blueprintVersion: z.number().int().positive(),
  variables: z.record(z.string(), blueprintVariableValueSchema),
  workspace: z.string().nullable(),
  timing: scheduleTimingSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  lastRunAt: nullableTimestampSchema,
  nextRunAt: nullableTimestampSchema,
  recentRuns: z.array(scheduleRunSchema)
}).strict();

export const missionValueSourceSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("mission"), key: z.string() }).strict(),
  z.object({ source: z.literal("node"), nodeId: z.string(), key: z.string() }).strict(),
  z.object({ source: z.literal("literal"), value: blueprintVariableValueSchema }).strict()
]);
export const missionNodeDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  blueprintId: z.string(),
  blueprintVersion: z.number().int().positive(),
  dependsOn: z.array(z.string()),
  inputMapping: z.record(z.string(), missionValueSourceSchema),
  outputMapping: z.record(z.string(), z.string())
}).strict();
export const missionManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.number().int().positive(),
  createdAt: timestampSchema,
  nodes: z.array(missionNodeDefinitionSchema)
}).strict();
export const missionStateSchema = z.enum(["pending", "running", "completed", "failed", "paused"]);
export const missionNodeRunSchema = z.object({
  nodeId: z.string(),
  state: z.enum(["pending", "running", "completed", "failed"]),
  inputs: z.record(z.string(), blueprintVariableValueSchema),
  outputs: z.record(z.string(), z.unknown()),
  operationId: z.string().nullable(),
  threadId: threadIdSchema.nullable(),
  error: z.string().nullable(),
  startedAt: nullableTimestampSchema,
  completedAt: nullableTimestampSchema
}).strict();
export const missionRunSchema = z.object({
  id: z.uuid(),
  missionId: z.string(),
  missionVersion: z.number().int().positive(),
  state: missionStateSchema,
  inputs: z.record(z.string(), blueprintVariableValueSchema),
  workspace: z.string().nullable(),
  outputs: z.record(z.string(), z.record(z.string(), z.unknown())),
  nodes: z.array(missionNodeRunSchema),
  error: z.string().nullable(),
  createdAt: timestampSchema,
  startedAt: nullableTimestampSchema,
  updatedAt: timestampSchema,
  completedAt: nullableTimestampSchema
}).strict();
export const missionSchema = missionManifestSchema.extend({
  state: missionStateSchema,
  latestRun: missionRunSchema.nullable()
}).strict();

const evalModelSchema = z.object({
  provider: providerSchema,
  model: modelNameSchema,
  reasoningEffort: reasoningEffortSchema.nullable().default(null)
}).strict();

const evalSuccessCriteriaSchema = z.object({
  requiredPhrases: z.array(z.string().trim().min(1).max(1_000)).max(20).default([]),
  forbiddenPhrases: z.array(z.string().trim().min(1).max(1_000)).max(20).default([]),
  maxDurationMs: z.number().int().min(1_000).max(24 * 60 * 60_000).nullable().default(null),
  maxTotalTokens: z.number().int().positive().max(100_000_000).nullable().default(null),
  requireBlueprintGates: z.boolean().default(true)
}).strict();

export const evalRequestSchema = z.object({
  evalId: z.uuid().optional(),
  name: z.string().trim().min(1).max(100),
  blueprintId: z.string().min(1).max(128),
  blueprintVersion: z.number().int().positive().optional(),
  variables: z.record(z.string(), blueprintVariableValueSchema).default({}),
  workspace: workspacePathSchema,
  models: z.array(evalModelSchema).min(1).max(8),
  successCriteria: evalSuccessCriteriaSchema
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  value.models.forEach((model, index) => {
    const key = `${model.provider}\0${model.model}\0${model.reasoningEffort || ""}`;
    if (seen.has(key)) context.addIssue({ code: "custom", path: ["models", index], message: "Eval models must be unique" });
    seen.add(key);
  });
});

const evalCriterionResultSchema = z.object({
  criterion: z.string(),
  passed: z.boolean(),
  expected: z.union([z.string(), z.number(), z.boolean()]),
  actual: z.union([z.string(), z.number(), z.boolean()])
}).strict();

const evalScoreSchema = z.object({
  scorerVersion: z.literal(1),
  passed: z.boolean(),
  criteria: z.array(evalCriterionResultSchema)
}).strict();

const evalResultSchema = z.object({
  model: evalModelSchema,
  status: z.enum(["queued", "running", "passed", "failed", "error"]),
  operationId: z.string().uuid().nullable(),
  threadId: threadIdSchema.nullable(),
  startedAt: nullableTimestampSchema,
  completedAt: nullableTimestampSchema,
  durationMs: nonnegativeNumberSchema.nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  output: z.string(),
  error: z.string().nullable(),
  score: evalScoreSchema.nullable()
}).strict();

const evalRunSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  version: z.number().int().positive(),
  name: z.string(),
  blueprint: z.object({ id: z.string(), version: z.number().int().positive(), name: z.string() }).strict(),
  variables: z.record(z.string(), blueprintVariableValueSchema),
  workspace: z.string(),
  prompt: z.string(),
  successCriteria: evalSuccessCriteriaSchema,
  status: z.enum(["queued", "running", "completed", "failed"]),
  passed: z.boolean().nullable(),
  createdAt: timestampSchema,
  startedAt: nullableTimestampSchema,
  completedAt: nullableTimestampSchema,
  results: z.array(evalResultSchema)
}).strict();

const evalListSchema = z.object({ data: z.array(evalRunSchema) }).strict();
const evalResponseSchema = z.object({ eval: evalRunSchema }).strict();

export const comparisonModelSchema = z.object({
  provider: providerSchema,
  model: modelNameSchema,
  reasoningEffort: reasoningEffortSchema.nullable().default(null)
}).strict();

export const compareRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(100_000),
  workspace: workspacePathSchema,
  models: z.array(comparisonModelSchema).min(2).max(8),
  judge: comparisonModelSchema.nullable().optional().default(null)
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  value.models.forEach((model, index) => {
    const key = `${model.provider}\0${model.model}\0${model.reasoningEffort || ""}`;
    if (seen.has(key)) context.addIssue({ code: "custom", path: ["models", index], message: "Comparison models must be unique" });
    seen.add(key);
  });
});

export const comparisonJudgeScoreSchema = z.object({
  outputId: z.uuid(),
  score: z.number().int().min(0).max(100),
  rationale: z.string()
}).strict();

export const comparisonJudgeVerdictSchema = z.object({
  winnerOutputId: z.uuid().nullable(),
  summary: z.string(),
  scores: z.array(comparisonJudgeScoreSchema)
}).strict();

const comparisonResultSchema = z.object({
  id: z.uuid(),
  model: comparisonModelSchema,
  status: z.enum(["queued", "running", "completed", "error"]),
  operationId: z.uuid().nullable(),
  threadId: threadIdSchema.nullable(),
  startedAt: nullableTimestampSchema,
  completedAt: nullableTimestampSchema,
  durationMs: nonnegativeNumberSchema.nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  output: z.string(),
  error: z.string().nullable()
}).strict();

const comparisonDiffLineSchema = z.object({
  kind: z.enum(["context", "added", "removed"]),
  text: z.string(),
  oldLine: z.number().int().positive().nullable(),
  newLine: z.number().int().positive().nullable()
}).strict();

const comparisonDiffSchema = z.object({
  leftOutputId: z.uuid(),
  rightOutputId: z.uuid(),
  lines: z.array(comparisonDiffLineSchema),
  truncated: z.boolean()
}).strict();

const comparisonJudgeResultSchema = z.object({
  model: comparisonModelSchema,
  status: z.enum(["queued", "running", "completed", "error"]),
  operationId: z.uuid().nullable(),
  threadId: threadIdSchema.nullable(),
  startedAt: nullableTimestampSchema,
  completedAt: nullableTimestampSchema,
  durationMs: nonnegativeNumberSchema.nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  output: z.string(),
  error: z.string().nullable(),
  verdict: comparisonJudgeVerdictSchema.nullable()
}).strict();

export const comparisonRunSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  prompt: z.string(),
  workspace: z.string(),
  status: z.enum(["queued", "running", "judging", "completed", "failed"]),
  createdAt: timestampSchema,
  startedAt: nullableTimestampSchema,
  completedAt: nullableTimestampSchema,
  results: z.array(comparisonResultSchema),
  diffs: z.array(comparisonDiffSchema),
  judge: comparisonJudgeResultSchema.nullable()
}).strict();

const comparisonListSchema = z.object({ data: z.array(comparisonRunSchema) }).strict();
const comparisonResponseSchema = z.object({ comparison: comparisonRunSchema }).strict();

export const threadStatusSchema = z.object({
  type: z.enum(["notLoaded", "idle", "systemError", "active"]),
  activeFlags: z.array(z.string()).optional()
}).passthrough();
export const threadItemSchema = z.object({
  id: z.string().optional(),
  type: z.string(),
  text: z.string().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional(), path: z.string().optional() }).passthrough()).optional(),
  summary: z.array(z.string()).optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  status: z.string().optional(),
  aggregatedOutput: z.string().nullable().optional(),
  exitCode: z.number().nullable().optional(),
  changes: z.array(jsonObjectSchema).optional(),
  server: z.string().optional(),
  tool: z.string().optional(),
  arguments: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional()
}).passthrough();
export const turnSchema = z.object({
  id: z.string(),
  items: z.array(threadItemSchema).default([]),
  status: z.enum(["inProgress", "completed", "failed", "interrupted"]),
  error: z.object({ message: z.string().optional() }).passthrough().nullable().optional(),
  startedAt: nullableTimestampSchema.optional(),
  completedAt: nullableTimestampSchema.optional()
}).passthrough();
export const threadGoalSchema = z.object({
  threadId: threadIdSchema,
  objective: z.string(),
  status: z.enum(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]),
  tokenBudget: nonnegativeNumberSchema.nullable(),
  tokensUsed: nonnegativeNumberSchema,
  timeUsedSeconds: nonnegativeNumberSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema
}).passthrough();
export const threadSessionMetadataSchema = z.object({
  preset: modelPresetSchema.nullable().optional(),
  model: modelNameSchema.nullable().optional(),
  reasoningEffort: reasoningEffortSchema.nullable().optional(),
  effort: reasoningEffortSchema.nullable().optional()
}).passthrough().transform((value) => ({
  ...value,
  reasoningEffort: value.reasoningEffort ?? value.effort ?? null,
  effort: value.effort ?? value.reasoningEffort ?? null
}));

export const runGuardianStateSchema = z.object({
  threadId: threadIdSchema,
  phase: z.enum(["idle", "monitoring", "stalled", "retrying", "escalating", "paused", "failed"]),
  active: z.boolean(),
  recoveryAttempts: z.number().int().nonnegative(),
  maxRecoveryAttempts: z.number().int().positive(),
  lastActivityAt: timestampSchema,
  stalledAt: nullableTimestampSchema,
  lastActionAt: nullableTimestampSchema,
  actionModel: modelNameSchema.nullable(),
  operatorNotifiedAt: nullableTimestampSchema,
  recoveredAt: nullableTimestampSchema,
  updatedAt: timestampSchema,
  error: z.string().nullable(),
  policy: z.object({
    stallTimeoutMs: z.number().int().positive(),
    escalationModel: modelNameSchema.nullable()
  }).strict()
}).passthrough();

export const artifactDescriptorSchema = z.object({
  id: z.string().min(1).max(200),
  version: z.number().int().positive(),
  definition: jsonObjectSchema.optional()
}).strict();
export const artifactProducerSchema = z.object({
  sessionId: threadIdSchema,
  turnId: z.string().max(200).nullable(),
  itemId: z.string().max(200).nullable(),
  actor: z.string().min(1).max(200)
}).strict();
export const artifactProvenanceSchema = z.object({
  source: z.enum(["runtime", "http", "mcp", "user", "system"]),
  trust: z.enum(["deterministic", "human", "advisory"]),
  command: z.string().max(100_000).nullable().optional(),
  cwd: z.string().max(4_096).nullable().optional(),
  tool: z.string().max(200).nullable().optional(),
  details: jsonObjectSchema.optional()
}).strict();
export const artifactRetentionSchema = z.object({
  policy: z.enum(["session", "persistent", "expires", "reference-only"]),
  expiresAt: nullableTimestampSchema.optional(),
  sensitive: z.boolean().default(false)
}).strict();
export const artifactReferenceSchema = z.object({
  kind: z.enum(["workspace-file", "content-addressed", "external"]),
  uri: z.string().min(1).max(8_192),
  mediaType: z.string().max(200).nullable().optional(),
  byteSize: z.number().int().nonnegative().nullable().optional(),
  sensitive: z.boolean()
}).strict();
export const artifactValidationSchema = z.object({
  status: z.enum(["valid", "invalid"]),
  validatedAt: timestampSchema,
  validator: z.string().min(1).max(200),
  errors: z.array(z.string().max(2_000)).max(100)
}).strict();

export const fileArtifactContentSchema = z.object({
  path: z.string().min(1).max(4_096),
  mediaType: z.string().max(200).nullable().optional(),
  byteSize: z.number().int().nonnegative(),
  fileHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  exists: z.literal(true)
}).strict();
export const patchArtifactContentSchema = z.object({
  format: z.literal("unified-diff"),
  patch: z.string().optional(),
  files: z.array(z.string().min(1).max(4_096)).max(1_000),
  appliesCleanly: z.boolean().nullable().default(null)
}).strict();
export const testResultArtifactContentSchema = z.object({
  command: z.string().min(1).max(100_000),
  status: z.enum(["passed", "failed"]),
  exitCode: z.number().int().nullable(),
  passed: z.number().int().nonnegative().nullable().optional(),
  failed: z.number().int().nonnegative().nullable().optional(),
  skipped: z.number().int().nonnegative().nullable().optional(),
  durationMs: z.number().finite().nonnegative().nullable().optional(),
  output: z.string().optional()
}).strict();
export const commandArtifactContentSchema = z.object({
  command: z.string().min(1).max(100_000),
  cwd: z.string().max(4_096).nullable(),
  status: z.enum(["passed", "failed"]),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().finite().nonnegative().nullable().optional(),
  output: z.string().optional(),
  structuredOutput: z.unknown().optional()
}).strict();
export const reviewVerdictArtifactContentSchema = z.object({
  verdict: z.enum(["approved", "changes-requested", "advisory"]),
  summary: z.string().min(1).max(100_000),
  findings: z.array(z.object({
    severity: z.enum(["info", "warning", "error"]),
    message: z.string().min(1).max(10_000),
    path: z.string().max(4_096).nullable().optional(),
    line: z.number().int().positive().nullable().optional()
  }).strict()).max(10_000),
  reviewer: z.string().max(200).nullable().optional(),
  details: z.unknown().optional()
}).strict();

const artifactEnvelopeBaseSchema = z.object({
  id: z.uuid(),
  sessionId: threadIdSchema,
  name: z.string().min(1).max(200),
  version: z.number().int().positive(),
  schemaVersion: z.literal(1),
  schema: artifactDescriptorSchema,
  producer: artifactProducerSchema,
  provenance: artifactProvenanceSchema,
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  retention: artifactRetentionSchema,
  reference: artifactReferenceSchema.nullable(),
  validation: artifactValidationSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema
});
export const artifactSchema = z.discriminatedUnion("type", [
  artifactEnvelopeBaseSchema.extend({ type: z.literal("FileArtifact"), content: fileArtifactContentSchema.nullable() }),
  artifactEnvelopeBaseSchema.extend({ type: z.literal("PatchArtifact"), content: patchArtifactContentSchema.nullable() }),
  artifactEnvelopeBaseSchema.extend({ type: z.literal("TestResultArtifact"), content: testResultArtifactContentSchema.nullable() }),
  artifactEnvelopeBaseSchema.extend({ type: z.literal("CommandArtifact"), content: commandArtifactContentSchema.nullable() }),
  artifactEnvelopeBaseSchema.extend({ type: z.literal("ReviewVerdictArtifact"), content: reviewVerdictArtifactContentSchema.nullable() })
]);
export const unmetCompletionGateSchema = z.object({
  name: z.string(),
  description: z.string(),
  required: z.boolean(),
  artifactType: artifactTypeSchema.nullable(),
  reason: z.string(),
  trust: z.enum(["deterministic", "human", "advisory"])
}).strict();
export const artifactStatusSchema = z.object({
  status: z.enum(["not-configured", "pending", "passed"]),
  artifactCount: z.number().int().nonnegative(),
  validArtifactCount: z.number().int().nonnegative(),
  requiredGateCount: z.number().int().nonnegative(),
  metGateCount: z.number().int().nonnegative(),
  unmetGates: z.array(unmetCompletionGateSchema)
}).strict();

const rawThreadResourceSchema = z.object({
  id: threadIdSchema,
  name: z.string().nullable().default(null),
  preview: z.string().default(""),
  cwd: z.string().default(""),
  provider: providerSchema.optional(),
  backend: providerSchema.optional(),
  modelProvider: z.string().optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  recencyAt: nullableTimestampSchema.default(null),
  status: threadStatusSchema,
  turns: z.array(turnSchema).default([]),
  gitInfo: z.object({ branch: z.string().optional(), repositoryUrl: z.string().optional() }).passthrough().nullable().optional(),
  goal: threadGoalSchema.nullable().optional(),
  policy: z.enum(["workspace-write", "yolo"]).optional(),
  tags: z.array(z.string()).optional(),
  category: z.string().nullable().optional(),
  blueprintId: z.string().optional(),
  blueprintVersion: z.number().int().positive().optional(),
  blueprintEnvironment: z.string().optional(),
  blueprintModelConfiguration: z.object({
    backend: providerSchema,
    model: modelNameSchema,
    effort: reasoningEffortSchema.nullable(),
    preset: modelPresetSchema.nullable().optional()
  }).passthrough().optional(),
  sessionClass: sessionClassSchema.optional(),
  preset: modelPresetSchema.nullable().optional(),
  model: modelNameSchema.nullable().optional(),
  reasoningEffort: reasoningEffortSchema.nullable().optional(),
  effort: reasoningEffortSchema.nullable().optional(),
  settings: threadSessionMetadataSchema.nullable().optional(),
  metadata: threadSessionMetadataSchema.nullable().optional(),
  sessionMetadata: threadSessionMetadataSchema.nullable().optional(),
  archiveState: z.enum(["active", "archiving", "archived"]).optional(),
  pinned: z.boolean().optional(),
  queueState: z.enum(["empty", "queued"]).optional(),
  queueDepth: z.number().int().nonnegative().optional(),
  owner: z.string().optional(),
  source: z.enum(["user", "mcp", "external"]).optional(),
  guardian: runGuardianStateSchema.optional(),
  policyWarnings: z.array(z.string()).optional(),
  artifactStatus: artifactStatusSchema.optional(),
  workspaceLeaseMode: workspaceLeaseModeSchema.optional(),
  workspaceLease: workspaceLeaseSchema.nullable().optional()
}).passthrough();

export const threadResourceSchema = rawThreadResourceSchema.transform((thread) => {
  const provider = thread.provider ?? thread.backend ?? "codex";
  const model = thread.model ?? null;
  const reasoningEffort = thread.reasoningEffort ?? thread.effort ?? null;
  return {
    ...thread,
    provider,
    backend: thread.backend ?? provider,
    modelProvider: thread.modelProvider ?? provider,
    sessionClass: thread.sessionClass ?? "standard",
    model,
    reasoningEffort,
    effort: thread.effort ?? reasoningEffort
  };
});

export const archiveEntrySchema = z.object({
  id: threadIdSchema,
  name: z.string(),
  cwd: z.string().nullable(),
  backend: providerSchema,
  sessionClass: sessionClassSchema,
  archivedAt: timestampSchema,
  reason: z.enum(["manual", "ttl"]),
  pinned: z.boolean(),
  restorable: z.boolean(),
  ttlHours: z.number().finite().positive().nullable(),
  permanentDeletionAt: nullableTimestampSchema,
  remainingTimeMs: z.number().finite().nonnegative().nullable(),
  daysUntilPermanentDeletion: z.number().int().nonnegative().nullable()
}).strict();
export const archiveResponseSchema = z.object({
  data: z.array(archiveEntrySchema),
  retention: z.object({
    ttlHours: z.number().finite().positive().nullable(),
    sparkTtlHours: z.number().finite().positive().nullable(),
    archiveRetentionHours: z.number().finite().positive().nullable()
  }).strict()
}).strict();

const sessionExportFileSchema = z.object({
  path: z.string(),
  operation: z.string().nullable()
}).strict();
const sessionExportArtifactSummarySchema = z.object({
  id: z.string().nullable(),
  turnId: z.string().nullable(),
  type: z.string(),
  name: z.string().nullable(),
  version: z.number().int().positive().nullable(),
  status: z.string().nullable(),
  createdAt: nullableTimestampSchema,
  fileCount: z.number().int().nonnegative(),
  files: z.array(sessionExportFileSchema)
}).strict();
const sessionExportRunSchema = z.object({
  id: z.string(),
  status: z.string(),
  startedAt: nullableTimestampSchema,
  completedAt: nullableTimestampSchema,
  durationMs: nonnegativeNumberSchema.nullable(),
  prompt: z.string().nullable(),
  keyOutputCount: z.number().int().nonnegative(),
  artifactCount: z.number().int().nonnegative(),
  error: z.string().nullable()
}).strict();
const sessionExportKeyOutputSchema = z.object({
  turnId: z.string(),
  text: z.string()
}).strict();
export const sessionExportSchema = z.object({
  schemaVersion: z.literal(1),
  provenance: z.object({
    sessionId: threadIdSchema,
    exportedAt: timestampSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    blueprintId: z.string().nullable(),
    blueprintVersion: z.number().int().positive().nullable()
  }).strict(),
  session: z.object({
    name: z.string().nullable(),
    preview: z.string().nullable(),
    status: z.string(),
    provider: providerSchema,
    model: z.string().nullable(),
    reasoningEffort: z.string().nullable(),
    sessionClass: sessionClassSchema,
    workspace: z.string().nullable(),
    category: z.string().nullable(),
    tags: z.array(z.string()),
    durationMs: nonnegativeNumberSchema.nullable(),
    turnCount: z.number().int().nonnegative()
  }).strict(),
  prompt: z.string().nullable(),
  runs: z.array(sessionExportRunSchema),
  artifactSummaries: z.array(sessionExportArtifactSummarySchema),
  keyOutputs: z.array(sessionExportKeyOutputSchema),
  privacy: z.object({
    secretsRedacted: z.literal(true),
    rawToolOutputIncluded: z.literal(false),
    absoluteWorkspacePathsIncluded: z.literal(false)
  }).strict()
}).strict();

export const notificationPreferencesSchema = z.object({
  onCompletion: z.boolean(),
  onFailure: z.boolean(),
  onApprovalNeeded: z.boolean()
}).strict();
export const sessionSettingsSchema = z.object({
  model: modelNameSchema,
  effort: reasoningEffortSchema,
  notifications: notificationPreferencesSchema.optional()
}).strict();
export const threadTokenUsageSchema = z.object({
  totalTokens: nonnegativeNumberSchema,
  inputTokens: nonnegativeNumberSchema.optional(),
  outputTokens: nonnegativeNumberSchema.optional(),
  cachedInputTokens: nonnegativeNumberSchema.optional(),
  reasoningOutputTokens: nonnegativeNumberSchema.optional()
}).passthrough();
export const admissionAlertSchema = z.object({
  severity: z.enum(["soft", "hard"]),
  code: z.string(),
  message: z.string(),
  scopeType: z.enum(["run", "blueprint", "workspace"]).optional(),
  scopeId: z.string().optional(),
  metric: z.enum(["requestCount", "totalTokens", "estimatedCostMicros"]).optional(),
  current: nonnegativeNumberSchema.optional(),
  limit: nonnegativeNumberSchema.optional(),
  resetAt: nullableTimestampSchema.optional()
}).passthrough();
export const admissionEventSchema = z.object({
  threadId: threadIdSchema.optional(),
  decision: z.object({
    action: z.enum(["admit", "wait", "pause", "downgrade", "fallback"]),
    alerts: z.array(admissionAlertSchema),
    retryAt: nullableTimestampSchema,
    target: z.object({
      provider: z.enum(["codex", "spark"]),
      model: modelNameSchema
    }).passthrough().nullable()
  }).passthrough().optional(),
  action: z.enum(["budget-updated", "budget-removed"]).optional(),
  budget: z.unknown().optional(),
  scopeType: z.enum(["run", "blueprint", "workspace"]).optional(),
  scopeId: z.string().optional()
}).passthrough();
export const rateWindowSchema = z.object({
  usedPercent: z.number().finite(),
  windowDurationMins: z.number().finite().nullable().default(null),
  resetsAt: nullableTimestampSchema
}).passthrough();
export const rateSnapshotSchema = z.object({
  limitId: nullableStringSchema.default(null),
  limitName: nullableStringSchema.default(null),
  primary: rateWindowSchema.nullable(),
  secondary: rateWindowSchema.nullable().default(null),
  planType: nullableStringSchema.default(null)
}).passthrough();
export const usageSchema = z.object({
  rateLimits: rateSnapshotSchema,
  rateLimitsByLimitId: z.record(z.string(), rateSnapshotSchema).nullable()
}).passthrough();
export const pendingRequestSchema = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: jsonObjectSchema,
  receivedAt: timestampSchema
}).passthrough();
export const queueEntrySchema = z.object({
  id: z.string(),
  text: z.string(),
  model: modelNameSchema,
  reasoningEffort: reasoningEffortSchema.nullable().optional(),
  effort: reasoningEffortSchema.nullable().optional(),
  createdAt: timestampSchema
}).passthrough().transform((entry) => ({
  ...entry,
  reasoningEffort: entry.reasoningEffort ?? entry.effort ?? null,
  effort: entry.effort ?? entry.reasoningEffort ?? null
}));
export const liveThreadStateSchema = z.object({
  items: z.record(z.string(), threadItemSchema),
  agentText: z.record(z.string(), z.string()),
  toolOutput: z.record(z.string(), z.string()),
  active: z.boolean(),
  completedAt: nullableTimestampSchema,
  updatedAt: timestampSchema,
  tokenUsage: threadTokenUsageSchema.nullable(),
  truncated: z.boolean(),
  truncatedItemIds: z.array(z.string())
}).passthrough();
export const liveRecoverySnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  threadRevisions: z.record(z.string(), z.number().int().nonnegative()).optional(),
  data: z.record(z.string(), liveThreadStateSchema),
  queues: z.record(z.string(), z.array(queueEntrySchema)),
  activeThreadIds: z.array(threadIdSchema)
}).passthrough();
export const backgroundTaskHealthSchema = z.object({
  name: z.string(),
  status: z.enum(["starting", "ok", "degraded", "stopped"]),
  running: z.boolean(),
  attempts: z.number().int().nonnegative(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastRunAt: nullableTimestampSchema,
  lastSuccessAt: nullableTimestampSchema,
  nextRunAt: nullableTimestampSchema,
  error: serverErrorSchema.nullable()
}).passthrough();
export const backgroundHealthSchema = z.object({
  status: z.enum(["ok", "degraded", "starting", "stopped"]),
  tasks: z.array(backgroundTaskHealthSchema)
}).passthrough();

export const sessionOutcomeSchema = z.enum(["success", "failed", "interrupted"]);
export const timelineEventSchema = z.object({
  id: z.string(),
  revision: z.number().int().nonnegative(),
  threadId: threadIdSchema,
  type: z.string(),
  timestamp: timestampSchema,
  summary: z.string(),
  payloadSummary: jsonObjectSchema,
  model: nullableStringSchema,
  outcome: sessionOutcomeSchema.nullable(),
  error: nullableStringSchema,
  durationMs: nonnegativeNumberSchema.nullable()
}).strict();
export const sessionTimelineSchema = z.object({
  session: z.object({ id: threadIdSchema, name: z.string(), model: nullableStringSchema }).strict(),
  events: z.array(timelineEventSchema),
  truncated: z.boolean()
}).strict();
export const sessionSearchResultSchema = z.object({
  sessionId: threadIdSchema,
  name: z.string(),
  prompt: nullableStringSchema,
  model: nullableStringSchema,
  outcome: z.union([sessionOutcomeSchema, z.literal("unknown")]),
  error: nullableStringSchema,
  startedAt: timestampSchema,
  completedAt: nullableTimestampSchema,
  durationMs: nonnegativeNumberSchema.nullable(),
  matchedEvent: nullableStringSchema
}).strict();
const analyticsTotalsSchema = z.object({
  sessions: z.number().int().nonnegative(),
  runs: z.number().int().nonnegative(),
  successful: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  successRate: z.number().min(0).max(100),
  avgCompletionTimeMs: nonnegativeNumberSchema.nullable()
}).strict();
export const outcomeAnalyticsSchema = z.object({
  generatedAt: timestampSchema,
  totals: analyticsTotalsSchema,
  byModel: z.array(analyticsTotalsSchema.omit({ sessions: true }).extend({ model: z.string() }).strict()),
  commonErrors: z.array(z.object({ pattern: z.string(), count: z.number().int().positive(), models: z.array(z.string()) }).strict())
}).strict();

export const startupConfigurationSchema = z.object({
  server: z.object({ id: z.string(), name: z.string() }).passthrough(),
  version: z.string(),
  health: z.object({
    status: z.enum(["ok", "degraded"]),
    runtime: jsonObjectSchema,
    storage: z.object({
      engine: z.literal("sqlite").optional(),
      status: z.enum(["ok", "error"]),
      writable: z.boolean(),
      revision: z.number().optional(),
      backupRevision: z.number().optional(),
      recoverySource: z.enum(["primary", "backup", "empty"]).optional(),
      error: z.string().optional()
    }).passthrough(),
    background: backgroundHealthSchema.optional()
  }).passthrough(),
  models: z.object({ data: z.array(codexModelSchema) }).passthrough(),
  roots: z.array(z.string()),
  background: backgroundHealthSchema.optional(),
  degraded: z.boolean().optional(),
  errors: z.array(serverErrorSchema).optional()
}).passthrough();
const backendStatusEntrySchema = z.object({
  available: z.boolean(),
  rateLimit: z.object({ primary: z.object({ usedPercent: z.number() }).passthrough().optional() }).passthrough().nullable().optional(),
  activeCount: z.number().int().nonnegative().default(0),
  maxConcurrent: z.number().int().positive().optional()
}).passthrough();
export const accountStatusSchema = z.object({
  account: z.object({
    account: z.object({ type: z.string(), email: z.string().nullable().optional(), planType: z.string().optional() }).passthrough().nullable(),
    requiresOpenaiAuth: z.boolean()
  }).passthrough(),
  usage: usageSchema.nullable(),
  backendStatus: z.object({
    codex: backendStatusEntrySchema,
    spark: backendStatusEntrySchema
  }).passthrough().optional(),
  activeThreadIds: z.array(threadIdSchema).optional(),
  agentThreadIds: z.array(threadIdSchema).optional(),
  sparkAgentThreadIds: z.array(threadIdSchema).optional(),
  sparkActiveThreadIds: z.array(threadIdSchema).optional(),
  runtime: jsonObjectSchema.optional(),
  admission: z.object({ settings: jsonObjectSchema }).passthrough().optional(),
  degraded: z.boolean().optional(),
  errors: z.array(serverErrorSchema).optional()
}).passthrough();
export const bootstrapSchema = z.intersection(startupConfigurationSchema, accountStatusSchema);

export type ReasoningOption = z.infer<typeof reasoningOptionSchema>;
export type CodexModel = z.infer<typeof codexModelSchema>;
export type BlueprintVariableValue = z.infer<typeof blueprintVariableValueSchema>;
export type BlueprintVariableSchema = z.infer<typeof blueprintVariableSchema>;
export type AgentBlueprintDefinition = z.infer<typeof agentBlueprintDefinitionSchema>;
export type AgentBlueprintManifest = z.infer<typeof agentBlueprintManifestSchema>;
export type CompletionGate = z.infer<typeof completionGateSchema>;
export type ArtifactType = z.infer<typeof artifactTypeSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type FileArtifact = Extract<Artifact, { type: "FileArtifact" }>;
export type PatchArtifact = Extract<Artifact, { type: "PatchArtifact" }>;
export type TestResultArtifact = Extract<Artifact, { type: "TestResultArtifact" }>;
export type CommandArtifact = Extract<Artifact, { type: "CommandArtifact" }>;
export type ReviewVerdictArtifact = Extract<Artifact, { type: "ReviewVerdictArtifact" }>;
export type ArtifactStatus = z.infer<typeof artifactStatusSchema>;
export type GuardianPolicy = z.infer<typeof guardianPolicySchema>;
export type RunGuardianState = z.infer<typeof runGuardianStateSchema>;
export type ScheduleTiming = z.infer<typeof scheduleTimingSchema>;
export type ScheduleRun = z.infer<typeof scheduleRunSchema>;
export type AgentSchedule = z.infer<typeof agentScheduleSchema>;
export type MissionValueSource = z.infer<typeof missionValueSourceSchema>;
export type MissionNodeDefinition = z.infer<typeof missionNodeDefinitionSchema>;
export type MissionManifest = z.infer<typeof missionManifestSchema>;
export type MissionState = z.infer<typeof missionStateSchema>;
export type MissionNodeRun = z.infer<typeof missionNodeRunSchema>;
export type MissionRun = z.infer<typeof missionRunSchema>;
export type Mission = z.infer<typeof missionSchema>;
export type EvalModel = z.infer<typeof evalModelSchema>;
export type EvalSuccessCriteria = z.infer<typeof evalSuccessCriteriaSchema>;
export type EvalRequest = z.infer<typeof evalRequestSchema>;
export type EvalCriterionResult = z.infer<typeof evalCriterionResultSchema>;
export type EvalScore = z.infer<typeof evalScoreSchema>;
export type EvalRun = z.infer<typeof evalRunSchema>;
export type ComparisonModel = z.infer<typeof comparisonModelSchema>;
export type CompareRequest = z.infer<typeof compareRequestSchema>;
export type ComparisonJudgeScore = z.infer<typeof comparisonJudgeScoreSchema>;
export type ComparisonJudgeVerdict = z.infer<typeof comparisonJudgeVerdictSchema>;
export type ComparisonRun = z.infer<typeof comparisonRunSchema>;
export type ThreadStatus = z.infer<typeof threadStatusSchema>;
export type ThreadItem = z.infer<typeof threadItemSchema>;
export type Turn = z.infer<typeof turnSchema>;
export type Thread = z.infer<typeof threadResourceSchema>;
export type ArchiveEntry = z.infer<typeof archiveEntrySchema>;
export type ArchiveResponse = z.infer<typeof archiveResponseSchema>;
export type ThreadSessionMetadata = z.infer<typeof threadSessionMetadataSchema>;
export type SessionExport = z.infer<typeof sessionExportSchema>;
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;
export type SessionSettings = z.infer<typeof sessionSettingsSchema>;
export type ThreadTokenUsage = z.infer<typeof threadTokenUsageSchema>;
export type AdmissionAlert = z.infer<typeof admissionAlertSchema>;
export type AdmissionEvent = z.infer<typeof admissionEventSchema>;
export type ThreadGoal = z.infer<typeof threadGoalSchema>;
export type RateWindow = z.infer<typeof rateWindowSchema>;
export type RateSnapshot = z.infer<typeof rateSnapshotSchema>;
export type Usage = z.infer<typeof usageSchema>;
export type PendingRequest = z.infer<typeof pendingRequestSchema>;
export type QueueEntry = z.infer<typeof queueEntrySchema>;
export type LiveThreadState = z.infer<typeof liveThreadStateSchema>;
export type LiveRecoverySnapshot = z.infer<typeof liveRecoverySnapshotSchema>;
export type BackgroundHealth = z.infer<typeof backgroundHealthSchema>;
export type SessionOutcome = z.infer<typeof sessionOutcomeSchema>;
export type TimelineEvent = z.infer<typeof timelineEventSchema>;
export type SessionTimeline = z.infer<typeof sessionTimelineSchema>;
export type SessionSearchResult = z.infer<typeof sessionSearchResultSchema>;
export type OutcomeAnalytics = z.infer<typeof outcomeAnalyticsSchema>;
export type StartupConfiguration = z.infer<typeof startupConfigurationSchema>;
export type AccountStatus = z.infer<typeof accountStatusSchema>;
export type Bootstrap = z.infer<typeof bootstrapSchema>;
export type WorkspaceLeaseMode = z.infer<typeof workspaceLeaseModeSchema>;
export type WorkspaceLease = z.infer<typeof workspaceLeaseSchema>;
export type WorkspaceLeaseStatus = z.infer<typeof workspaceLeaseStatusSchema>;

const tagListSchema = z.array(z.string().max(32)).max(10).default([]).transform((values) => {
  const seen = new Set<string>();
  return values.map((value) => value.trim().replace(/\s+/g, " ")).filter((value) => {
    if (!value) return false;
    const key = value.normalize("NFKC").toLocaleLowerCase("en-US");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
});

export const createSessionRequestSchema = z.object({
  cwd: workspacePathSchema,
  provider: providerSchema.optional(),
  backend: providerSchema.optional(),
  sessionClass: sessionClassSchema.optional(),
  class: sessionClassSchema.optional(),
  preset: modelPresetSchema.nullable().optional(),
  model: modelNameSchema.optional(),
  reasoningEffort: reasoningEffortSchema.nullable().optional(),
  effort: reasoningEffortSchema.nullable().optional(),
  yolo: z.boolean().default(false),
  leaseMode: workspaceLeaseModeSchema.default("exclusive"),
  fileScope: workspaceFileScopeSchema.optional(),
  name: z.string().max(100).optional(),
  prompt: z.string().max(100_000).nullable().optional(),
  tags: tagListSchema,
  category: z.string().max(50).nullable().optional(),
  blueprintId: z.string().max(128).nullable().optional(),
  blueprintVersion: z.number().int().positive().nullable().optional(),
  blueprintEnvironment: z.string().max(100).nullable().optional(),
  blueprintVariables: jsonObjectSchema.nullable().optional(),
  admissionPolicy: z.unknown().optional(),
  projection: z.unknown().optional(),
  guardian: guardianPolicySchema.optional()
}).strict().superRefine((value, context) => {
  if (value.provider && value.backend && value.provider !== value.backend) {
    context.addIssue({ code: "custom", path: ["provider"], message: "provider conflicts with deprecated backend alias" });
  }
  if (value.sessionClass && value.class && value.sessionClass !== value.class) {
    context.addIssue({ code: "custom", path: ["sessionClass"], message: "sessionClass conflicts with deprecated class alias" });
  }
  if (value.reasoningEffort && value.effort && value.reasoningEffort !== value.effort) {
    context.addIssue({ code: "custom", path: ["reasoningEffort"], message: "reasoningEffort conflicts with deprecated effort alias" });
  }
  if (value.leaseMode === "read-only" && value.yolo) {
    context.addIssue({
      code: "custom",
      path: ["leaseMode"],
      message: "Read-only workspace leases cannot be combined with bypass permissions"
    });
  }
  if (value.preset) {
    const target = MODEL_PRESETS[value.preset];
    const provider = value.provider ?? value.backend ?? "codex";
    const sessionClass = value.sessionClass ?? value.class ?? "standard";
    const effort = value.reasoningEffort ?? value.effort;
    if (provider !== "codex") {
      context.addIssue({ code: "custom", path: ["preset"], message: "Model presets only support the Codex provider" });
    }
    if (sessionClass !== "standard") {
      context.addIssue({ code: "custom", path: ["preset"], message: "Model presets only support standard sessions" });
    }
    if (value.model && value.model !== target.model) {
      context.addIssue({ code: "custom", path: ["model"], message: `Model conflicts with the ${target.label} preset` });
    }
    if (effort && effort !== target.effort) {
      context.addIssue({ code: "custom", path: ["reasoningEffort"], message: `Reasoning effort conflicts with the ${target.label} preset` });
    }
  }
}).transform((value) => ({
  ...value,
  provider: value.provider ?? value.backend ?? "codex",
  sessionClass: value.sessionClass ?? value.class ?? "standard",
  model: value.preset ? MODEL_PRESETS[value.preset].model : value.model,
  reasoningEffort: value.preset ? MODEL_PRESETS[value.preset].effort : value.reasoningEffort ?? value.effort ?? null
}));

export const messageRequestSchema = z.object({
  text: z.string().min(1).max(100_000),
  model: modelNameSchema,
  reasoningEffort: reasoningEffortSchema.nullable().optional(),
  effort: reasoningEffortSchema.nullable().optional(),
  admissionPolicy: z.unknown().optional(),
  projection: z.unknown().optional()
}).strict().superRefine((value, context) => {
  if (value.reasoningEffort && value.effort && value.reasoningEffort !== value.effort) {
    context.addIssue({ code: "custom", path: ["reasoningEffort"], message: "reasoningEffort conflicts with deprecated effort alias" });
  }
}).transform((value) => ({
  ...value,
  reasoningEffort: value.reasoningEffort ?? value.effort ?? null
}));

export const webhookTriggerRequestSchema = z.object({
  blueprint: z.string().trim().min(1).max(100),
  variables: z.record(z.string(), blueprintVariableValueSchema).default({}),
  workspace: workspacePathSchema.optional(),
  model: modelNameSchema.optional()
}).strict();

export const webhookTriggerResponseSchema = z.object({
  status: z.enum(["queued", "running", "error"]),
  operationId: z.string().uuid(),
  operationUrl: z.string().url(),
  sessionUrl: z.string().url().nullable(),
  error: jsonObjectSchema.nullable()
}).strict();

export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export type MessageRequest = z.infer<typeof messageRequestSchema>;
export type WebhookTriggerRequest = z.infer<typeof webhookTriggerRequestSchema>;
export type WebhookTriggerResponse = z.infer<typeof webhookTriggerResponseSchema>;

const runtimeEventPayloadSchema = z.object({
  state: z.enum(["ready", "offline", "error"]),
  error: serverErrorSchema.optional()
}).passthrough();
const queueEventPayloadSchema = z.object({
  threadId: threadIdSchema.optional(),
  queue: z.array(queueEntrySchema),
  error: serverErrorSchema.nullable().optional()
}).passthrough();
const threadsEventPayloadSchema = z.object({
  action: z.enum(["created", "updated", "removed"]),
  threadId: threadIdSchema,
  provider: providerSchema.optional(),
  backend: providerSchema.optional(),
  reason: z.string().optional()
}).passthrough().transform((value) => ({
  ...value,
  provider: value.provider ?? value.backend,
  backend: value.backend ?? value.provider
}));
const codexEventPayloadSchema = z.object({
  method: z.string(),
  params: jsonObjectSchema.optional()
}).passthrough().transform((value) => normalizeTimestampFields(value) as typeof value);
const guardianEventPayloadSchema = z.object({
  threadId: threadIdSchema,
  reason: z.string(),
  guardian: runGuardianStateSchema
}).passthrough();
const backendStatusEventPayloadSchema = z.object({
  codex: backendStatusEntrySchema.partial().optional(),
  spark: backendStatusEntrySchema.partial().optional()
}).passthrough();
const healthEventPayloadSchema = backgroundHealthSchema;
const eventSubscriptionRequestSchema = z.object({
  threadIds: z.array(threadIdSchema).max(256)
}).strict();
const eventSubscriptionResponseSchema = z.object({
  ok: z.literal(true),
  connected: z.boolean(),
  threadIds: z.array(threadIdSchema)
}).strict();

export const ssePayloadSchemas = {
  connected: z.object({ at: timestampSchema }).passthrough(),
  "session-ended": z.object({ reason: z.enum(["logout", "expired"]) }).passthrough(),
  runtime: runtimeEventPayloadSchema,
  approval: pendingRequestSchema,
  "approval-resolved": z.object({ id: z.union([z.string(), z.number()]), reason: z.string().optional() }).passthrough(),
  "backend-status": backendStatusEventPayloadSchema,
  admission: admissionEventSchema,
  queue: queueEventPayloadSchema,
  health: healthEventPayloadSchema,
  threads: threadsEventPayloadSchema,
  codex: codexEventPayloadSchema,
  guardian: guardianEventPayloadSchema
} as const;

export type SseEventName = keyof typeof ssePayloadSchemas;
export type SsePayload<Name extends SseEventName> = z.infer<(typeof ssePayloadSchemas)[Name]>;
export type SseEnvelope<Name extends SseEventName = SseEventName> = {
  eventId: number;
  schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
  threadId: string | null;
  payload: SsePayload<Name>;
};

export function parseSseEnvelope<Name extends SseEventName>(
  name: Name,
  value: unknown,
  lastEventId?: string
): SseEnvelope<Name> {
  const schema = z.object({
    eventId: z.number().int().nonnegative(),
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    threadId: threadIdSchema.nullable(),
    payload: ssePayloadSchemas[name]
  });
  const envelope = schema.parse(value) as SseEnvelope<Name>;
  if (lastEventId && Number(lastEventId) !== envelope.eventId) throw new Error("SSE frame id does not match its envelope");
  return envelope;
}

export function serializeSseEnvelope<Name extends SseEventName>(
  name: Name,
  payload: unknown,
  eventId: number,
  threadId: string | null
): SseEnvelope<Name> {
  return parseSseEnvelope(name, {
    eventId,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    threadId,
    payload
  });
}

export function isSseEventName(value: string): value is SseEventName {
  return Object.prototype.hasOwnProperty.call(ssePayloadSchemas, value);
}

function normalizeTimestampFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeTimestampFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    if (/(?:At|timestamp)$/.test(key) && typeof item === "number" && Number.isFinite(item) && item >= 0) {
      return [key, epochNumberToIso(item)];
    }
    return [key, normalizeTimestampFields(item)];
  }));
}

const directoryEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  leaseStatus: workspaceLeaseStatusSchema.optional()
}).passthrough();
export const directoryResponseSchema = z.object({
  path: z.string().nullable(),
  parent: z.string().nullable(),
  entries: z.array(directoryEntrySchema),
  leaseStatus: workspaceLeaseStatusSchema.nullable().optional()
}).passthrough();
export const threadInventoryResponseSchema = z.object({
  data: z.array(threadResourceSchema),
  nextCursor: z.string().nullable().optional(),
  total: z.number().int().nonnegative().optional(),
  revision: z.union([z.string(), z.number().int().nonnegative().transform(String)]).optional(),
  facets: z.unknown().optional(),
  refreshedAt: timestampSchema.optional()
}).passthrough();
export const threadDetailResponseSchema = z.object({ thread: threadResourceSchema }).passthrough();
const sessionOperationResultSchema = jsonObjectSchema.transform((result) => {
  if (!("thread" in result)) return result;
  return {
    ...result,
    thread: threadResourceSchema.parse(result.thread),
    ...(result.metadata === undefined ? {} : { metadata: threadSessionMetadataSchema.parse(result.metadata) }),
    ...(result.sessionMetadata === undefined ? {} : { sessionMetadata: threadSessionMetadataSchema.parse(result.sessionMetadata) })
  };
});
export const sessionOperationResourceSchema = z.object({
  id: z.uuid(),
  kind: z.enum(["create", "archive"]),
  idempotencyKey: z.string(),
  status: z.enum(["pending", "running", "compensating", "retrying", "succeeded", "failed"]),
  currentStep: z.string(),
  remoteThreadId: threadIdSchema.nullable(),
  attemptCount: z.number().int().nonnegative(),
  compensation: jsonObjectSchema,
  terminal: z.boolean(),
  result: sessionOperationResultSchema.nullable(),
  error: jsonObjectSchema.nullable(),
  nextAttemptAt: nullableTimestampSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  completedAt: nullableTimestampSchema,
  links: z.object({ self: z.string() }).passthrough()
}).passthrough();
export const operationResponseSchema = z.object({ operation: sessionOperationResourceSchema }).passthrough();
export const createSessionResponseSchema = operationResponseSchema;
export const threadRecoveryResponseSchema = z.object({
  revision: z.number().int().nonnegative(),
  threadId: threadIdSchema,
  state: liveThreadStateSchema.nullable(),
  queue: z.array(queueEntrySchema),
  active: z.boolean()
}).passthrough();

type HttpContract = {
  method: string;
  path: RegExp;
  request?: z.ZodType;
  response: z.ZodType;
};

const okResponseSchema = z.object({ ok: z.boolean() }).passthrough();
const unknownObjectSchema = z.object({}).passthrough();
const dataUnknownSchema = z.object({ data: z.unknown() }).passthrough();
const blueprintListSchema = z.object({ data: z.array(agentBlueprintManifestSchema) }).passthrough();
const blueprintResponseSchema = z.object({ blueprint: agentBlueprintManifestSchema }).passthrough();
const scheduleRequestSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  blueprintId: z.string().min(1).max(128),
  blueprintVersion: z.number().int().positive().nullable().optional(),
  variables: z.record(z.string(), blueprintVariableValueSchema).optional(),
  workspace: z.string().max(4_096).nullable().optional(),
  timing: scheduleTimingSchema
}).strict();
const scheduleListSchema = z.object({ data: z.array(agentScheduleSchema) }).passthrough();
const scheduleResponseSchema = z.object({ schedule: agentScheduleSchema }).passthrough();
const missionNodeRequestSchema = missionNodeDefinitionSchema.extend({
  name: z.string().min(1).max(100).optional(),
  blueprintVersion: z.number().int().positive().nullable().optional(),
  dependsOn: z.array(z.string()).max(50).default([]),
  inputMapping: z.record(z.string(), missionValueSourceSchema).default({}),
  outputMapping: z.record(z.string(), z.string()).default({})
}).strict();
const missionRequestSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  name: z.string().min(1).max(100),
  description: z.string().max(1_000).optional(),
  nodes: z.array(missionNodeRequestSchema).min(1).max(50)
}).strict();
const missionRunRequestSchema = z.object({
  inputs: z.record(z.string(), blueprintVariableValueSchema).default({}),
  workspace: workspacePathSchema.nullable().optional()
}).strict();
const missionListSchema = z.object({ data: z.array(missionSchema) }).passthrough();
const missionResponseSchema = z.object({ mission: missionSchema }).passthrough();
const approvalListSchema = z.object({ data: z.array(pendingRequestSchema) }).passthrough();
const queueListSchema = z.object({ data: z.record(z.string(), z.array(queueEntrySchema)) }).passthrough();
const loginRequestSchema = z.object({ token: z.string() }).strict();
const mcpActorRequestSchema = z.object({ clientId: z.string().max(128).optional() }).strict();
const mcpRevokeRequestSchema = z.object({ releaseOwnership: z.literal(true) }).strict();
const mcpHandoffRequestSchema = z.object({
  handoffToken: z.string().min(1).max(256),
  threadIds: z.array(threadIdSchema).min(1).max(50)
}).strict();
const mcpClaimRequestSchema = z.object({
  threadIds: z.array(threadIdSchema).min(1).max(50)
}).strict();
const budgetRequestSchema = z.object({
  scopeType: z.enum(["run", "blueprint", "workspace"]),
  scopeId: z.string().min(1).max(4_096),
  softLimit: jsonObjectSchema.nullable().optional(),
  hardLimit: jsonObjectSchema.nullable().optional(),
  exhaustionPolicy: z.enum(["wait", "pause", "downgrade", "fallback"]).optional()
}).strict();
const threadBatchRequestSchema = z.object({
  operation: z.enum(["read", "archive", "organize"]).optional(),
  threadIds: z.array(threadIdSchema).min(1).max(100),
  tags: z.array(z.string()).optional(),
  category: z.string().nullable().optional()
}).strict();
const commandRequestSchema = z.object({ command: z.string().min(1), args: z.string().nullable().optional() }).strict();
const interruptRequestSchema = z.object({ turnId: z.string().max(128).optional() }).strict();
const threadPolicyRequestSchema = z.object({ yolo: z.boolean() }).strict();
const threadUpdateRequestSchema = z.object({
  name: z.string().max(100).optional(),
  tags: z.array(z.string()).max(10).optional(),
  category: z.string().max(50).nullable().optional(),
  guardian: guardianPolicySchema.optional()
}).strict().refine((value) => Object.keys(value).length > 0, "At least one session field is required");
const guardianActionRequestSchema = z.object({ model: modelNameSchema.optional() }).strict().default({});
const restoreSessionRequestSchema = z.object({}).strict().default({});
const pinSessionRequestSchema = z.object({ pinned: z.boolean().optional() }).strict().default({});
const approvalRequestSchema = z.object({
  decision: z.string().optional(),
  result: z.unknown().optional()
}).strict();
const artifactSubmissionBase = {
  name: z.string().min(1).max(200),
  schema: artifactDescriptorSchema.optional(),
  retention: artifactRetentionSchema.partial().optional(),
  provenance: z.object({
    trust: z.enum(["deterministic", "human", "advisory"]).optional(),
    command: z.string().max(100_000).nullable().optional(),
    cwd: z.string().max(4_096).nullable().optional(),
    tool: z.string().max(200).nullable().optional(),
    details: jsonObjectSchema.optional()
  }).strict().optional(),
  turnId: z.string().max(200).nullable().optional(),
  itemId: z.string().max(200).nullable().optional()
};
export const artifactSubmissionSchema = z.discriminatedUnion("type", [
  z.object({ ...artifactSubmissionBase, type: z.literal("FileArtifact"), content: z.object({ path: z.string().min(1).max(4_096) }).strict() }).strict(),
  z.object({ ...artifactSubmissionBase, type: z.literal("PatchArtifact"), content: patchArtifactContentSchema.pick({ format: true, patch: true, files: true, appliesCleanly: true }).required({ patch: true }).partial({ files: true, appliesCleanly: true }) }).strict(),
  z.object({ ...artifactSubmissionBase, type: z.literal("TestResultArtifact"), content: testResultArtifactContentSchema }).strict(),
  z.object({ ...artifactSubmissionBase, type: z.literal("CommandArtifact"), content: commandArtifactContentSchema }).strict(),
  z.object({ ...artifactSubmissionBase, type: z.literal("ReviewVerdictArtifact"), content: reviewVerdictArtifactContentSchema }).strict()
]);
export type ArtifactSubmission = z.infer<typeof artifactSubmissionSchema>;
export const artifactListResponseSchema = z.object({
  data: z.array(artifactSchema),
  completion: artifactStatusSchema
}).strict();
export const artifactResponseSchema = z.object({ artifact: artifactSchema }).strict();

const httpContracts: readonly HttpContract[] = [
  { method: "GET", path: /^\/api\/auth$/, response: z.object({ authenticated: z.boolean() }).strict() },
  { method: "POST", path: /^\/api\/webhook\/trigger$/, request: webhookTriggerRequestSchema, response: webhookTriggerResponseSchema },
  { method: "POST", path: /^\/api\/login$/, request: loginRequestSchema, response: okResponseSchema },
  { method: "POST", path: /^\/api\/logout$/, response: okResponseSchema },
  { method: "POST", path: /^\/api\/mcp\/actors$/, request: mcpActorRequestSchema, response: z.object({ actorId: z.string(), token: z.string() }).passthrough() },
  { method: "POST", path: /^\/api\/mcp\/actors\/current\/rotate$/, request: z.object({}).strict(), response: unknownObjectSchema },
  { method: "DELETE", path: /^\/api\/mcp\/actors\/current$/, request: mcpRevokeRequestSchema, response: unknownObjectSchema },
  { method: "POST", path: /^\/api\/mcp\/handoffs$/, request: z.object({}).strict(), response: unknownObjectSchema },
  { method: "POST", path: /^\/api\/mcp\/owned-threads\/handoff$/, request: mcpHandoffRequestSchema, response: unknownObjectSchema },
  { method: "POST", path: /^\/api\/mcp\/owned-threads\/claim$/, request: mcpClaimRequestSchema, response: unknownObjectSchema },
  { method: "GET", path: /^\/api\/mcp\/owned-threads$/, response: z.object({ actorId: z.string().optional(), data: z.array(threadIdSchema) }).passthrough() },
  { method: "GET", path: /^\/api\/health$/, response: unknownObjectSchema },
  { method: "GET", path: /^\/api\/diagnostics\/performance$/, response: unknownObjectSchema },
  { method: "GET", path: /^\/api\/bootstrap$/, response: startupConfigurationSchema },
  { method: "GET", path: /^\/api\/account\/status$/, response: accountStatusSchema },
  { method: "GET", path: /^\/api\/(?:usage|budgets)$/, response: dataUnknownSchema },
  { method: "PUT", path: /^\/api\/budgets$/, request: budgetRequestSchema, response: unknownObjectSchema },
  { method: "DELETE", path: /^\/api\/budgets$/, response: okResponseSchema },
  { method: "GET", path: /^\/api\/policies$/, response: policyListSchema },
  { method: "POST", path: /^\/api\/policies$/, request: policyRequestSchema, response: policyResponseSchema },
  { method: "DELETE", path: /^\/api\/policies$/, request: policyDeleteRequestSchema, response: okResponseSchema },
  { method: "GET", path: /^\/api\/approvals$/, response: approvalListSchema },
  { method: "POST", path: /^\/api\/approvals\/[^/]+$/, request: approvalRequestSchema, response: okResponseSchema },
  { method: "GET", path: /^\/api\/queues$/, response: queueListSchema },
  { method: "GET", path: /^\/api\/blueprints$/, response: blueprintListSchema },
  { method: "POST", path: /^\/api\/blueprints(?:\/import)?$/, request: unknownObjectSchema, response: blueprintResponseSchema },
  { method: "GET", path: /^\/api\/blueprints\/[^/]+\/export$/, response: agentBlueprintManifestSchema },
  { method: "GET", path: /^\/api\/blueprints\/[^/]+\/versions$/, response: blueprintListSchema },
  { method: "POST", path: /^\/api\/blueprints\/[^/]+\/versions$/, request: unknownObjectSchema, response: blueprintResponseSchema },
  { method: "GET", path: /^\/api\/blueprints\/[^/]+$/, response: blueprintResponseSchema },
  { method: "GET", path: /^\/api\/schedules$/, response: scheduleListSchema },
  { method: "POST", path: /^\/api\/schedules$/, request: scheduleRequestSchema, response: scheduleResponseSchema },
  { method: "PUT", path: /^\/api\/schedules\/[^/]+$/, request: scheduleRequestSchema, response: scheduleResponseSchema },
  { method: "DELETE", path: /^\/api\/schedules\/[^/]+$/, response: okResponseSchema },
  { method: "GET", path: /^\/api\/missions$/, response: missionListSchema },
  { method: "POST", path: /^\/api\/missions$/, request: missionRequestSchema, response: missionResponseSchema },
  { method: "DELETE", path: /^\/api\/missions$/, response: okResponseSchema },
  { method: "GET", path: /^\/api\/missions\/[^/]+$/, response: missionResponseSchema },
  { method: "DELETE", path: /^\/api\/missions\/[^/]+$/, response: okResponseSchema },
  { method: "POST", path: /^\/api\/missions\/[^/]+\/run$/, request: missionRunRequestSchema, response: missionResponseSchema },
  { method: "GET", path: /^\/api\/evals$/, response: evalListSchema },
  { method: "POST", path: /^\/api\/evals$/, request: evalRequestSchema, response: evalResponseSchema },
  { method: "GET", path: /^\/api\/evals\/[^/]+$/, response: evalResponseSchema },
  { method: "GET", path: /^\/api\/compare$/, response: comparisonListSchema },
  { method: "POST", path: /^\/api\/compare$/, request: compareRequestSchema, response: comparisonResponseSchema },
  { method: "GET", path: /^\/api\/compare\/[^/]+$/, response: comparisonResponseSchema },
  { method: "GET", path: /^\/api\/knowledge-packs$/, response: knowledgePackListSchema },
  { method: "POST", path: /^\/api\/knowledge-packs$/, request: knowledgePackRequestSchema, response: knowledgePackResponseSchema },
  { method: "DELETE", path: /^\/api\/knowledge-packs$/, response: okResponseSchema },
  { method: "DELETE", path: /^\/api\/knowledge-packs\/[^/]+$/, response: okResponseSchema },
  { method: "POST", path: /^\/api\/knowledge-packs\/[^/]+\/refresh$/, request: z.object({}).strict().optional(), response: knowledgePackResponseSchema },
  { method: "GET", path: /^\/api\/directories$/, response: directoryResponseSchema },
  { method: "GET", path: /^\/api\/files$/, response: dataUnknownSchema },
  { method: "GET", path: /^\/api\/workspaces\/[^/]+\/leases$/, response: workspaceLeaseStatusSchema },
  { method: "GET", path: /^\/api\/operations\/[^/]+$/, response: operationResponseSchema },
  { method: "GET", path: /^\/api\/threads$/, response: threadInventoryResponseSchema },
  { method: "GET", path: /^\/api\/archive$/, response: archiveResponseSchema },
  { method: "POST", path: /^\/api\/threads$/, request: createSessionRequestSchema, response: createSessionResponseSchema },
  { method: "POST", path: /^\/api\/threads\/batch$/, request: threadBatchRequestSchema, response: unknownObjectSchema },
  { method: "GET", path: /^\/api\/threads\/[^/]+\/history$/, response: dataUnknownSchema },
  { method: "GET", path: /^\/api\/threads\/[^/]+\/recovery$/, response: threadRecoveryResponseSchema },
  { method: "GET", path: /^\/api\/sessions\/[^/]+\/timeline$/, response: sessionTimelineSchema },
  { method: "GET", path: /^\/api\/sessions\/[^/]+\/artifacts$/, response: artifactListResponseSchema },
  { method: "POST", path: /^\/api\/sessions\/[^/]+\/artifacts$/, request: artifactSubmissionSchema, response: artifactResponseSchema },
  { method: "GET", path: /^\/api\/artifacts\/[^/]+$/, response: artifactResponseSchema },
  { method: "GET", path: /^\/api\/sessions\/[^/]+\/export$/, response: z.union([sessionExportSchema, z.string()]) },
  { method: "GET", path: /^\/api\/sessions\/[^/]+\/guardian$/, response: z.object({ guardian: runGuardianStateSchema }).passthrough() },
  { method: "POST", path: /^\/api\/sessions\/[^/]+\/restore$/, request: restoreSessionRequestSchema, response: z.object({ restored: z.literal(true), thread: threadResourceSchema }).strict() },
  { method: "POST", path: /^\/api\/sessions\/[^/]+\/pin$/, request: pinSessionRequestSchema, response: z.object({ id: threadIdSchema, pinned: z.boolean(), ttlExempt: z.boolean() }).strict() },
  { method: "POST", path: /^\/api\/sessions\/[^/]+\/lease$/, request: workspaceLeaseRequestSchema, response: workspaceLeaseResponseSchema },
  { method: "GET", path: /^\/api\/search$/, response: z.object({ data: z.array(sessionSearchResultSchema), total: z.number().int().nonnegative() }).strict() },
  { method: "GET", path: /^\/api\/analytics$/, response: outcomeAnalyticsSchema },
  { method: "POST", path: /^\/api\/sessions\/[^/]+\/guardian\/(?:retry|escalate)$/, request: guardianActionRequestSchema, response: z.object({ guardian: runGuardianStateSchema }).passthrough() },
  { method: "PUT", path: /^\/api\/events\/subscriptions\/[A-Za-z0-9._-]{1,128}$/, request: eventSubscriptionRequestSchema, response: eventSubscriptionResponseSchema },
  { method: "GET", path: /^\/api\/events\/revision$/, response: z.object({ revision: z.number().int().nonnegative() }).passthrough() },
  { method: "GET", path: /^\/api\/threads\/[^/]+$/, response: threadDetailResponseSchema },
  { method: "POST", path: /^\/api\/threads\/[^/]+\/(?:messages|queue)$/, request: messageRequestSchema, response: unknownObjectSchema },
  { method: "DELETE", path: /^\/api\/threads\/[^/]+\/queue\/[^/]+$/, response: okResponseSchema },
  { method: "POST", path: /^\/api\/threads\/[^/]+\/command$/, request: commandRequestSchema, response: unknownObjectSchema },
  { method: "POST", path: /^\/api\/threads\/[^/]+\/interrupt$/, request: interruptRequestSchema, response: unknownObjectSchema },
  { method: "PATCH", path: /^\/api\/threads\/[^/]+\/policy$/, request: threadPolicyRequestSchema, response: unknownObjectSchema },
  { method: "PATCH", path: /^\/api\/threads\/[^/]+$/, request: threadUpdateRequestSchema, response: unknownObjectSchema },
  { method: "DELETE", path: /^\/api\/threads\/[^/]+$/, response: unknownObjectSchema }
];

export function parseHttpRequest(method: string, path: string, value: unknown): unknown {
  const contract = findHttpContract(method, path);
  return contract?.request ? contract.request.parse(value) : value;
}

export function parseHttpResponse(method: string, path: string, value: unknown): unknown {
  const contract = findHttpContract(method, path);
  return contract ? contract.response.parse(value) : value;
}

export function hasHttpContract(method: string, path: string): boolean {
  return Boolean(findHttpContract(method, path));
}

function findHttpContract(method: string, path: string): HttpContract | undefined {
  const pathname = path.split("?", 1)[0] || path;
  const normalizedMethod = method.toUpperCase();
  return httpContracts.find((contract) => contract.method === normalizedMethod && contract.path.test(pathname));
}

// MCP schemas live here as the fourth adapter over the same protocol primitives.
// Advertised MCP output schemas must remain directly representable as JSON
// Schema, while the exported resource parser still normalizes legacy timestamps.
const mcpNullableTimestampSchema = z.union([z.string(), z.number().finite().nonnegative(), z.null()]);
export const mcpSessionSummarySchema = z.object({
  id: threadIdSchema,
  name: z.string().nullable(),
  preview: z.string(),
  cwd: z.string(),
  created_at: nullableTimestampSchema,
  updated_at: nullableTimestampSchema,
  category: z.string().nullable(),
  tags: z.array(z.string()),
  provider: providerSchema,
  backend: providerSchema.optional(),
  session_class: sessionClassSchema,
  preset: modelPresetSchema.nullable().optional(),
  model: z.string().nullable(),
  reasoning_effort: z.string().nullable(),
  effort: z.string().nullable().optional(),
  state: z.string(),
  health: z.enum(["ok", "stalled", "error", "idle"]).optional(),
  last_activity: mcpNullableTimestampSchema.optional(),
  files_count: z.number().int().nonnegative().optional(),
  agent_owned: z.boolean(),
  mutation_access: z.enum(["allowed", "view-only"])
}).passthrough();
const mcpSessionSummaryOutputSchema = mcpSessionSummarySchema.extend({
  created_at: mcpNullableTimestampSchema,
  updated_at: mcpNullableTimestampSchema
});
const mcpBriefSessionSummaryOutputSchema = z.object({
  id: threadIdSchema,
  name: z.string().nullable(),
  state: z.string(),
  cwd: z.string(),
  provider: providerSchema,
  model: z.string().nullable(),
  effort: z.string().nullable()
});
export const mcpRateLimitSchema = z.object({ usedPercent: z.number(), resetsAt: mcpNullableTimestampSchema }).nullable();
export const mcpUsageSchema = z.object({
  codex: z.object({ available: z.boolean(), rateLimit: mcpRateLimitSchema, planType: z.string().nullable() }),
  spark: z.object({ available: z.boolean(), rateLimit: mcpRateLimitSchema })
});
export const mcpHealthOutputSchema = z.object({
  status: z.enum(["ok", "degraded"]), forgedeck: z.literal("reachable"),
  codex_adapter: z.enum(["ready", "busy", "unavailable"]), latency_ms: z.number(),
  forgedeck_latency_ms: z.number().optional(), model_count: z.number().optional(), error: z.string().optional(),
  retryable: z.boolean().optional(), session_spawned: z.literal(false)
});
export const mcpModelOptionSchema = z.object({
  id: z.unknown().optional(), model: z.unknown().optional(), display_name: z.unknown().optional(),
  description: z.unknown().optional(), is_default: z.unknown().optional(),
  default_reasoning_effort: z.unknown().optional(), supported_reasoning_efforts: z.unknown().optional()
});
export const mcpModelPresetOptionSchema = z.object({
  preset: modelPresetSchema,
  label: z.string(),
  model: modelNameSchema,
  effort: reasoningEffortSchema
});
export const mcpOptionsOutputSchema = z.object({
  workspace_roots: z.array(z.string()), models: z.array(mcpModelOptionSchema), presets: z.array(mcpModelPresetOptionSchema), usage: mcpUsageSchema,
  defaults: z.object({ yolo: z.literal(false), session_class: z.literal("standard"), class: z.literal("standard").optional() }),
  yolo_warning: z.string()
});
export const mcpDirectoriesOutputSchema = z.object({ directories: z.unknown() });
export const mcpSpawnSessionOutputSchema = z.object({
  session: mcpSessionSummaryOutputSchema, agent_owned: z.literal(true), visible_in_control_center: z.boolean(),
  visible_in_sparkboard: z.boolean(), first_turn_started: z.boolean(), warnings: z.array(z.string())
});
export const mcpSessionListOutputSchema = z.object({ sessions: z.array(mcpSessionSummaryOutputSchema) });
// MCP advertises JSON Schema, so its resource shape must not reuse HTTP timestamp transforms.
const mcpArtifactResourceSchema = z.object({
  id: z.string(),
  sessionId: threadIdSchema,
  name: z.string(),
  version: z.number().int().positive(),
  schemaVersion: z.literal(1),
  type: artifactTypeSchema,
  schema: z.unknown(),
  producer: z.unknown(),
  provenance: z.unknown(),
  contentHash: z.string(),
  retention: z.unknown(),
  reference: z.unknown().nullable(),
  validation: z.unknown(),
  content: z.unknown().nullable(),
  createdAt: mcpNullableTimestampSchema,
  updatedAt: mcpNullableTimestampSchema
}).passthrough();
export const mcpSessionDetailOutputSchema = z.object({
  session: z.union([mcpSessionSummaryOutputSchema, mcpBriefSessionSummaryOutputSchema]), goal: z.unknown().optional(), policy: z.unknown(), queued_messages: z.unknown().optional(),
  recent_turns: z.array(z.unknown()).optional(), recent_agent_messages: z.array(z.string()).max(2).optional(),
  artifacts: z.array(mcpArtifactResourceSchema).optional(), completion: artifactStatusSchema,
  files: z.array(z.string()).max(1_000),
  health: z.enum(["ok", "stalled", "error", "idle"]),
  last_message: z.string(),
  mutation_access: z.enum(["allowed", "view-only"]).optional(),
  pagination: z.object({
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().nonnegative(),
    returned_items: z.number().int().nonnegative(),
    total_items: z.number().int().nonnegative(),
    has_more: z.boolean(),
    next_offset: z.number().int().nonnegative().nullable(),
    next_cursor: z.string().nullable()
  }).optional()
});
export const mcpWaitSessionOutputSchema = mcpSessionDetailOutputSchema;
export const mcpArtifactListOutputSchema = z.object({ artifacts: z.array(mcpArtifactResourceSchema), completion: artifactStatusSchema });
export const mcpArtifactOutputSchema = z.object({ artifact: mcpArtifactResourceSchema });
export const mcpSendMessageOutputSchema = z.object({ delivery: z.enum(["started", "queued"]), result: z.unknown() });
export const mcpSetYoloOutputSchema = z.object({ yolo: z.boolean(), result: z.unknown() });
export const mcpBatchMutationItemSchema = z.object({ id: z.string(), ok: z.boolean(), error: z.string().nullable() });
export const mcpBatchMutationOutputSchema = z.object({
  results: z.array(mcpBatchMutationItemSchema), ok: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative()
});
export const mcpBatchSpawnOutputSchema = z.object({
  results: z.array(z.union([mcpSpawnSessionOutputSchema, z.object({ error: z.string() })])),
  ok: z.number().int().nonnegative(), failed: z.number().int().nonnegative()
});
export const mcpCreateHandoffOutputSchema = z.object({ token: z.string(), expires: z.string() });
export const mcpHandoffSessionsOutputSchema = z.object({ ids: z.array(threadIdSchema), target: z.string() });
export const mcpRevokeIdentityOutputSchema = z.object({
  revoked: z.literal(true), archived: z.array(threadIdSchema), released: z.array(threadIdSchema)
});

export const mcpEmptyInputSchema = z.object({});
export const mcpListDirectoriesInputSchema = z.object({ path: workspacePathSchema.optional() });
export const mcpSpawnSessionInputSchema = z.object({
  cwd: workspacePathSchema,
  provider: providerSchema.default("codex"),
  preset: modelPresetSchema.optional(),
  model: modelNameSchema.optional(),
  effort: reasoningEffortSchema.optional(),
  class: sessionClassSchema.default("standard"),
  yolo: z.boolean().default(false),
  fileScope: workspaceFileScopeSchema.optional(),
  name: z.string().max(100).optional(),
  category: z.string().max(50).optional(),
  tags: tagListSchema,
  prompt: z.string().max(100_000).optional()
}).superRefine((value, context) => {
  if (!value.preset && (!value.model || !value.effort)) {
    context.addIssue({ code: "custom", path: ["preset"], message: "Choose a preset or provide both model and effort" });
  }
  if (!value.preset) return;
  const target = MODEL_PRESETS[value.preset];
  if (value.provider !== "codex") {
    context.addIssue({ code: "custom", path: ["preset"], message: "Model presets only support the Codex provider" });
  }
  if (value.class !== "standard") {
    context.addIssue({ code: "custom", path: ["preset"], message: "Model presets only support standard sessions" });
  }
  if (value.model && value.model !== target.model) {
    context.addIssue({ code: "custom", path: ["model"], message: `Model conflicts with the ${target.label} preset` });
  }
  if (value.effort && value.effort !== target.effort) {
    context.addIssue({ code: "custom", path: ["effort"], message: `Effort conflicts with the ${target.label} preset` });
  }
});
export const mcpListSessionsInputSchema = z.object({
  query: z.string().optional(), active: z.boolean().default(false), limit: z.number().int().min(1).max(200).default(100)
});
export const mcpGetSessionInputSchema = z.object({
  id: threadIdSchema,
  brief: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(30),
  offset: z.number().int().nonnegative().default(0),
  cursor: z.string().max(2_048).optional()
}).superRefine((value, context) => {
  if (value.cursor && value.offset > 0) {
    context.addIssue({ code: "custom", path: ["offset"], message: "offset must be zero when cursor is provided" });
  }
});
export const mcpWaitSessionInputSchema = z.object({
  id: threadIdSchema,
  timeout: z.number().finite().positive().max(86_400).default(600)
});
export const mcpListArtifactsInputSchema = z.object({ id: threadIdSchema });
export const mcpGetArtifactInputSchema = z.object({ id: z.uuid() });
export const mcpPublishArtifactInputSchema = z.object({
  id: threadIdSchema,
  artifact: artifactSubmissionSchema
});
export const mcpSendMessageInputSchema = z.object({
  id: threadIdSchema, text: z.string().min(1).max(100_000), model: modelNameSchema,
  effort: reasoningEffortSchema, queue: z.boolean().default(true)
});
export const mcpSetYoloInputSchema = z.object({ id: threadIdSchema, yolo: z.boolean() });
export const mcpBatchSpawnInputSchema = z.object({ items: z.array(mcpSpawnSessionInputSchema).min(1).max(20) });
export const mcpBatchThreadsInputSchema = z.object({ ids: z.array(threadIdSchema).min(1).max(50) });
export const mcpHandoffSessionsInputSchema = z.object({
  token: z.string().min(32).max(256), ids: z.array(threadIdSchema).min(1).max(50)
});
export const mcpClaimSessionsInputSchema = z.object({
  ids: z.string().min(1).max(6_500).transform((value, context) => {
    const parsed = [...new Set(value.split(",").map((id) => id.trim()).filter(Boolean))];
    if (!parsed.length || parsed.length > 50) {
      context.addIssue({ code: "custom", message: "Provide between 1 and 50 comma-separated session IDs" });
      return z.NEVER;
    }
    for (const id of parsed) {
      if (!threadIdSchema.safeParse(id).success) {
        context.addIssue({ code: "custom", message: `Invalid session ID: ${id}` });
        return z.NEVER;
      }
    }
    return parsed;
  })
});
export const mcpClaimSessionsOutputSchema = z.object({ ids: z.array(threadIdSchema), actor: z.string() });
export const mcpRevokeIdentityInputSchema = z.object({ mode: z.enum(["release", "archive"]) });

export type McpSpawnSessionInput = z.infer<typeof mcpSpawnSessionInputSchema>;
