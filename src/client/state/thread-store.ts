import { useSyncExternalStore } from "react";
import { timestampNow, timestampToEpochMs } from "../../shared/contracts";
import { notificationPreferences } from "./preferences";
import type {
  ClaudeModelOption, CodexModel, LiveThreadState, QueueEntry, SessionSettings,
  LiveRecoverySnapshot, RunGuardianState, Thread, ThreadItem, ThreadStatus, ThreadTokenUsage
} from "../types";

export const LIVE_OUTPUT_BUDGET_BYTES = 384 * 1024;
const MAX_DETAIL_SNAPSHOTS = 60;

export type ThreadLiveSnapshot = {
  agentText: Readonly<Record<string, string>>;
  toolOutput: Readonly<Record<string, string>>;
  items: Readonly<Record<string, ThreadItem>>;
  status: ThreadStatus | null;
  queue: readonly QueueEntry[];
  completed: boolean;
  completedAt: number | null;
  tokenUsage: ThreadTokenUsage | null;
  truncated: boolean;
  truncatedItemIds: readonly string[];
};

type ThreadLocalUiSlice = {
  completionSeenThrough: number;
};

type ThreadDomainSlices = {
  /** Full or summary resources read from authoritative HTTP snapshots. */
  authoritative: { summary: Thread | null; detail: Thread | null };
  /** Revisioned, transient state projected directly from SSE snapshots and deltas. */
  liveOverlay: ThreadLiveSnapshot;
  /** Browser-only presentation state which server snapshots never overwrite. */
  localUi: ThreadLocalUiSlice;
  revision: number;
};

type EventBase = { threadId: string; revision?: number };
type NormalizedThreadEvent = EventBase & (
  | { type: "live/snapshot"; state: LiveThreadState; queue: readonly QueueEntry[] }
  | { type: "live/agent-text"; deltas: Readonly<Record<string, string>> }
  | { type: "live/tool-output"; deltas: Readonly<Record<string, string>> }
  | { type: "live/item"; item: ThreadItem; completed: boolean }
  | { type: "live/status"; status: ThreadStatus }
  | { type: "live/started" }
  | { type: "live/completed"; completedAt: number }
  | { type: "live/queue"; queue: readonly QueueEntry[] }
  | { type: "live/token-usage"; tokenUsage: ThreadTokenUsage }
  | { type: "live/truncated"; itemIds: readonly string[] }
  | { type: "live/clear-transient" }
  | { type: "ui/completion-seen" }
);

const EMPTY_RECORD = Object.freeze({}) as Readonly<Record<string, never>>;
const EMPTY_LIVE: ThreadLiveSnapshot = Object.freeze({
  agentText: EMPTY_RECORD,
  toolOutput: EMPTY_RECORD,
  items: EMPTY_RECORD,
  status: null,
  queue: Object.freeze([]),
  completed: false,
  completedAt: null,
  tokenUsage: null,
  truncated: false,
  truncatedItemIds: Object.freeze([])
});

type Listener = () => void;

class ThreadStore {
  private summaries = new Map<string, Thread>();
  private summaryOrder: string[] = [];
  private inventorySnapshot: readonly Thread[] = Object.freeze([]);
  private details = new Map<string, Thread>();
  // These maps are deliberately separate authorities: HTTP entities, revisioned
  // live overlays, and local UI state must never overwrite one another implicitly.
  private live = new Map<string, ThreadLiveSnapshot>();
  private liveRevisions = new Map<string, number>();
  private completionSeenThrough = new Map<string, number>();
  private activeIds: ReadonlySet<string> = new Set();
  private inventoryListeners = new Set<Listener>();
  private activeListeners = new Set<Listener>();
  private threadListeners = new Map<string, Set<Listener>>();

  subscribeInventory = (listener: Listener): (() => void) => {
    this.inventoryListeners.add(listener);
    return () => this.inventoryListeners.delete(listener);
  };

  subscribeActive = (listener: Listener): (() => void) => {
    this.activeListeners.add(listener);
    return () => this.activeListeners.delete(listener);
  };

  subscribeThread = (threadId: string, listener: Listener): (() => void) => {
    const listeners = this.threadListeners.get(threadId) || new Set<Listener>();
    listeners.add(listener);
    this.threadListeners.set(threadId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.threadListeners.delete(threadId);
    };
  };

  getInventory = (): readonly Thread[] => this.inventorySnapshot;
  getActiveIds = (): ReadonlySet<string> => this.activeIds;
  getSummary = (threadId: string): Thread | null => this.summaries.get(threadId) || null;
  getDetail = (threadId: string): Thread | null => this.details.get(threadId) || null;
  getLive = (threadId: string): ThreadLiveSnapshot => this.live.get(threadId) || EMPTY_LIVE;
  getDomainSlices = (threadId: string): ThreadDomainSlices => ({
    authoritative: { summary: this.getSummary(threadId), detail: this.getDetail(threadId) },
    liveOverlay: this.getLive(threadId),
    localUi: { completionSeenThrough: this.completionSeenThrough.get(threadId) || 0 },
    revision: this.liveRevisions.get(threadId) || 0
  });

  replaceSummaries(threads: Thread[]): void {
    const next = new Map<string, Thread>();
    let changed = threads.length !== this.summaryOrder.length;
    for (let index = 0; index < threads.length; index += 1) {
      const incoming = threads[index];
      const current = this.summaries.get(incoming.id);
      const summary = reconcileThread(current, incoming);
      next.set(summary.id, summary);
      if (!changed && (this.summaryOrder[index] !== summary.id || this.summaries.get(summary.id) !== summary)) changed = true;
    }
    if (!changed) return;
    const previous = this.summaries;
    const removedIds = [...previous.keys()].filter((id) => !next.has(id));
    this.summaries = next;
    this.summaryOrder = threads.map((thread) => thread.id);
    this.inventorySnapshot = Object.freeze(this.summaryOrder.map((id) => next.get(id)!));
    for (const [id, summary] of next) {
      if (previous.get(id) !== summary) this.emitThread(id);
    }
    for (const id of removedIds) {
      this.details.delete(id);
      this.live.delete(id);
      this.liveRevisions.delete(id);
      this.completionSeenThrough.delete(id);
      this.emitThread(id);
    }
    if (removedIds.length) this.replaceActive([...this.activeIds].filter((id) => next.has(id)));
    this.emitInventory();
  }

  mergeSummaries(threads: readonly Thread[]): void {
    if (!threads.length) return;
    let summaries = this.summaries;
    let order = this.summaryOrder;
    const changedIds: string[] = [];
    for (const thread of threads) {
      const current = summaries.get(thread.id);
      const reconciled = reconcileThread(current, thread);
      if (current === reconciled) continue;
      if (summaries === this.summaries) summaries = new Map(this.summaries);
      summaries.set(thread.id, reconciled);
      if (!current) {
        if (order === this.summaryOrder) order = [...this.summaryOrder];
        order.push(thread.id);
      }
      changedIds.push(thread.id);
    }
    if (!changedIds.length) return;
    this.summaries = summaries;
    this.summaryOrder = order;
    this.inventorySnapshot = Object.freeze(order.map((id) => summaries.get(id)!).filter(Boolean));
    for (const id of changedIds) this.emitThread(id);
    this.emitInventory();
  }

  upsertSummary(thread: Thread): void {
    const current = this.summaries.get(thread.id);
    const reconciled = reconcileThread(current, thread);
    if (current === reconciled) return;
    if (!current) this.summaryOrder = [...this.summaryOrder, thread.id];
    this.summaries = new Map(this.summaries).set(thread.id, reconciled);
    this.inventorySnapshot = Object.freeze(this.summaryOrder.map((id) => this.summaries.get(id)!).filter(Boolean));
    this.emitThread(thread.id);
    this.emitInventory();
  }

  upsertDetail(thread: Thread): void {
    const current = this.details.get(thread.id);
    const reconciled = reconcileThread(current, thread);
    if (current === reconciled) {
      if (this.reconcileCanonicalDetail(thread)) this.emitThread(thread.id);
      return;
    }
    this.details = new Map(this.details);
    this.details.delete(thread.id);
    this.details.set(thread.id, reconciled);
    while (this.details.size > MAX_DETAIL_SNAPSHOTS) {
      const oldest = this.details.keys().next().value as string | undefined;
      if (!oldest) break;
      this.details.delete(oldest);
    }
    this.reconcileCanonicalDetail(thread);
    this.emitThread(thread.id);
  }

  removeThread(threadId: string): void {
    const hadSummary = this.summaries.has(threadId);
    if (hadSummary) {
      this.summaries = new Map(this.summaries);
      this.summaries.delete(threadId);
      this.summaryOrder = this.summaryOrder.filter((id) => id !== threadId);
      this.inventorySnapshot = Object.freeze(this.summaryOrder.map((id) => this.summaries.get(id)!).filter(Boolean));
    }
    this.details.delete(threadId);
    this.live.delete(threadId);
    this.liveRevisions.delete(threadId);
    this.completionSeenThrough.delete(threadId);
    this.setActive(threadId, false);
    this.emitThread(threadId);
    if (hadSummary) this.emitInventory();
  }

  hydrateLiveState(state: Record<string, LiveThreadState>, activeThreadIds: readonly string[] = []): void {
    const activeIds = new Set(activeThreadIds);
    for (const [threadId, incoming] of Object.entries(state)) {
      if (incoming.active) activeIds.add(threadId);
      this.applyEvent({
        type: "live/snapshot",
        threadId,
        state: { ...incoming, active: activeIds.has(threadId) },
        queue: this.getLive(threadId).queue
      });
    }
    this.replaceActive(activeIds);
  }

  /** Applies an authoritative recovery boundary through the same reducer as live deltas. */
  applyRecoverySnapshot(snapshot: LiveRecoverySnapshot): void {
    const activeIds = new Set(snapshot.activeThreadIds);
    const requestedIds = new Set([...Object.keys(snapshot.data), ...Object.keys(snapshot.queues)]);
    for (const threadId of requestedIds) {
      const state = snapshot.data[threadId] || emptyLiveThreadState(activeIds.has(threadId));
      this.applyEvent({
        type: "live/snapshot",
        threadId,
        revision: snapshot.threadRevisions?.[threadId] ?? snapshot.revision,
        state: { ...state, active: activeIds.has(threadId) },
        queue: snapshot.queues[threadId] || []
      });
    }
  }

  applyEvent(event: NormalizedThreadEvent): boolean {
    const currentRevision = this.liveRevisions.get(event.threadId) || 0;
    if (event.revision !== undefined) {
      if (event.revision < currentRevision || (event.revision === currentRevision && event.type !== "live/snapshot")) return false;
      this.liveRevisions.set(event.threadId, event.revision);
    }
    if (event.type === "ui/completion-seen") {
      const completedAt = this.getLive(event.threadId).completedAt || Date.now();
      this.completionSeenThrough.set(event.threadId, Math.max(this.completionSeenThrough.get(event.threadId) || 0, completedAt));
    }
    const current = this.getLive(event.threadId);
    const next = reduceNormalizedThreadEvent(current, event, this.completionSeenThrough.get(event.threadId) || 0);
    if (next !== current) this.commitLive(event.threadId, next);
    const active = next.status?.type === "active";
    if (this.activeIds.has(event.threadId) !== active && event.type !== "ui/completion-seen") this.setActive(event.threadId, active);
    return true;
  }

  replaceActive(threadIds: Iterable<string>): void {
    const next = new Set(threadIds);
    if (sameSet(this.activeIds, next)) return;
    const previous = this.activeIds;
    this.activeIds = next;
    for (const id of new Set([...previous, ...next])) {
      if (previous.has(id) === next.has(id)) continue;
      if (!next.has(id) && !this.summaries.has(id)) continue;
      const current = this.getLive(id);
      this.commitLive(id, {
        ...current,
        status: next.has(id) ? { type: "active", activeFlags: [] } : current.status?.type === "active" ? { type: "idle" } : current.status
      });
    }
    for (const listener of this.activeListeners) listener();
  }

  setActive(threadId: string, active: boolean): void {
    if (this.activeIds.has(threadId) === active) return;
    const next = new Set(this.activeIds);
    active ? next.add(threadId) : next.delete(threadId);
    this.replaceActive(next);
  }

  setStatus(threadId: string, status: ThreadStatus): void {
    this.applyEvent({ type: "live/status", threadId, status });
  }

  markStarted(threadId: string): void {
    this.applyEvent({ type: "live/started", threadId });
  }

  markCompleted(threadId: string, completedAt = Date.now()): void {
    this.applyEvent({ type: "live/completed", threadId, completedAt });
  }

  markCompletionSeen(threadId: string): void {
    if (this.getLive(threadId).completed) this.applyEvent({ type: "ui/completion-seen", threadId });
  }

  appendAgentText(threadId: string, itemId: string, delta: string): void {
    this.appendAgentTextDeltas(threadId, { [itemId]: delta });
  }

  appendAgentTextDeltas(threadId: string, deltas: Readonly<Record<string, string>>): void {
    this.applyEvent({ type: "live/agent-text", threadId, deltas });
  }

  appendToolOutput(threadId: string, itemId: string, delta: string): void {
    this.appendToolOutputDeltas(threadId, { [itemId]: delta });
  }

  appendToolOutputDeltas(threadId: string, deltas: Readonly<Record<string, string>>): void {
    this.applyEvent({ type: "live/tool-output", threadId, deltas });
  }

  upsertLiveItem(threadId: string, item: ThreadItem): void {
    this.applyEvent({ type: "live/item", threadId, item, completed: item.status !== "inProgress" });
  }

  markLiveTruncated(threadId: string, itemIds: readonly string[]): void {
    this.applyEvent({ type: "live/truncated", threadId, itemIds });
  }

  setQueue(threadId: string, queue: QueueEntry[]): void {
    this.applyEvent({ type: "live/queue", threadId, queue });
  }

  setTokenUsage(threadId: string, tokenUsage: ThreadTokenUsage): void {
    this.applyEvent({ type: "live/token-usage", threadId, tokenUsage });
  }

  setGuardian(threadId: string, guardian: RunGuardianState): void {
    const summary = this.getSummary(threadId);
    const detail = this.getDetail(threadId);
    if (summary) this.upsertSummary({ ...summary, guardian });
    if (detail) this.upsertDetail({ ...detail, guardian });
  }

  clearTransient(threadId: string): void {
    this.applyEvent({ type: "live/clear-transient", threadId });
  }

  private commitLive(threadId: string, next: ThreadLiveSnapshot): void {
    const bounded = boundLiveSnapshot(next);
    if (this.live.get(threadId) === bounded) return;
    this.live.set(threadId, bounded);
    this.emitThread(threadId);
  }

  private reconcileCanonicalDetail(thread: Thread): boolean {
    const current = this.live.get(thread.id);
    if (!current) return false;
    const canonicalItems = new Map(thread.turns.flatMap((turn) => turn.items).filter((item) => item.id).map((item) => [item.id!, item]));
    const recoveredIds = new Set([...canonicalItems.entries()].filter(([, item]) => hasAuthoritativeOutput(item)).map(([itemId]) => itemId));
    const agentText = withoutKeys(current.agentText, recoveredIds);
    const toolOutput = withoutKeys(current.toolOutput, recoveredIds);
    const items = withoutKeys(current.items, new Set(canonicalItems.keys()));
    if (agentText === current.agentText && toolOutput === current.toolOutput && items === current.items && !current.truncated) return false;
    this.live.set(thread.id, {
      ...current,
      agentText,
      toolOutput,
      items,
      truncated: false,
      truncatedItemIds: Object.freeze([])
    });
    return true;
  }

  private emitInventory(): void { for (const listener of this.inventoryListeners) listener(); }
  private emitThread(threadId: string): void { for (const listener of this.threadListeners.get(threadId) || []) listener(); }
}

export const threadStore = new ThreadStore();

export function useThreadInventorySnapshot(): readonly Thread[] {
  return useSyncExternalStore(threadStore.subscribeInventory, threadStore.getInventory, threadStore.getInventory);
}

export function useActiveThreadIds(): ReadonlySet<string> {
  return useSyncExternalStore(threadStore.subscribeActive, threadStore.getActiveIds, threadStore.getActiveIds);
}

export function useThreadSummary(threadId: string): Thread | null {
  return useSyncExternalStore(
    (listener) => threadStore.subscribeThread(threadId, listener),
    () => threadStore.getSummary(threadId),
    () => threadStore.getSummary(threadId)
  );
}

export function useThreadDetail(threadId: string): Thread | null {
  return useSyncExternalStore(
    (listener) => threadStore.subscribeThread(threadId, listener),
    () => threadStore.getDetail(threadId),
    () => threadStore.getDetail(threadId)
  );
}

export function useThreadLiveState(threadId: string): ThreadLiveSnapshot {
  return useSyncExternalStore(
    (listener) => threadStore.subscribeThread(threadId, listener),
    () => threadStore.getLive(threadId),
    () => threadStore.getLive(threadId)
  );
}

/** Resolve server-persisted settings before local overrides or account defaults. */
export function settingsFromThread(thread: Thread): Partial<SessionSettings> {
  const metadata = thread.sessionMetadata || thread.metadata || thread.settings;
  const model = metadata?.model || thread.model || thread.claudeModel || undefined;
  const effort = metadata?.effort || thread.effort || thread.claudeEffort || undefined;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

export function normalizeThreadSettings(
  thread: Thread,
  models: readonly CodexModel[],
  claudeModels: readonly ClaudeModelOption[],
  local: SessionSettings | undefined,
  defaultModel?: CodexModel
): SessionSettings {
  const notifications = notificationPreferences(local);
  if (thread.sessionClass === "spark") return { model: "gpt-5.3-codex-spark", effort: "high", notifications };
  const persisted = settingsFromThread(thread);
  if (thread.backend === "claude") {
    const allowedModels = new Set(claudeModels.map((model) => model.model));
    const model = allowedModels.has(local?.model || "") ? local!.model
      : allowedModels.has(persisted.model || "") ? persisted.model!
      : claudeModels[0]?.model || "";
    const candidateEffort = local?.effort || persisted.effort || "high";
    const effort = ["low", "medium", "high", "max"].includes(candidateEffort) ? candidateEffort : "high";
    return { model, effort, notifications };
  }
  const persistedModel = models.find((candidate) => candidate.model === persisted.model || candidate.id === persisted.model);
  const localModel = models.find((candidate) => candidate.model === local?.model || candidate.id === local?.model);
  const selected = localModel || persistedModel || defaultModel || models[0];
  if (!selected) return { model: "", effort: "", notifications };
  const efforts = new Set(selected.supportedReasoningEfforts.map((option) => option.reasoningEffort));
  const candidateEffort = localModel ? local?.effort : persistedModel ? persisted.effort : undefined;
  const effort = candidateEffort && efforts.has(candidateEffort) ? candidateEffort : selected.defaultReasoningEffort;
  return { model: selected.model, effort, notifications };
}

/** Apply persisted metadata over a validated local cache/override. */
export function resolveThreadSettings(
  thread: Thread,
  models: readonly CodexModel[],
  claudeModels: readonly ClaudeModelOption[],
  local: SessionSettings | undefined,
  defaultModel?: CodexModel
): SessionSettings {
  const persisted = settingsFromThread(thread);
  if (!persisted.model && !persisted.effort) return normalizeThreadSettings(thread, models, claudeModels, local, defaultModel);
  const model = persisted.model || local?.model || "";
  const effort = persisted.effort || (local?.model === model ? local.effort : "");
  return normalizeThreadSettings(thread, models, claudeModels, { model, effort, notifications: local?.notifications }, defaultModel);
}

/** The sole reducer for recovery snapshots, SSE deltas, and local presentation actions. */
function reduceNormalizedThreadEvent(
  current: ThreadLiveSnapshot,
  event: NormalizedThreadEvent,
  completionSeenThrough = 0
): ThreadLiveSnapshot {
  if (event.type === "live/snapshot") {
    const completedAt = event.state.active || !event.state.completedAt ? null : timestampToEpochMs(event.state.completedAt);
    const agentText = stableRecord(current.agentText, event.state.agentText, Object.is);
    const toolOutput = stableRecord(current.toolOutput, event.state.toolOutput, Object.is);
    const items = stableRecord(current.items, event.state.items, sameItem);
    const status: ThreadStatus = event.state.active
      ? { type: "active", activeFlags: [] }
      : current.status?.type === "systemError" ? current.status : { type: "idle" };
    const queue = sameQueue(current.queue, event.queue) ? current.queue : event.queue;
    const tokenUsage = sameNullableUsage(current.tokenUsage, event.state.tokenUsage) ? current.tokenUsage : event.state.tokenUsage;
    const truncatedItemIds = sameArray(current.truncatedItemIds, event.state.truncatedItemIds) ? current.truncatedItemIds : event.state.truncatedItemIds;
    const completed = Boolean(completedAt && completedAt > completionSeenThrough);
    if (agentText === current.agentText && toolOutput === current.toolOutput && items === current.items
      && sameStatusOrNull(current.status, status) && queue === current.queue && tokenUsage === current.tokenUsage
      && completed === current.completed && completedAt === current.completedAt
      && current.truncated === event.state.truncated && truncatedItemIds === current.truncatedItemIds) return current;
    return {
      agentText, toolOutput, items, status, queue, tokenUsage, completed, completedAt,
      truncated: event.state.truncated,
      truncatedItemIds
    };
  }
  if (event.type === "live/agent-text" || event.type === "live/tool-output") {
    const source = event.type === "live/agent-text" ? current.agentText : current.toolOutput;
    let next = source;
    for (const [itemId, delta] of Object.entries(event.deltas)) {
      if (!delta) continue;
      if (next === source) next = { ...source };
      (next as Record<string, string>)[itemId] = `${next[itemId] || ""}${delta}`;
    }
    if (next === source) return current;
    return event.type === "live/agent-text" ? { ...current, agentText: next } : { ...current, toolOutput: next };
  }
  if (event.type === "live/item") {
    if (!event.item.id) return current;
    const itemId = event.item.id;
    const itemChanged = !sameItem(current.items[itemId], event.item);
    const authoritative = event.completed && hasAuthoritativeOutput(event.item);
    const removeText = authoritative && Object.prototype.hasOwnProperty.call(current.agentText, itemId);
    const removeTool = authoritative && Object.prototype.hasOwnProperty.call(current.toolOutput, itemId);
    if (!itemChanged && !removeText && !removeTool) return current;
    const agentText = removeText ? withoutKey(current.agentText, itemId) : current.agentText;
    const toolOutput = removeTool ? withoutKey(current.toolOutput, itemId) : current.toolOutput;
    return {
      ...current,
      agentText,
      toolOutput,
      items: itemChanged ? { ...current.items, [itemId]: event.item } : current.items
    };
  }
  if (event.type === "live/status") {
    const active = event.status.type === "active";
    if (sameStatusOrNull(current.status, event.status) && (!active || (!current.completed && current.completedAt === null))) return current;
    return { ...current, status: event.status, completed: active ? false : current.completed, completedAt: active ? null : current.completedAt };
  }
  if (event.type === "live/started") {
    if (current.status?.type === "active" && !current.completed && current.completedAt === null) return current;
    return { ...current, status: { type: "active", activeFlags: [] }, completed: false, completedAt: null };
  }
  if (event.type === "live/completed") {
    const completed = event.completedAt > completionSeenThrough;
    if (current.status?.type === "idle" && current.completed === completed && current.completedAt === event.completedAt) return current;
    return { ...current, status: { type: "idle" }, completed, completedAt: event.completedAt };
  }
  if (event.type === "live/queue") return sameQueue(current.queue, event.queue) ? current : { ...current, queue: event.queue };
  if (event.type === "live/token-usage") return sameUsage(current.tokenUsage, event.tokenUsage) ? current : { ...current, tokenUsage: event.tokenUsage };
  if (event.type === "live/truncated") {
    const itemIds = uniqueIds([...current.truncatedItemIds, ...event.itemIds]).slice(-64);
    return current.truncated && sameArray(current.truncatedItemIds, itemIds)
      ? current : { ...current, truncated: true, truncatedItemIds: itemIds };
  }
  if (event.type === "live/clear-transient") {
    return !Object.keys(current.agentText).length && !Object.keys(current.toolOutput).length && !Object.keys(current.items).length
      ? current : { ...current, agentText: EMPTY_RECORD, toolOutput: EMPTY_RECORD, items: EMPTY_RECORD };
  }
  return current.completed ? { ...current, completed: false } : current;
}

function emptyLiveThreadState(active: boolean): LiveThreadState {
  return {
    items: {}, agentText: {}, toolOutput: {}, active, completedAt: null, updatedAt: timestampNow(),
    tokenUsage: null, truncated: false, truncatedItemIds: []
  };
}

function stableRecord<T>(
  current: Readonly<Record<string, T>>,
  incoming: Readonly<Record<string, T>>,
  equal: (left: T | undefined, right: T) => boolean
): Readonly<Record<string, T>> {
  const currentKeys = Object.keys(current);
  const incomingKeys = Object.keys(incoming);
  if (currentKeys.length === incomingKeys.length && incomingKeys.every((key, index) => key === currentKeys[index] && equal(current[key], incoming[key]))) return current;
  return { ...incoming };
}

function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
  const next = { ...record };
  delete next[key];
  return next;
}

function withoutKeys<T>(record: Readonly<Record<string, T>>, keys: ReadonlySet<string>): Readonly<Record<string, T>> {
  if (![...keys].some((key) => Object.prototype.hasOwnProperty.call(record, key))) return record;
  const next = { ...record };
  for (const key of keys) delete next[key];
  return next;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const TRUNCATION_MARKER = "…[earlier output truncated]\n";

export function liveOutputByteSize(snapshot: Pick<ThreadLiveSnapshot, "items" | "agentText" | "toolOutput">): number {
  return textEncoder.encode(JSON.stringify({
    items: snapshot.items,
    agentText: snapshot.agentText,
    toolOutput: snapshot.toolOutput
  })).byteLength;
}

function boundLiveSnapshot(snapshot: ThreadLiveSnapshot, maximum = LIVE_OUTPUT_BUDGET_BYTES): ThreadLiveSnapshot {
  if (liveOutputByteSize(snapshot) <= maximum) return snapshot;
  let items: Readonly<Record<string, ThreadItem>> = { ...snapshot.items };
  let agentText: Readonly<Record<string, string>> = { ...snapshot.agentText };
  let toolOutput: Readonly<Record<string, string>> = { ...snapshot.toolOutput };
  let truncatedItemIds = uniqueIds([...snapshot.truncatedItemIds]);
  const mark = (itemId: string) => {
    truncatedItemIds = uniqueIds([...truncatedItemIds, itemId]).slice(-64);
  };
  const size = () => liveOutputByteSize({ items, agentText, toolOutput });

  for (const itemId of Object.keys(items)) {
    if (size() <= maximum) break;
    items = withoutKey(items, itemId);
    mark(itemId);
  }
  while (size() > maximum) {
    const candidates = [
      ...Object.keys(agentText).map((itemId) => ({ kind: "agent" as const, itemId, value: agentText[itemId] })),
      ...Object.keys(toolOutput).map((itemId) => ({ kind: "tool" as const, itemId, value: toolOutput[itemId] }))
    ];
    if (!candidates.length) break;
    const candidate = candidates[0];
    if (candidates.length > 1) {
      if (candidate.kind === "agent") agentText = withoutKey(agentText, candidate.itemId);
      else toolOutput = withoutKey(toolOutput, candidate.itemId);
      mark(candidate.itemId);
      continue;
    }
    const currentBytes = textEncoder.encode(candidate.value).byteLength;
    const desired = Math.max(0, currentBytes - (size() - maximum) - textEncoder.encode(TRUNCATION_MARKER).byteLength - 16);
    const tail = desired > 0 ? utf8Tail(candidate.value, desired) : "";
    const value = tail ? `${TRUNCATION_MARKER}${tail}` : "";
    if (candidate.kind === "agent") {
      agentText = value ? { ...agentText, [candidate.itemId]: value } : withoutKey(agentText, candidate.itemId);
    } else {
      toolOutput = value ? { ...toolOutput, [candidate.itemId]: value } : withoutKey(toolOutput, candidate.itemId);
    }
    mark(candidate.itemId);
  }
  return { ...snapshot, items, agentText, toolOutput, truncated: true, truncatedItemIds };
}

function utf8Tail(value: string, maximumBytes: number): string {
  const encoded = textEncoder.encode(value);
  if (encoded.byteLength <= maximumBytes) return value;
  return textDecoder.decode(encoded.slice(encoded.byteLength - maximumBytes)).replace(/^\uFFFD+/, "");
}

function hasAuthoritativeOutput(item: ThreadItem): boolean {
  if (item.type === "agentMessage") return typeof item.text === "string";
  if (item.type === "commandExecution") return item.aggregatedOutput !== undefined && item.aggregatedOutput !== null;
  if (item.type === "fileChange") return Array.isArray(item.changes);
  return item.result !== undefined || item.error !== undefined || item.contentItems !== undefined;
}

function uniqueIds(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sameStatusOrNull(left: ThreadStatus | null, right: ThreadStatus | null): boolean {
  return left === right || Boolean(left && right && sameStatus(left, right));
}

function sameNullableUsage(left: ThreadTokenUsage | null, right: ThreadTokenUsage | null): boolean {
  return left === right || Boolean(right && sameUsage(left, right));
}

function sameThreadSnapshot(current: Thread | undefined, next: Thread): boolean {
  if (!current) return false;
  return current === next || (
    current.id === next.id && current.name === next.name && current.preview === next.preview
    && current.cwd === next.cwd && current.modelProvider === next.modelProvider
    && current.createdAt === next.createdAt && current.updatedAt === next.updatedAt
    && current.recencyAt === next.recencyAt && sameStatus(current.status, next.status)
    && current.backend === next.backend && current.sessionClass === next.sessionClass
    && current.model === next.model && current.effort === next.effort
    && current.settings?.model === next.settings?.model && current.settings?.effort === next.settings?.effort
    && current.policy === next.policy && current.category === next.category
    && sameArray(current.tags || [], next.tags || [])
    && current.gitInfo?.branch === next.gitInfo?.branch && current.gitInfo?.repositoryUrl === next.gitInfo?.repositoryUrl
    && current.claudeModel === next.claudeModel && current.claudeEffort === next.claudeEffort
    && current.claudePermissionMode === next.claudePermissionMode
    && current.archiveState === next.archiveState && current.pinned === next.pinned && current.queueState === next.queueState
    && current.queueDepth === next.queueDepth && current.owner === next.owner && current.source === next.source
    && current.metadata?.model === next.metadata?.model && current.metadata?.effort === next.metadata?.effort
    && current.sessionMetadata?.model === next.sessionMetadata?.model && current.sessionMetadata?.effort === next.sessionMetadata?.effort
    && current.goal?.updatedAt === next.goal?.updatedAt && current.goal?.status === next.goal?.status
    && current.goal?.tokensUsed === next.goal?.tokensUsed && current.goal?.objective === next.goal?.objective
    && current.turns.length === next.turns.length
    && current.turns.at(-1)?.id === next.turns.at(-1)?.id
    && current.turns.at(-1)?.status === next.turns.at(-1)?.status
    && current.turns.at(-1)?.items.length === next.turns.at(-1)?.items.length
    && itemRevision(current.turns.at(-1)?.items.at(-1)) === itemRevision(next.turns.at(-1)?.items.at(-1))
  );
}

function reconcileThread(current: Thread | undefined, next: Thread): Thread {
  if (!current) return next;
  if (sameThreadSnapshot(current, next)) return current;
  const turnsById = new Map(current.turns.map((turn) => [turn.id, turn]));
  const turns = next.turns.map((turn) => {
    const previous = turnsById.get(turn.id);
    if (!previous) return turn;
    const itemsById = new Map(previous.items.filter((item) => item.id).map((item) => [item.id!, item]));
    let itemsChanged = previous.items.length !== turn.items.length;
    const items = turn.items.map((item, itemIndex) => {
      const old = item.id ? itemsById.get(item.id) : previous.items[itemIndex];
      const value = old && itemRevision(old) === itemRevision(item) ? old : item;
      if (value !== previous.items[itemIndex]) itemsChanged = true;
      return value;
    });
    const value = !itemsChanged && previous.status === turn.status && previous.startedAt === turn.startedAt
      && previous.completedAt === turn.completedAt && previous.error?.message === turn.error?.message
      ? previous : { ...turn, items };
    return value;
  });
  return { ...next, turns };
}

function sameStatus(left: ThreadStatus, right: ThreadStatus): boolean {
  return left.type === right.type && sameArray(left.activeFlags || [], right.activeFlags || []);
}

function sameArray<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function itemRevision(item: ThreadItem | undefined): string {
  if (!item) return "";
  return [item.id, item.type, item.status, item.text, item.aggregatedOutput, item.exitCode,
    item.summary?.join("\n"), stablePayload(item.changes), stablePayload(item.result),
    stablePayload(item.error), stablePayload(item.arguments)].join(":");
}

function stablePayload(value: unknown): string {
  if (value === undefined || value === null) return "";
  try { return JSON.stringify(value); } catch { return "[unserializable]"; }
}

function sameSet<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function sameItem(left: ThreadItem | undefined, right: ThreadItem): boolean {
  return left === right || Boolean(left) && JSON.stringify(left) === JSON.stringify(right);
}

function sameQueue(left: readonly QueueEntry[], right: readonly QueueEntry[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry.id === right[index]?.id
    && entry.text === right[index].text && entry.model === right[index].model
    && entry.effort === right[index].effort && entry.createdAt === right[index].createdAt);
}

function sameUsage(left: ThreadTokenUsage | null, right: ThreadTokenUsage): boolean {
  return Boolean(left) && left!.totalTokens === right.totalTokens && left!.inputTokens === right.inputTokens
    && left!.outputTokens === right.outputTokens && left!.cachedInputTokens === right.cachedInputTokens
    && left!.reasoningOutputTokens === right.reasoningOutputTokens;
}
