import { useCallback, useEffect, useRef, useState } from "react";
import {
  isSseEventName,
  parseSseEnvelope,
  timestampToEpochMs,
  type SseEnvelope,
  type SseEventName,
  type SsePayload
} from "../../shared/contracts";
import { api, apiErrorFromPayload, type ServerErrorPayload } from "../api/client";
import { LIVE_OUTPUT_BUDGET_BYTES, threadStore } from "../state/thread-store";
import type {
  AdmissionEvent, LiveRecoverySnapshot, PendingRequest, QueueEntry, RunGuardianState, Thread, ThreadItem, ThreadTokenUsage
} from "../types";

export type BackendHealth = "unknown" | "ready" | "offline" | "error";
export type TransportState = "reconnecting" | "live" | "polling" | "offline";
export type RecoveryReason = "gap" | "reconnect" | "poll";
export type LiveNotificationEvent = {
  kind: "completed" | "failed" | "approval" | "queued";
  threadId: string;
  message?: string;
  queuedCount?: number;
};

type UseEventStreamOptions = {
  enabled: boolean;
  subscribedThreadIds: readonly string[];
  fallbackPollInterval: number;
  refreshStatus: () => Promise<unknown>;
  readApprovals: () => Promise<PendingRequest[]>;
  refreshInventory: () => Promise<unknown>;
  refreshThread: (threadId: string, quiet?: boolean) => Promise<unknown>;
  readRecovery: () => Promise<LiveRecoverySnapshot>;
  selectedThreadId: () => string | null;
  shouldReconcileThread?: (threadId: string) => boolean;
  onThreadRemoved?: (threadId: string) => void;
  onSessionEnded?: (reason: "logout" | "expired") => void;
  onAdmission?: (event: AdmissionEvent) => void;
  onBackendStatus?: (status: SsePayload<"backend-status">) => void;
  onNotification?: (event: LiveNotificationEvent) => void;
  onError?: (error: unknown) => void;
};

type BufferedDeltas = Record<string, { revision: number; values: Record<string, string> }>;
type DeferredEvent = { apply: () => void };

const LIVE_FLUSH_MS = 50;
const AUTOMATIC_FALLBACK_POLL_MS = 10_000;
const SSE_CONNECT_TIMEOUT_MS = 10_000;
const SSE_RECONNECT_BASE_MS = 1_000;
const SSE_RECONNECT_MAX_MS = 30_000;

/** A disabled preference still gets a conservative safety poll while SSE is down. */
export function effectiveFallbackPollInterval(preference: number): number {
  return Number.isFinite(preference) && preference > 0 ? preference : AUTOMATIC_FALLBACK_POLL_MS;
}

/** Bounds automatic and manual SSE retries to a predictable exponential backoff. */
export function reconnectBackoffDelay(attempt: number): number {
  const exponent = Math.max(0, Math.min(30, Math.floor(attempt)));
  return Math.min(SSE_RECONNECT_MAX_MS, SSE_RECONNECT_BASE_MS * (2 ** exponent));
}

/** Reports one automatic failure per channel until that channel recovers. */
export class AutomaticErrorGate {
  private readonly active = new Map<string, string>();

  report(channel: string, error: unknown, reporter: (caught: unknown) => void): boolean {
    const signature = automaticErrorSignature(error);
    if (this.active.get(channel) === signature) return false;
    this.active.set(channel, signature);
    reporter(error);
    return true;
  }

  resolve(channel: string): void {
    this.active.delete(channel);
  }

  clear(): void {
    this.active.clear();
  }
}

/** Keeps late provider events from turning an intentional removal into a failure. */
export class RemovedSessionGate {
  private readonly removed = new Set<string>();

  markRemoved(threadId: string): void {
    this.removed.add(threadId);
  }

  markPresent(threadId: string): void {
    this.removed.delete(threadId);
  }

  has(threadId: string | null | undefined): boolean {
    return Boolean(threadId && this.removed.has(threadId));
  }

  clear(): void {
    this.removed.clear();
  }
}

export function reversesSessionRemoval(action: unknown, reason: unknown): boolean {
  return action === "created" || (action === "updated" && (reason === "restored" || reason === "archive_failed"));
}

export function shouldRefreshDetailDuringRecovery(reason: RecoveryReason): boolean {
  return reason !== "poll";
}

/**
 * Orders the SSE sequence. Unscoped streams recover revision gaps; scoped
 * streams accept sparse revisions because unrelated thread events are omitted.
 */
export class RevisionSequence {
  private revision: number | null = null;
  private pending = new Map<number, DeferredEvent>();
  private recovery: Promise<boolean> | null = null;
  private recoveryFailed = false;

  constructor(
    private readonly recoverSnapshot: (reason: RecoveryReason) => Promise<number>,
    private readonly onError: (error: unknown) => void = () => undefined,
    private readonly allowSparseRevisions = false
  ) {}

  establish(revision: number): void {
    if (!isRevision(revision)) return;
    if (this.revision === null) this.revision = revision;
  }

  observe(revision: number, apply: () => void): void {
    if (!isRevision(revision) || (this.revision !== null && revision <= this.revision)) return;
    if (!this.pending.has(revision)) this.pending.set(revision, { apply });
    this.recoveryFailed = false;
    this.drain();
  }

  forceRecovery(reason: RecoveryReason): Promise<boolean> {
    this.recoveryFailed = false;
    return this.startRecovery(reason);
  }

  async settled(): Promise<void> {
    while (this.recovery) await this.recovery;
  }

  get currentRevision(): number | null {
    return this.revision;
  }

  private drain(): void {
    if (this.recovery || this.recoveryFailed || !this.pending.size) return;
    if (this.revision === null) {
      const first = Math.min(...this.pending.keys());
      const event = this.pending.get(first)!;
      this.pending.delete(first);
      this.revision = first;
      event.apply();
    }
    if (this.allowSparseRevisions && this.revision !== null) {
      for (const pendingRevision of [...this.pending.keys()].sort((left, right) => left - right)) {
        if (pendingRevision <= this.revision) {
          this.pending.delete(pendingRevision);
          continue;
        }
        const event = this.pending.get(pendingRevision)!;
        this.pending.delete(pendingRevision);
        this.revision = pendingRevision;
        event.apply();
      }
      return;
    }
    while (this.revision !== null) {
      const nextRevision: number = this.revision + 1;
      const event = this.pending.get(nextRevision);
      if (!event) break;
      this.pending.delete(nextRevision);
      this.revision = nextRevision;
      event.apply();
    }
    if (this.pending.size) void this.startRecovery("gap");
  }

  private startRecovery(reason: RecoveryReason): Promise<boolean> {
    if (this.recovery) return this.recovery;
    const recovery = this.recoverSnapshot(reason)
      .then((revision) => {
        if (!isRevision(revision)) throw new Error("Recovery snapshot did not include a valid revision");
        this.revision = Math.max(this.revision || 0, revision);
        for (const pendingRevision of this.pending.keys()) {
          if (pendingRevision <= this.revision) this.pending.delete(pendingRevision);
        }
        return true;
      })
      .catch((error) => {
        this.recoveryFailed = true;
        this.onError(error);
        return false;
      })
      .finally(() => {
        this.recovery = null;
        this.drain();
      });
    this.recovery = recovery;
    return recovery;
  }
}

/** Owns the SSE lifecycle and dispatches revisioned updates to the normalized store. */
export function useEventStream(options: UseEventStreamOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const reconnectRef = useRef<() => void>(() => undefined);
  const clientIdRef = useRef<string | null>(null);
  const subscriptionSyncRef = useRef<Promise<void>>(Promise.resolve());
  const automaticErrorsRef = useRef(new AutomaticErrorGate());
  const removedSessionsRef = useRef(new RemovedSessionGate());
  clientIdRef.current ||= createEventStreamClientId();
  const subscribedThreadIds = [...new Set(options.subscribedThreadIds)].sort();
  const subscriptionSignature = subscribedThreadIds.join(",");
  const [backendHealth, setBackendHealth] = useState<BackendHealth>("unknown");
  const [transport, setTransport] = useState<TransportState>("reconnecting");
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [nextReconnectAt, setNextReconnectAt] = useState<number | null>(null);
  const [pending, setPending] = useState<PendingRequest[]>([]);

  const replacePending = useCallback((requests: PendingRequest[]) => setPending((current) => samePending(current, requests) ? current : requests), []);
  const resolvePending = useCallback((id: string | number) => {
    setPending((current) => current.filter((request) => String(request.id) !== String(id)));
  }, []);

  useEffect(() => {
    if (!options.enabled) {
      automaticErrorsRef.current.clear();
      removedSessionsRef.current.clear();
      setBackendHealth("unknown");
      setTransport("offline");
      setLastSyncedAt(null);
      setNextReconnectAt(null);
      reconnectRef.current = () => undefined;
      return;
    }
    let disposed = false;
    let stream: EventSource | null = null;
    let streamGeneration = 0;
    let streamConnected = false;
    let retryAttempt = 0;
    let retryTimer: number | null = null;
    let connectTimer: number | null = null;
    let pollTimer: number | null = null;
    let polling = false;
    let fallbackActive = false;
    let lastSyncCommit = 0;
    let listTimer: number | null = null;
    let flushTimer: number | null = null;
    const terminalTimers = new Map<string, number>();
    let textDeltas: BufferedDeltas = {};
    let toolDeltas: BufferedDeltas = {};
    let pendingTruncations: Record<string, Set<string>> = {};
    const automaticErrors = automaticErrorsRef.current;
    const removedSessions = removedSessionsRef.current;
    const reportAutomaticError = (channel: string, error: unknown) => {
      if (channel.startsWith("detail:") && removedSessions.has(channel.slice("detail:".length))) return;
      automaticErrors.report(channel, error, (caught) => optionsRef.current.onError?.(caught));
    };

    const updateTransport = (state: TransportState) => {
      if (!disposed) setTransport(state);
    };
    const markSynced = () => {
      const now = Date.now();
      if (now - lastSyncCommit < 1_000) return;
      lastSyncCommit = now;
      if (!disposed) setLastSyncedAt(now);
    };

    const scheduleInventory = (delay = 250) => {
      if (listTimer) clearTimeout(listTimer);
      listTimer = window.setTimeout(() => {
        listTimer = null;
        void optionsRef.current.refreshInventory()
          .then(() => automaticErrors.resolve("inventory"))
          .catch((error) => reportAutomaticError("inventory", error));
      }, delay);
    };
    const recoverSnapshot = async (reason: RecoveryReason): Promise<number> => {
      const snapshot = await optionsRef.current.readRecovery();
      automaticErrors.resolve("recovery");
      threadStore.applyRecoverySnapshot(snapshot);
      const selected = optionsRef.current.selectedThreadId();
      const supplemental: Array<[channel: string, operation: Promise<unknown>]> = [
        ["status", optionsRef.current.refreshStatus()],
        ["approvals", optionsRef.current.readApprovals().then(replacePending)],
        ["inventory", optionsRef.current.refreshInventory()]
      ];
      // The live recovery snapshot already carries selected-thread deltas.
      // Re-reading a broken detail on every fallback poll caused the ×70 storms.
      if (shouldRefreshDetailDuringRecovery(reason) && selected) {
        if (!removedSessions.has(selected)) supplemental.push([`detail:${selected}`, optionsRef.current.refreshThread(selected, true)]);
      }
      await Promise.all(supplemental.map(async ([channel, operation]) => {
        try {
          await operation;
          automaticErrors.resolve(channel);
        } catch (error) {
          reportAutomaticError(channel, error);
        }
      }));
      markSynced();
      return snapshot.revision;
    };
    const sequence = new RevisionSequence(recoverSnapshot, (error) => reportAutomaticError("recovery", error), true);

    const closeStream = () => {
      streamGeneration += 1;
      streamConnected = false;
      if (connectTimer) clearTimeout(connectTimer);
      connectTimer = null;
      stream?.close();
      stream = null;
    };
    const stopFallback = () => {
      fallbackActive = false;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
    };
    const schedulePoll = () => {
      if (disposed || !fallbackActive || pollTimer) return;
      pollTimer = window.setTimeout(() => {
        pollTimer = null;
        void pollOnce();
      }, effectiveFallbackPollInterval(optionsRef.current.fallbackPollInterval));
    };
    const pollOnce = async () => {
      if (disposed || !fallbackActive || polling) return;
      polling = true;
      const recovered = await sequence.forceRecovery("poll");
      polling = false;
      if (disposed || !fallbackActive) return;
      if (recovered) {
        if (streamConnected) {
          stopFallback();
          updateTransport("live");
        } else {
          updateTransport("polling");
          schedulePoll();
        }
      } else {
        updateTransport("offline");
        schedulePoll();
      }
    };
    const startFallback = () => {
      if (disposed) return;
      fallbackActive = true;
      if (!polling && !pollTimer) void pollOnce();
    };
    const clearRetry = () => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      if (!disposed) setNextReconnectAt(null);
    };
    const scheduleReconnect = (immediate = false) => {
      if (disposed || retryTimer || navigator.onLine === false) return;
      const delay = immediate ? 0 : reconnectBackoffDelay(retryAttempt++);
      const reconnectAt = Date.now() + delay;
      if (!disposed) setNextReconnectAt(reconnectAt);
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        if (!disposed) setNextReconnectAt(null);
        openStream();
      }, delay);
    };
    const handleStreamFailure = (failedStream: EventSource) => {
      if (disposed || stream !== failedStream) return;
      closeStream();
      updateTransport(navigator.onLine === false ? "offline" : "reconnecting");
      startFallback();
      scheduleReconnect();
    };

    const flush = () => {
      flushTimer = null;
      const nextText = textDeltas;
      const nextTools = toolDeltas;
      const nextTruncations = pendingTruncations;
      textDeltas = {};
      toolDeltas = {};
      pendingTruncations = {};
      for (const [threadId, buffered] of Object.entries(nextText)) {
        threadStore.applyEvent({ type: "live/agent-text", threadId, revision: buffered.revision, deltas: buffered.values });
      }
      for (const [threadId, buffered] of Object.entries(nextTools)) {
        threadStore.applyEvent({ type: "live/tool-output", threadId, revision: buffered.revision, deltas: buffered.values });
      }
      for (const [threadId, itemIds] of Object.entries(nextTruncations)) {
        threadStore.markLiveTruncated(threadId, [...itemIds]);
      }
    };
    const flushNow = () => {
      if (!flushTimer) return;
      clearTimeout(flushTimer);
      flush();
    };
    const queueDelta = (target: "text" | "tool", threadId: string, itemId: string, delta: string, revision: number) => {
      if (!delta) return;
      const collection = target === "text" ? textDeltas : toolDeltas;
      const current = collection[threadId] || { revision, values: {} };
      collection[threadId] = {
        revision: Math.max(current.revision, revision),
        values: { ...current.values, [itemId]: `${current.values[itemId] || ""}${delta}` }
      };
      const truncated = boundPendingThread(textDeltas[threadId]?.values || {}, toolDeltas[threadId]?.values || {});
      if (truncated.length) {
        pendingTruncations[threadId] ||= new Set();
        for (const truncatedItemId of truncated) pendingTruncations[threadId].add(truncatedItemId);
      }
      if (!flushTimer) flushTimer = window.setTimeout(flush, LIVE_FLUSH_MS);
    };
    const reconcileTerminal = (threadId: string) => {
      if (removedSessions.has(threadId)) return;
      const existing = terminalTimers.get(threadId);
      if (existing) clearTimeout(existing);
      terminalTimers.set(threadId, window.setTimeout(() => {
        terminalTimers.delete(threadId);
        if (removedSessions.has(threadId)) return;
        if (!threadStore.getLive(threadId).completed) threadStore.markCompleted(threadId);
        void optionsRef.current.refreshStatus()
          .then(() => automaticErrors.resolve("status"))
          .catch((error) => reportAutomaticError("status", error));
        scheduleInventory(0);
        const relevant = optionsRef.current.shouldReconcileThread?.(threadId)
          ?? optionsRef.current.selectedThreadId() === threadId;
        if (!relevant) return;
        void optionsRef.current.refreshThread(threadId, true)
          .then(() => {
            automaticErrors.resolve(`detail:${threadId}`);
            threadStore.clearTransient(threadId);
          })
          .catch((error) => reportAutomaticError(`detail:${threadId}`, error));
      }, 300));
    };
    function onRevisioned<T>(events: EventSource, name: string, handle: (payload: T, revision: number, threadId: string | null) => void) {
      events.addEventListener(name, (event) => {
        const envelope = parseEnvelope<T>(name, event);
        if (!envelope) return;
        sequence.observe(envelope.eventId, () => {
          handle(envelope.payload, envelope.eventId, envelope.threadId);
          markSynced();
        });
      });
    }
    function attachListeners(events: EventSource, generation: number) {
      events.addEventListener("connected", (event) => {
        if (disposed || stream !== events || generation !== streamGeneration) return;
        const envelope = parseEnvelope<{ at?: unknown }>("connected", event);
        if (!envelope) return;
        streamConnected = true;
        retryAttempt = 0;
        clearRetry();
        if (connectTimer) clearTimeout(connectTimer);
        connectTimer = null;
        updateTransport("reconnecting");
        sequence.establish(envelope.eventId);
        void sequence.forceRecovery("reconnect").then((recovered) => {
          if (disposed || stream !== events || !streamConnected) return;
          if (recovered) {
            stopFallback();
            updateTransport("live");
          } else {
            startFallback();
          }
        });
      });
      events.addEventListener("session-ended", (event) => {
        const envelope = parseEnvelope<{ reason?: unknown }>("session-ended", event);
        const reason = envelope?.payload.reason;
        if (reason === "logout" || reason === "expired") {
          disposed = true;
          closeStream();
          stopFallback();
          clearRetry();
          optionsRef.current.onSessionEnded?.(reason);
        }
      });
      onRevisioned<{ state?: unknown; error?: unknown }>(events, "runtime", (payload) => {
        if (!payload || !["ready", "offline", "error"].includes(String(payload.state))) return;
        const state = payload.state as Exclude<BackendHealth, "unknown">;
        if (!disposed) setBackendHealth(state);
        if (payload.error) optionsRef.current.onError?.(apiErrorFromPayload(payload.error, { scope: "runtime" }));
      });
      attachRevisionedListeners(events);
      events.onerror = () => handleStreamFailure(events);
    }
    function attachRevisionedListeners(events: EventSource) {
      onRevisioned<PendingRequest>(events, "approval", (request, _revision, envelopeThreadId) => {
        if (!request || request.id === undefined) return;
        setPending((current) => current.some((item) => String(item.id) === String(request.id)) ? current : [...current, request]);
        const requestThreadId = isRecord(request.params) && typeof request.params.threadId === "string" ? request.params.threadId : null;
        const threadId = envelopeThreadId || requestThreadId;
        if (threadId) optionsRef.current.onNotification?.({ kind: "approval", threadId });
      });
    onRevisioned<{ id?: unknown }>(events, "approval-resolved", (payload) => {
      if (payload?.id !== undefined) resolvePending(payload.id as string | number);
    });
    onRevisioned<SsePayload<"backend-status">>(events, "backend-status", (payload) => {
      if (optionsRef.current.onBackendStatus) {
        optionsRef.current.onBackendStatus(payload);
        automaticErrors.resolve("status");
        return;
      }
      void optionsRef.current.refreshStatus()
        .then(() => automaticErrors.resolve("status"))
        .catch((error) => reportAutomaticError("status", error));
    });
    onRevisioned<AdmissionEvent>(events, "admission", (payload) => {
      if (payload) optionsRef.current.onAdmission?.(payload);
    });
    onRevisioned<{ threadId?: unknown; queue?: unknown; error?: unknown }>(events, "queue", (payload, revision) => {
      if (!payload || typeof payload.threadId !== "string" || !Array.isArray(payload.queue)) return;
      if (removedSessions.has(payload.threadId)) return;
      flushNow();
      const previousIds = new Set(threadStore.getLive(payload.threadId).queue.map((entry) => entry.id));
      const added = (payload.queue as QueueEntry[]).filter((entry) => !previousIds.has(entry.id));
      threadStore.applyEvent({ type: "live/queue", threadId: payload.threadId, revision, queue: payload.queue as QueueEntry[] });
      if (added.length) optionsRef.current.onNotification?.({
        kind: "queued",
        threadId: payload.threadId,
        queuedCount: added.length,
        message: added.length === 1 ? added[0].text : undefined
      });
      if (payload.error) optionsRef.current.onError?.(apiErrorFromPayload(payload.error, { scope: "sessions", sessionId: payload.threadId }));
    });
    onRevisioned<{ tasks?: unknown }>(events, "health", (payload) => {
      if (!payload || !Array.isArray(payload.tasks)) return;
      for (const task of payload.tasks) {
        if (!isRecord(task)) continue;
        const error = task.error as ServerErrorPayload | null | undefined;
        if (error) optionsRef.current.onError?.(apiErrorFromPayload(error, { scope: "background" }));
      }
    });
    onRevisioned<{ action?: unknown; threadId?: unknown; reason?: unknown }>(events, "threads", (payload) => {
      if (!payload || typeof payload.threadId !== "string" || !["created", "updated", "removed"].includes(String(payload.action))) return;
      if (payload.action === "removed") {
        removedSessions.markRemoved(payload.threadId);
        const terminalTimer = terminalTimers.get(payload.threadId);
        if (terminalTimer) clearTimeout(terminalTimer);
        terminalTimers.delete(payload.threadId);
        automaticErrors.resolve(`detail:${payload.threadId}`);
        delete textDeltas[payload.threadId];
        delete toolDeltas[payload.threadId];
        delete pendingTruncations[payload.threadId];
        threadStore.removeThread(payload.threadId);
        optionsRef.current.onThreadRemoved?.(payload.threadId);
      } else if (reversesSessionRemoval(payload.action, payload.reason)) {
        // Ordinary late updates can still arrive while archival is in flight;
        // only a create, restore, or compensated archive failure revives it.
        removedSessions.markPresent(payload.threadId);
      }
      scheduleInventory(payload.action === "removed" ? 0 : 250);
    });
    onRevisioned<{ method?: unknown; params?: unknown }>(events, "codex", (notification, revision) => {
      if (!notification || typeof notification.method !== "string" || !isRecord(notification.params)) return;
      const params = notification.params;
      const threadId = typeof params.threadId === "string" ? params.threadId : null;
      if (removedSessions.has(threadId)) return;
      if (notification.method === "item/agentMessage/delta" && threadId) {
        queueDelta("text", threadId, String(params.itemId), String(params.delta || ""), revision);
        return;
      }
      if (["item/commandExecution/outputDelta", "item/fileChange/outputDelta", "command/exec/outputDelta"].includes(notification.method) && threadId) {
        queueDelta("tool", threadId, String(params.itemId || params.processId || "command"), String(params.delta || ""), revision);
        return;
      }
      // Preserve wire order when a lifecycle event follows buffered text/output.
      flushNow();
      if ((notification.method === "item/started" || notification.method === "item/completed") && threadId && isRecord(params.item)) {
        threadStore.applyEvent({
          type: "live/item",
          threadId,
          revision,
          item: params.item as ThreadItem,
          completed: notification.method === "item/completed"
        });
      }
      if (notification.method === "thread/status/changed" && threadId && isRecord(params.status)) {
        const status = params.status as Thread["status"];
        threadStore.applyEvent(status.type === "active"
          ? { type: "live/started", threadId, revision }
          : { type: "live/status", threadId, revision, status });
        if (status.type !== "active") reconcileTerminal(threadId);
      }
      if (notification.method === "turn/started" && threadId) {
        threadStore.applyEvent({ type: "live/started", threadId, revision });
      }
      if (notification.method === "turn/completed" && threadId) {
        const turn = isRecord(params.turn) ? params.turn : null;
        const completedAt = typeof turn?.completedAt === "string" || typeof turn?.completedAt === "number"
          ? timestampToEpochMs(turn.completedAt)
          : Date.now();
        threadStore.applyEvent({ type: "live/completed", threadId, revision, completedAt });
        const status = typeof turn?.status === "string" ? turn.status : "completed";
        if (status === "failed") {
          const turnError = isRecord(turn?.error) && typeof turn.error.message === "string" ? turn.error.message : undefined;
          optionsRef.current.onNotification?.({ kind: "failed", threadId, message: turnError });
        } else if (status !== "interrupted") {
          optionsRef.current.onNotification?.({ kind: "completed", threadId });
        }
        reconcileTerminal(threadId);
      }
      if (notification.method === "thread/tokenUsage/updated" && threadId) {
        const usage = normalizeUsage(isRecord(params.tokenUsage) ? params.tokenUsage.total : null);
        if (usage) threadStore.applyEvent({ type: "live/token-usage", threadId, revision, tokenUsage: usage });
      }
      if (notification.method === "account/rateLimits/updated") {
        void optionsRef.current.refreshStatus()
          .then(() => automaticErrors.resolve("status"))
          .catch((error) => reportAutomaticError("status", error));
      }
      // Lifecycle/item payloads are authoritative in-turn. Full thread history is
      // reconciled only by reconnect/gap recovery, explicit UI actions, or terminal.
      if (/^(thread|turn)\//.test(notification.method)) scheduleInventory(400);
    });
    onRevisioned<{ threadId?: unknown; state?: unknown; completedAt?: unknown; error?: unknown }>(events, "claude-turn", (snapshot, revision) => {
      if (!snapshot || typeof snapshot.threadId !== "string") return;
      if (removedSessions.has(snapshot.threadId)) return;
      const terminal = snapshot.state === "completed" || snapshot.state === "failed";
      threadStore.applyEvent(terminal
        ? {
          type: "live/completed",
          threadId: snapshot.threadId,
          revision,
          completedAt: typeof snapshot.completedAt === "string" || typeof snapshot.completedAt === "number"
            ? timestampToEpochMs(snapshot.completedAt)
            : Date.now()
        }
        : { type: "live/started", threadId: snapshot.threadId, revision });
      if (terminal) {
        optionsRef.current.onNotification?.({
          kind: snapshot.state === "failed" ? "failed" : "completed",
          threadId: snapshot.threadId,
          message: typeof snapshot.error === "string" && snapshot.error ? snapshot.error : undefined
        });
        reconcileTerminal(snapshot.threadId);
      }
    });
    onRevisioned<{ threadId?: unknown; items?: unknown }>(events, "claude-output", (payload, revision) => {
      if (!payload || typeof payload.threadId !== "string" || !Array.isArray(payload.items)) return;
      flushNow();
      const items = payload.items.filter((item): item is ThreadItem => isRecord(item) && typeof item.type === "string");
      for (const [index, item] of items.entries()) {
        threadStore.applyEvent({
          type: "live/item",
          threadId: payload.threadId,
          ...(index === 0 ? { revision } : {}),
          item,
          completed: item.status !== "inProgress"
        });
      }
    });
    onRevisioned<{ threadId?: unknown; reason?: unknown; guardian?: unknown }>(events, "guardian", (payload) => {
      if (!payload || typeof payload.threadId !== "string" || !isRecord(payload.guardian)) return;
      if (removedSessions.has(payload.threadId)) return;
      const guardian = payload.guardian as RunGuardianState;
      threadStore.setGuardian(payload.threadId, guardian);
      if (guardian.phase === "paused" && payload.reason === "operator-escalation") {
        optionsRef.current.onNotification?.({
          kind: "failed",
          threadId: payload.threadId,
          message: "Run Guardian exhausted recovery attempts and paused this session."
        });
      }
      scheduleInventory(0);
    });
    }
    function openStream() {
      if (disposed || navigator.onLine === false) return;
      closeStream();
      updateTransport("reconnecting");
      const generation = streamGeneration;
      let events: EventSource;
      try {
        events = new EventSource(eventStreamUrl(clientIdRef.current!, optionsRef.current.subscribedThreadIds));
      } catch {
        startFallback();
        scheduleReconnect();
        return;
      }
      stream = events;
      attachListeners(events, generation);
      connectTimer = window.setTimeout(() => handleStreamFailure(events), SSE_CONNECT_TIMEOUT_MS);
    }
    const manualReconnect = () => {
      if (disposed || streamConnected || navigator.onLine === false) return;
      clearRetry();
      closeStream();
      updateTransport("reconnecting");
      startFallback();
      scheduleReconnect(true);
    };
    const handleOffline = () => {
      clearRetry();
      closeStream();
      updateTransport("offline");
      startFallback();
    };
    const handleOnline = () => {
      updateTransport("reconnecting");
      startFallback();
      scheduleReconnect(true);
    };

    reconnectRef.current = manualReconnect;
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    if (navigator.onLine === false) handleOffline();
    else openStream();

    return () => {
      disposed = true;
      reconnectRef.current = () => undefined;
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      closeStream();
      stopFallback();
      clearRetry();
      if (listTimer) clearTimeout(listTimer);
      if (flushTimer) clearTimeout(flushTimer);
      for (const timer of terminalTimers.values()) clearTimeout(timer);
    };
  }, [options.enabled, replacePending, resolvePending]);

  useEffect(() => {
    if (!options.enabled) return;
    let disposed = false;
    const threadIds = subscriptionSignature ? subscriptionSignature.split(",") : [];
    const sync = subscriptionSyncRef.current
      .catch(() => undefined)
      .then(async () => {
        await api(`/api/events/subscriptions/${encodeURIComponent(clientIdRef.current!)}`, {
          method: "PUT",
          body: JSON.stringify({ threadIds })
        });
        automaticErrorsRef.current.resolve("subscriptions");
      });
    subscriptionSyncRef.current = sync;
    void sync.catch((error) => {
      if (!disposed) {
        automaticErrorsRef.current.report("subscriptions", error, (caught) => optionsRef.current.onError?.(caught));
      }
    });
    return () => { disposed = true; };
  }, [options.enabled, subscriptionSignature]);

  const reconnect = useCallback(() => reconnectRef.current(), []);
  return { backendHealth, transport, lastSyncedAt, nextReconnectAt, reconnect, pending, replacePending, resolvePending };
}

export function eventStreamUrl(clientId: string, threadIds: readonly string[]): string {
  const params = new URLSearchParams({ clientId });
  for (const threadId of [...new Set(threadIds)].sort()) params.append("threadId", threadId);
  return `/events?${params.toString()}`;
}

function createEventStreamClientId(): string {
  return globalThis.crypto?.randomUUID?.() || `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function parseEnvelope<T>(name: string, event: Event): (SseEnvelope & { payload: T }) | null {
  const message = event as MessageEvent<unknown>;
  if (typeof message.data !== "string" || !isSseEventName(name)) return null;
  try {
    return parseSseEnvelope(name as SseEventName, JSON.parse(message.data) as unknown, message.lastEventId) as SseEnvelope & { payload: T };
  } catch {
    return null;
  }
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function automaticErrorSignature(error: unknown): string {
  const record = isRecord(error) ? error : {};
  return [
    error instanceof Error ? error.name : typeof record.name === "string" ? record.name : "Error",
    error instanceof Error ? error.message : typeof record.message === "string" ? record.message : String(error),
    typeof record.type === "string" ? record.type : "",
    typeof record.code === "string" ? record.code : "",
    typeof record.scope === "string" ? record.scope : "",
    typeof record.sessionId === "string" ? record.sessionId : ""
  ].join("|");
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function boundPendingThread(agentText: Record<string, string>, toolOutput: Record<string, string>): string[] {
  const truncated: string[] = [];
  const size = () => textEncoder.encode(JSON.stringify({ agentText, toolOutput })).byteLength;
  while (size() > LIVE_OUTPUT_BUDGET_BYTES) {
    const candidates = [
      ...Object.keys(agentText).map((itemId) => ({ target: agentText, itemId })),
      ...Object.keys(toolOutput).map((itemId) => ({ target: toolOutput, itemId }))
    ];
    if (!candidates.length) break;
    const candidate = candidates[0];
    if (candidates.length > 1) {
      delete candidate.target[candidate.itemId];
      truncated.push(candidate.itemId);
      continue;
    }
    const current = candidate.target[candidate.itemId];
    const encoded = textEncoder.encode(current);
    const desired = Math.max(0, encoded.byteLength - (size() - LIVE_OUTPUT_BUDGET_BYTES) - 16);
    const value = desired > 0
      ? textDecoder.decode(encoded.slice(encoded.byteLength - desired)).replace(/^\uFFFD+/, "")
      : "";
    if (value) candidate.target[candidate.itemId] = value;
    else delete candidate.target[candidate.itemId];
    truncated.push(candidate.itemId);
  }
  return truncated;
}

function normalizeUsage(value: unknown): ThreadTokenUsage | null {
  if (!isRecord(value) || typeof value.totalTokens !== "number" || !Number.isFinite(value.totalTokens)) return null;
  const read = (key: string) => typeof value[key] === "number" && Number.isFinite(value[key]) ? Math.max(0, Number(value[key])) : undefined;
  return {
    totalTokens: Math.max(0, value.totalTokens),
    inputTokens: read("inputTokens"),
    outputTokens: read("outputTokens"),
    cachedInputTokens: read("cachedInputTokens"),
    reasoningOutputTokens: read("reasoningOutputTokens")
  };
}

function samePending(left: PendingRequest[], right: PendingRequest[]): boolean {
  return left.length === right.length && left.every((request, index) => request.id === right[index]?.id
    && request.method === right[index].method && request.receivedAt === right[index].receivedAt);
}
