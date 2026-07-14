import { execFile, execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const CLAUDE_SESSION_PREFIX = "claude-";
const THREAD_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;
const DEFAULT_MAX_TURNS = 15;
const STALE_SESSION_SECONDS = 24 * 60 * 60;
const resolvedClaudeBins = new Map<string, string>();

type CommandResult = { stdout: string; stderr: string };
type CommandRunner = (file: string, args: string[], timeoutMs?: number) => Promise<CommandResult>;

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

/** Manages opt-in Claude Code print sessions inside durable tmux shells. */
export class ClaudeBridge {
  private readonly sessions = new Map<string, ClaudeProcessSession>();

  constructor(
    private readonly claudeBin = process.env.FORGEDECK_CLAUDE_BIN?.trim() || "claude",
    private readonly run: CommandRunner = runCommand
  ) {}

  async start(params: ClaudeStartParams): Promise<{ ok: boolean }> {
    validateThreadId(params.threadId);
    const maxTurns = normalizeMaxTurns(params.maxTurns);
    const target = sessionName(params.threadId);
    if (await this.hasTmuxSession(target)) throw new Error(`Claude session ${params.threadId} already exists`);

    await this.run("tmux", ["new-session", "-d", "-s", target, "-c", params.cwd], 10_000);
    const session: ClaudeProcessSession = {
      threadId: params.threadId,
      model: params.model,
      effort: params.effort,
      permissionMode: params.permissionMode,
      maxTurns,
      claudeSessionId: params.threadId,
      hasConversation: false
    };
    this.sessions.set(params.threadId, session);
    try {
      await Promise.all([
        this.setTmuxOption(target, "@forgedeck_claude_active", "0"),
        this.setTmuxOption(target, "@forgedeck_created_at", String(Math.floor(Date.now() / 1_000))),
        this.setTmuxOption(target, "@forgedeck_claude_model", params.model || ""),
        this.setTmuxOption(target, "@forgedeck_claude_effort", params.effort || ""),
        this.setTmuxOption(target, "@forgedeck_claude_permission_mode", params.permissionMode || ""),
        this.setTmuxOption(target, "@forgedeck_claude_max_turns", String(maxTurns))
      ]);
      if (params.prompt?.trim()) {
        await this.sendPrintCommand(session, params.prompt.trim(), false);
      }
      return { ok: true };
    } catch (error) {
      this.sessions.delete(params.threadId);
      await this.killTmuxSession(target).catch(() => undefined);
      throw error;
    }
  }

  async sendMessage(threadId: string, text: string): Promise<void> {
    validateThreadId(threadId);
    const message = text.trim();
    if (!message) throw new Error("Claude message cannot be empty");
    const session = await this.sessionFor(threadId);
    if ((await this.status(threadId)).active) throw new Error("This Claude session already has an active turn");
    await this.sendPrintCommand(session, message, session.hasConversation);
  }

  async stop(threadId: string): Promise<void> {
    validateThreadId(threadId);
    const target = sessionName(threadId);
    if (!await this.hasTmuxSession(target)) return;
    await this.run("tmux", ["send-keys", "-t", target, "C-c"], 10_000);
    await this.setTmuxOption(target, "@forgedeck_claude_active", "0").catch(() => undefined);
  }

  async status(threadId: string): Promise<{ active: boolean; text: string }> {
    validateThreadId(threadId);
    const target = sessionName(threadId);
    if (!await this.hasTmuxSession(target)) return { active: false, text: "" };
    const [activeValue, captured] = await Promise.all([
      this.getTmuxOption(target, "@forgedeck_claude_active").catch(() => "0"),
      this.run("tmux", ["capture-pane", "-t", target, "-p", "-S", "-200"], 10_000)
    ]);
    const text = stripAnsi(captured.stdout).trimEnd();
    const parsedSessionId = parseClaudeSessionId(text);
    const session = this.sessions.get(threadId);
    if (session && parsedSessionId) {
      session.claudeSessionId = parsedSessionId;
      session.hasConversation = true;
    }
    return { active: activeValue.trim() === "1", text };
  }

  async exists(threadId: string): Promise<boolean> {
    validateThreadId(threadId);
    return this.hasTmuxSession(sessionName(threadId));
  }

  async setPermissionMode(threadId: string, permissionMode: string): Promise<void> {
    const session = await this.sessionFor(threadId);
    session.permissionMode = permissionMode;
    await this.setTmuxOption(sessionName(threadId), "@forgedeck_claude_permission_mode", permissionMode);
  }

  async setEffort(threadId: string, effort: string): Promise<void> {
    const session = await this.sessionFor(threadId);
    session.effort = effort;
    await this.setTmuxOption(sessionName(threadId), "@forgedeck_claude_effort", effort);
  }

  async archive(threadId: string): Promise<void> {
    validateThreadId(threadId);
    this.sessions.delete(threadId);
    await this.killTmuxSession(sessionName(threadId));
  }

  async recoverOrphans(): Promise<string[]> {
    const result = await this.listTmuxSessions("#{session_name}");
    const recovered: string[] = [];
    for (const name of result) {
      if (!name.startsWith(CLAUDE_SESSION_PREFIX)) continue;
      const threadId = name.slice(CLAUDE_SESSION_PREFIX.length);
      if (!THREAD_ID_PATTERN.test(threadId)) continue;
      const [model, effort, permissionMode, maxTurns] = await Promise.all([
        this.getTmuxOption(name, "@forgedeck_claude_model").catch(() => ""),
        this.getTmuxOption(name, "@forgedeck_claude_effort").catch(() => ""),
        this.getTmuxOption(name, "@forgedeck_claude_permission_mode").catch(() => ""),
        this.getTmuxOption(name, "@forgedeck_claude_max_turns").catch(() => String(DEFAULT_MAX_TURNS))
      ]);
      this.sessions.set(threadId, {
        threadId,
        model: model || undefined,
        effort: effort || undefined,
        permissionMode: permissionMode || undefined,
        maxTurns: normalizeMaxTurns(Number(maxTurns)),
        claudeSessionId: threadId,
        hasConversation: true
      });
      recovered.push(threadId);
    }
    return recovered;
  }

  static async checkAvailable(): Promise<boolean> {
    const configuredBin = process.env.FORGEDECK_CLAUDE_BIN?.trim() || "claude";
    const bin = resolveClaudeBin(configuredBin);
    try {
      await runCommand(bin, ["--version"], 8_000);
      let status: CommandResult;
      try {
        status = await runCommand(bin, ["auth", "status", "--text"], 10_000);
      } catch {
        status = await runCommand(bin, ["auth", "status"], 10_000);
      }
      const output = `${status.stdout}\n${status.stderr}`.toLowerCase();
      return !/(not logged in|not authenticated|authentication required|loggedin["']?\s*:\s*false)/.test(output);
    } catch {
      return false;
    }
  }

  cleanStaleSessions(): void {
    void this.cleanStaleSessionsNow();
  }

  private async cleanStaleSessionsNow(): Promise<void> {
    const now = Math.floor(Date.now() / 1_000);
    const entries = await this.listTmuxSessions("#{session_name}\t#{session_created}");
    await Promise.all(entries.map(async (entry) => {
      const [name, createdValue] = entry.split("\t");
      const createdAt = Number(createdValue);
      if (!name.startsWith(CLAUDE_SESSION_PREFIX) || !Number.isFinite(createdAt) || now - createdAt <= STALE_SESSION_SECONDS) return;
      const active = await this.getTmuxOption(name, "@forgedeck_claude_active").catch(() => "0");
      if (active.trim() === "1") return;
      const threadId = name.slice(CLAUDE_SESSION_PREFIX.length);
      this.sessions.delete(threadId);
      await this.killTmuxSession(name);
    }));
  }

  private async sessionFor(threadId: string): Promise<ClaudeProcessSession> {
    const existing = this.sessions.get(threadId);
    if (existing) return existing;
    const target = sessionName(threadId);
    if (!await this.hasTmuxSession(target)) throw new Error("Claude session not found");
    const recovered: ClaudeProcessSession = {
      threadId,
      maxTurns: DEFAULT_MAX_TURNS,
      claudeSessionId: threadId,
      hasConversation: true
    };
    this.sessions.set(threadId, recovered);
    return recovered;
  }

  private async sendPrintCommand(session: ClaudeProcessSession, prompt: string, resume: boolean): Promise<void> {
    const target = sessionName(session.threadId);
    if (!await this.hasTmuxSession(target)) throw new Error("Claude session not found");
    const args = ["-p", prompt, "--output-format", "json", "--max-turns", String(session.maxTurns)];
    if (resume) args.push("--resume", session.claudeSessionId);
    else args.push("--session-id", session.threadId);
    if (session.model) args.push("--model", session.model);
    if (session.effort) args.push("--effort", session.effort);
    if (session.permissionMode && session.permissionMode !== "default") args.push("--permission-mode", session.permissionMode);
    const command = `${shellJoin([this.claudeBin, ...args])}; tmux set-option -t ${shellQuote(target)} @forgedeck_claude_active 0`;
    await this.setTmuxOption(target, "@forgedeck_claude_active", "1");
    await this.run("tmux", ["send-keys", "-t", target, "-l", "--", command], 10_000);
    await this.run("tmux", ["send-keys", "-t", target, "Enter"], 10_000);
    session.hasConversation = true;
  }

  private async hasTmuxSession(target: string): Promise<boolean> {
    try {
      await this.run("tmux", ["has-session", "-t", target], 5_000);
      return true;
    } catch {
      return false;
    }
  }

  private async listTmuxSessions(format: string): Promise<string[]> {
    try {
      const result = await this.run("tmux", ["list-sessions", "-F", format], 10_000);
      return result.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  private async setTmuxOption(target: string, name: string, value: string): Promise<void> {
    await this.run("tmux", ["set-option", "-t", target, name, value], 5_000);
  }

  private async getTmuxOption(target: string, name: string): Promise<string> {
    const result = await this.run("tmux", ["show-options", "-v", "-t", target, name], 5_000);
    return result.stdout.trim();
  }

  private async killTmuxSession(target: string): Promise<void> {
    if (!await this.hasTmuxSession(target)) return;
    await this.run("tmux", ["kill-session", "-t", target], 10_000);
  }
}

function runCommand(file: string, args: string[], timeoutMs = 10_000): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(new Error(stderr.trim() || error.message), { cause: error }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function resolveClaudeBin(bin: string): string {
  const cached = resolvedClaudeBins.get(bin);
  if (cached) return cached;
  try {
    const searchPath = [process.env.PATH, path.join(os.homedir(), ".local", "bin")].filter(Boolean).join(path.delimiter);
    const resolved = execSync(`command -v ${shellQuote(bin)}`, {
      encoding: "utf8",
      env: { ...process.env, PATH: searchPath }
    }).trim();
    if (resolved) resolvedClaudeBins.set(bin, resolved);
    return resolved || bin;
  } catch {
    return bin;
  }
}

function sessionName(threadId: string): string {
  return `${CLAUDE_SESSION_PREFIX}${threadId}`;
}

function validateThreadId(threadId: string): void {
  if (!THREAD_ID_PATTERN.test(threadId)) throw new Error("Invalid Claude thread id");
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
  return value.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "");
}

function parseClaudeSessionId(text: string): string | null {
  for (const line of text.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { session_id?: unknown };
      if (typeof parsed.session_id === "string" && THREAD_ID_PATTERN.test(parsed.session_id)) return parsed.session_id;
    } catch {
      // Wrapped terminal output may not contain one complete JSON object per line.
    }
  }
  const match = /["']session_id["']\s*:\s*["']([a-zA-Z0-9_-]{8,128})["']/.exec(text);
  return match?.[1] || null;
}
