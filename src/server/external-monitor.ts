import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

type Notification = { method: string; params: Record<string, unknown> };
type ThreadRow = { id: string; rollout_path: string; cwd: string };
type ToolItem = Record<string, unknown> & { id: string; type: string };
type Tracker = {
  id: string;
  path: string;
  cwd: string;
  offset: number;
  partial: string;
  active: boolean;
  activeTurnId: string | null;
  calls: Map<string, ToolItem>;
  recent: ToolItem[];
};

export class ExternalCodexMonitor {
  private readonly db: DatabaseSync;
  private readonly trackers = new Map<string, Tracker>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(private readonly emit: (notification: Notification, historical?: boolean) => void, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")) {
    this.db = new DatabaseSync(path.join(codexHome, "state_5.sqlite"), { readOnly: true });
  }

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), 650);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.db.close();
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const rows = this.db.prepare(
        "SELECT id, rollout_path, cwd FROM threads WHERE archived = 0 ORDER BY updated_at_ms DESC LIMIT 32"
      ).all() as unknown as ThreadRow[];
      for (const row of rows) this.readThread(row);
    } catch (error) {
      console.error("[ForgeDeck] External Codex monitor failed:", error);
    } finally {
      this.polling = false;
    }
  }

  private readThread(row: ThreadRow): void {
    let stat: fs.Stats;
    try { stat = fs.statSync(row.rollout_path); } catch { return; }
    let tracker = this.trackers.get(row.id);
    const initial = !tracker;
    if (!tracker) {
      tracker = {
        id: row.id,
        path: row.rollout_path,
        cwd: row.cwd,
        offset: Math.max(0, stat.size - 1024 * 1024),
        partial: "",
        active: false,
        activeTurnId: null,
        calls: new Map(),
        recent: []
      };
      this.trackers.set(row.id, tracker);
    }
    if (stat.size < tracker.offset) {
      tracker.offset = 0;
      tracker.partial = "";
    }
    if (stat.size === tracker.offset) return;

    const length = stat.size - tracker.offset;
    const buffer = Buffer.alloc(length);
    const descriptor = fs.openSync(tracker.path, "r");
    try { fs.readSync(descriptor, buffer, 0, length, tracker.offset); } finally { fs.closeSync(descriptor); }
    tracker.offset = stat.size;
    const chunks = `${tracker.partial}${buffer.toString("utf8")}`.split("\n");
    tracker.partial = chunks.pop() || "";
    for (const line of chunks) this.processLine(tracker, line, !initial);

    if (initial) {
      this.emitStatus(tracker, true);
      for (const item of tracker.recent.slice(-192)) {
        this.emit({ method: item.status === "inProgress" ? "item/started" : "item/completed", params: { threadId: tracker.id, turnId: "external", item } }, true);
      }
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
      if (emitNow) {
        if (changed) this.emitStatus(tracker);
        this.emit({ method: "turn/started", params: { threadId: tracker.id, turn: { id: tracker.activeTurnId, status: "inProgress", items: [] } } });
      }
      return;
    }
    if (record.type === "event_msg" && payloadType === "user_message") {
      const changed = !tracker.active;
      tracker.active = true;
      if (emitNow && changed) this.emitStatus(tracker);
      return;
    }
    if (record.type === "event_msg" && ["task_complete", "turn_complete", "turn_aborted", "task_cancelled"].includes(payloadType)) {
      const changed = tracker.active;
      const turnId = String(payload.turn_id || tracker.activeTurnId || "external");
      tracker.active = false;
      tracker.activeTurnId = null;
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
        diff: String(change.unified_diff || ""),
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
        ? { type: "agentMessage", id, text, phase: payload.phase == null ? null : String(payload.phase), memoryCitation: null }
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
      const output = flattenOutput(payload.output);
      const completed: ToolItem = existing.type === "commandExecution"
        ? { ...existing, status: "completed", aggregatedOutput: output, exitCode: inferExitCode(output) }
        : { ...existing, status: "completed", contentItems: output ? [{ type: "inputText", text: output }] : [], success: true };
      tracker.calls.set(callId, completed);
      pushRecent(tracker, completed);
      if (emitNow) this.emit({ method: "item/completed", params: { threadId: tracker.id, turnId: "external", item: completed } });
    }
  }

  private emitStatus(tracker: Tracker, historical = false): void {
    this.emit({ method: "thread/status/changed", params: { threadId: tracker.id, status: tracker.active ? { type: "active", activeFlags: [] } : { type: "idle" } } }, historical);
  }
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
