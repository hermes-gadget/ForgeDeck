import crypto from "node:crypto";

export type InventorySortKey = "created_at" | "updated_at" | "name" | "directory" | "status";
type InventorySortDirection = "asc" | "desc";
export type InventoryItem = Record<string, unknown> & { id: string };

type InventoryFilters = {
  sessionClass?: string;
  status?: string;
  backend?: string;
  model?: string;
  workspace?: string;
  label?: string;
  queueState?: string;
  owner?: string;
  source?: string;
  archiveState?: string;
  dateFrom?: number;
  dateTo?: number;
  dateField?: "created" | "updated";
};

export type InventoryQuery = {
  cursor?: string;
  limit: number;
  search?: string;
  sortKey: InventorySortKey;
  sortDirection: InventorySortDirection;
  filters?: InventoryFilters;
};

type InventoryFacet = { value: string; count: number };
type InventoryFacets = {
  status: InventoryFacet[];
  backend: InventoryFacet[];
  model: InventoryFacet[];
  workspace: InventoryFacet[];
  labels: InventoryFacet[];
  queueState: InventoryFacet[];
  owner: InventoryFacet[];
  source: InventoryFacet[];
  archiveState: InventoryFacet[];
  sessionClass: InventoryFacet[];
};

export type InventoryPage = {
  data: InventoryItem[];
  nextCursor: string | null;
  revision: string;
  total: number;
  facets: InventoryFacets;
  refreshedAt: number;
};

type Snapshot = {
  revision: number;
  generation: number;
  createdAt: number;
  retainUntil: number;
  items: readonly InventoryItem[];
};

type CursorPayload = {
  v: 1;
  revision: number;
  fingerprint: string;
  lastId: string;
  lastValue: string | number;
};

export type SessionInventoryOptions = {
  refreshTtlMs?: number;
  snapshotRetentionMs?: number;
  maxSnapshots?: number;
  now?: () => number;
};

const DEFAULT_REFRESH_TTL_MS = 15_000;
const DEFAULT_SNAPSHOT_RETENTION_MS = 2 * 60_000;
const DEFAULT_MAX_SNAPSHOTS = 12;

class InventoryCursorError extends Error {
  readonly status = 409;
  readonly code = "INVENTORY_CURSOR_EXPIRED";

  constructor(message = "The inventory changed and this cursor is no longer available") {
    super(message);
    this.name = "InventoryCursorError";
  }
}

/**
 * Coalesces provider scans into short-lived immutable revisions. Cursors hold a
 * keyset boundary and the revision they were issued from, while recent
 * revisions remain available long enough for a user to finish pagination.
 */
export class SessionInventoryIndex {
  private readonly refreshTtlMs: number;
  private readonly snapshotRetentionMs: number;
  private readonly maxSnapshots: number;
  private readonly now: () => number;
  private readonly snapshots = new Map<number, Snapshot>();
  private current: Snapshot | null = null;
  private refreshPromise: Promise<Snapshot> | null = null;
  private generation = 1;
  private nextRevision = 1;

  constructor(
    private readonly load: () => Promise<InventoryItem[]>,
    options: SessionInventoryOptions = {}
  ) {
    this.refreshTtlMs = positiveDuration(options.refreshTtlMs, DEFAULT_REFRESH_TTL_MS, "Inventory refresh TTL");
    this.snapshotRetentionMs = positiveDuration(options.snapshotRetentionMs, DEFAULT_SNAPSHOT_RETENTION_MS, "Inventory snapshot retention");
    this.maxSnapshots = positiveInteger(options.maxSnapshots, DEFAULT_MAX_SNAPSHOTS, "Inventory snapshot limit");
    this.now = options.now || Date.now;
  }

  invalidate(): void {
    this.generation = this.generation === Number.MAX_SAFE_INTEGER ? 1 : this.generation + 1;
  }

  archiveStateFor(threadId: string): string | null {
    const item = this.current?.items.find((candidate) => candidate.id === threadId);
    return item ? stringValue(item.archiveState, "active") : null;
  }

  async query(query: InventoryQuery): Promise<InventoryPage> {
    const normalized = normalizeQuery(query);
    const fingerprint = queryFingerprint(normalized);
    const cursor = normalized.cursor ? decodeCursor(normalized.cursor) : null;
    if (cursor && cursor.fingerprint !== fingerprint) {
      throw new InventoryCursorError("This cursor belongs to a different inventory query");
    }
    const snapshot = await this.snapshot(cursor?.revision);
    const filtered = snapshot.items.filter((item) => matches(item, normalized));
    filtered.sort(itemComparator(normalized.sortKey, normalized.sortDirection));
    const start = cursor ? cursorStart(filtered, cursor, normalized.sortKey) : 0;
    const data = filtered.slice(start, start + normalized.limit);
    const last = data.at(-1);
    const nextCursor = last && start + data.length < filtered.length
      ? encodeCursor({
        v: 1,
        revision: snapshot.revision,
        fingerprint,
        lastId: last.id,
        lastValue: sortValue(last, normalized.sortKey)
      })
      : null;
    return {
      data,
      nextCursor,
      revision: String(snapshot.revision),
      total: filtered.length,
      facets: collectFacets(snapshot.items, normalized),
      refreshedAt: snapshot.createdAt
    };
  }

  private async snapshot(revision?: number): Promise<Snapshot> {
    this.pruneSnapshots();
    if (revision !== undefined) {
      const retained = this.snapshots.get(revision);
      if (!retained || retained.retainUntil <= this.now()) throw new InventoryCursorError();
      return retained;
    }
    const now = this.now();
    if (this.current && this.current.generation === this.generation && now - this.current.createdAt < this.refreshTtlMs) {
      return this.current;
    }
    if (this.refreshPromise) return this.refreshPromise;
    const generation = this.generation;
    this.refreshPromise = this.load().then((items) => {
      const createdAt = this.now();
      const snapshot: Snapshot = {
        revision: this.nextRevision++,
        generation,
        createdAt,
        retainUntil: createdAt + this.snapshotRetentionMs,
        items: Object.freeze(dedupeItems(items).map((item) => Object.freeze({ ...item })))
      };
      this.current = snapshot;
      this.snapshots.set(snapshot.revision, snapshot);
      this.pruneSnapshots();
      return snapshot;
    }).finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  private pruneSnapshots(): void {
    const now = this.now();
    for (const [revision, snapshot] of this.snapshots) {
      if (snapshot !== this.current && snapshot.retainUntil <= now) this.snapshots.delete(revision);
    }
    while (this.snapshots.size > this.maxSnapshots) {
      const oldest = this.snapshots.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      if (this.snapshots.get(oldest) === this.current && this.snapshots.size > 1) {
        const next = [...this.snapshots.keys()].find((revision) => revision !== oldest);
        if (next === undefined) break;
        this.snapshots.delete(next);
      } else {
        this.snapshots.delete(oldest);
      }
    }
  }
}

function normalizeQuery(query: InventoryQuery): InventoryQuery & { filters: InventoryFilters } {
  if (!Number.isInteger(query.limit) || query.limit <= 0 || query.limit > 200) throw new RangeError("Inventory page limit must be between 1 and 200");
  const filters = Object.fromEntries(Object.entries(query.filters || {}).filter(([, value]) => value !== undefined && value !== "")) as InventoryFilters;
  return {
    ...query,
    search: query.search?.trim().toLocaleLowerCase() || undefined,
    filters
  };
}

function queryFingerprint(query: InventoryQuery & { filters: InventoryFilters }): string {
  return crypto.createHash("sha256").update(JSON.stringify({
    search: query.search || "",
    sortKey: query.sortKey,
    sortDirection: query.sortDirection,
    filters: Object.fromEntries(Object.entries(query.filters).sort(([left], [right]) => left.localeCompare(right)))
  })).digest("base64url").slice(0, 18);
}

function matches(item: InventoryItem, query: InventoryQuery & { filters: InventoryFilters }, omit?: keyof InventoryFilters): boolean {
  const { filters } = query;
  if (query.search && !inventorySearchText(item).includes(query.search)) return false;
  if (omit !== "sessionClass" && filters.sessionClass && stringValue(item.sessionClass, "standard") !== filters.sessionClass) return false;
  if (omit !== "status" && filters.status && statusValue(item) !== filters.status) return false;
  if (omit !== "backend" && filters.backend && stringValue(item.backend, "codex") !== filters.backend) return false;
  if (omit !== "model" && filters.model && modelValue(item) !== filters.model) return false;
  if (omit !== "workspace" && filters.workspace && stringValue(item.cwd) !== filters.workspace) return false;
  if (omit !== "label" && filters.label && !labelsValue(item).includes(filters.label)) return false;
  if (omit !== "queueState" && filters.queueState && stringValue(item.queueState, "empty") !== filters.queueState) return false;
  if (omit !== "owner" && filters.owner && stringValue(item.owner, "local") !== filters.owner) return false;
  if (omit !== "source" && filters.source && stringValue(item.source, "external") !== filters.source) return false;
  if (omit !== "archiveState" && filters.archiveState && filters.archiveState !== "all" && stringValue(item.archiveState, "active") !== filters.archiveState) return false;
  const dateValue = normalizedTimestamp(filters.dateField === "created" ? item.createdAt : item.updatedAt);
  if (filters.dateFrom !== undefined && dateValue < filters.dateFrom) return false;
  if (filters.dateTo !== undefined && dateValue > filters.dateTo) return false;
  return true;
}

function collectFacets(items: readonly InventoryItem[], query: InventoryQuery & { filters: InventoryFilters }): InventoryFacets {
  const forFacet = (field: keyof InventoryFilters) => items.filter((item) => matches(item, query, field));
  return {
    status: facet(forFacet("status").map(statusValue)),
    backend: facet(forFacet("backend").map((item) => stringValue(item.backend, "codex"))),
    model: facet(forFacet("model").map(modelValue).filter(Boolean)),
    workspace: facet(forFacet("workspace").map((item) => stringValue(item.cwd)).filter(Boolean)),
    labels: facet(forFacet("label").flatMap(labelsValue)),
    queueState: facet(forFacet("queueState").map((item) => stringValue(item.queueState, "empty"))),
    owner: facet(forFacet("owner").map((item) => stringValue(item.owner, "local"))),
    source: facet(forFacet("source").map((item) => stringValue(item.source, "external"))),
    archiveState: facet(forFacet("archiveState").map((item) => stringValue(item.archiveState, "active"))),
    sessionClass: facet(forFacet("sessionClass").map((item) => stringValue(item.sessionClass, "standard")))
  };
}

function facet(values: string[]): InventoryFacet[] {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts].map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

function itemComparator(sortKey: InventorySortKey, direction: InventorySortDirection): (left: InventoryItem, right: InventoryItem) => number {
  const multiplier = direction === "asc" ? 1 : -1;
  return (left, right) => {
    const compared = compareValues(sortValue(left, sortKey), sortValue(right, sortKey));
    return compared ? compared * multiplier : left.id.localeCompare(right.id);
  };
}

function sortValue(item: InventoryItem, sortKey: InventorySortKey): string | number {
  if (sortKey === "name") return stringValue(item.name) || stringValue(item.preview) || "Untitled session";
  if (sortKey === "directory") return stringValue(item.cwd);
  if (sortKey === "status") return statusValue(item) === "active" ? 3 : statusValue(item) === "error" ? 2 : 1;
  return threadTimestamp(sortKey === "created_at" ? item.createdAt : item.updatedAt);
}

function cursorStart(items: readonly InventoryItem[], cursor: CursorPayload, sortKey: InventorySortKey): number {
  const index = items.findIndex((item) => item.id === cursor.lastId && sortValue(item, sortKey) === cursor.lastValue);
  if (index < 0) throw new InventoryCursorError("The inventory cursor boundary is no longer available");
  return index + 1;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeCursor(value: string): CursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CursorPayload>;
    if (parsed.v !== 1 || !Number.isInteger(parsed.revision) || Number(parsed.revision) <= 0
      || typeof parsed.fingerprint !== "string" || typeof parsed.lastId !== "string"
      || (typeof parsed.lastValue !== "string" && typeof parsed.lastValue !== "number")) throw new Error("Invalid cursor");
    return parsed as CursorPayload;
  } catch {
    throw new InventoryCursorError("The inventory cursor is invalid");
  }
}

function inventorySearchText(item: InventoryItem): string {
  const prompts = collectPromptText(item.turns);
  return [item.name, item.preview, item.lastPrompt, item.cwd, item.category, modelValue(item), ...labelsValue(item), ...prompts]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .normalize("NFKC")
    .toLocaleLowerCase();
}

function collectPromptText(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const turn of value) {
    if (!turn || typeof turn !== "object" || !Array.isArray((turn as { items?: unknown }).items)) continue;
    for (const rawItem of (turn as { items: unknown[] }).items) {
      if (!rawItem || typeof rawItem !== "object") continue;
      const item = rawItem as Record<string, unknown>;
      if (item.type !== "userMessage" && item.type !== "user_message") continue;
      if (typeof item.text === "string") result.push(item.text);
      if (Array.isArray(item.content)) {
        for (const content of item.content) {
          if (content && typeof content === "object" && typeof (content as { text?: unknown }).text === "string") {
            result.push((content as { text: string }).text);
          }
        }
      }
    }
  }
  return result;
}

function statusValue(item: InventoryItem): string {
  const status = item.status && typeof item.status === "object" ? (item.status as { type?: unknown }).type : null;
  if (status === "active") return "active";
  if (status === "systemError") return "error";
  const turns = Array.isArray(item.turns) ? item.turns as Array<{ status?: unknown }> : [];
  if (turns.some((turn) => turn?.status === "inProgress")) return "active";
  if (turns.at(-1)?.status === "failed") return "error";
  return "idle";
}

function labelsValue(item: InventoryItem): string[] {
  const values = [item.category, ...(Array.isArray(item.tags) ? item.tags : [])];
  return values.filter((value): value is string => typeof value === "string" && Boolean(value));
}

function modelValue(item: InventoryItem): string {
  return stringValue(item.model) || stringValue(item.claudeModel);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function compareValues(left: string | number, right: string | number): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
}

function threadTimestamp(value: unknown): number {
  const timestamp = Number(value || 0);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizedTimestamp(value: unknown): number {
  const timestamp = threadTimestamp(value);
  return timestamp > 0 && timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp;
}

function dedupeItems(items: InventoryItem[]): InventoryItem[] {
  const byId = new Map<string, InventoryItem>();
  for (const item of items) {
    if (!item || typeof item.id !== "string" || !item.id) continue;
    const existing = byId.get(item.id);
    if (!existing || stringValue(existing.archiveState, "active") !== "active") byId.set(item.id, item);
  }
  return [...byId.values()];
}

function positiveDuration(value: number | undefined, fallback: number, label: string): number {
  const duration = value ?? fallback;
  if (!Number.isFinite(duration) || duration <= 0) throw new RangeError(`${label} must be positive`);
  return duration;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const number = value ?? fallback;
  if (!Number.isInteger(number) || number <= 0) throw new RangeError(`${label} must be a positive integer`);
  return number;
}
