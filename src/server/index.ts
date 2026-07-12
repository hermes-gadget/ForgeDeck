import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { AuthManager } from "./auth.js";
import { CodexBridge, type ServerRequest } from "./codex-bridge.js";
import { PathError, WorkspacePaths } from "./paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const dataDir = path.join(projectRoot, ".data");
const distDir = path.join(projectRoot, "dist");
const host = process.env.FORGEDECK_HOST || "0.0.0.0";
const port = parsePort(process.env.FORGEDECK_PORT || "4173");
const auth = new AuthManager(dataDir);
const workspaces = await WorkspacePaths.create();
const codex = new CodexBridge();
const app = express();
const sseClients = new Set<Response>();

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

app.use("/api", auth.requireAuth);
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
    res.json({ models, account, usage, roots: workspaces.roots, pendingRequests: codex.listServerRequests() });
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
    res.json(await codex.request("thread/list", params));
  } catch (error) {
    next(error);
  }
});

app.post("/api/threads", async (req, res, next) => {
  try {
    const cwd = await workspaces.validate(requiredString(req.body?.cwd, "Directory"));
    const model = requiredString(req.body?.model, "Model");
    const effort = optionalString(req.body?.effort);
    await validateModelChoice(model, effort);
    const result = await codex.request<{ thread: { id: string } }>("thread/start", {
      cwd,
      runtimeWorkspaceRoots: [cwd],
      model,
      allowProviderModelFallback: false,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      ephemeral: false,
      serviceName: "ForgeDeck"
    });
    const threadId = result.thread.id;
    const name = optionalString(req.body?.name);
    if (name) await codex.request("thread/name/set", { threadId, name: name.slice(0, 100) });
    const prompt = optionalString(req.body?.prompt);
    if (prompt) await startTurn(threadId, prompt, model, effort);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/api/threads/:threadId", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    res.json(await codex.request("thread/read", { threadId, includeTurns: true }, 60_000));
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
    await codex.request("thread/resume", { threadId, model, excludeTurns: true }, 60_000);
    res.status(202).json(await startTurn(threadId, text, model, effort));
  } catch (error) {
    next(error);
  }
});

app.post("/api/threads/:threadId/interrupt", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    const turnId = requiredString(req.body?.turnId, "Turn id");
    res.json(await codex.request("turn/interrupt", { threadId, turnId }));
  } catch (error) {
    next(error);
  }
});

app.patch("/api/threads/:threadId", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    const name = requiredString(req.body?.name, "Name").slice(0, 100);
    res.json(await codex.request("thread/name/set", { threadId, name }));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/threads/:threadId", async (req, res, next) => {
  try {
    const threadId = validThreadId(req.params.threadId);
    res.json(await codex.request("thread/archive", { threadId }));
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

codex.on("notification", (payload) => broadcast("codex", payload));
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
const server = app.listen(port, host, () => {
  const addresses = lanAddresses(port);
  console.log(`\n  ForgeDeck is online`);
  for (const address of addresses) console.log(`  ${address}`);
  if (!auth.enabled) console.log("\n  Authentication: disabled by FORGEDECK_AUTH=off");
  else if (auth.generatedTokenPath) console.log(`\n  Access key file: ${auth.generatedTokenPath}`);
  console.log("\n  Closing a browser will not stop active Codex turns.\n");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    codex.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}

async function startTurn(threadId: string, text: string, model: string, effort: string | null): Promise<unknown> {
  return codex.request("turn/start", {
    threadId,
    input: [{ type: "text", text, text_elements: [] }],
    model,
    effort: effort || undefined
  }, 60_000);
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
