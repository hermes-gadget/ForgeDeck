import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  compareRequestSchema,
  createSessionRequestSchema,
  evalRequestSchema,
  knowledgePackRequestSchema,
  messageRequestSchema,
  parseHttpRequest,
  parseHttpResponse,
  webhookTriggerRequestSchema,
  type ModelPreset
} from "../shared/contracts.js";
import { ApiProfiler } from "./api-profiler.js";
import { ArtifactValidationError } from "./artifacts.js";
import {
  AdmissionController,
  AdmissionDeniedError,
  normalizeRateLimitSnapshots,
  normalizeTokenSnapshot,
  retryAfterSecondsFromError,
  type AdmissionDecision,
  type AdmissionProjection,
  type BudgetLimit,
  type DeclaredExhaustionPolicy,
  type UsageAttribution
} from "./admission-control.js";
import { AsyncTtlCache } from "./async-cache.js";
import { AuthManager } from "./auth.js";
import { BackgroundTaskSupervisor, type BackgroundHealthReport } from "./background-tasks.js";
import {
  BlueprintConflictError,
  BlueprintValidationError,
  type ResolvedBlueprintRun
} from "./blueprints.js";
import { CapacityCancelledError, CapacityManager, CapacityUnavailableError, type CapacityBackend } from "./capacity.js";
import { CodexBridge, CodexBridgeError, CodexRpcError, CodexUnavailableError, type ServerRequest } from "./codex-bridge.js";
import {
  buildComparisonDiffs,
  buildComparisonJudgePrompt,
  parseComparisonJudgeVerdict,
  type ComparisonRun
} from "./comparisons.js";
import { assertRuntimeReady, loadConfig, readProcessEnvironment } from "./config.js";
import { createCorsMiddleware } from "./cors.js";
import {
  BackendUnavailableError,
  CapacityError,
  ConflictError,
  ForgeDeckError,
  InternalError,
  NotFoundError,
  serializeError,
  ValidationError,
  type ErrorScope,
  type SerializedForgeDeckError
} from "./errors.js";
import { ExternalCodexMonitor } from "./external-monitor.js";
import { evalOutput, scoreEval, type EvalRun } from "./evals.js";
import { jsonRevision, matchesIfNoneMatch } from "./http-cache.js";
import { LiveRecoveryStore } from "./live-recovery.js";
import { KnowledgePackConflictError } from "./knowledge-packs.js";
import { logger } from "./logger.js";
import { McpAccessManager } from "./mcp-access.js";
import {
  MissionConflictError,
  MissionRunner,
  MissionValidationError,
  type MissionExecution,
  type MissionNodeInspection,
  type MissionNodeRun,
  type MissionRun
} from "./missions.js";
import { AdaptiveOperationPool, type OperationContext, type OperationOptions } from "./operation-pool.js";
import { PathError, WorkspacePaths } from "./paths.js";
import { PolicyNotFoundError, type PolicyDecision } from "./policy-engine.js";
import { createRateLimiter } from "./rate-limit.js";
import {
  RunGuardian,
  selectStrongerModel,
  type RunGuardianPolicy,
  type RunGuardianState
} from "./run-guardian.js";
import { createServerRuntimeOptions } from "./runtime-options.js";
import {
  ScheduleConflictError,
  ScheduleRunner,
  ScheduleValidationError,
  type AgentSchedule,
  type ScheduleRun
} from "./schedules.js";
import {
  SessionManager,
  SessionOperationConflictError,
  deriveSessionName,
  isSessionExpired,
  type SessionBackend,
  type SessionArchiveReason,
  type SessionClass,
  type SessionOperation,
  type WorkspaceLeaseMode
} from "./session-manager.js";
import { SessionInventoryIndex, type InventoryItem, type InventorySortKey } from "./session-inventory.js";
import { formatRevisionedSseEvent, SseSessionRegistry } from "./sse-session.js";
import { createSessionExport, sessionExportToMarkdown } from "./session-export.js";
import { createWorkspaceRouter } from "./workspace-routes.js";
import { QueueDrainScheduler, type BudgetScopeType, type UsageProvider } from "./store.js";
import { verifyWebhookSignature, webhookIdempotencyKey, webhookTriggerResource } from "./webhook.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const packageVersion = readPackageVersion();
const environment = readProcessEnvironment();
const config = loadConfig(projectRoot, environment);
const runtimeOptions = createServerRuntimeOptions(config, environment);
logger.configure(runtimeOptions.logging);
for (const setting of config.overriddenSettings) {
  logger.warn("Configuration default overridden", { setting });
}
const preflight = assertRuntimeReady(config);
for (const warning of preflight.warnings) logger.warn("Startup preflight warning", { warning });
const { dataDir, distDir, host, port } = config;
const auth = new AuthManager(dataDir, runtimeOptions.auth);
const mcpAccess = new McpAccessManager(dataDir, runtimeOptions.mcpAccess);
const sessions = await SessionManager.create(dataDir, Date.now, runtimeOptions.sessions);
const recoveredEvals = sessions.evals.recoverInterrupted();
if (recoveredEvals.length) logger.warn("Interrupted eval runs were marked failed", { count: recoveredEvals.length });
const recoveredComparisons = sessions.comparisons.recoverInterrupted();
if (recoveredComparisons.length) logger.warn("Interrupted comparison runs were marked failed", { count: recoveredComparisons.length });
const workspaces = await WorkspacePaths.create(runtimeOptions.workspaces.roots, runtimeOptions.workspaces.search);
const readOperations = new AdaptiveOperationPool({
  name: "read",
  ...runtimeOptions.readOperations,
  latencyTargetMs: 2_000,
  isBackpressureError: isOperationBackpressureError
});
const mutationOperations = new AdaptiveOperationPool({
  name: "mutation",
  ...runtimeOptions.mutationOperations,
  latencyTargetMs: 5_000,
  isBackpressureError: isOperationBackpressureError
});
const codex = new CodexBridge({ runtime: runtimeOptions.codex, backgroundScheduler: readOperations });
const capacity = new CapacityManager(runtimeOptions.capacity);
const admission = new AdmissionController(sessions, runtimeOptions.admission);
const INTERACTIVE_CAPACITY_WAIT_MS = 5_000;
const QUEUE_CAPACITY_WAIT_MS = 30_000;
const RECOVERY_START_DEADLINE_MS = 60_000;
const app = express();
const profiler = new ApiProfiler(runtimeOptions.profiler.slowRequestMs, (message) => logger.warn(message));
type RequestOperationScope = { signal: AbortSignal; fairnessKey: string; requestId: string };
const requestOperationScope = new AsyncLocalStorage<RequestOperationScope>();
const MAX_SSE_CONNECTIONS = 256;
const MAX_SSE_CONNECTIONS_PER_SESSION = 3;
const MAX_SSE_THREAD_SUBSCRIPTIONS = 256;
const MAX_PENDING_SSE_BYTES = 2 * 1024 * 1024;
let sseEventId = sessions.latestTimelineRevision();
const sseClients = new SseSessionRegistry(MAX_SSE_CONNECTIONS, MAX_SSE_CONNECTIONS_PER_SESSION, () => sseEventId);
let backgroundHealthSignature = "";
const backgroundTasks = new BackgroundTaskSupervisor({ onHealthChange: publishBackgroundHealth });
const removeAuthInvalidationListener = auth.onSessionInvalidated(({ sessionId, reason }) => sseClients.closeSession(sessionId, reason));
type PendingSseMessage = { message: string; subscriptionThreadId: string | null };
const pendingSseMessages: PendingSseMessage[] = [];
let pendingSseBytes = 0;
let sseFlushScheduled = false;
let externalMonitor: ExternalCodexMonitor | null = null;
let unavailableThreadIds = new Set<string>();
let reconciledInventoryIds: Set<string> | null = null;
type QueuedMessage = {
  id: string;
  text: string;
  model: string;
  effort: string | null;
  createdAt: number;
  admissionPolicy: DeclaredExhaustionPolicy | null;
  projection: AdmissionProjection | null;
};
const queueFile = path.join(dataDir, "message-queues.json");
const messageQueues = loadMessageQueues();
type ThreadPolicy = "workspace-write" | "yolo";
const policyFile = path.join(dataDir, "thread-policies.json");
const threadPolicies = loadThreadPolicies();
const activeThreads = new Set<string>();
type ActivitySource = "bridge" | "external";
const activeThreadSources = new Map<string, Set<ActivitySource>>();
const activeTurnIds = new Map<string, string>();
const usageModelsByThread = new Map<string, string>();
const deadProcessThreadIds = new Set<string>();
const drainingQueues = new Set<string>();
const admissionQueueTimers = new Map<string, NodeJS.Timeout>();
const admissionPausedQueues = new Set<string>();
const bridgeOwnedThreads = new Set<string>();
const capacityBuffers = new Map<string, string>();
const capacityHandledThreads = new Set<string>();
const capacityRecoveringThreads = new Set<string>();
const capacityRecoveryTimers = new Map<string, NodeJS.Timeout>();
const knownThreadIds = new Set<string>();
const archivingThreadIds = new Set<string>();
const removedThreadIds = new Set<string>();
const durableOperationSignal = new AbortController().signal;
const sessionOperationScheduler = new QueueDrainScheduler(runSessionOperation, {
  minimumRetryMs: 1_000,
  maximumRetryMs: 30_000,
  onFailure: (operationId, error, retryInMs) => logger.warn("Durable session operation deferred", { operationId, retryInMs, error })
});
const scheduleRunner = new ScheduleRunner(
  sessions.schedules,
  fireScheduledSession,
  (operationId) => sessions.getSessionOperation(operationId),
  60_000,
  (error) => logger.warn("Scheduled runs could not be checked", { error })
);
const missionRunner = new MissionRunner(
  sessions.missions,
  fireMissionNode,
  inspectMissionNode,
  1_500,
  (error) => logger.warn("Mission runs could not be checked", { error })
);
const sessionTtlMs = config.sessionTtlMs;
const sparkTtlMs = config.sparkTtlMs;
const liveRecovery = new LiveRecoveryStore(runtimeOptions.liveRecovery);
const inventoryIndex = new SessionInventoryIndex(loadSessionInventory);
const removeInventoryMetadataListener = sessions.onMetadataChanged(() => inventoryIndex.invalidate());
const guardian = new RunGuardian({
  load: () => sessions.listRunGuardianStates(),
  save: (state) => sessions.saveRunGuardianState(state),
  remove: (threadId) => sessions.removeRunGuardianState(threadId)
}, {
  retry: (threadId) => retryGuardianRun(threadId),
  escalate: (threadId, requestedModel) => escalateGuardianRun(threadId, requestedModel),
  pause: (threadId) => pauseGuardianRun(threadId)
}, {
  onChange: (state, reason) => {
    inventoryIndex.invalidate();
    broadcast("guardian", { threadId: state.threadId, reason, guardian: state });
    void sessions.record(state.threadId, `guardian_${reason.replaceAll("-", "_")}`, "guardian", guardianAuditDetails(state))
      .catch((error) => logger.warn("Could not record guardian state change", { threadId: state.threadId, reason, error }));
  }
});
const allowedCorsOrigins = config.trustedOrigins;
type ModelListResponse = { data: Array<{ id: string; model: string; supportedReasoningEfforts: Array<{ reasoningEffort: string }> }> };
type UsageResponse = { rateLimits?: unknown; rateLimitsByLimitId?: Record<string, unknown> | null };
const modelCache = new AsyncTtlCache<ModelListResponse>(runtimeOptions.caches.modelTtlMs);
type AccountStatusCore = {
  account: unknown | null;
  usage: UsageResponse | null;
  models: ModelListResponse;
  errors: unknown[];
};
const accountStatusCache = new AsyncTtlCache<AccountStatusCore>(3_000);
const quotaCache = new AsyncTtlCache<UsageResponse>(3_000);
const serverIdentity = {
  id: `forgedeck-${crypto.createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 16)}`,
  name: "ForgeDeck"
};
const apiRateLimiter = createRateLimiter({
  ...runtimeOptions.rateLimit,
  key: (req) => config.trustProxy ? req.ip || req.socket.remoteAddress || "unknown" : req.socket.remoteAddress || "unknown"
});

app.disable("x-powered-by");
if (config.trustProxy) app.set("trust proxy", 1);
app.use(requestLogger);
app.use(operationScopeMiddleware);
app.use(profiler.middleware);
app.use(securityHeaders);
app.use(createCorsMiddleware({ publicOrigin: config.publicOrigin, allowedOrigins: allowedCorsOrigins }));
app.post("/api/webhook/trigger", apiRateLimiter, express.raw({ type: () => true, limit: "256kb" }), async (req, res, next) => {
  try {
    if (!config.webhookSecret) {
      throw httpError("Webhook triggers are not configured", 503, "WEBHOOK_NOT_CONFIGURED");
    }
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const signature = req.get("X-ForgeDeck-Signature") || req.get("X-Hub-Signature-256");
    if (!verifyWebhookSignature(rawBody, signature, config.webhookSecret)) {
      throw httpError("Invalid webhook signature", 401, "INVALID_WEBHOOK_SIGNATURE");
    }
    if (!req.is("application/json")) {
      throw httpError("Webhook triggers require Content-Type: application/json", 415, "INVALID_WEBHOOK_CONTENT_TYPE");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(rawBody.toString("utf8")) as unknown;
    } catch (error) {
      throw httpError(error instanceof Error ? `Invalid webhook JSON: ${error.message}` : "Invalid webhook JSON", 400, "INVALID_WEBHOOK_PAYLOAD");
    }
    const parsed = webhookTriggerRequestSchema.safeParse(decoded);
    if (!parsed.success) {
      throw httpError(parsed.error.issues[0]?.message || "Invalid webhook payload", 400, "INVALID_WEBHOOK_PAYLOAD");
    }
    const blueprint = sessions.blueprints.getByName(parsed.data.blueprint);
    if (!blueprint) throw httpError("Blueprint not found", 404, "BLUEPRINT_NOT_FOUND");
    const deliveryKey = req.get("Idempotency-Key") || req.get("X-GitHub-Delivery");
    let idempotencyKey: string;
    try {
      idempotencyKey = webhookIdempotencyKey(deliveryKey);
    } catch (error) {
      throw httpError(error instanceof Error ? error.message : "Invalid idempotency key", 400, "INVALID_IDEMPOTENCY_KEY");
    }
    const { operation } = await acceptSessionCreation({
      cwd: parsed.data.workspace || workspaces.roots[0],
      provider: blueprint.definition.model.backend,
      model: blueprint.definition.model.model,
      reasoningEffort: blueprint.definition.model.effort || null,
      blueprintId: blueprint.id,
      blueprintVersion: blueprint.version,
      blueprintVariables: parsed.data.variables
    }, {
      idempotencyKey,
      actor: "webhook",
      mcpActorId: null,
      workspaceOverride: parsed.data.workspace,
      modelOverride: parsed.data.model
    });
    const resource = webhookTriggerResource(operation, config.publicOrigin);
    res.setHeader("Location", resource.sessionUrl || resource.operationUrl);
    res.setHeader("Idempotency-Key", deliveryKey!.trim());
    if (resource.status === "queued") res.setHeader("Retry-After", "1");
    res.status(resource.status === "queued" ? 202 : 200).json(parseHttpResponse(req.method, req.path, resource));
  } catch (error) {
    if (error instanceof SessionOperationConflictError) {
      res.setHeader("Location", `/api/operations/${error.operation.id}`);
      next(httpError(error.message, 409, "IDEMPOTENCY_KEY_REUSED"));
      return;
    }
    next(blueprintHttpError(error));
  }
});
app.use(express.json({ limit: "256kb" }));
app.use("/api", (req, _res, next) => {
  try {
    req.body = parseHttpRequest(req.method, req.originalUrl, req.body);
    next();
  } catch (error) {
    next(new ValidationError(error instanceof Error ? error.message : "Request does not match the API contract", {
      code: "INVALID_REQUEST_CONTRACT",
      cause: error,
      scope: "api"
    }));
  }
});
app.use("/api", apiRateLimiter);

app.get("/api/auth", (req, res) => res.json({ authenticated: auth.isAuthenticated(req) }));
app.post("/api/login", (req, res, next) => {
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  const clientIdentity = config.trustProxy ? req.ip || req.socket.remoteAddress || "unknown" : req.socket.remoteAddress || "unknown";
  const result = auth.login(clientIdentity, token);
  if (!result.ok) {
    if (result.retryAfter) res.setHeader("Retry-After", result.retryAfter);
    const sessionLimit = result.reason === "session_limit";
    const rateLimited = result.reason === "rate_limited";
    next(httpError(
      sessionLimit ? "The maximum number of browser sessions is active. Log out another session or wait for it to expire."
        : rateLimited ? "Too many attempts. Try again later." : "Incorrect access key",
      sessionLimit || rateLimited ? 429 : 401,
      sessionLimit ? "SESSION_LIMIT" : rateLimited ? "RATE_LIMITED" : "INVALID_CREDENTIALS"
    ));
    return;
  }
  auth.setCookie(req, res, result.sessionId!);
  res.json({ ok: true });
});

app.post("/api/mcp/actors", mcpAccess.requireBootstrap, (req, res, next) => {
  try {
    assertObject(req.body, "Request body");
    assertAllowedKeys(req.body, ["clientId"]);
    const clientId = req.body.clientId === undefined ? undefined : mcpClientId(req.body.clientId);
    res.status(201).json(mcpAccess.registerActor(clientId));
  } catch (error) {
    next(error);
  }
});

app.get("/api/health", (_req, res) => {
  const runtime = publicRuntimeStatus();
  const monitor = { ...(externalMonitor?.getStatus() || {
    state: "starting" as const,
    available: false,
    lastPollAt: null,
    lastSuccessAt: null,
    lastError: null,
    trackedThreads: 0
  }), lastError: null };
  const storage = storageStatus();
  const background = backgroundTasks.getHealth();
  const degraded = !runtime.available || monitor.state === "degraded" || storage.status !== "ok" || background.status === "degraded";
  res.status(degraded ? 503 : 200).json({
    status: degraded ? "degraded" : "ok",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    subsystems: {
      api: { status: "ok" },
      codex: { status: runtime.available ? "ok" : "unavailable", ...runtime },
      externalMonitor: { status: monitor.available ? "ok" : monitor.state, ...monitor },
      workspaces: { status: "ok", roots: workspaces.roots.length },
      storage,
      background,
      sessions: {
        status: "ok",
        active: activeThreads.size,
        activeCodex: activeThreads.size,
        queuedMessages: [...messageQueues.values()].reduce((total, queue) => total + queue.length, 0),
        drainingQueues: drainingQueues.size,
        pendingArchives: archivingThreadIds.size,
        ttlHours: sessionTtlMs > 0 ? sessionTtlMs / 3_600_000 : null,
        sparkTtlHours: sparkTtlMs > 0 ? sparkTtlMs / 3_600_000 : null
      },
      events: { status: "ok", clients: sseClients.size },
      authentication: { status: "ok", enabled: auth.enabled, activeSessions: auth.activeSessionCount }
    }
  });
});

app.use("/api", (req, res, next) => {
  const actorId = mcpAccess.authenticateActor(req);
  if (!actorId) {
    auth.requireAuth(req, res, next);
    return;
  }
  res.locals.mcpActorId = actorId;
  if (!mcpRequestAllowed(req, actorId)) {
    next(new ValidationError("MCP agents have read-only access to user-created sessions", {
      code: "MCP_ACCESS_DENIED",
      status: 403,
      scope: "sessions"
    }));
    return;
  }
  next();
});
app.use("/events", auth.requireAuth);

app.post("/api/mcp/actors/current/rotate", (_req, res, next) => {
  try {
    const actorId = currentMcpActorId(res);
    res.json(mcpAccess.refreshActor(actorId));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/mcp/actors/current", async (req, res, next) => {
  try {
    assertObject(req.body, "Request body");
    assertAllowedKeys(req.body, ["releaseOwnership"]);
    if (req.body.releaseOwnership !== true) {
      throw httpError("MCP actor revocation requires releaseOwnership=true", 400, "MCP_REVOCATION_DISPOSITION_REQUIRED");
    }
    const actorId = currentMcpActorId(res);
    const owned = mcpAccess.listOwnedThreads(actorId);
    const releasedThreadIds = mcpAccess.revokeActor(actorId);
    await Promise.allSettled(owned.map((threadId) => sessions.record(
      threadId,
      "mcp_ownership_released",
      `mcp:${actorId}`,
      { reason: "actor_revoked" }
    )));
    res.json({ revoked: true, actorId, releasedThreadIds });
  } catch (error) {
    next(error);
  }
});

app.post("/api/mcp/handoffs", (_req, res, next) => {
  try {
    res.status(201).json(mcpAccess.createHandoff(currentMcpActorId(res)));
  } catch (error) {
    next(error);
  }
});

app.post("/api/mcp/owned-threads/handoff", async (req, res, next) => {
  try {
    assertObject(req.body, "Request body");
    assertAllowedKeys(req.body, ["handoffToken", "threadIds"]);
    const handoffToken = boundedString(req.body.handoffToken, "Handoff token", 256);
    const threadIds = parseThreadIds(req.body.threadIds, 50);
    const actorId = currentMcpActorId(res);
    let result: { targetActorId: string; threadIds: string[] };
    try {
      result = mcpAccess.handoffThreads(actorId, handoffToken, threadIds);
    } catch (error) {
      throw httpError(error instanceof Error ? error.message : "MCP ownership handoff failed", 409, "MCP_HANDOFF_FAILED");
    }
    await Promise.allSettled(result.threadIds.map((threadId) => sessions.record(
      threadId,
      "mcp_ownership_handed_off",
      `mcp:${actorId}`,
      { targetActor: `mcp:${result.targetActorId}` }
    )));
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/mcp/owned-threads/claim", async (req, res, next) => {
  try {
    assertObject(req.body, "Request body");
    assertAllowedKeys(req.body, ["threadIds"]);
    const threadIds = parseThreadIds(req.body.threadIds, 50);
    await Promise.all(threadIds.map(ensureSessionExists));
    const actorId = currentMcpActorId(res);
    const previousOwners = new Map(threadIds.map((threadId) => [threadId, mcpAccess.ownerForThread(threadId)]));
    const claimedThreadIds = mcpAccess.claimThreads(threadIds, actorId);
    inventoryIndex.invalidate();
    for (const threadId of claimedThreadIds) {
      broadcast("threads", { action: "updated", threadId, reason: "mcp_ownership_claimed" });
    }
    await Promise.allSettled(claimedThreadIds.map((threadId) => sessions.record(
      threadId,
      "mcp_ownership_claimed",
      `mcp:${actorId}`,
      { previousOwner: previousOwners.get(threadId) ? `mcp:${previousOwners.get(threadId)}` : "local" }
    )));
    res.json({ actorId, threadIds: claimedThreadIds });
  } catch (error) {
    next(error);
  }
});

app.get("/api/mcp/owned-threads", (_req, res) => {
  const actorId = currentMcpActorId(res);
  res.json({ actorId, data: mcpAccess.listOwnedThreads(actorId) });
});

app.get("/api/diagnostics/performance", (_req, res) => {
  res.json({
    routes: profiler.snapshot(),
    codex: codex.getMetrics(),
    capacity: capacity.metrics(),
    operations: { reads: readOperations.metrics(), mutations: mutationOperations.metrics() },
    sampledAt: Date.now()
  });
});

app.post("/api/logout", (req, res) => {
  auth.logout(req, res);
  res.json({ ok: true });
});

app.get("/api/bootstrap", async (req, res, next) => {
  try {
    const modelsResult = await Promise.allSettled([readModels()]);
    const errors = modelsResult
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => publicError(result.reason));
    errors.push(...backgroundTasks.getHealth().tasks.flatMap((task) => task.error ? [task.error] : []));
    sendRevisionedJson(req, res, {
      server: serverIdentity,
      version: packageVersion,
      health: publicHealthSummary(),
      models: modelsResult[0].status === "fulfilled" ? modelsResult[0].value : { data: [] },
      roots: workspaces.roots,
      background: backgroundTasks.getHealth(),
      degraded: errors.length > 0,
      errors
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/account/status", async (req, res, next) => {
  try {
    const core = await accountStatusCache.get(readAccountStatusCore);
    sendRevisionedJson(req, res, publicAccountStatus(core, typeof res.locals.mcpActorId !== "string"));
  } catch (error) {
    next(error);
  }
});

app.get("/api/usage", (req, res, next) => {
  try {
    const scopeType = optionalEnumQuery(req, "scopeType", ["run", "blueprint", "workspace"] as const);
    const scopeId = stringQuery(req, "scopeId");
    if ((scopeType && !scopeId) || (!scopeType && scopeId)) throw httpError("scopeType and scopeId must be provided together", 400, "INVALID_USAGE_SCOPE");
    const runId = stringQuery(req, "runId");
    const limit = numberQuery(req, "limit", 100, 1, 1_000);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      events: admission.events(limit, runId),
      estimates: admission.estimates(limit, runId),
      aggregate: scopeType && scopeId ? admission.usage(scopeType, scopeId) : null,
      budgets: scopeType && scopeId ? admission.listBudgets(scopeType, scopeId) : [],
      settings: admission.settings
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/budgets", (req, res, next) => {
  try {
    const scopeType = optionalEnumQuery(req, "scopeType", ["run", "blueprint", "workspace"] as const);
    const scopeId = stringQuery(req, "scopeId");
    res.setHeader("Cache-Control", "no-store");
    res.json({ data: admission.listBudgets(scopeType, scopeId) });
  } catch (error) {
    next(error);
  }
});

app.put("/api/budgets", async (req, res, next) => {
  try {
    const input = parseBudgetInput(req.body);
    if (!config.costCatalog && (
      input.softLimit?.estimatedCostMicros !== undefined
      || input.hardLimit?.estimatedCostMicros !== undefined
    )) {
      throw httpError("Estimated cost budgets require FORGEDECK_COST_CATALOG_JSON", 400, "COST_CATALOG_REQUIRED");
    }
    const scopeId = input.scopeType === "workspace" ? await workspaces.validate(input.scopeId) : input.scopeId;
    const budget = admission.setBudget({ ...input, scopeId });
    broadcast("admission", { action: "budget-updated", budget });
    wakeQueuedAdmissions();
    res.json({ budget });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/budgets", async (req, res, next) => {
  try {
    const scopeType = optionalEnumQuery(req, "scopeType", ["run", "blueprint", "workspace"] as const);
    const rawScopeId = stringQuery(req, "scopeId");
    if (!scopeType || !rawScopeId) throw httpError("scopeType and scopeId are required", 400, "INVALID_BUDGET_SCOPE");
    const scopeId = scopeType === "workspace" ? await workspaces.validate(rawScopeId) : rawScopeId;
    const removed = admission.removeBudget(scopeType, scopeId);
    if (!removed) throw httpError("Budget policy not found", 404, "BUDGET_NOT_FOUND");
    broadcast("admission", { action: "budget-removed", scopeType, scopeId });
    wakeQueuedAdmissions();
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/policies", (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(parseHttpResponse(req.method, req.path, { data: sessions.policies.list() }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/policies", (req, res, next) => {
  try {
    const updating = typeof req.body?.id === "string";
    const policy = sessions.policies.save(req.body);
    res.status(updating ? 200 : 201).json(parseHttpResponse(req.method, req.path, { policy }));
  } catch (error) {
    if (error instanceof PolicyNotFoundError) {
      next(httpError(error.message, 404, "POLICY_NOT_FOUND"));
      return;
    }
    next(error);
  }
});

app.delete("/api/policies", (req, res, next) => {
  try {
    if (!sessions.policies.remove(req.body.id)) throw httpError("Policy not found", 404, "POLICY_NOT_FOUND");
    res.json(parseHttpResponse(req.method, req.path, { ok: true }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/approvals", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ data: codex.listServerRequests() });
});

app.get("/api/queues", (req, res, next) => {
  try {
    const threadIds = threadIdsQuery(req, 100);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      data: Object.fromEntries(threadIds.map((threadId) => [threadId, messageQueues.get(threadId) || []]))
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/blueprints", (req, res, next) => {
  try {
    res.json({ data: sessions.blueprints.search(stringQuery(req, "search") || "", numberQuery(req, "limit", 50, 1, 200)) });
  } catch (error) {
    next(blueprintHttpError(error));
  }
});

app.post("/api/blueprints", (req, res, next) => {
  try {
    res.status(201).json({ blueprint: sessions.blueprints.create(req.body) });
  } catch (error) {
    next(blueprintHttpError(error));
  }
});

app.post("/api/blueprints/import", (req, res, next) => {
  try {
    res.status(201).json({ blueprint: sessions.blueprints.import(req.body) });
  } catch (error) {
    next(blueprintHttpError(error));
  }
});

app.get("/api/blueprints/:blueprintId/export", (req, res, next) => {
  try {
    const blueprint = sessions.blueprints.get(req.params.blueprintId, optionalPositiveIntegerQuery(req, "version"));
    if (!blueprint) throw httpError("Blueprint version not found", 404, "BLUEPRINT_NOT_FOUND");
    res.setHeader("Content-Disposition", `attachment; filename="${blueprint.id}-v${blueprint.version}.json"`);
    res.json(blueprint);
  } catch (error) {
    next(blueprintHttpError(error));
  }
});

app.get("/api/blueprints/:blueprintId/versions", (req, res, next) => {
  try {
    const data = sessions.blueprints.versions(req.params.blueprintId);
    if (!data.length) throw httpError("Blueprint not found", 404, "BLUEPRINT_NOT_FOUND");
    res.json({ data });
  } catch (error) {
    next(blueprintHttpError(error));
  }
});

app.post("/api/blueprints/:blueprintId/versions", (req, res, next) => {
  try {
    res.status(201).json({ blueprint: sessions.blueprints.createVersion(req.params.blueprintId, req.body) });
  } catch (error) {
    next(blueprintHttpError(error));
  }
});

app.get("/api/blueprints/:blueprintId", (req, res, next) => {
  try {
    const blueprint = sessions.blueprints.get(req.params.blueprintId, optionalPositiveIntegerQuery(req, "version"));
    if (!blueprint) throw httpError("Blueprint version not found", 404, "BLUEPRINT_NOT_FOUND");
    res.json({ blueprint });
  } catch (error) {
    next(blueprintHttpError(error));
  }
});

app.get("/api/schedules", (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(parseHttpResponse(req.method, req.path, {
      data: sessions.schedules.list(numberQuery(req, "historyLimit", 20, 1, 100))
    }));
  } catch (error) {
    next(scheduleHttpError(error));
  }
});

app.post("/api/schedules", (req, res, next) => {
  try {
    res.status(201).json(parseHttpResponse(req.method, req.path, { schedule: sessions.schedules.create(req.body) }));
  } catch (error) {
    next(scheduleHttpError(error));
  }
});

app.put("/api/schedules/:scheduleId", (req, res, next) => {
  try {
    res.json(parseHttpResponse(req.method, req.path, { schedule: sessions.schedules.update(req.params.scheduleId, req.body) }));
  } catch (error) {
    next(scheduleHttpError(error));
  }
});

app.delete("/api/schedules/:scheduleId", (req, res, next) => {
  try {
    if (!sessions.schedules.delete(req.params.scheduleId)) throw httpError("Schedule not found", 404, "SCHEDULE_NOT_FOUND");
    res.json(parseHttpResponse(req.method, req.path, { ok: true }));
  } catch (error) {
    next(scheduleHttpError(error));
  }
});

app.get("/api/missions", (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(parseHttpResponse(req.method, req.path, { data: sessions.missions.list() }));
  } catch (error) {
    next(missionHttpError(error));
  }
});

app.post("/api/missions", (req, res, next) => {
  try {
    const mission = sessions.missions.create(req.body);
    res.setHeader("Location", `/api/missions/${encodeURIComponent(mission.id)}`);
    res.status(201).json(parseHttpResponse(req.method, req.path, { mission }));
  } catch (error) {
    next(missionHttpError(error));
  }
});

app.get("/api/missions/:missionId", (req, res, next) => {
  try {
    const mission = sessions.missions.get(req.params.missionId, optionalPositiveIntegerQuery(req, "version"));
    if (!mission) throw httpError("Mission not found", 404, "MISSION_NOT_FOUND");
    res.setHeader("Cache-Control", "no-store");
    res.json(parseHttpResponse(req.method, req.path, { mission }));
  } catch (error) {
    next(missionHttpError(error));
  }
});

app.delete("/api/missions", (req, res, next) => {
  try {
    const bodyId = req.body && typeof req.body === "object" ? (req.body as { id?: unknown }).id : undefined;
    const id = stringQuery(req, "id") || (typeof bodyId === "string" ? bodyId : "");
    if (!id) throw httpError("Mission ID is required", 400, "INVALID_MISSION_ID");
    if (!sessions.missions.delete(id)) throw httpError("Mission not found", 404, "MISSION_NOT_FOUND");
    res.json(parseHttpResponse(req.method, req.path, { ok: true }));
  } catch (error) {
    next(missionHttpError(error));
  }
});

app.delete("/api/missions/:missionId", (req, res, next) => {
  try {
    if (!sessions.missions.delete(req.params.missionId)) throw httpError("Mission not found", 404, "MISSION_NOT_FOUND");
    res.json(parseHttpResponse(req.method, req.path, { ok: true }));
  } catch (error) {
    next(missionHttpError(error));
  }
});

app.post("/api/missions/:missionId/run", (req, res, next) => {
  try {
    const mission = sessions.missions.start(req.params.missionId, req.body ?? {});
    res.setHeader("Location", `/api/missions/${encodeURIComponent(mission.id)}`);
    res.setHeader("Retry-After", "1");
    res.status(202).json(parseHttpResponse(req.method, req.path, { mission }));
    void missionRunner.tick().catch((error) => logger.warn("Mission run could not be started", { missionId: mission.id, error }));
  } catch (error) {
    next(missionHttpError(error));
  }
});

app.get("/api/evals", (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(parseHttpResponse(req.method, req.path, {
      data: sessions.evals.list(numberQuery(req, "limit", 100, 1, 500))
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/evals", async (req, res, next) => {
  try {
    const input = evalRequestSchema.parse(req.body);
    const workspace = await workspaces.validate(input.workspace);
    await Promise.all(input.models.map((model) => validateModelChoice(model.model, model.reasoningEffort)));
    const evaluation = sessions.evals.create({ ...input, workspace });
    setImmediate(() => {
      void runEval(evaluation).catch((error) => {
        logger.error("Eval run failed", { evalId: evaluation.id, version: evaluation.version, error });
        try { sessions.evals.fail(evaluation.id, evaluation.version, error); } catch { /* preserve the runner error */ }
      });
    });
    res.setHeader("Location", `/api/evals/${evaluation.id}?version=${evaluation.version}`);
    res.setHeader("Retry-After", "1");
    res.status(202).json(parseHttpResponse(req.method, req.path, { eval: evaluation }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/evals/:evalId", (req, res, next) => {
  try {
    const evaluation = sessions.evals.get(validEvalId(req.params.evalId), optionalPositiveIntegerQuery(req, "version"));
    if (!evaluation) throw httpError("Eval not found", 404, "EVAL_NOT_FOUND");
    res.setHeader("Cache-Control", "no-store");
    if (evaluation.status === "queued" || evaluation.status === "running") res.setHeader("Retry-After", "1");
    res.json(parseHttpResponse(req.method, req.path, { eval: evaluation }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/compare", (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(parseHttpResponse(req.method, req.path, {
      data: sessions.comparisons.list(numberQuery(req, "limit", 100, 1, 500))
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/compare", async (req, res, next) => {
  try {
    const input = compareRequestSchema.parse(req.body);
    const workspace = await workspaces.validate(input.workspace);
    const models = input.judge ? [...input.models, input.judge] : input.models;
    await Promise.all(models.map((model) => validateModelChoice(model.model, model.reasoningEffort)));
    const comparison = sessions.comparisons.create({ ...input, workspace });
    setImmediate(() => {
      void runComparison(comparison).catch((error) => {
        logger.error("Comparison run failed", { comparisonId: comparison.id, error });
        try { sessions.comparisons.fail(comparison.id, error); } catch { /* preserve the runner error */ }
      });
    });
    res.setHeader("Location", `/api/compare/${comparison.id}`);
    res.setHeader("Retry-After", "1");
    res.status(202).json(parseHttpResponse(req.method, req.path, { comparison }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/compare/:comparisonId", (req, res, next) => {
  try {
    const comparison = sessions.comparisons.get(validComparisonId(req.params.comparisonId));
    if (!comparison) throw httpError("Comparison not found", 404, "COMPARISON_NOT_FOUND");
    res.setHeader("Cache-Control", "no-store");
    if (["queued", "running", "judging"].includes(comparison.status)) res.setHeader("Retry-After", "1");
    res.json(parseHttpResponse(req.method, req.path, { comparison }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/knowledge-packs", async (req, res, next) => {
  try {
    const rawWorkspace = stringQuery(req, "workspace");
    const workspace = rawWorkspace ? await workspaces.validate(rawWorkspace) : undefined;
    const scope = optionalEnumQuery(req, "scope", ["global", "workspace"] as const);
    res.setHeader("Cache-Control", "no-store");
    res.json(parseHttpResponse(req.method, req.path, {
      data: await sessions.knowledgePacks.list({ ...(workspace ? { workspace } : {}), ...(scope ? { scope } : {}) })
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/knowledge-packs", async (req, res, next) => {
  try {
    const input = knowledgePackRequestSchema.parse(req.body);
    const workspace = input.workspace ? await workspaces.validate(input.workspace) : null;
    const pack = await sessions.knowledgePacks.create({ ...input, workspace });
    res.status(201).json(parseHttpResponse(req.method, req.path, { pack }));
  } catch (error) {
    next(error instanceof KnowledgePackConflictError
      ? httpError(error.message, 409, "KNOWLEDGE_PACK_CONFLICT")
      : error);
  }
});

app.delete("/api/knowledge-packs", (req, res, next) => {
  try {
    const id = validKnowledgePackId(String(req.query.id || req.body?.id || ""));
    if (!sessions.knowledgePacks.remove(id)) throw httpError("Knowledge pack not found", 404, "KNOWLEDGE_PACK_NOT_FOUND");
    res.json(parseHttpResponse(req.method, req.path, { ok: true }));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/knowledge-packs/:packId", (req, res, next) => {
  try {
    const id = validKnowledgePackId(req.params.packId);
    if (!sessions.knowledgePacks.remove(id)) throw httpError("Knowledge pack not found", 404, "KNOWLEDGE_PACK_NOT_FOUND");
    res.json(parseHttpResponse(req.method, req.path, { ok: true }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/knowledge-packs/:packId/refresh", async (req, res, next) => {
  try {
    const pack = await sessions.knowledgePacks.refresh(validKnowledgePackId(req.params.packId));
    if (!pack) throw httpError("Knowledge pack not found", 404, "KNOWLEDGE_PACK_NOT_FOUND");
    res.json(parseHttpResponse(req.method, req.path, { pack }));
  } catch (error) {
    next(error);
  }
});

app.use(createWorkspaceRouter(workspaces, sessions));

app.get("/api/threads", async (req, res, next) => {
  try {
    const sessionClass = optionalEnumQuery(req, "sessionClass", ["standard", "spark"] as const)
      ?? optionalEnumQuery(req, "class", ["standard", "spark"] as const);
    const backend = optionalEnumQuery(req, "provider", ["codex"] as const)
      ?? optionalEnumQuery(req, "backend", ["codex"] as const);
    const limit = numberQuery(req, "limit", 100, 1, 200);
    const sortKey = enumQuery(req, "sortKey", ["created_at", "updated_at", "name", "directory", "status"] as const, "updated_at");
    const sortDirection = enumQuery(req, "sortDirection", ["asc", "desc"], "desc");
    const page = await inventoryIndex.query({
      cursor: stringQuery(req, "cursor"),
      limit,
      search: stringQuery(req, "search"),
      sortKey: sortKey as InventorySortKey,
      sortDirection,
      filters: {
        sessionClass,
        backend,
        status: optionalEnumQuery(req, "status", ["active", "idle", "error"] as const),
        model: stringQuery(req, "model"),
        workspace: stringQuery(req, "workspace"),
        label: stringQuery(req, "label"),
        queueState: optionalEnumQuery(req, "queueState", ["empty", "queued"] as const),
        owner: stringQuery(req, "owner"),
        source: optionalEnumQuery(req, "source", ["user", "mcp", "external"] as const),
        archiveState: enumQuery(req, "archiveState", ["active", "archived", "all"] as const, "active"),
        dateFrom: dateQuery(req, "dateFrom", false),
        dateTo: dateQuery(req, "dateTo", true),
        dateField: enumQuery(req, "dateField", ["created", "updated"] as const, "updated")
      }
    });
    res.setHeader("ETag", `W/"inventory-${page.revision}"`);
    res.setHeader("X-Inventory-Revision", page.revision);
    res.json(parseHttpResponse(req.method, req.path, page));
  } catch (error) {
    next(error);
  }
});

app.get("/api/archive", async (req, res, next) => {
  try {
    const threads = (await listAllSessions({}, {
      priority: "interactive",
      fairnessKey: "archive-view"
    }, true)).filter((thread) => thread.archiveState === "archived");
    const data = await Promise.all(threads.map(archiveEntry));
    data.sort((left, right) => right.archivedAt - left.archivedAt || left.id.localeCompare(right.id));
    res.setHeader("Cache-Control", "no-store");
    res.json(parseHttpResponse(req.method, req.path, {
      data,
      retention: {
        ttlHours: sessionTtlMs > 0 ? sessionTtlMs / 3_600_000 : null,
        sparkTtlHours: sparkTtlMs > 0 ? sparkTtlMs / 3_600_000 : null,
        archiveRetentionHours: config.metadataRetentionMs > 0 ? config.metadataRetentionMs / 3_600_000 : null
      }
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/threads", async (req, res, next) => {
  try {
    const mcpActorId = typeof res.locals.mcpActorId === "string" ? res.locals.mcpActorId : null;
    const actor = mcpActorId ? `mcp:${mcpActorId}` : "user";
    const idempotencyKey = requestIdempotencyKey(req);
    const { operation } = await acceptSessionCreation(req.body, { idempotencyKey, actor, mcpActorId });
    res.setHeader("Location", `/api/operations/${operation.id}`);
    res.setHeader("Idempotency-Key", operation.idempotencyKey);
    res.setHeader("Retry-After", "1");
    res.status(202).json(parseHttpResponse(req.method, req.path, { operation: operationResource(operation) }));
  } catch (error) {
    if (error instanceof SessionOperationConflictError) {
      res.setHeader("Location", `/api/operations/${error.operation.id}`);
      next(httpError(error.message, 409, "IDEMPOTENCY_KEY_REUSED"));
      return;
    }
    next(error);
  }
});

app.get("/api/operations/:operationId", (req, res, next) => {
  try {
    const operationId = validOperationId(req.params.operationId);
    const operation = sessions.getSessionOperation(operationId);
    if (!operation) throw httpError("Session operation not found", 404, "OPERATION_NOT_FOUND");
    res.setHeader("Cache-Control", "no-store");
    if (operation.status !== "succeeded" && operation.status !== "failed") res.setHeader("Retry-After", "1");
    res.json(parseHttpResponse(req.method, req.path, { operation: operationResource(operation) }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/threads/batch", async (req, res, next) => {
  try {
    assertObject(req.body, "Request body");
    assertAllowedKeys(req.body, ["operation", "threadIds", "tags", "category"]);
    const operation = enumBody(req.body.operation, ["read", "archive", "organize"] as const, "read");
    const threadIds = parseThreadIds(req.body.threadIds, operation === "read" ? 100 : 50);
    const batchIdempotencyKey = operation === "archive" ? requestIdempotencyKey(req) : null;
    const settled = await Promise.allSettled(threadIds.map(async (threadId) => {
      if (operation === "read") {
        liveRecovery.markViewed(threadId);
        return readSession(threadId, true);
      }
      if (operation === "archive") return archiveSession(
        threadId,
        "batch",
        "user",
        `archive:${crypto.createHash("sha256").update(`${batchIdempotencyKey}\0${threadId}`).digest("hex")}`
      );
      return sessions.withSession(threadId, async () => {
        await ensureSessionExists(threadId);
        return updateSessionMetadata(threadId, { tags: req.body.tags, category: req.body.category }, "user");
      });
    }));
    const results = settled.map((result, index) => result.status === "fulfilled"
      ? { threadId: threadIds[index], ok: true, value: result.value }
      : { threadId: threadIds[index], ok: false, error: publicError(result.reason) });
    res.status(results.some((result) => !result.ok) ? 207 : 200).json({ operation, results });
  } catch (error) {
    next(error);
  }
});

app.get("/api/threads/:threadId/history", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    const limit = numberQuery(req, "limit", 100, 1, 1_000);
    res.json({ data: await sessions.history(threadId, limit) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/sessions/:threadId/restore", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    const actor = requestAuditActor(res);
    const result = await restoreArchivedSession(threadId, actor);
    res.json(parseHttpResponse(req.method, req.path, result));
  } catch (error) {
    next(error);
  }
});

app.post("/api/sessions/:threadId/pin", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    const metadata = sessions.metadataFor(threadId);
    if (!sessions.hasMetadata(threadId) || metadata.archiveState !== "archived") {
      const archived = (await listCodexThreadsRaw(true, threadId)).some((thread) => thread.id === threadId);
      if (archived) await sessions.markArchived(threadId, inferredArchiveReason(threadId), "system", { discovered: true });
      else await ensureSessionExists(threadId);
    }
    const current = sessions.metadataFor(threadId);
    const pinned = typeof req.body?.pinned === "boolean" ? req.body.pinned : !current.pinned;
    const updated = await sessions.setPinned(threadId, pinned, requestAuditActor(res));
    inventoryIndex.invalidate();
    broadcast("threads", { action: "updated", threadId, reason: pinned ? "pinned" : "unpinned" });
    res.json(parseHttpResponse(req.method, req.path, { id: threadId, pinned: updated.pinned, ttlExempt: updated.pinned }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/sessions/:threadId/lease", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    assertObject(req.body, "Request body");
    assertAllowedKeys(req.body, ["mode"]);
    if (req.body.mode !== null && req.body.mode !== "read-only" && req.body.mode !== "exclusive") {
      throw httpError("Lease mode must be read-only, exclusive, or null to release", 400, "INVALID_WORKSPACE_LEASE_MODE");
    }
    await ensureSessionExists(threadId);
    const active = activeThreads.has(threadId);
    const current = sessions.workspaceLeaseForSession(threadId);
    if (active && (req.body.mode === null || (current && current.mode !== req.body.mode))) {
      throw httpError("An active session cannot release or change its workspace lease", 409, "WORKSPACE_LEASE_ACTIVE");
    }
    let lease = current;
    if (req.body.mode === null) {
      lease = sessions.releaseWorkspaceLease(threadId);
      await sessions.record(threadId, "workspace_lease_released", requestAuditActor(res), { source: "api" });
      lease = null;
    } else {
      const mode = req.body.mode as WorkspaceLeaseMode;
      lease = sessions.acquireWorkspaceLease(threadId, null, mode);
      try {
        await sessions.setWorkspaceLeaseMode(threadId, mode, requestAuditActor(res));
      } catch (error) {
        if (!current) sessions.releaseWorkspaceLease(threadId);
        else sessions.acquireWorkspaceLease(threadId, current.root, current.mode);
        throw error;
      }
      await sessions.record(threadId, "workspace_lease_acquired", requestAuditActor(res), { mode, root: lease.root, source: "api" });
    }
    const root = sessions.metadataFor(threadId).cwd;
    if (!root) throw httpError("This session has no workspace", 409, "WORKSPACE_REQUIRED");
    inventoryIndex.invalidate();
    broadcast("threads", { action: "updated", threadId, reason: lease ? "workspace_lease_acquired" : "workspace_lease_released" });
    res.json(parseHttpResponse(req.method, req.path, {
      lease,
      status: sessions.workspaceLeaseStatus(root)
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/threads/:threadId/recovery", (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    const state = liveRecovery.read(threadId);
    res.setHeader("Cache-Control", "no-store");
    res.json(parseHttpResponse(req.method, req.path, {
      revision: sseEventId,
      threadId,
      state,
      queue: messageQueues.get(threadId) || [],
      active: activeThreads.has(threadId)
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/sessions/:threadId/timeline", (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    const limit = numberQuery(req, "limit", 2_000, 1, 10_000);
    const events = sessions.timeline(threadId, limit + 1);
    const metadata = sessions.metadataFor(threadId);
    const visibleEvents = events.slice(Math.max(0, events.length - limit));
    const prompt = [...visibleEvents].reverse().find((event) => event.type === "prompt/submitted")?.payloadSummary.prompt;
    res.setHeader("Cache-Control", "no-store");
    res.json(parseHttpResponse(req.method, req.path, {
      session: {
        id: threadId,
        name: metadata.name || deriveSessionName(typeof prompt === "string" ? prompt : metadata.lastPrompt, threadId),
        model: metadata.model
      },
      events: visibleEvents.map((event) => ({
        id: event.id,
        revision: event.revision,
        threadId: event.threadId,
        type: event.type,
        timestamp: event.at,
        summary: event.summary,
        payloadSummary: event.payloadSummary,
        model: event.model,
        outcome: event.outcome,
        error: event.error,
        durationMs: event.durationMs
      })),
      truncated: events.length > limit
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/search", (req, res, next) => {
  try {
    const results = sessions.searchSessions({
      q: stringQuery(req, "q"),
      model: stringQuery(req, "model"),
      outcome: optionalEnumQuery(req, "outcome", ["success", "failed", "interrupted", "unknown"] as const),
      from: dateQuery(req, "from", false),
      to: dateQuery(req, "to", true),
      limit: numberQuery(req, "limit", 100, 1, 500)
    });
    res.setHeader("Cache-Control", "no-store");
    res.json(parseHttpResponse(req.method, req.path, {
      data: results.map((result) => ({
        ...result,
        startedAt: result.startedAt,
        completedAt: result.completedAt
      })),
      total: results.length
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/analytics", (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(parseHttpResponse(req.method, req.path, sessions.outcomeAnalytics()));
  } catch (error) {
    next(error);
  }
});

app.get("/api/sessions/:threadId/export", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    const format = typeof req.query.format === "string" ? req.query.format.toLocaleLowerCase("en-US") : "";
    if (format !== "json" && format !== "markdown") {
      throw httpError("Export format must be json or markdown", 400, "INVALID_EXPORT_FORMAT");
    }
    const thread = await readSession(threadId, true);
    const record = createSessionExport(thread, {
      metadata: { ...sessions.metadataFor(threadId) },
      artifacts: sessions.listArtifacts(threadId).map((artifact) => ({ ...artifact }))
    });
    const extension = format === "json" ? "json" : "md";
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", `attachment; filename="forgedeck-session-${threadId}.${extension}"`);
    if (format === "json") {
      res.type("application/json").send(`${JSON.stringify(parseHttpResponse(req.method, req.path, record), null, 2)}\n`);
      return;
    }
    res.type("text/markdown").send(sessionExportToMarkdown(record));
  } catch (error) {
    next(error);
  }
});

app.get("/api/sessions/:threadId/artifacts", (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    const artifacts = sessions.listArtifacts(threadId);
    if (!sessions.hasMetadata(threadId) && !artifacts.length) throw httpError("Session not found", 404, "SESSION_NOT_FOUND");
    res.setHeader("Cache-Control", "no-store");
    res.json(parseHttpResponse(req.method, req.path, {
      data: artifacts,
      completion: sessions.artifactStatus(threadId)
    }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/sessions/:threadId/artifacts", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    await ensureSessionExists(threadId);
    const metadata = sessions.metadataFor(threadId);
    const artifact = await sessions.createArtifact(threadId, req.body, {
      actor: requestAuditActor(res),
      source: typeof res.locals.mcpActorId === "string" ? "mcp" : "http",
      cwd: metadata.cwd
    });
    inventoryIndex.invalidate();
    await sessions.record(threadId, "artifact_published", requestAuditActor(res), {
      artifactId: artifact.id,
      artifactType: artifact.type,
      artifactName: artifact.name,
      validation: artifact.validation.status
    });
    broadcast("threads", { action: "updated", threadId, reason: "artifact_published" });
    res.status(201).json(parseHttpResponse(req.method, req.path, { artifact }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/artifacts/:artifactId", (req, res, next) => {
  try {
    if (!/^[a-f0-9-]{36}$/.test(req.params.artifactId)) throw httpError("Invalid artifact id", 400, "INVALID_ARTIFACT_ID");
    const artifact = sessions.artifactById(req.params.artifactId);
    if (!artifact) throw httpError("Artifact not found", 404, "ARTIFACT_NOT_FOUND");
    res.setHeader("Cache-Control", "no-store");
    res.json(parseHttpResponse(req.method, req.path, { artifact }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/sessions/:threadId/guardian", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    await ensureSessionExists(threadId);
    res.setHeader("Cache-Control", "no-store");
    res.json(parseHttpResponse(req.method, req.path, { guardian: guardian.get(threadId) }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/sessions/:threadId/guardian/retry", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    assertObject(req.body, "Request body");
    assertAllowedKeys(req.body, ["model"]);
    await ensureSessionExists(threadId);
    const state = await guardian.retryNow(threadId);
    res.json(parseHttpResponse(req.method, req.path, { guardian: state }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/sessions/:threadId/guardian/escalate", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    assertObject(req.body, "Request body");
    assertAllowedKeys(req.body, ["model"]);
    const requestedModel = req.body.model === undefined ? null : boundedString(req.body.model, "Escalation model", 128);
    await ensureSessionExists(threadId);
    const state = await guardian.escalateNow(threadId, requestedModel);
    res.json(parseHttpResponse(req.method, req.path, { guardian: state }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/events/revision", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(parseHttpResponse(req.method, req.path, { revision: sseEventId }));
});

app.put("/api/events/subscriptions/:clientId", (req, res, next) => {
  try {
    const sessionId = sseSessionId(req, res);
    const clientId = validSseClientId(req.params.clientId);
    assertObject(req.body, "Request body");
    assertAllowedKeys(req.body, ["threadIds"]);
    if (!Array.isArray(req.body.threadIds) || req.body.threadIds.length > MAX_SSE_THREAD_SUBSCRIPTIONS) {
      throw httpError(`threadIds must contain at most ${MAX_SSE_THREAD_SUBSCRIPTIONS} entries`, 400, "INVALID_SSE_SUBSCRIPTIONS");
    }
    const threadIds = [...new Set(req.body.threadIds.map((threadId) => validThreadId(String(threadId))))];
    const connected = sseClients.setSubscriptions(sessionId, clientId, threadIds);
    res.json(parseHttpResponse(req.method, req.path, { ok: true, connected, threadIds }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/threads/:threadId", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    liveRecovery.markViewed(threadId);
    res.json(parseHttpResponse(req.method, req.path, { thread: await readSession(threadId, true) }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/threads/:threadId/messages", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    const actor = requestAuditActor(res);
    const { text, model, effort, admissionPolicy, projection } = parseMessageInput(req.body);
    await validateModelChoice(model, effort);
    const result = await withThreadOperation(threadId, async () => {
      assertSessionNotArchiving(threadId);
      if (activeThreads.has(threadId)) {
        reconcileTurnCapacity(threadId);
        throw httpError("This session already has an active turn", 409, "SESSION_ACTIVE");
      }
      await enforceResumePolicy(threadId, { model, reasoningEffort: effort }, actor);
      claimBridgeThread(threadId);
      try {
        sessions.acquireWorkspaceLease(threadId);
        await sessions.setMetadata(threadId, { lastPrompt: text }, actor);
        await codexMutation("thread/resume", { threadId, model, excludeTurns: true }, 60_000);
        const prepared = await prepareKnowledgePackMessage(threadId, text);
        const started = await startTurn(threadId, prepared.text, model, effort, INTERACTIVE_CAPACITY_WAIT_MS, {}, admissionPolicy, projection);
        await markKnowledgePackMessageInjected(threadId, prepared.markInjected);
        guardian.beginRun(threadId);
        return started;
      } catch (error) {
        releaseTurnCapacity(threadId, false);
        releaseBridgeThread(threadId);
        throw error;
      }
    });
    res.status(202).json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/threads/:threadId/command", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    const command = requiredString(req.body?.command, "Command").toLowerCase();
    const args = optionalString(req.body?.args);
    if (command !== "archive") assertSessionNotArchiving(threadId);
    if (command === "compact") {
      res.json(await withMutableThreadOperation(threadId, () => codexMutation("thread/compact/start", { threadId }, 60_000)));
      return;
    }
    if (command === "stop") {
      res.json(await withMutableThreadOperation(threadId, async () => {
        const turnId = await findActiveTurnId(threadId);
        if (!turnId) throw httpError("This session has no active turn", 409);
        await sessions.record(threadId, "interrupt_requested", "user", { turnId });
        const result = await codexMutation("turn/interrupt", { threadId, turnId });
        clearCapacityRecovery(threadId);
        releaseTurnCapacity(threadId, true);
        return result;
      }));
      return;
    }
    if (command === "rename") {
      if (!args) throw httpError("Use /rename followed by a session name", 400);
      const name = args.slice(0, 100);
      const result = await withMutableThreadOperation(threadId, async () => {
        const response = await codexMutation("thread/name/set", { threadId, name });
        await sessions.record(threadId, "renamed", "user", { name });
        return response;
      });
      broadcast("threads", { action: "updated", threadId });
      res.json(result);
      return;
    }
    if (command === "archive") {
      res.status(202).json(await archiveSession(threadId, "command", "user", requestIdempotencyKey(req)));
      return;
    }
    if (command === "goal") {
      const operation = args?.toLowerCase();
      if (!args || operation === "view") {
        res.json(await withMutableThreadOperation(threadId, () => codexRead("thread/goal/get", { threadId })));
        return;
      }
      if (operation === "clear") {
        res.json(await withMutableThreadOperation(threadId, () => codexMutation("thread/goal/clear", { threadId })));
        return;
      }
      if (operation === "pause" || operation === "resume") {
        res.json(await withMutableThreadOperation(threadId, () => operation === "resume"
          ? activateSessionGoal(threadId, { threadId, status: "active" })
          : codexMutation("thread/goal/set", { threadId, status: "paused" })));
        return;
      }
      const objective = args.replace(/^set\s+/i, "").trim();
      if (!objective) throw httpError("Use /goal followed by an objective", 400);
      res.json(await withMutableThreadOperation(threadId, () => activateSessionGoal(threadId, { threadId, objective, status: "active" })));
      return;
    }
    throw httpError(`Unsupported ForgeDeck command: /${command}`, 400);
  } catch (error) {
    next(error);
  }
});

app.post("/api/threads/:threadId/queue", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    const actor = requestAuditActor(res);
    const { text, model, effort, admissionPolicy, projection } = parseMessageInput(req.body);
    await validateModelChoice(model, effort);
    const { entry, position } = await withThreadOperation(threadId, async () => {
      await ensureSessionExists(threadId);
      const queued: QueuedMessage = {
        id: crypto.randomUUID(), text, model, effort, createdAt: Date.now(), admissionPolicy, projection
      };
      const queue = messageQueues.get(threadId) || [];
      if (queue.length >= config.queueMaxMessages) throw httpError("This session's message queue is full", 409, "QUEUE_FULL");
      queue.push(queued);
      messageQueues.set(threadId, queue);
      persistMessageQueues();
      await sessions.record(threadId, "message_queued", actor, { queueId: queued.id, position: queue.length });
      broadcastQueue(threadId);
      return { entry: queued, position: queue.length };
    });
    void drainQueue(threadId);
    res.status(202).json({ queued: entry, position });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/threads/:threadId/queue/:queueId", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    if (!/^[a-f0-9-]{36}$/i.test(req.params.queueId)) throw httpError("Invalid queued message id", 400, "INVALID_QUEUE_ID");
    await withMutableThreadOperation(threadId, async () => {
      const queue = messageQueues.get(threadId) || [];
      const nextQueue = queue.filter((entry) => entry.id !== req.params.queueId);
      if (nextQueue.length === queue.length) throw httpError("Queued message not found", 404);
      if (nextQueue.length) messageQueues.set(threadId, nextQueue);
      else {
        messageQueues.delete(threadId);
        admissionPausedQueues.delete(threadId);
        const timer = admissionQueueTimers.get(threadId);
        if (timer) clearTimeout(timer);
        admissionQueueTimers.delete(threadId);
      }
      persistMessageQueues();
      await sessions.record(threadId, "queued_message_removed", "user", { queueId: req.params.queueId });
      broadcastQueue(threadId);
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/threads/:threadId/interrupt", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    const actor = requestAuditActor(res);
    assertSessionNotArchiving(threadId);
    const requestedTurnId = optionalBoundedString(req.body?.turnId, "Turn id", 128);
    if (requestedTurnId && !/^[a-zA-Z0-9_-]{1,128}$/.test(requestedTurnId)) throw httpError("Invalid turn id", 400, "INVALID_TURN_ID");
    res.json(await withMutableThreadOperation(threadId, async () => {
      const turnId = requestedTurnId || await findActiveTurnId(threadId);
      if (!turnId) throw httpError("This session has no active turn", 409);
      await sessions.record(threadId, "interrupt_requested", actor, { turnId });
      const result = await codexMutation("turn/interrupt", { threadId, turnId });
      clearCapacityRecovery(threadId);
      releaseTurnCapacity(threadId, true);
      return result;
    }));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/threads/:threadId/policy", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    const actor = requestAuditActor(res);
    assertSessionNotArchiving(threadId);
    assertObject(req.body, "Request body");
    assertAllowedKeys(req.body, ["yolo"]);
    if (typeof req.body.yolo !== "boolean") throw httpError("YOLO must be a boolean", 400, "INVALID_YOLO");
    const policy: ThreadPolicy = req.body.yolo ? "yolo" : "workspace-write";
    await withMutableThreadOperation(threadId, async () => {
      if (activeThreads.has(threadId) || await findActiveTurnId(threadId)) throw httpError("Stop or finish the current turn before changing permissions", 409);
      await codexMutation("thread/resume", { threadId, excludeTurns: true }, 60_000);
      await codexMutation("thread/settings/update", policy === "yolo" ? {
        threadId, approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }
      } : {
        threadId, approvalPolicy: "on-request", sandboxPolicy: {
          type: "workspaceWrite", writableRoots: [], networkAccess: false,
          excludeTmpdirEnvVar: false, excludeSlashTmp: false
        }
      });
      threadPolicies.set(threadId, policy);
      persistThreadPolicies();
      await sessions.record(threadId, "policy_changed", actor, { policy });
    });
    res.json({ policy });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/threads/:threadId", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    assertSessionNotArchiving(threadId);
    assertObject(req.body, "Request body");
    assertAllowedKeys(req.body, ["name", "tags", "category", "guardian"]);
    if (!("name" in req.body) && !("tags" in req.body) && !("category" in req.body) && !("guardian" in req.body)) throw httpError("At least one session field is required", 400);
    const guardianPolicy = "guardian" in req.body ? guardianPolicyFromRequest(req.body.guardian) : null;
    const result = await withMutableThreadOperation(threadId, async () => {
      await ensureSessionExists(threadId);
      let renameResult: unknown = { ok: true };
      if ("name" in req.body) {
        const name = boundedString(req.body.name, "Name", 100);
        renameResult = await codexMutation("thread/name/set", { threadId, name });
        await sessions.record(threadId, "renamed", "user", { name });
      }
      const metadata = ("tags" in req.body || "category" in req.body)
        ? updateSessionMetadata(threadId, { tags: req.body.tags, category: req.body.category }, "user")
        : sessions.metadataFor(threadId);
      const guardianState = guardianPolicy ? guardian.configure(threadId, guardianPolicy) : guardian.get(threadId);
      return { result: renameResult, ...metadata, guardian: guardianState };
    });
    broadcast("threads", { action: "updated", threadId });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/threads/:threadId", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    res.status(202).json(await archiveSession(threadId, "delete", requestAuditActor(res), requestIdempotencyKey(req)));
  } catch (error) {
    next(error);
  }
});

app.post("/api/approvals/:requestId", (req, res, next) => {
  try {
    const pending = codex.listServerRequests().find((request) => String(request.id) === req.params.requestId);
    if (!pending) throw httpError("That request is no longer pending", 404);
    const result = approvalResult(pending, req.body);
    codex.respondToServerRequest(pending.id, result);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/events", (req, res, next) => {
  let sessionId: string;
  let clientId: string;
  let threadIds: string[];
  try {
    sessionId = sseSessionId(req, res);
    clientId = typeof req.query.clientId === "string"
      ? validSseClientId(req.query.clientId)
      : `legacy-${crypto.randomUUID()}`;
    threadIds = sseThreadSubscriptions(req.query.threadId);
    if (!sseClients.canAccept(sessionId, clientId)) {
      next(httpError("Too many live event connections", 429, "SSE_CONNECTION_LIMIT"));
      return;
    }
  } catch (error) {
    next(error);
    return;
  }
  res.status(200);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders();
  const heartbeat = setInterval(() => writeSse(res, ": heartbeat\n\n"), 20_000);
  heartbeat.unref();
  sseClients.add(res, sessionId, heartbeat, clientId, threadIds);
  writeSse(res, formatRevisionedSseEvent("connected", { at: Date.now() }, sseEventId));
  res.on("error", () => closeSseClient(res));
  req.on("close", () => closeSseClient(res));
});

codex.on("notification", (payload) => {
  const notification = payload as { method: string; params?: Record<string, unknown> };
  if (notification.method === "account/rateLimits/updated") {
    accountStatusCache.clear();
    quotaCache.clear();
    void readProviderQuota().then(wakeQueuedAdmissions).catch((error) => {
      logger.debug("Could not refresh quota after provider update", { error });
    });
  }
  recordUsageNotification(notification);
  resumeGoalAfterCapacity(notification);
  recordLiveEvent(notification, "bridge");
  const outbound = canonicalActivityNotification(notification);
  if (outbound) broadcast("codex", outbound);
  if (notification.method === "turn/completed") {
    const threadId = typeof notification.params?.threadId === "string" ? notification.params.threadId : null;
    if (threadId) releaseBridgeThread(threadId);
  }
});
codex.on("serverRequest", (payload) => broadcast("approval", payload));
codex.on("serverRequestResolved", (payload) => broadcast("approval-resolved", payload));
codex.on("offline", (payload) => {
  inventoryIndex.invalidate();
  clearBridgeActivity();
  for (const threadId of [...capacityRecoveringThreads]) clearCapacityRecovery(threadId);
  capacity.releaseBackend("codex/standard");
  capacity.releaseBackend("codex/spark");
  externalMonitor?.emitCurrentStatuses();
  broadcast("runtime", {
    state: "offline",
    error: publicError(new BackendUnavailableError("Codex runtime is temporarily unavailable", {
      cause: payload,
      code: "CODEX_UNAVAILABLE",
      scope: "runtime",
      retryable: payload.willRetry,
      retryAfter: payload.willRetry ? 2 : undefined
    }))
  });
});
codex.on("ready", () => {
  inventoryIndex.invalidate();
  modelCache.clear();
  logger.info("Codex runtime connected", { runtime: codex.getStatus() });
  for (const session of codex.listSessions()) {
    if (session.state === "running") {
      setThreadActivity(session.threadId, "bridge", true);
      reconcileTurnCapacity(session.threadId);
      if (session.turnId) activeTurnIds.set(session.threadId, session.turnId);
    }
  }
  broadcast("runtime", { state: "ready" });
  void recoverCodexGuardianMonitoring();
  for (const threadId of messageQueues.keys()) void drainQueue(threadId);
});
codex.on("error", (error) => {
  logger.warn("Codex runtime unavailable", { error, runtime: codex.getStatus() });
  broadcast("runtime", {
    state: "error",
    error: publicError(new BackendUnavailableError("Codex runtime is temporarily unavailable", {
      cause: error,
      code: "CODEX_UNAVAILABLE",
      scope: "runtime",
      retryAfter: 2
    }))
  });
});
if (fs.existsSync(distDir)) {
  app.use("/assets", express.static(path.join(distDir, "assets"), { index: false, maxAge: "1y", immutable: true }));
  app.use(express.static(distDir, { index: false, maxAge: "1h", immutable: false }));
}
app.use((req, res, next) => {
  if (!["GET", "HEAD"].includes(req.method) || req.path.startsWith("/api/") || req.path === "/events") return next();
  const indexPath = path.join(distDir, "index.html");
  if (!fs.existsSync(indexPath)) {
    res.status(503).send("ForgeDeck client is not built. Run npm run build.");
    return;
  }
  res.sendFile(indexPath);
});

app.use("/api", (_req, _res, next) => {
  next(new NotFoundError("API endpoint not found", { code: "NOT_FOUND", scope: "api" }));
});

app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
  const normalized = publicError(error, {
    requestId: typeof res.locals.requestId === "string" ? res.locals.requestId : crypto.randomUUID(),
    scope: requestErrorScope(req.path),
    sessionId: requestSessionId(req)
  });
  if (normalized.retryAfter) res.setHeader("Retry-After", String(normalized.retryAfter));
  const context = { requestId: res.locals.requestId, method: req.method, path: req.path, status: normalized.status, error };
  if (normalized.status >= 500) logger.error("Request failed", context);
  else logger.warn("Request rejected", context);
  res.status(normalized.status).json({ error: normalized.message, ...normalized });
});

if (runtimeOptions.externalMonitor.enabled) externalMonitor = new ExternalCodexMonitor((notification, historical) => {
  const threadId = typeof notification.params.threadId === "string" ? notification.params.threadId : null;
  if (threadId && removedThreadIds.has(threadId)) return;
  const turn = notification.params.turn as { status?: unknown } | undefined;
  const deadProcess = notification.method === "turn/completed" && turn?.status === "interrupted";
  if (threadId && bridgeOwnedThreads.has(threadId) && !deadProcess) return;
  if (threadId && deadProcess) releaseBridgeThread(threadId);
  if (!historical) resumeGoalAfterCapacity(notification);
  recordLiveEvent(notification, "external");
  const outbound = canonicalActivityNotification(notification);
  if (outbound) broadcast("codex", outbound);
}, runtimeOptions.externalMonitor.codexHome, ({ threadIds, unavailableThreadIds: unavailable }) => {
  unavailableThreadIds = unavailable;
  reconcileSessionInventory(threadIds);
}, runtimeOptions.externalMonitor.monitor);
externalMonitor?.start();
const server = app.listen(port, host, () => {
  const addresses = listenAddresses(host, port);
  logger.info("ForgeDeck API listening", {
    addresses,
    publicOrigin: config.publicOrigin,
    lanExposureAcknowledged: config.allowLan,
    authenticationEnabled: auth.enabled,
    generatedAccessTokenPath: auth.generatedTokenPath,
    mcpBootstrapTokenPath: mcpAccess.bootstrapTokenPath,
    logLevel: logger.level
  });
});
resumeIncompleteSessionOperations();
scheduleRunner.start();
missionRunner.start();
void codex.start().then(resumeIncompleteSessionOperations).catch(() => undefined);
backgroundTasks.register({
  name: "session-expiry",
  safeFailureMessage: "Expired sessions could not be inspected",
  task: sweepExpiredSessions,
  intervalMs: 15 * 60_000,
  initialDelayMs: 30_000,
  maxAttempts: 3,
  retryBaseDelayMs: 1_000
});
backgroundTasks.register({
  name: "live-state-pruning",
  safeFailureMessage: "Old live session state could not be pruned",
  task: pruneLiveThreadStates,
  intervalMs: 10 * 60_000,
  initialDelayMs: 10 * 60_000,
  maxAttempts: 2
});
backgroundTasks.startAll();
guardian.start();

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("ForgeDeck shutting down", { signal });
    externalMonitor?.stop();
    backgroundTasks.stopAll();
    guardian.close();
    scheduleRunner.close();
    missionRunner.close();
    sessionOperationScheduler.close();
    removeInventoryMetadataListener();
    sessions.close();
    removeAuthInvalidationListener();
    mcpAccess.close();
    for (const timer of admissionQueueTimers.values()) clearTimeout(timer);
    admissionQueueTimers.clear();
    sseClients.closeAll();
    auth.close();
    const forceTimer = setTimeout(() => {
      logger.error("ForgeDeck graceful shutdown timed out", { timeoutMs: config.shutdownTimeoutMs });
      server.closeAllConnections();
      codex.stop();
      process.exitCode = 1;
    }, config.shutdownTimeoutMs);
    forceTimer.unref();
    server.close((error) => {
      clearTimeout(forceTimer);
      codex.stop();
      if (error) {
        logger.error("ForgeDeck HTTP server failed to close", { error });
        process.exitCode = 1;
      }
    });
    server.closeIdleConnections();
  });
}

async function startTurn(
  threadId: string,
  text: string,
  model: string,
  effort: string | null,
  capacityWaitMs = INTERACTIVE_CAPACITY_WAIT_MS,
  operationOptions: OperationOptions = {},
  admissionPolicy: DeclaredExhaustionPolicy | null = null,
  projection: AdmissionProjection | null = null
): Promise<unknown> {
  const policy = threadPolicies.get(threadId);
  const leaseMode = sessions.metadataFor(threadId).workspaceLeaseMode;
  const decision = await acquireTurnCapacity(threadId, capacityBackendForThread(threadId), capacityWaitMs, {
    model,
    policy: admissionPolicy,
    projection
  });
  const admittedModel = decision.target?.model || model;
  if (admittedModel !== model) {
    try {
      await validateModelChoice(admittedModel, effort);
    } catch (error) {
      releaseTurnCapacity(threadId, false);
      throw error;
    }
  }
  usageModelsByThread.set(threadId, admittedModel);
  let result: { turn?: { id?: string; status?: string } };
  try {
    result = await codexMutation<{ turn?: { id?: string; status?: string } }>("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      model: admittedModel,
      effort: effort || undefined,
      ...(leaseMode === "read-only" ? {
        sandboxPolicy: { type: "readOnly" }
      } : policy === "yolo" ? {
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" }
      } : {})
    }, 60_000, operationOptions);
  } catch (error) {
    observeProviderFailure(usageProviderForBackend(capacityBackendForThread(threadId)), error);
    releaseTurnCapacity(threadId, false);
    throw error;
  }
  setThreadActivity(threadId, "bridge", true);
  if (typeof result.turn?.id === "string") activeTurnIds.set(threadId, result.turn.id);
  recordAcceptedRequest(threadId, admittedModel, result.turn?.id || null);
  return { ...result, admission: publicAdmissionDecision(decision) };
}

async function activateSessionGoal(threadId: string, params: Record<string, unknown>): Promise<unknown> {
  sessions.acquireWorkspaceLease(threadId);
  try {
    return await codexMutation("thread/goal/set", params);
  } catch (error) {
    sessions.releaseWorkspaceLease(threadId);
    throw error;
  }
}

async function prepareKnowledgePackMessage(
  threadId: string,
  text: string
): Promise<{ text: string; markInjected: boolean }> {
  const metadata = sessions.metadataFor(threadId);
  if (metadata.knowledgeContextInjectedAt !== null || metadata.knowledgePackIds.length === 0) {
    return { text, markInjected: false };
  }
  const context = await sessions.knowledgePacks.contextForIds(metadata.knowledgePackIds);
  if (!context) return { text, markInjected: true };
  return {
    text: `${context}\n\n<user-request>\n${text}\n</user-request>`,
    markInjected: true
  };
}

async function markKnowledgePackMessageInjected(threadId: string, shouldMark: boolean): Promise<void> {
  if (!shouldMark) return;
  try {
    await sessions.markKnowledgeContextInjected(threadId);
  } catch (error) {
    logger.warn("Could not persist knowledge pack injection state", { threadId, error });
  }
}

async function drainQueue(threadId: string): Promise<void> {
  if (drainingQueues.has(threadId) || admissionPausedQueues.has(threadId) || archivingThreadIds.has(threadId) || !(messageQueues.get(threadId)?.length)) return;
  drainingQueues.add(threadId);
  let entry: QueuedMessage | undefined;
  try {
    await withMutableThreadOperation(threadId, async () => {
      const queueOptions = { priority: "background", fairnessKey: `message-queue:${threadId}` } as const;
      const snapshot = await codexRead<{ thread: ThreadSnapshot }>("thread/read", { threadId, includeTurns: true }, 60_000, queueOptions);
      knownThreadIds.add(threadId);
      const lastTurn = snapshot.thread.turns?.at(-1);
      if (snapshot.thread.status?.type === "active" || lastTurn?.status === "inProgress") {
        setThreadActivity(threadId, "bridge", true);
        reconcileTurnCapacity(threadId);
        if (lastTurn?.id) activeTurnIds.set(threadId, lastTurn.id);
        return;
      }
      setThreadActivity(threadId, "bridge", false);
      releaseTurnCapacity(threadId, true);
      const queue = messageQueues.get(threadId) || [];
      entry = queue[0];
      if (!entry) return;
      await enforceResumePolicy(threadId, { model: entry.model, reasoningEffort: entry.effort }, "queue");
      claimBridgeThread(threadId);
      await sessions.setMetadata(threadId, { lastPrompt: entry.text }, "system");
      await codexMutation("thread/resume", { threadId, model: entry.model, excludeTurns: true }, 60_000, queueOptions);
      const prepared = await prepareKnowledgePackMessage(threadId, entry.text);
      await startTurn(
        threadId,
        prepared.text,
        entry.model,
        entry.effort,
        QUEUE_CAPACITY_WAIT_MS,
        queueOptions,
        entry.admissionPolicy,
        entry.projection
      );
      await markKnowledgePackMessageInjected(threadId, prepared.markInjected);
      guardian.beginRun(threadId);
      queue.shift();
      if (queue.length) messageQueues.set(threadId, queue);
      else messageQueues.delete(threadId);
      persistMessageQueues();
      await sessions.record(threadId, "queued_message_started", "system", { queueId: entry.id });
      broadcastQueue(threadId);
    });
  } catch (error) {
    releaseTurnCapacity(threadId, false);
    releaseBridgeThread(threadId);
    scheduleAdmissionQueueRetry(threadId, error);
    if (entry) {
      broadcastQueue(threadId, error);
    }
    logger.warn("Could not start queued turn", { threadId, error });
  } finally {
    drainingQueues.delete(threadId);
  }
}

async function findActiveTurnId(threadId: string): Promise<string | null> {
  const snapshot = await codexRead<{ thread: ThreadSnapshot }>("thread/read", { threadId, includeTurns: true }, 60_000);
  knownThreadIds.add(threadId);
  const activeTurn = [...(snapshot.thread.turns || [])].reverse().find((turn) => turn.status === "inProgress")?.id || null;
  if (deadProcessThreadIds.has(threadId)) {
    setThreadActivity(threadId, "bridge", false);
    releaseTurnCapacity(threadId, true);
    return null;
  }
  const active = snapshot.thread.status?.type === "active" || Boolean(activeTurn);
  setThreadActivity(threadId, "bridge", active);
  if (active) reconcileTurnCapacity(threadId);
  else releaseTurnCapacity(threadId, true);
  if (activeTurn) activeTurnIds.set(threadId, activeTurn);
  return activeTurn;
}

type ThreadSnapshot = { status?: { type?: string }; turns?: Array<{ id?: string; status?: string }> };

function loadMessageQueues(): Map<string, QueuedMessage[]> {
  try {
    if (!fs.existsSync(queueFile)) return new Map();
    const parsed: unknown = JSON.parse(fs.readFileSync(queueFile, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    const queues = new Map<string, QueuedMessage[]>();
    for (const [threadId, value] of Object.entries(parsed)) {
      if (!/^[a-zA-Z0-9_-]{8,128}$/.test(threadId) || !Array.isArray(value)) continue;
      const entries = value.map(parseQueuedMessage).filter((entry): entry is QueuedMessage => entry !== null).slice(0, config.queueMaxMessages);
      if (entries.length) queues.set(threadId, entries);
    }
    return queues;
  } catch (error) {
    logger.warn("Ignoring invalid message queue file", { error });
    return new Map();
  }
}

function parseQueuedMessage(value: unknown): QueuedMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || !/^[a-f0-9-]{36}$/i.test(entry.id)) return null;
  if (typeof entry.text !== "string" || !entry.text.trim() || entry.text.length > 100_000) return null;
  if (typeof entry.model !== "string" || !/^[a-zA-Z0-9._:/-]{1,128}$/.test(entry.model)) return null;
  if (entry.effort !== null && (typeof entry.effort !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(entry.effort))) return null;
  if (typeof entry.createdAt !== "number" || !Number.isFinite(entry.createdAt) || entry.createdAt < 0) return null;
  let admissionPolicy: DeclaredExhaustionPolicy | null = null;
  let projection: AdmissionProjection | null = null;
  try {
    admissionPolicy = parseDeclaredAdmissionPolicy(entry.admissionPolicy);
    projection = parseAdmissionProjection(entry.projection);
  } catch {
    return null;
  }
  return {
    id: entry.id,
    text: entry.text,
    model: entry.model,
    effort: entry.effort as string | null,
    createdAt: entry.createdAt,
    admissionPolicy,
    projection
  };
}

function persistMessageQueues(): void {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const temporary = `${queueFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(Object.fromEntries(messageQueues), null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, queueFile);
}

function loadThreadPolicies(): Map<string, ThreadPolicy> {
  try {
    if (!fs.existsSync(policyFile)) return new Map();
    const parsed: unknown = JSON.parse(fs.readFileSync(policyFile, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    return new Map(Object.entries(parsed).filter((entry): entry is [string, ThreadPolicy] =>
      /^[a-zA-Z0-9_-]{8,128}$/.test(entry[0]) && (entry[1] === "workspace-write" || entry[1] === "yolo")
    ));
  } catch (error) {
    logger.warn("Ignoring invalid thread policy file", { error });
    return new Map();
  }
}

function persistThreadPolicies(): void {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const temporary = `${policyFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(Object.fromEntries(threadPolicies), null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, policyFile);
}

function broadcastQueue(threadId: string, error?: unknown): void {
  broadcast("queue", {
    threadId,
    queue: messageQueues.get(threadId) || [],
    error: error === undefined ? null : publicError(error, { scope: "sessions", sessionId: threadId })
  });
}

async function validateModelChoice(modelId: string, effort: string | null): Promise<void> {
  const response = await readModels();
  const model = response.data.find((item) => item.id === modelId || item.model === modelId);
  if (!model) throw httpError("That model is not available on this Codex account", 400);
  if (effort && !model.supportedReasoningEfforts.some((item) => item.reasoningEffort === effort)) {
    throw httpError("That reasoning level is not available for the selected model", 400);
  }
}

async function retryGuardianRun(threadId: string): Promise<void> {
  await submitGuardianRecovery(threadId, null);
}

async function escalateGuardianRun(threadId: string, requestedModel: string | null): Promise<string> {
  const metadata = sessions.metadataFor(threadId);
  const currentModel = metadata.model;
  if (!currentModel) throw new Error("The stalled session has no recorded model to escalate");
  const targetModel = selectStrongerModel(currentModel, (await readModels()).data
    .filter((model) => !metadata.effort || model.supportedReasoningEfforts.some((option) => option.reasoningEffort === metadata.effort))
    .map((model) => model.model), requestedModel);
  await submitGuardianRecovery(threadId, targetModel);
  return targetModel;
}

async function submitGuardianRecovery(threadId: string, targetModel: string | null): Promise<void> {
  await withMutableThreadOperation(threadId, async () => {
    const metadata = sessions.metadataFor(threadId);
    const prompt = metadata.lastPrompt;
    if (!prompt) throw new Error("The stalled session has no recorded message to retry");
    const model = targetModel || metadata.model;
    if (!model) throw new Error("The stalled session has no recorded model to retry");
    await enforceResumePolicy(threadId, { model, reasoningEffort: metadata.effort }, "guardian");

    await validateModelChoice(model, metadata.effort);
    const turnId = activeTurnIds.get(threadId) || await findActiveTurnId(threadId);
    if (turnId) {
      await sessions.record(threadId, "interrupt_requested", "guardian", { turnId, reason: "stalled" });
      await codexMutation("turn/interrupt", { threadId, turnId }, 30_000, {
        priority: "background",
        fairnessKey: `guardian:${threadId}`
      });
    }
    setThreadActivity(threadId, "bridge", false);
    setThreadActivity(threadId, "external", false);
    releaseTurnCapacity(threadId, true);
    if (targetModel) {
      await sessions.setMetadata(threadId, {
        model,
        ...(metadata.sessionClass === "spark" && model !== "gpt-5.3-codex-spark" ? { sessionClass: "standard" as const } : {})
      }, "guardian");
    }
    claimBridgeThread(threadId);
    try {
      await codexMutation("thread/goal/set", { threadId, status: "active" }, 30_000, {
        priority: "background",
        fairnessKey: `guardian:${threadId}`
      }).catch(() => undefined);
      await codexMutation("thread/resume", { threadId, model, excludeTurns: true }, 60_000, {
        priority: "background",
        fairnessKey: `guardian:${threadId}`
      });
      await startTurn(threadId, prompt, model, metadata.effort, QUEUE_CAPACITY_WAIT_MS, {
        priority: "background",
        fairnessKey: `guardian:${threadId}`
      });
    } catch (error) {
      releaseBridgeThread(threadId);
      throw error;
    }
    await sessions.record(threadId, targetModel ? "guardian_escalation_submitted" : "guardian_retry_submitted", "guardian", {
      backend: "codex",
      model
    });
  });
}

async function pauseGuardianRun(threadId: string): Promise<void> {
  await withMutableThreadOperation(threadId, async () => {
    const turnId = activeTurnIds.get(threadId) || await findActiveTurnId(threadId);
    if (turnId) await codexMutation("turn/interrupt", { threadId, turnId }, 30_000, {
      priority: "background",
      fairnessKey: `guardian:${threadId}`
    });
    await codexMutation("thread/goal/set", { threadId, status: "paused" }, 30_000, {
      priority: "background",
      fairnessKey: `guardian:${threadId}`
    }).catch(() => undefined);
    setThreadActivity(threadId, "bridge", false);
    setThreadActivity(threadId, "external", false);
    releaseTurnCapacity(threadId, true);
    await sessions.record(threadId, "guardian_operator_notified", "guardian", {
      reason: "recovery_attempts_exhausted",
      recoveryAttempts: 3
    });
  });
}

function guardianAuditDetails(state: RunGuardianState): Record<string, unknown> {
  return {
    phase: state.phase,
    active: state.active,
    recoveryAttempts: state.recoveryAttempts,
    maxRecoveryAttempts: state.maxRecoveryAttempts,
    actionModel: state.actionModel,
    stalledAt: state.stalledAt,
    operatorNotifiedAt: state.operatorNotifiedAt,
    error: state.error
  };
}

function capacityBackendForThread(threadId: string): CapacityBackend {
  return sessionClassFor(threadId) === "spark" ? "codex/spark" : "codex/standard";
}

async function acquireTurnCapacity(
  threadId: string,
  backend: CapacityBackend,
  waitMs: number,
  options: {
    model?: string;
    workspaceId?: string | null;
    blueprintId?: string | null;
    policy?: DeclaredExhaustionPolicy | null;
    projection?: AdmissionProjection | null;
  } = {}
): Promise<AdmissionDecision> {
  sessions.acquireWorkspaceLease(threadId);
  try {
    const provider = usageProviderForBackend(backend);
    await refreshProviderQuota(provider);
    const attribution = usageAttribution(threadId, options.model, options.workspaceId, options.blueprintId, provider);
    const decision = admission.reserve(threadId, {
      ...attribution,
      policy: options.policy,
      projection: options.projection || undefined
    });
    publishAdmissionDecision(threadId, decision);
    if (!decision.admitted) throw new AdmissionDeniedError(decision);
    if (decision.target && decision.target.provider !== provider) {
      admission.releaseReservation(threadId);
      throw new AdmissionDeniedError({ ...decision, admitted: false });
    }
    await capacity.acquire(backend, threadId, Date.now() + waitMs, requestOperationScope.getStore()?.signal);
    return decision;
  } catch (error) {
    admission.releaseReservation(threadId);
    sessions.releaseWorkspaceLease(threadId);
    throw error;
  }
}

function reconcileTurnCapacity(threadId: string): void {
  try {
    sessions.acquireWorkspaceLease(threadId);
  } catch (error) {
    logger.warn("An already-running session conflicts with an active workspace lease", { threadId, error });
    broadcast("threads", { action: "updated", threadId, reason: "workspace_lease_conflict", error: publicError(error) });
  }
  capacity.reconcile(capacityBackendForThread(threadId), threadId);
}

function releaseTurnCapacity(threadId: string, wakeQueues: boolean): void {
  admission.releaseReservation(threadId);
  if (capacityRecoveringThreads.has(threadId)) return;
  const releasedLease = sessions.releaseWorkspaceLease(threadId);
  if (releasedLease) broadcast("threads", { action: "updated", threadId, reason: "workspace_lease_released" });
  const backend = capacity.release(threadId);
  if (!backend || !wakeQueues) return;
  const timer = setTimeout(() => {
    for (const queuedThreadId of messageQueues.keys()) {
      if (capacityBackendForThread(queuedThreadId) === backend) void drainQueue(queuedThreadId);
    }
  }, 0);
  timer.unref();
}

function clearCapacityRecovery(threadId: string): void {
  capacityRecoveringThreads.delete(threadId);
  const timer = capacityRecoveryTimers.get(threadId);
  if (timer) clearTimeout(timer);
  capacityRecoveryTimers.delete(threadId);
}

function usageProviderForBackend(backend: CapacityBackend): UsageProvider {
  return backend === "codex/spark" ? "spark" : "codex";
}

function usageAttribution(
  threadId: string,
  modelOverride?: string,
  workspaceOverride?: string | null,
  blueprintOverride?: string | null,
  providerOverride?: UsageProvider
): UsageAttribution {
  const metadata = sessions.metadataFor(threadId);
  return {
    provider: providerOverride || (metadata.sessionClass === "spark" ? "spark" : "codex"),
    model: modelOverride || metadata.model || "unknown",
    runId: threadId,
    workspaceId: workspaceOverride === undefined ? metadata.cwd : workspaceOverride,
    blueprintId: blueprintOverride === undefined ? metadata.blueprintId : blueprintOverride
  };
}

function recordAcceptedRequest(threadId: string, model: string, providerRequestId: string | null, allowUnreserved = false): void {
  try {
    usageModelsByThread.set(threadId, model);
    const attribution = usageAttribution(threadId, model);
    const sourceEventId = providerRequestId ? `request:${attribution.provider}:${threadId}:${providerRequestId}` : null;
    const committed = admission.commitRequest(threadId, attribution, sourceEventId);
    if (!committed && allowUnreserved) admission.recordRequest(attribution, sourceEventId);
  } catch (error) {
    logger.warn("Could not persist accepted provider request usage", { threadId, model, error });
  }
}

function recordUsageNotification(notification: { method: string; params?: Record<string, unknown> }): void {
  if (notification.method !== "thread/tokenUsage/updated") return;
  const threadId = typeof notification.params?.threadId === "string" ? notification.params.threadId : null;
  const tokenUsage = notification.params?.tokenUsage;
  const total = tokenUsage && typeof tokenUsage === "object" && !Array.isArray(tokenUsage)
    ? (tokenUsage as Record<string, unknown>).total
    : null;
  const tokens = normalizeTokenSnapshot(total);
  if (!threadId || !tokens) return;
  try {
    admission.recordTokenSnapshot(usageAttribution(threadId, usageModelsByThread.get(threadId)), tokens);
  } catch (error) {
    logger.warn("Could not persist normalized token usage", { threadId, error });
  }
}

function observeProviderFailure(provider: UsageProvider, error: unknown): void {
  const retryAfter = retryAfterSecondsFromError(error);
  const text = `${error instanceof Error ? error.message : ""} ${safeStringify(error)}`;
  if (retryAfter !== null && /(?:rate.?limit|quota|retry.?after|too many requests|\b429\b)/i.test(text)) {
    admission.observeRetryAfter(provider, retryAfter, publicError(error));
  }
}

function safeStringify(value: unknown): string {
  try { return JSON.stringify(value) || ""; } catch { return ""; }
}

function publicAdmissionDecision(decision: AdmissionDecision) {
  return {
    action: decision.action,
    alerts: decision.alerts,
    retryAt: decision.retryAt,
    target: decision.target
  };
}

function publishAdmissionDecision(threadId: string, decision: AdmissionDecision): void {
  if (!decision.alerts.length && decision.action === "admit") return;
  broadcast("admission", { threadId, decision: publicAdmissionDecision(decision) });
}

function scheduleAdmissionQueueRetry(threadId: string, error: unknown): void {
  if (error instanceof AdmissionDeniedError) {
    if (error.decision.action !== "wait" || error.decision.retryAt === null) {
      admissionPausedQueues.add(threadId);
      return;
    }
  }
  const retryAt = error instanceof AdmissionDeniedError
    ? error.decision.action === "wait" ? error.decision.retryAt : null
    : (() => {
        const retryAfter = retryAfterSecondsFromError(error);
        return retryAfter === null ? null : Date.now() + retryAfter * 1_000;
      })();
  if (retryAt === null) return;
  const previous = admissionQueueTimers.get(threadId);
  if (previous) clearTimeout(previous);
  const delayMs = Math.max(1, Math.min(2_147_483_647, retryAt - Date.now()));
  const timer = setTimeout(() => {
    admissionQueueTimers.delete(threadId);
    void drainQueue(threadId);
  }, delayMs);
  timer.unref();
  admissionQueueTimers.set(threadId, timer);
}

function wakeQueuedAdmissions(): void {
  for (const timer of admissionQueueTimers.values()) clearTimeout(timer);
  admissionQueueTimers.clear();
  admissionPausedQueues.clear();
  for (const threadId of messageQueues.keys()) void drainQueue(threadId);
}

function readModels(): Promise<ModelListResponse> {
  return modelCache.get(() => codexRead<ModelListResponse>("model/list", { limit: 100, includeHidden: false }));
}

async function readAccountStatusCore(): Promise<AccountStatusCore> {
  const results = await Promise.allSettled([
    codexRead("account/read", { refreshToken: false }),
    readProviderQuota(),
    readModels()
  ]);
  const [accountResult, usageResult, modelsResult] = results;
  return {
    account: accountResult.status === "fulfilled" ? accountResult.value : null,
    usage: usageResult.status === "fulfilled" ? usageResult.value : null,
    models: modelsResult.status === "fulfilled" ? modelsResult.value : { data: [] },
    errors: results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason)
  };
}

async function readProviderQuota(): Promise<UsageResponse> {
  return quotaCache.get(async () => {
    const usage = await codexRead<UsageResponse>("account/rateLimits/read");
    observeQuotaUsage(usage);
    return usage;
  });
}

async function refreshProviderQuota(provider: UsageProvider): Promise<void> {
  try {
    await readProviderQuota();
  } catch (error) {
    logger.debug("Provider quota could not be refreshed before admission", { provider, error });
  }
}

function observeQuotaUsage(usage: UsageResponse): void {
  const byLimitId = usage.rateLimitsByLimitId ?? {};
  const codexRateLimit = byLimitId.codex ?? usage.rateLimits ?? null;
  const sparkRateLimit = Object.values(byLimitId).find((entry) => {
    const candidate = entry as Record<string, unknown>;
    return typeof candidate.limitName === "string" && /spark|5\.3|gpt-5-3/i.test(candidate.limitName);
  }) ?? null;
  const standardRateLimit = byLimitId.codex && byLimitId.codex !== sparkRateLimit ? byLimitId.codex : codexRateLimit;
  const observedAt = Date.now();
  for (const snapshot of normalizeRateLimitSnapshots("codex", standardRateLimit, observedAt)) admission.observeQuota(snapshot);
  for (const snapshot of normalizeRateLimitSnapshots("spark", sparkRateLimit || codexRateLimit, observedAt)) admission.observeQuota(snapshot);
}

function publicAccountStatus(core: AccountStatusCore, includeEmail: boolean) {
  const errors = [
    ...core.errors.map((error) => publicError(error)),
    ...backgroundTasks.getHealth().tasks.flatMap((task) => task.error ? [task.error] : [])
  ];
  const byLimitId = core.usage?.rateLimitsByLimitId ?? {};
  const codexRateLimit = byLimitId.codex ?? core.usage?.rateLimits ?? null;
  const sparkRateLimit = Object.values(byLimitId).find((entry) => {
    const candidate = entry as Record<string, unknown>;
    return typeof candidate.limitName === "string" && /spark|5\.3|gpt-5-3/i.test(candidate.limitName);
  }) ?? null;
  const standardRateLimit = byLimitId.codex && byLimitId.codex !== sparkRateLimit ? byLimitId.codex : codexRateLimit;
  const sparkActiveThreadIds = [...activeThreads].filter((threadId) => sessionClassFor(threadId) === "spark");
  const activeThreadIds = [...activeThreads];
  const agentThreadIds = mcpAccess.listAgentThreads();
  const sparkAgentThreadIds = agentThreadIds.filter((threadId) => sessionClassFor(threadId) === "spark");
  return {
    account: core.account === null
      ? { account: null, requiresOpenaiAuth: true }
      : publicAccount(core.account, includeEmail),
    usage: core.usage,
    backendStatus: {
      codex: {
        available: core.models.data.length > 0,
        rateLimit: standardRateLimit,
        activeCount: activeThreads.size - sparkActiveThreadIds.length
      },
      spark: {
        available: core.models.data.some((model) => model.id === "gpt-5.3-codex-spark" || model.model === "gpt-5.3-codex-spark"),
        rateLimit: sparkRateLimit,
        activeCount: sparkActiveThreadIds.length
      }
    },
    runtime: publicRuntimeStatus(),
    activeThreadIds,
    agentThreadIds,
    sparkAgentThreadIds,
    sparkActiveThreadIds,
    admission: { settings: admission.settings },
    degraded: errors.length > 0,
    errors
  };
}

function publicHealthSummary() {
  const runtime = publicRuntimeStatus();
  const storage = storageStatus();
  const background = backgroundTasks.getHealth();
  return {
    status: runtime.available && storage.status === "ok" && background.status !== "degraded" ? "ok" as const : "degraded" as const,
    runtime,
    storage,
    background
  };
}

function sendRevisionedJson(req: Request, res: Response, value: unknown): void {
  const revision = jsonRevision(value);
  res.set({
    "Cache-Control": "private, max-age=0, must-revalidate",
    ETag: revision.etag,
    "X-Resource-Revision": revision.etag,
    "Content-Type": "application/json; charset=utf-8"
  });
  res.vary("Cookie");
  res.vary("Authorization");
  if (matchesIfNoneMatch(req.headers["if-none-match"], revision.etag)) {
    res.status(304).end();
    return;
  }
  res.send(revision.body);
}

function publicRuntimeStatus(): ReturnType<CodexBridge["getStatus"]> {
  return { ...codex.getStatus(), lastError: null };
}

function publicAccount(value: unknown, includeEmail: boolean): { account: Record<string, unknown> | null; requiresOpenaiAuth: boolean } {
  const response = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rawAccount = response.account && typeof response.account === "object" ? response.account as Record<string, unknown> : null;
  const account = rawAccount ? {
    type: typeof rawAccount.type === "string" ? rawAccount.type : "unknown",
    planType: typeof rawAccount.planType === "string" ? rawAccount.planType : undefined,
    ...(includeEmail && typeof rawAccount.email === "string" ? { email: rawAccount.email } : {})
  } : null;
  return { account, requiresOpenaiAuth: response.requiresOpenaiAuth === true };
}

function approvalResult(request: ServerRequest, body: unknown): unknown {
  const value = body as { decision?: string; result?: unknown };
  if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval") {
    const allowed = new Set(["accept", "acceptForSession", "decline", "cancel"]);
    if (!value || !allowed.has(value.decision || "")) throw httpError("Invalid approval decision", 400);
    return { decision: value.decision };
  }
  if (request.method === "item/tool/requestUserInput") {
    const result = value?.result as { answers?: Record<string, { answers?: unknown }> } | undefined;
    if (!result?.answers || typeof result.answers !== "object") throw httpError("Answers are required", 400);
    for (const answer of Object.values(result.answers)) {
      if (!answer || !Array.isArray(answer.answers) || !answer.answers.every((item) => typeof item === "string")) {
        throw httpError("Invalid answer payload", 400);
      }
    }
    return result;
  }
  if (value && typeof value.result === "object" && value.result !== null) return value.result;
  throw httpError("This request needs a structured response that ForgeDeck cannot infer", 400);
}

function broadcast(event: string, payload: unknown): void {
  if (event === "threads" || event === "queue") inventoryIndex.invalidate();
  // Advance before applying byte limits so a dropped event creates an observable
  // sequence gap and forces clients back to an authoritative recovery snapshot.
  const threadId = eventThreadId(payload);
  let eventId: number;
  if (threadId) {
    try {
      eventId = sessions.recordNextTimelineEvent(threadId, event, payload);
    } catch (error) {
      eventId = sessions.nextTimelineRevision();
      logger.warn("Could not persist session timeline event", { event, eventId, threadId, error });
    }
  } else {
    eventId = sessions.nextTimelineRevision();
  }
  sseEventId = eventId;
  const message = formatRevisionedSseEvent(event, payload, eventId, threadId);
  const bytes = Buffer.byteLength(message);
  if (bytes > config.sseEventMaxBytes) {
    logger.warn("Dropped oversized SSE event", { event, bytes });
    return;
  }
  if (pendingSseBytes + bytes > MAX_PENDING_SSE_BYTES) {
    logger.warn("Dropped SSE event because the fan-out queue is full", { event, bytes, pendingSseBytes });
    return;
  }
  pendingSseMessages.push({ message, subscriptionThreadId: sseSubscriptionThreadId(event, payload, threadId) });
  pendingSseBytes += bytes;
  if (sseFlushScheduled) return;
  sseFlushScheduled = true;
  queueMicrotask(flushSseFanout);
}

function eventThreadId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.threadId === "string") return record.threadId;
  const params = record.params;
  return params && typeof params === "object" && !Array.isArray(params) && typeof (params as Record<string, unknown>).threadId === "string"
    ? String((params as Record<string, unknown>).threadId)
    : null;
}

function sseSubscriptionThreadId(event: string, payload: unknown, threadId: string | null): string | null {
  if (event === "threads" && payload && typeof payload === "object" && !Array.isArray(payload)) {
    const action = (payload as Record<string, unknown>).action;
    if (action === "created") return null;
  }
  return threadId;
}

function publishBackgroundHealth(report: BackgroundHealthReport): void {
  const signature = JSON.stringify(report.tasks.map((task) => ({
    name: task.name,
    status: task.status,
    requestId: task.error?.requestId || null
  })));
  if (signature === backgroundHealthSignature) return;
  backgroundHealthSignature = signature;
  broadcast("health", report);
}

function writeSse(client: Response, message: string): void {
  try {
    if (client.write(message)) return;
  } catch (error) {
    logger.debug("SSE client write failed", { error });
  }
  closeSseClient(client);
}

function flushSseFanout(): void {
  sseFlushScheduled = false;
  if (!pendingSseMessages.length) return;
  const messages = pendingSseMessages.splice(0);
  pendingSseBytes = 0;
  const batches = new Map<Response, string[]>();
  for (const { message, subscriptionThreadId } of messages) {
    for (const client of sseClients.responses(subscriptionThreadId)) {
      const batch = batches.get(client) || [];
      batch.push(message);
      batches.set(client, batch);
    }
  }
  for (const [client, batch] of batches) writeSse(client, batch.join(""));
}

function closeSseClient(response: Response): void {
  sseClients.close(response);
}

function recordLiveEvent(notification: { method: string; params?: Record<string, unknown> }, source: ActivitySource): void {
  if (/^(thread|turn)\//.test(notification.method) && !notification.method.endsWith("/delta")) inventoryIndex.invalidate();
  const params = notification.params;
  const threadId = typeof params?.threadId === "string" ? params.threadId : null;
  if (!threadId) return;
  if (sessions.hasMetadata(threadId) && guardianProgressNotification(notification.method)) {
    guardian.activate(threadId);
    guardian.activity(threadId, true);
  }
  if (notification.method === "turn/started") {
    deadProcessThreadIds.delete(threadId);
    setThreadActivity(threadId, source, true);
    clearCapacityRecovery(threadId);
    reconcileTurnCapacity(threadId);
    guardian.activity(threadId, false);
    const turn = params?.turn as { id?: unknown } | undefined;
    if (typeof turn?.id === "string") activeTurnIds.set(threadId, turn.id);
    recordAcceptedRequest(
      threadId,
      usageModelsByThread.get(threadId) || sessions.metadataFor(threadId).model || "unknown",
      typeof turn?.id === "string" ? turn.id : null,
      true
    );
    void sessions.record(threadId, "turn_started", source, typeof turn?.id === "string" ? { turnId: turn.id } : undefined);
  }
  if (notification.method === "turn/completed") {
    guardian.complete(threadId);
    setThreadActivity(threadId, source, false);
    releaseTurnCapacity(threadId, true);
    const turn = params?.turn as { id?: unknown; status?: unknown } | undefined;
    if (source === "external" && turn?.status === "interrupted") deadProcessThreadIds.add(threadId);
    void sessions.record(threadId, "turn_completed", source, {
      ...(typeof turn?.id === "string" ? { turnId: turn.id } : {}),
      ...(typeof turn?.status === "string" ? { status: turn.status } : {})
    });
    setTimeout(() => {
      const completion = sessions.artifactStatus(threadId);
      if (completion.status === "pending") {
        void sessions.record(threadId, "completion_gates_unmet", "system", {
          unmetGates: completion.unmetGates.map((gate) => gate.name)
        });
        inventoryIndex.invalidate();
        broadcast("threads", { action: "updated", threadId, reason: "completion_gates_unmet" });
      }
    }, 100).unref();
    setTimeout(() => void drainQueue(threadId), 50).unref();
  }
  if (notification.method === "thread/status/changed") {
    const status = params?.status as { type?: string } | undefined;
    setThreadActivity(threadId, source, status?.type === "active");
    if (status?.type === "active") guardian.activity(threadId, false);
    if (status?.type !== "active") {
      if (!activeThreads.has(threadId)) {
        releaseTurnCapacity(threadId, true);
        guardian.complete(threadId);
      }
      setTimeout(() => void drainQueue(threadId), 50).unref();
    }
  }
  if (notification.method === "thread/unarchived") {
    removedThreadIds.delete(threadId);
    unavailableThreadIds.delete(threadId);
    void sessions.markRestored(threadId, "codex").then(() => {
      inventoryIndex.invalidate();
      broadcast("threads", { action: "updated", threadId, reason: "restored" });
    }).catch((error) => logger.warn("Could not restore unarchived session metadata", { threadId, error }));
  }
  if (notification.method === "thread/deleted" || notification.method === "thread/archived") {
    if (!archivingThreadIds.has(threadId)) {
      const archived = notification.method === "thread/archived";
      void (async () => {
        if (archived) await sessions.markArchived(threadId, "manual", "codex", { source: "notification" });
        await cleanupSessionTraces(threadId, "codex_notification", "codex", false, archived);
      })().catch((error) => logger.warn("Could not clean archived session state", { threadId, error }));
    }
    return;
  }

  if (notification.method === "item/completed" && params?.item && typeof params.item === "object" && !Array.isArray(params.item)) {
    const item = params.item as Record<string, unknown>;
    if (typeof item.id === "string") {
      void sessions.persistCanonicalItem(threadId, item)
        .catch((error) => logger.warn("Could not persist canonical session item", { threadId, itemId: item.id, error }));
      void sessions.captureArtifactItem(threadId, item).then((artifacts) => {
        if (!artifacts.length) return;
        inventoryIndex.invalidate();
        broadcast("threads", { action: "updated", threadId, reason: "artifacts_captured" });
      }).catch((error) => logger.warn("Could not capture typed artifacts", { threadId, itemId: item.id, error }));
    }
  }

  liveRecovery.record(notification, activeThreads.has(threadId));
}

function setThreadActivity(threadId: string, source: ActivitySource, active: boolean): void {
  const sources = activeThreadSources.get(threadId) || new Set<ActivitySource>();
  if (active) sources.add(source);
  else sources.delete(source);
  if (sources.size) {
    activeThreadSources.set(threadId, sources);
    activeThreads.add(threadId);
    if (sessions.hasMetadata(threadId)) guardian.activate(threadId);
  } else {
    activeThreadSources.delete(threadId);
    activeThreads.delete(threadId);
    activeTurnIds.delete(threadId);
  }
}

function guardianProgressNotification(method: string): boolean {
  return method === "thread/tokenUsage/updated"
    || method === "item/started"
    || method === "item/completed"
    || method.endsWith("/delta")
    || method.endsWith("/outputDelta");
}

function canonicalActivityNotification(notification: { method: string; params?: Record<string, unknown> }): { method: string; params?: Record<string, unknown> } | null {
  const threadId = typeof notification.params?.threadId === "string" ? notification.params.threadId : null;
  if (!threadId) return notification;
  if (notification.method === "turn/completed" && activeThreads.has(threadId)) return null;
  if (notification.method !== "thread/status/changed") return notification;
  return {
    ...notification,
    params: {
      ...notification.params,
      status: activeThreads.has(threadId) ? { type: "active", activeFlags: [] } : notification.params?.status
    }
  };
}

function resumeGoalAfterCapacity(notification: { method: string; params?: Record<string, unknown> }): void {
  const threadId = typeof notification.params?.threadId === "string" ? notification.params.threadId : null;
  if (!threadId) return;
  if (notification.method === "turn/started") {
    capacityBuffers.delete(threadId);
    capacityHandledThreads.delete(threadId);
  }
  if (capacityHandledThreads.has(threadId)) return;
  const strings = collectStrings(notification).join(" ");
  const previous = capacityBuffers.get(threadId) || "";
  const combined = `${previous} ${strings}`.slice(-1_000);
  capacityBuffers.set(threadId, combined);
  if (!combined.toLowerCase().includes("selected model is at capacity. please try a different model.")) return;
  capacityHandledThreads.add(threadId);
  capacityBuffers.delete(threadId);
  void resumeGoalWithCapacity(threadId);
}

async function resumeGoalWithCapacity(threadId: string): Promise<void> {
  capacityRecoveringThreads.add(threadId);
  try {
    await acquireTurnCapacity(threadId, capacityBackendForThread(threadId), INTERACTIVE_CAPACITY_WAIT_MS);
  } catch (error) {
    clearCapacityRecovery(threadId);
    logger.warn("Could not reserve capacity to resume session goal", { threadId, error });
    return;
  }

  const timer = setTimeout(() => {
    clearCapacityRecovery(threadId);
    releaseTurnCapacity(threadId, true);
    logger.warn("Released goal recovery capacity because no turn started before the deadline", { threadId });
  }, RECOVERY_START_DEADLINE_MS);
  timer.unref();
  capacityRecoveryTimers.set(threadId, timer);
  try {
    await codexMutation("thread/goal/set", { threadId, status: "active" });
    logger.info("Resumed session goal after model-capacity error", { threadId });
  } catch (error) {
    clearCapacityRecovery(threadId);
    releaseTurnCapacity(threadId, true);
    logger.warn("Could not resume session goal after model-capacity error", { threadId, error });
  }
}

function collectStrings(value: unknown, depth = 0): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object" || depth >= 6) return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectStrings(item, depth + 1));
  return Object.values(value as Record<string, unknown>).flatMap((item) => collectStrings(item, depth + 1));
}

let ttlSweepRunning = false;
async function sweepExpiredSessions(): Promise<void> {
  if (ttlSweepRunning || (sessionTtlMs <= 0 && sparkTtlMs <= 0)) return;
  ttlSweepRunning = true;
  try {
    const maintenanceOptions = { priority: "background", fairnessKey: "session-ttl-sweep" } as const;
    const threads = await listAllSessions({}, maintenanceOptions);
    const activeIds = new Set(activeThreads);
    const expired = threads.filter((thread) => {
      const ttlMs = thread.sessionClass === "spark" ? sparkTtlMs : sessionTtlMs;
      return isSessionExpired(thread, activeIds, ttlMs);
    });
    const failures: PromiseRejectedResult[] = [];
    for (let offset = 0; offset < expired.length; offset += config.maintenanceChunkSize) {
      const chunk = expired.slice(offset, offset + config.maintenanceChunkSize);
      const results = await Promise.allSettled(chunk.map((thread) => archiveSession(
        String(thread.id),
        "ttl",
        "system",
        `ttl:${String(thread.id)}`
      )));
      failures.push(...results.filter((result): result is PromiseRejectedResult => result.status === "rejected"));
      if (offset + chunk.length < expired.length) await yieldToEventLoop();
    }
    if (expired.length) logger.info("Session TTL sweep completed", { expired: expired.length, archived: expired.length - failures.length, failures: failures.length });
    for (const failure of failures) logger.warn("Could not auto-archive expired session", { error: failure.reason });
  } catch (error) {
    logger.warn("Session TTL sweep failed", { error });
    throw error;
  } finally {
    ttlSweepRunning = false;
  }
}

function pruneLiveThreadStates(): void {
  liveRecovery.prune();
}

async function readSession(threadId: string, includeTurns: boolean): Promise<Record<string, unknown>> {
  const indexedArchived = inventoryIndex.archiveStateFor(threadId) === "archived";
  if (removedThreadIds.has(threadId) && !indexedArchived) throw httpError("Session has been removed", 404, "SESSION_NOT_FOUND");
  assertSessionNotArchiving(threadId);
  if (unavailableThreadIds.has(threadId) && !indexedArchived) throw httpError("This session no longer has a Codex rollout", 404, "SESSION_UNAVAILABLE");
  return withThreadOperation(threadId, async () => {
    const [snapshot, goal] = await Promise.all([
      codexRead<{ thread: Record<string, unknown> }>("thread/read", { threadId, includeTurns }, 60_000),
      codexRead<{ goal: Record<string, unknown> | null }>("thread/goal/get", { threadId }).catch(() => ({ goal: null }))
    ]);
    synchronizeThreadSnapshot(snapshot.thread);
    const thread = sessions.enrich({
      ...snapshot.thread,
      goal: goal.goal,
      policy: threadPolicies.get(threadId) || "workspace-write",
      archiveState: indexedArchived ? "archived" : "active",
      guardian: guardian.get(threadId)
    });
    if (includeTurns) await sessions.persistCanonicalHistory(thread);
    return thread;
  });
}

async function archiveSession(threadId: string, reason: string, actor: string, idempotencyKey?: string): Promise<Record<string, unknown>> {
  return withThreadOperation(threadId, async () => {
    const pending = sessions.incompleteSessionOperationFor("archive", threadId);
    if (pending) return { accepted: true, operation: operationResource(pending) };
    const key = idempotencyKey || `archive:${threadId}:${crypto.randomUUID()}`;
    const { operation, created } = await sessions.createSessionOperation("archive", key, {
      threadId,
      reason,
      actor,
      backend: "codex"
    }, threadId);
    archivingThreadIds.add(threadId);
    removedThreadIds.add(threadId);
    if (created) {
      await sessions.record(threadId, "archive_queued", actor, { reason, operationId: operation.id });
      broadcast("threads", { action: "removed", threadId, reason: "archiving", operationId: operation.id });
    }
    scheduleSessionOperation(operation.id);
    return { accepted: true, operation: operationResource(operation) };
  });
}

async function runSessionOperation(operationId: string): Promise<void | { retryAfterMs?: number }> {
  const operation = sessions.getSessionOperation(operationId);
  if (!operation || isTerminalOperation(operation)) return;
  const now = Date.now();
  if (operation.nextAttemptAt !== null && operation.nextAttemptAt > now) {
    return { retryAfterMs: operation.nextAttemptAt - now };
  }
  try {
    if (operation.kind === "create") await runCreateOperation(operation);
    else await runArchiveOperation(operation);
  } catch (error) {
    if (error instanceof DurableOperationRetryError) {
      const latest = sessions.getSessionOperation(operationId);
      if (!latest || isTerminalOperation(latest)) return;
      const retryAfterMs = error.retryAfterMs || operationRetryDelay(latest.attemptCount);
      const retryError = operationError(error.cause || error);
      const compensationFailure = jsonObject(latest.compensation.failure);
      await sessions.updateSessionOperation(operationId, {
        status: latest.status === "compensating" ? "compensating" : "retrying",
        step: latest.step,
        error: latest.status === "compensating" && compensationFailure ? compensationFailure : retryError,
        compensation: latest.status === "compensating"
          ? { ...latest.compensation, lastCompensationError: retryError }
          : latest.compensation,
        nextAttemptAt: Date.now() + retryAfterMs
      });
      return { retryAfterMs };
    }
    const latest = sessions.getSessionOperation(operationId);
    if (!latest || isTerminalOperation(latest)) return;
    if (latest.kind === "create" && latest.remoteThreadId) {
      const failure = jsonObject(latest.compensation.failure) || operationError(error);
      await sessions.updateSessionOperation(operationId, {
        status: "compensating",
        step: "compensating_remote",
        error: failure,
        compensation: {
          ...latest.compensation,
          failure,
          ...(latest.status === "compensating" ? { lastCompensationError: operationError(error) } : {})
        },
        nextAttemptAt: null
      });
      return runSessionOperation(operationId);
    }
    if (latest.kind === "archive") {
      if (isRetryableOperationError(error)) {
        const retryAfterMs = operationRetryDelay(latest.attemptCount);
        await sessions.updateSessionOperation(operationId, {
          status: "retrying",
          step: latest.step,
          error: operationError(error),
          nextAttemptAt: Date.now() + retryAfterMs
        });
        return { retryAfterMs };
      }
      await failArchiveOperation(latest, error);
      return;
    }
    await sessions.updateSessionOperation(operationId, {
      status: "failed",
      step: "failed",
      error: operationError(error),
      result: null,
      nextAttemptAt: null
    });
  }
}

function scheduleSessionOperation(operationId: string): void {
  sessionOperationScheduler.request(operationId);
}

function resumeIncompleteSessionOperations(): void {
  const incomplete = sessions.incompleteSessionOperations();
  for (const operation of incomplete) {
    if (operation.kind === "archive" && operation.remoteThreadId) {
      archivingThreadIds.add(operation.remoteThreadId);
      removedThreadIds.add(operation.remoteThreadId);
    }
    scheduleSessionOperation(operation.id);
  }
  if (incomplete.length) logger.info("Resuming durable session operations", { count: incomplete.length });
}

async function runCreateOperation(operation: SessionOperation): Promise<void> {
  if (operation.status === "compensating") {
    await compensateCreateOperation(operation);
    return;
  }
  let current = await sessions.updateSessionOperation(operation.id, {
    status: "running",
    step: "discovering_remote",
    attemptCount: operation.attemptCount + 1,
    error: null,
    nextAttemptAt: null
  });
  const input = current.input as unknown as DurableCreateInput;
  let threadId = current.remoteThreadId;
  try {
    if (!threadId) {
      threadId = await ensureCodexCreateRemote(current, input);
      current = sessions.getSessionOperation(operation.id) || current;
    }

    await sessions.updateSessionOperation(operation.id, { step: "persisting_local", remoteThreadId: threadId });
    await sessions.setMetadata(threadId, {
      tags: input.tags,
      category: input.category,
      sessionClass: input.sessionClass,
      backend: input.backend,
      cwd: input.cwd,
      name: input.name,
      preset: input.preset,
      model: input.model,
      effort: input.effort,
      lastPrompt: input.prompt,
      blueprintId: input.blueprintId,
      blueprintVersion: input.blueprintVersion,
      blueprintEnvironment: input.blueprintEnvironment,
      blueprintModelConfiguration: input.blueprintModelConfiguration,
      knowledgePackIds: input.knowledgePackIds,
      policyWarnings: input.policyWarnings,
      workspaceLeaseMode: input.leaseMode,
      workspaceFileScope: input.fileScope
    }, input.actor);
    if (input.guardianPolicy) guardian.configure(threadId, input.guardianPolicy);
    if (input.mcpActorId) mcpAccess.assignThread(threadId, input.mcpActorId);
    threadPolicies.set(threadId, input.yolo ? "yolo" : "workspace-write");
    persistThreadPolicies();
    knownThreadIds.add(threadId);
    await sessions.record(threadId, "created", input.actor, {
      operationId: operation.id,
      cwd: input.cwd,
      preset: input.preset,
      model: input.model,
      effort: input.effort,
      name: input.name,
      tags: input.tags,
      category: input.category,
      fileScope: input.fileScope,
      backend: input.backend,
      sessionClass: input.sessionClass,
      blueprintId: input.blueprintId,
      blueprintVersion: input.blueprintVersion,
      blueprintEnvironment: input.blueprintEnvironment,
      blueprintModelConfiguration: input.blueprintModelConfiguration
    });
    const committedOperation = sessions.getSessionOperation(operation.id) || current;
    await sessions.updateSessionOperation(operation.id, {
      compensation: { ...committedOperation.compensation, localState: "committed" }
    });

    const warnings: string[] = [...input.policyWarnings];
    let initialTurnStarted = false;
    const latest = sessions.getSessionOperation(operation.id) || current;
    let compensation = latest.compensation;
    if (compensation.nameApplied !== true) {
      await sessions.updateSessionOperation(operation.id, { step: "naming_remote" });
      try {
        await codexMutation("thread/name/set", { threadId, name: input.name }, 30_000, durableMutationOptions("session-create-name"));
        compensation = { ...compensation, nameApplied: true };
      } catch (error) {
        warnings.push("The session was created, but its name could not be set.");
        compensation = { ...compensation, nameApplied: "indeterminate" };
        logger.warn("Could not name newly created session", { operationId: operation.id, threadId, error });
      }
      await sessions.updateSessionOperation(operation.id, { compensation });
    }

    if (input.prompt) {
      const promptState = compensation.initialTurn;
      if (promptState === "accepted") {
        initialTurnStarted = true;
      } else if (promptState === "attempting" || promptState === "indeterminate") {
        warnings.push("The session was created, but the initial message outcome is indeterminate; it was not sent again.");
      } else {
        compensation = { ...compensation, initialTurn: "attempting" };
        await sessions.updateSessionOperation(operation.id, { step: "starting_initial_turn", compensation });
        try {
          const prepared = await prepareKnowledgePackMessage(threadId, input.prompt);
          claimBridgeThread(threadId);
          try {
            await sessions.withSession(threadId, () => startTurn(
                threadId!,
                prepared.text,
                input.model,
                input.effort,
                input.capacityWaitMs || INTERACTIVE_CAPACITY_WAIT_MS,
                durableMutationOptions("session-create-initial-turn"),
                input.admissionPolicy,
                input.projection
              ));
          } catch (error) {
            releaseBridgeThread(threadId);
            throw error;
          }
          await markKnowledgePackMessageInjected(threadId, prepared.markInjected);
          guardian.beginRun(threadId);
          initialTurnStarted = true;
          compensation = { ...compensation, initialTurn: "accepted" };
        } catch (error) {
          warnings.push(error instanceof ConflictError && error.code === "WORKSPACE_LEASE_CONFLICT"
            ? error.message
            : isRetryableOperationError(error)
              ? "The session was created, but the initial message outcome is indeterminate; it was not sent again."
              : "The session was created, but its initial message could not be started.");
          compensation = { ...compensation, initialTurn: isRetryableOperationError(error) ? "indeterminate" : "failed" };
          logger.warn("Could not start initial turn for newly created session", { operationId: operation.id, threadId, error });
        }
        await sessions.updateSessionOperation(operation.id, { compensation });
      }
    }

    await sessions.updateSessionOperation(operation.id, { step: "reading_result" });
    const thread = await readCreatedCodexSession(threadId, input.name);
    const result = { thread, initialTurnStarted, warnings };
    const completed = await sessions.updateSessionOperation(operation.id, {
      status: "succeeded",
      step: "completed",
      result,
      error: null,
      compensation: { ...compensation, remoteCleanup: "not_required", localState: "committed" },
      nextAttemptAt: null
    });
    broadcast("threads", { action: "created", threadId, backend: input.backend, operationId: operation.id });
    logger.info("Session creation operation completed", { operationId: operation.id, threadId, attempts: completed.attemptCount });
  } catch (error) {
    const latest = sessions.getSessionOperation(operation.id);
    if (latest?.compensation.localState === "committed" && isRetryableOperationError(error)) {
      throw new DurableOperationRetryError(error);
    }
    if (!latest?.remoteThreadId && isRetryableOperationError(error)) {
      throw new DurableOperationRetryError(error);
    }
    if (latest?.remoteThreadId) {
      const failure = operationError(error);
      await sessions.updateSessionOperation(operation.id, {
        status: "compensating",
        step: "compensating_remote",
        error: failure,
        compensation: { ...latest.compensation, failure, remoteCleanup: "pending" },
        nextAttemptAt: null
      });
      await compensateCreateOperation(sessions.getSessionOperation(operation.id)!);
      return;
    }
    throw error;
  }
}

async function ensureCodexCreateRemote(operation: SessionOperation, input: DurableCreateInput): Promise<string> {
  let compensation = operation.compensation;
  const baseline = stringArray(compensation.baselineThreadIds);
  if ((compensation.remoteMutation === "indeterminate" || compensation.remoteMutation === "in_flight") && baseline) {
    const candidates = await discoverCodexCreateCandidates(input, new Set(baseline));
    const discoveryPasses = nonNegativeInteger(compensation.discoveryPasses) + 1;
    compensation = { ...compensation, discoveryPasses };
    if (candidates.length === 1) {
      const threadId = candidates[0].id as string;
      await sessions.updateSessionOperation(operation.id, {
        remoteThreadId: threadId,
        step: "remote_discovered",
        compensation: { ...compensation, remoteMutation: "discovered", remoteCleanup: "pending", remoteThreadSnapshot: candidates[0] }
      });
      return threadId;
    }
    await sessions.updateSessionOperation(operation.id, { step: "discovering_remote", compensation });
    if (candidates.length > 1 || discoveryPasses < 2) {
      throw new DurableOperationRetryError(new Error(candidates.length > 1
        ? "Remote creation discovery is ambiguous"
        : "Remote creation is not visible yet"));
    }
  }

  return sessions.withInventory(async () => {
    let currentCompensation = (sessions.getSessionOperation(operation.id) || operation).compensation;
    let currentBaseline = stringArray(currentCompensation.baselineThreadIds);
    if (!currentBaseline) {
      currentBaseline = (await listCodexThreadsRaw(false)).map((thread) => String(thread.id));
      currentCompensation = { ...currentCompensation, baselineThreadIds: currentBaseline };
    }
    await sessions.updateSessionOperation(operation.id, {
      step: "creating_remote",
      compensation: { ...currentCompensation, remoteMutation: "in_flight", remoteCleanup: "pending" }
    });
    try {
      const result = await codexMutation<{ thread: Record<string, unknown> & { id: string } }>("thread/start", {
        cwd: input.cwd,
        runtimeWorkspaceRoots: [input.cwd],
        model: input.model,
        allowProviderModelFallback: false,
        approvalPolicy: input.yolo ? "never" : "on-request",
        sandbox: input.leaseMode === "read-only" ? "read-only" : input.yolo ? "danger-full-access" : "workspace-write",
        ephemeral: false,
        serviceName: input.serviceName
      }, 60_000, durableMutationOptions("session-create-remote"));
      const threadId = validAdapterThreadId(result.thread?.id);
      await sessions.updateSessionOperation(operation.id, {
        remoteThreadId: threadId,
        step: "remote_created",
        compensation: { ...currentCompensation, remoteMutation: "completed", remoteCleanup: "pending", remoteThreadSnapshot: result.thread }
      });
      return threadId;
    } catch (error) {
      if (!isRetryableOperationError(error)) throw error;
      const latest = sessions.getSessionOperation(operation.id) || operation;
      await sessions.updateSessionOperation(operation.id, {
        step: "discovering_remote",
        compensation: { ...latest.compensation, remoteMutation: "indeterminate", discoveryPasses: 0 }
      });
      const candidates = await discoverCodexCreateCandidates(input, new Set(currentBaseline)).catch(() => []);
      if (candidates.length === 1) {
        const threadId = candidates[0].id as string;
        await sessions.updateSessionOperation(operation.id, {
          remoteThreadId: threadId,
          step: "remote_discovered",
          compensation: { ...latest.compensation, remoteMutation: "discovered", remoteCleanup: "pending", remoteThreadSnapshot: candidates[0] }
        });
        return threadId;
      }
      throw new DurableOperationRetryError(error);
    }
  });
}

async function compensateCreateOperation(operation: SessionOperation): Promise<void> {
  const input = operation.input as unknown as DurableCreateInput;
  const threadId = operation.remoteThreadId;
  if (!threadId) {
    await sessions.updateSessionOperation(operation.id, { status: "failed", step: "failed", nextAttemptAt: null });
    return;
  }
  const current = await sessions.updateSessionOperation(operation.id, {
    status: "compensating",
    step: "compensating_remote",
    attemptCount: operation.attemptCount + 1,
    compensation: { ...operation.compensation, remoteCleanup: "in_flight" },
    nextAttemptAt: null
  });
  try {
    const state = await discoverCodexArchiveState(threadId);
    if (state === "active") {
      try {
        await sessions.withInventory(() => codexMutation(
          "thread/archive",
          { threadId },
          60_000,
          durableMutationOptions("session-create-compensation")
        ));
      } catch (error) {
        if (!isMissingThreadError(error) && await discoverCodexArchiveState(threadId) === "active") throw error;
      }
    }
  } catch (error) {
    throw new DurableOperationRetryError(error);
  }
  await cleanupSessionTraces(threadId, "create_compensation", input.actor);
  await sessions.updateSessionOperation(operation.id, {
    status: "failed",
    step: "compensated",
    result: null,
    compensation: { ...current.compensation, remoteCleanup: "completed", localCleanup: "completed" },
    nextAttemptAt: null
  });
  logger.warn("Failed session creation was compensated", { operationId: operation.id, threadId });
}

async function runArchiveOperation(operation: SessionOperation): Promise<void> {
  let current = await sessions.updateSessionOperation(operation.id, {
    status: "running",
    step: "preparing_archive",
    attemptCount: operation.attemptCount + 1,
    error: null,
    nextAttemptAt: null
  });
  const input = current.input as unknown as DurableArchiveInput;
  const threadId = validThreadId(input.threadId);
  archivingThreadIds.add(threadId);
  removedThreadIds.add(threadId);
  let compensation = current.compensation;

  if (compensation.preparation !== "completed") {
    const savedQueue = compensation.savedQueue || cloneQueuedMessages(messageQueues.get(threadId) || []);
    compensation = {
      ...compensation,
      preparation: "recorded",
      savedQueue,
      remoteArchive: compensation.remoteArchive || "pending",
      localCleanup: compensation.localCleanup || "pending"
    };
    await sessions.updateSessionOperation(operation.id, { compensation });
    const hadQueue = messageQueues.delete(threadId);
    admissionPausedQueues.delete(threadId);
    const admissionTimer = admissionQueueTimers.get(threadId);
    if (admissionTimer) clearTimeout(admissionTimer);
    admissionQueueTimers.delete(threadId);
    if (hadQueue) {
      persistMessageQueues();
      broadcastQueue(threadId);
    }
    try {
      if (!unavailableThreadIds.has(threadId)) {
        const activeTurnId = await findActiveTurnId(threadId);
        compensation = { ...compensation, activeTurnId };
        if (activeTurnId) {
          await sessions.record(threadId, "interrupt_requested", input.actor, { turnId: activeTurnId, reason: "archive", operationId: operation.id });
          await codexMutation(
            "turn/interrupt",
            { threadId, turnId: activeTurnId },
            30_000,
            durableMutationOptions("session-archive-interrupt")
          );
        }
      }
    } catch (error) {
      compensation = { ...compensation, interrupt: "indeterminate" };
      logger.warn("Archive interruption outcome is indeterminate; continuing with authoritative archive", { operationId: operation.id, threadId, error });
    }
    if (activeThreads.has(threadId) || compensation.activeTurnId) {
      activeThreads.delete(threadId);
      activeThreadSources.delete(threadId);
      activeTurnIds.delete(threadId);
      clearCapacityRecovery(threadId);
      releaseTurnCapacity(threadId, true);
    }
    compensation = { ...compensation, preparation: "completed" };
    await sessions.updateSessionOperation(operation.id, { compensation });
  }

  current = sessions.getSessionOperation(operation.id) || current;
  compensation = current.compensation;
  let archiveState = compensation.remoteArchive === "completed"
    ? "archived_or_missing" as const
    : await discoverRemoteArchiveState(threadId);
  if (archiveState === "active") {
    compensation = { ...compensation, remoteArchive: "in_flight" };
    await sessions.updateSessionOperation(operation.id, { step: "archiving_remote", compensation });
    try {
      await sessions.withInventory(() => codexMutation(
        "thread/archive",
        { threadId },
        60_000,
        durableMutationOptions("session-archive-remote", input.actor)
      ));
      archiveState = "archived_or_missing";
    } catch (error) {
      archiveState = await discoverRemoteArchiveState(threadId).catch(() => "active" as const);
      if (archiveState === "active") throw error;
    }
  }

  compensation = { ...compensation, remoteArchive: "completed" };
  await sessions.updateSessionOperation(operation.id, { step: "cleaning_local", compensation });
  await sessions.markArchived(threadId, archiveReason(input.reason), input.actor, {
    operationId: operation.id,
    attempts: current.attemptCount,
    backend: input.backend,
    ...(unavailableThreadIds.has(threadId) ? { remoteAlreadyMissing: true } : {})
  });
  await cleanupSessionTraces(threadId, input.reason, input.actor, false, true);
  const result = { accepted: true, archived: true, threadId };
  const completed = await sessions.updateSessionOperation(operation.id, {
    status: "succeeded",
    step: "completed",
    result,
    error: null,
    compensation: { ...compensation, localCleanup: "completed" },
    nextAttemptAt: null
  });
  logger.info("Session archive operation completed", { operationId: operation.id, threadId, attempts: completed.attemptCount });
}

async function failArchiveOperation(operation: SessionOperation, error: unknown): Promise<void> {
  const input = operation.input as unknown as DurableArchiveInput;
  const threadId = input.threadId;
  const savedQueue = queuedMessages(operation.compensation.savedQueue);
  if (savedQueue?.length && !messageQueues.has(threadId)) {
    messageQueues.set(threadId, savedQueue);
    persistMessageQueues();
    broadcastQueue(threadId);
  }
  archivingThreadIds.delete(threadId);
  removedThreadIds.delete(threadId);
  await sessions.record(threadId, "archive_failed", input.actor, {
    reason: input.reason,
    operationId: operation.id,
    error: operationError(error).message
  });
  await sessions.updateSessionOperation(operation.id, {
    status: "failed",
    step: "failed_compensated",
    error: operationError(error),
    result: null,
    compensation: { ...operation.compensation, localVisibility: "restored", savedQueue: savedQueue || [] },
    nextAttemptAt: null
  });
  broadcast("threads", { action: "updated", threadId, reason: "archive_failed", operationId: operation.id });
}

async function discoverRemoteArchiveState(threadId: string): Promise<"active" | "archived_or_missing"> {
  if (unavailableThreadIds.has(threadId)) return "archived_or_missing";
  return discoverCodexArchiveState(threadId);
}

async function discoverCodexArchiveState(threadId: string): Promise<"active" | "archived_or_missing"> {
  if ((await listCodexThreadsRaw(false, threadId)).some((thread) => thread.id === threadId)) return "active";
  if ((await listCodexThreadsRaw(true, threadId)).some((thread) => thread.id === threadId)) return "archived_or_missing";
  return "archived_or_missing";
}

async function discoverCodexCreateCandidates(input: DurableCreateInput, baseline: Set<string>): Promise<Array<Record<string, unknown> & { id: string }>> {
  const threads = await listCodexThreadsRaw(false);
  return threads.filter((thread): thread is Record<string, unknown> & { id: string } => {
    if (typeof thread.id !== "string" || baseline.has(thread.id)) return false;
    if (typeof thread.serviceName === "string" && thread.serviceName !== input.serviceName) return false;
    if (typeof thread.cwd === "string" && path.resolve(thread.cwd) !== path.resolve(input.cwd)) return false;
    if (typeof thread.model === "string" && thread.model !== input.model) return false;
    return true;
  });
}

async function listCodexThreadsRaw(archived: boolean, stopAfterThreadId?: string): Promise<Array<Record<string, unknown>>> {
  const threads: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const result = await codexRead<{ data: Array<Record<string, unknown>>; nextCursor: string | null }>("thread/list", {
      cursor,
      limit: 200,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived
    }, 30_000, durableReadOptions("session-operation-discovery"));
    threads.push(...result.data);
    if ((stopAfterThreadId && result.data.some((thread) => thread.id === stopAfterThreadId)) || !result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return threads;
}

async function readCreatedCodexSession(threadId: string, name: string): Promise<Record<string, unknown>> {
  const snapshot = await codexRead<{ thread: Record<string, unknown> }>(
    "thread/read",
    { threadId, includeTurns: true },
    60_000,
    durableReadOptions("session-create-result")
  );
  synchronizeThreadSnapshot(snapshot.thread);
  const thread = sessions.enrich({
    ...snapshot.thread,
    name,
    policy: threadPolicies.get(threadId) || "workspace-write",
    archiveState: "active",
    guardian: guardian.get(threadId)
  });
  await sessions.persistCanonicalHistory(thread);
  return thread;
}

function durableMutationOptions(fairnessKey: string, actor = "system"): OperationOptions {
  return {
    priority: actor === "system" ? "background" : "interactive",
    fairnessKey,
    signal: durableOperationSignal
  };
}

function durableReadOptions(fairnessKey: string): OperationOptions {
  return { priority: "background", fairnessKey, signal: durableOperationSignal };
}

function operationRetryDelay(attemptCount: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.min(5, Math.max(0, attemptCount - 1)));
}

function isRetryableOperationError(error: unknown): boolean {
  const normalized = normalizeHttpError(error);
  return normalized.retryable || normalized.status === 408 || normalized.status === 429 || normalized.status >= 500;
}

function operationError(error: unknown): Record<string, unknown> {
  return { ...publicError(error) };
}

function isTerminalOperation(operation: SessionOperation): boolean {
  return operation.status === "succeeded" || operation.status === "failed";
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function nonNegativeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function cloneQueuedMessages(messages: QueuedMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => ({ ...message }));
}

function queuedMessages(value: unknown): QueuedMessage[] | null {
  if (!Array.isArray(value)) return null;
  const messages = value.filter((item): item is QueuedMessage => Boolean(
    item && typeof item === "object" && typeof (item as QueuedMessage).id === "string"
      && typeof (item as QueuedMessage).text === "string" && typeof (item as QueuedMessage).model === "string"
  ));
  return messages.length === value.length ? messages.map((message) => ({ ...message })) : null;
}

class DurableOperationRetryError extends Error {
  constructor(override readonly cause: unknown, readonly retryAfterMs?: number) {
    super(cause instanceof Error ? cause.message : "Durable session operation should be retried", { cause });
    this.name = "DurableOperationRetryError";
  }
}

type DurableCreateInput = SessionCreationInput & {
  actor: string;
  mcpActorId: string | null;
  serviceName: string;
  blueprintModelConfiguration: { backend: SessionBackend; model: string; effort: string | null; preset: ModelPreset | null } | null;
  knowledgePackIds: string[];
  policyWarnings: string[];
  capacityWaitMs?: number;
};

type DurableArchiveInput = {
  threadId: string;
  reason: string;
  actor: string;
  backend: SessionBackend;
};

async function cleanupSessionTraces(
  threadId: string,
  reason: string,
  actor: string,
  ownershipReleased = false,
  preserveMetadata = false
): Promise<void> {
  const hadQueue = messageQueues.delete(threadId);
  const hadPolicy = threadPolicies.delete(threadId);
  const hadMetadata = preserveMetadata ? false : await sessions.removeMetadata(threadId);
  const hadLiveState = liveRecovery.delete(threadId);
  const hadActivity = activeThreads.has(threadId) || activeThreadSources.has(threadId) || activeTurnIds.has(threadId);
  const hadOwnership = ownershipReleased || mcpAccess.listAgentThreads().includes(threadId);

  activeThreads.delete(threadId);
  const hadGuardian = guardian.remove(threadId);
  clearCapacityRecovery(threadId);
  releaseTurnCapacity(threadId, true);
  activeThreadSources.delete(threadId);
  activeTurnIds.delete(threadId);
  usageModelsByThread.delete(threadId);
  deadProcessThreadIds.delete(threadId);
  drainingQueues.delete(threadId);
  const admissionTimer = admissionQueueTimers.get(threadId);
  if (admissionTimer) clearTimeout(admissionTimer);
  admissionQueueTimers.delete(threadId);
  admissionPausedQueues.delete(threadId);
  bridgeOwnedThreads.delete(threadId);
  capacityBuffers.delete(threadId);
  capacityHandledThreads.delete(threadId);
  knownThreadIds.delete(threadId);
  archivingThreadIds.delete(threadId);
  if (!ownershipReleased) mcpAccess.releaseThread(threadId);

  if (hadQueue) persistMessageQueues();
  if (hadPolicy) persistThreadPolicies();
  if (hadQueue || hadPolicy || hadMetadata || hadLiveState || hadActivity || hadOwnership || hadGuardian) {
    await sessions.record(threadId, "local_state_removed", actor, { reason });
  }
  codex.dismissServerRequestsForThread(threadId);
  broadcastQueue(threadId);
  broadcast("threads", { action: "removed", threadId, reason });
}

function reconcileSessionInventory(threadIds: Set<string>): void {
  inventoryIndex.invalidate();
  const previouslyRemoved = reconciledInventoryIds
    ? [...reconciledInventoryIds].filter((threadId) => !threadIds.has(threadId))
    : [];
  const definiteStale = new Set(previouslyRemoved);
  const locallyTracked = new Set([
    ...messageQueues.keys(), ...threadPolicies.keys(), ...mcpAccess.listAgentThreads(),
    ...sessions.trackedThreadIds(), ...liveRecovery.keys(), ...activeThreadSources.keys()
  ]);
  const staleThreadIds: string[] = [];
  for (const threadId of locallyTracked) {
    if (archivingThreadIds.has(threadId)) continue;
    if (!threadIds.has(threadId) && (definiteStale.has(threadId) || !knownThreadIds.has(threadId))) {
      staleThreadIds.push(threadId);
    }
  }
  const releasedOwnership = new Set(mcpAccess.releaseThreads(staleThreadIds));
  for (const threadId of staleThreadIds) {
    void cleanupSessionTraces(threadId, "inventory_reconciliation", "system", releasedOwnership.has(threadId))
      .catch((error) => logger.warn("Could not reconcile stale session state", { threadId, error }));
  }
  reconciledInventoryIds = new Set(threadIds);
}

async function loadSessionInventory(): Promise<InventoryItem[]> {
  const items = await listAllSessions({}, {
    priority: "background",
    fairnessKey: "session-inventory-refresh",
    deadline: Date.now() + 45_000,
    // The inventory index is shared by every browser. Once a refresh starts,
    // one caller disconnecting must not cancel it and cache a partial fleet.
    signal: durableOperationSignal
  }, true);
  return items.filter((item): item is InventoryItem => typeof item.id === "string");
}

async function listAllSessions(
  filters: { sessionClass?: SessionClass; backend?: SessionBackend } = {},
  operationOptions: OperationOptions = {},
  includeArchived = false
): Promise<Array<Record<string, unknown>>> {
  return sessions.withInventory(async () => {
    const threads: Array<Record<string, unknown>> = [];
    try {
        const archiveStates = includeArchived ? [false, true] : [false];
        for (const archived of archiveStates) {
          try {
            let cursor: string | undefined;
            for (let page = 0; page < 100; page += 1) {
              const result = await codexRead<{ data: Array<Record<string, unknown>>; nextCursor: string | null }>("thread/list", {
                cursor,
                limit: 200,
                sortKey: "updated_at",
                sortDirection: "desc",
                archived
              }, 30_000, operationOptions);
              for (const thread of result.data) {
                if (typeof thread.id !== "string" || archivingThreadIds.has(thread.id)) continue;
                if (!archived && (unavailableThreadIds.has(thread.id) || removedThreadIds.has(thread.id))) continue;
                if (!archived) synchronizeThreadSnapshot(thread);
                const enriched = inventorySummary(sessions.enrich(thread), archived ? "archived" : "active");
                if (filters.sessionClass && enriched.sessionClass !== filters.sessionClass) continue;
                threads.push(enriched);
              }
              if (!result.nextCursor || result.nextCursor === cursor) break;
              cursor = result.nextCursor;
            }
          } catch (error) {
            if (!archived) throw error;
            logger.warn("Archived Codex sessions could not be included in the inventory", { error });
          }
        }
    } catch (error) {
      if (filters.backend === "codex") throw error;
      logger.warn("Codex sessions could not be included in the session list", { error });
    }
    return threads;
  });
}

function inventorySummary(thread: Record<string, unknown>, archiveState: "active" | "archived"): Record<string, unknown> {
  const threadId = typeof thread.id === "string" ? thread.id : "";
  const metadata = threadId ? sessions.metadataFor(threadId) : null;
  const ownerId = threadId ? mcpAccess.ownerForThread(threadId) : null;
  const source = ownerId ? "mcp" : threadId && sessions.hasMetadata(threadId) ? "user" : "external";
  const queueDepth = messageQueues.get(threadId)?.length || 0;
  return {
    ...thread,
    archiveState,
    queueState: queueDepth > 0 ? "queued" : "empty",
    queueDepth,
    owner: ownerId ? `mcp:${ownerId.slice(0, 8)}` : "local",
    source,
    guardian: guardian.get(threadId),
    ...(metadata?.lastPrompt ? { lastPrompt: metadata.lastPrompt } : {})
  };
}

async function archiveEntry(thread: Record<string, unknown>) {
  const id = validThreadId(typeof thread.id === "string" ? thread.id : "");
  const metadata = sessions.metadataFor(id);
  const history = metadata.archiveReason && metadata.archivedAt ? [] : await sessions.history(id, 100);
  const event = [...history].reverse().find((candidate) => candidate.action === "archived");
  const archivedAt = metadata.archivedAt
    || event?.at
    || providerTimestampMs(thread.updatedAt)
    || providerTimestampMs(thread.recencyAt)
    || Date.now();
  const reason: SessionArchiveReason = metadata.archiveReason
    || (event?.details?.reason === "ttl" ? "ttl" : "manual");
  const pinned = metadata.pinned || thread.pinned === true;
  const retentionMs = config.metadataRetentionMs;
  const permanentDeletionAt = !pinned && retentionMs > 0 ? archivedAt + retentionMs : null;
  const remainingTimeMs = permanentDeletionAt === null ? null : Math.max(0, permanentDeletionAt - Date.now());
  const sessionClass = thread.sessionClass === "spark" ? "spark" as const : "standard" as const;
  const ttlMs = sessionClass === "spark" ? sparkTtlMs : sessionTtlMs;
  const backend = "codex" as const;
  return {
    id,
    name: typeof thread.name === "string" && thread.name.trim()
      ? thread.name.trim()
      : metadata.name || (typeof thread.preview === "string" && thread.preview.trim() ? thread.preview.trim().slice(0, 100) : "Untitled session"),
    cwd: typeof thread.cwd === "string" ? thread.cwd : metadata.cwd,
    backend,
    sessionClass,
    archivedAt,
    reason,
    pinned,
    restorable: backend === "codex",
    ttlHours: ttlMs > 0 ? ttlMs / 3_600_000 : null,
    permanentDeletionAt,
    remainingTimeMs,
    daysUntilPermanentDeletion: remainingTimeMs === null ? null : Math.ceil(remainingTimeMs / 86_400_000)
  };
}

async function restoreArchivedSession(threadId: string, actor: string): Promise<Record<string, unknown>> {
  return withThreadOperation(threadId, async () => {
    assertSessionNotArchiving(threadId);
    sessions.metadataFor(threadId);
    const archived = (await listCodexThreadsRaw(true, threadId)).find((thread) => thread.id === threadId);
    if (!archived) throw httpError("Archived session not found", 404, "ARCHIVED_SESSION_NOT_FOUND");
    await enforceResumePolicy(threadId, {}, actor);
    const response = await codexMutation<{ thread: Record<string, unknown> }>(
      "thread/unarchive",
      { threadId },
      60_000,
      { fairnessKey: `restore:${threadId}` }
    );
    removedThreadIds.delete(threadId);
    unavailableThreadIds.delete(threadId);
    await sessions.markRestored(threadId, actor);
    synchronizeThreadSnapshot(response.thread);
    inventoryIndex.invalidate();
    const thread = inventorySummary(sessions.enrich({ ...response.thread, archiveState: "active" }), "active");
    broadcast("threads", { action: "updated", threadId, reason: "restored" });
    return { restored: true, thread };
  });
}

function archiveReason(value: string): SessionArchiveReason {
  return value === "ttl" ? "ttl" : "manual";
}

function inferredArchiveReason(threadId: string): SessionArchiveReason {
  return sessions.metadataFor(threadId).archiveReason || "manual";
}

function providerTimestampMs(value: unknown): number {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number < 100_000_000_000 ? number * 1_000 : number;
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

let codexGuardianRecoveryPromise: Promise<void> | null = null;
function recoverCodexGuardianMonitoring(): Promise<void> {
  if (codexGuardianRecoveryPromise) return codexGuardianRecoveryPromise;
  codexGuardianRecoveryPromise = (async () => {
    const recoverable = guardian.list().filter((state) => state.active);
    for (const state of recoverable) {
      try {
        const snapshot = await codexRead<{ thread: ThreadSnapshot }>(
          "thread/read",
          { threadId: state.threadId, includeTurns: true },
          30_000,
          { priority: "background", fairnessKey: "guardian-recovery" }
        );
        const lastTurn = snapshot.thread.turns?.at(-1);
        const active = snapshot.thread.status?.type === "active" || lastTurn?.status === "inProgress";
        if (active) {
          setThreadActivity(state.threadId, "bridge", true);
          reconcileTurnCapacity(state.threadId);
          if (lastTurn?.id) activeTurnIds.set(state.threadId, lastTurn.id);
        } else {
          guardian.complete(state.threadId);
        }
      } catch (error) {
        logger.warn("Could not recover guardian monitoring for a Codex session", { threadId: state.threadId, error });
      }
    }
    if (recoverable.length) logger.info("Recovered Codex guardian monitoring", { sessions: recoverable.length });
  })().finally(() => { codexGuardianRecoveryPromise = null; });
  return codexGuardianRecoveryPromise;
}

function sessionClassFor(threadId: string): SessionClass {
  return sessions.metadataFor(threadId).sessionClass;
}

function synchronizeThreadSnapshot(thread: Record<string, unknown>): void {
  if (typeof thread.id !== "string") return;
  const threadId = thread.id;
  if (removedThreadIds.has(threadId)) return;
  knownThreadIds.add(threadId);
  unavailableThreadIds.delete(threadId);
  const status = thread.status && typeof thread.status === "object" ? (thread.status as { type?: unknown }) : null;
  const turns = Array.isArray(thread.turns) ? thread.turns as Array<Record<string, unknown>> : [];
  const lastTurn = turns.at(-1);
  if (deadProcessThreadIds.has(threadId)) {
    thread.status = { type: "idle" };
    if (lastTurn?.status === "inProgress") lastTurn.status = "interrupted";
    setThreadActivity(threadId, "bridge", false);
    releaseTurnCapacity(threadId, true);
    return;
  }
  const active = status?.type === "active" || lastTurn?.status === "inProgress";
  setThreadActivity(threadId, "bridge", active);
  if (active) reconcileTurnCapacity(threadId);
  else releaseTurnCapacity(threadId, true);
  if (active && typeof lastTurn?.id === "string") activeTurnIds.set(threadId, lastTurn.id);
}

function claimBridgeThread(threadId: string): void {
  bridgeOwnedThreads.add(threadId);
  deadProcessThreadIds.delete(threadId);
  setThreadActivity(threadId, "external", false);
}

function releaseBridgeThread(threadId: string): void {
  bridgeOwnedThreads.delete(threadId);
  setThreadActivity(threadId, "bridge", false);
}

function clearBridgeActivity(): void {
  for (const threadId of [...activeThreadSources.keys()]) setThreadActivity(threadId, "bridge", false);
  bridgeOwnedThreads.clear();
}

function withThreadOperation<T>(threadId: string, operation: () => Promise<T> | T): Promise<T> {
  return sessions.withSession(threadId, operation);
}

function withMutableThreadOperation<T>(threadId: string, operation: () => Promise<T> | T): Promise<T> {
  return withThreadOperation(threadId, () => {
    assertSessionNotArchiving(threadId);
    return operation();
  });
}

function runReadOperation<T>(
  operation: (context: OperationContext) => Promise<T> | T,
  timeoutMs = 60_000,
  options: OperationOptions = {}
): Promise<T> {
  return readOperations.run(operation, scopedOperationOptions(timeoutMs, options));
}

function runMutationOperation<T>(
  operation: (context: OperationContext) => Promise<T> | T,
  timeoutMs = 60_000,
  options: OperationOptions = {}
): Promise<T> {
  return mutationOperations.run(operation, scopedOperationOptions(timeoutMs, options));
}

function codexRead<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000, options: OperationOptions = {}): Promise<T> {
  return runReadOperation((context) => codex.request<T>(method, params, {
    timeoutMs: boundedRemainingTimeout(context, timeoutMs),
    signal: context.signal
  }), timeoutMs, options);
}

function codexMutation<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000, options: OperationOptions = {}): Promise<T> {
  return runMutationOperation((context) => codex.request<T>(method, params, {
    timeoutMs: boundedRemainingTimeout(context, timeoutMs),
    signal: context.signal
  }), timeoutMs, options);
}

function scopedOperationOptions(timeoutMs: number, options: OperationOptions): OperationOptions {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("Operation timeout must be positive");
  const scope = requestOperationScope.getStore();
  return {
    ...options,
    priority: options.priority || (scope ? "interactive" : "background"),
    signal: options.signal || scope?.signal,
    fairnessKey: options.fairnessKey || scope?.fairnessKey || options.priority || "system",
    deadline: options.deadline ?? Date.now() + timeoutMs
  };
}

function boundedRemainingTimeout(context: OperationContext, requestedMs: number): number {
  return Math.max(1, Math.min(requestedMs, Math.floor(context.remainingMs())));
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function ensureSessionExists(threadId: string): Promise<void> {
  assertSessionNotArchiving(threadId);
  if (unavailableThreadIds.has(threadId)) throw httpError("Session not found", 404, "SESSION_NOT_FOUND");
  const snapshot = await codexRead<{ thread: Record<string, unknown> }>("thread/read", { threadId, includeTurns: false }, 60_000);
  synchronizeThreadSnapshot(snapshot.thread);
}

function assertSessionNotArchiving(threadId: string): void {
  if (archivingThreadIds.has(threadId) || sessions.incompleteSessionOperationFor("archive", threadId)) {
    throw httpError("This session is being archived", 409, "SESSION_ARCHIVING");
  }
}

async function updateSessionMetadata(threadId: string, update: { tags?: unknown; category?: unknown }, actor: string) {
  try {
    return await sessions.setMetadata(threadId, update, actor);
  } catch (error) {
    throw httpError(error instanceof Error ? error.message : "Invalid session organization", 400, "INVALID_SESSION_METADATA");
  }
}

function isMissingThreadError(error: unknown): boolean {
  if (error instanceof NotFoundError) return true;
  if (error instanceof CodexRpcError) {
    const code = providerErrorCode(error.data);
    return code === "THREAD_NOT_FOUND" || code === "SESSION_NOT_FOUND" || code === "THREAD_ARCHIVED";
  }
  const candidate = error as { status?: unknown; code?: unknown };
  return Number(candidate?.status) === 404
    || candidate?.code === "THREAD_NOT_FOUND"
    || candidate?.code === "SESSION_NOT_FOUND"
    || candidate?.code === "THREAD_ARCHIVED";
}

function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Permitted-Cross-Domain-Policies": "none",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  });
  if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
  next();
}

function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const suppliedId = req.headers["x-request-id"];
  const requestId = typeof suppliedId === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(suppliedId)
    ? suppliedId
    : crypto.randomUUID();
  const startedAt = process.hrtime.bigint();
  res.locals.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  res.once("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const context = {
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      remoteAddress: req.ip || req.socket.remoteAddress || "unknown"
    };
    if (res.statusCode >= 500) logger.error("HTTP request completed", context);
    else if (res.statusCode >= 400) logger.warn("HTTP request completed", context);
    else if (req.path === "/api/health") logger.debug("HTTP request completed", context);
    else logger.info("HTTP request completed", context);
  });
  next();
}

function operationScopeMiddleware(req: Request, res: Response, next: NextFunction): void {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(new Error("HTTP client disconnected"));
  };
  req.once("aborted", abort);
  res.once("close", () => {
    if (!res.writableFinished) abort();
  });
  const requestId = typeof res.locals.requestId === "string" ? res.locals.requestId : crypto.randomUUID();
  requestOperationScope.run({ signal: controller.signal, fairnessKey: `request:${requestId}`, requestId }, next);
}

function isOperationBackpressureError(error: unknown): boolean {
  const candidate = error as { status?: unknown; code?: unknown; transient?: unknown; indeterminate?: unknown };
  const status = Number(candidate?.status);
  if (status === 429 || status >= 500) return true;
  if (candidate?.transient === true || candidate?.indeterminate === true) return true;
  return /(?:timeout|backpressure|capacity|busy|offline|unavailable|connection)/i.test(String(candidate?.code || ""));
}

function storageStatus(): {
  engine: "sqlite";
  status: "ok" | "error";
  writable: boolean;
  revision?: number;
  backupRevision?: number;
  recoverySource?: "primary" | "backup" | "empty";
  error?: string;
} {
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.accessSync(dataDir, fs.constants.R_OK | fs.constants.W_OK);
    const store = sessions.storageStatus();
    return { ...store, writable: store.status === "ok" };
  } catch (error) {
    logger.warn("ForgeDeck data directory is unavailable", { error });
    return { engine: "sqlite", status: "error", writable: false, error: "Data directory is unavailable" };
  }
}

type SessionCreationInput = {
  cwd: string;
  backend: SessionBackend;
  sessionClass: SessionClass;
  preset: ModelPreset | null;
  model: string;
  effort: string | null;
  yolo: boolean;
  leaseMode: WorkspaceLeaseMode;
  fileScope: string[] | null;
  name: string;
  prompt: string | null;
  tags: string[];
  category: string | null;
  blueprintId: string | null;
  blueprintVersion: number | null;
  blueprintEnvironment: string | null;
  blueprintVariables: Record<string, unknown> | null;
  admissionPolicy: DeclaredExhaustionPolicy | null;
  projection: AdmissionProjection | null;
  guardianPolicy: RunGuardianPolicy | null;
};

type AcceptSessionCreationOptions = {
  idempotencyKey: string;
  actor: string;
  mcpActorId: string | null;
  workspaceOverride?: string;
  providerOverride?: SessionBackend;
  modelOverride?: string;
  effortOverride?: string | null;
  capacityWaitMs?: number;
};

async function acceptSessionCreation(
  value: unknown,
  options: AcceptSessionCreationOptions
): Promise<{ operation: SessionOperation; created: boolean }> {
  let input = parseSessionCreation(value);
  const resolvedBlueprint = input.blueprintId
    ? sessions.blueprints.resolve(input.blueprintId, input.blueprintVersion, input.blueprintVariables)
    : null;
  if (resolvedBlueprint) {
    input = applyBlueprintToSession(input, resolvedBlueprint);
    if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, "name")) {
      input = { ...input, name: deriveSessionName(input.prompt) };
    }
  }
  if (options.workspaceOverride) input = { ...input, cwd: options.workspaceOverride };
  if (options.providerOverride || options.modelOverride || options.effortOverride !== undefined) {
    const backend = options.providerOverride || input.backend;
    const model = options.modelOverride || input.model;
    const sessionClass: SessionClass = backend === "codex" && model === "gpt-5.3-codex-spark"
      ? "spark"
      : "standard";
    input = {
      ...input,
      backend,
      preset: null,
      model,
      sessionClass,
      effort: sessionClass === "spark" ? "high" : options.effortOverride === undefined ? input.effort : options.effortOverride
    };
  }
  const cwd = await workspaces.validate(input.cwd);
  const { backend, model, effort } = input;
  const blueprintModelConfiguration = resolvedBlueprint ? { backend, model, effort, preset: input.preset } : null;
  await validateModelChoice(model, effort);
  const policyDecision = evaluatePreflightPolicy({
    sessionClass: input.sessionClass,
    model,
    reasoningEffort: effort,
    workspace: cwd,
    tokensUsed: 0
  });
  assertPolicyAllowed(policyDecision);
  const operationInput: Record<string, unknown> = {
    ...input,
    cwd,
    policyWarnings: policyDecision.warnings,
    actor: options.actor,
    mcpActorId: options.mcpActorId,
    blueprintModelConfiguration,
    knowledgePackIds: sessions.knowledgePacks.packIdsForWorkspace(cwd),
    ...(options.capacityWaitMs === undefined ? {} : { capacityWaitMs: options.capacityWaitMs }),
    serviceName: `ForgeDeck/${crypto.createHash("sha256").update(options.idempotencyKey).digest("hex").slice(0, 24)}`
  };
  const result = await sessions.createSessionOperation("create", options.idempotencyKey, operationInput);
  scheduleSessionOperation(result.operation.id);
  return result;
}

type PolicyPreflightInput = {
  sessionClass: SessionClass;
  model: string;
  reasoningEffort: string | null;
  workspace: string;
  tokensUsed: number;
};

function evaluatePreflightPolicy(input: PolicyPreflightInput): PolicyDecision {
  const now = new Date();
  const timeOfDay = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return sessions.policies.evaluate({
    ...input,
    timeOfDay,
    concurrency: activeThreads.size
  });
}

function assertPolicyAllowed(decision: PolicyDecision): void {
  if (decision.blocked) throw httpError(decision.reason || "Blocked by a pre-flight policy", 403, "POLICY_BLOCKED");
}

async function enforceResumePolicy(
  threadId: string,
  overrides: { model?: string; reasoningEffort?: string | null; sessionClass?: SessionClass } = {},
  actor = "policy"
): Promise<PolicyDecision> {
  const metadata = sessions.metadataFor(threadId);
  const decision = evaluatePreflightPolicy({
    sessionClass: overrides.sessionClass || metadata.sessionClass,
    model: overrides.model || metadata.model || "unknown",
    reasoningEffort: overrides.reasoningEffort === undefined ? metadata.effort : overrides.reasoningEffort,
    workspace: metadata.cwd || "",
    tokensUsed: admission.usage("run", threadId).totalTokens
  });
  assertPolicyAllowed(decision);
  await sessions.setPolicyWarnings(threadId, decision.warnings, actor);
  return decision;
}

async function fireScheduledSession(schedule: AgentSchedule, run: ScheduleRun): Promise<{ operationId: string }> {
  const manifest = sessions.blueprints.get(schedule.blueprintId, schedule.blueprintVersion);
  if (!manifest) throw new Error("Scheduled blueprint version was not found");
  const { operation } = await acceptSessionCreation({
    cwd: schedule.workspace || projectRoot,
    provider: manifest.definition.model.backend,
    preset: manifest.definition.model.preset,
    model: manifest.definition.model.model,
    reasoningEffort: manifest.definition.model.effort || null,
    name: schedule.name,
    blueprintId: schedule.blueprintId,
    blueprintVersion: schedule.blueprintVersion,
    blueprintVariables: schedule.variables
  }, {
    idempotencyKey: `schedule:${schedule.id}:${run.id}`,
    actor: `schedule:${schedule.id}`,
    mcpActorId: null
  });
  return { operationId: operation.id };
}

async function fireMissionNode(execution: MissionExecution): Promise<{ operationId: string; threadId?: string | null }> {
  const { mission, run, node, inputs } = execution;
  const manifest = sessions.blueprints.get(node.blueprintId, node.blueprintVersion);
  if (!manifest) throw new MissionValidationError(`Blueprint for mission node ${node.id} was not found`);
  const { operation } = await acceptSessionCreation({
    cwd: run.workspace || projectRoot,
    provider: manifest.definition.model.backend,
    preset: manifest.definition.model.preset,
    model: manifest.definition.model.model,
    reasoningEffort: manifest.definition.model.effort || null,
    name: `${mission.name} · ${node.name}`,
    blueprintId: node.blueprintId,
    blueprintVersion: node.blueprintVersion,
    blueprintVariables: inputs
  }, {
    idempotencyKey: `mission:${run.id}:${node.id}`,
    actor: `mission:${mission.id}:${run.id}`,
    mcpActorId: null
  });
  return { operationId: operation.id, threadId: operation.remoteThreadId };
}

async function inspectMissionNode(run: MissionRun, nodeRun: MissionNodeRun): Promise<MissionNodeInspection> {
  if (!nodeRun.operationId) return { state: "failed", error: "Mission node operation is missing" };
  const operation = sessions.getSessionOperation(nodeRun.operationId);
  if (!operation) return { state: "failed", error: "Mission node operation was not found" };
  if (operation.status === "failed") {
    return {
      state: "failed",
      threadId: operation.remoteThreadId,
      error: missionOperationError(operation.error, "Mission node session creation failed")
    };
  }
  if (operation.status !== "succeeded") return { state: "running", threadId: operation.remoteThreadId };
  const threadId = operation.remoteThreadId;
  if (!threadId) return { state: "failed", error: "Mission node session is missing" };
  if (operation.result?.initialTurnStarted === false) {
    const warnings = Array.isArray(operation.result.warnings)
      ? operation.result.warnings.filter((value): value is string => typeof value === "string")
      : [];
    return { state: "failed", threadId, error: warnings[0] || "Mission node did not start its agent turn" };
  }

  const thread = await readSession(threadId, true) as Record<string, unknown>;
  const status = thread.status && typeof thread.status === "object" ? (thread.status as { type?: unknown }).type : null;
  const turns = Array.isArray(thread.turns) ? thread.turns as Array<Record<string, unknown>> : [];
  const lastTurn = turns.at(-1);
  if (status === "active" || lastTurn?.status === "inProgress") return { state: "running", threadId };
  if (status === "systemError") return { state: "failed", threadId, error: "Mission node session entered a system error state" };
  if (!lastTurn) return { state: "running", threadId };
  if (lastTurn.status === "failed" || lastTurn.status === "interrupted") {
    const turnError = lastTurn.error && typeof lastTurn.error === "object"
      ? (lastTurn.error as { message?: unknown }).message
      : null;
    return {
      state: "failed",
      threadId,
      error: typeof turnError === "string" && turnError ? turnError : `Mission node turn ${String(lastTurn.status)}`
    };
  }
  if (lastTurn.status !== "completed") return { state: "running", threadId };
  const completion = sessions.artifactStatus(threadId);
  if (completion.status === "pending") {
    return {
      state: "failed",
      threadId,
      error: `Mission node completion gates were not met: ${completion.unmetGates.map((gate) => gate.name).join(", ")}`
    };
  }
  return {
    state: "completed",
    threadId,
    output: {
      text: missionAgentText(lastTurn),
      threadId,
      artifacts: sessions.listArtifacts(threadId),
      missionRunId: run.id
    }
  };
}

function missionAgentText(turn: Record<string, unknown>): string {
  const items = Array.isArray(turn.items) ? turn.items as Array<Record<string, unknown>> : [];
  for (const item of [...items].reverse()) {
    const type = typeof item.type === "string" ? item.type.toLocaleLowerCase() : "";
    if ((type === "agentmessage" || type === "agent_message" || type === "assistantmessage") && typeof item.text === "string") {
      return item.text;
    }
  }
  return "";
}

function missionOperationError(error: Record<string, unknown> | null, fallback: string): string {
  if (!error) return fallback;
  for (const key of ["message", "error", "code"]) {
    if (typeof error[key] === "string" && error[key]) return error[key] as string;
  }
  return fallback;
}

const EVAL_OPERATION_TIMEOUT_MS = 10 * 60_000;
const EVAL_DEFAULT_RUN_TIMEOUT_MS = 60 * 60_000;

async function runEval(evaluation: EvalRun): Promise<void> {
  sessions.evals.start(evaluation.id, evaluation.version);
  await Promise.all(evaluation.results.map((_result, index) => runEvalModel(evaluation, index)));
  sessions.evals.complete(evaluation.id, evaluation.version);
}

async function runEvalModel(evaluation: EvalRun, index: number): Promise<void> {
  const model = evaluation.results[index]?.model;
  if (!model) throw new Error(`Eval model ${index} was not found`);
  let threadId: string | null = null;
  let startedAt = Date.now();
  sessions.evals.updateResult(evaluation.id, evaluation.version, index, { status: "running", startedAt });
  try {
    const { operation } = await acceptSessionCreation({
      cwd: evaluation.workspace,
      provider: model.provider,
      model: model.model,
      reasoningEffort: model.reasoningEffort,
      leaseMode: "read-only",
      name: `${evaluation.name} · ${model.model}`,
      tags: ["eval"],
      category: "eval",
      blueprintId: evaluation.blueprint.id,
      blueprintVersion: evaluation.blueprint.version,
      blueprintVariables: evaluation.variables
    }, {
      idempotencyKey: `eval:${evaluation.id}:${evaluation.version}:${index}`,
      actor: `eval:${evaluation.id}:v${evaluation.version}`,
      mcpActorId: null,
      workspaceOverride: evaluation.workspace,
      providerOverride: model.provider,
      modelOverride: model.model,
      effortOverride: model.reasoningEffort
    });
    sessions.evals.updateResult(evaluation.id, evaluation.version, index, { operationId: operation.id });
    const completedOperation = await waitForEvalOperation(operation.id, Date.now() + EVAL_OPERATION_TIMEOUT_MS);
    if (completedOperation.status !== "succeeded" || !completedOperation.remoteThreadId) {
      throw new Error(evalOperationFailure(completedOperation));
    }
    threadId = completedOperation.remoteThreadId;
    if (completedOperation.result?.initialTurnStarted !== true) {
      throw new Error("The eval session was created, but its prompt did not start");
    }
    startedAt = Date.now();
    sessions.evals.updateResult(evaluation.id, evaluation.version, index, { threadId, startedAt });
    const deadline = startedAt + (evaluation.successCriteria.maxDurationMs || EVAL_DEFAULT_RUN_TIMEOUT_MS);
    const terminal = await waitForEvalThread(threadId, deadline);
    const completedAt = Date.now();
    const durationMs = Math.max(0, completedAt - startedAt);
    const output = evalOutput(terminal.thread);
    const scoredTurnStatus = terminal.timedOut ? "timedOut" : output.turnStatus;
    const usage = sessions.usageAggregate("run", threadId);
    const gates = sessions.artifactStatus(threadId);
    const score = scoreEval(evaluation.successCriteria, {
      turnStatus: scoredTurnStatus,
      output: output.output,
      durationMs,
      totalTokens: usage.totalTokens,
      blueprintGates: gates
    });
    sessions.evals.updateResult(evaluation.id, evaluation.version, index, {
      status: score.passed ? "passed" : "failed",
      completedAt,
      durationMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      output: output.output,
      error: terminal.timedOut
        ? "Eval model exceeded the duration limit"
        : output.turnStatus === "completed" ? null : `Turn ended with status ${output.turnStatus}`,
      score
    });
  } catch (error) {
    const completedAt = Date.now();
    if (threadId) await stopEvalThread(threadId).catch(() => undefined);
    const usage = threadId ? sessions.usageAggregate("run", threadId) : null;
    sessions.evals.updateResult(evaluation.id, evaluation.version, index, {
      status: "error",
      threadId,
      completedAt,
      durationMs: Math.max(0, completedAt - startedAt),
      inputTokens: usage?.inputTokens || 0,
      outputTokens: usage?.outputTokens || 0,
      totalTokens: usage?.totalTokens || 0,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function waitForEvalOperation(operationId: string, deadline: number): Promise<SessionOperation> {
  while (Date.now() < deadline) {
    const operation = sessions.getSessionOperation(operationId);
    if (!operation) throw new Error("Eval session operation disappeared");
    if (isTerminalOperation(operation)) return operation;
    await evalPollDelay();
  }
  throw new Error("Timed out while creating the eval session");
}

async function waitForEvalThread(threadId: string, deadline: number): Promise<{ thread: Record<string, unknown>; timedOut: boolean }> {
  let latest: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    latest = await readSession(threadId, true);
    const { turnStatus } = evalOutput(latest);
    if (["completed", "failed", "interrupted"].includes(turnStatus)) return { thread: latest, timedOut: false };
    await evalPollDelay();
  }
  if (latest) {
    const { turnStatus } = evalOutput(latest);
    if (["completed", "failed", "interrupted"].includes(turnStatus)) return { thread: latest, timedOut: false };
  }
  await stopEvalThread(threadId).catch(() => undefined);
  await evalPollDelay();
  const terminal = await readSession(threadId, true).catch(() => latest);
  if (!terminal) throw new Error("Eval model exceeded the duration limit");
  return { thread: terminal, timedOut: true };
}

async function stopEvalThread(threadId: string): Promise<void> {
  const turnId = await findActiveTurnId(threadId);
  if (turnId) await codexMutation("turn/interrupt", { threadId, turnId }, 30_000, durableMutationOptions("eval-timeout"));
}

function evalOperationFailure(operation: SessionOperation): string {
  const message = operation.error && typeof operation.error.message === "string" ? operation.error.message : null;
  return message || `Eval session creation ${operation.status}`;
}

function evalPollDelay(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 500);
    timer.unref();
  });
}

async function runComparison(comparison: ComparisonRun): Promise<void> {
  sessions.comparisons.start(comparison.id);
  await Promise.all(comparison.results.map((_result, index) => runComparisonModel(comparison, index)));
  let current = sessions.comparisons.get(comparison.id);
  if (!current) throw new Error("Comparison disappeared while its outputs were running");
  current = sessions.comparisons.setDiffs(current.id, buildComparisonDiffs(current.results));
  if (current.judge) await runComparisonJudge(current);
  sessions.comparisons.complete(comparison.id);
}

async function runComparisonModel(comparison: ComparisonRun, index: number): Promise<void> {
  const result = comparison.results[index];
  if (!result) throw new Error(`Comparison model ${index} was not found`);
  const model = result.model;
  let threadId: string | null = null;
  let startedAt = Date.now();
  sessions.comparisons.updateResult(comparison.id, index, { status: "running", startedAt });
  try {
    const { operation } = await acceptSessionCreation({
      cwd: comparison.workspace,
      provider: model.provider,
      model: model.model,
      reasoningEffort: model.reasoningEffort,
      leaseMode: "read-only",
      prompt: comparison.prompt,
      name: `Comparison · ${model.model}`,
      tags: ["comparison"],
      category: "compare"
    }, {
      idempotencyKey: `compare:${comparison.id}:${result.id}`,
      actor: `compare:${comparison.id}`,
      mcpActorId: null,
      workspaceOverride: comparison.workspace,
      providerOverride: model.provider,
      modelOverride: model.model,
      effortOverride: model.reasoningEffort,
      capacityWaitMs: EVAL_OPERATION_TIMEOUT_MS
    });
    sessions.comparisons.updateResult(comparison.id, index, { operationId: operation.id });
    const completedOperation = await waitForEvalOperation(operation.id, Date.now() + EVAL_OPERATION_TIMEOUT_MS);
    if (completedOperation.status !== "succeeded" || !completedOperation.remoteThreadId) {
      throw new Error(evalOperationFailure(completedOperation));
    }
    threadId = completedOperation.remoteThreadId;
    if (completedOperation.result?.initialTurnStarted !== true) {
      throw new Error("The comparison session was created, but its prompt did not start");
    }
    startedAt = Date.now();
    sessions.comparisons.updateResult(comparison.id, index, { threadId, startedAt });
    const terminal = await waitForEvalThread(threadId, startedAt + EVAL_DEFAULT_RUN_TIMEOUT_MS);
    const completedAt = Date.now();
    const output = evalOutput(terminal.thread);
    const usage = sessions.usageAggregate("run", threadId);
    const terminalError = terminal.timedOut
      ? "Comparison model exceeded the run time limit"
      : output.turnStatus === "completed" ? null : `Turn ended with status ${output.turnStatus}`;
    sessions.comparisons.updateResult(comparison.id, index, {
      status: terminalError ? "error" : "completed",
      completedAt,
      durationMs: Math.max(0, completedAt - startedAt),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      output: output.output,
      error: terminalError
    });
  } catch (error) {
    const completedAt = Date.now();
    if (threadId) await stopEvalThread(threadId).catch(() => undefined);
    const usage = threadId ? sessions.usageAggregate("run", threadId) : null;
    sessions.comparisons.updateResult(comparison.id, index, {
      status: "error",
      threadId,
      completedAt,
      durationMs: Math.max(0, completedAt - startedAt),
      inputTokens: usage?.inputTokens || 0,
      outputTokens: usage?.outputTokens || 0,
      totalTokens: usage?.totalTokens || 0,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function runComparisonJudge(comparison: ComparisonRun): Promise<void> {
  if (!comparison.judge) return;
  const model = comparison.judge.model;
  const judgePrompt = buildComparisonJudgePrompt(comparison);
  let threadId: string | null = null;
  let startedAt = Date.now();
  sessions.comparisons.startJudge(comparison.id);
  try {
    const { operation } = await acceptSessionCreation({
      cwd: comparison.workspace,
      provider: model.provider,
      model: model.model,
      reasoningEffort: model.reasoningEffort,
      leaseMode: "read-only",
      prompt: judgePrompt,
      name: `Comparison judge · ${model.model}`,
      tags: ["comparison", "judge"],
      category: "compare"
    }, {
      idempotencyKey: `compare:${comparison.id}:judge`,
      actor: `compare:${comparison.id}:judge`,
      mcpActorId: null,
      workspaceOverride: comparison.workspace,
      providerOverride: model.provider,
      modelOverride: model.model,
      effortOverride: model.reasoningEffort,
      capacityWaitMs: EVAL_OPERATION_TIMEOUT_MS
    });
    sessions.comparisons.updateJudge(comparison.id, { operationId: operation.id });
    const completedOperation = await waitForEvalOperation(operation.id, Date.now() + EVAL_OPERATION_TIMEOUT_MS);
    if (completedOperation.status !== "succeeded" || !completedOperation.remoteThreadId) {
      throw new Error(evalOperationFailure(completedOperation));
    }
    threadId = completedOperation.remoteThreadId;
    if (completedOperation.result?.initialTurnStarted !== true) {
      throw new Error("The judge session was created, but its prompt did not start");
    }
    startedAt = Date.now();
    sessions.comparisons.updateJudge(comparison.id, { threadId, startedAt });
    const terminal = await waitForEvalThread(threadId, startedAt + EVAL_DEFAULT_RUN_TIMEOUT_MS);
    const completedAt = Date.now();
    const output = evalOutput(terminal.thread);
    const usage = sessions.usageAggregate("run", threadId);
    if (terminal.timedOut) throw new Error("Comparison judge exceeded the run time limit");
    if (output.turnStatus !== "completed") throw new Error(`Judge turn ended with status ${output.turnStatus}`);
    const verdict = parseComparisonJudgeVerdict(output.output, comparison.results.map((result) => result.id));
    sessions.comparisons.updateJudge(comparison.id, {
      status: "completed",
      completedAt,
      durationMs: Math.max(0, completedAt - startedAt),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      output: output.output,
      error: null,
      verdict
    });
  } catch (error) {
    const completedAt = Date.now();
    if (threadId) await stopEvalThread(threadId).catch(() => undefined);
    const usage = threadId ? sessions.usageAggregate("run", threadId) : null;
    const latestOutput = threadId
      ? await readSession(threadId, true).then((thread) => evalOutput(thread).output).catch(() => "")
      : "";
    sessions.comparisons.updateJudge(comparison.id, {
      status: "error",
      threadId,
      completedAt,
      durationMs: Math.max(0, completedAt - startedAt),
      inputTokens: usage?.inputTokens || 0,
      outputTokens: usage?.outputTokens || 0,
      totalTokens: usage?.totalTokens || 0,
      output: latestOutput,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function parseSessionCreation(value: unknown): SessionCreationInput {
  const result = createSessionRequestSchema.safeParse(value);
  if (!result.success) throw httpError(result.error.issues[0]?.message || "Invalid session request", 400, "INVALID_SESSION_REQUEST");
  const input = result.data;
  const source = value as Record<string, unknown>;
  const cwd = input.cwd;
  const backend = input.provider;
  const sessionClass = input.sessionClass;
  const requestedModel = input.model || null;
  const model = sessionClass === "spark"
    ? "gpt-5.3-codex-spark"
    : requestedModel || (() => { throw httpError("Model is required", 400, "INVALID_MODEL"); })();
  // Infer Spark only when the client omitted class; an explicit standard class
  // must remain standard even when it selects the Spark model.
  const effectiveClass: SessionClass = !Object.prototype.hasOwnProperty.call(source, "class")
    && !Object.prototype.hasOwnProperty.call(source, "sessionClass")
    && sessionClass === "standard"
    && model === "gpt-5.3-codex-spark"
    ? "spark"
    : sessionClass;
  const effort = effectiveClass === "spark" ? "high" : input.reasoningEffort;
  const prompt = input.prompt || null;
  const explicitName = input.name || null;
  const name = singleLine(explicitName || deriveSessionName(prompt), "Name");
  const tags = input.tags;
  const categoryValue = input.category || null;
  const category = categoryValue ? singleLine(categoryValue, "Category") : null;
  const blueprintId = input.blueprintId || null;
  if (blueprintId && !/^[a-zA-Z0-9._:-]+$/.test(blueprintId)) throw httpError("Blueprint ID contains invalid characters", 400, "INVALID_BLUEPRINT_ID");
  const blueprintVersion = input.blueprintVersion || null;
  const blueprintEnvironment = blueprintId
    ? input.blueprintEnvironment || "local"
    : null;
  if (blueprintEnvironment && !/^[a-zA-Z0-9._:-]+$/.test(blueprintEnvironment)) {
    throw httpError("Blueprint environment contains invalid characters", 400, "INVALID_BLUEPRINT_ENVIRONMENT");
  }
  const blueprintVariables = input.blueprintVariables || null;
  if (!blueprintId && (blueprintVersion || blueprintVariables || input.blueprintEnvironment !== undefined)) {
    throw httpError("Blueprint run settings require a blueprint ID", 400, "INVALID_BLUEPRINT_RUN");
  }
  const admissionPolicy = parseDeclaredAdmissionPolicy(input.admissionPolicy);
  const projection = parseAdmissionProjection(input.projection);
  const guardianPolicy = input.guardian ? guardianPolicyFromRequest(input.guardian) : null;
  return {
    cwd, backend, sessionClass: effectiveClass, preset: input.preset || null, model, effort, yolo: input.yolo,
    leaseMode: input.leaseMode, fileScope: input.fileScope || null,
    name, prompt, tags, category, blueprintId, blueprintVersion, blueprintEnvironment,
    blueprintVariables, admissionPolicy, projection, guardianPolicy
  };
}

function applyBlueprintToSession(input: SessionCreationInput, resolved: ResolvedBlueprintRun): SessionCreationInput {
  const definition = resolved.manifest.definition;
  let cwd = input.cwd;
  if (definition.workspace.selector === "fixed") cwd = definition.workspace.value || cwd;
  if (definition.workspace.selector === "variable") {
    const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(definition.workspace.value || "");
    const selected = match ? resolved.variables[match[1]] : undefined;
    if (typeof selected !== "string" || !selected.trim()) {
      throw httpError("Blueprint workspace variable must resolve to a path", 400, "INVALID_BLUEPRINT_WORKSPACE");
    }
    cwd = selected;
  }
  const backend = definition.model.backend;
  const mode = definition.approvals.mode;
  const guardianPolicy = definition.guardian
    ? guardianPolicyFromRequest(definition.guardian)
    : input.guardianPolicy;
  if (guardianPolicy && !guardianPolicy.escalationModel) {
    guardianPolicy.escalationModel = definition.model.fallbacks?.find((target) => target.backend === backend)?.model || null;
  }
  return {
    ...input,
    cwd,
    backend,
    sessionClass: definition.model.model === "gpt-5.3-codex-spark" ? "spark" : "standard",
    preset: definition.model.preset || null,
    model: definition.model.model,
    effort: definition.model.effort || null,
    prompt: resolved.prompt || null,
    yolo: mode === "never",
    leaseMode: mode === "plan" ? "read-only" : input.leaseMode,
    blueprintId: resolved.manifest.id,
    blueprintVersion: resolved.manifest.version,
    guardianPolicy
  };
}

function parseMessageInput(value: unknown): {
  text: string;
  model: string;
  effort: string | null;
  admissionPolicy: DeclaredExhaustionPolicy | null;
  projection: AdmissionProjection | null;
} {
  const result = messageRequestSchema.safeParse(value);
  if (!result.success) throw httpError(result.error.issues[0]?.message || "Invalid message request", 400, "INVALID_MESSAGE_REQUEST");
  const input = result.data;
  return {
    text: input.text,
    model: input.model,
    effort: input.reasoningEffort,
    admissionPolicy: parseDeclaredAdmissionPolicy(input.admissionPolicy),
    projection: parseAdmissionProjection(input.projection)
  };
}

function parseDeclaredAdmissionPolicy(value: unknown): DeclaredExhaustionPolicy | null {
  if (value === undefined || value === null) return null;
  assertObject(value, "Admission policy");
  assertAllowedKeys(value, ["action", "approved", "target"]);
  const action = enumBody(value.action, ["wait", "pause", "downgrade", "fallback"] as const, "wait");
  if (value.approved !== undefined && typeof value.approved !== "boolean") throw httpError("Admission approval must be a boolean", 400, "INVALID_ADMISSION_POLICY");
  let target: { provider: UsageProvider; model: string } | undefined;
  if (value.target !== undefined && value.target !== null) {
    assertObject(value.target, "Admission target");
    assertAllowedKeys(value.target, ["provider", "model"]);
    target = {
      provider: enumBody(value.target.provider, ["codex", "spark"] as const, "codex"),
      model: boundedString(value.target.model, "Admission target model", 128)
    };
  }
  if ((action === "downgrade" || action === "fallback") && (value.approved !== true || !target)) {
    throw httpError(`${action} requires approved=true and an explicit provider/model target`, 400, "ADMISSION_APPROVAL_REQUIRED");
  }
  if ((action === "wait" || action === "pause") && target) {
    throw httpError(`${action} admission policies cannot declare a switch target`, 400, "INVALID_ADMISSION_POLICY");
  }
  return { action, approved: value.approved === true, ...(target ? { target } : {}) };
}

function parseAdmissionProjection(value: unknown): AdmissionProjection | null {
  if (value === undefined || value === null) return null;
  assertObject(value, "Admission projection");
  assertAllowedKeys(value, ["requestCount", "totalTokens", "estimatedCostMicros"]);
  const projection: AdmissionProjection = {};
  for (const key of ["requestCount", "totalTokens", "estimatedCostMicros"] as const) {
    if (value[key] === undefined) continue;
    const number = Number(value[key]);
    if (!Number.isSafeInteger(number) || number < 0) throw httpError(`Admission projection ${key} must be a non-negative integer`, 400, "INVALID_ADMISSION_PROJECTION");
    projection[key] = number;
  }
  return Object.keys(projection).length ? projection : null;
}

function guardianPolicyFromRequest(value: unknown): RunGuardianPolicy {
  assertObject(value, "Guardian policy");
  assertAllowedKeys(value, ["stallTimeoutMinutes", "escalationModel"]);
  const stallTimeoutMinutes = Number(value.stallTimeoutMinutes);
  if (!Number.isSafeInteger(stallTimeoutMinutes) || stallTimeoutMinutes < 1 || stallTimeoutMinutes > 24 * 60) {
    throw httpError("Guardian stall timeout must be between 1 and 1440 minutes", 400, "INVALID_GUARDIAN_POLICY");
  }
  const escalationModel = value.escalationModel === undefined || value.escalationModel === null
    ? null
    : boundedString(value.escalationModel, "Guardian escalation model", 128);
  return { stallTimeoutMs: stallTimeoutMinutes * 60_000, escalationModel };
}

function parseBudgetInput(value: unknown): {
  scopeType: BudgetScopeType;
  scopeId: string;
  softLimit: BudgetLimit | null;
  hardLimit: BudgetLimit | null;
  exhaustionPolicy: "wait" | "pause" | "downgrade" | "fallback";
} {
  assertObject(value, "Request body");
  assertAllowedKeys(value, ["scopeType", "scopeId", "softLimit", "hardLimit", "exhaustionPolicy"]);
  const softLimit = parseBudgetLimit(value.softLimit, "Soft budget");
  const hardLimit = parseBudgetLimit(value.hardLimit, "Hard budget");
  if (softLimit && hardLimit) {
    for (const key of ["requestCount", "totalTokens", "estimatedCostMicros"] as const) {
      if (softLimit[key] !== undefined && hardLimit[key] !== undefined && softLimit[key]! > hardLimit[key]!) {
        throw httpError(`Soft ${key} budget must not exceed the hard budget`, 400, "INVALID_BUDGET");
      }
    }
  }
  return {
    scopeType: enumBody(value.scopeType, ["run", "blueprint", "workspace"] as const, "run"),
    scopeId: boundedString(value.scopeId, "Budget scope ID", 4_096),
    softLimit,
    hardLimit,
    exhaustionPolicy: enumBody(value.exhaustionPolicy, ["wait", "pause", "downgrade", "fallback"] as const, "wait")
  };
}

function parseBudgetLimit(value: unknown, label: string): BudgetLimit | null {
  if (value === undefined || value === null) return null;
  assertObject(value, label);
  assertAllowedKeys(value, ["requestCount", "totalTokens", "estimatedCostMicros"]);
  const limit: BudgetLimit = {};
  for (const key of ["requestCount", "totalTokens", "estimatedCostMicros"] as const) {
    if (value[key] === undefined) continue;
    const number = Number(value[key]);
    if (!Number.isSafeInteger(number) || number < 0) throw httpError(`${label} ${key} must be a non-negative integer`, 400, "INVALID_BUDGET");
    limit[key] = number;
  }
  return Object.keys(limit).length ? limit : null;
}

function parseThreadIds(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || !value.length) throw httpError("Thread ids are required", 400, "INVALID_THREAD_IDS");
  if (value.length > maximum) throw httpError(`At most ${maximum} sessions can be processed at once`, 400, "TOO_MANY_THREAD_IDS");
  return [...new Set(value.map((threadId) => typeof threadId === "string" ? validThreadId(threadId) : (() => { throw httpError("Invalid thread id", 400, "INVALID_THREAD_ID"); })()))];
}

function threadIdsQuery(req: Request, maximum: number): string[] {
  const raw = req.query.threadIds;
  const values = (Array.isArray(raw) ? raw : [raw])
    .flatMap((value) => typeof value === "string" ? value.split(",") : [])
    .map((value) => value.trim())
    .filter(Boolean);
  return parseThreadIds(values, maximum);
}

function enumBody<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) throw httpError(`Value must be one of: ${allowed.join(", ")}`, 400, "INVALID_ENUM");
  return value as T;
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw httpError(`${label} must be a JSON object`, 400, "INVALID_BODY");
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length) throw httpError(`Unknown request field${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`, 400, "UNKNOWN_FIELDS");
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) throw httpError(`${label} is required`, 400, "INVALID_STRING");
  if (value.length > maximum) throw httpError(`${label} must be ${maximum.toLocaleString()} characters or fewer`, 400, "VALUE_TOO_LONG");
  return value.trim();
}

function optionalBoundedString(value: unknown, label: string, maximum: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw httpError(`${label} must be a string`, 400, "INVALID_STRING");
  if (value.length > maximum) throw httpError(`${label} must be ${maximum.toLocaleString()} characters or fewer`, 400, "VALUE_TOO_LONG");
  return value.trim() || null;
}

function singleLine(value: string, label: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw httpError(`${label} cannot contain control characters`, 400, "INVALID_STRING");
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw httpError(`${label} is required`, 400);
  return value.trim();
}

function mcpRequestAllowed(req: Request, actorId: string): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
  if (req.method === "POST" && req.path === "/threads") return true;
  if (req.method === "POST" && [
    "/mcp/actors/current/rotate",
    "/mcp/handoffs",
    "/mcp/owned-threads/handoff",
    "/mcp/owned-threads/claim"
  ].includes(req.path)) return true;
  if (req.method === "DELETE" && req.path === "/mcp/actors/current") return true;
  const match = /^\/threads\/([a-zA-Z0-9_-]{8,128})(?:\/|$)/.exec(req.path);
  if (match) return mcpAccess.ownsThread(actorId, match[1]);
  const sessionMatch = /^\/sessions\/([a-zA-Z0-9_-]{8,128})\/(?:guardian|artifacts)(?:\/|$)/.exec(req.path);
  return sessionMatch ? mcpAccess.ownsThread(actorId, sessionMatch[1]) : false;
}

function currentMcpActorId(res: Response): string {
  const actorId = res.locals.mcpActorId;
  if (typeof actorId !== "string" || !actorId) throw httpError("A valid MCP actor credential is required", 401, "MCP_CREDENTIAL_REQUIRED");
  return actorId;
}

function requestAuditActor(res: Response): string {
  const actorId = res.locals.mcpActorId;
  return typeof actorId === "string" && actorId ? `mcp:${actorId}` : "user";
}

function mcpClientId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw httpError("MCP clientId must contain 1-128 letters, numbers, dots, colons, underscores, or hyphens", 400, "INVALID_MCP_CLIENT_ID");
  }
  return value;
}

function sseSessionId(req: Request, res: Response): string {
  const sessionId = typeof res.locals.authSessionId === "string" ? res.locals.authSessionId : null;
  if (!sessionId) throw httpError("Authentication required", 401, "AUTH_REQUIRED");
  if (auth.enabled) return sessionId;
  const identity = config.trustProxy ? req.ip || req.socket.remoteAddress || "unknown" : req.socket.remoteAddress || "unknown";
  return `authentication-disabled:${crypto.createHash("sha256").update(identity).digest("base64url")}`;
}

function validSseClientId(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw httpError("Invalid SSE client id", 400, "INVALID_SSE_CLIENT_ID");
  }
  return value;
}

function sseThreadSubscriptions(value: unknown): string[] {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.length > MAX_SSE_THREAD_SUBSCRIPTIONS || values.some((threadId) => typeof threadId !== "string")) {
    throw httpError(`threadId must contain at most ${MAX_SSE_THREAD_SUBSCRIPTIONS} valid entries`, 400, "INVALID_SSE_SUBSCRIPTIONS");
  }
  return [...new Set((values as string[]).map(validThreadId))];
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw httpError("Command arguments must be a string", 400, "INVALID_ARGUMENTS");
  return value.trim() || null;
}

function validThreadId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(value)) throw httpError("Invalid thread id", 400, "INVALID_THREAD_ID");
  return value;
}

function validOperationId(value: string): string {
  if (!/^[a-f0-9-]{36}$/.test(value)) throw httpError("Invalid operation id", 400, "INVALID_OPERATION_ID");
  return value;
}

function validEvalId(value: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) {
    throw httpError("Invalid eval id", 400, "INVALID_EVAL_ID");
  }
  return value;
}

function validComparisonId(value: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) {
    throw httpError("Invalid comparison id", 400, "INVALID_COMPARISON_ID");
  }
  return value;
}

function validKnowledgePackId(value: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) {
    throw httpError("Invalid knowledge pack id", 400, "INVALID_KNOWLEDGE_PACK_ID");
  }
  return value;
}

function requestIdempotencyKey(req: Request): string {
  const raw = req.get("Idempotency-Key");
  const key = raw === undefined ? crypto.randomUUID() : raw.trim();
  if (!key || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw httpError("Idempotency-Key must contain between 1 and 200 visible characters", 400, "INVALID_IDEMPOTENCY_KEY");
  }
  return key;
}

function operationResource(operation: SessionOperation): Record<string, unknown> {
  const {
    savedQueue,
    baselineThreadIds,
    remoteThreadSnapshot: _remoteThreadSnapshot,
    ...publicCompensation
  } = operation.compensation;
  return {
    id: operation.id,
    kind: operation.kind,
    idempotencyKey: operation.idempotencyKey,
    status: operation.status,
    currentStep: operation.step,
    remoteThreadId: operation.remoteThreadId,
    attemptCount: operation.attemptCount,
    compensation: {
      ...publicCompensation,
      ...(Array.isArray(savedQueue) ? { savedQueueDepth: savedQueue.length } : {}),
      ...(Array.isArray(baselineThreadIds) ? { discoveryBaselineSize: baselineThreadIds.length } : {})
    },
    terminal: isTerminalOperation(operation),
    result: operation.result,
    error: operation.error,
    nextAttemptAt: operation.nextAttemptAt,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    completedAt: operation.completedAt,
    links: { self: `/api/operations/${operation.id}` }
  };
}

function validAdapterThreadId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(value)) throw httpError("Codex returned an invalid session id", 502, "INVALID_CODEX_RESPONSE");
  return value;
}

function stringQuery(req: Request, name: string): string | undefined {
  const value = req.query[name];
  return typeof value === "string" && value ? value : undefined;
}

function numberQuery(req: Request, name: string, fallback: number, min: number, max: number): number {
  const value = Number(req.query[name] ?? fallback);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

function optionalPositiveIntegerQuery(req: Request, name: string): number | undefined {
  const value = req.query[name];
  if (value === undefined || value === "") return undefined;
  return optionalPositiveInteger(value, name) || undefined;
}

function optionalPositiveInteger(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw httpError(`${label} must be a positive integer`, 400, "INVALID_INTEGER");
  return number;
}

function enumQuery<T extends string>(req: Request, name: string, values: readonly T[], fallback: T): T {
  const value = req.query[name];
  return typeof value === "string" && values.includes(value as T) ? value as T : fallback;
}

function optionalEnumQuery<T extends string>(req: Request, name: string, values: readonly T[]): T | undefined {
  const value = req.query[name];
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !values.includes(value as T)) throw httpError(`${name} must be one of: ${values.join(", ")}`, 400, "INVALID_QUERY");
  return value as T;
}

function dateQuery(req: Request, name: string, endOfDay: boolean): number | undefined {
  const value = req.query[name];
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw httpError(`${name} must be an ISO date`, 400, "INVALID_QUERY");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw httpError(`${name} must be an ISO date`, 400, "INVALID_QUERY");
  return endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value) ? timestamp + 24 * 60 * 60_000 - 1 : timestamp;
}

type ErrorContext = { requestId?: string | null; scope?: ErrorScope; sessionId?: string | null };

function normalizeHttpError(error: unknown): SerializedForgeDeckError {
  return publicError(error);
}

/** The only provider/adapter-to-public translation boundary. */
function publicError(error: unknown, context: ErrorContext = {}): SerializedForgeDeckError {
  const requestId = context.requestId || requestOperationScope.getStore()?.requestId || crypto.randomUUID();
  return serializeError(translateBoundaryError(error, requestId), {
    requestId,
    scope: context.scope,
    sessionId: context.sessionId
  });
}

function translateBoundaryError(error: unknown, requestId: string): ForgeDeckError {
  if (error instanceof ForgeDeckError) {
    if (!error.requestId) error.requestId = requestId;
    return error;
  }
  if (error instanceof SessionOperationConflictError) {
    return new ConflictError(error.message, { code: "IDEMPOTENCY_KEY_REUSED", requestId, scope: "sessions" });
  }
  if (error instanceof ArtifactValidationError) {
    return new ValidationError(error.message, { code: "INVALID_ARTIFACT", requestId, scope: "sessions" });
  }
  if (error instanceof PathError) {
    const options = { cause: error, code: "INVALID_PATH", requestId, status: error.status, scope: "workspace" as const };
    return error.status === 404 ? new NotFoundError(error.message, options) : new ValidationError(error.message, options);
  }
  if (error instanceof CapacityUnavailableError) {
    return new CapacityError("The selected backend is at capacity", {
      cause: error,
      code: error.code,
      requestId,
      retryAfter: error.retryAfter,
      scope: "sessions"
    });
  }
  if (error instanceof CapacityCancelledError) {
    return new ConflictError("The capacity request was cancelled", {
      cause: error,
      code: error.code,
      requestId,
      status: error.status,
      scope: "sessions"
    });
  }
  if (error instanceof CodexUnavailableError) {
    return new BackendUnavailableError("Codex runtime is temporarily unavailable", {
      cause: error,
      code: "CODEX_UNAVAILABLE",
      requestId,
      retryable: !error.dispatched,
      retryAfter: !error.dispatched ? 2 : undefined,
      scope: "runtime"
    });
  }
  if (error instanceof CodexRpcError) return translateCodexRpcError(error, requestId);
  if (error instanceof CodexBridgeError) {
    const timedOut = error.code === "TIMEOUT" || error.code === "HEARTBEAT_TIMEOUT";
    const retryable = error.transient && !error.dispatched;
    return new BackendUnavailableError(timedOut ? "Codex runtime did not respond in time" : "Codex runtime could not complete the request", {
      cause: error,
      code: timedOut ? "CODEX_TIMEOUT" : "CODEX_UNAVAILABLE",
      requestId,
      retryable,
      retryAfter: retryable ? 2 : undefined,
      status: timedOut ? 504 : 503,
      scope: "runtime"
    });
  }
  const candidate = error as { status?: unknown; code?: unknown; type?: unknown; retryAfter?: unknown };
  if (candidate?.type === "entity.parse.failed") {
    return new ValidationError("Invalid JSON request body", { cause: error, code: "INVALID_JSON", requestId });
  }
  const status = Number(candidate?.status);
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    const message = error instanceof Error && status < 500 ? error.message : status >= 500 ? "Unexpected server error" : "Request failed";
    const code = typeof candidate.code === "string" ? candidate.code : undefined;
    const retryAfter = Number(candidate.retryAfter);
    return errorForStatus(message, status, code, error, requestId, retryAfter);
  }
  return new InternalError("Unexpected server error", { cause: error, requestId });
}

function translateCodexRpcError(error: CodexRpcError, requestId: string): ForgeDeckError {
  const providerCode = providerErrorCode(error.data);
  if (error.code === -32602 || providerCode === "INVALID_ARGUMENT" || providerCode === "INVALID_REQUEST") {
    return new ValidationError("Codex rejected an invalid request", { cause: error, code: "INVALID_CODEX_REQUEST", requestId, scope: "sessions" });
  }
  if (providerCode === "THREAD_NOT_FOUND" || providerCode === "SESSION_NOT_FOUND") {
    return new NotFoundError("Session not found", { cause: error, code: "SESSION_NOT_FOUND", requestId, scope: "sessions" });
  }
  if (providerCode === "ALREADY_ACTIVE" || providerCode === "SESSION_CONFLICT") {
    return new ConflictError("The session state changed before the request completed", { cause: error, code: "SESSION_CONFLICT", requestId, scope: "sessions" });
  }
  return new BackendUnavailableError("Codex runtime rejected the request", {
    cause: error,
    code: "CODEX_REQUEST_FAILED",
    requestId,
    retryable: error.transient && !error.dispatched,
    retryAfter: error.transient && !error.dispatched ? 2 : undefined,
    status: error.transient ? 503 : 502,
    scope: "runtime"
  });
}

function providerErrorCode(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const code = (data as Record<string, unknown>).code;
  return typeof code === "string" ? code.toUpperCase() : null;
}

function errorForStatus(
  message: string,
  status: number,
  code: string | undefined,
  cause: unknown,
  requestId: string,
  retryAfter: number
): ForgeDeckError {
  const options = { cause, code, requestId, status, ...(retryAfter > 0 ? { retryAfter } : {}) };
  if (status === 404) return new NotFoundError(message, options);
  if (status === 409 || status === 499) return new ConflictError(message, options);
  if (status === 429) return new CapacityError(message, options);
  if (status === 503 || status === 504) return new BackendUnavailableError(message, options);
  if (status >= 500) return new InternalError(message, { ...options, retryable: false });
  return new ValidationError(message, options);
}

function readPackageVersion(): string {
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")) as { version?: unknown };
    return typeof metadata.version === "string" && metadata.version ? metadata.version : "unknown";
  } catch {
    return "unknown";
  }
}

function httpError(message: string, status: number, code = "REQUEST_FAILED"): ForgeDeckError {
  return errorForStatus(message, status, code, undefined, requestOperationScope.getStore()?.requestId || crypto.randomUUID(), 0);
}

function blueprintHttpError(error: unknown): unknown {
  if (error instanceof BlueprintValidationError) return httpError(error.message, 400, "INVALID_BLUEPRINT");
  if (error instanceof BlueprintConflictError) return httpError(error.message, 409, "BLUEPRINT_VERSION_CONFLICT");
  return error;
}

function scheduleHttpError(error: unknown): unknown {
  if (error instanceof ScheduleValidationError) {
    const notFound = error.message.endsWith("was not found");
    return httpError(error.message, notFound ? 404 : 400, notFound ? "SCHEDULE_NOT_FOUND" : "INVALID_SCHEDULE");
  }
  if (error instanceof ScheduleConflictError) return httpError(error.message, 409, "SCHEDULE_CONFLICT");
  return blueprintHttpError(error);
}

function missionHttpError(error: unknown): unknown {
  if (error instanceof MissionValidationError) {
    const notFound = error.message.endsWith("was not found");
    return httpError(error.message, notFound ? 404 : 400, notFound ? "MISSION_NOT_FOUND" : "INVALID_MISSION");
  }
  if (error instanceof MissionConflictError) return httpError(error.message, 409, "MISSION_CONFLICT");
  return blueprintHttpError(error);
}

function requestErrorScope(pathname: string): ErrorScope {
  if (pathname.startsWith("/api/auth") || pathname.startsWith("/api/login") || pathname.startsWith("/api/logout")) return "authentication";
  if (pathname.startsWith("/api/threads") || pathname.startsWith("/api/queues") || pathname.startsWith("/api/schedules") || pathname.startsWith("/api/missions") || pathname.startsWith("/api/evals") || pathname.startsWith("/api/compare")) return "sessions";
  if (pathname.startsWith("/api/directories") || pathname.startsWith("/api/files")) return "workspace";
  if (pathname.startsWith("/api/approvals")) return "approvals";
  if (pathname.startsWith("/api/account") || pathname.startsWith("/api/bootstrap") || pathname.startsWith("/api/health")) return "runtime";
  return "api";
}

function requestSessionId(req: Request): string | null {
  if (typeof req.params.threadId === "string") return req.params.threadId;
  const match = /^\/api\/threads\/([a-zA-Z0-9_-]{8,128})(?:\/|$)/.exec(req.path);
  return match?.[1] || null;
}

function listenAddresses(listenHost: string, listenPort: number): string[] {
  const normalized = listenHost.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1" || (isIP(normalized) === 4 && Number(normalized.split(".", 1)[0]) === 127)) {
    const formatted = normalized.includes(":") ? `[${normalized}]` : normalized;
    return [`http://${formatted}:${listenPort}`];
  }
  const values = new Set<string>();
  if (normalized !== "0.0.0.0" && normalized !== "::") {
    const formatted = normalized.includes(":") ? `[${normalized}]` : normalized;
    values.add(`http://${formatted}:${listenPort}`);
  }
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const address of interfaces || []) {
      if (address.family === "IPv4" && !address.internal) values.add(`http://${address.address}:${listenPort}`);
    }
  }
  return [...values];
}
