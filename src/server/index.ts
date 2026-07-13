import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { AuthManager } from "./auth.js";
import { CodexBridge, type ServerRequest } from "./codex-bridge.js";
import { ExternalCodexMonitor } from "./external-monitor.js";
import { McpAccessManager } from "./mcp-access.js";
import { PathError, WorkspacePaths } from "./paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const dataDir = path.join(projectRoot, ".data");
const distDir = path.join(projectRoot, "dist");
const host = process.env.FORGEDECK_HOST || "0.0.0.0";
const port = parsePort(process.env.FORGEDECK_PORT || "4173");
const auth = new AuthManager(dataDir);
const mcpAccess = new McpAccessManager(dataDir);
const workspaces = await WorkspacePaths.create();
const codex = new CodexBridge();
const app = express();
const sseClients = new Set<Response>();
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
const drainingQueues = new Set<string>();
const bridgeOwnedThreads = new Set<string>();
const capacityBuffers = new Map<string, string>();
const capacityHandledThreads = new Set<string>();
type LiveThreadState = {
  items: Record<string, Record<string, unknown>>;
  agentText: Record<string, string>;
  toolOutput: Record<string, string>;
  active: boolean;
  completedAt: number | null;
  updatedAt: number;
};
const liveThreadStates = new Map<string, LiveThreadState>();

app.disable("x-powered-by");
app.use(securityHeaders);
app.use(express.json({ limit: "256kb" }));

app.get("/api/auth", (req, res) => res.json({ authenticated: auth.isAuthenticated(req) }));
app.post("/api/login", (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  const result = auth.login(req.ip || req.socket.remoteAddress || "unknown", token);
  if (!result.ok) {
    if (result.retryAfter) res.setHeader("Retry-After", result.retryAfter);
    res.status(result.retryAfter ? 429 : 401).json({ error: result.retryAfter ? "Too many attempts. Try again later." : "Incorrect access key" });
    return;
  }
  auth.setCookie(res, result.sessionId!);
  res.json({ ok: true });
});

app.post("/api/mcp/actors", mcpAccess.requireBootstrap, (_req, res) => {
  res.status(201).json(mcpAccess.registerActor());
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
app.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) {
        res.status(403).json({ error: "Cross-origin request rejected" });
        return;
      }
    } catch {
      res.status(403).json({ error: "Invalid request origin" });
      return;
    }
  }
  next();
});

app.get("/api/mcp/owned-threads", (_req, res) => {
  const actorId = typeof res.locals.mcpActorId === "string" ? res.locals.mcpActorId : "";
  res.json({ data: mcpAccess.listOwnedThreads(actorId) });
});

app.post("/api/logout", (req, res) => {
  auth.logout(req, res);
  res.json({ ok: true });
});

app.get("/api/bootstrap", async (_req, res, next) => {
  try {
    const [models, account, usage] = await Promise.all([
      codex.request("model/list", { limit: 100, includeHidden: false }),
      codex.request("account/read", { refreshToken: false }).catch(() => ({ account: null, requiresOpenaiAuth: true })),
      codex.request("account/rateLimits/read").catch(() => null)
    ]);
    res.json({ models, account, usage, roots: workspaces.roots, pendingRequests: codex.listServerRequests(), liveState: Object.fromEntries(liveThreadStates), queues: Object.fromEntries(messageQueues), activeThreadIds: [...activeThreads], agentThreadIds: mcpAccess.listAgentThreads() });
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
    const result = await codex.request<{ data: Array<Record<string, unknown>>; nextCursor: string | null }>("thread/list", params);
    if (!params.cursor) {
      const listed = new Set(result.data.map((thread) => String(thread.id || "")));
      const missingIds = mcpAccess.listAgentThreads().filter((threadId) => !listed.has(threadId));
      const missing = await Promise.allSettled(missingIds.map((threadId) =>
        codex.request<{ thread: Record<string, unknown> }>("thread/read", { threadId, includeTurns: false }, 60_000)
      ));
      const search = params.searchTerm?.toLowerCase();
      for (const snapshot of missing) {
        if (snapshot.status !== "fulfilled") continue;
        const thread = snapshot.value.thread;
        const searchable = `${thread.name || ""} ${thread.preview || ""} ${thread.cwd || ""}`.toLowerCase();
        if (!search || searchable.includes(search)) result.data.push(thread);
      }
      result.data.sort((left, right) => compareThreadListEntries(left, right, params.sortKey, params.sortDirection));
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/threads", async (req, res, next) => {
  try {
    const cwd = await workspaces.validate(requiredString(req.body?.cwd, "Directory"));
    const model = requiredString(req.body?.model, "Model");
    const effort = optionalString(req.body?.effort);
    const yolo = req.body?.yolo === true;
    await validateModelChoice(model, effort);
    const result = await codex.request<{ thread: { id: string } }>("thread/start", {
      cwd,
      runtimeWorkspaceRoots: [cwd],
      model,
      allowProviderModelFallback: false,
      approvalPolicy: yolo ? "never" : "on-request",
      sandbox: yolo ? "danger-full-access" : "workspace-write",
      ephemeral: false,
      serviceName: "ForgeDeck"
    });
    const threadId = result.thread.id;
    const mcpActorId = typeof res.locals.mcpActorId === "string" ? res.locals.mcpActorId : null;
    if (mcpActorId) mcpAccess.assignThread(threadId, mcpActorId);
    threadPolicies.set(threadId, yolo ? "yolo" : "workspace-write");
    persistThreadPolicies();
    const name = optionalString(req.body?.name);
    if (name) await codex.request("thread/name/set", { threadId, name: name.slice(0, 100) });
    broadcast("threads", { action: "created", threadId });
    const prompt = optionalString(req.body?.prompt);
    if (prompt) {
      bridgeOwnedThreads.add(threadId);
      await startTurn(threadId, prompt, model, effort);
    }
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/threads/:threadId", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    const [snapshot, goal] = await Promise.all([
      codex.request<{ thread: Record<string, unknown> }>("thread/read", { threadId, includeTurns: true }, 60_000),
      codex.request<{ goal: Record<string, unknown> | null }>("thread/goal/get", { threadId }).catch(() => ({ goal: null }))
    ]);
    res.json({ ...snapshot, thread: { ...snapshot.thread, goal: goal.goal, policy: threadPolicies.get(threadId) || "workspace-write" } });
  } catch (error) {
    next(error);
  }
});

app.post("/api/threads/:threadId/messages", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    const text = requiredString(req.body?.text, "Message");
    if (text.length > 100_000) throw httpError("Message is too long", 413);
    const model = requiredString(req.body?.model, "Model");
    const effort = optionalString(req.body?.effort);
    await validateModelChoice(model, effort);
    bridgeOwnedThreads.add(threadId);
    await codex.request("thread/resume", { threadId, model, excludeTurns: true }, 60_000);
    res.status(202).json(await startTurn(threadId, text, model, effort));
  } catch (error) {
    next(error);
  }
});

app.post("/api/threads/:threadId/command", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    const command = requiredString(req.body?.command, "Command").toLowerCase();
    const args = optionalString(req.body?.args);
    if (command === "compact") {
      res.json(await codex.request("thread/compact/start", { threadId }, 60_000));
      return;
    }
    if (command === "stop") {
      const turnId = await findActiveTurnId(threadId);
      if (!turnId) throw httpError("This session has no active turn", 409);
      res.json(await codex.request("turn/interrupt", { threadId, turnId }));
      return;
    }
    if (command === "rename") {
      if (!args) throw httpError("Use /rename followed by a session name", 400);
      const result = await codex.request("thread/name/set", { threadId, name: args.slice(0, 100) });
      broadcast("threads", { action: "updated", threadId });
      res.json(result);
      return;
    }
    if (command === "archive") {
      const result = await codex.request("thread/archive", { threadId });
      if (messageQueues.delete(threadId)) persistMessageQueues();
      if (threadPolicies.delete(threadId)) persistThreadPolicies();
      mcpAccess.releaseThread(threadId);
      broadcastQueue(threadId);
      broadcast("threads", { action: "removed", threadId });
      res.json(result);
      return;
    }
    if (command === "goal") {
      const operation = args?.toLowerCase();
      if (!args || operation === "view") {
        res.json(await codex.request("thread/goal/get", { threadId }));
        return;
      }
      if (operation === "clear") {
        res.json(await codex.request("thread/goal/clear", { threadId }));
        return;
      }
      if (operation === "pause" || operation === "resume") {
        res.json(await codex.request("thread/goal/set", { threadId, status: operation === "pause" ? "paused" : "active" }));
        return;
      }
      const objective = args.replace(/^set\s+/i, "").trim();
      if (!objective) throw httpError("Use /goal followed by an objective", 400);
      res.json(await codex.request("thread/goal/set", { threadId, objective, status: "active" }));
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
    const text = requiredString(req.body?.text, "Message");
    if (text.length > 100_000) throw httpError("Message is too long", 413);
    const model = requiredString(req.body?.model, "Model");
    const effort = optionalString(req.body?.effort);
    await validateModelChoice(model, effort);
    const entry: QueuedMessage = { id: crypto.randomUUID(), text, model, effort, createdAt: Date.now() };
    const queue = messageQueues.get(threadId) || [];
    queue.push(entry);
    messageQueues.set(threadId, queue);
    persistMessageQueues();
    broadcastQueue(threadId);
    void drainQueue(threadId);
    res.status(202).json({ queued: entry, position: queue.length });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/threads/:threadId/queue/:queueId", (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    const queue = messageQueues.get(threadId) || [];
    const nextQueue = queue.filter((entry) => entry.id !== req.params.queueId);
    if (nextQueue.length === queue.length) throw httpError("Queued message not found", 404);
    if (nextQueue.length) messageQueues.set(threadId, nextQueue);
    else messageQueues.delete(threadId);
    persistMessageQueues();
    broadcastQueue(threadId);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/threads/:threadId/interrupt", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    const requestedTurnId = optionalString(req.body?.turnId);
    const turnId = requestedTurnId || await findActiveTurnId(threadId);
    if (!turnId) throw httpError("This session has no active turn", 409);
    res.json(await codex.request("turn/interrupt", { threadId, turnId }));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/threads/:threadId/policy", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    if (activeThreads.has(threadId) || await findActiveTurnId(threadId)) throw httpError("Stop or finish the current turn before changing permissions", 409);
    const policy: ThreadPolicy = req.body?.yolo === true ? "yolo" : "workspace-write";
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
    res.json({ policy });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/threads/:threadId", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    const name = requiredString(req.body?.name, "Name").slice(0, 100);
    const result = await codex.request("thread/name/set", { threadId, name });
    broadcast("threads", { action: "updated", threadId });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/threads/:threadId", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    const result = await codex.request("thread/archive", { threadId });
    if (messageQueues.delete(threadId)) persistMessageQueues();
    if (threadPolicies.delete(threadId)) persistThreadPolicies();
    mcpAccess.releaseThread(threadId);
    broadcastQueue(threadId);
    broadcast("threads", { action: "removed", threadId });
    res.json(result);
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
  res.write(`event: connected\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
  sseClients.add(res);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20_000);
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
    if (threadId) bridgeOwnedThreads.delete(threadId);
  }
});
codex.on("serverRequest", (payload) => broadcast("approval", payload));
codex.on("serverRequestResolved", (payload) => broadcast("approval-resolved", payload));
codex.on("offline", (payload) => broadcast("runtime", { state: "offline", ...payload }));
codex.on("ready", () => broadcast("runtime", { state: "ready" }));
codex.on("error", (error) => {
  console.error("[ForgeDeck] Codex runtime error:", error);
  broadcast("runtime", { state: "error", message: error instanceof Error ? error.message : String(error) });
});

if (fs.existsSync(distDir)) {
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

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = error instanceof PathError ? error.status : Number((error as { status?: number })?.status) || 500;
  const message = error instanceof Error ? error.message : "Unexpected server error";
  if (status >= 500) console.error("[ForgeDeck]", error);
  res.status(status).json({ error: status >= 500 ? `Codex runtime error: ${message}` : message });
});

await codex.start();
const externalMonitor = new ExternalCodexMonitor((notification, historical) => {
  const threadId = typeof notification.params.threadId === "string" ? notification.params.threadId : null;
  if (threadId && bridgeOwnedThreads.has(threadId)) return;
  if (!historical) resumeGoalAfterCapacity(notification);
  recordLiveEvent(notification, "external");
  const outbound = canonicalActivityNotification(notification);
  if (outbound) broadcast("codex", outbound);
});
externalMonitor.start();
for (const threadId of messageQueues.keys()) void drainQueue(threadId);
const server = app.listen(port, host, () => {
  const addresses = lanAddresses(port);
  console.log(`\n  ForgeDeck is online`);
  for (const address of addresses) console.log(`  ${address}`);
  if (!auth.enabled) console.log("\n  Authentication: disabled by FORGEDECK_AUTH=off");
  else if (auth.generatedTokenPath) console.log(`\n  Access key file: ${auth.generatedTokenPath}`);
  console.log(`  MCP bootstrap token: ${mcpAccess.bootstrapTokenPath}`);
  console.log("\n  Closing a browser will not stop active Codex turns.\n");
});

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    externalMonitor.stop();
    for (const client of sseClients) client.end();
    sseClients.clear();
    server.close(() => process.exit(0));
    server.closeAllConnections();
    codex.stop();
    setTimeout(() => process.exit(1), 5000).unref();
  });
}

async function startTurn(threadId: string, text: string, model: string, effort: string | null): Promise<unknown> {
  const policy = threadPolicies.get(threadId);
  return codex.request("turn/start", {
    threadId,
    input: [{ type: "text", text, text_elements: [] }],
    model,
    effort: effort || undefined,
    ...(policy === "yolo" ? {
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" }
    } : {})
  }, 60_000);
}

async function drainQueue(threadId: string): Promise<void> {
  if (drainingQueues.has(threadId) || activeThreads.has(threadId) || !(messageQueues.get(threadId)?.length)) return;
  drainingQueues.add(threadId);
  let entry: QueuedMessage | undefined;
  try {
    const snapshot = await codex.request<{ thread: ThreadSnapshot }>("thread/read", { threadId, includeTurns: true }, 60_000);
    const lastTurn = snapshot.thread.turns?.at(-1);
    if (snapshot.thread.status?.type === "active" || lastTurn?.status === "inProgress") {
      setThreadActivity(threadId, "bridge", true);
      return;
    }
    const queue = messageQueues.get(threadId) || [];
    entry = queue[0];
    if (!entry) return;
    setThreadActivity(threadId, "bridge", true);
    bridgeOwnedThreads.add(threadId);
    await codex.request("thread/resume", { threadId, model: entry.model, excludeTurns: true }, 60_000);
    await startTurn(threadId, entry.text, entry.model, entry.effort);
    queue.shift();
    if (queue.length) messageQueues.set(threadId, queue);
    else messageQueues.delete(threadId);
    persistMessageQueues();
    broadcastQueue(threadId);
  } catch (error) {
    setThreadActivity(threadId, "bridge", false);
    if (entry) {
      broadcastQueue(threadId, error instanceof Error ? error.message : String(error));
    }
    console.error(`[ForgeDeck] Could not start queued turn for ${threadId}:`, error);
  } finally {
    drainingQueues.delete(threadId);
  }
}

async function findActiveTurnId(threadId: string): Promise<string | null> {
  const known = activeTurnIds.get(threadId);
  if (known) return known;
  const snapshot = await codex.request<{ thread: ThreadSnapshot }>("thread/read", { threadId, includeTurns: true }, 60_000);
  return [...(snapshot.thread.turns || [])].reverse().find((turn) => turn.status === "inProgress")?.id || null;
}

type ThreadSnapshot = { status?: { type?: string }; turns?: Array<{ id?: string; status?: string }> };

function loadMessageQueues(): Map<string, QueuedMessage[]> {
  try {
    if (!fs.existsSync(queueFile)) return new Map();
    const parsed = JSON.parse(fs.readFileSync(queueFile, "utf8")) as Record<string, QueuedMessage[]>;
    return new Map(Object.entries(parsed).filter(([, queue]) => Array.isArray(queue) && queue.length));
  } catch (error) {
    console.error("[ForgeDeck] Ignoring invalid message queue file:", error);
    return new Map();
  }
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
    const parsed = JSON.parse(fs.readFileSync(policyFile, "utf8")) as Record<string, unknown>;
    return new Map(Object.entries(parsed).filter((entry): entry is [string, ThreadPolicy] => entry[1] === "workspace-write" || entry[1] === "yolo"));
  } catch (error) {
    console.error("[ForgeDeck] Ignoring invalid thread policy file:", error);
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
  const response = await codex.request<{ data: Array<{ id: string; model: string; supportedReasoningEfforts: Array<{ reasoningEffort: string }> }> }>(
    "model/list", { limit: 100, includeHidden: false }
  );
  const model = response.data.find((item) => item.id === modelId || item.model === modelId);
  if (!model) throw httpError("That model is not available on this Codex account", 400);
  if (effort && !model.supportedReasoningEfforts.some((item) => item.reasoningEffort === effort)) {
    throw httpError("That reasoning level is not available for the selected model", 400);
  }
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
  for (const client of sseClients) client.write(message);
}

function recordLiveEvent(notification: { method: string; params?: Record<string, unknown> }, source: ActivitySource): void {
  const params = notification.params;
  const threadId = typeof params?.threadId === "string" ? params.threadId : null;
  if (!threadId) return;
  if (notification.method === "turn/started") {
    setThreadActivity(threadId, source, true);
    const turn = params?.turn as { id?: unknown } | undefined;
    if (typeof turn?.id === "string") activeTurnIds.set(threadId, turn.id);
  }
  if (notification.method === "turn/completed") {
    setThreadActivity(threadId, source, false);
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
    liveThreadStates.delete(threadId);
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
    state.agentText[params.itemId] = (state.agentText[params.itemId] || "") + String(params.delta || "");
    trimRecord(state.agentText, 16);
  }
  if ((notification.method === "item/commandExecution/outputDelta" || notification.method === "item/fileChange/outputDelta") && typeof params?.itemId === "string") {
    state.toolOutput[params.itemId] = (state.toolOutput[params.itemId] || "") + String(params.delta || "");
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
    console.log(`[ForgeDeck] Resumed goal for ${threadId} after the selected model reported capacity`);
  }).catch((error) => {
    console.error(`[ForgeDeck] Could not resume goal for ${threadId} after a model-capacity error:`, error);
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

setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60_000;
  for (const [threadId, state] of liveThreadStates) if (state.updatedAt < cutoff) liveThreadStates.delete(threadId);
}, 10 * 60_000).unref();

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
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validThreadId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(value)) throw httpError("Invalid thread id", 400);
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

function compareThreadListEntries(left: Record<string, unknown>, right: Record<string, unknown>, sortKey: "created_at" | "updated_at", direction: "asc" | "desc"): number {
  const key = sortKey === "created_at" ? "createdAt" : "updatedAt";
  const leftValue = Number(left[key] || 0);
  const rightValue = Number(right[key] || 0);
  return (leftValue - rightValue) * (direction === "asc" ? 1 : -1);
}

function httpError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function parsePort(value: string): number {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1 || result > 65535) throw new Error("FORGEDECK_PORT must be a valid port");
  return result;
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
