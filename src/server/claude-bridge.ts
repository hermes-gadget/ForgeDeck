import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { logger } from "./logger.js";
import type { OperationContext, OperationOptions, OperationScheduler } from "./operation-pool.js";

const CLAUDE_SESSION_PREFIX = "claude-";
const CLAUDE_OWNER_OPTION = "@forgedeck_claude_owner";
const CLAUDE_OWNER = "forgedeck";
const CLAUDE_ACTIVE_OPTION = "@forgedeck_claude_active";
const CLAUDE_ACTIVE_SINCE_OPTION = "@forgedeck_claude_active_since";
const CLAUDE_COMPLETION_MARKER_OPTION = "@forgedeck_claude_completion_marker";
const CLAUDE_LAST_EXIT_OPTION = "@forgedeck_claude_last_exit";
const CLAUDE_TURN_STATE_OPTION = "@forgedeck_claude_turn_state";
const CLAUDE_SESSION_ID_OPTION = "@forgedeck_claude_session_id";
const CLAUDE_COMPLETION_MARKER_PREFIX = "__FD_CLAUDE_DONE_";
const COMPLETION_OBSERVER_INTERVAL_MS = 500;
const DEFAULT_INTERRUPT_ACK_TIMEOUT_MS = 10_000;
const THREAD_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_TURNS = 15;

/** Effort levels accepted by the Claude Code CLI's --effort flag. */
export const CLAUDE_EFFORT_LEVELS = Object.freeze(["low", "medium", "high", "xhigh", "max"] as const);
/** Permission modes accepted by the Claude Code CLI; "default" means no --permission-mode flag. */
const CLAUDE_PERMISSION_MODES = Object.freeze([
  "default",
  "plan",
  "acceptEdits",
  "bypassPermissions",
  "auto",
  "manual",
  "dontAsk"
] as const);
const STALE_SESSION_SECONDS = 24 * 60 * 60;
const MAINTENANCE_CHUNK_SIZE = 25;
type CommandResult = { stdout: string; stderr: string };
type CommandRunner = (file: string, args: string[], timeoutMs?: number, signal?: AbortSignal) => Promise<CommandResult>;

export type ClaudePlanUsage = {
  usedPercent: number;
  observedAt: number;
};

export type ClaudeBridgeOptions = {
  claudeBin: string;
  environment: Readonly<NodeJS.ProcessEnv>;
  run?: CommandRunner;
  interruptAckTimeoutMs?: number;
  readScheduler?: OperationScheduler;
  mutationScheduler?: OperationScheduler;
};

export type ClaudeAvailabilityOptions = Pick<ClaudeBridgeOptions, "claudeBin" | "environment">;

export type ClaudeStartParams = {
  threadId: string;
  cwd: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  prompt?: string;
  maxTurns?: number;
};

type ClaudeProcessSession = {
  threadId: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  maxTurns: number;
  claudeSessionId: string;
  hasConversation: boolean;
};

export type ClaudeTurnState = "accepted" | "running" | "interrupting" | "completed" | "failed";

export type ClaudeTurnTerminalReason =
  | "completed"
  | "interrupted"
  | "process_failed"
  | "process_lost"
  | "submission_failed"
  | "archived";

export type ClaudeTurnSnapshot = {
  id: string;
  threadId: string;
  state: ClaudeTurnState;
  acceptedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  exitCode: number | null;
  reason: ClaudeTurnTerminalReason | null;
  error: string | null;
};

export type ClaudeTurnHandle = {
  readonly id: string;
  readonly threadId: string;
  readonly accepted: Promise<ClaudeTurnSnapshot>;
  readonly completion: Promise<ClaudeTurnSnapshot>;
  snapshot(): ClaudeTurnSnapshot;
};

export type ClaudeOutputSnapshot = {
  threadId: string;
  turnId: string;
  text: string;
  observedAt: number;
};

type ActiveClaudeTurn = {
  target: string;
  marker: string;
  handle: MutableClaudeTurnHandle;
  transitionTail: Promise<void>;
  enterAcknowledged: boolean;
  lastOutputDigest: string;
};

type TurnTransition = {
  exitCode?: number | null;
  reason?: ClaudeTurnTerminalReason | null;
  error?: string | null;
  persist?: boolean;
};

type TransitionResult = { snapshot: ClaudeTurnSnapshot; changed: boolean };

class MutableClaudeTurnHandle implements ClaudeTurnHandle {
  readonly id: string;
  readonly threadId: string;
  readonly accepted: Promise<ClaudeTurnSnapshot>;
  readonly completion: Promise<ClaudeTurnSnapshot>;
  private current: ClaudeTurnSnapshot;
  private resolveCompletion!: (snapshot: ClaudeTurnSnapshot) => void;

  constructor(snapshot: ClaudeTurnSnapshot) {
    this.id = snapshot.id;
    this.threadId = snapshot.threadId;
    this.current = snapshot;
    this.accepted = Promise.resolve(Object.freeze({ ...snapshot, state: "accepted" }));
    this.completion = new Promise((resolve) => { this.resolveCompletion = resolve; });
  }

  snapshot(): ClaudeTurnSnapshot {
    return Object.freeze({ ...this.current });
  }

  update(snapshot: ClaudeTurnSnapshot): void {
    this.current = snapshot;
    if (isTerminalTurnState(snapshot.state)) this.resolveCompletion(this.snapshot());
  }
}

export class ClaudeBridgeError extends Error {
  constructor(
    message: string,
    readonly code: "TMUX_SESSION_NOT_FOUND" | "TMUX_UNAVAILABLE" | "TMUX_TIMEOUT" | "TMUX_COMMAND_FAILED",
    readonly indeterminate: boolean,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ClaudeBridgeError";
  }
}

/** Manages opt-in Claude Code print sessions inside durable tmux shells. */
export class ClaudeBridge extends EventEmitter<{
  turnState: [snapshot: ClaudeTurnSnapshot];
  output: [snapshot: ClaudeOutputSnapshot];
}> {
  private readonly sessions = new Map<string, ClaudeProcessSession>();
  private readonly sendMessageLocks = new Map<string, Promise<void>>();
  private readonly activeTurns = new Map<string, ActiveClaudeTurn>();
  private readonly lastTurns = new Map<string, ClaudeTurnSnapshot>();
  private readonly lastExitCodes = new Map<string, number>();
  private readonly operationScope = new AsyncLocalStorage<OperationOptions>();
  private completionObserver: NodeJS.Timeout | null = null;
  private observingCompletions = false;
  private readonly claudeBin: string;
  private readonly environment: Readonly<NodeJS.ProcessEnv>;
  private resolvedClaudeBin: Promise<string> | null = null;
  private readonly run: CommandRunner;
  private readonly interruptAckTimeoutMs: number;
  private readonly readScheduler?: OperationScheduler;
  private readonly mutationScheduler?: OperationScheduler;

  constructor(options: ClaudeBridgeOptions) {
    super();
    this.claudeBin = options.claudeBin;
    this.interruptAckTimeoutMs = options.interruptAckTimeoutMs ?? DEFAULT_INTERRUPT_ACK_TIMEOUT_MS;
    this.readScheduler = options.readScheduler;
    this.mutationScheduler = options.mutationScheduler;
    const environment = Object.freeze({ ...options.environment });
    this.environment = environment;
    this.run = options.run || ((file, args, timeoutMs, signal) => runCommand(file, args, timeoutMs, signal, environment));
    if (!this.claudeBin.trim()) throw new Error("Claude executable must not be empty");
    if (!Number.isFinite(this.interruptAckTimeoutMs) || this.interruptAckTimeoutMs < 1) {
      throw new Error("Claude interrupt acknowledgement timeout must be positive");
    }
  }

  withOperationOptions<T>(options: OperationOptions, operation: () => Promise<T>): Promise<T> {
    return this.operationScope.run(options, operation);
  }

  async start(params: ClaudeStartParams): Promise<{ ok: boolean; turn: ClaudeTurnHandle | null }> {
    validateThreadId(params.threadId);
    validateEffort(params.effort);
    validatePermissionMode(params.permissionMode);
    const maxTurns = normalizeMaxTurns(params.maxTurns);
    const target = sessionName(params.threadId);
    if (await this.hasTmuxSession(target)) throw new Error(`Claude session ${params.threadId} already exists`);

    await this.runMutationCommand(["new-session", "-d", "-s", target, "-c", params.cwd], 10_000);
    const session: ClaudeProcessSession = {
      threadId: params.threadId,
      model: params.model,
      effort: params.effort,
      permissionMode: params.permissionMode,
      maxTurns,
      claudeSessionId: deriveClaudeSessionId(params.threadId),
      hasConversation: false
    };
    this.sessions.set(params.threadId, session);
    try {
      await Promise.all([
        this.setTmuxOption(target, CLAUDE_OWNER_OPTION, CLAUDE_OWNER),
        this.setTmuxOption(target, CLAUDE_ACTIVE_OPTION, "0"),
        this.setTmuxOption(target, CLAUDE_ACTIVE_SINCE_OPTION, "0"),
        this.setTmuxOption(target, CLAUDE_COMPLETION_MARKER_OPTION, ""),
        this.setTmuxOption(target, CLAUDE_LAST_EXIT_OPTION, ""),
        this.setTmuxOption(target, CLAUDE_TURN_STATE_OPTION, ""),
        this.setTmuxOption(target, CLAUDE_SESSION_ID_OPTION, ""),
        this.setTmuxOption(target, "@forgedeck_created_at", String(Math.floor(Date.now() / 1_000))),
        this.setTmuxOption(target, "@forgedeck_claude_model", params.model || ""),
        this.setTmuxOption(target, "@forgedeck_claude_effort", params.effort || ""),
        this.setTmuxOption(target, "@forgedeck_claude_permission_mode", params.permissionMode || ""),
        this.setTmuxOption(target, "@forgedeck_claude_max_turns", String(maxTurns))
      ]);
      const turn = params.prompt?.trim()
        ? await this.withTurnLock(params.threadId, () => this.sendPrintCommand(session, params.prompt!.trim(), false))
        : null;
      return { ok: true, turn };
    } catch (error) {
      // An Enter failure is indeterminate: the command may have been accepted.
      // Keep the durable session and let the exact-marker observer reconcile it.
      if (this.activeTurns.has(params.threadId)) throw error;
      this.sessions.delete(params.threadId);
      await this.killTmuxSession(target).catch(() => undefined);
      throw error;
    }
  }

  async sendMessage(threadId: string, text: string): Promise<ClaudeTurnHandle> {
    validateThreadId(threadId);
    const message = text.trim();
    if (!message) throw new Error("Claude message cannot be empty");
    return this.withTurnLock(threadId, async () => {
      const session = await this.sessionFor(threadId);
      if ((await this.status(threadId)).active) throw new Error("This Claude session already has an active turn");
      return this.sendPrintCommand(session, message, session.hasConversation);
    });
  }

  async stop(threadId: string): Promise<ClaudeTurnSnapshot | null> {
    validateThreadId(threadId);
    return this.withTurnLock(threadId, async () => {
      const target = sessionName(threadId);
      if (!await this.hasTmuxSession(target)) {
        await this.failProcessLost(threadId);
        return null;
      }
      const turn = await this.trackDurableActiveTurn(threadId, target);
      if (!turn) return this.lastTurns.get(threadId) || null;
      return this.interruptTurn(turn);
    });
  }

  async status(threadId: string): Promise<{ active: boolean; text: string; exitCode: number | null; turn: ClaudeTurnSnapshot | null }> {
    validateThreadId(threadId);
    const target = sessionName(threadId);
    if (!await this.hasTmuxSession(target)) {
      await this.failProcessLost(threadId);
      return {
        active: false,
        text: "",
        exitCode: this.lastExitCodes.get(threadId) ?? null,
        turn: this.lastTurns.get(threadId) || null
      };
    }
    let activeValue: string;
    let durableStateValue: string;
    let marker: string;
    let activeSinceValue: string;
    let captured: CommandResult;
    try {
      [activeValue, durableStateValue, marker, activeSinceValue, captured] = await Promise.all([
        this.getTmuxOption(target, CLAUDE_ACTIVE_OPTION),
        this.getTmuxOption(target, CLAUDE_TURN_STATE_OPTION).catch(() => ""),
        this.getTmuxOption(target, CLAUDE_COMPLETION_MARKER_OPTION).catch(() => ""),
        this.getTmuxOption(target, CLAUDE_ACTIVE_SINCE_OPTION).catch(() => "0"),
        this.runReadCommand(["capture-pane", "-J", "-t", target, "-p", "-S", "-"], 10_000)
      ]);
    } catch (error) {
      throw normalizeTmuxError(error);
    }
    const rawText = stripAnsi(captured.stdout).trimEnd();
    let tracked = this.activeTurns.get(threadId);
    let completionObserved = false;
    const durableState = parseTurnState(durableStateValue);
    if (!tracked && activeValue.trim() === "1" && isCompletionMarker(marker)) {
      tracked = this.recoverTrackedTurn(threadId, target, marker.trim(), durableState, activeSinceValue);
    }
    if (tracked && activeValue.trim() === "1" && marker.trim() === tracked.marker) {
      const exitCode = parseCompletionExitCode(rawText, tracked.marker);
      if (exitCode !== null) {
        await this.completeObservedTurn(threadId, tracked, rawText, exitCode);
        completionObserved = true;
      }
    } else if (tracked && activeValue.trim() !== "1") {
      await this.transitionTurn(tracked, "failed", { reason: "process_lost", error: "Claude active state was lost" });
    }
    const activeTurn = this.activeTurns.get(threadId);
    const active = Boolean(activeTurn)
      || (!completionObserved && activeValue.trim() === "1" && !isTerminalTurnState(durableState));
    let text = rawText;
    text = stripCompletionMarkers(text).trimEnd();
    const parsedSessionId = parseClaudeSessionId(text);
    const session = this.sessions.get(threadId);
    if (session && parsedSessionId) {
      session.claudeSessionId = parsedSessionId;
      if (!active && this.lastExitCodes.get(threadId) === 0 && !session.hasConversation) {
        session.hasConversation = true;
        this.persistSessionIdentity(threadId, target, parsedSessionId);
      }
    }
    return {
      active,
      text,
      exitCode: this.lastExitCodes.get(threadId) ?? null,
      turn: activeTurn?.handle.snapshot() || this.lastTurns.get(threadId) || null
    };
  }

  async exists(threadId: string): Promise<boolean> {
    validateThreadId(threadId);
    return this.hasTmuxSession(sessionName(threadId));
  }

  async setPermissionMode(threadId: string, permissionMode: string): Promise<void> {
    validatePermissionMode(permissionMode);
    const session = await this.sessionFor(threadId);
    session.permissionMode = permissionMode;
    await this.setTmuxOption(sessionName(threadId), "@forgedeck_claude_permission_mode", permissionMode);
  }

  async setEffort(threadId: string, effort: string): Promise<void> {
    validateEffort(effort);
    const session = await this.sessionFor(threadId);
    session.effort = effort;
    await this.setTmuxOption(sessionName(threadId), "@forgedeck_claude_effort", effort);
  }

  async setModel(threadId: string, model: string): Promise<void> {
    const session = await this.sessionFor(threadId);
    session.model = model;
    await this.setTmuxOption(sessionName(threadId), "@forgedeck_claude_model", model);
  }

  async archive(threadId: string): Promise<void> {
    validateThreadId(threadId);
    await this.withTurnLock(threadId, async () => {
      const target = sessionName(threadId);
      if (!await this.hasTmuxSession(target)) {
        await this.failProcessLost(threadId);
      } else {
        const turn = await this.trackDurableActiveTurn(threadId, target);
        if (turn) {
          try {
            await this.interruptTurn(turn);
          } catch (error) {
            // Archive is itself an authoritative terminal operation. After
            // waiting for a graceful acknowledgement, force process loss by
            // destroying the durable shell and publish that terminal state.
            logger.warn("Claude did not acknowledge archive interruption; terminating its tmux session", { threadId, error });
          }
        }
        await this.killTmuxSession(target);
        const remaining = this.activeTurns.get(threadId);
        if (remaining) {
          await this.transitionTurn(remaining, "failed", {
            reason: "archived",
            error: "Claude turn ended when its session was archived",
            persist: false
          });
        }
      }
      this.sessions.delete(threadId);
      this.lastTurns.delete(threadId);
      this.lastExitCodes.delete(threadId);
      this.stopCompletionObserverIfIdle();
    });
  }

  async recoverOrphans(): Promise<string[]> {
    const result = await this.listTmuxSessions("#{session_name}");
    const recovered: string[] = [];
    for (const name of result) {
      if (!name.startsWith(CLAUDE_SESSION_PREFIX)) continue;
      const threadId = name.slice(CLAUDE_SESSION_PREFIX.length);
      if (!THREAD_ID_PATTERN.test(threadId)) continue;
      const owner = await this.getTmuxOption(name, CLAUDE_OWNER_OPTION).catch(() => "");
      if (owner.trim() !== CLAUDE_OWNER) continue;
      const [session, lastExit, active, completionMarker, turnState, activeSince] = await Promise.all([
        this.recoverSessionFromOptions(threadId, name),
        this.getTmuxOption(name, CLAUDE_LAST_EXIT_OPTION).catch(() => ""),
        this.getTmuxOption(name, CLAUDE_ACTIVE_OPTION).catch(() => "0"),
        this.getTmuxOption(name, CLAUDE_COMPLETION_MARKER_OPTION).catch(() => ""),
        this.getTmuxOption(name, CLAUDE_TURN_STATE_OPTION).catch(() => ""),
        this.getTmuxOption(name, CLAUDE_ACTIVE_SINCE_OPTION).catch(() => "0")
      ]);
      this.sessions.set(threadId, session);
      const exitCode = Number(lastExit);
      if (lastExit.trim() !== "" && Number.isInteger(exitCode)) this.lastExitCodes.set(threadId, exitCode);
      if (active.trim() === "1" && isCompletionMarker(completionMarker)) {
        this.recoverTrackedTurn(threadId, name, completionMarker.trim(), parseTurnState(turnState), activeSince);
      }
      recovered.push(threadId);
    }
    return recovered;
  }

  static async checkAvailable(options: ClaudeAvailabilityOptions, signal?: AbortSignal): Promise<boolean> {
    const environment = Object.freeze({ ...options.environment });
    try {
      await runCommand("tmux", ["-V"], 5_000, signal, environment);
      const claudeBin = await resolveClaudeBin(options.claudeBin, signal, environment);
      await runCommand(claudeBin, ["--version"], 8_000, signal, environment);
      let status: CommandResult;
      try {
        status = await runCommand(claudeBin, ["auth", "status", "--text"], 10_000, signal, environment);
      } catch {
        status = await runCommand(claudeBin, ["auth", "status"], 10_000, signal, environment);
      }
      const output = `${status.stdout}\n${status.stderr}`.toLowerCase();
      return !/(not logged in|not authenticated|authentication required|loggedin["']?\s*:\s*false)/.test(output);
    } catch {
      return false;
    }
  }

  /** Reads the subscription usage shown by Claude Code's zero-token /usage command. */
  async readUsage(signal?: AbortSignal): Promise<ClaudePlanUsage | null> {
    const claudeBin = await this.claudeExecutable();
    const result = await this.run(claudeBin, [
      "-p",
      "/usage",
      "--output-format",
      "json",
      "--no-session-persistence"
    ], 10_000, signal);
    return parseClaudeUsageOutput(result.stdout);
  }

  cleanStaleSessions(): Promise<void> {
    return this.cleanStaleSessionsNow();
  }

  private async cleanStaleSessionsNow(): Promise<void> {
    const now = Math.floor(Date.now() / 1_000);
    const entries = await this.listTmuxSessions("#{session_name}\t#{session_created}");
    for (let offset = 0; offset < entries.length; offset += MAINTENANCE_CHUNK_SIZE) {
      const chunk = entries.slice(offset, offset + MAINTENANCE_CHUNK_SIZE);
      const results = await Promise.allSettled(chunk.map(async (entry) => {
        const [name, createdValue] = entry.split("\t");
        const createdAt = Number(createdValue);
        if (!name.startsWith(CLAUDE_SESSION_PREFIX) || !Number.isFinite(createdAt) || now - createdAt <= STALE_SESSION_SECONDS) return;
        const owner = await this.getTmuxOption(name, CLAUDE_OWNER_OPTION).catch(() => "");
        if (owner.trim() !== CLAUDE_OWNER) return;
        const active = await this.getTmuxOption(name, CLAUDE_ACTIVE_OPTION).catch(() => "0");
        if (active.trim() === "1") return;
        const threadId = name.slice(CLAUDE_SESSION_PREFIX.length);
        this.sessions.delete(threadId);
        await this.killTmuxSession(name);
      }));
      for (const result of results) {
        if (result.status === "rejected") logger.warn("Could not clean stale ForgeDeck Claude session", { error: result.reason });
      }
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), "Could not clean stale Claude sessions");
      if (offset + chunk.length < entries.length) await new Promise((resolve) => setImmediate(resolve));
    }
  }

  private async sessionFor(threadId: string): Promise<ClaudeProcessSession> {
    const existing = this.sessions.get(threadId);
    if (existing) return existing;
    const target = sessionName(threadId);
    if (!await this.hasTmuxSession(target)) throw new Error("Claude session not found");
    const owner = await this.getTmuxOption(target, CLAUDE_OWNER_OPTION).catch(() => "");
    if (owner.trim() !== CLAUDE_OWNER) throw new Error("Claude session is not owned by ForgeDeck");
    const recovered = await this.recoverSessionFromOptions(threadId, target);
    this.sessions.set(threadId, recovered);
    await this.trackDurableActiveTurn(threadId, target);
    return recovered;
  }

  /**
   * Rebuilds a session record from the durable tmux options. The Claude
   * session id must be a valid UUID for --session-id/--resume, so an
   * unproven or corrupted value falls back to the id derived from the
   * thread id, and hasConversation is only assumed when a successful turn
   * left durable evidence behind.
   */
  private async recoverSessionFromOptions(threadId: string, target: string): Promise<ClaudeProcessSession> {
    const [model, effort, permissionMode, maxTurns, persistedSessionId, lastExit] = await Promise.all([
      this.getTmuxOption(target, "@forgedeck_claude_model").catch(() => ""),
      this.getTmuxOption(target, "@forgedeck_claude_effort").catch(() => ""),
      this.getTmuxOption(target, "@forgedeck_claude_permission_mode").catch(() => ""),
      this.getTmuxOption(target, "@forgedeck_claude_max_turns").catch(() => String(DEFAULT_MAX_TURNS)),
      this.getTmuxOption(target, CLAUDE_SESSION_ID_OPTION).catch(() => ""),
      this.getTmuxOption(target, CLAUDE_LAST_EXIT_OPTION).catch(() => "")
    ]);
    const provenSessionId = UUID_PATTERN.test(persistedSessionId.trim()) ? persistedSessionId.trim().toLowerCase() : null;
    return {
      threadId,
      model: model || undefined,
      effort: isClaudeEffort(effort) ? effort : undefined,
      permissionMode: isClaudePermissionMode(permissionMode) ? permissionMode : undefined,
      maxTurns: normalizeMaxTurns(Number(maxTurns)),
      claudeSessionId: provenSessionId || deriveClaudeSessionId(threadId),
      hasConversation: provenSessionId !== null || lastExit.trim() === "0"
    };
  }

  private async sendPrintCommand(session: ClaudeProcessSession, prompt: string, resume: boolean): Promise<ClaudeTurnHandle> {
    const target = sessionName(session.threadId);
    if (!await this.hasTmuxSession(target)) throw new Error("Claude session not found");
    // Claude Code only accepts UUID session ids; never trust a stale value.
    if (!UUID_PATTERN.test(session.claudeSessionId)) session.claudeSessionId = deriveClaudeSessionId(session.threadId);
    const args = ["-p", "--verbose", "--output-format", "stream-json", "--max-turns", String(session.maxTurns)];
    if (resume) args.push("--resume", session.claudeSessionId);
    else args.push("--session-id", session.claudeSessionId);
    if (session.model) args.push("--model", session.model);
    if (session.effort) args.push("--effort", session.effort);
    if (session.permissionMode && session.permissionMode !== "default") args.push("--permission-mode", session.permissionMode);
    args.push("--", prompt);
    const claudeBin = await this.claudeExecutable();
    const completionMarker = `${CLAUDE_COMPLETION_MARKER_PREFIX}${randomUUID().replaceAll("-", "")}`;
    const command = `${shellJoin([claudeBin, ...args])}; __forgedeck_claude_exit=$?; printf '\\n%s:%s\\n' ${shellQuote(completionMarker)} "$__forgedeck_claude_exit"`;
    const acceptedAt = Date.now();
    await this.setTmuxOption(target, CLAUDE_ACTIVE_SINCE_OPTION, String(Math.floor(acceptedAt / 1_000)));
    await this.setTmuxOption(target, CLAUDE_COMPLETION_MARKER_OPTION, completionMarker);
    await this.setTmuxOption(target, CLAUDE_LAST_EXIT_OPTION, "");
    await this.setTmuxOption(target, CLAUDE_TURN_STATE_OPTION, "accepted");
    await this.setTmuxOption(target, CLAUDE_ACTIVE_OPTION, "1");
    try {
      await this.runMutationCommand(["send-keys", "-t", target, "-l", "--", command], 10_000);
    } catch (error) {
      await this.recordSubmissionFailure(session.threadId, target, completionMarker, acceptedAt, error);
      throw error;
    }
    const turn = this.createTrackedTurn(session.threadId, target, completionMarker, "accepted", acceptedAt);
    this.publishTurnState(turn.handle.snapshot());
    try {
      await this.runMutationCommand(["send-keys", "-t", target, "Enter"], 10_000);
    } catch (error) {
      // Enter may have reached tmux before a timeout/error was reported. Keep
      // the accepted turn reserved so a retry cannot overlap it. A definite
      // session-loss error is terminal; timeouts remain indeterminate.
      const normalized = normalizeTmuxError(error);
      if (!normalized.indeterminate) {
        await this.transitionTurn(turn, "failed", {
          reason: "submission_failed",
          error: normalized.message,
          persist: normalized.code !== "TMUX_SESSION_NOT_FOUND"
        });
        throw normalized;
      }
      logger.warn("Claude Enter acknowledgement was indeterminate; retaining turn ownership", {
        threadId: session.threadId,
        error: normalized
      });
      this.startTrackingTurn();
      return turn.handle;
    }

    turn.enterAcknowledged = true;
    try {
      await this.transitionTurn(turn, "running");
    } catch (error) {
      // Enter was acknowledged, so Claude may be running even if persisting
      // the running state failed. Keep the accepted handle/capacity and let
      // the observer retry the durable transition.
      logger.warn("Could not persist running Claude turn state; retaining accepted ownership", {
        threadId: session.threadId,
        error
      });
    }
    this.startTrackingTurn();
    return turn.handle;
  }

  private async withTurnLock<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sendMessageLocks.get(threadId) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    this.sendMessageLocks.set(threadId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.sendMessageLocks.get(threadId) === tail) this.sendMessageLocks.delete(threadId);
    }
  }

  private async trackDurableActiveTurn(threadId: string, target: string): Promise<ActiveClaudeTurn | null> {
    const existing = this.activeTurns.get(threadId);
    if (existing) return existing;
    const [active, marker, state, activeSince] = await Promise.all([
      this.getTmuxOption(target, CLAUDE_ACTIVE_OPTION),
      this.getTmuxOption(target, CLAUDE_COMPLETION_MARKER_OPTION),
      this.getTmuxOption(target, CLAUDE_TURN_STATE_OPTION).catch(() => ""),
      this.getTmuxOption(target, CLAUDE_ACTIVE_SINCE_OPTION).catch(() => "0")
    ]);
    if (active.trim() === "1" && isCompletionMarker(marker)) {
      return this.recoverTrackedTurn(threadId, target, marker.trim(), parseTurnState(state), activeSince);
    }
    return null;
  }

  private startTrackingTurn(): void {
    if (!this.completionObserver) {
      this.completionObserver = setInterval(() => this.scheduleCompletionObservation(), COMPLETION_OBSERVER_INTERVAL_MS);
      this.completionObserver.unref();
    }
    this.scheduleCompletionObservation();
  }

  private scheduleCompletionObservation(): void {
    void this.operationScope.run(
      { priority: "background", fairnessKey: "claude-completion-observer" },
      () => this.observeCompletions()
    );
  }

  private async observeCompletions(): Promise<void> {
    if (this.observingCompletions || !this.activeTurns.size) return;
    this.observingCompletions = true;
    try {
      await Promise.allSettled([...this.activeTurns].map(([threadId, turn]) => this.withOperationOptions({
        priority: "background",
        fairnessKey: "claude-turn-observer",
        deadline: Date.now() + 10_000
      }, () => this.observeTurn(threadId, turn))));
    } finally {
      this.observingCompletions = false;
      this.stopCompletionObserverIfIdle();
    }
  }

  private async observeTurn(threadId: string, turn: ActiveClaudeTurn): Promise<void> {
    try {
      if (!await this.hasTmuxSession(turn.target)) {
        if (this.activeTurns.get(threadId) === turn) {
          await this.transitionTurn(turn, "failed", {
            reason: "process_lost",
            error: "Claude tmux session disappeared",
            persist: false
          });
        }
        return;
      }
      if (turn.enterAcknowledged && turn.handle.snapshot().state === "accepted") {
        await this.transitionTurn(turn, "running");
      }
      const [active, marker, captured] = await Promise.all([
        this.getTmuxOption(turn.target, CLAUDE_ACTIVE_OPTION),
        this.getTmuxOption(turn.target, CLAUDE_COMPLETION_MARKER_OPTION),
        this.runReadCommand(["capture-pane", "-J", "-t", turn.target, "-p", "-S", "-"], 10_000)
      ]);
      if (this.activeTurns.get(threadId) !== turn) return;
      if (active.trim() !== "1") {
        await this.transitionTurn(turn, "failed", {
          reason: "process_lost",
          error: "Claude active state was cleared without a completion marker"
        });
        return;
      }
      if (marker.trim() !== turn.marker) return;
      const text = stripAnsi(captured.stdout).trimEnd();
      this.publishTurnOutput(turn, turnOutputSegment(text, turn.marker));
      const exitCode = parseCompletionExitCode(text, turn.marker);
      if (exitCode === null) return;
      await this.completeObservedTurn(threadId, turn, text, exitCode);
    } catch (error) {
      // Observation failures are indeterminate and must leave durable active
      // state intact. The shared observer retries on its next health pass.
      logger.warn("Could not observe active Claude turn", { threadId, error });
    }
  }

  private createTrackedTurn(
    threadId: string,
    target: string,
    marker: string,
    state: "accepted" | "running" | "interrupting",
    acceptedAt: number
  ): ActiveClaudeTurn {
    const existing = this.activeTurns.get(threadId);
    if (existing?.marker === marker) return existing;
    if (existing) throw new Error(`Claude session ${threadId} already has an active turn`);
    const snapshot: ClaudeTurnSnapshot = {
      id: marker,
      threadId,
      state,
      acceptedAt,
      startedAt: state === "running" ? acceptedAt : null,
      completedAt: null,
      exitCode: null,
      reason: null,
      error: null
    };
    const turn: ActiveClaudeTurn = {
      target,
      marker,
      handle: new MutableClaudeTurnHandle(snapshot),
      transitionTail: Promise.resolve(),
      enterAcknowledged: state !== "accepted",
      lastOutputDigest: ""
    };
    this.activeTurns.set(threadId, turn);
    this.lastTurns.delete(threadId);
    this.lastExitCodes.delete(threadId);
    return turn;
  }

  private recoverTrackedTurn(
    threadId: string,
    target: string,
    marker: string,
    durableState: ClaudeTurnState | null,
    activeSinceValue: string
  ): ActiveClaudeTurn {
    const existing = this.activeTurns.get(threadId);
    if (existing?.marker === marker) return existing;
    const state = durableState === "accepted" || durableState === "interrupting" ? durableState : "running";
    const activeSince = Number(activeSinceValue);
    const acceptedAt = Number.isFinite(activeSince) && activeSince > 0 ? activeSince * 1_000 : Date.now();
    const turn = this.createTrackedTurn(threadId, target, marker, state, acceptedAt);
    this.publishTurnState(turn.handle.snapshot());
    this.startTrackingTurn();
    return turn;
  }

  private async recordSubmissionFailure(
    threadId: string,
    target: string,
    marker: string,
    acceptedAt: number,
    error: unknown
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await Promise.allSettled([
      this.setTmuxOption(target, CLAUDE_TURN_STATE_OPTION, "failed"),
      this.setTmuxOption(target, CLAUDE_ACTIVE_OPTION, "0"),
      this.setTmuxOption(target, CLAUDE_ACTIVE_SINCE_OPTION, "0")
    ]);
    const snapshot: ClaudeTurnSnapshot = Object.freeze({
      id: marker,
      threadId,
      state: "failed",
      acceptedAt,
      startedAt: null,
      completedAt: Date.now(),
      exitCode: null,
      reason: "submission_failed",
      error: message
    });
    this.lastTurns.set(threadId, snapshot);
    this.publishTurnState(snapshot);
  }

  private transitionTurn(
    turn: ActiveClaudeTurn,
    state: ClaudeTurnState,
    transition: TurnTransition = {}
  ): Promise<TransitionResult> {
    const operation = turn.transitionTail
      .catch(() => undefined)
      .then(() => this.applyTurnTransition(turn, state, transition));
    turn.transitionTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async applyTurnTransition(
    turn: ActiveClaudeTurn,
    state: ClaudeTurnState,
    transition: TurnTransition
  ): Promise<TransitionResult> {
    const current = turn.handle.snapshot();
    if (this.activeTurns.get(current.threadId) !== turn || isTerminalTurnState(current.state)) {
      return { snapshot: current, changed: false };
    }
    if (current.state === state) return { snapshot: current, changed: false };
    if (!canTransitionTurn(current.state, state)) {
      throw new Error(`Invalid Claude turn transition ${current.state} -> ${state}`);
    }

    const persist = transition.persist !== false;
    if (persist) {
      await this.setTmuxOption(turn.target, CLAUDE_TURN_STATE_OPTION, state);
      if (transition.exitCode !== undefined && transition.exitCode !== null) {
        await this.setTmuxOption(turn.target, CLAUDE_LAST_EXIT_OPTION, String(transition.exitCode));
      }
      if (isTerminalTurnState(state)) {
        await this.setTmuxOption(turn.target, CLAUDE_ACTIVE_OPTION, "0");
        await this.setTmuxOption(turn.target, CLAUDE_ACTIVE_SINCE_OPTION, "0").catch(() => undefined);
      }
    }

    const now = Date.now();
    const snapshot: ClaudeTurnSnapshot = Object.freeze({
      ...current,
      state,
      startedAt: current.startedAt ?? (state === "running" ? now : null),
      completedAt: isTerminalTurnState(state) ? now : null,
      exitCode: transition.exitCode !== undefined ? transition.exitCode : current.exitCode,
      reason: transition.reason !== undefined ? transition.reason : current.reason,
      error: transition.error !== undefined ? transition.error : current.error
    });
    turn.handle.update(snapshot);
    if (isTerminalTurnState(state)) {
      if (snapshot.exitCode !== null) this.lastExitCodes.set(snapshot.threadId, snapshot.exitCode);
      this.activeTurns.delete(snapshot.threadId);
      this.lastTurns.set(snapshot.threadId, snapshot);
      this.stopCompletionObserverIfIdle();
    }
    this.publishTurnState(snapshot);
    return { snapshot, changed: true };
  }

  private async completeObservedTurn(
    threadId: string,
    turn: ActiveClaudeTurn,
    text: string,
    exitCode: number
  ): Promise<ClaudeTurnSnapshot> {
    const interrupted = turn.handle.snapshot().state === "interrupting";
    const state: ClaudeTurnState = exitCode === 0 || interrupted ? "completed" : "failed";
    const result = await this.transitionTurn(turn, state, {
      exitCode,
      reason: interrupted ? "interrupted" : exitCode === 0 ? "completed" : "process_failed",
      error: exitCode === 0 || interrupted ? null : `Claude exited with status ${exitCode}`
    });
    if (result.changed) {
      const session = this.sessions.get(threadId);
      if (session) this.reconcileConversationState(threadId, turn, session, text, exitCode);
    }
    return result.snapshot;
  }

  /**
   * Updates conversation identity from a turn's own output. A result JSON in
   * the segment proves the conversation exists even when the process exited
   * non-zero (max turns, API errors); the two session-id errors mean our
   * new-vs-resume choice was stale, so flip it for the next turn.
   */
  private reconcileConversationState(
    threadId: string,
    turn: ActiveClaudeTurn,
    session: ClaudeProcessSession,
    text: string,
    exitCode: number
  ): void {
    const segment = turnOutputSegment(text, turn.marker);
    const parsedSessionId = parseClaudeSessionId(stripCompletionMarkers(segment));
    if (exitCode === 0 || parsedSessionId) {
      if (parsedSessionId) session.claudeSessionId = parsedSessionId;
      session.hasConversation = true;
      this.persistSessionIdentity(threadId, turn.target, session.claudeSessionId);
      return;
    }
    if (new RegExp(`Session ID ${escapeRegExp(session.claudeSessionId)} is already in use`, "i").test(segment)) {
      session.hasConversation = true;
      this.persistSessionIdentity(threadId, turn.target, session.claudeSessionId);
      return;
    }
    if (new RegExp(`No conversation found with session ID:?\\s*${escapeRegExp(session.claudeSessionId)}`, "i").test(segment)) {
      session.hasConversation = false;
      session.claudeSessionId = deriveClaudeSessionId(threadId);
      this.persistSessionIdentity(threadId, turn.target, "");
    }
  }

  private persistSessionIdentity(threadId: string, target: string, sessionId: string): void {
    void this.setTmuxOption(target, CLAUDE_SESSION_ID_OPTION, sessionId).catch((error) => {
      logger.warn("Could not persist Claude session identity", { threadId, error });
    });
  }

  private async interruptTurn(turn: ActiveClaudeTurn): Promise<ClaudeTurnSnapshot> {
    const marked = await this.transitionTurn(turn, "interrupting");
    if (isTerminalTurnState(marked.snapshot.state)) return marked.snapshot;
    try {
      await this.runMutationCommand(["send-keys", "-t", turn.target, "C-c"], 10_000);
    } catch (error) {
      const normalized = normalizeTmuxError(error);
      if (normalized.code === "TMUX_SESSION_NOT_FOUND") {
        return (await this.transitionTurn(turn, "failed", {
          reason: "process_lost",
          error: normalized.message,
          persist: false
        })).snapshot;
      }
      throw normalized;
    }
    await this.observeTurn(turn.handle.threadId, turn);
    return this.waitForTurnCompletion(turn);
  }

  private async waitForTurnCompletion(turn: ActiveClaudeTurn): Promise<ClaudeTurnSnapshot> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        turn.handle.completion,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(
            `Claude did not acknowledge interruption within ${this.interruptAckTimeoutMs}ms`
          )), this.interruptAckTimeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async failProcessLost(threadId: string): Promise<void> {
    const turn = this.activeTurns.get(threadId);
    if (!turn) return;
    await this.transitionTurn(turn, "failed", {
      reason: "process_lost",
      error: "Claude tmux session disappeared",
      persist: false
    });
  }

  private publishTurnState(snapshot: ClaudeTurnSnapshot): void {
    try {
      this.emit("turnState", Object.freeze({ ...snapshot }));
    } catch (error) {
      logger.error("Claude turn-state listener failed", { threadId: snapshot.threadId, state: snapshot.state, error });
    }
  }

  private publishTurnOutput(turn: ActiveClaudeTurn, text: string): void {
    const cleaned = stripCompletionMarkers(text).trimEnd();
    const digest = createHash("sha256").update(cleaned).digest("base64url");
    if (digest === turn.lastOutputDigest) return;
    turn.lastOutputDigest = digest;
    try {
      this.emit("output", Object.freeze({
        threadId: turn.handle.threadId,
        turnId: turn.handle.id,
        text: cleaned,
        observedAt: Date.now()
      }));
    } catch (error) {
      logger.error("Claude output listener failed", { threadId: turn.handle.threadId, error });
    }
  }

  private stopCompletionObserverIfIdle(): void {
    if (this.activeTurns.size || !this.completionObserver) return;
    clearInterval(this.completionObserver);
    this.completionObserver = null;
  }

  private async hasTmuxSession(target: string): Promise<boolean> {
    try {
      await this.runReadCommand(["has-session", "-t", target], 5_000);
      return true;
    } catch (error) {
      const normalized = normalizeTmuxError(error);
      if (normalized.code === "TMUX_SESSION_NOT_FOUND") return false;
      throw normalized;
    }
  }

  private async listTmuxSessions(format: string): Promise<string[]> {
    try {
      const result = await this.runReadCommand(["list-sessions", "-F", format], 10_000);
      return result.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  private async setTmuxOption(target: string, name: string, value: string): Promise<void> {
    await this.runMutationCommand(["set-option", "-t", target, name, value], 5_000);
  }

  private async getTmuxOption(target: string, name: string): Promise<string> {
    const result = await this.runReadCommand(["show-options", "-v", "-t", target, name], 5_000);
    return result.stdout.trim();
  }

  private async killTmuxSession(target: string): Promise<void> {
    if (!await this.hasTmuxSession(target)) return;
    await this.runMutationCommand(["kill-session", "-t", target], 10_000);
  }

  /**
   * Resolves the configured Claude binary to an absolute path with the same
   * environment the availability check uses, so the fresh tmux shell cannot
   * disagree with ForgeDeck about which executable runs.
   */
  private claudeExecutable(): Promise<string> {
    this.resolvedClaudeBin ||= resolveClaudeBin(this.claudeBin, undefined, this.environment).catch(() => this.claudeBin);
    return this.resolvedClaudeBin;
  }

  private runReadCommand(args: string[], timeoutMs: number): Promise<CommandResult> {
    return this.runCommandWithScheduler(this.readScheduler, args, timeoutMs);
  }

  private runMutationCommand(args: string[], timeoutMs: number): Promise<CommandResult> {
    return this.runCommandWithScheduler(this.mutationScheduler, args, timeoutMs);
  }

  private runCommandWithScheduler(scheduler: OperationScheduler | undefined, args: string[], timeoutMs: number): Promise<CommandResult> {
    const scoped = this.operationScope.getStore() || {};
    if (!scheduler) return this.run("tmux", args, timeoutMs, scoped.signal);
    const options: OperationOptions = {
      ...scoped,
      priority: scoped.priority || "background",
      fairnessKey: scoped.fairnessKey || "claude-bridge",
      deadline: scoped.deadline ?? Date.now() + timeoutMs
    };
    return scheduler.run(
      (context) => this.run("tmux", args, commandTimeout(context, timeoutMs), context.signal),
      options
    );
  }
}

/** Parses the human-readable plan block nested in Claude Code's JSON result envelope. */
export function parseClaudeUsageOutput(output: string, observedAt = Date.now()): ClaudePlanUsage | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(output);
  } catch (error) {
    throw new Error("Claude usage output was not valid JSON", { cause: error });
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("Claude usage output did not contain a result envelope");
  }
  const record = envelope as Record<string, unknown>;
  if (record.is_error === true) throw new Error("Claude usage command failed");
  if (typeof record.result !== "string") throw new Error("Claude usage output did not contain result text");
  const match = /^Current session:\s*(\d+(?:\.\d+)?)%\s*used\b/im.exec(record.result);
  if (!match) return null;
  const usedPercent = Number(match[1]);
  if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) {
    throw new Error("Claude usage percentage was outside the expected range");
  }
  return { usedPercent, observedAt };
}

function runCommand(
  file: string,
  args: string[],
  timeoutMs = 10_000,
  signal?: AbortSignal,
  environment: Readonly<NodeJS.ProcessEnv> = {}
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      signal,
      env: { ...environment }
    }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(new Error(stderr.trim() || error.message), { cause: error }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function resolveClaudeBin(
  bin: string,
  signal: AbortSignal | undefined,
  environment: Readonly<NodeJS.ProcessEnv>
): Promise<string> {
  try {
    const result = await runCommand(
      "/bin/sh",
      ["-c", "command -v \"$1\"", "sh", bin],
      5_000,
      signal,
      environment
    );
    const resolved = result.stdout.trim().split(/\r?\n/, 1)[0];
    if (resolved) return resolved;
  } catch {
    // Fall through to the explicit per-user location when PATH lookup is unavailable.
  }

  if (path.basename(bin) === bin) {
    const localBin = path.join(os.homedir(), ".local", "bin", bin);
    try {
      await access(localBin, fsConstants.X_OK);
      return localBin;
    } catch {
      // Preserve the configured value so the caller reports availability as false.
    }
  }
  return bin;
}

function commandTimeout(context: OperationContext, requestedMs: number): number {
  return Math.max(1, Math.min(requestedMs, Math.floor(context.remainingMs())));
}

function sessionName(threadId: string): string {
  return `${CLAUDE_SESSION_PREFIX}${threadId}`;
}

function validateThreadId(threadId: string): void {
  if (!THREAD_ID_PATTERN.test(threadId)) throw new Error("Invalid Claude thread id");
}

/**
 * Claude Code requires --session-id/--resume values to be UUIDs, while
 * ForgeDeck thread ids are free-form slugs. Non-UUID thread ids map to a
 * stable UUID derived from the thread id so every path (first turn, resume,
 * recovery after restart) recomputes the same identity.
 */
function deriveClaudeSessionId(threadId: string): string {
  if (UUID_PATTERN.test(threadId)) return threadId.toLowerCase();
  const hash = createHash("sha256").update(`forgedeck-claude-session:${threadId}`).digest("hex");
  const variant = ((Number.parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function isClaudeEffort(value: string): value is (typeof CLAUDE_EFFORT_LEVELS)[number] {
  return (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(value);
}

function isClaudePermissionMode(value: string): value is (typeof CLAUDE_PERMISSION_MODES)[number] {
  return (CLAUDE_PERMISSION_MODES as readonly string[]).includes(value);
}

function validateEffort(effort: string | undefined): void {
  if (effort !== undefined && !isClaudeEffort(effort)) {
    throw new Error(`Claude effort must be one of: ${CLAUDE_EFFORT_LEVELS.join(", ")}`);
  }
}

function validatePermissionMode(permissionMode: string | undefined): void {
  if (permissionMode !== undefined && !isClaudePermissionMode(permissionMode)) {
    throw new Error(`Claude permission mode must be one of: ${CLAUDE_PERMISSION_MODES.join(", ")}`);
  }
}

/**
 * Returns the captured output belonging to the turn that printed the given
 * completion marker: the lines between the previous marker (or the start of
 * the capture) and this marker's own line.
 */
function turnOutputSegment(text: string, marker: string): string {
  const lines = text.split(/\r?\n/);
  const ownMarker = new RegExp(`^${escapeRegExp(marker)}:-?\\d+$`);
  const anyMarker = new RegExp(`^${escapeRegExp(CLAUDE_COMPLETION_MARKER_PREFIX)}[a-f0-9]{32}:-?\\d+$`, "i");
  let end = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    if (ownMarker.test(lines[index].trim())) {
      end = index;
      break;
    }
  }
  let start = 0;
  for (let index = end - 1; index >= 0; index -= 1) {
    if (anyMarker.test(lines[index].trim())) {
      start = index + 1;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function normalizeMaxTurns(value: number | undefined): number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 100 ? Number(value) : DEFAULT_MAX_TURNS;
}

function shellJoin(values: string[]): string {
  return values.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function stripAnsi(value: string): string {
  return value.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "");
}

function parseCompletionExitCode(text: string, marker: string): number | null {
  for (const line of text.split(/\r?\n/)) {
    const match = new RegExp(`^${escapeRegExp(marker)}:(-?\\d+)$`).exec(line.trim());
    if (match) return Number(match[1]);
  }
  return null;
}

function parseTurnState(value: string): ClaudeTurnState | null {
  const normalized = value.trim();
  return normalized === "accepted"
    || normalized === "running"
    || normalized === "interrupting"
    || normalized === "completed"
    || normalized === "failed"
    ? normalized
    : null;
}

function isTerminalTurnState(value: ClaudeTurnState | null): value is "completed" | "failed" {
  return value === "completed" || value === "failed";
}

function canTransitionTurn(from: ClaudeTurnState, to: ClaudeTurnState): boolean {
  if (from === "accepted") return to === "running" || to === "interrupting" || isTerminalTurnState(to);
  if (from === "running") return to === "interrupting" || isTerminalTurnState(to);
  if (from === "interrupting") return isTerminalTurnState(to);
  return false;
}

function isCompletionMarker(value: string): boolean {
  return new RegExp(`^${escapeRegExp(CLAUDE_COMPLETION_MARKER_PREFIX)}[a-f0-9]{32}$`, "i").test(value.trim());
}

function stripCompletionMarkers(text: string): string {
  const pattern = new RegExp(`^\\s*${escapeRegExp(CLAUDE_COMPLETION_MARKER_PREFIX)}[a-f0-9]{32}:-?\\d+\\s*$`, "gim");
  return text.replace(pattern, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTmuxError(cause: unknown): ClaudeBridgeError {
  if (cause instanceof ClaudeBridgeError) return cause;
  const error = cause instanceof Error ? cause : new Error(String(cause));
  const details = `${error.message} ${error.cause instanceof Error ? error.cause.message : ""}`.toLowerCase();
  const code = (error.cause instanceof Error ? (error.cause as NodeJS.ErrnoException).code : undefined)
    ?? (error as NodeJS.ErrnoException).code;
  // "no server running" is a definite absence: tmux sessions only exist inside
  // a live server, so the first session on a fresh boot must see "not found"
  // rather than an indeterminate unavailability that blocks creation forever.
  if (details.trim() === "missing" || /can't find session|no such session|session not found|no server running/.test(details)) {
    return new ClaudeBridgeError(error.message, "TMUX_SESSION_NOT_FOUND", false, { cause: error });
  }
  if (code === "ETIMEDOUT" || /timed out|timeout/.test(details)) {
    return new ClaudeBridgeError(error.message, "TMUX_TIMEOUT", true, { cause: error });
  }
  if (code === "ENOENT" || code === "EACCES" || /failed to connect|connection refused/.test(details)) {
    return new ClaudeBridgeError(error.message, "TMUX_UNAVAILABLE", true, { cause: error });
  }
  return new ClaudeBridgeError(error.message, "TMUX_COMMAND_FAILED", true, { cause: error });
}

function parseClaudeSessionId(text: string): string | null {
  for (const line of text.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { session_id?: unknown };
      if (typeof parsed.session_id === "string" && UUID_PATTERN.test(parsed.session_id)) {
        return parsed.session_id.toLowerCase();
      }
    } catch {
      // Wrapped terminal output may not contain one complete JSON object per line.
    }
  }
  const match = /["']session_id["']\s*:\s*["']([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})["']/.exec(text);
  return match?.[1]?.toLowerCase() || null;
}
