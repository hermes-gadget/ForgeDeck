export type JsonObject = Record<string, unknown>;

const FULL_DIFF_KEYS = new Set(["changes", "diff", "unified_diff"]);

/** Produces a stable, low-volume session record suitable for an MCP tool response. */
export function summarizeThread(thread: JsonObject, activeIds: Set<string>, owned: boolean): JsonObject {
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
    category: thread.category || null,
    tags: Array.isArray(thread.tags) ? thread.tags : [],
    backend: thread.backend || "codex",
    session_class: thread.sessionClass || "standard",
    state: running ? "running" : lastTurn?.status || "idle",
    agent_owned: owned,
    mutation_access: owned ? "allowed" : "view-only"
  };
}

/** Returns the newest items across turns while preserving chronological order. */
export function summarizeTurns(value: unknown, itemLimit: number): unknown[] {
  const turns = Array.isArray(value) ? value.map(asObject) : [];
  let remaining = itemLimit;
  const result: unknown[] = [];
  for (const turn of [...turns].reverse()) {
    if (remaining <= 0) break;
    const items = Array.isArray(turn.items) ? turn.items.map(asObject) : [];
    const selected = items.slice(-remaining).map(summarizeItem);
    remaining -= selected.length;
    result.unshift({ id: turn.id, status: turn.status, error: compactValue(turn.error), items: selected });
  }
  return result;
}

/** Bounds arbitrary Codex values without truncating file diffs needed for review. */
export function compactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > 8_000 ? `${value.slice(0, 8_000)}\n…[truncated]` : value;
  if (value === null || typeof value !== "object") return value;
  if (depth >= 5) return "[nested value omitted]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => compactValue(item, depth + 1));
  return Object.fromEntries(Object.entries(value as JsonObject).slice(0, 100).map(([key, item]) => [key, compactValue(item, depth + 1)]));
}

export function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function summarizeItem(item: JsonObject): JsonObject {
  const keys = ["id", "type", "status", "text", "content", "summary", "command", "cwd", "aggregatedOutput", "exitCode", "changes", "diff", "unified_diff", "server", "tool", "arguments", "result", "error"];
  return Object.fromEntries(keys.filter((key) => item[key] !== undefined).map((key) => [key, FULL_DIFF_KEYS.has(key) ? item[key] : compactValue(item[key])]));
}
