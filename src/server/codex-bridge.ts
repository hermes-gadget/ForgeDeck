import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import readline, { type Interface as ReadlineInterface } from "node:readline";
import WebSocket, { type RawData } from "ws";
import { logger, redactSensitive } from "./logger.js";

export type RpcId = string | number;

export interface RpcErrorPayload {
  code?: number;
  message?: string;
  data?: unknown;
}

export interface RpcMessage {
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: RpcErrorPayload;
}

export interface CodexNotification {
  method: string;
  params?: Record<string, unknown>;
}

export interface ServerRequest {
  id: RpcId;
  method: string;
  params: unknown;
  receivedAt: number;
}

export type BridgeConnectionState = "offline" | "connecting" | "ready" | "stopping" | "stopped";

export interface BridgeSession {
  threadId: string;
  turnId: string | null;
  state: "running" | "completed" | "interrupted";
  startedAt: number;
  lastActivityAt: number;
  completedAt: number | null;
}

export interface BridgeMetrics {
  connectionState: BridgeConnectionState;
  uptimeMs: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  timedOutRequests: number;
  retryAttempts: number;
  reconnectAttempts: number;
  averageResponseTimeMs: number;
  successRate: number;
  queueDepth: number;
  pendingRpcCalls: number;
  bufferedOutputBytes: number;
  activeSessions: number;
  lastHeartbeatAt: number | null;
}

export interface BridgeStatus {
  state: BridgeConnectionState;
  available: boolean;
  generation: number;
  lastConnectedAt: number | null;
  lastHeartbeatAt: number | null;
  lastError: string | null;
  metrics: BridgeMetrics;
}

export interface BridgeOfflineEvent {
  code: number | null;
  signal: NodeJS.Signals | null;
  reason: string;
  willRetry: boolean;
}

export interface BridgeReadyEvent {
  generation: number;
  recoveredSessions: number;
}

export interface CodexBridgeOptions {
  requestRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  sessionIdleGraceMs?: number;
  sessionStaleMs?: number;
  sessionRecoveryTimeoutMs?: number;
  serverRequestTtlMs?: number;
  completedSessionTtlMs?: number;
  maxTrackedSessions?: number;
  streamFlushIntervalMs?: number;
  maxBufferedOutputBytes?: number;
  maxOutboundBufferBytes?: number;
  shutdownGraceMs?: number;
  isRetryableMethod?: (method: string) => boolean;
}

export interface CodexBridgeEventMap {
  ready: [event: BridgeReadyEvent];
  offline: [event: BridgeOfflineEvent];
  error: [error: Error];
  notification: [notification: CodexNotification];
  serverRequest: [request: ServerRequest];
  serverRequestResolved: [event: { id: RpcId; reason?: string }];
  metrics: [metrics: BridgeMetrics];
}

export class CodexBridgeError extends Error {
  constructor(
    message: string,
    readonly code: string | number,
    readonly transient: boolean,
    readonly dispatched: boolean,
    readonly data?: unknown
  ) {
    super(message);
    this.name = "CodexBridgeError";
  }
}

export class CodexRpcError extends CodexBridgeError {
  constructor(message: string, code: number | string = "RPC_ERROR", data?: unknown, transient = false) {
    super(message, code, transient, true, data);
    this.name = "CodexRpcError";
  }
}

export class CodexUnavailableError extends CodexBridgeError {
  constructor(message: string, code: number | string = "OFFLINE", transient = true, dispatched = false) {
    super(message, code, transient, dispatched);
    this.name = "CodexUnavailableError";
  }
}

type PendingCall = {
  id: RpcId;
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  generation: number;
  dispatched: boolean;
};

type TrackedServerRequest = ServerRequest & { expiresAt: number };
type RunningSession = BridgeSession & { state: "running"; probeFailures: number; disconnectedAt: number | null };
type OutboundMessage = { payload: string; id?: RpcId; bytes: number };
type BufferedNotification = { notification: CodexNotification; bytes: number };

type ChildTransport = {
  kind: "child";
  generation: number;
  child: ChildProcessWithoutNullStreams;
  lines: ReadlineInterface;
  closed: boolean;
  connectReject: ((error: Error) => void) | null;
};

type SocketTransport = {
  kind: "socket";
  generation: number;
  socket: WebSocket;
  closed: boolean;
  awaitingPongSince: number | null;
  connectReject: ((error: Error) => void) | null;
};

type Transport = ChildTransport | SocketTransport;

type ThreadReadResult = {
  thread?: {
    status?: { type?: string };
    turns?: Array<{ id?: string; status?: string }>;
  };
};

const OUTPUT_DELTA_METHODS = new Set([
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "command/exec/outputDelta"
]);

const DEFAULT_OPTIONS: Required<Omit<CodexBridgeOptions, "isRetryableMethod">> = {
  requestRetries: 2,
  retryBaseDelayMs: 200,
  retryMaxDelayMs: 2_000,
  reconnectBaseDelayMs: 750,
  reconnectMaxDelayMs: 30_000,
  heartbeatIntervalMs: 15_000,
  heartbeatTimeoutMs: 8_000,
  sessionIdleGraceMs: 250,
  sessionStaleMs: 60_000,
  sessionRecoveryTimeoutMs: 90_000,
  serverRequestTtlMs: 30 * 60_000,
  completedSessionTtlMs: 5 * 60_000,
  maxTrackedSessions: 512,
  streamFlushIntervalMs: 16,
  maxBufferedOutputBytes: 512 * 1024,
  maxOutboundBufferBytes: 4 * 1024 * 1024,
  shutdownGraceMs: 2_000
};

const SAFE_RETRY_METHODS = [
  /\/(?:list|read|get)$/,
  /^account\/(?:read|rateLimits\/read)$/,
  /^model\/list$/,
  /^thread\/resume$/,
  /^thread\/name\/set$/,
  /^thread\/settings\/update$/,
  /^thread\/goal\/(?:set|clear|get)$/,
  /^turn\/interrupt$/
];

/**
 * Owns one Codex app-server transport and preserves logical session state while
 * that transport is being recovered. The class deliberately retries only
 * idempotent operations after they may have reached Codex.
 */
export class CodexBridge extends EventEmitter {
  private readonly options: Required<Omit<CodexBridgeOptions, "isRetryableMethod">> & Pick<CodexBridgeOptions, "isRetryableMethod">;
  private readonly startedAt = Date.now();
  private transport: Transport | null = null;
  private connectionState: BridgeConnectionState = "offline";
  private generation = 0;
  private nextId = 1;
  private readonly pending = new Map<RpcId, PendingCall>();
  private readonly serverRequests = new Map<string, TrackedServerRequest>();
  private readonly activeSessions = new Map<string, RunningSession>();
  private readonly recentCompletions = new Map<string, number>();
  private readonly completionTimers = new Map<string, NodeJS.Timeout>();
  private readonly sessionProbes = new Set<string>();
  private readonly outputBuffers = new Map<string, BufferedNotification>();
  private outputBufferBytes = 0;
  private outputFlushTimer: NodeJS.Timeout | null = null;
  private readonly outboundQueue: OutboundMessage[] = [];
  private outboundQueueBytes = 0;
  private outboundBlocked = false;
  private outboundFlushTimer: NodeJS.Timeout | null = null;
  private startPromise: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatInFlight = false;
  private sessionRecoveryTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private logicalQueueDepth = 0;
  private totalRequests = 0;
  private successfulRequests = 0;
  private failedRequests = 0;
  private timedOutRequests = 0;
  private retryAttempts = 0;
  private reconnectAttempts = 0;
  private totalResponseTimeMs = 0;
  private lastHeartbeatAt: number | null = null;
  private lastConnectedAt: number | null = null;
  private lastError: string | null = null;

  constructor(options: CodexBridgeOptions = {}) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async start(): Promise<void> {
    if (this.stopping) throw new CodexBridgeError("Codex bridge has been stopped", "STOPPED", false, false);
    if (this.startPromise) return this.startPromise;
    if (this.connectionState === "ready" && this.transport) return;

    this.clearReconnectTimer();
    this.connectionState = "connecting";
    const startPromise = this.launch();
    this.startPromise = startPromise;
    this.emitMetrics();
    try {
      await startPromise;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = null;
    }
  }

  async request<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    if (!method.trim()) throw new TypeError("Codex RPC method is required");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("Codex request timeout must be positive");

    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    this.totalRequests += 1;
    this.logicalQueueDepth += 1;
    let attempt = 0;

    try {
      while (true) {
        try {
          try {
            await this.start();
          } catch (cause) {
            const connectionError = this.normalizeRequestError(cause);
            throw new CodexUnavailableError(connectionError.message, connectionError.code, connectionError.transient, false);
          }
          const remainingMs = Math.max(1, deadline - Date.now());
          const result = await this.callRaw(method, params, remainingMs);
          this.successfulRequests += 1;
          return result as T;
        } catch (cause) {
          const error = this.normalizeRequestError(cause);
          if (!this.shouldRetry(method, error, attempt, deadline)) {
            this.failedRequests += 1;
            if (error.code === "TIMEOUT") this.timedOutRequests += 1;
            throw error;
          }

          const delayMs = this.backoff(attempt, this.options.retryBaseDelayMs, this.options.retryMaxDelayMs);
          attempt += 1;
          this.retryAttempts += 1;
          if (Date.now() + delayMs >= deadline) {
            this.failedRequests += 1;
            if (error.code === "TIMEOUT") this.timedOutRequests += 1;
            throw error;
          }
          await delay(delayMs);
        }
      }
    } finally {
      this.logicalQueueDepth = Math.max(0, this.logicalQueueDepth - 1);
      this.totalResponseTimeMs += Date.now() - startedAt;
      this.emitMetrics();
    }
  }

  listServerRequests(): ServerRequest[] {
    this.expireServerRequests();
    return [...this.serverRequests.values()].map(({ expiresAt: _expiresAt, ...request }) => request);
  }

  listSessions(): BridgeSession[] {
    return [...this.activeSessions.values()].map(({ probeFailures: _probeFailures, disconnectedAt: _disconnectedAt, ...session }) => session);
  }

  getMetrics(): BridgeMetrics {
    const completedRequests = this.successfulRequests + this.failedRequests;
    return {
      connectionState: this.connectionState,
      uptimeMs: Date.now() - this.startedAt,
      totalRequests: this.totalRequests,
      successfulRequests: this.successfulRequests,
      failedRequests: this.failedRequests,
      timedOutRequests: this.timedOutRequests,
      retryAttempts: this.retryAttempts,
      reconnectAttempts: this.reconnectAttempts,
      averageResponseTimeMs: completedRequests ? Math.round((this.totalResponseTimeMs / completedRequests) * 100) / 100 : 0,
      successRate: completedRequests ? Math.round((this.successfulRequests / completedRequests) * 10_000) / 10_000 : 0,
      queueDepth: this.logicalQueueDepth,
      pendingRpcCalls: this.pending.size,
      bufferedOutputBytes: this.outputBufferBytes + this.outboundQueueBytes,
      activeSessions: this.activeSessions.size,
      lastHeartbeatAt: this.lastHeartbeatAt
    };
  }

  getStatus(): BridgeStatus {
    return {
      state: this.connectionState,
      available: this.connectionState === "ready" && this.transport !== null,
      generation: this.generation,
      lastConnectedAt: this.lastConnectedAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastError: this.lastError,
      metrics: this.getMetrics()
    };
  }

  respondToServerRequest(id: RpcId, result: unknown): void {
    const key = String(id);
    if (!this.serverRequests.has(key)) throw new Error("That request is no longer pending");
    this.write({ id, result });
    this.serverRequests.delete(key);
    this.emit("serverRequestResolved", { id });
  }

  dismissServerRequestsForThread(threadId: string): number {
    let dismissed = 0;
    for (const [key, request] of this.serverRequests) {
      const params = request.params && typeof request.params === "object" ? request.params as Record<string, unknown> : null;
      if (params?.threadId !== threadId && params?.thread_id !== threadId) continue;
      try {
        this.write({ id: request.id, error: { code: -32800, message: "Session was archived" } });
      } catch {
        // Removing the local request is still correct while the transport is offline.
      }
      this.serverRequests.delete(key);
      this.emit("serverRequestResolved", { id: request.id, reason: "session_archived" });
      dismissed += 1;
    }
    return dismissed;
  }

  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.connectionState = "stopping";
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    this.clearSessionRecoveryTimer();
    this.clearOutputBuffers(false);
    this.clearCompletionTimers();

    const error = new CodexBridgeError("Codex bridge stopped", "STOPPED", false, false);
    this.rejectPending(error);
    this.resolveServerRequests("bridge_stopped");
    this.activeSessions.clear();
    this.recentCompletions.clear();

    const transport = this.transport;
    if (transport) this.disposeTransport(transport, true, true);
    this.connectionState = "stopped";
    this.emitMetrics();
  }

  private async launch(): Promise<void> {
    const codexBin = process.env.CODEX_BIN || "codex";
    const serverUrl = process.env.CODEX_APP_SERVER_URL?.trim();
    let transport: Transport | null = null;

    try {
      transport = serverUrl ? await this.connectSocket(serverUrl) : await this.spawnChild(codexBin);
      this.assertCurrentTransport(transport);
      await this.callRaw("initialize", {
        clientInfo: { name: "forgedeck", title: "ForgeDeck", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false }
      }, 30_000);
      this.assertCurrentTransport(transport);
      this.write({ method: "initialized" });

      this.connectionState = "ready";
      this.reconnectAttempt = 0;
      this.lastHeartbeatAt = Date.now();
      this.lastConnectedAt = this.lastHeartbeatAt;
      this.lastError = null;
      this.clearSessionRecoveryTimer();
      this.startHeartbeat();
      const recoveredSessions = this.activeSessions.size;
      this.emit("ready", { generation: transport.generation, recoveredSessions });
      this.emitMetrics();
      if (recoveredSessions) void this.reconcileActiveSessions();
    } catch (cause) {
      const error = this.normalizeConnectionError(cause, false);
      this.lastError = error.message;
      if (transport && this.transport === transport) this.handleTransportFailure(transport, error);
      else if (!this.stopping) this.scheduleReconnect();
      this.reportError(error);
      throw error;
    }
  }

  private async spawnChild(codexBin: string): Promise<ChildTransport> {
    const generation = ++this.generation;
    const child = spawn(codexBin, ["app-server", "--stdio"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    const transport: ChildTransport = { kind: "child", generation, child, lines, closed: false, connectReject: null };
    this.transport = transport;

    lines.on("line", (line) => this.handlePayload(transport, line));
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = String(chunk).trim();
      if (text) logger.debug("Codex runtime stderr", { output: redactSensitive(text.slice(0, 8_000)) });
    });

    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        cleanup();
        transport.connectReject = null;
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        transport.connectReject = null;
        reject(error);
      };
      const cleanup = (): void => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
      transport.connectReject = onError;
    });

    this.assertCurrentTransport(transport);
    child.on("error", (error) => this.handleTransportFailure(transport, this.normalizeConnectionError(error, true)));
    child.on("exit", (code, signal) => {
      const error = new CodexBridgeError(
        `Codex app-server exited (${signal || code || "unknown"})`,
        "CONNECTION_CLOSED",
        true,
        true
      );
      this.handleTransportFailure(transport, error, code, signal);
    });
    child.stdin.on("error", (error) => this.handleTransportFailure(transport, this.normalizeConnectionError(error, true)));
    child.stdin.on("drain", () => {
      if (this.transport !== transport) return;
      this.outboundBlocked = false;
      this.flushOutboundQueue();
    });
    return transport;
  }

  private async connectSocket(serverUrl: string): Promise<SocketTransport> {
    const generation = ++this.generation;
    const socket = new WebSocket(serverUrl);
    const transport: SocketTransport = {
      kind: "socket",
      generation,
      socket,
      closed: false,
      awaitingPongSince: null,
      connectReject: null
    };
    this.transport = transport;
    socket.on("message", (data: RawData) => this.handlePayload(transport, String(data)));

    await new Promise<void>((resolve, reject) => {
      const onConnect = (): void => {
        cleanup();
        transport.connectReject = null;
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        transport.connectReject = null;
        reject(error);
      };
      const cleanup = (): void => {
        socket.off("open", onConnect);
        socket.off("error", onError);
      };
      socket.once("open", onConnect);
      socket.once("error", onError);
      transport.connectReject = onError;
    });

    this.assertCurrentTransport(transport);
    socket.on("pong", () => {
      if (this.transport !== transport) return;
      transport.awaitingPongSince = null;
      this.markHeartbeat();
    });
    socket.on("error", (error) => this.handleTransportFailure(transport, this.normalizeConnectionError(error, true)));
    socket.on("close", (code, reason) => {
      const suffix = reason.length ? `: ${String(reason)}` : "";
      this.handleTransportFailure(
        transport,
        new CodexBridgeError(`Codex app-server socket closed (${code})${suffix}`, "CONNECTION_CLOSED", true, true),
        code
      );
    });
    return transport;
  }

  private callRaw(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const transport = this.transport;
    if (!transport || transport.closed) {
      return Promise.reject(new CodexBridgeError("Codex app-server is not available", "OFFLINE", true, false));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const call = this.pending.get(id);
        if (!call) return;
        this.pending.delete(id);
        reject(new CodexBridgeError(`Codex request timed out: ${method}`, "TIMEOUT", true, call.dispatched));
      }, timeoutMs);
      timer.unref();
      const call: PendingCall = {
        id,
        method,
        resolve,
        reject,
        timer,
        generation: transport.generation,
        dispatched: false
      };
      this.pending.set(id, call);
      const message: RpcMessage = { id, method };
      if (params !== undefined) message.params = params;
      try {
        this.write(message);
      } catch (cause) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(this.normalizeConnectionError(cause, call.dispatched));
      }
    });
  }

  private write(message: RpcMessage): void {
    const transport = this.transport;
    if (!transport || transport.closed) throw new CodexBridgeError("Codex app-server is not available", "OFFLINE", true, false);
    const payload = `${JSON.stringify(message)}${transport.kind === "child" ? "\n" : ""}`;
    const bytes = Buffer.byteLength(payload);
    const outbound: OutboundMessage = { payload, id: message.id, bytes };

    if (this.outboundBlocked || this.outboundQueue.length) {
      this.enqueueOutbound(outbound);
      return;
    }
    this.sendOutbound(transport, outbound);
  }

  private enqueueOutbound(message: OutboundMessage): void {
    if (this.outboundQueueBytes + message.bytes > this.options.maxOutboundBufferBytes) {
      throw new CodexBridgeError("Codex output buffer is full", "BACKPRESSURE", true, false);
    }
    this.outboundQueue.push(message);
    this.outboundQueueBytes += message.bytes;
    if (this.transport?.kind === "socket") this.scheduleOutboundFlush();
  }

  private sendOutbound(transport: Transport, message: OutboundMessage): void {
    const pending = message.id === undefined ? undefined : this.pending.get(message.id);
    if (pending) pending.dispatched = true;

    if (transport.kind === "socket") {
      if (transport.socket.readyState !== WebSocket.OPEN) {
        if (pending) pending.dispatched = false;
        throw new CodexBridgeError("Codex app-server socket is not open", "OFFLINE", true, false);
      }
      transport.socket.send(message.payload, (error) => {
        if (error) this.handleTransportFailure(transport, this.normalizeConnectionError(error, true));
      });
      if (transport.socket.bufferedAmount >= this.options.maxOutboundBufferBytes / 2) {
        this.outboundBlocked = true;
        this.scheduleOutboundFlush();
      }
      return;
    }

    if (!transport.child.stdin.writable || transport.child.exitCode !== null) {
      if (pending) pending.dispatched = false;
      throw new CodexBridgeError("Codex app-server stdin is not writable", "OFFLINE", true, false);
    }
    this.outboundBlocked = !transport.child.stdin.write(message.payload, (error) => {
      if (error) this.handleTransportFailure(transport, this.normalizeConnectionError(error, true));
    });
  }

  private flushOutboundQueue(): void {
    const transport = this.transport;
    if (!transport || transport.closed) return;
    if (transport.kind === "socket" && transport.socket.bufferedAmount >= this.options.maxOutboundBufferBytes / 2) {
      this.outboundBlocked = true;
      this.scheduleOutboundFlush();
      return;
    }

    this.outboundBlocked = false;
    while (!this.outboundBlocked && this.outboundQueue.length) {
      const next = this.outboundQueue.shift()!;
      this.outboundQueueBytes -= next.bytes;
      try {
        this.sendOutbound(transport, next);
      } catch (cause) {
        const pending = next.id === undefined ? undefined : this.pending.get(next.id);
        if (pending) pending.dispatched = false;
        this.handleTransportFailure(transport, this.normalizeConnectionError(cause, false));
        return;
      }
    }
  }

  private scheduleOutboundFlush(): void {
    if (this.outboundFlushTimer) return;
    this.outboundFlushTimer = setTimeout(() => {
      this.outboundFlushTimer = null;
      this.flushOutboundQueue();
    }, 10);
    this.outboundFlushTimer.unref();
  }

  private handlePayload(transport: Transport, payload: string): void {
    if (this.transport !== transport || transport.closed) return;
    this.markHeartbeat();
    for (const line of payload.split(/\r?\n/)) {
      if (line.trim()) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      logger.warn("Ignoring malformed Codex protocol message");
      return;
    }

    if (message.id !== undefined && ("result" in message || "error" in message) && !message.method) {
      const call = this.pending.get(message.id);
      if (!call) return;
      clearTimeout(call.timer);
      this.pending.delete(message.id);
      if (message.error) {
        call.reject(new CodexRpcError(
          message.error.message || "Codex request failed",
          message.error.code ?? "RPC_ERROR",
          message.error.data,
          isTransientRpcError(message.error)
        ));
      } else {
        call.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      const request: TrackedServerRequest = {
        id: message.id,
        method: message.method,
        params: message.params,
        receivedAt: Date.now(),
        expiresAt: Date.now() + this.options.serverRequestTtlMs
      };
      this.serverRequests.set(String(message.id), request);
      const { expiresAt: _expiresAt, ...publicRequest } = request;
      this.emit("serverRequest", publicRequest);
      return;
    }

    if (message.method) {
      const params = isRecord(message.params) ? message.params : undefined;
      this.queueNotification({ method: message.method, ...(params ? { params } : {}) });
    }
  }

  private queueNotification(notification: CodexNotification): void {
    const params = notification.params;
    const delta = typeof params?.delta === "string" ? params.delta : null;
    if (!OUTPUT_DELTA_METHODS.has(notification.method) || delta === null) {
      this.flushOutputBuffers();
      this.processNotification(notification);
      return;
    }

    const threadId = typeof params?.threadId === "string" ? params.threadId : "";
    const itemId = typeof params?.itemId === "string"
      ? params.itemId
      : typeof params?.processId === "string" ? params.processId : "";
    const key = `${notification.method}\0${threadId}\0${itemId}`;
    const bytes = Buffer.byteLength(delta);
    const buffered = this.outputBuffers.get(key);
    if (buffered) {
      buffered.notification.params = { ...buffered.notification.params, ...params, delta: String(buffered.notification.params?.delta || "") + delta };
      buffered.bytes += bytes;
    } else {
      this.outputBuffers.set(key, { notification: { method: notification.method, params: { ...params } }, bytes });
    }
    this.outputBufferBytes += bytes;
    this.touchSession(threadId);

    if (this.outputBufferBytes >= this.options.maxBufferedOutputBytes) {
      this.flushOutputBuffers();
      return;
    }
    if (!this.outputFlushTimer) {
      this.outputFlushTimer = setTimeout(() => {
        this.outputFlushTimer = null;
        this.flushOutputBuffers();
      }, this.options.streamFlushIntervalMs);
      this.outputFlushTimer.unref();
    }
  }

  private flushOutputBuffers(): void {
    if (this.outputFlushTimer) clearTimeout(this.outputFlushTimer);
    this.outputFlushTimer = null;
    if (!this.outputBuffers.size) return;
    const buffered = [...this.outputBuffers.values()];
    this.outputBuffers.clear();
    this.outputBufferBytes = 0;
    for (const entry of buffered) this.processNotification(entry.notification);
  }

  private clearOutputBuffers(flush: boolean): void {
    if (flush) this.flushOutputBuffers();
    else {
      if (this.outputFlushTimer) clearTimeout(this.outputFlushTimer);
      this.outputFlushTimer = null;
      this.outputBuffers.clear();
      this.outputBufferBytes = 0;
    }
  }

  private processNotification(notification: CodexNotification): void {
    const params = notification.params;
    const threadId = typeof params?.threadId === "string" ? params.threadId : null;

    if (threadId && notification.method === "turn/started") {
      this.beginSession(threadId, readTurnId(params!));
    } else if (threadId && notification.method === "turn/completed") {
      if (this.isDuplicateCompletion(threadId, readTurnId(params!))) return;
      this.recordCompletion(threadId, readTurnId(params!));
    } else if (threadId && notification.method === "thread/status/changed") {
      const status = isRecord(params?.status) ? params.status.type : undefined;
      if (status === "active") this.ensureActiveSession(threadId);
    } else if (threadId) {
      this.touchSession(threadId);
    }

    this.emit("notification", notification);

    if (threadId && notification.method === "thread/status/changed") {
      const status = isRecord(params?.status) ? params.status.type : undefined;
      if (status !== "active" && this.activeSessions.has(threadId)) this.scheduleCompletion(threadId, "completed", "status_became_idle", false);
    }
    if (threadId && (notification.method === "thread/deleted" || notification.method === "thread/archived")) {
      const session = this.activeSessions.get(threadId);
      if (session) this.completeSession(session, "interrupted", "thread_closed", true);
    }
  }

  private beginSession(threadId: string, turnId: string | null): void {
    const previous = this.activeSessions.get(threadId);
    if (previous && turnId && previous.turnId && previous.turnId !== turnId) {
      this.completeSession(previous, "interrupted", "superseded_by_new_turn", true);
    }
    this.cancelScheduledCompletion(threadId);
    this.recentCompletions.delete(completionKey(threadId, null));
    if (turnId) this.recentCompletions.delete(completionKey(threadId, turnId));
    if (!previous && this.activeSessions.size >= this.options.maxTrackedSessions) {
      const oldest = [...this.activeSessions.values()].sort((left, right) => left.lastActivityAt - right.lastActivityAt)[0];
      if (oldest) this.completeSession(oldest, "interrupted", "session_tracking_limit_reached", true);
    }
    const now = Date.now();
    this.activeSessions.set(threadId, {
      threadId,
      turnId: turnId ?? previous?.turnId ?? null,
      state: "running",
      startedAt: previous?.startedAt ?? now,
      lastActivityAt: now,
      completedAt: null,
      probeFailures: 0,
      disconnectedAt: null
    });
  }

  private ensureActiveSession(threadId: string): void {
    const existing = this.activeSessions.get(threadId);
    if (existing) {
      existing.lastActivityAt = Date.now();
      existing.probeFailures = 0;
      existing.disconnectedAt = null;
      this.cancelScheduledCompletion(threadId);
      return;
    }
    this.beginSession(threadId, null);
  }

  private touchSession(threadId: string): void {
    const session = this.activeSessions.get(threadId);
    if (!session) return;
    session.lastActivityAt = Date.now();
    session.probeFailures = 0;
  }

  private scheduleCompletion(threadId: string, state: "completed" | "interrupted", reason: string, emitStatus: boolean): void {
    this.cancelScheduledCompletion(threadId);
    const timer = setTimeout(() => {
      this.completionTimers.delete(threadId);
      const session = this.activeSessions.get(threadId);
      if (session) this.completeSession(session, state, reason, emitStatus);
    }, this.options.sessionIdleGraceMs);
    timer.unref();
    this.completionTimers.set(threadId, timer);
  }

  private cancelScheduledCompletion(threadId: string): void {
    const timer = this.completionTimers.get(threadId);
    if (timer) clearTimeout(timer);
    this.completionTimers.delete(threadId);
  }

  private clearCompletionTimers(): void {
    for (const timer of this.completionTimers.values()) clearTimeout(timer);
    this.completionTimers.clear();
  }

  private recordCompletion(threadId: string, turnId: string | null): void {
    const session = this.activeSessions.get(threadId);
    if (session && (!turnId || !session.turnId || session.turnId === turnId)) {
      this.activeSessions.delete(threadId);
      this.cancelScheduledCompletion(threadId);
    }
    this.rememberCompletion(threadId, turnId ?? session?.turnId ?? null);
  }

  private completeSession(session: RunningSession, state: "completed" | "interrupted", reason: string, emitStatus: boolean): void {
    if (this.activeSessions.get(session.threadId) !== session) return;
    this.activeSessions.delete(session.threadId);
    this.cancelScheduledCompletion(session.threadId);
    const completedAt = Date.now();
    this.rememberCompletion(session.threadId, session.turnId);
    if (emitStatus) {
      this.emit("notification", {
        method: "thread/status/changed",
        params: { threadId: session.threadId, status: { type: "idle" }, synthetic: true, reason }
      });
    }
    this.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: session.threadId,
        turn: { id: session.turnId ?? "unknown", status: state, items: [] },
        synthetic: true,
        reason,
        completedAt
      }
    });
    this.emitMetrics();
  }

  private isDuplicateCompletion(threadId: string, turnId: string | null): boolean {
    this.expireRecentCompletions();
    return this.recentCompletions.has(completionKey(threadId, turnId))
      || (turnId !== null && this.recentCompletions.has(completionKey(threadId, null)));
  }

  private rememberCompletion(threadId: string, turnId: string | null): void {
    this.expireRecentCompletions();
    this.recentCompletions.set(completionKey(threadId, turnId), Date.now() + this.options.completedSessionTtlMs);
    while (this.recentCompletions.size > 1_024) {
      const oldest = this.recentCompletions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.recentCompletions.delete(oldest);
    }
  }

  private expireRecentCompletions(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.recentCompletions) {
      if (expiresAt <= now) this.recentCompletions.delete(key);
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setInterval(() => void this.heartbeatTick(), this.options.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.heartbeatInFlight = false;
  }

  private async heartbeatTick(): Promise<void> {
    const transport = this.transport;
    if (!transport || transport.closed || this.connectionState !== "ready" || this.heartbeatInFlight) return;
    this.expireServerRequests();
    this.expireRecentCompletions();
    for (const session of this.activeSessions.values()) {
      if (Date.now() - session.lastActivityAt >= this.options.sessionStaleMs) void this.probeSession(session.threadId);
    }

    if (transport.kind === "socket") {
      if (transport.awaitingPongSince && Date.now() - transport.awaitingPongSince >= this.options.heartbeatTimeoutMs) {
        this.handleTransportFailure(
          transport,
          new CodexBridgeError("Codex app-server heartbeat timed out", "HEARTBEAT_TIMEOUT", true, true)
        );
        return;
      }
      try {
        transport.awaitingPongSince = Date.now();
        transport.socket.ping();
      } catch (cause) {
        this.handleTransportFailure(transport, this.normalizeConnectionError(cause, true));
      }
      return;
    }

    this.heartbeatInFlight = true;
    try {
      await this.callRaw("ping", undefined, this.options.heartbeatTimeoutMs);
      this.markHeartbeat();
    } catch (cause) {
      const error = this.normalizeRequestError(cause);
      // A JSON-RPC "method not found" response still proves the stdio peer is alive.
      if (error instanceof CodexRpcError) this.markHeartbeat();
      else if (this.transport === transport) this.handleTransportFailure(transport, error);
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  private markHeartbeat(): void {
    this.lastHeartbeatAt = Date.now();
  }

  private async reconcileActiveSessions(): Promise<void> {
    await Promise.allSettled([...this.activeSessions.keys()].map((threadId) => this.probeSession(threadId)));
  }

  private async probeSession(threadId: string): Promise<void> {
    if (this.sessionProbes.has(threadId) || this.connectionState !== "ready") return;
    const session = this.activeSessions.get(threadId);
    if (!session) return;
    this.sessionProbes.add(threadId);
    try {
      const result = await this.callRaw("thread/read", { threadId, includeTurns: true }, this.options.heartbeatTimeoutMs) as ThreadReadResult;
      const current = this.activeSessions.get(threadId);
      if (!current) return;
      const latestTurn = result.thread?.turns?.at(-1);
      const active = result.thread?.status?.type === "active" || latestTurn?.status === "inProgress";
      if (active) {
        current.turnId = latestTurn?.id ?? current.turnId;
        current.lastActivityAt = Date.now();
        current.probeFailures = 0;
        current.disconnectedAt = null;
      } else {
        const interrupted = latestTurn?.status === "interrupted" || latestTurn?.status === "failed";
        this.completeSession(current, interrupted ? "interrupted" : "completed", "reconciled_after_silence", true);
      }
    } catch {
      const current = this.activeSessions.get(threadId);
      if (!current) return;
      current.probeFailures += 1;
      const staleFor = Date.now() - current.lastActivityAt;
      if (current.probeFailures >= 3 && staleFor >= this.options.sessionStaleMs * 3) {
        this.completeSession(current, "interrupted", "session_heartbeat_failed", true);
      }
    } finally {
      this.sessionProbes.delete(threadId);
    }
  }

  private handleTransportFailure(
    transport: Transport,
    error: CodexBridgeError,
    code: number | null = null,
    signal: NodeJS.Signals | null = null
  ): void {
    if (this.transport !== transport || transport.closed) return;
    this.lastError = error.message;
    this.clearHeartbeatTimer();
    this.clearOutputBuffers(true);
    this.disposeTransport(transport, transport.kind === "child" && transport.child.exitCode === null, false);
    this.connectionState = this.stopping ? "stopped" : "offline";
    this.rejectPendingForGeneration(transport.generation, error);
    this.resolveServerRequests("connection_lost");

    const now = Date.now();
    for (const session of this.activeSessions.values()) {
      session.disconnectedAt ??= now;
    }
    if (this.activeSessions.size) this.scheduleSessionRecoveryTimeout();

    const willRetry = !this.stopping && error.transient;
    this.emit("offline", { code, signal, reason: error.message, willRetry });
    this.emitMetrics();
    if (willRetry) this.scheduleReconnect();
  }

  private scheduleSessionRecoveryTimeout(): void {
    if (this.sessionRecoveryTimer) return;
    const disconnectedAt = [...this.activeSessions.values()]
      .map((session) => session.disconnectedAt)
      .filter((value): value is number => value !== null);
    if (!disconnectedAt.length) return;
    const delayMs = Math.max(1, Math.min(...disconnectedAt) + this.options.sessionRecoveryTimeoutMs - Date.now());
    this.sessionRecoveryTimer = setTimeout(() => {
      this.sessionRecoveryTimer = null;
      if (this.connectionState === "ready") return;
      const cutoff = Date.now() - this.options.sessionRecoveryTimeoutMs;
      for (const session of [...this.activeSessions.values()]) {
        if (session.disconnectedAt !== null && session.disconnectedAt <= cutoff) {
          this.completeSession(session, "interrupted", "runtime_recovery_timed_out", true);
        }
      }
    }, delayMs);
    this.sessionRecoveryTimer.unref();
  }

  private clearSessionRecoveryTimer(): void {
    if (this.sessionRecoveryTimer) clearTimeout(this.sessionRecoveryTimer);
    this.sessionRecoveryTimer = null;
  }

  private disposeTransport(transport: Transport, terminate: boolean, graceful: boolean): void {
    if (transport.closed) return;
    transport.closed = true;
    if (this.transport === transport) this.transport = null;
    this.clearOutboundQueue();
    const connectReject = transport.connectReject;
    transport.connectReject = null;
    connectReject?.(new CodexUnavailableError("Codex connection was closed before it became ready", "CONNECTION_CLOSED", true, false));

    if (transport.kind === "socket") {
      transport.socket.removeAllListeners();
      try {
        if (graceful && transport.socket.readyState === WebSocket.OPEN) transport.socket.close(1000, "ForgeDeck bridge stopped");
        else if (transport.socket.readyState !== WebSocket.CLOSED) transport.socket.terminate();
      } catch {
        // The socket is already closing.
      }
      return;
    }

    transport.lines.close();
    transport.lines.removeAllListeners();
    transport.child.stdin.removeAllListeners();
    transport.child.stdout.removeAllListeners();
    transport.child.stderr.removeAllListeners();
    transport.child.removeAllListeners();
    transport.child.stdin.on("error", () => undefined);
    transport.child.stdout.on("error", () => undefined);
    transport.child.stderr.on("error", () => undefined);
    transport.child.stdin.end();
    transport.child.stdout.destroy();
    transport.child.stderr.destroy();
    if (terminate && transport.child.exitCode === null && transport.child.signalCode === null) {
      this.terminateChild(transport.child);
    }
  }

  private terminateChild(child: ChildProcessWithoutNullStreams): void {
    let escalationTimer: NodeJS.Timeout | null = null;
    const cleanup = (): void => {
      if (escalationTimer) clearTimeout(escalationTimer);
      escalationTimer = null;
    };
    child.once("exit", cleanup);
    try {
      child.kill("SIGTERM");
    } catch {
      cleanup();
      return;
    }
    escalationTimer = setTimeout(() => {
      escalationTimer = null;
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGKILL"); } catch { /* The process exited between checks. */ }
      }
    }, this.options.shutdownGraceMs);
    escalationTimer.unref();
  }

  private clearOutboundQueue(): void {
    if (this.outboundFlushTimer) clearTimeout(this.outboundFlushTimer);
    this.outboundFlushTimer = null;
    this.outboundQueue.length = 0;
    this.outboundQueueBytes = 0;
    this.outboundBlocked = false;
  }

  private rejectPendingForGeneration(generation: number, error: CodexBridgeError): void {
    for (const [id, call] of this.pending) {
      if (call.generation !== generation) continue;
      clearTimeout(call.timer);
      this.pending.delete(id);
      call.reject(new CodexBridgeError(error.message, error.code, error.transient, call.dispatched, error.data));
    }
  }

  private rejectPending(error: CodexBridgeError): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
  }

  private resolveServerRequests(reason: string): void {
    for (const request of this.serverRequests.values()) {
      this.emit("serverRequestResolved", { id: request.id, reason });
    }
    this.serverRequests.clear();
  }

  private expireServerRequests(): void {
    const now = Date.now();
    for (const [key, request] of this.serverRequests) {
      if (request.expiresAt > now) continue;
      this.serverRequests.delete(key);
      this.emit("serverRequestResolved", { id: request.id, reason: "expired" });
    }
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    const delayMs = this.backoff(this.reconnectAttempt, this.options.reconnectBaseDelayMs, this.options.reconnectMaxDelayMs);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopping || this.connectionState === "ready") return;
      this.reconnectAttempts += 1;
      void this.start().catch(() => {
        // launch() reports the concrete error and schedules the next attempt.
      });
    }, delayMs);
    this.reconnectTimer.unref();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private shouldRetry(method: string, error: CodexBridgeError, attempt: number, deadline: number): boolean {
    if (!error.transient || attempt >= this.options.requestRetries || Date.now() >= deadline) return false;
    if (!error.dispatched) return true;
    const isRetryable = this.options.isRetryableMethod ?? ((candidate: string) => SAFE_RETRY_METHODS.some((pattern) => pattern.test(candidate)));
    return isRetryable(method);
  }

  private backoff(attempt: number, baseMs: number, maxMs: number): number {
    const exponential = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 16));
    // A small jitter prevents every HTTP request from reconnecting in lockstep.
    return Math.max(1, Math.round(exponential * (0.8 + Math.random() * 0.4)));
  }

  private normalizeRequestError(cause: unknown): CodexBridgeError {
    if (cause instanceof CodexBridgeError) return cause;
    return this.normalizeConnectionError(cause, false);
  }

  private normalizeConnectionError(cause: unknown, dispatched: boolean): CodexBridgeError {
    if (cause instanceof CodexBridgeError) return cause;
    const error = cause instanceof Error ? errorWithCode(cause) : null;
    const code = error?.code ?? "CONNECTION_ERROR";
    const permanent = code === "ENOENT" || code === "EACCES" || code === "ERR_INVALID_URL";
    return new CodexUnavailableError(
      error?.message || (typeof cause === "string" ? cause : "Codex app-server connection failed"),
      code,
      !permanent,
      dispatched
    );
  }

  private assertCurrentTransport(transport: Transport): void {
    if (this.transport !== transport || transport.closed || this.stopping) {
      throw new CodexBridgeError("Codex connection was superseded", "CONNECTION_SUPERSEDED", true, false);
    }
  }

  private reportError(error: Error): void {
    if (this.listenerCount("error")) this.emit("error", error);
    else logger.error("Unhandled Codex bridge error", { error });
  }

  private emitMetrics(): void {
    if (this.listenerCount("metrics")) this.emit("metrics", this.getMetrics());
  }
}

export interface CodexBridge {
  on<K extends keyof CodexBridgeEventMap>(event: K, listener: (...args: CodexBridgeEventMap[K]) => void): this;
  once<K extends keyof CodexBridgeEventMap>(event: K, listener: (...args: CodexBridgeEventMap[K]) => void): this;
  emit<K extends keyof CodexBridgeEventMap>(event: K, ...args: CodexBridgeEventMap[K]): boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTurnId(params: Record<string, unknown>): string | null {
  const turn = isRecord(params.turn) ? params.turn : null;
  if (typeof turn?.id === "string") return turn.id;
  return typeof params.turnId === "string" ? params.turnId : null;
}

function completionKey(threadId: string, turnId: string | null): string {
  return `${threadId}\0${turnId ?? "*"}`;
}

function isTransientRpcError(error: RpcErrorPayload): boolean {
  return error.code === -32603 || (typeof error.code === "number" && error.code >= -32099 && error.code <= -32000);
}

function errorWithCode(error: Error): Error & { code?: string | number } {
  return error as Error & { code?: string | number };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
