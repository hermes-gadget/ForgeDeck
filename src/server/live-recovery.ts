const DEFAULT_MAX_BYTES = 384 * 1024;
const DEFAULT_RETENTION_MS = 15 * 60_000;
const TRUNCATION_MARKER = "…[earlier output truncated]\n";
const MAX_TRUNCATED_ITEM_IDS = 64;

export type LiveRecoverySnapshot = {
  items: Record<string, Record<string, unknown>>;
  agentText: Record<string, string>;
  toolOutput: Record<string, string>;
  active: boolean;
  completedAt: number | null;
  updatedAt: number;
  tokenUsage: Record<string, unknown> | null;
  truncated: boolean;
  truncatedItemIds: string[];
};

export type LiveRecoveryOptions = {
  maxBytes?: number;
  retentionMs?: number;
  now?: () => number;
};

type RecoveryEntry = {
  snapshot: LiveRecoverySnapshot;
};

/**
 * Holds only bounded, reconnect-oriented state. Completed canonical items are
 * persisted separately and are deliberately not treated as recovery buffers.
 */
export class LiveRecoveryStore {
  private readonly entries = new Map<string, RecoveryEntry>();
  private readonly lastViewedAt = new Map<string, number>();
  private readonly maxBytes: number;
  private readonly retentionMs: number;
  private readonly now: () => number;

  constructor(options: LiveRecoveryOptions = {}) {
    this.maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES, "Live recovery byte budget");
    this.retentionMs = positiveInteger(options.retentionMs, DEFAULT_RETENTION_MS, "Live recovery retention");
    this.now = options.now || Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  keys(): IterableIterator<string> {
    return this.entries.keys();
  }

  has(threadId: string): boolean {
    return this.entries.has(threadId);
  }

  delete(threadId: string): boolean {
    this.lastViewedAt.delete(threadId);
    return this.entries.delete(threadId);
  }

  markViewed(threadId: string): void {
    this.lastViewedAt.set(threadId, this.timestamp());
  }

  /** Returns one thread's recovery state and renews only that thread's lease. */
  read(threadId: string): LiveRecoverySnapshot | null {
    const entry = this.entries.get(threadId);
    const now = this.timestamp();
    const previousView = this.lastViewedAt.get(threadId) || 0;
    this.lastViewedAt.set(threadId, now);
    if (!entry) return null;
    if (!entry.snapshot.active && previousView < now - this.retentionMs) {
      this.entries.delete(threadId);
      return null;
    }
    return entry.snapshot;
  }

  record(
    notification: { method: string; params?: Record<string, unknown> },
    active: boolean
  ): LiveRecoverySnapshot | null {
    const params = notification.params;
    const threadId = typeof params?.threadId === "string" ? params.threadId : null;
    if (!threadId) return null;
    const now = this.timestamp();
    const entry = this.entries.get(threadId) || { snapshot: emptySnapshot(now) };
    const state = entry.snapshot;
    state.updatedAt = now;

    if (notification.method === "turn/started") {
      state.items = {};
      state.agentText = {};
      state.toolOutput = {};
      state.truncated = false;
      state.truncatedItemIds = [];
      state.active = active;
      state.completedAt = null;
    } else if (notification.method === "turn/completed") {
      state.active = active;
      if (!active) state.completedAt = now;
    } else if (notification.method === "thread/status/changed") {
      state.active = active;
    }

    if ((notification.method === "item/started" || notification.method === "item/completed") && isRecord(params?.item)) {
      const item = params.item;
      if (typeof item.id === "string") {
        touchRecord(state.items, item.id, item);
        if (notification.method === "item/completed" && hasAuthoritativeOutput(item)) {
          delete state.agentText[item.id];
          delete state.toolOutput[item.id];
        }
        if (item.recoveryTruncated === true) markTruncated(state, item.id);
      }
    }

    if (notification.method === "item/agentMessage/delta" && typeof params?.itemId === "string") {
      touchRecord(state.agentText, params.itemId, `${state.agentText[params.itemId] || ""}${String(params.delta || "")}`);
    }
    if (["item/commandExecution/outputDelta", "item/fileChange/outputDelta", "command/exec/outputDelta"].includes(notification.method)) {
      const itemId = typeof params?.itemId === "string" ? params.itemId : typeof params?.processId === "string" ? params.processId : null;
      if (itemId) touchRecord(state.toolOutput, itemId, `${state.toolOutput[itemId] || ""}${String(params?.delta || "")}`);
    }
    if (notification.method === "thread/tokenUsage/updated") {
      const tokenUsage = params?.tokenUsage as { total?: unknown } | undefined;
      state.tokenUsage = isRecord(tokenUsage?.total) ? tokenUsage.total : null;
    }

    enforceBudget(state, this.maxBytes);
    this.entries.set(threadId, entry);
    if (!state.active && !this.wasViewedRecently(threadId, now)) {
      this.entries.delete(threadId);
      return null;
    }
    return state;
  }

  replace(threadId: string, snapshot: Omit<LiveRecoverySnapshot, "truncated" | "truncatedItemIds"> & Partial<Pick<LiveRecoverySnapshot, "truncated" | "truncatedItemIds">>): LiveRecoverySnapshot | null {
    const now = this.timestamp();
    if (!snapshot.active && !this.wasViewedRecently(threadId, now)) {
      this.entries.delete(threadId);
      return null;
    }
    const state: LiveRecoverySnapshot = {
      ...snapshot,
      truncated: snapshot.truncated || false,
      truncatedItemIds: [...(snapshot.truncatedItemIds || [])]
    };
    enforceBudget(state, this.maxBytes);
    this.entries.set(threadId, { snapshot: state });
    return state;
  }

  prune(): number {
    const now = this.timestamp();
    const cutoff = now - this.retentionMs;
    let removed = 0;
    for (const [threadId, entry] of this.entries) {
      if (!entry.snapshot.active && (this.lastViewedAt.get(threadId) || 0) < cutoff) {
        this.entries.delete(threadId);
        removed += 1;
      }
    }
    for (const [threadId, viewedAt] of this.lastViewedAt) {
      if (viewedAt < cutoff && !this.entries.has(threadId)) this.lastViewedAt.delete(threadId);
    }
    return removed;
  }

  private wasViewedRecently(threadId: string, now: number): boolean {
    return (this.lastViewedAt.get(threadId) || 0) >= now - this.retentionMs;
  }

  private timestamp(): number {
    const value = this.now();
    if (!Number.isFinite(value) || value < 0) throw new RangeError("Live recovery clock must be non-negative and finite");
    return Math.round(value);
  }
}

export function liveRecoveryByteSize(snapshot: LiveRecoverySnapshot): number {
  return Buffer.byteLength(JSON.stringify(snapshot));
}

function emptySnapshot(now: number): LiveRecoverySnapshot {
  return {
    items: {},
    agentText: {},
    toolOutput: {},
    active: false,
    completedAt: null,
    updatedAt: now,
    tokenUsage: null,
    truncated: false,
    truncatedItemIds: []
  };
}

function enforceBudget(state: LiveRecoverySnapshot, maximum: number): void {
  if (liveRecoveryByteSize(state) <= maximum) return;
  state.truncated = true;

  for (const itemId of Object.keys(state.items)) {
    if (liveRecoveryByteSize(state) <= maximum) return;
    delete state.items[itemId];
    markTruncated(state, itemId);
  }

  while (liveRecoveryByteSize(state) > maximum) {
    const candidates = [
      ...Object.keys(state.agentText).map((itemId) => ({ target: state.agentText, itemId })),
      ...Object.keys(state.toolOutput).map((itemId) => ({ target: state.toolOutput, itemId }))
    ];
    if (!candidates.length) break;
    if (candidates.length > 1) {
      const candidate = candidates[0];
      delete candidate.target[candidate.itemId];
      markTruncated(state, candidate.itemId);
      continue;
    }
    const candidate = candidates[0];
    const excess = liveRecoveryByteSize(state) - maximum;
    const currentBytes = Buffer.byteLength(candidate.target[candidate.itemId]);
    const desiredBytes = Math.max(0, currentBytes - excess - Buffer.byteLength(TRUNCATION_MARKER) - 16);
    const next = desiredBytes > 0 ? `${TRUNCATION_MARKER}${utf8Tail(candidate.target[candidate.itemId], desiredBytes)}` : "";
    if (!next || Buffer.byteLength(next) >= currentBytes) delete candidate.target[candidate.itemId];
    else candidate.target[candidate.itemId] = next;
    markTruncated(state, candidate.itemId);
  }
}

function utf8Tail(value: string, maximumBytes: number): string {
  const buffer = Buffer.from(value);
  if (buffer.byteLength <= maximumBytes) return value;
  return buffer.subarray(buffer.byteLength - maximumBytes).toString("utf8").replace(/^\uFFFD+/, "");
}

function markTruncated(state: LiveRecoverySnapshot, itemId: string): void {
  state.truncated = true;
  if (!state.truncatedItemIds.includes(itemId)) state.truncatedItemIds.push(itemId);
  if (state.truncatedItemIds.length > MAX_TRUNCATED_ITEM_IDS) {
    state.truncatedItemIds.splice(0, state.truncatedItemIds.length - MAX_TRUNCATED_ITEM_IDS);
  }
}

function hasAuthoritativeOutput(item: Record<string, unknown>): boolean {
  if (item.type === "agentMessage") return typeof item.text === "string";
  if (item.type === "commandExecution") return item.aggregatedOutput !== undefined && item.aggregatedOutput !== null;
  if (item.type === "fileChange") return Array.isArray(item.changes);
  return item.result !== undefined || item.error !== undefined || item.contentItems !== undefined;
}

function touchRecord<T>(record: Record<string, T>, key: string, value: T): void {
  delete record[key];
  record[key] = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result <= 0) throw new RangeError(`${label} must be a positive integer`);
  return result;
}
