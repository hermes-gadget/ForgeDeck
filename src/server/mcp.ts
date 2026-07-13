import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

type JsonObject = Record<string, unknown>;
type Actor = { actorId: string; token: string };
type Bootstrap = {
  models?: { data?: JsonObject[] };
  roots?: string[];
  activeThreadIds?: string[];
  queues?: Record<string, unknown[]>;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const baseUrl = process.env.FORGEDECK_URL || `http://127.0.0.1:${process.env.FORGEDECK_PORT || "4173"}`;
const tokenFile = process.env.FORGEDECK_MCP_TOKEN_FILE || path.join(projectRoot, ".data", "mcp-token");

async function main(): Promise<void> {
const api = new ForgeDeckApi(baseUrl, tokenFile);
const server = new McpServer({ name: "forgedeck", version: "0.1.0" }, {
  instructions: "Use forgedeck_list_options before spawning when model, reasoning effort, or workspace roots are unknown. Spawned sessions appear in the user's normal ForgeDeck Control Center. You may view every session, but mutation tools work only on sessions created by this MCP client. YOLO mode disables approvals and grants full computer access; enable it only when explicitly appropriate. Remove an owned session only after its work is complete."
});

server.registerTool("forgedeck_list_options", {
  title: "List ForgeDeck session options",
  description: "List allowed workspace roots and the account's current Codex models and supported reasoning efforts. Call this before spawning if exact option values are unknown.",
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, openWorldHint: false }
}, () => safely(async () => {
  const bootstrap = await api.get<Bootstrap>("/api/bootstrap");
  return {
    workspace_roots: bootstrap.roots || [],
    models: (bootstrap.models?.data || []).map((model) => ({
      id: model.id,
      model: model.model,
      display_name: model.displayName,
      description: model.description,
      is_default: model.isDefault,
      default_reasoning_effort: model.defaultReasoningEffort,
      supported_reasoning_efforts: model.supportedReasoningEfforts
    })),
    defaults: { yolo: false },
    yolo_warning: "YOLO mode uses danger-full-access and never asks for command or file approvals."
  };
}));

server.registerTool("forgedeck_list_directories", {
  title: "Browse ForgeDeck workspaces",
  description: "Browse directories that can be selected as a session working directory. Omit path to list configured roots.",
  inputSchema: z.object({
    path: z.string().optional().describe("Absolute directory to browse; it must be within a configured ForgeDeck root.")
  }),
  annotations: { readOnlyHint: true, openWorldHint: false }
}, ({ path: directory }) => safely(async () => {
  const query = directory ? `?path=${encodeURIComponent(directory)}` : "";
  return { directories: await api.get<unknown>(`/api/directories${query}`) };
}));

server.registerTool("forgedeck_spawn_session", {
  title: "Spawn a Codex session in ForgeDeck",
  description: "Create a persistent Codex session in a chosen directory. It appears immediately as a normal user-visible Control Center card and is owned by this MCP client for mutation authorization.",
  inputSchema: z.object({
    cwd: z.string().min(1).describe("Absolute working directory inside a configured ForgeDeck workspace root."),
    model: z.string().min(1).describe("Exact model value returned by forgedeck_list_options."),
    reasoning_effort: z.string().min(1).describe("Exact supported reasoning effort returned for the selected model."),
    yolo: z.boolean().default(false).describe("Enable danger-full-access with no approvals for this session."),
    name: z.string().max(100).optional().describe("Optional Control Center session name."),
    prompt: z.string().max(100_000).optional().describe("Optional first task. When omitted, the session is created idle.")
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
}, ({ cwd, model, reasoning_effort, yolo, name, prompt }) => safely(async () => {
  const result = await api.request<JsonObject>("/api/threads", {
    method: "POST",
    body: { cwd, model, effort: reasoning_effort, yolo, name, prompt }
  });
  const createdThread = asObject(result.thread);
  const threadId = typeof createdThread.id === "string" ? createdThread.id : "";
  const detail = threadId ? await api.get<{ thread?: JsonObject }>(`/api/threads/${encodeURIComponent(threadId)}`) : {};
  const thread = detail.thread || createdThread;
  return {
    session: summarizeThread(thread, new Set(), true),
    agent_owned: true,
    visible_in_control_center: true,
    first_turn_started: Boolean(prompt)
  };
}));

server.registerTool("forgedeck_list_sessions", {
  title: "List ForgeDeck sessions",
  description: "List user-visible ForgeDeck sessions. All sessions are viewable; agent_owned marks the only sessions this MCP client may mutate.",
  inputSchema: z.object({
    search: z.string().optional(),
    active_only: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(100)
  }),
  annotations: { readOnlyHint: true, openWorldHint: false }
}, ({ search, active_only, limit }) => safely(async () => {
  const query = new URLSearchParams({ limit: String(limit), sortKey: "updated_at", sortDirection: "desc" });
  if (search) query.set("search", search);
  const [threads, bootstrap, ownership] = await Promise.all([
    api.get<{ data?: JsonObject[] }>(`/api/threads?${query}`),
    api.get<Bootstrap>("/api/bootstrap"),
    api.get<{ data?: string[] }>("/api/mcp/owned-threads")
  ]);
  const active = new Set(bootstrap.activeThreadIds || []);
  const owned = new Set(ownership.data || []);
  const sessions = (threads.data || []).map((thread) => summarizeThread(thread, active, owned.has(String(thread.id))));
  return { sessions: active_only ? sessions.filter((session) => session.state === "running") : sessions };
}));

server.registerTool("forgedeck_get_session", {
  title: "Inspect a ForgeDeck session",
  description: "Read a session's state, goal, recent conversation and tool activity, queued messages, and permission policy. User-created sessions are intentionally view-only.",
  inputSchema: z.object({
    thread_id: z.string().min(8),
    item_limit: z.number().int().min(1).max(100).default(30)
  }),
  annotations: { readOnlyHint: true, openWorldHint: false }
}, ({ thread_id, item_limit }) => safely(async () => {
  const [detail, bootstrap, ownership] = await Promise.all([
    api.get<{ thread?: JsonObject }>(`/api/threads/${encodeURIComponent(thread_id)}`),
    api.get<Bootstrap>("/api/bootstrap"),
    api.get<{ data?: string[] }>("/api/mcp/owned-threads")
  ]);
  const thread = detail.thread || {};
  const owned = new Set(ownership.data || []).has(thread_id);
  return {
    session: summarizeThread(thread, new Set(bootstrap.activeThreadIds || []), owned),
    goal: compactValue(thread.goal),
    policy: thread.policy || "workspace-write",
    queued_messages: compactValue(bootstrap.queues?.[thread_id] || []),
    recent_turns: summarizeTurns(thread.turns, item_limit),
    mutation_access: owned ? "allowed" : "view-only"
  };
}));

server.registerTool("forgedeck_send_message", {
  title: "Send or queue a message",
  description: "Send a task to an agent-owned session. If its turn is active, the message is queued and starts after the current turn, matching ForgeDeck and Codex CLI behavior. User-created sessions are always rejected.",
  inputSchema: z.object({
    thread_id: z.string().min(8),
    text: z.string().min(1).max(100_000),
    model: z.string().min(1).describe("Exact model value returned by forgedeck_list_options."),
    reasoning_effort: z.string().min(1),
    queue_if_busy: z.boolean().default(true)
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
}, ({ thread_id, text: message, model, reasoning_effort, queue_if_busy }) => safely(async () => {
  const bootstrap = await api.get<Bootstrap>("/api/bootstrap");
  const active = new Set(bootstrap.activeThreadIds || []).has(thread_id);
  const body = { text: message, model, effort: reasoning_effort };
  if (active && !queue_if_busy) throw new Error("The session is currently running; set queue_if_busy=true or wait for completion.");
  if (active) {
    return { delivery: "queued", result: await api.request(`/api/threads/${encodeURIComponent(thread_id)}/queue`, { method: "POST", body }) };
  }
  try {
    return { delivery: "started", result: await api.request(`/api/threads/${encodeURIComponent(thread_id)}/messages`, { method: "POST", body }) };
  } catch (error) {
    if (queue_if_busy && error instanceof ForgeDeckApiError && error.status === 409) {
      return { delivery: "queued", result: await api.request(`/api/threads/${encodeURIComponent(thread_id)}/queue`, { method: "POST", body }) };
    }
    throw error;
  }
}));

server.registerTool("forgedeck_stop_session", {
  title: "Stop an agent-owned session",
  description: "Interrupt the active turn of a session created by this MCP client. The server always rejects attempts to stop user-created or other agents' sessions.",
  inputSchema: z.object({ thread_id: z.string().min(8) }),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
}, ({ thread_id }) => safely(async () => ({
  stopped: true,
  result: await api.request(`/api/threads/${encodeURIComponent(thread_id)}/interrupt`, { method: "POST", body: {} })
})));

server.registerTool("forgedeck_set_yolo", {
  title: "Set an agent-owned session's YOLO mode",
  description: "Enable or disable danger-full-access/no-approval mode on an idle agent-owned session. User-created sessions and actively running turns are always rejected.",
  inputSchema: z.object({
    thread_id: z.string().min(8),
    yolo: z.boolean()
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
}, ({ thread_id, yolo }) => safely(async () => ({
  yolo,
  result: await api.request(`/api/threads/${encodeURIComponent(thread_id)}/policy`, { method: "PATCH", body: { yolo } })
})));

server.registerTool("forgedeck_remove_session", {
  title: "Remove an agent-owned session",
  description: "Archive and remove a completed or idle session created by this MCP client from the Control Center. Running sessions and every user-created or other-agent session are rejected.",
  inputSchema: z.object({ thread_id: z.string().min(8) }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
}, ({ thread_id }) => safely(async () => {
  const bootstrap = await api.get<Bootstrap>("/api/bootstrap");
  if (new Set(bootstrap.activeThreadIds || []).has(thread_id)) {
    throw new Error("The session is still running. Wait for it to finish or stop the agent-owned turn before removing it.");
  }
  await api.request(`/api/threads/${encodeURIComponent(thread_id)}`, { method: "DELETE" });
  return { removed: true, thread_id, note: "The session was archived and removed from the active Control Center." };
}));

await server.connect(new StdioServerTransport());
}

class ForgeDeckApi {
  private actorPromise: Promise<Actor> | null = null;
  private readonly url: URL;

  constructor(url: string, private readonly bootstrapTokenFile: string) {
    this.url = new URL(url.endsWith("/") ? url : `${url}/`);
  }

  get<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint);
  }

  async request<T = unknown>(endpoint: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    const actor = await this.ensureActor();
    const response = await fetch(new URL(endpoint.replace(/^\//, ""), this.url), {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${actor.token}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" })
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(70_000)
    }).catch((error) => {
      throw new Error(`Could not reach ForgeDeck at ${this.url.origin}: ${error instanceof Error ? error.message : String(error)}`);
    });
    const payload = await readResponse(response);
    if (!response.ok) throw new ForgeDeckApiError(errorMessage(payload, response.status), response.status);
    return payload as T;
  }

  private ensureActor(): Promise<Actor> {
    if (!this.actorPromise) this.actorPromise = this.registerActor();
    return this.actorPromise;
  }

  private async registerActor(): Promise<Actor> {
    let token: string;
    try {
      token = fs.readFileSync(this.bootstrapTokenFile, "utf8").trim();
    } catch {
      throw new Error(`ForgeDeck MCP token not found at ${this.bootstrapTokenFile}. Start or restart ForgeDeck before using its MCP tools.`);
    }
    const response = await fetch(new URL("api/mcp/actors", this.url), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(10_000)
    }).catch((error) => {
      throw new Error(`Could not reach ForgeDeck at ${this.url.origin}: ${error instanceof Error ? error.message : String(error)}`);
    });
    const payload = await readResponse(response);
    if (!response.ok) throw new ForgeDeckApiError(errorMessage(payload, response.status), response.status);
    const actor = asObject(payload);
    if (typeof actor.actorId !== "string" || typeof actor.token !== "string") throw new Error("ForgeDeck returned an invalid MCP actor credential");
    return { actorId: actor.actorId, token: actor.token };
  }
}

class ForgeDeckApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function safely(action: () => Promise<JsonObject>): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const result = await action();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

function summarizeThread(thread: JsonObject, activeIds: Set<string>, owned: boolean): JsonObject {
  const id = typeof thread.id === "string" ? thread.id : "";
  const turns = Array.isArray(thread.turns) ? thread.turns.map(asObject) : [];
  const lastTurn = turns.at(-1);
  const status = asObject(thread.status).type;
  const running = activeIds.has(id) || status === "active" || lastTurn?.status === "inProgress";
  return {
    id,
    name: thread.name || null,
    preview: thread.preview || "",
    cwd: thread.cwd || "",
    created_at: thread.createdAt || null,
    updated_at: thread.updatedAt || null,
    state: running ? "running" : lastTurn?.status || "idle",
    agent_owned: owned,
    mutation_access: owned ? "allowed" : "view-only"
  };
}

function summarizeTurns(value: unknown, itemLimit: number): unknown[] {
  const turns = Array.isArray(value) ? value.map(asObject) : [];
  let remaining = itemLimit;
  const result: unknown[] = [];
  for (const turn of [...turns].reverse()) {
    if (remaining <= 0) break;
    const items = Array.isArray(turn.items) ? turn.items.map(asObject) : [];
    const selected = items.slice(-remaining).map(summarizeItem);
    remaining -= selected.length;
    result.unshift({
      id: turn.id,
      status: turn.status,
      error: compactValue(turn.error),
      items: selected
    });
  }
  return result;
}

function summarizeItem(item: JsonObject): JsonObject {
  const keys = ["id", "type", "status", "text", "content", "summary", "command", "cwd", "aggregatedOutput", "exitCode", "changes", "server", "tool", "arguments", "result", "error"];
  return Object.fromEntries(keys.filter((key) => item[key] !== undefined).map((key) => [key, compactValue(item[key])]));
}

function compactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > 8_000 ? `${value.slice(0, 8_000)}\n…[truncated]` : value;
  if (value === null || typeof value !== "object") return value;
  if (depth >= 5) return "[nested value omitted]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => compactValue(item, depth + 1));
  return Object.fromEntries(Object.entries(value as JsonObject).slice(0, 100).map(([key, item]) => [key, compactValue(item, depth + 1)]));
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(payload: unknown, status: number): string {
  const error = asObject(payload).error;
  return typeof error === "string" ? error : `ForgeDeck request failed with HTTP ${status}`;
}

await main();
