import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  MODEL_PRESETS,
  mcpArtifactListOutputSchema as artifactListOutputSchema,
  mcpArtifactOutputSchema as artifactOutputSchema,
  mcpBatchMutationOutputSchema as batchMutationOutputSchema,
  mcpBatchSpawnInputSchema as batchSpawnInputSchema,
  mcpBatchSpawnOutputSchema as batchSpawnOutputSchema,
  mcpBatchThreadsInputSchema as batchThreadsInputSchema,
  mcpClaimSessionsInputSchema as claimSessionsInputSchema,
  mcpClaimSessionsOutputSchema as claimSessionsOutputSchema,
  mcpDirectoriesOutputSchema as directoriesOutputSchema,
  mcpEmptyInputSchema as emptyInputSchema,
  mcpCreateHandoffOutputSchema as handoffOfferOutputSchema,
  mcpGetSessionInputSchema as getSessionInputSchema,
  mcpGetArtifactInputSchema as getArtifactInputSchema,
  mcpHandoffSessionsInputSchema as handoffSessionsInputSchema,
  mcpHandoffSessionsOutputSchema as handoffSessionsOutputSchema,
  mcpHealthOutputSchema as healthOutputSchema,
  mcpListDirectoriesInputSchema as listDirectoriesInputSchema,
  mcpListSessionsInputSchema as listSessionsInputSchema,
  mcpListArtifactsInputSchema as listArtifactsInputSchema,
  mcpOptionsOutputSchema as optionsOutputSchema,
  mcpPublishArtifactInputSchema as publishArtifactInputSchema,
  mcpRevokeIdentityInputSchema as revokeIdentityInputSchema,
  mcpRevokeIdentityOutputSchema as revokeIdentityOutputSchema,
  mcpSendMessageInputSchema as sendMessageInputSchema,
  mcpSendMessageOutputSchema as sendMessageOutputSchema,
  mcpSessionDetailOutputSchema as sessionDetailOutputSchema,
  mcpSessionListOutputSchema as sessionListOutputSchema,
  mcpSetYoloOutputSchema as setYoloOutputSchema,
  mcpSetYoloInputSchema as setYoloInputSchema,
  mcpUsageSchema as usageSchema,
  mcpWaitSessionInputSchema as waitSessionInputSchema,
  mcpWaitSessionOutputSchema as waitSessionOutputSchema,
  threadIdSchema
} from "../shared/contracts.js";
import { KeyedAsyncTtlCache } from "./async-cache.js";
import {
  isSessionActiveError,
  MCP_API_TIMEOUT_MS,
  MCP_HEALTH_TIMEOUT_MS,
  type ForgeDeckApiClient
} from "./mcp-client.js";
import { McpServer } from "./mcp-sdk.js";
import {
  asObject,
  compactValue,
  isAdapterBusyError,
  presentToolResult,
  presentUsage,
  summarizeAgentMessages,
  summarizeBriefThread,
  summarizeLastActivity,
  summarizeSessionFiles,
  summarizeSessionHealth,
  summarizeThread,
  summarizeTurnsPage,
  toolErrorMessage,
  type JsonObject
} from "./mcp-presenters.js";
import { AdaptiveOperationPool } from "./operation-pool.js";
import type { AccountStatus, Bootstrap, McpSpawnSessionInput } from "../shared/contracts.js";

type SessionList = { sessions: JsonObject[] };

export const DEFAULT_LIST_SESSIONS_TTL_MS = 2_000;

export type ForgeDeckMcpServerOptions = Readonly<{
  listSessionsCacheTtlMs: number;
  mutationMaxConcurrency: number;
}>;

/** Builds the real MCP tool surface without opening a transport. */
export function createForgeDeckMcpServer(
  api: ForgeDeckApiClient,
  options: ForgeDeckMcpServerOptions = {
    listSessionsCacheTtlMs: DEFAULT_LIST_SESSIONS_TTL_MS,
    mutationMaxConcurrency: 5
  }
): McpServer {
const listSessionsCache = new KeyedAsyncTtlCache<SessionList>(options.listSessionsCacheTtlMs);
const mutationOperations = new AdaptiveOperationPool({
  name: "mcp-mutation",
  maxConcurrency: options.mutationMaxConcurrency,
  minConcurrency: 1,
  latencyTargetMs: 5_000,
  isBackpressureError: (error) => {
    const status = Number((error as { status?: unknown }).status);
    return status === 429 || status >= 500;
  }
});
const server = new McpServer({ name: "forgedeck", version: "0.1.0" }, {
  instructions: "Use forgedeck_list_options before spawning when presets, models, reasoning effort, or workspace roots are unknown. A preset is a transparent fixed model and effort mapping. Spawned sessions appear in the user's normal ForgeDeck Control Center. You may view every session, but mutation tools work only on sessions created by this MCP client. YOLO mode disables approvals and grants full computer access; enable it only when explicitly appropriate. Remove an owned session only after its work is complete."
});

server.registerTool("forgedeck_health_check", {
  title: "Check ForgeDeck connectivity",
  description: "Check API, authentication, and adapter readiness.",
  inputSchema: emptyInputSchema,
  outputSchema: healthOutputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false }
}, () => presentToolResult(async () => {
  const startedAt = Date.now();
  await api.request("/api/mcp/owned-threads", { timeoutMs: MCP_HEALTH_TIMEOUT_MS });
  const forgeDeckLatencyMs = Date.now() - startedAt;
  try {
    const bootstrap = await api.request<Bootstrap>("/api/bootstrap", { timeoutMs: MCP_HEALTH_TIMEOUT_MS });
    return {
      status: "ok",
      forgedeck: "reachable",
      codex_adapter: "ready",
      latency_ms: Date.now() - startedAt,
      forgedeck_latency_ms: forgeDeckLatencyMs,
      model_count: bootstrap.models?.data?.length || 0,
      session_spawned: false
    };
  } catch (error) {
    return {
      status: "degraded",
      forgedeck: "reachable",
      codex_adapter: isAdapterBusyError(error) ? "busy" : "unavailable",
      latency_ms: Date.now() - startedAt,
      error: toolErrorMessage(error),
      retryable: true,
      session_spawned: false
    };
  }
}));

server.registerTool("forgedeck_list_options", {
  title: "List ForgeDeck session options",
  description: "List workspace roots, models, efforts, defaults, and backend availability.",
  inputSchema: emptyInputSchema,
  outputSchema: optionsOutputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false }
}, () => presentToolResult(async () => {
  const [bootstrap, status] = await Promise.all([
    api.get<Bootstrap>("/api/bootstrap"),
    api.get<AccountStatus>("/api/account/status")
  ]);
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
    presets: Object.entries(MODEL_PRESETS).map(([preset, target]) => ({ preset, ...target })),
    claude_available: status.claudeAvailable === true,
    claude_models: (bootstrap.claudeModelOptions || []).map((model) => ({
      id: model.id,
      model: model.model,
      display_name: model.displayName,
      description: model.description
    })),
    usage: presentUsage(status, bootstrap),
    defaults: { yolo: false, session_class: "standard", class: "standard" },
    yolo_warning: "YOLO mode uses danger-full-access and never asks for command or file approvals."
  };
}));

server.registerTool("forgedeck_get_usage", {
  title: "Get ForgeDeck backend usage",
  description: "Report backend availability and rate-limit usage.",
  inputSchema: emptyInputSchema,
  outputSchema: usageSchema,
  annotations: { readOnlyHint: true, openWorldHint: false }
}, () => presentToolResult(async () => presentUsage(await api.get<AccountStatus>("/api/account/status"))));

server.registerTool("forgedeck_list_directories", {
  title: "Browse ForgeDeck workspaces",
  description: "Browse allowed workspace directories.",
  inputSchema: listDirectoriesInputSchema,
  outputSchema: directoriesOutputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false }
}, ({ path: directory }) => presentToolResult(async () => {
  const validatedDirectory = directory ? await validateWorkspacePath(api, directory) : undefined;
  const query = validatedDirectory ? `?path=${encodeURIComponent(validatedDirectory)}` : "";
  return { directories: await api.get<unknown>(`/api/directories${query}`) };
}));

server.registerTool("forgedeck_list_sessions", {
  title: "List ForgeDeck sessions",
  description: "List sessions and this client's mutation access.",
  inputSchema: listSessionsInputSchema,
  outputSchema: sessionListOutputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false }
}, ({ query: search, active, limit }) => presentToolResult(async () => {
  const cacheKey = JSON.stringify([search || "", limit]);
  const result = await listSessionsCache.get(cacheKey, async () => {
    const query = new URLSearchParams({ limit: String(limit), sortKey: "updated_at", sortDirection: "desc" });
    if (search) query.set("search", search);
    const [threads, status, ownership] = await Promise.all([
      api.get<{ data?: JsonObject[] }>(`/api/threads?${query}`),
      api.get<AccountStatus>("/api/account/status"),
      api.get<{ data?: string[] }>("/api/mcp/owned-threads")
    ]);
    const active = new Set(status.activeThreadIds || []);
    const owned = new Set(ownership.data || []);
    const sessions = (threads.data || []).map((thread) => ({
      ...summarizeThread(thread, active, owned.has(String(thread.id))),
      health: summarizeSessionHealth(thread, active),
      last_activity: summarizeLastActivity(thread),
      files_count: summarizeSessionFiles(thread, []).length
    }));
    return { sessions };
  });
  return { sessions: active ? result.sessions.filter((session) => session.state === "running") : result.sessions };
}));

server.registerTool("forgedeck_get_session", {
  title: "Inspect a ForgeDeck session",
  description: "Inspect session state, history, queue, goal, and policy.",
  inputSchema: getSessionInputSchema,
  outputSchema: sessionDetailOutputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false }
}, ({ id, brief, limit, offset, cursor }) => presentToolResult(
  () => inspectSession(api, id, { brief, limit, offset, cursor })
));

server.registerTool("forgedeck_wait", {
  title: "Wait for a ForgeDeck session",
  description: "Wait for a session to complete, fail, be interrupted, or be archived.",
  inputSchema: waitSessionInputSchema,
  outputSchema: waitSessionOutputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false }
}, ({ id, timeout }) => presentToolResult(async () => {
  const deadline = Date.now() + timeout * 1_000;
  while (true) {
    const [detail, status] = await Promise.all([
      api.get<{ thread?: JsonObject }>(`/api/threads/${encodeURIComponent(id)}`),
      api.get<AccountStatus>("/api/account/status")
    ]);
    const thread = detail.thread || {};
    const state = waitSessionState(thread, new Set(status.activeThreadIds || []));
    if (["completed", "failed", "interrupted", "archived"].includes(state) || Date.now() >= deadline) {
      return inspectSession(api, id, { brief: true, detail, status });
    }
    await operationPollDelay(Math.min(2_000, Math.max(1, deadline - Date.now())));
  }
}));

server.registerTool("forgedeck_claim_sessions", {
  title: "Claim ForgeDeck sessions",
  description: "Claim comma-separated session IDs for this MCP identity.",
  inputSchema: claimSessionsInputSchema,
  outputSchema: claimSessionsOutputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
}, ({ ids }) => presentToolResult(async () => {
  const result = await api.request<{ actorId: string; threadIds: string[] }>("/api/mcp/owned-threads/claim", {
    method: "POST",
    body: { threadIds: ids }
  });
  listSessionsCache.clear();
  return { ids: result.threadIds, actor: result.actorId };
}));

async function inspectSession(
  api: ForgeDeckApiClient,
  id: string,
  options: {
    brief: boolean;
    limit?: number;
    offset?: number;
    cursor?: string;
    detail?: { thread?: JsonObject };
    status?: AccountStatus;
  }
): Promise<JsonObject> {
  const { brief, limit = 30, offset = 0, cursor } = options;
  const queueQuery = new URLSearchParams({ threadIds: id });
  const [detail, status, queues, ownership, artifactResult] = await Promise.all([
    options.detail || api.get<{ thread?: JsonObject }>(`/api/threads/${encodeURIComponent(id)}`),
    options.status || api.get<AccountStatus>("/api/account/status"),
    brief ? Promise.resolve(null) : api.get<{ data?: Record<string, unknown[]> }>(`/api/queues?${queueQuery}`),
    api.get<{ data?: string[] }>("/api/mcp/owned-threads"),
    api.get<{ data?: unknown[]; completion?: unknown }>(`/api/sessions/${encodeURIComponent(id)}/artifacts`)
  ]);
  const thread = detail.thread || {};
  const activeIds = new Set(status.activeThreadIds || []);
  const artifacts = artifactResult.data || [];
  const owned = new Set(ownership.data || []).has(id);
  const recentAgentMessages = summarizeAgentMessages(thread.turns, 2);
  const fullSession = summarizeThread(thread, activeIds, owned);
  const briefSession = summarizeBriefThread(thread, activeIds, owned);
  if (thread.archiveState === "archived") {
    fullSession.state = "archived";
    briefSession.state = "archived";
  }
  const common = {
    session: fullSession,
    policy: typeof thread.policy === "string" ? thread.policy : "workspace-write",
    files: summarizeSessionFiles(thread, artifacts),
    health: summarizeSessionHealth(thread, activeIds),
    last_message: recentAgentMessages.at(-1) || "",
    completion: compactValue(artifactResult.completion) || compactValue(thread.artifactStatus) || {
      status: "not-configured", artifactCount: 0, validArtifactCount: 0,
      requiredGateCount: 0, metGateCount: 0, unmetGates: []
    }
  };
  if (brief) return {
    ...common,
    session: briefSession,
    recent_agent_messages: recentAgentMessages
  };
  const history = summarizeTurnsPage(thread.turns, {
    threadId: id,
    limit,
    offset,
    cursor
  });
  return {
    ...common,
    goal: compactValue(thread.goal) ?? null,
    queued_messages: compactValue(queues?.data?.[id] || []),
    recent_turns: history.turns,
    artifacts,
    mutation_access: owned ? "allowed" : "view-only",
    pagination: history.pagination
  };
}

function waitSessionState(thread: JsonObject, activeIds: Set<string>): string {
  if (thread.archiveState === "archived") return "archived";
  if (asObject(thread.status).type === "systemError") return "failed";
  return String(summarizeBriefThread(thread, activeIds, false).state);
}

server.registerTool("forgedeck_list_artifacts", {
  title: "List session artifacts",
  description: "List session artifacts and unmet completion gates.",
  inputSchema: listArtifactsInputSchema,
  outputSchema: artifactListOutputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false }
}, ({ id }) => presentToolResult(async () => {
  const result = await api.get<{ data?: unknown[]; completion?: unknown }>(`/api/sessions/${encodeURIComponent(id)}/artifacts`);
  return { artifacts: result.data || [], completion: result.completion };
}));

server.registerTool("forgedeck_get_artifact", {
  title: "Get a session artifact",
  description: "Get an artifact by ID.",
  inputSchema: getArtifactInputSchema,
  outputSchema: artifactOutputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false }
}, ({ id }) => presentToolResult(async () => api.get(`/api/artifacts/${encodeURIComponent(id)}`)));

server.registerTool("forgedeck_publish_artifact", {
  title: "Publish a session artifact",
  description: "Publish and validate an artifact for an owned session.",
  inputSchema: publishArtifactInputSchema,
  outputSchema: artifactOutputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
}, ({ id, artifact }) => presentToolResult(async () => api.request(`/api/sessions/${encodeURIComponent(id)}/artifacts`, {
  method: "POST",
  body: artifact
})));

server.registerTool("forgedeck_send_message", {
  title: "Send or queue a message",
  description: "Send or queue a task for an owned session.",
  inputSchema: sendMessageInputSchema,
  outputSchema: sendMessageOutputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
}, ({ id, text: message, model, effort, queue }) => presentToolResult(async () => {
  const body = { text: message, model, reasoningEffort: effort };
  try {
    const result = await api.request(`/api/threads/${encodeURIComponent(id)}/messages`, { method: "POST", body });
    listSessionsCache.clear();
    return { delivery: "started", result };
  } catch (error) {
    if (queue && isSessionActiveError(error)) {
      const result = await api.request(`/api/threads/${encodeURIComponent(id)}/queue`, { method: "POST", body });
      listSessionsCache.clear();
      return { delivery: "queued", result };
    }
    throw error;
  }
}));

server.registerTool("forgedeck_set_yolo", {
  title: "Set an agent-owned session's YOLO mode",
  description: "Set YOLO mode on an idle owned session.",
  inputSchema: setYoloInputSchema,
  outputSchema: setYoloOutputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
}, ({ id, yolo }) => presentToolResult(async () => {
  const result = await api.request(`/api/threads/${encodeURIComponent(id)}/policy`, { method: "PATCH", body: { yolo } });
  listSessionsCache.clear();
  return { yolo, result };
}));

server.registerTool("forgedeck_spawn", {
  title: "Spawn sessions",
  description: "Spawn persistent owned sessions.",
  inputSchema: batchSpawnInputSchema,
  outputSchema: batchSpawnOutputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
}, ({ items }) => presentToolResult(async () => {
  const results = await Promise.allSettled(
    items.map((params) => mutationOperations.run(
      (context) => spawnOne(api, listSessionsCache, params, context.signal),
      { fairnessKey: "mcp-batch-spawn", deadline: Date.now() + MCP_API_TIMEOUT_MS }
    ))
  );
  return {
    results: results.map((r) =>
      r.status === "fulfilled" ? r.value : { error: r.reason instanceof Error ? r.reason.message : String(r.reason) }
    ),
    ok: results.filter((r) => r.status === "fulfilled").length,
    failed: results.filter((r) => r.status === "rejected").length
  };
}));

server.registerTool("forgedeck_stop", {
  title: "Stop sessions",
  description: "Interrupt active turns in owned sessions.",
  inputSchema: batchThreadsInputSchema,
  outputSchema: batchMutationOutputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
}, ({ ids }) => presentToolResult(async () => {
  const results = await Promise.allSettled(
    ids.map((id) => mutationOperations.run(
      (context) => api.request(`/api/threads/${encodeURIComponent(id)}/interrupt`, {
        method: "POST",
        body: {},
        timeoutMs: context.remainingMs(),
        signal: context.signal
      }),
      { fairnessKey: "mcp-batch-stop", deadline: Date.now() + MCP_API_TIMEOUT_MS }
    ))
  );
  listSessionsCache.clear();
  return {
    results: results.map((r, i) => ({
      id: ids[i],
      ok: r.status === "fulfilled",
      error: r.status === "rejected" ? (r.reason instanceof Error ? r.reason.message : String(r.reason)) : null
    })),
    ok: results.filter((r) => r.status === "fulfilled").length,
    failed: results.filter((r) => r.status === "rejected").length
  };
}));

server.registerTool("forgedeck_remove", {
  title: "Remove sessions",
  description: "Archive and remove idle owned sessions.",
  inputSchema: batchThreadsInputSchema,
  outputSchema: batchMutationOutputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
}, ({ ids }) => presentToolResult(async () => {
  const results = await Promise.allSettled(
    ids.map((id) => mutationOperations.run(async (context) => {
      const accepted = await api.request<JsonObject>(`/api/threads/${encodeURIComponent(id)}`, {
        method: "DELETE",
        timeoutMs: context.remainingMs(),
        signal: context.signal,
        idempotencyKey: crypto.randomUUID()
      });
      await waitForSessionOperation(api, accepted, context.signal, context.remainingMs());
      return id;
    }, { fairnessKey: "mcp-batch-remove", deadline: Date.now() + MCP_API_TIMEOUT_MS }))
  );
  listSessionsCache.clear();
  return {
    results: results.map((r, i) => ({
      id: ids[i],
      ok: r.status === "fulfilled",
      error: r.status === "rejected" ? (r.reason instanceof Error ? r.reason.message : String(r.reason)) : null
    })),
    ok: results.filter((r) => r.status === "fulfilled").length,
    failed: results.filter((r) => r.status === "rejected").length
  };
}));

server.registerTool("forgedeck_create_handoff", {
  title: "Create an MCP ownership handoff",
  description: "Create a one-time MCP ownership handoff token.",
  inputSchema: emptyInputSchema,
  outputSchema: handoffOfferOutputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
}, () => presentToolResult(async () => {
  const result = await api.request<{ handoffToken: string; expiresAt: number }>("/api/mcp/handoffs", {
    method: "POST",
    body: {}
  });
  return {
    token: result.handoffToken,
    expires: new Date(result.expiresAt).toISOString()
  };
}));

server.registerTool("forgedeck_handoff_sessions", {
  title: "Hand off owned sessions",
  description: "Transfer owned sessions to a handoff-token identity.",
  inputSchema: handoffSessionsInputSchema,
  outputSchema: handoffSessionsOutputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
}, ({ token, ids }) => presentToolResult(async () => {
  const result = await api.request<{ targetActorId: string; threadIds: string[] }>("/api/mcp/owned-threads/handoff", {
    method: "POST",
    body: { handoffToken: token, threadIds: ids }
  });
  listSessionsCache.clear();
  return { ids: result.threadIds, target: result.targetActorId };
}));

server.registerTool("forgedeck_revoke_identity", {
  title: "Revoke this MCP identity",
  description: "Revoke this MCP identity and release or archive its sessions.",
  inputSchema: revokeIdentityInputSchema,
  outputSchema: revokeIdentityOutputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
}, ({ mode }) => presentToolResult(async () => {
  const ownership = await api.get<{ data?: string[] }>("/api/mcp/owned-threads");
  const owned = ownership.data || [];
  let archived: string[] = [];
  if (mode === "archive") {
    const results = await Promise.allSettled(owned.map((threadId) => mutationOperations.run(
      async (context) => {
        const accepted = await api.request<JsonObject>(`/api/threads/${encodeURIComponent(threadId)}`, {
          method: "DELETE",
          timeoutMs: context.remainingMs(),
          signal: context.signal,
          idempotencyKey: crypto.randomUUID()
        });
        return waitForSessionOperation(api, accepted, context.signal, context.remainingMs());
      },
      { fairnessKey: "mcp-identity-archive", deadline: Date.now() + MCP_API_TIMEOUT_MS }
    )));
    const failures = results.flatMap((result, index) => result.status === "rejected"
      ? [`${owned[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
      : []);
    if (failures.length) {
      throw new Error(`MCP identity was not revoked because owned-session archival failed: ${failures.join("; ")}`);
    }
    archived = owned.filter((_, index) => results[index].status === "fulfilled");
  }
  const result = await api.request<{ releasedThreadIds?: string[] }>("/api/mcp/actors/current", {
    method: "DELETE",
    body: { releaseOwnership: true }
  });
  listSessionsCache.clear();
  return { revoked: true, archived, released: result.releasedThreadIds || [] };
}));

return server;
}


async function validateWorkspacePath(api: ForgeDeckApiClient, candidate: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await fs.promises.realpath(candidate);
  } catch {
    throw new Error("Workspace path does not exist");
  }
  const bootstrap = await api.get<Bootstrap>("/api/bootstrap");
  const roots = bootstrap.roots || [];
  if (!roots.some((root) => isWithinWorkspaceRoot(path.resolve(root), resolved))) {
    throw new Error("Workspace path is outside the configured ForgeDeck roots");
  }
  return resolved;
}

async function spawnOne(
  api: ForgeDeckApiClient,
  cache: KeyedAsyncTtlCache<SessionList>,
  params: McpSpawnSessionInput,
  signal?: AbortSignal
): Promise<JsonObject> {
  const validatedCwd = await validateWorkspacePath(api, params.cwd);
  const sessionClass = params.class;
  const presetTarget = params.preset ? MODEL_PRESETS[params.preset] : null;
  const model = presetTarget?.model || params.model;
  const effort = presetTarget?.effort || params.effort;
  if (!model || !effort) throw new Error("Choose a preset or provide both model and effort");
  const result = await api.request<JsonObject>("/api/threads", {
    method: "POST",
    body: {
      cwd: validatedCwd,
      provider: params.provider,
      preset: params.preset,
      model,
      reasoningEffort: effort,
      sessionClass,
      yolo: params.yolo || false,
      ...(params.fileScope ? { fileScope: params.fileScope } : {}),
      permissionMode: params.permissionMode,
      maxTurns: params.maxTurns,
      name: params.name,
      category: params.category,
      tags: params.tags || [],
      prompt: params.prompt
    },
    signal,
    idempotencyKey: crypto.randomUUID()
  });
  const completedResult = await waitForSessionOperation(api, result, signal);
  cache.clear();
  const createdThread = asObject(completedResult.thread);
  const threadIdResult = threadIdSchema.safeParse(createdThread.id);
  if (!threadIdResult.success) throw new Error("ForgeDeck returned an invalid created session");
  const threadId = threadIdResult.data;
  const initialTurnStarted = completedResult.initialTurnStarted === true;
  const warnings = Array.isArray(completedResult.warnings)
    ? completedResult.warnings.filter((warning): warning is string => typeof warning === "string")
    : [];
  const thread = {
    ...createdThread,
    preset: typeof createdThread.preset === "string" ? createdThread.preset : params.preset,
    model: typeof createdThread.model === "string" ? createdThread.model : model,
    reasoningEffort: typeof createdThread.reasoningEffort === "string"
      ? createdThread.reasoningEffort
      : typeof createdThread.effort === "string" ? createdThread.effort : effort,
    effort: typeof createdThread.effort === "string" ? createdThread.effort : effort,
    provider: typeof createdThread.provider === "string" ? createdThread.provider : params.provider,
    backend: typeof createdThread.backend === "string" ? createdThread.backend : params.provider
  };
  return {
    session: summarizeThread(thread, initialTurnStarted ? new Set([threadId]) : new Set(), true),
    agent_owned: true,
    visible_in_control_center: sessionClass === "standard",
    visible_in_sparkboard: sessionClass === "spark",
    first_turn_started: initialTurnStarted,
    warnings
  };
}

async function waitForSessionOperation(
  api: ForgeDeckApiClient,
  accepted: JsonObject,
  signal?: AbortSignal,
  maximumWaitMs = 90_000
): Promise<JsonObject> {
  let operation = asObject(accepted.operation);
  if (!Object.keys(operation).length) return accepted;
  const operationId = typeof operation.id === "string" ? operation.id : "unknown";
  const link = asObject(operation.links).self;
  if (typeof link !== "string" || !link.startsWith("/api/operations/")) {
    throw new Error("ForgeDeck returned an invalid session operation resource");
  }
  const deadline = Date.now() + Math.max(1, maximumWaitMs);
  while (operation.status !== "succeeded" && operation.status !== "failed") {
    if (signal?.aborted) throw new Error(`ForgeDeck session operation ${operationId} was cancelled while still running`);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`ForgeDeck session operation ${operationId} is still running; inspect ${link}`);
    await operationPollDelay(Math.min(500, remaining), signal);
    const response = await api.request<JsonObject>(link, { timeoutMs: Math.max(1, remaining), signal });
    operation = asObject(response.operation);
  }
  if (operation.status === "failed") {
    const failure = asObject(operation.error);
    const message = typeof failure.message === "string" ? failure.message : "ForgeDeck session operation failed";
    throw new Error(`${message} (operation ${operationId})`);
  }
  return asObject(operation.result);
}

function operationPollDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("ForgeDeck session operation polling was cancelled"));
      return;
    }
    const timer = setTimeout(done, milliseconds);
    timer.unref();
    signal?.addEventListener("abort", cancelled, { once: true });
    function done(): void {
      signal?.removeEventListener("abort", cancelled);
      resolve();
    }
    function cancelled(): void {
      clearTimeout(timer);
      reject(new Error("ForgeDeck session operation polling was cancelled"));
    }
  });
}

function isWithinWorkspaceRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
