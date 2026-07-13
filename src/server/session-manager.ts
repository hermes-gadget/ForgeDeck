import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";

export const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60_000;

export type SessionMetadata = {
  tags: string[];
  category: string | null;
  createdAt: number;
  updatedAt: number;
};

export type SessionAuditEvent = {
  id: string;
  threadId: string;
  action: string;
  at: number;
  actor: string;
  details?: Record<string, unknown>;
};

type MetadataUpdate = { tags?: unknown; category?: unknown };
type ThreadLike = Record<string, unknown> & { id?: unknown; updatedAt?: unknown; recencyAt?: unknown; status?: unknown };

/**
 * Owns ForgeDeck's session-local state. Codex remains the source of truth for
 * whether a thread exists; this store only adds organization and audit data.
 */
export class SessionManager {
  private readonly metadataFile: string;
  private readonly auditFile: string;
  private readonly metadata = new Map<string, SessionMetadata>();
  private readonly locks = new Map<string, Promise<void>>();
  private auditSequence = 0;

  constructor(private readonly dataDir: string, private readonly now: () => number = Date.now) {
    this.metadataFile = path.join(dataDir, "session-metadata.json");
    this.auditFile = path.join(dataDir, "session-audit.jsonl");
    this.loadMetadata();
  }

  /** Serialize operations which may race on the same Codex thread. */
  async withSession<T>(threadId: string, operation: () => Promise<T> | T): Promise<T> {
    return this.withLock(`thread:${threadId}`, operation);
  }

  /** Serialize inventory-changing operations such as create/list/archive. */
  async withInventory<T>(operation: () => Promise<T> | T): Promise<T> {
    return this.withLock("inventory", operation);
  }

  metadataFor(threadId: string): SessionMetadata {
    const stored = this.metadata.get(threadId);
    return stored ? { ...stored, tags: [...stored.tags] } : { tags: [], category: null, createdAt: 0, updatedAt: 0 };
  }

  enrich<T extends ThreadLike>(thread: T): T & Pick<SessionMetadata, "tags" | "category"> {
    const threadId = typeof thread.id === "string" ? thread.id : "";
    const metadata = this.metadataFor(threadId);
    return { ...thread, tags: metadata.tags, category: metadata.category };
  }

  setMetadata(threadId: string, update: MetadataUpdate, actor = "user"): SessionMetadata {
    const previous = this.metadata.get(threadId);
    const timestamp = this.now();
    const next: SessionMetadata = {
      tags: update.tags === undefined ? [...(previous?.tags || [])] : normalizeTags(update.tags),
      category: update.category === undefined ? previous?.category || null : normalizeCategory(update.category),
      createdAt: previous?.createdAt || timestamp,
      updatedAt: timestamp
    };
    this.metadata.set(threadId, next);
    this.persistMetadata();
    this.record(threadId, "organized", actor, { tags: next.tags, category: next.category });
    return { ...next, tags: [...next.tags] };
  }

  removeMetadata(threadId: string): boolean {
    if (!this.metadata.delete(threadId)) return false;
    this.persistMetadata();
    return true;
  }

  trackedThreadIds(): string[] {
    return [...this.metadata.keys()];
  }

  record(threadId: string, action: string, actor = "system", details?: Record<string, unknown>): SessionAuditEvent {
    const at = this.now();
    const event: SessionAuditEvent = {
      id: `${at.toString(36)}-${process.pid.toString(36)}-${(this.auditSequence++).toString(36)}`,
      threadId,
      action,
      at,
      actor,
      ...(details && Object.keys(details).length ? { details } : {})
    };
    try {
      fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.auditFile, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      logger.error("Could not append session audit event", { error });
    }
    return event;
  }

  history(threadId: string, limit = 100): SessionAuditEvent[] {
    const boundedLimit = Math.max(1, Math.min(1_000, Math.round(limit)));
    let lines: string[];
    try {
      lines = fs.readFileSync(this.auditFile, "utf8").split("\n");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const events: SessionAuditEvent[] = [];
    for (let index = lines.length - 1; index >= 0 && events.length < boundedLimit; index -= 1) {
      if (!lines[index].trim()) continue;
      try {
        const event = JSON.parse(lines[index]) as SessionAuditEvent;
        if (event.threadId === threadId && typeof event.action === "string" && Number.isFinite(event.at)) events.push(event);
      } catch {
        // A final partial line after an unexpected shutdown must not hide older history.
      }
    }
    return events.reverse();
  }

  private async withLock<T>(key: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.locks.get(key) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    this.locks.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  private loadMetadata(): void {
    let parsed: Record<string, unknown> = {};
    try {
      if (fs.existsSync(this.metadataFile)) parsed = JSON.parse(fs.readFileSync(this.metadataFile, "utf8")) as Record<string, unknown>;
    } catch (error) {
      logger.warn("Ignoring invalid session metadata file", { error });
    }
    for (const [threadId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      const candidate = value as Partial<SessionMetadata>;
      try {
        this.metadata.set(threadId, {
          tags: normalizeTags(candidate.tags),
          category: normalizeCategory(candidate.category),
          createdAt: finiteNumber(candidate.createdAt),
          updatedAt: finiteNumber(candidate.updatedAt)
        });
      } catch {
        // Invalid records are skipped independently so one entry cannot hide all metadata.
      }
    }
  }

  private persistMetadata(): void {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.metadataFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(Object.fromEntries(this.metadata), null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.metadataFile);
  }
}

export function deriveSessionName(prompt: unknown, fallback = "New session"): string {
  if (typeof prompt !== "string") return fallback;
  const firstLine = prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!firstLine) return fallback;
  const cleaned = firstLine.replace(/^(?:#{1,6}|[-*+] |\d+[.)] )\s*/, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return fallback;
  if (cleaned.length <= 100) return cleaned;
  const truncated = cleaned.slice(0, 100);
  const boundary = truncated.lastIndexOf(" ");
  return `${(boundary >= 60 ? truncated.slice(0, boundary) : truncated.slice(0, 99)).trimEnd()}…`;
}

export function isSessionExpired(thread: ThreadLike, activeThreadIds: ReadonlySet<string>, ttlMs = DEFAULT_SESSION_TTL_MS, now = Date.now()): boolean {
  const threadId = typeof thread.id === "string" ? thread.id : "";
  if (!threadId || ttlMs <= 0 || activeThreadIds.has(threadId)) return false;
  const status = thread.status && typeof thread.status === "object" ? (thread.status as { type?: unknown }).type : null;
  if (status === "active") return false;
  const updatedAt = Math.max(normalizeTimestamp(thread.updatedAt), normalizeTimestamp(thread.recencyAt));
  return updatedAt > 0 && now - updatedAt > ttlMs;
}

export function normalizeTags(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("Tags must be an array of strings");
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") throw new Error("Tags must be an array of strings");
    const tag = raw.trim().replace(/\s+/g, " ");
    if (!tag) continue;
    if (tag.length > 32) throw new Error("Tags must be 32 characters or fewer");
    const key = tag.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      tags.push(tag);
    }
  }
  if (tags.length > 10) throw new Error("A session can have at most 10 tags");
  return tags;
}

export function normalizeCategory(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error("Category must be a string or null");
  const category = value.trim().replace(/\s+/g, " ");
  if (!category) return null;
  if (category.length > 50) throw new Error("Category must be 50 characters or fewer");
  return category;
}

function normalizeTimestamp(value: unknown): number {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number < 10_000_000_000 ? number * 1_000 : number;
}

function finiteNumber(value: unknown): number {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}
