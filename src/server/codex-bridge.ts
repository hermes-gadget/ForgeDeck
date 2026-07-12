import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";

type RpcId = string | number;
type RpcMessage = {
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type ServerRequest = { id: RpcId; method: string; params: unknown; receivedAt: number };

export class CodexBridge extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<RpcId, PendingCall>();
  private serverRequests = new Map<string, ServerRequest>();
  private startPromise: Promise<void> | null = null;
  private stopping = false;

  async start(): Promise<void> {
    if (this.child && !this.child.killed) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.launch();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async launch(): Promise<void> {
    const codexBin = process.env.CODEX_BIN || "codex";
    const child = spawn(codexBin, ["app-server", "--stdio"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.stdin.on("error", (error) => this.emit("error", error));
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) console.error(`[codex] ${text}`);
    });
    child.on("error", (error) => this.emit("error", error));
    child.on("exit", (code, signal) => this.handleExit(code, signal));

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => { cleanup(); resolve(); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const cleanup = () => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });

    await this.callRaw("initialize", {
      clientInfo: { name: "forgedeck", title: "ForgeDeck", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false }
    });
    this.write({ method: "initialized" });
    this.emit("ready");
  }

  async request<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    await this.start();
    return this.callRaw(method, params, timeoutMs) as Promise<T>;
  }

  listServerRequests(): ServerRequest[] {
    return [...this.serverRequests.values()];
  }

  respondToServerRequest(id: RpcId, result: unknown): void {
    const key = String(id);
    if (!this.serverRequests.has(key)) throw new Error("That request is no longer pending");
    this.write({ id, result });
    this.serverRequests.delete(key);
    this.emit("serverRequestResolved", { id });
  }

  stop(): void {
    this.stopping = true;
    this.child?.kill("SIGTERM");
  }

  private callRaw(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const message: RpcMessage = { id, method };
      if (params !== undefined) message.params = params;
      try {
        this.write(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private write(message: RpcMessage): void {
    if (!this.child?.stdin.writable) throw new Error("Codex app-server is not available");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      console.error("[codex] Ignoring malformed protocol message");
      return;
    }

    if (message.id !== undefined && ("result" in message || "error" in message) && !message.method) {
      const call = this.pending.get(message.id);
      if (!call) return;
      clearTimeout(call.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message || "Codex request failed");
        Object.assign(error, { code: message.error.code, data: message.error.data });
        call.reject(error);
      } else {
        call.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      const request: ServerRequest = {
        id: message.id,
        method: message.method,
        params: message.params,
        receivedAt: Date.now()
      };
      this.serverRequests.set(String(message.id), request);
      this.emit("serverRequest", request);
      return;
    }

    if (message.method) this.emit("notification", { method: message.method, params: message.params });
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.child = null;
    const error = new Error(`Codex app-server exited (${signal || code || "unknown"})`);
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
    this.serverRequests.clear();
    this.emit("offline", { code, signal });
    if (!this.stopping) setTimeout(() => void this.start().catch((err) => this.emit("error", err)), 1500).unref();
  }
}
