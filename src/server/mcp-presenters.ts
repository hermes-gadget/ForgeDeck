import crypto from "node:crypto";
import path from "node:path";
import { timestampSchema } from "../shared/contracts.js";
import { ForgeDeckApiError, endpointMayUseAdapter } from "./mcp-client.js";
import type { AccountStatus, Bootstrap } from "../shared/contracts.js";

export type JsonObject = Record<string, unknown>;

const DIFF_KEYS = new Set(["diff", "patch", "unified_diff"]);
const MAX_COMPACT_STRING_CHARS = 8_000;
export const MAX_MCP_RESPONSE_DIFF_CHARS = 24_000;
const MAX_MCP_DIFF_CHARS = 8_000;
const MAX_SESSION_FILES = 1_000;
const SESSION_STALL_MS = 2 * 60 * 1_000;

type FlatTurnItem = {
  turn: JsonObject;
  item: JsonObject;
  turnIndex: number;
  itemIndex: number;
};

type HistoryCursor = {
  v: 1;
  threadId: string;
  before: string;
};

export type TurnPage = {
  turns: unknown[];
  pagination: {
    limit: number;
    offset: number;
    returned_items: number;
    total_items: number;
    has_more: boolean;
    next_offset: number | null;
    next_cursor: string | null;
  };
};

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: JsonObject;
  isError?: boolean;
};

/** Produces a stable, low-volume session record suitable for an MCP tool response. */
export function summarizeThread(thread: JsonObject, activeIds: Set<string>, owned: boolean): JsonObject {
  const id = typeof thread.id === "string" ? thread.id : "";
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const lastTurn = turns.length ? asObject(turns[turns.length - 1]) : undefined;
  const status = asObject(thread.status).type;
  const running = activeIds.has(id) || status === "active" || lastTurn?.status === "inProgress";
  const completion = asObject(thread.artifactStatus);
  const gated = completion.status === "pending";
  return {
    id,
    name: stringOrNull(thread.name),
    preview: stringOrNull(thread.preview) || "",
    cwd: stringOrNull(thread.cwd) || "",
    created_at: timestampOrNull(thread.createdAt),
    updated_at: timestampOrNull(thread.updatedAt),
    category: stringOrNull(thread.category),
    tags: Array.isArray(thread.tags) ? thread.tags.filter((tag): tag is string => typeof tag === "string") : [],
    provider: stringOrNull(thread.provider) || stringOrNull(thread.backend) || "codex",
    backend: stringOrNull(thread.backend) || stringOrNull(thread.provider) || "codex",
    session_class: stringOrNull(thread.sessionClass) || "standard",
    preset: stringOrNull(thread.preset),
    model: firstString(thread.claudeModel, thread.model, lastTurn?.model),
    reasoning_effort: firstString(thread.claudeEffort, thread.reasoningEffort, thread.reasoning_effort, thread.effort, lastTurn?.reasoningEffort, lastTurn?.effort),
    effort: firstString(thread.claudeEffort, thread.reasoningEffort, thread.reasoning_effort, thread.effort, lastTurn?.reasoningEffort, lastTurn?.effort),
    state: running ? "running" : gated ? "gated" : stringOrNull(lastTurn?.status) || "idle",
    completion: compactValue(completion),
    agent_owned: owned,
    mutation_access: owned ? "allowed" : "view-only"
  };
}

/** Selects only the stable metadata needed by lightweight session inspection. */
export function summarizeBriefThread(thread: JsonObject, activeIds: Set<string>, owned: boolean): JsonObject {
  const summary = summarizeThread(thread, activeIds, owned);
  return Object.fromEntries([
    "id", "name", "state", "cwd", "provider", "model", "effort"
  ].map((key) => [key, summary[key]]));
}

/** Returns the newest agent message texts while preserving chronological order. */
export function summarizeAgentMessages(value: unknown, limit = 2): string[] {
  if (!Number.isInteger(limit) || limit < 1) return [];
  const messages: string[] = [];
  const turns = Array.isArray(value) ? value : [];
  for (let turnIndex = turns.length - 1; turnIndex >= 0 && messages.length < limit; turnIndex -= 1) {
    const items = asObject(turns[turnIndex]).items;
    if (!Array.isArray(items)) continue;
    for (let itemIndex = items.length - 1; itemIndex >= 0 && messages.length < limit; itemIndex -= 1) {
      const item = asObject(items[itemIndex]);
      if (item.type === "agentMessage" && typeof item.text === "string") messages.push(item.text);
    }
  }
  return messages.reverse();
}

/** Returns the newest activity timestamp recorded by the most recent turn. */
export function summarizeLastActivity(thread: JsonObject): string | null {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const lastTurn = turns.length ? asObject(turns[turns.length - 1]) : undefined;
  if (!lastTurn) return null;
  const turnTimestamp = latestTurnActivityTimestamp(lastTurn);
  const timestamp = turnTimestamp > 0 ? turnTimestamp : timestampMs(thread.updatedAt);
  return timestamp > 0 ? new Date(timestamp).toISOString() : null;
}

/** Derives session health from the current thread snapshot without persisted health state. */
export function summarizeSessionHealth(thread: JsonObject, activeIds: Set<string>, now = Date.now()): "ok" | "stalled" | "error" | "idle" {
  const id = typeof thread.id === "string" ? thread.id : "";
  const turns = Array.isArray(thread.turns) ? thread.turns.map(asObject) : [];
  const lastTurn = turns.at(-1);
  const threadStatus = asObject(thread.status).type;
  if (threadStatus === "systemError") return "error";
  if (!turns.length) return "idle";
  if (lastTurn?.status === "failed" || lastTurn?.status === "interrupted" || hasError(lastTurn?.error)) return "error";

  const running = activeIds.has(id) || threadStatus === "active" || lastTurn?.status === "inProgress";
  if (!running) return "ok";
  const lastActivityAt = latestActivityTimestamp(thread, lastTurn);
  return lastActivityAt > 0 && now - lastActivityAt > SESSION_STALL_MS ? "stalled" : "ok";
}

/** Lists workspace-relative files attributed to turn changes or file/patch artifacts. */
export function summarizeSessionFiles(thread: JsonObject, artifacts: unknown, limit = MAX_SESSION_FILES): string[] {
  const cwd = typeof thread.cwd === "string" ? thread.cwd : "";
  const files = new Set<string>();
  const add = (value: unknown) => {
    if (files.size >= limit || typeof value !== "string") return;
    const relative = workspaceRelativeFile(cwd, value);
    if (relative) files.add(relative);
  };
  const artifactList = Array.isArray(artifacts) ? artifacts : [];
  for (let index = artifactList.length - 1; index >= 0 && files.size < limit; index -= 1) {
    const artifact = asObject(artifactList[index]);
    const content = asObject(artifact.content);
    if (artifact.type === "FileArtifact") add(content.path);
    if (artifact.type === "PatchArtifact" && Array.isArray(content.files)) {
      for (let fileIndex = content.files.length - 1; fileIndex >= 0; fileIndex -= 1) add(content.files[fileIndex]);
    }
  }
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (let turnIndex = turns.length - 1; turnIndex >= 0 && files.size < limit; turnIndex -= 1) {
    const items = asObject(turns[turnIndex]).items;
    if (!Array.isArray(items)) continue;
    for (let itemIndex = items.length - 1; itemIndex >= 0 && files.size < limit; itemIndex -= 1) {
      const changes = asObject(items[itemIndex]).changes;
      if (!Array.isArray(changes)) continue;
      for (let changeIndex = changes.length - 1; changeIndex >= 0; changeIndex -= 1) add(asObject(changes[changeIndex]).path);
    }
  }
  return [...files];
}

/** Returns the newest items across turns while preserving chronological order. */
export function summarizeTurns(value: unknown, itemLimit: number): unknown[] {
  return summarizeTurnsPage(value, { threadId: "legacy", limit: itemLimit }).turns;
}

/** Pages backward through session items, using a stable item boundary when a cursor is supplied. */
export function summarizeTurnsPage(
  value: unknown,
  options: { threadId: string; limit: number; offset?: number; cursor?: string }
): TurnPage {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new RangeError("MCP history limit must be between 1 and 100");
  }
  if (options.offset !== undefined && (!Number.isInteger(options.offset) || options.offset < 0)) {
    throw new RangeError("MCP history offset must be a non-negative integer");
  }
  const flattened = flattenTurnItems(value);
  const totalItems = flattened.length;
  const requestedOffset = options.offset || 0;
  let end = Math.max(0, totalItems - requestedOffset);
  if (options.cursor) {
    if (requestedOffset > 0) throw new Error("MCP history cursor cannot be combined with a non-zero offset");
    const cursor = decodeHistoryCursor(options.cursor);
    if (cursor.threadId !== options.threadId) throw new Error("MCP history cursor belongs to a different session");
    end = flattened.findIndex((entry) => historyItemBoundary(entry) === cursor.before);
    if (end < 0) throw new Error("MCP history cursor is no longer available; restart pagination without a cursor");
  }
  const start = Math.max(0, end - options.limit);
  const selected = flattened.slice(start, end);
  const turns = groupTurnItems(selected);
  const hasMore = start > 0;
  const offset = options.cursor ? totalItems - end : requestedOffset;
  return {
    turns,
    pagination: {
      limit: options.limit,
      offset,
      returned_items: selected.length,
      total_items: totalItems,
      has_more: hasMore,
      next_offset: hasMore ? totalItems - start : null,
      next_cursor: hasMore ? encodeHistoryCursor({
        v: 1,
        threadId: options.threadId,
        before: historyItemBoundary(selected[0])
      }) : null
    }
  };
}

/** Bounds arbitrary Codex values, including individual file diffs. */
export function compactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return truncateString(value, MAX_COMPACT_STRING_CHARS);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 5) return "[nested value omitted]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => compactValue(item, depth + 1));
  return Object.fromEntries(Object.entries(value as JsonObject).slice(0, 100).map(([key, item]) => [key, compactValue(item, depth + 1)]));
}

/** Applies one aggregate diff/patch budget to an entire MCP structured response. */
export function boundMcpDiffOutput(value: unknown): unknown {
  const budget = { remaining: MAX_MCP_RESPONSE_DIFF_CHARS, fields: countDiffStrings(value) };
  return boundDiffValue(value, "", budget);
}

export function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function summarizeItem(item: JsonObject): JsonObject {
  const keys = ["id", "type", "status", "text", "content", "summary", "command", "cwd", "aggregatedOutput", "exitCode", "changes", "diff", "patch", "unified_diff", "server", "tool", "arguments", "result", "error"];
  return Object.fromEntries(keys.filter((key) => item[key] !== undefined).map((key) => [key, compactValue(item[key])]));
}

function flattenTurnItems(value: unknown): FlatTurnItem[] {
  const flattened: FlatTurnItem[] = [];
  const turns = Array.isArray(value) ? value.map(asObject) : [];
  for (const [turnIndex, turn] of turns.entries()) {
    const items = Array.isArray(turn.items) ? turn.items.map(asObject) : [];
    for (const [itemIndex, item] of items.entries()) flattened.push({ turn, item, turnIndex, itemIndex });
  }
  return flattened;
}

function groupTurnItems(entries: FlatTurnItem[]): unknown[] {
  const result: Array<{ id: unknown; status: unknown; error: unknown; items: JsonObject[] }> = [];
  let previousTurn: JsonObject | null = null;
  for (const entry of entries) {
    if (entry.turn !== previousTurn) {
      result.push({
        id: entry.turn.id,
        status: entry.turn.status,
        error: compactValue(entry.turn.error),
        items: []
      });
      previousTurn = entry.turn;
    }
    result[result.length - 1].items.push(summarizeItem(entry.item));
  }
  return result;
}

function historyItemBoundary(entry: FlatTurnItem): string {
  const turnId = typeof entry.turn.id === "string" ? entry.turn.id : "";
  const itemId = typeof entry.item.id === "string" ? entry.item.id : "";
  if (itemId) return `id:${turnId}\0${itemId}`;
  const itemHash = crypto.createHash("sha256").update(JSON.stringify(entry.item)).digest("base64url");
  return `fallback:${turnId || entry.turnIndex}\0${entry.itemIndex}\0${itemHash}`;
}

function encodeHistoryCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeHistoryCursor(value: string): HistoryCursor {
  try {
    if (value.length > 2_048) throw new Error("oversized cursor");
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<HistoryCursor>;
    if (parsed.v !== 1 || typeof parsed.threadId !== "string" || typeof parsed.before !== "string" || !parsed.before) {
      throw new Error("invalid cursor payload");
    }
    return { v: 1, threadId: parsed.threadId, before: parsed.before };
  } catch {
    throw new Error("Invalid MCP history cursor");
  }
}

function countDiffStrings(value: unknown, key = ""): number {
  if (typeof value === "string") return DIFF_KEYS.has(key.toLowerCase()) ? 1 : 0;
  if (value === null || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce((total, item) => total + countDiffStrings(item, key), 0);
  return Object.entries(value as JsonObject)
    .reduce((total, [childKey, item]) => total + countDiffStrings(item, childKey), 0);
}

function boundDiffValue(value: unknown, key: string, budget: { remaining: number; fields: number }): unknown {
  if (typeof value === "string") {
    if (!DIFF_KEYS.has(key.toLowerCase())) return value;
    const reservePerLaterField = budget.fields > 0 ? Math.min(64, Math.floor(budget.remaining / budget.fields)) : 0;
    const reservedForLaterFields = Math.max(0, budget.fields - 1) * reservePerLaterField;
    const allowance = Math.min(MAX_MCP_DIFF_CHARS, Math.max(0, budget.remaining - reservedForLaterFields));
    budget.fields -= 1;
    budget.remaining -= Math.min(value.length, allowance);
    return truncateString(value, allowance);
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => boundDiffValue(item, key, budget));
  return Object.fromEntries(Object.entries(value as JsonObject).map(([childKey, item]) => [childKey, boundDiffValue(item, childKey, budget)]));
}

function truncateString(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit <= 0) return "";
  const marker = `\n…[truncated for MCP response; original ${value.length} chars]`;
  if (marker.length >= limit) return marker.slice(0, limit);
  return `${value.slice(0, limit - marker.length)}${marker}`;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const text = stringOrNull(value);
    if (text) return text;
  }
  return null;
}

function hasError(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return value !== null && typeof value === "object" && Object.keys(value as JsonObject).length > 0;
}

function latestActivityTimestamp(thread: JsonObject, lastTurn: JsonObject | undefined): number {
  const values: unknown[] = [
    asObject(thread.guardian).lastActivityAt,
    thread.updatedAt,
    lastTurn?.startedAt,
    lastTurn?.completedAt
  ];
  return Math.max(0, ...values.map(timestampMs), lastTurn ? latestTurnActivityTimestamp(lastTurn) : 0);
}

function latestTurnActivityTimestamp(turn: JsonObject): number {
  const values: unknown[] = [turn.startedAt, turn.completedAt, turn.createdAt, turn.updatedAt];
  const items = Array.isArray(turn.items) ? turn.items : [];
  for (const item of items) {
    const record = asObject(item);
    values.push(record.createdAt, record.updatedAt, record.startedAt, record.completedAt);
  }
  return Math.max(0, ...values.map(timestampMs));
}

function timestampMs(value: unknown): number {
  const parsed = timestampSchema.safeParse(value);
  return parsed.success ? Date.parse(parsed.data) : 0;
}

function workspaceRelativeFile(cwd: string, value: string): string | null {
  const file = value.trim();
  if (!file || file.includes("\0")) return null;
  const windows = /^[a-zA-Z]:[\\/]/.test(cwd);
  const paths = windows ? path.win32 : path.posix;
  const absolute = paths.isAbsolute(file) || /^[a-zA-Z]:[\\/]/.test(file);
  if (absolute && !cwd) return null;
  const relative = absolute ? paths.relative(paths.resolve(cwd), paths.resolve(file)) : paths.normalize(file);
  if (!relative || relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) return null;
  return relative.replaceAll("\\", "/").replace(/^\.\//, "");
}

function timestampOrNull(value: unknown): string | null {
  const result = timestampSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** Converts a tool action into the bounded MCP content/structuredContent envelope. */
export async function presentToolResult(action: () => Promise<JsonObject>): Promise<ToolResult> {
  try {
    const result = boundMcpDiffOutput(await action()) as JsonObject;
    return {
      content: [{ type: "text", text: compactTextFallback(result) }],
      structuredContent: result
    };
  } catch (error) {
    const message = toolErrorMessage(error);
    return {
      content: [{ type: "text", text: message.slice(0, 2_000) }],
      structuredContent: structuredToolError(error, message),
      isError: true
    };
  }
}

/** Shapes backend availability and quota data for MCP tools. */
export function presentUsage(status: AccountStatus, bootstrap?: Bootstrap): JsonObject {
  const usage = asObject(status.usage);
  const byLimitId = asObject(usage.rateLimitsByLimitId);
  const defaultLimits = asObject(usage.rateLimits);
  const codexLimits = Object.keys(asObject(byLimitId.codex)).length ? asObject(byLimitId.codex) : defaultLimits;
  const sparkEntry = Object.values(byLimitId).find((entry) => {
    const limitName = asObject(entry).limitName;
    return typeof limitName === "string" && /spark|gpt-5[.-]3/i.test(limitName);
  });
  const sparkLimits = asObject(sparkEntry);
  const backendStatus = asObject(status.backendStatus);
  const codexStatus = asObject(backendStatus.codex);
  const sparkStatus = asObject(backendStatus.spark);
  const claudeStatus = asObject(backendStatus.claude);
  const claudeActiveCount = Number(claudeStatus.activeCount);
  const claudeMaxConcurrent = Number(claudeStatus.maxConcurrent);
  const account = asObject(asObject(status.account).account);
  const runtimeAvailable = asObject(status.runtime).available !== false;
  const codexAvailable = runtimeAvailable && codexStatus.available === true;
  const sparkAvailable = runtimeAvailable && sparkStatus.available === true;
  const claudeAvailable = status.claudeAvailable === true;
  return {
    codex: {
      available: codexAvailable,
      rateLimit: publicRateLimit(codexLimits),
      planType: stringValue(codexLimits.planType) || stringValue(account.planType)
    },
    spark: {
      available: sparkAvailable,
      rateLimit: publicRateLimit(sparkLimits)
    },
    claude: {
      available: claudeAvailable,
      subscriptionActive: claudeAvailable,
      rateLimit: publicRateLimit(asObject(claudeStatus.rateLimit)),
      activeCount: Number.isFinite(claudeActiveCount) ? claudeActiveCount : 0,
      maxConcurrent: Number.isFinite(claudeMaxConcurrent) ? claudeMaxConcurrent : null,
      modelOptions: (bootstrap?.claudeModelOptions || (Array.isArray(claudeStatus.modelOptions) ? claudeStatus.modelOptions.map(asObject) : []))
        .map((model) => model.model)
        .filter((model): model is string => typeof model === "string")
    }
  };
}

export function isAdapterBusyError(error: unknown): boolean {
  if (error instanceof ForgeDeckApiError && endpointMayUseAdapter(error.endpoint) && [429, 502, 503, 504].includes(error.status)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /codex.*(?:busy|capacity|overload|timed out|not available|connection closed|offline|reconnect)/i.test(message);
}

export function toolErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (isAdapterBusyError(error)) {
    return `ForgeDeck's Codex adapter is busy or reconnecting. ${message} Retry in a few seconds or use forgedeck_health_check to check readiness.`;
  }
  if (error instanceof ForgeDeckApiError) return `ForgeDeck API request to ${error.endpoint} failed (HTTP ${error.status}): ${message}`;
  return message;
}

function publicRateLimit(snapshot: JsonObject): JsonObject | null {
  const primary = asObject(snapshot.primary);
  const usedPercent = Number(primary.usedPercent);
  if (!Number.isFinite(usedPercent)) return null;
  const resetsAt = Number(primary.resetsAt);
  return {
    usedPercent,
    resetsAt: Number.isFinite(resetsAt) && resetsAt > 0
      ? new Date(resetsAt < 10_000_000_000 ? resetsAt * 1_000 : resetsAt).toISOString()
      : null
  };
}

function compactTextFallback(result: JsonObject): string {
  const serialized = JSON.stringify(result);
  if (serialized.length <= 2_000) return serialized;
  const summary: JsonObject = {
    note: "Full result is available in structuredContent.",
    byte_length: Buffer.byteLength(serialized),
    fields: Object.keys(result)
  };
  const session = asObject(result.session);
  if (Object.keys(session).length) summary.session = session;
  for (const [key, value] of Object.entries(result)) {
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) summary[key] = value;
    else if (Array.isArray(value)) summary[`${key}_count`] = value.length;
  }
  return JSON.stringify(summary);
}

function structuredToolError(error: unknown, message: string): JsonObject {
  if (error instanceof ForgeDeckApiError) {
    return {
      error: {
        message,
        code: error.code,
        status: error.status,
        endpoint: error.endpoint,
        retryable: error.status === 409 || error.status === 429 || error.status >= 500,
        request_id: error.requestId
      }
    };
  }
  return { error: { message, code: "MCP_TOOL_ERROR", retryable: isAdapterBusyError(error) } };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
