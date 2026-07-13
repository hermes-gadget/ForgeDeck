import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { ApiProfiler } from "./api-profiler.js";
import { AsyncTtlCache } from "./async-cache.js";
import { AuthManager } from "./auth.js";
import { CodexBridge, CodexBridgeError, CodexRpcError, CodexUnavailableError, type ServerRequest } from "./codex-bridge.js";
import { loadConfig } from "./config.js";
import { createCorsMiddleware } from "./cors.js";
import { ExternalCodexMonitor } from "./external-monitor.js";
import { logger } from "./logger.js";
import { McpAccessManager } from "./mcp-access.js";
import { PathError, WorkspacePaths } from "./paths.js";
import { createRateLimiter } from "./rate-limit.js";
import { SessionManager, deriveSessionName, isSessionExpired } from "./session-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const config = loadConfig(projectRoot);
const { dataDir, distDir, host, port } = config;
const auth = new AuthManager(dataDir, config.cookieSecure);
const mcpAccess = new McpAccessManager(dataDir);
const sessions = new SessionManager(dataDir);
const workspaces = await WorkspacePaths.create();
const codex = new CodexBridge();
const app = express();
const profiler = new ApiProfiler(config.slowRequestMs, (message) => logger.warn(message));
const sseClients = new Set<Response>();
let externalMonitor: ExternalCodexMonitor | null = null;
let unavailableThreadIds = new Set<string>();
let reconciledInventoryIds: Set<string> | null = null;
type QueuedMessage = { id: string; text: string; model: string; effort: string | null; createdAt: number };
const queueFile = path.join(dataDir, "message-queues.json");
const messageQueues = loadMessageQueues();
type ThreadPolicy = "workspace-write" | "yolo";
const policyFile = path.join(dataDir, "thread-policies.json");
const threadPolicies = loadThreadPolicies();
const activeThreads = new Set<string>();
type ActivitySource = "bridge" | "external";
const activeThreadSources = new Map<string, Set<ActivitySource>>();
const activeTurnIds = new Map<string, string>();
const deadProcessThreadIds = new Set<string>();
const drainingQueues = new Set<string>();
const bridgeOwnedThreads = new Set<string>();
const capacityBuffers = new Map<string, string>();
const capacityHandledThreads = new Set<string>();
const knownThreadIds = new Set<string>();
const archivingThreadIds = new Set<string>();
type ArchiveJob = { threadId: string; reason: string; actor: string; attempts: number; acceptedAt: number; lastError: string | null };
const archiveQueue: ArchiveJob[] = [];
let archiveWorkerRunning = false;
let archiveRetryTimer: NodeJS.Timeout | null = null;
const sessionTtlMs = config.sessionTtlMs;
type LiveThreadState = {
  items: Record<string, Record<string, unknown>>;
  agentText: Record<string, string>;
  toolOutput: Record<string, string>;
  active: boolean;
  completedAt: number | null;
  updatedAt: number;
};
const liveThreadStates = new Map<string, LiveThreadState>();
const allowedCorsOrigins = config.trustedOrigins;
type ModelListResponse = { data: Array<{ id: string; model: string; supportedReasoningEfforts: Array<{ reasoningEffort: string }> }> };
const modelCache = new AsyncTtlCache<ModelListResponse>(config.modelCacheTtlMs);
const apiRateLimiter = createRateLimiter({
  windowMs: config.apiRateWindowMs,
  max: config.apiRateLimit
});

app.disable("x-powered-by");
if (config.trustProxy) app.set("trust proxy", 1);
app.use(requestLogger);
app.use(profiler.middleware);
app.use(securityHeaders);
app.use(createCorsMiddleware(allowedCorsOrigins));
app.use(express.json({ limit: "256kb" }));
app.use("/api", apiRateLimiter);

app.get("/api/auth", (req, res) => res.json({ authenticated: auth.isAuthenticated(req) }));
app.post("/api/login", (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  const result = auth.login(req.ip || req.socket.remoteAddress || "unknown", token);
  if (!result.ok) {
    if (result.retryAfter) res.setHeader("Retry-After", result.retryAfter);
    res.status(result.retryAfter ? 429 : 401).json({ error: result.retryAfter ? "Too many attempts. Try again later." : "Incorrect access key" });
    return;
  }
  auth.setCookie(req, res, result.sessionId!);
  res.json({ ok: true });
});

app.post("/api/mcp/actors", mcpAccess.requireBootstrap, (_req, res) => {
  res.status(201).json(mcpAccess.registerActor());
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
  const degraded = !runtime.available || monitor.state === "degraded" || storage.status !== "ok";
  res.json({
    status: degraded ? "degraded" : "ok",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    subsystems: {
      api: { status: "ok" },
      codex: { status: runtime.available ? "ok" : "unavailable", ...runtime },
      externalMonitor: { status: monitor.available ? "ok" : monitor.state, ...monitor },
      workspaces: { status: "ok", roots: workspaces.roots.length },
      storage,
      sessions: {
        status: "ok",
        active: activeThreads.size,
        queuedMessages: [...messageQueues.values()].reduce((total, queue) => total + queue.length, 0),
        drainingQueues: drainingQueues.size,
        pendingArchives: archivingThreadIds.size,
        ttlHours: sessionTtlMs > 0 ? sessionTtlMs / 3_600_000 : null
      },
      events: { status: "ok", clients: sseClients.size },
      authentication: { status: "ok", enabled: auth.enabled }
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
    res.status(403).json({ error: "MCP agents have read-only access to user-created sessions" });
    return;
  }
  next();
});
app.use("/events", auth.requireAuth);

app.get("/api/mcp/owned-threads", (_req, res) => {
  const actorId = typeof res.locals.mcpActorId === "string" ? res.locals.mcpActorId : "";
  res.json({ data: mcpAccess.listOwnedThreads(actorId) });
});

app.get("/api/diagnostics/performance", (_req, res) => {
  res.json({ routes: profiler.snapshot(), codex: codex.getMetrics(), sampledAt: Date.now() });
});

app.post("/api/logout", (req, res) => {
  auth.logout(req, res);
  res.json({ ok: true });
});

app.get("/api/bootstrap", async (_req, res, next) => {
  try {
    const [modelsResult, accountResult, usageResult] = await Promise.allSettled([
      readModels(),
      codex.request("account/read", { refreshToken: false }),
      codex.request("account/rateLimits/read")
    ]);
    const bootstrapErrors = [modelsResult, accountResult, usageResult]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => publicError(result.reason));
    res.json({
      models: modelsResult.status === "fulfilled" ? modelsResult.value : { data: [] },
      account: accountResult.status === "fulfilled" ? publicAccount(accountResult.value, typeof res.locals.mcpActorId !== "string") : { account: null, requiresOpenaiAuth: true },
      usage: usageResult.status === "fulfilled" ? usageResult.value : null,
      roots: workspaces.roots,
      pendingRequests: codex.listServerRequests(),
      liveState: Object.fromEntries(liveThreadStates),
      queues: Object.fromEntries(messageQueues),
      activeThreadIds: [...activeThreads],
      agentThreadIds: mcpAccess.listAgentThreads(),
      runtime: publicRuntimeStatus(),
      degraded: bootstrapErrors.length > 0,
      errors: bootstrapErrors
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/directories", async (req, res, next) => {
  try {
    const candidate = typeof req.query.path === "string" ? req.query.path : undefined;
    res.json(await workspaces.list(candidate));
  } catch (error) {
    next(error);
  }
});

app.get("/api/files", async (req, res, next) => {
  try {
    const cwd = requiredString(req.query.cwd, "Directory");
    const query = typeof req.query.q === "string" ? req.query.q : "";
    res.json({ data: await workspaces.searchFiles(cwd, query, 30) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/threads", async (req, res, next) => {
  try {
    const params = {
      cursor: stringQuery(req, "cursor"),
      limit: numberQuery(req, "limit", 100, 1, 200),
      sortKey: enumQuery(req, "sortKey", ["created_at", "updated_at"], "updated_at"),
      sortDirection: enumQuery(req, "sortDirection", ["asc", "desc"], "desc"),
      searchTerm: stringQuery(req, "search") || undefined,
      archived: false
    };
    const result = await sessions.withInventory(() =>
      codex.request<{ data: Array<Record<string, unknown>>; nextCursor: string | null }>("thread/list", params)
    );
    result.data = result.data
      .filter((thread) => typeof thread.id === "string" && !unavailableThreadIds.has(thread.id) && !archivingThreadIds.has(thread.id))
      .map((thread) => {
        synchronizeThreadSnapshot(thread);
        return sessions.enrich(thread);
      });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/threads", async (req, res, next) => {
  try {
    const input = parseSessionCreation(req.body);
    const cwd = await workspaces.validate(input.cwd);
    const { model, effort, yolo, name, prompt, tags, category } = input;
    await validateModelChoice(model, effort);
    const result = await sessions.withInventory(() => codex.request<{ thread: Record<string, unknown> & { id: string } }>("thread/start", {
        cwd,
        runtimeWorkspaceRoots: [cwd],
        model,
        allowProviderModelFallback: false,
        approvalPolicy: yolo ? "never" : "on-request",
        sandbox: yolo ? "danger-full-access" : "workspace-write",
        ephemeral: false,
        serviceName: "ForgeDeck"
      }));
    const threadId = validAdapterThreadId(result.thread?.id);
    knownThreadIds.add(threadId);
    const warnings: string[] = [];
    const mcpActorId = typeof res.locals.mcpActorId === "string" ? res.locals.mcpActorId : null;
    if (mcpActorId) mcpAccess.assignThread(threadId, mcpActorId);
    threadPolicies.set(threadId, yolo ? "yolo" : "workspace-write");
    persistThreadPolicies();
    if (tags.length || category) sessions.setMetadata(threadId, { tags, category }, mcpActorId ? `mcp:${mcpActorId}` : "user");
    sessions.record(threadId, "created", mcpActorId ? `mcp:${mcpActorId}` : "user", { cwd, model, effort, name, tags, category });
    try {
      await codex.request("thread/name/set", { threadId, name });
    } catch (error) {
      warnings.push("The session was created, but its name could not be set.");
      logger.warn("Could not name newly created session", { threadId, error });
    }
    broadcast("threads", { action: "created", threadId });
    let initialTurnStarted = false;
    if (prompt) {
      claimBridgeThread(threadId);
      try {
        await sessions.withSession(threadId, () => startTurn(threadId, prompt, model, effort));
        initialTurnStarted = true;
      } catch (error) {
        releaseBridgeThread(threadId);
        warnings.push("The session was created, but its initial message could not be started.");
        logger.warn("Could not start initial turn for newly created session", { threadId, error });
      }
    }
    res.status(201).json({ ...result, thread: sessions.enrich({ ...result.thread, name }), initialTurnStarted, warnings });
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
    const settled = await Promise.allSettled(threadIds.map(async (threadId) => {
      if (operation === "read") return readSession(threadId, true);
      if (operation === "archive") return archiveSession(threadId, "batch", "user");
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
    res.json({ data: sessions.history(threadId, limit) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/threads/:threadId", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    res.json({ thread: await readSession(threadId, true) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/threads/:threadId/messages", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    const { text, model, effort } = parseMessageInput(req.body);
    await validateModelChoice(model, effort);
    const result = await withThreadOperation(threadId, async () => {
      assertSessionNotArchiving(threadId);
      if (activeThreads.has(threadId)) throw httpError("This session already has an active turn", 409, "SESSION_ACTIVE");
      claimBridgeThread(threadId);
      try {
        await codex.request("thread/resume", { threadId, model, excludeTurns: true }, 60_000);
        return await startTurn(threadId, text, model, effort);
      } catch (error) {
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
      res.json(await withMutableThreadOperation(threadId, () => codex.request("thread/compact/start", { threadId }, 60_000)));
      return;
    }
    if (command === "stop") {
      res.json(await withMutableThreadOperation(threadId, async () => {
        const turnId = await findActiveTurnId(threadId);
        if (!turnId) throw httpError("This session has no active turn", 409);
        sessions.record(threadId, "interrupt_requested", "user", { turnId });
        return codex.request("turn/interrupt", { threadId, turnId });
      }));
      return;
    }
    if (command === "rename") {
      if (!args) throw httpError("Use /rename followed by a session name", 400);
      const name = args.slice(0, 100);
      const result = await withMutableThreadOperation(threadId, async () => {
        const response = await codex.request("thread/name/set", { threadId, name });
        sessions.record(threadId, "renamed", "user", { name });
        return response;
      });
      broadcast("threads", { action: "updated", threadId });
      res.json(result);
      return;
    }
    if (command === "archive") {
      res.status(202).json(await archiveSession(threadId, "command", "user"));
      return;
    }
    if (command === "goal") {
      const operation = args?.toLowerCase();
      if (!args || operation === "view") {
        res.json(await withMutableThreadOperation(threadId, () => codex.request("thread/goal/get", { threadId })));
        return;
      }
      if (operation === "clear") {
        res.json(await withMutableThreadOperation(threadId, () => codex.request("thread/goal/clear", { threadId })));
        return;
      }
      if (operation === "pause" || operation === "resume") {
        res.json(await withMutableThreadOperation(threadId, () => codex.request("thread/goal/set", { threadId, status: operation === "pause" ? "paused" : "active" })));
        return;
      }
      const objective = args.replace(/^set\s+/i, "").trim();
      if (!objective) throw httpError("Use /goal followed by an objective", 400);
      res.json(await withMutableThreadOperation(threadId, () => codex.request("thread/goal/set", { threadId, objective, status: "active" })));
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
    const { text, model, effort } = parseMessageInput(req.body);
    await validateModelChoice(model, effort);
    const { entry, position } = await withThreadOperation(threadId, async () => {
      await ensureSessionExists(threadId);
      const queued: QueuedMessage = { id: crypto.randomUUID(), text, model, effort, createdAt: Date.now() };
      const queue = messageQueues.get(threadId) || [];
      if (queue.length >= config.queueMaxMessages) throw httpError("This session's message queue is full", 409, "QUEUE_FULL");
      queue.push(queued);
      messageQueues.set(threadId, queue);
      persistMessageQueues();
      sessions.record(threadId, "message_queued", "user", { queueId: queued.id, position: queue.length });
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
    await withMutableThreadOperation(threadId, () => {
      const queue = messageQueues.get(threadId) || [];
      const nextQueue = queue.filter((entry) => entry.id !== req.params.queueId);
      if (nextQueue.length === queue.length) throw httpError("Queued message not found", 404);
      if (nextQueue.length) messageQueues.set(threadId, nextQueue);
      else messageQueues.delete(threadId);
      persistMessageQueues();
      sessions.record(threadId, "queued_message_removed", "user", { queueId: req.params.queueId });
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
    assertSessionNotArchiving(threadId);
    const requestedTurnId = optionalBoundedString(req.body?.turnId, "Turn id", 128);
    if (requestedTurnId && !/^[a-zA-Z0-9_-]{1,128}$/.test(requestedTurnId)) throw httpError("Invalid turn id", 400, "INVALID_TURN_ID");
    res.json(await withMutableThreadOperation(threadId, async () => {
      const turnId = requestedTurnId || await findActiveTurnId(threadId);
      if (!turnId) throw httpError("This session has no active turn", 409);
      sessions.record(threadId, "interrupt_requested", "user", { turnId });
      return codex.request("turn/interrupt", { threadId, turnId });
    }));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/threads/:threadId/policy", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    assertSessionNotArchiving(threadId);
    assertObject(req.body, "Request body");
    assertAllowedKeys(req.body, ["yolo"]);
    if (typeof req.body.yolo !== "boolean") throw httpError("YOLO must be a boolean", 400, "INVALID_YOLO");
    const policy: ThreadPolicy = req.body.yolo ? "yolo" : "workspace-write";
    await withMutableThreadOperation(threadId, async () => {
      if (activeThreads.has(threadId) || await findActiveTurnId(threadId)) throw httpError("Stop or finish the current turn before changing permissions", 409);
      await codex.request("thread/resume", { threadId, excludeTurns: true }, 60_000);
      await codex.request("thread/settings/update", policy === "yolo" ? {
        threadId, approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }
      } : {
        threadId, approvalPolicy: "on-request", sandboxPolicy: {
          type: "workspaceWrite", writableRoots: [], networkAccess: false,
          excludeTmpdirEnvVar: false, excludeSlashTmp: false
        }
      });
      threadPolicies.set(threadId, policy);
      persistThreadPolicies();
      sessions.record(threadId, "policy_changed", "user", { policy });
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
    assertAllowedKeys(req.body, ["name", "tags", "category"]);
    if (!("name" in req.body) && !("tags" in req.body) && !("category" in req.body)) throw httpError("At least one session field is required", 400);
    const result = await withMutableThreadOperation(threadId, async () => {
      await ensureSessionExists(threadId);
      let renameResult: unknown = { ok: true };
      if ("name" in req.body) {
        const name = boundedString(req.body.name, "Name", 100);
        renameResult = await codex.request("thread/name/set", { threadId, name });
        sessions.record(threadId, "renamed", "user", { name });
      }
      const metadata = ("tags" in req.body || "category" in req.body)
        ? updateSessionMetadata(threadId, { tags: req.body.tags, category: req.body.category }, "user")
        : sessions.metadataFor(threadId);
      return { result: renameResult, ...metadata };
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
    res.status(202).json(await archiveSession(threadId, "delete", "user"));
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

app.get("/events", (req, res) => {
  res.status(200);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders();
  sseClients.add(res);
  writeSse(res, `event: connected\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
  const heartbeat = setInterval(() => writeSse(res, ": heartbeat\n\n"), 20_000);
  res.on("error", () => sseClients.delete(res));
  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

codex.on("notification", (payload) => {
  const notification = payload as { method: string; params?: Record<string, unknown> };
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
  clearBridgeActivity();
  externalMonitor?.emitCurrentStatuses();
  broadcast("runtime", { state: "offline", ...payload });
});
codex.on("ready", () => {
  modelCache.clear();
  logger.info("Codex runtime connected", { runtime: codex.getStatus() });
  for (const session of codex.listSessions()) {
    if (session.state === "running") {
      setThreadActivity(session.threadId, "bridge", true);
      if (session.turnId) activeTurnIds.set(session.threadId, session.turnId);
    }
  }
  broadcast("runtime", { state: "ready" });
  for (const threadId of messageQueues.keys()) void drainQueue(threadId);
  void drainArchiveQueue();
});
codex.on("error", (error) => {
  logger.warn("Codex runtime unavailable", { error, runtime: codex.getStatus() });
  broadcast("runtime", { state: "error", message: "Codex runtime is temporarily unavailable" });
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

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API endpoint not found", code: "NOT_FOUND" });
});

app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
  const normalized = normalizeHttpError(error);
  if (normalized.retryAfter) res.setHeader("Retry-After", String(normalized.retryAfter));
  const context = { requestId: res.locals.requestId, method: req.method, path: req.path, status: normalized.status, error };
  if (normalized.status >= 500) logger.error("Request failed", context);
  else logger.warn("Request rejected", context);
  res.status(normalized.status).json({ error: normalized.message, code: normalized.code, requestId: res.locals.requestId });
});

if (config.externalMonitorEnabled) externalMonitor = new ExternalCodexMonitor((notification, historical) => {
  const threadId = typeof notification.params.threadId === "string" ? notification.params.threadId : null;
  const turn = notification.params.turn as { status?: unknown } | undefined;
  const deadProcess = notification.method === "turn/completed" && turn?.status === "interrupted";
  if (threadId && bridgeOwnedThreads.has(threadId) && !deadProcess) return;
  if (threadId && deadProcess) releaseBridgeThread(threadId);
  if (!historical) resumeGoalAfterCapacity(notification);
  recordLiveEvent(notification, "external");
  const outbound = canonicalActivityNotification(notification);
  if (outbound) broadcast("codex", outbound);
}, undefined, ({ threadIds, unavailableThreadIds: unavailable }) => {
  unavailableThreadIds = unavailable;
  reconcileSessionInventory(threadIds);
}, {
  pollMs: config.externalMonitorPollMs,
  livenessMs: config.externalMonitorLivenessMs,
  threadLimit: config.externalMonitorThreadLimit,
  maxReadBytes: config.externalMonitorMaxReadBytes,
  maxOutputChars: config.liveOutputMaxChars
});
externalMonitor?.start();
const server = app.listen(port, host, () => {
  const addresses = lanAddresses(port);
  logger.info("ForgeDeck API listening", {
    addresses,
    authenticationEnabled: auth.enabled,
    generatedAccessTokenPath: auth.generatedTokenPath,
    mcpBootstrapTokenPath: mcpAccess.bootstrapTokenPath,
    logLevel: logger.level
  });
});
void codex.start().catch(() => undefined);

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("ForgeDeck shutting down", { signal });
    externalMonitor?.stop();
    if (archiveRetryTimer) clearTimeout(archiveRetryTimer);
    for (const client of sseClients) client.end();
    sseClients.clear();
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

async function startTurn(threadId: string, text: string, model: string, effort: string | null): Promise<unknown> {
  const policy = threadPolicies.get(threadId);
  const result = await codex.request<{ turn?: { id?: string; status?: string } }>("turn/start", {
    threadId,
    input: [{ type: "text", text, text_elements: [] }],
    model,
    effort: effort || undefined,
    ...(policy === "yolo" ? {
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" }
    } : {})
  }, 60_000);
  setThreadActivity(threadId, "bridge", true);
  if (typeof result.turn?.id === "string") activeTurnIds.set(threadId, result.turn.id);
  return result;
}

async function drainQueue(threadId: string): Promise<void> {
  if (drainingQueues.has(threadId) || archivingThreadIds.has(threadId) || !(messageQueues.get(threadId)?.length)) return;
  drainingQueues.add(threadId);
  let entry: QueuedMessage | undefined;
  try {
    await withMutableThreadOperation(threadId, async () => {
      const snapshot = await codex.request<{ thread: ThreadSnapshot }>("thread/read", { threadId, includeTurns: true }, 60_000);
      knownThreadIds.add(threadId);
      const lastTurn = snapshot.thread.turns?.at(-1);
      if (snapshot.thread.status?.type === "active" || lastTurn?.status === "inProgress") {
        setThreadActivity(threadId, "bridge", true);
        if (lastTurn?.id) activeTurnIds.set(threadId, lastTurn.id);
        return;
      }
      setThreadActivity(threadId, "bridge", false);
      const queue = messageQueues.get(threadId) || [];
      entry = queue[0];
      if (!entry) return;
      claimBridgeThread(threadId);
      await codex.request("thread/resume", { threadId, model: entry.model, excludeTurns: true }, 60_000);
      await startTurn(threadId, entry.text, entry.model, entry.effort);
      queue.shift();
      if (queue.length) messageQueues.set(threadId, queue);
      else messageQueues.delete(threadId);
      persistMessageQueues();
      sessions.record(threadId, "queued_message_started", "system", { queueId: entry.id });
      broadcastQueue(threadId);
    });
  } catch (error) {
    releaseBridgeThread(threadId);
    if (entry) {
      broadcastQueue(threadId, publicError(error).message);
    }
    logger.warn("Could not start queued turn", { threadId, error });
  } finally {
    drainingQueues.delete(threadId);
  }
}

async function findActiveTurnId(threadId: string): Promise<string | null> {
  const snapshot = await codex.request<{ thread: ThreadSnapshot }>("thread/read", { threadId, includeTurns: true }, 60_000);
  knownThreadIds.add(threadId);
  const activeTurn = [...(snapshot.thread.turns || [])].reverse().find((turn) => turn.status === "inProgress")?.id || null;
  if (deadProcessThreadIds.has(threadId)) {
    setThreadActivity(threadId, "bridge", false);
    return null;
  }
  setThreadActivity(threadId, "bridge", snapshot.thread.status?.type === "active" || Boolean(activeTurn));
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
  return { id: entry.id, text: entry.text, model: entry.model, effort: entry.effort as string | null, createdAt: entry.createdAt };
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

function broadcastQueue(threadId: string, error?: string): void {
  broadcast("queue", { threadId, queue: messageQueues.get(threadId) || [], error: error || null });
}

async function validateModelChoice(modelId: string, effort: string | null): Promise<void> {
  const response = await readModels();
  const model = response.data.find((item) => item.id === modelId || item.model === modelId);
  if (!model) throw httpError("That model is not available on this Codex account", 400);
  if (effort && !model.supportedReasoningEfforts.some((item) => item.reasoningEffort === effort)) {
    throw httpError("That reasoning level is not available for the selected model", 400);
  }
}

function readModels(): Promise<ModelListResponse> {
  return modelCache.get(() => codex.request<ModelListResponse>("model/list", { limit: 100, includeHidden: false }));
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
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  const bytes = Buffer.byteLength(message);
  if (bytes > config.sseEventMaxBytes) {
    logger.warn("Dropped oversized SSE event", { event, bytes });
    return;
  }
  for (const client of sseClients) writeSse(client, message);
}

function writeSse(client: Response, message: string): void {
  try {
    if (client.write(message)) return;
  } catch (error) {
    logger.debug("SSE client write failed", { error });
  }
  sseClients.delete(client);
  client.end();
}

function recordLiveEvent(notification: { method: string; params?: Record<string, unknown> }, source: ActivitySource): void {
  const params = notification.params;
  const threadId = typeof params?.threadId === "string" ? params.threadId : null;
  if (!threadId) return;
  if (notification.method === "turn/started") {
    deadProcessThreadIds.delete(threadId);
    setThreadActivity(threadId, source, true);
    const turn = params?.turn as { id?: unknown } | undefined;
    if (typeof turn?.id === "string") activeTurnIds.set(threadId, turn.id);
    sessions.record(threadId, "turn_started", source, typeof turn?.id === "string" ? { turnId: turn.id } : undefined);
  }
  if (notification.method === "turn/completed") {
    setThreadActivity(threadId, source, false);
    const turn = params?.turn as { id?: unknown; status?: unknown } | undefined;
    if (source === "external" && turn?.status === "interrupted") deadProcessThreadIds.add(threadId);
    sessions.record(threadId, "turn_completed", source, {
      ...(typeof turn?.id === "string" ? { turnId: turn.id } : {}),
      ...(typeof turn?.status === "string" ? { status: turn.status } : {})
    });
    setTimeout(() => void drainQueue(threadId), 50).unref();
  }
  if (notification.method === "thread/status/changed") {
    const status = params?.status as { type?: string } | undefined;
    setThreadActivity(threadId, source, status?.type === "active");
    if (status?.type !== "active") {
      setTimeout(() => void drainQueue(threadId), 50).unref();
    }
  }
  if (notification.method === "thread/deleted" || notification.method === "thread/archived") {
    if (!archivingThreadIds.has(threadId)) cleanupSessionTraces(threadId, "codex_notification", "codex");
    return;
  }

  const state = liveThreadStates.get(threadId) || { items: {}, agentText: {}, toolOutput: {}, active: false, completedAt: null, updatedAt: Date.now() };
  state.updatedAt = Date.now();
  if (notification.method === "turn/started") {
    state.active = activeThreads.has(threadId);
    state.completedAt = null;
  }
  if (notification.method === "turn/completed") {
    state.active = activeThreads.has(threadId);
    if (!state.active) state.completedAt = Date.now();
  }
  if (notification.method === "thread/status/changed") {
    state.active = activeThreads.has(threadId);
  }
  if ((notification.method === "item/started" || notification.method === "item/completed") && params?.item && typeof params.item === "object") {
    const item = params.item as Record<string, unknown>;
    if (typeof item.id === "string") {
      state.items[item.id] = item;
      if (notification.method === "item/completed" && item.type === "agentMessage") delete state.agentText[item.id];
      trimRecord(state.items, 192);
    }
  }
  if (notification.method === "item/agentMessage/delta" && typeof params?.itemId === "string") {
    state.agentText[params.itemId] = appendBounded(state.agentText[params.itemId], String(params.delta || ""), config.liveOutputMaxChars);
    trimRecord(state.agentText, 16);
  }
  if ((notification.method === "item/commandExecution/outputDelta" || notification.method === "item/fileChange/outputDelta") && typeof params?.itemId === "string") {
    state.toolOutput[params.itemId] = appendBounded(state.toolOutput[params.itemId], String(params.delta || ""), config.liveOutputMaxChars);
    trimRecord(state.toolOutput, 32);
  }
  liveThreadStates.set(threadId, state);
}

function setThreadActivity(threadId: string, source: ActivitySource, active: boolean): void {
  const sources = activeThreadSources.get(threadId) || new Set<ActivitySource>();
  if (active) sources.add(source);
  else sources.delete(source);
  if (sources.size) {
    activeThreadSources.set(threadId, sources);
    activeThreads.add(threadId);
  } else {
    activeThreadSources.delete(threadId);
    activeThreads.delete(threadId);
    activeTurnIds.delete(threadId);
  }
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
  void codex.request("thread/goal/set", { threadId, status: "active" }).then(() => {
    logger.info("Resumed session goal after model-capacity error", { threadId });
  }).catch((error) => {
    logger.warn("Could not resume session goal after model-capacity error", { threadId, error });
  });
}

function collectStrings(value: unknown, depth = 0): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object" || depth >= 6) return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectStrings(item, depth + 1));
  return Object.values(value as Record<string, unknown>).flatMap((item) => collectStrings(item, depth + 1));
}

function trimRecord<T>(record: Record<string, T>, maxEntries: number): void {
  const keys = Object.keys(record);
  for (const key of keys.slice(0, Math.max(0, keys.length - maxEntries))) delete record[key];
}

function appendBounded(current: string | undefined, delta: string, maximum: number): string {
  const value = `${current || ""}${delta}`;
  if (value.length <= maximum) return value;
  return `…[earlier output truncated]\n${value.slice(-(maximum - 28))}`;
}

let ttlSweepRunning = false;
async function sweepExpiredSessions(): Promise<void> {
  if (ttlSweepRunning || sessionTtlMs <= 0) return;
  ttlSweepRunning = true;
  try {
    const threads = await listAllSessions();
    const expired = threads.filter((thread) => isSessionExpired(thread, activeThreads, sessionTtlMs));
    const results = await Promise.allSettled(expired.map((thread) => archiveSession(String(thread.id), "ttl", "system")));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (expired.length) logger.info("Session TTL sweep completed", { expired: expired.length, archived: expired.length - failures.length, failures: failures.length });
    for (const failure of failures) logger.warn("Could not auto-archive expired session", { error: failure.reason });
  } catch (error) {
    logger.warn("Session TTL sweep failed", { error });
  } finally {
    ttlSweepRunning = false;
  }
}

setTimeout(() => void sweepExpiredSessions(), 30_000).unref();
setInterval(() => void sweepExpiredSessions(), 15 * 60_000).unref();

setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60_000;
  for (const [threadId, state] of liveThreadStates) if (state.updatedAt < cutoff) liveThreadStates.delete(threadId);
}, 10 * 60_000).unref();

async function readSession(threadId: string, includeTurns: boolean): Promise<Record<string, unknown>> {
  assertSessionNotArchiving(threadId);
  if (unavailableThreadIds.has(threadId)) throw httpError("This session no longer has a Codex rollout", 404, "SESSION_UNAVAILABLE");
  return withThreadOperation(threadId, async () => {
    const [snapshot, goal] = await Promise.all([
      codex.request<{ thread: Record<string, unknown> }>("thread/read", { threadId, includeTurns }, 60_000),
      codex.request<{ goal: Record<string, unknown> | null }>("thread/goal/get", { threadId }).catch(() => ({ goal: null }))
    ]);
    synchronizeThreadSnapshot(snapshot.thread);
    return sessions.enrich({
      ...snapshot.thread,
      goal: goal.goal,
      policy: threadPolicies.get(threadId) || "workspace-write"
    });
  });
}

async function archiveSession(threadId: string, reason: string, actor: string): Promise<Record<string, unknown>> {
  return withThreadOperation(threadId, async () => {
    const pending = archiveQueue.find((job) => job.threadId === threadId);
    if (pending || archivingThreadIds.has(threadId)) {
      return { accepted: true, threadId, status: "archiving", attempts: pending?.attempts || 0 };
    }
    if (unavailableThreadIds.has(threadId)) {
      sessions.record(threadId, "archived", actor, { reason, codexAlreadyMissing: true });
      cleanupSessionTraces(threadId, reason, actor);
      return { accepted: true, archived: true, threadId, alreadyMissing: true };
    }
    const activeTurnId = await findActiveTurnId(threadId);
    if (activeThreads.has(threadId) || activeTurnId) throw httpError("Stop or finish the current turn before archiving this session", 409, "SESSION_ACTIVE");
    const job: ArchiveJob = { threadId, reason, actor, attempts: 0, acceptedAt: Date.now(), lastError: null };
    archivingThreadIds.add(threadId);
    archiveQueue.push(job);
    sessions.record(threadId, "archive_queued", actor, { reason });
    broadcast("threads", { action: "removed", threadId, reason: "archiving" });
    queueMicrotask(() => void drainArchiveQueue());
    return { accepted: true, threadId, status: "archiving" };
  });
}

async function drainArchiveQueue(): Promise<void> {
  if (archiveWorkerRunning || !archiveQueue.length || !codex.getStatus().available) return;
  archiveWorkerRunning = true;
  try {
    while (archiveQueue.length && codex.getStatus().available) {
      const job = archiveQueue[0];
      job.attempts += 1;
      try {
        await withThreadOperation(job.threadId, () => codex.request("thread/archive", { threadId: job.threadId }, 60_000));
        archiveQueue.shift();
        sessions.record(job.threadId, "archived", job.actor, { reason: job.reason, attempts: job.attempts });
        cleanupSessionTraces(job.threadId, job.reason, job.actor);
        logger.info("Session archived", { threadId: job.threadId, reason: job.reason, attempts: job.attempts });
      } catch (error) {
        if (isMissingThreadError(error)) {
          archiveQueue.shift();
          sessions.record(job.threadId, "archived", job.actor, { reason: job.reason, codexAlreadyMissing: true });
          cleanupSessionTraces(job.threadId, job.reason, job.actor);
          continue;
        }
        const normalized = normalizeHttpError(error);
        job.lastError = normalized.message;
        if (normalized.status >= 500 || normalized.status === 429) {
          logger.warn("Session archive deferred", { threadId: job.threadId, attempts: job.attempts, error });
          scheduleArchiveRetry(Math.min(30_000, 1_000 * 2 ** Math.min(5, job.attempts - 1)));
          return;
        }
        archiveQueue.shift();
        archivingThreadIds.delete(job.threadId);
        sessions.record(job.threadId, "archive_failed", job.actor, { reason: job.reason, error: normalized.message });
        broadcast("threads", { action: "updated", threadId: job.threadId, reason: "archive_failed" });
        logger.warn("Session archive rejected", { threadId: job.threadId, status: normalized.status, error });
      }
    }
  } finally {
    archiveWorkerRunning = false;
  }
}

function scheduleArchiveRetry(delayMs: number): void {
  if (archiveRetryTimer) return;
  archiveRetryTimer = setTimeout(() => {
    archiveRetryTimer = null;
    void drainArchiveQueue();
  }, delayMs);
  archiveRetryTimer.unref();
}

function cleanupSessionTraces(threadId: string, reason: string, actor: string, ownershipReleased = false): void {
  const hadQueue = messageQueues.delete(threadId);
  const hadPolicy = threadPolicies.delete(threadId);
  const hadMetadata = sessions.removeMetadata(threadId);
  const hadLiveState = liveThreadStates.delete(threadId);
  const hadActivity = activeThreads.has(threadId) || activeThreadSources.has(threadId) || activeTurnIds.has(threadId);
  const hadOwnership = ownershipReleased || mcpAccess.listAgentThreads().includes(threadId);

  activeThreads.delete(threadId);
  activeThreadSources.delete(threadId);
  activeTurnIds.delete(threadId);
  deadProcessThreadIds.delete(threadId);
  drainingQueues.delete(threadId);
  bridgeOwnedThreads.delete(threadId);
  capacityBuffers.delete(threadId);
  capacityHandledThreads.delete(threadId);
  knownThreadIds.delete(threadId);
  archivingThreadIds.delete(threadId);
  if (!ownershipReleased) mcpAccess.releaseThread(threadId);

  if (hadQueue) persistMessageQueues();
  if (hadPolicy) persistThreadPolicies();
  if (hadQueue || hadPolicy || hadMetadata || hadLiveState || hadActivity || hadOwnership) {
    sessions.record(threadId, "local_state_removed", actor, { reason });
  }
  codex.dismissServerRequestsForThread(threadId);
  broadcastQueue(threadId);
  broadcast("threads", { action: "removed", threadId, reason });
}

function reconcileSessionInventory(threadIds: Set<string>): void {
  const previouslyRemoved = reconciledInventoryIds
    ? [...reconciledInventoryIds].filter((threadId) => !threadIds.has(threadId))
    : [];
  const definiteStale = new Set(previouslyRemoved);
  const locallyTracked = new Set([
    ...messageQueues.keys(), ...threadPolicies.keys(), ...mcpAccess.listAgentThreads(),
    ...sessions.trackedThreadIds(), ...liveThreadStates.keys(), ...activeThreadSources.keys()
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
    cleanupSessionTraces(threadId, "inventory_reconciliation", "system", releasedOwnership.has(threadId));
  }
  reconciledInventoryIds = new Set(threadIds);
}

async function listAllSessions(): Promise<Array<Record<string, unknown>>> {
  return sessions.withInventory(async () => {
    const threads: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = await codex.request<{ data: Array<Record<string, unknown>>; nextCursor: string | null }>("thread/list", {
        cursor,
        limit: 200,
        sortKey: "updated_at",
        sortDirection: "desc",
        archived: false
      });
      for (const thread of result.data) {
        if (typeof thread.id !== "string" || unavailableThreadIds.has(thread.id) || archivingThreadIds.has(thread.id)) continue;
        synchronizeThreadSnapshot(thread);
        threads.push(thread);
      }
      if (!result.nextCursor || result.nextCursor === cursor) break;
      cursor = result.nextCursor;
    }
    return threads;
  });
}

function synchronizeThreadSnapshot(thread: Record<string, unknown>): void {
  if (typeof thread.id !== "string") return;
  const threadId = thread.id;
  knownThreadIds.add(threadId);
  unavailableThreadIds.delete(threadId);
  const status = thread.status && typeof thread.status === "object" ? (thread.status as { type?: unknown }) : null;
  const turns = Array.isArray(thread.turns) ? thread.turns as Array<Record<string, unknown>> : [];
  const lastTurn = turns.at(-1);
  if (deadProcessThreadIds.has(threadId)) {
    thread.status = { type: "idle" };
    if (lastTurn?.status === "inProgress") lastTurn.status = "interrupted";
    setThreadActivity(threadId, "bridge", false);
    return;
  }
  const active = status?.type === "active" || lastTurn?.status === "inProgress";
  setThreadActivity(threadId, "bridge", active);
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

async function ensureSessionExists(threadId: string): Promise<void> {
  assertSessionNotArchiving(threadId);
  if (unavailableThreadIds.has(threadId)) throw httpError("Session not found", 404, "SESSION_NOT_FOUND");
  const snapshot = await codex.request<{ thread: Record<string, unknown> }>("thread/read", { threadId, includeTurns: false }, 60_000);
  synchronizeThreadSnapshot(snapshot.thread);
}

function assertSessionNotArchiving(threadId: string): void {
  if (archivingThreadIds.has(threadId)) throw httpError("This session is being archived", 409, "SESSION_ARCHIVING");
}

function updateSessionMetadata(threadId: string, update: { tags?: unknown; category?: unknown }, actor: string) {
  try {
    return sessions.setMetadata(threadId, update, actor);
  } catch (error) {
    throw httpError(error instanceof Error ? error.message : "Invalid session organization", 400, "INVALID_SESSION_METADATA");
  }
}

function isMissingThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return /thread|session/.test(message) && /not found|does not exist|unknown|archived/.test(message);
}

function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  });
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

function storageStatus(): { status: "ok" | "error"; writable: boolean; error?: string } {
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.accessSync(dataDir, fs.constants.R_OK | fs.constants.W_OK);
    return { status: "ok", writable: true };
  } catch (error) {
    logger.warn("ForgeDeck data directory is unavailable", { error });
    return { status: "error", writable: false, error: "Data directory is unavailable" };
  }
}

type SessionCreationInput = {
  cwd: string;
  model: string;
  effort: string | null;
  yolo: boolean;
  name: string;
  prompt: string | null;
  tags: string[];
  category: string | null;
};

function parseSessionCreation(value: unknown): SessionCreationInput {
  assertObject(value, "Request body");
  assertAllowedKeys(value, ["cwd", "model", "effort", "yolo", "name", "prompt", "tags", "category"]);
  const cwd = boundedString(value.cwd, "Directory", 4_096);
  const model = boundedString(value.model, "Model", 128);
  if (!/^[a-zA-Z0-9._:/-]+$/.test(model)) throw httpError("Model contains invalid characters", 400, "INVALID_MODEL");
  const effort = optionalBoundedString(value.effort, "Reasoning level", 64);
  if (effort && !/^[a-zA-Z0-9_-]+$/.test(effort)) throw httpError("Reasoning level contains invalid characters", 400, "INVALID_EFFORT");
  if (value.yolo !== undefined && typeof value.yolo !== "boolean") throw httpError("YOLO must be a boolean", 400, "INVALID_YOLO");
  const prompt = optionalBoundedString(value.prompt, "Prompt", 100_000);
  const explicitName = optionalBoundedString(value.name, "Name", 100);
  const name = singleLine(explicitName || deriveSessionName(prompt), "Name");
  const tags = parseTags(value.tags);
  const categoryValue = optionalBoundedString(value.category, "Category", 50);
  const category = categoryValue ? singleLine(categoryValue, "Category") : null;
  return { cwd, model, effort, yolo: value.yolo === true, name, prompt, tags, category };
}

function parseMessageInput(value: unknown): { text: string; model: string; effort: string | null } {
  assertObject(value, "Request body");
  assertAllowedKeys(value, ["text", "model", "effort"]);
  const text = boundedString(value.text, "Message", 100_000);
  const model = boundedString(value.model, "Model", 128);
  if (!/^[a-zA-Z0-9._:/-]+$/.test(model)) throw httpError("Model contains invalid characters", 400, "INVALID_MODEL");
  const effort = optionalBoundedString(value.effort, "Reasoning level", 64);
  if (effort && !/^[a-zA-Z0-9_-]+$/.test(effort)) throw httpError("Reasoning level contains invalid characters", 400, "INVALID_EFFORT");
  return { text, model, effort };
}

function parseTags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw httpError("Tags must be an array of strings", 400, "INVALID_TAGS");
  if (value.length > 10) throw httpError("A session can have at most 10 tags", 400, "INVALID_TAGS");
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") throw httpError("Tags must be an array of strings", 400, "INVALID_TAGS");
    const tag = singleLine(raw.trim().replace(/\s+/g, " "), "Tag");
    if (!tag) continue;
    if (tag.length > 32) throw httpError("Tags must be 32 characters or fewer", 400, "INVALID_TAGS");
    const key = tag.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      tags.push(tag);
    }
  }
  return tags;
}

function parseThreadIds(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || !value.length) throw httpError("Thread ids are required", 400, "INVALID_THREAD_IDS");
  if (value.length > maximum) throw httpError(`At most ${maximum} sessions can be processed at once`, 400, "TOO_MANY_THREAD_IDS");
  return [...new Set(value.map((threadId) => typeof threadId === "string" ? validThreadId(threadId) : (() => { throw httpError("Invalid thread id", 400, "INVALID_THREAD_ID"); })()))];
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
  const match = /^\/threads\/([a-zA-Z0-9_-]{8,128})(?:\/|$)/.exec(req.path);
  return match ? mcpAccess.ownsThread(actorId, match[1]) : false;
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

function enumQuery<T extends string>(req: Request, name: string, values: readonly T[], fallback: T): T {
  const value = req.query[name];
  return typeof value === "string" && values.includes(value as T) ? value as T : fallback;
}

type NormalizedHttpError = { status: number; code: string; message: string; retryAfter?: number };

function normalizeHttpError(error: unknown): NormalizedHttpError {
  if (error instanceof PathError) return { status: error.status, code: "INVALID_PATH", message: error.message };
  const candidate = error as { status?: unknown; code?: unknown; type?: unknown; retryAfter?: unknown };
  if (candidate?.type === "entity.parse.failed") return { status: 400, code: "INVALID_JSON", message: "Invalid JSON request body" };
  if (error instanceof CodexUnavailableError) {
    return { status: 503, code: "CODEX_UNAVAILABLE", message: "Codex runtime is temporarily unavailable", retryAfter: 2 };
  }
  if (error instanceof CodexRpcError) return normalizeCodexRpcError(error);
  if (error instanceof CodexBridgeError) {
    if (error.code === "TIMEOUT" || error.code === "HEARTBEAT_TIMEOUT") {
      return { status: 504, code: "CODEX_TIMEOUT", message: "Codex runtime did not respond in time", retryAfter: 2 };
    }
    if (error.transient || ["OFFLINE", "STOPPED", "CONNECTION_CLOSED", "CONNECTION_ERROR", "BACKPRESSURE"].includes(String(error.code))) {
      return { status: 503, code: "CODEX_UNAVAILABLE", message: "Codex runtime is temporarily unavailable", retryAfter: 2 };
    }
    return { status: 502, code: "CODEX_REQUEST_FAILED", message: "Codex runtime rejected the request" };
  }
  const status = Number(candidate?.status);
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    const message = error instanceof Error ? error.message : status >= 500 ? "Unexpected server error" : "Request failed";
    const code = typeof candidate.code === "string" ? candidate.code : status === 404 ? "NOT_FOUND" : status >= 500 ? "INTERNAL_ERROR" : "INVALID_REQUEST";
    const retryAfter = Number(candidate.retryAfter);
    return { status, code, message: status >= 500 ? "Unexpected server error" : message, ...(retryAfter > 0 ? { retryAfter } : {}) };
  }
  return { status: 500, code: "INTERNAL_ERROR", message: "Unexpected server error" };
}

function normalizeCodexRpcError(error: CodexRpcError): NormalizedHttpError {
  const message = error.message || "Codex request failed";
  const normalized = message.toLowerCase();
  if (error.code === -32602 || /invalid (?:params?|argument|request)|malformed/.test(normalized)) {
    return { status: 400, code: "INVALID_CODEX_REQUEST", message };
  }
  if (/not found|does not exist|unknown (?:thread|session)|no (?:thread|session)/.test(normalized)) {
    return { status: 404, code: "SESSION_NOT_FOUND", message: "Session not found" };
  }
  if (/already (?:active|running)|in progress|active turn|cannot .*active|conflict/.test(normalized)) {
    return { status: 409, code: "SESSION_CONFLICT", message };
  }
  if (error.transient) return { status: 503, code: "CODEX_UNAVAILABLE", message: "Codex runtime is temporarily unavailable", retryAfter: 2 };
  return { status: 502, code: "CODEX_REQUEST_FAILED", message };
}

function publicError(error: unknown): NormalizedHttpError {
  return normalizeHttpError(error);
}

function httpError(message: string, status: number, code = "REQUEST_FAILED"): Error & { status: number; code: string } {
  return Object.assign(new Error(message), { status, code });
}

function lanAddresses(listenPort: number): string[] {
  const values = new Set<string>([`http://127.0.0.1:${listenPort}`]);
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const address of interfaces || []) {
      if (address.family === "IPv4" && !address.internal) values.add(`http://${address.address}:${listenPort}`);
    }
  }
  return [...values];
}
