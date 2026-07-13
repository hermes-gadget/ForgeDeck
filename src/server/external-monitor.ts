import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { logger } from "./logger.js";

type Notification = { method: string; params: Record<string, unknown> };
type ThreadRow = { id: string; rollout_path: string; cwd: string; updated_at: number; updated_at_ms: number | null };
type ToolItem = Record<string, unknown> & { id: string; type: string };
type Tracker = {
  id: string;
  path: string;
  cwd: string;
  offset: number;
  partial: string;
  active: boolean;
  activeTurnId: string | null;
  missingWritablePolls: number;
  lastObservedAt: number;
  calls: Map<string, ToolItem>;
  recent: ToolItem[];
};

export type ExternalSessionInventory = {
  threadIds: Set<string>;
  unavailableThreadIds: Set<string>;
};

export type ExternalCodexMonitorOptions = {
  pollMs?: number;
  livenessMs?: number;
  threadLimit?: number;
  maxReadBytes?: number;
  maxOutputChars?: number;
};

const INVENTORY_REFRESH_MS = 3_000;
const UNAVAILABLE_GRACE_MS = 30_000;
const DEAD_PROCESS_CONFIRMATION_POLLS = 3;
const INACTIVE_TRACKER_TTL_MS = 5 * 60_000;
const DEFAULT_OPTIONS: Required<ExternalCodexMonitorOptions> = {
  pollMs: 1_000,
  livenessMs: 2_500,
  threadLimit: 64,
  maxReadBytes: 512 * 1024,
  maxOutputChars: 200_000
};

export class ExternalCodexMonitor {
  private db: DatabaseSync | null = null;
  private readonly databasePath: string;
  private readonly sessionsRoot: string;
  private readonly trackers = new Map<string, Tracker>();
  private rows = new Map<string, ThreadRow>();
  private lastInventoryAt = 0;
  private inventoryInitialized = false;
  private lastInventorySignature = "";
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private state: "stopped" | "starting" | "ready" | "degraded" = "stopped";
  private lastPollAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastError: string | null = null;
  private canonicalSessionsRoot: string | null = null;
  private writableRollouts: Set<string> | null = null;
  private lastLivenessAt = 0;
  private readonly options: Required<ExternalCodexMonitorOptions>;
  private lastErrorLoggedAt = 0;

  constructor(
    private readonly emit: (notification: Notification, historical?: boolean) => void,
    codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    private readonly reconcileInventory?: (inventory: ExternalSessionInventory) => void,
    options: ExternalCodexMonitorOptions = {}
  ) {
    this.databasePath = path.join(codexHome, "state_5.sqlite");
    this.sessionsRoot = path.join(codexHome, "sessions");
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  start(): void {
    if (this.timer) return;
    this.state = "starting";
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.options.pollMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.db?.close();
    this.db = null;
    this.state = "stopped";
  }

  getStatus(): {
    state: "stopped" | "starting" | "ready" | "degraded";
    available: boolean;
    lastPollAt: number | null;
    lastSuccessAt: number | null;
    lastError: string | null;
    trackedThreads: number;
  } {
    return {
      state: this.state,
      available: this.state === "ready",
      lastPollAt: this.lastPollAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      trackedThreads: this.trackers.size
    };
  }

  /** Re-emit authoritative external states after the app-server disconnects. */
  emitCurrentStatuses(): void {
    for (const tracker of this.trackers.values()) this.emitStatus(tracker);
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    this.lastPollAt = Date.now();
    try {
      const db = this.openDatabase();
      const now = Date.now();
      if (!this.lastLivenessAt || now - this.lastLivenessAt >= this.options.livenessMs) {
        this.writableRollouts = findWritableRolloutPaths("/proc", this.sessionsRoot);
        this.lastLivenessAt = now;
      }
      const writableRollouts = this.writableRollouts;
      if (!this.inventoryInitialized || now - this.lastInventoryAt >= INVENTORY_REFRESH_MS) this.refreshInventory(db, now);
      const writable = writableRollouts || new Set<string>();
      const candidates = [...this.rows.values()].filter((row, index) =>
        index < this.options.threadLimit || writable.has(path.resolve(row.rollout_path)) || this.trackers.get(row.id)?.active
      );
      const candidateIds = new Set(candidates.map((row) => row.id));
      for (const row of candidates) this.readThread(row, writableRollouts);
      for (const [threadId, tracker] of this.trackers) {
        if (!this.rows.has(threadId)) {
          this.removeTracker(threadId, tracker, this.inventoryInitialized, true);
          continue;
        }
        if (!candidateIds.has(threadId) && !tracker.active && now - tracker.lastObservedAt > INACTIVE_TRACKER_TTL_MS) this.trackers.delete(threadId);
      }
      this.state = "ready";
      this.lastSuccessAt = Date.now();
      this.lastError = null;
    } catch (error) {
      this.state = "degraded";
      const message = error instanceof Error ? error.message : String(error);
      const changed = message !== this.lastError;
      this.lastError = message;
      if (changed || Date.now() - this.lastErrorLoggedAt >= 30_000) {
        this.lastErrorLoggedAt = Date.now();
        logger.warn("External Codex monitor poll failed", { error });
      }
      try { this.db?.close(); } catch { /* reopen on the next poll */ }
      this.db = null;
    } finally {
      this.polling = false;
    }
  }

  private openDatabase(): DatabaseSync {
    if (!this.db) this.db = new DatabaseSync(this.databasePath, { readOnly: true });
    return this.db;
  }

  private refreshInventory(db: DatabaseSync, now: number): void {
    const rows = db.prepare(
      "SELECT id, rollout_path, cwd, updated_at, updated_at_ms FROM threads WHERE archived = 0 ORDER BY updated_at_ms DESC"
    ).all() as unknown as ThreadRow[];
    const nextRows = new Map(rows.map((row) => [row.id, row]));
    const wasInitialized = this.inventoryInitialized;

    for (const [threadId, tracker] of this.trackers) {
      const row = nextRows.get(threadId);
      if (!row || canonicalPath(row.rollout_path) !== tracker.path) this.removeTracker(threadId, tracker, wasInitialized, !row);
    }

    this.rows = nextRows;
    this.lastInventoryAt = now;
    this.inventoryInitialized = true;
    if (!this.reconcileInventory) return;

    const threadIds = new Set<string>();
    const unavailableThreadIds = new Set<string>();
    for (const row of rows) {
      const updatedAt = Math.max(normalizeDatabaseTimestamp(row.updated_at_ms), normalizeDatabaseTimestamp(row.updated_at));
      if (fs.existsSync(row.rollout_path) || !updatedAt || now - updatedAt <= UNAVAILABLE_GRACE_MS) threadIds.add(row.id);
      else unavailableThreadIds.add(row.id);
    }
    const signature = `${[...threadIds].sort().join(",")}|${[...unavailableThreadIds].sort().join(",")}`;
    if (signature !== this.lastInventorySignature) {
      this.lastInventorySignature = signature;
      this.reconcileInventory({ threadIds, unavailableThreadIds });
    }
  }

  private readThread(row: ThreadRow, writableRollouts: Set<string> | null): void {
    const rollout = this.resolveRolloutFile(row.rollout_path);
    if (!rollout) {
      const tracker = this.trackers.get(row.id);
      if (tracker) this.removeTracker(row.id, tracker, true, false);
      return;
    }
    const { canonicalPath, stat } = rollout;
    let tracker = this.trackers.get(row.id);
    const initial = !tracker;
    if (!tracker) {
      tracker = {
        id: row.id,
        path: canonicalPath,
        cwd: row.cwd,
        offset: Math.max(0, stat.size - 1024 * 1024),
        partial: "",
        active: false,
        activeTurnId: null,
        missingWritablePolls: 0,
        lastObservedAt: Date.now(),
        calls: new Map(),
        recent: []
      };
      const lifecycle = readLatestLifecycle(canonicalPath, stat.size);
      if (lifecycle) {
        tracker.active = lifecycle.active;
        tracker.activeTurnId = lifecycle.turnId;
      }
      this.trackers.set(row.id, tracker);
    }
    tracker.lastObservedAt = Date.now();
    if (stat.size < tracker.offset) {
      tracker.offset = 0;
      tracker.partial = "";
    }
    if (stat.size === tracker.offset) {
      this.reconcileProcessState(tracker, writableRollouts, initial);
      return;
    }

    const descriptor = fs.openSync(tracker.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let length = 0;
    let buffer: Buffer;
    try {
      const openedStat = fs.fstatSync(descriptor);
      if (!openedStat.isFile() || openedStat.dev !== stat.dev || openedStat.ino !== stat.ino) return;
      length = Math.min(Math.max(0, openedStat.size - tracker.offset), this.options.maxReadBytes);
      buffer = Buffer.alloc(length);
      fs.readSync(descriptor, buffer, 0, length, tracker.offset);
    } finally { fs.closeSync(descriptor); }
    if (!length) return;
    tracker.offset += length;
    const chunks = `${tracker.partial}${buffer!.toString("utf8")}`.split("\n");
    tracker.partial = truncateTail(chunks.pop() || "", this.options.maxOutputChars);
    for (const line of chunks) this.processLine(tracker, line, !initial);

    this.reconcileProcessState(tracker, writableRollouts, initial);

    if (initial) {
      this.emitStatus(tracker, true);
      for (const item of tracker.recent.slice(-192)) {
        this.emit({ method: item.status === "inProgress" ? "item/started" : "item/completed", params: { threadId: tracker.id, turnId: "external", item } }, true);
      }
    }
  }

  private resolveRolloutFile(candidate: string): { canonicalPath: string; stat: fs.Stats } | null {
    try {
      const pathStat = fs.lstatSync(candidate);
      if (pathStat.isSymbolicLink() || !pathStat.isFile()) return null;
      this.canonicalSessionsRoot ||= fs.realpathSync(this.sessionsRoot);
      const canonicalPath = fs.realpathSync(candidate);
      const relative = path.relative(this.canonicalSessionsRoot, canonicalPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
      return { canonicalPath, stat: pathStat };
    } catch {
      return null;
    }
  }

  private processLine(tracker: Tracker, line: string, emitNow: boolean): void {
    if (!line.trim()) return;
    let record: { type?: string; timestamp?: string; payload?: Record<string, unknown> };
    try { record = JSON.parse(line); } catch { return; }
    const payload = record.payload;
    if (!payload) return;
    const payloadType = String(payload.type || "");

    if (record.type === "event_msg" && payloadType === "task_started") {
      const changed = !tracker.active;
      tracker.active = true;
      tracker.activeTurnId = String(payload.turn_id || "external");
      tracker.missingWritablePolls = 0;
      if (emitNow) {
        if (changed) this.emitStatus(tracker);
        this.emit({ method: "turn/started", params: { threadId: tracker.id, turn: { id: tracker.activeTurnId, status: "inProgress", items: [] } } });
      }
      return;
    }
    if (record.type === "event_msg" && payloadType === "user_message") {
      const changed = !tracker.active;
      tracker.active = true;
      tracker.missingWritablePolls = 0;
      if (emitNow && changed) this.emitStatus(tracker);
      return;
    }
    if (record.type === "event_msg" && ["task_complete", "turn_complete", "turn_aborted", "task_cancelled"].includes(payloadType)) {
      const changed = tracker.active;
      const turnId = String(payload.turn_id || tracker.activeTurnId || "external");
      tracker.active = false;
      tracker.activeTurnId = null;
      tracker.missingWritablePolls = 0;
      if (emitNow && changed) {
        this.emitStatus(tracker);
        this.emit({ method: "turn/completed", params: { threadId: tracker.id, turn: { id: turnId, status: payloadType.includes("abort") || payloadType.includes("cancel") ? "interrupted" : "completed", items: [] } } });
      }
      return;
    }

    if (record.type === "event_msg" && payloadType === "patch_apply_end") {
      const rawChanges = payload.changes && typeof payload.changes === "object" ? payload.changes as Record<string, Record<string, unknown>> : {};
      const changes = Object.entries(rawChanges).map(([filePath, change]) => ({
        path: filePath,
        kind: { type: String(change.type || "update") },
        diff: truncateTail(String(change.unified_diff || ""), this.options.maxOutputChars),
        movePath: change.move_path == null ? null : String(change.move_path)
      }));
      const item: ToolItem = {
        type: "fileChange", id: String(payload.call_id || `patch-${record.timestamp || Date.now()}`),
        changes, status: payload.success === false ? "failed" : "completed"
      };
      pushRecent(tracker, item);
      if (emitNow) this.emit({ method: "item/completed", params: { threadId: tracker.id, turnId: String(payload.turn_id || "external"), item } });
      return;
    }

    if (record.type !== "response_item") return;
    if (payloadType === "message") {
      const role = String(payload.role || "");
      const text = extractMessageText(payload.content);
      if (!text || !["assistant", "user"].includes(role)) return;
      if (role === "user" && isInjectedUserContext(text)) return;
      const id = String(payload.id || `${role}-${record.timestamp || tracker.recent.length}`);
      const item: ToolItem = role === "assistant"
        ? { type: "agentMessage", id, text: truncateTail(text, this.options.maxOutputChars), phase: payload.phase == null ? null : String(payload.phase), memoryCitation: null }
        : { type: "userMessage", id, clientId: null, content: [{ type: "text", text, text_elements: [] }] };
      pushRecent(tracker, item);
      if (emitNow) this.emit({ method: "item/completed", params: { threadId: tracker.id, turnId: "external", item } });
      return;
    }
    if (payloadType === "custom_tool_call" || payloadType === "function_call") {
      const callId = String(payload.call_id || payload.id || `external-${Date.now()}`);
      const name = String(payload.name || "tool");
      const rawInput = String(payload.input || payload.arguments || "");
      // Patch calls get a richer patch_apply_end record immediately afterward.
      // Do not mislabel the wrapper invocation as a shell command in the meantime.
      if (name === "exec" && isApplyPatchCall(rawInput)) return;
      const command = name === "exec" ? extractCommand(rawInput) : null;
      const item: ToolItem = command ? {
        type: "commandExecution", id: String(payload.id || callId), command, cwd: tracker.cwd, processId: null,
        source: "externalCodex", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null
      } : {
        type: "dynamicToolCall", id: String(payload.id || callId), namespace: "externalCodex", tool: name,
        arguments: parseArguments(payload.arguments ?? payload.input), status: "inProgress", contentItems: null, success: null, durationMs: null
      };
      tracker.calls.set(callId, item);
      pushRecent(tracker, item);
      if (emitNow) this.emit({ method: "item/started", params: { threadId: tracker.id, turnId: "external", item } });
      return;
    }

    if (payloadType === "custom_tool_call_output" || payloadType === "function_call_output") {
      const callId = String(payload.call_id || "");
      const existing = tracker.calls.get(callId);
      if (!existing) return;
      const output = truncateTail(flattenOutput(payload.output), this.options.maxOutputChars);
      const completed: ToolItem = existing.type === "commandExecution"
        ? { ...existing, status: "completed", aggregatedOutput: output, exitCode: inferExitCode(output) }
        : { ...existing, status: "completed", contentItems: output ? [{ type: "inputText", text: output }] : [], success: true };
      tracker.calls.delete(callId);
      pushRecent(tracker, completed);
      if (emitNow) this.emit({ method: "item/completed", params: { threadId: tracker.id, turnId: "external", item: completed } });
    }
  }

  private emitStatus(tracker: Tracker, historical = false): void {
    this.emit({ method: "thread/status/changed", params: { threadId: tracker.id, status: tracker.active ? { type: "active", activeFlags: [] } : { type: "idle" } } }, historical);
  }

  private reconcileProcessState(tracker: Tracker, writableRollouts: Set<string> | null, initial: boolean): void {
    if (!tracker.active || writableRollouts === null) return;
    if (writableRollouts.has(path.resolve(tracker.path))) {
      tracker.missingWritablePolls = 0;
      return;
    }
    tracker.missingWritablePolls += 1;
    if (tracker.missingWritablePolls < DEAD_PROCESS_CONFIRMATION_POLLS) return;
    const turnId = tracker.activeTurnId || "external";
    tracker.active = false;
    tracker.activeTurnId = null;
    tracker.missingWritablePolls = 0;
    if (initial) return;
    this.emitStatus(tracker);
    this.emit({ method: "turn/completed", params: { threadId: tracker.id, turn: { id: turnId, status: "interrupted", items: [] } } });
  }

  private removeTracker(threadId: string, tracker: Tracker, emitRemoval: boolean, archived: boolean): void {
    this.trackers.delete(threadId);
    if (!emitRemoval) return;
    if (tracker.active) {
      const turnId = tracker.activeTurnId || "external";
      tracker.active = false;
      tracker.activeTurnId = null;
      this.emit({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "interrupted", items: [] } } });
    }
    if (archived) this.emit({ method: "thread/archived", params: { threadId } });
  }
}

// A standalone Codex process can be killed before it appends task_complete or
// turn_aborted. In that case the rollout looks active forever. Linux exposes
// writable file descriptors through /proc, which gives us a definitive liveness
// check without guessing based on how long a model or tool has been quiet.
export function findWritableRolloutPaths(
  procRoot = "/proc",
  sessionsRoot = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions")
): Set<string> | null {
  let processEntries: fs.Dirent[];
  try {
    processEntries = fs.readdirSync(procRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  const rollouts = new Set<string>();
  const sessionsPrefix = `${path.resolve(sessionsRoot)}${path.sep}`;
  for (const processEntry of processEntries) {
    if (!processEntry.isDirectory() || !/^\d+$/.test(processEntry.name)) continue;
    const fdDirectory = path.join(procRoot, processEntry.name, "fd");
    let descriptors: string[];
    try { descriptors = fs.readdirSync(fdDirectory); } catch { continue; }
    for (const descriptor of descriptors) {
      const fdPath = path.join(fdDirectory, descriptor);
      let target: string;
      let flags: number;
      try {
        target = fs.readlinkSync(fdPath).replace(/ \(deleted\)$/, "");
        target = path.resolve(target);
        if (!target.startsWith(sessionsPrefix) || !target.endsWith(".jsonl")) continue;
        const match = /^flags:\s*([0-7]+)/m.exec(fs.readFileSync(path.join(procRoot, processEntry.name, "fdinfo", descriptor), "utf8"));
        if (!match) continue;
        flags = Number.parseInt(match[1], 8);
      } catch {
        continue;
      }
      const accessMode = flags & 0b11;
      if (accessMode === 1 || accessMode === 2) rollouts.add(target);
    }
  }
  return rollouts;
}

export function readLatestLifecycle(rolloutPath: string, size = fs.statSync(rolloutPath).size): { active: boolean; turnId: string | null } | null {
  const descriptor = fs.openSync(rolloutPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const chunkSize = 64 * 1024;
  const openedStat = fs.fstatSync(descriptor);
  if (!openedStat.isFile()) {
    fs.closeSync(descriptor);
    return null;
  }
  let position = Math.min(size, openedStat.size);
  let trailingPartial = "";
  try {
    while (position > 0) {
      const start = Math.max(0, position - chunkSize);
      const buffer = Buffer.alloc(position - start);
      fs.readSync(descriptor, buffer, 0, buffer.length, start);
      const lines = `${buffer.toString("utf8")}${trailingPartial}`.split("\n");
      trailingPartial = start > 0 ? lines.shift() || "" : "";
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        let record: { type?: string; payload?: Record<string, unknown> };
        try { record = JSON.parse(lines[index]); } catch { continue; }
        const payload = record.payload;
        if (record.type !== "event_msg" || !payload) continue;
        const type = String(payload.type || "");
        if (type === "task_started") return { active: true, turnId: String(payload.turn_id || "external") };
        if (["task_complete", "turn_complete", "turn_aborted", "task_cancelled"].includes(type)) return { active: false, turnId: null };
      }
      position = start;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return null;
}

function pushRecent(tracker: Tracker, item: ToolItem): void {
  const index = tracker.recent.findIndex((candidate) => candidate.id === item.id);
  if (index >= 0) tracker.recent.splice(index, 1);
  tracker.recent.push(item);
  if (tracker.recent.length > 192) tracker.recent.splice(0, tracker.recent.length - 192);
}

function extractCommand(input: string): string {
  if (!input) return "Codex command";
  const match = input.match(/exec_command\(\{cmd:("(?:\\.|[^"\\])*")/s);
  if (match) {
    try { return JSON.parse(match[1]); } catch { /* use compact fallback */ }
  }
  return input.length > 4_000 ? `${input.slice(0, 3_999)}…` : input;
}

export function isApplyPatchCall(input: string): boolean {
  return input.includes("tools.apply_patch") || (input.includes("apply_patch") && input.includes("*** Begin Patch"));
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  try { return JSON.parse(value); } catch { return { input: value }; }
}

function flattenOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => {
    if (item && typeof item === "object" && "text" in item) return String((item as { text: unknown }).text);
    return typeof item === "string" ? item : JSON.stringify(item);
  }).join("");
  return value == null ? "" : JSON.stringify(value, null, 2);
}

function inferExitCode(output: string): number | null {
  const match = output.match(/(?:exit code|Process exited with code)\s*[:=]?\s*(-?\d+)/i);
  return match ? Number(match[1]) : null;
}

function truncateTail(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `…[earlier output truncated]\n${value.slice(-(maximum - 28))}`;
}

function canonicalPath(value: string): string {
  try { return fs.realpathSync(value); } catch { return path.resolve(value); }
}

function extractMessageText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (!part || typeof part !== "object") return "";
    const content = part as { type?: unknown; text?: unknown };
    return ["input_text", "output_text", "text"].includes(String(content.type || "")) ? String(content.text || "") : "";
  }).filter(Boolean).join("\n");
}

export function isInjectedUserContext(text: string): boolean {
  const trimmed = text.trim();
  return /^<(environment_context|codex_internal_context)(?:\s[^>]*)?>[\s\S]*<\/\1>$/.test(trimmed);
}

function normalizeDatabaseTimestamp(value: unknown): number {
  const timestamp = Number(value || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
  return timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp;
}
