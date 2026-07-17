import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";
import type { NextFunction, Request, Response } from "express";

type StoredActor = {
  clientId: string | null;
  tokenHash: string;
  previousTokenHash: string | null;
  previousTokenExpiresAt: number | null;
  createdAt: number;
  credentialIssuedAt: number;
  credentialExpiresAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
};

type StoredHandoff = {
  targetActorId: string;
  createdAt: number;
  expiresAt: number;
};

type StoredAccess = {
  version?: number;
  actors: Record<string, unknown>;
  threadOwners: Record<string, string>;
  handoffs?: Record<string, StoredHandoff>;
};

export type McpActorCredential = {
  actorId: string;
  token: string;
  credentialIssuedAt: number;
  credentialExpiresAt: number;
};

export type McpHandoff = {
  handoffToken: string;
  expiresAt: number;
};

const EMPTY_ACCESS: StoredAccess = { version: 2, actors: {}, threadOwners: {}, handoffs: {} };
const DEFAULT_ACTOR_LIFETIME_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_ACTOR_INACTIVITY_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_LAST_SEEN_PERSIST_INTERVAL_MS = 30_000;
const DEFAULT_ROTATION_GRACE_MS = 60_000;
const DEFAULT_HANDOFF_TTL_MS = 5 * 60_000;

export type McpAccessOptions = {
  actorLifetimeMs?: number;
  actorInactivityTtlMs?: number;
  lastSeenPersistIntervalMs?: number;
  rotationGraceMs?: number;
  handoffTtlMs?: number;
  now?: () => number;
};

/** Persists MCP principals, credential hashes, and resource ownership for one installation. */
export class McpAccessManager {
  private readonly bootstrapSecret: string;
  private readonly accessFile: string;
  private readonly actors = new Map<string, StoredActor>();
  private readonly actorsByHash = new Map<string, string>();
  private readonly actorsByClientId = new Map<string, string>();
  private readonly threadOwners = new Map<string, string>();
  private readonly handoffs = new Map<string, StoredHandoff>();
  private readonly actorLifetimeMs: number;
  private readonly actorInactivityTtlMs: number;
  private readonly lastSeenPersistIntervalMs: number;
  private readonly rotationGraceMs: number;
  private readonly handoffTtlMs: number;
  private readonly now: () => number;
  private lastSeenDirty = false;
  private lastSeenPersistTimer: NodeJS.Timeout | null = null;
  readonly bootstrapTokenPath: string;

  constructor(dataDir: string, options: McpAccessOptions = {}) {
    this.actorLifetimeMs = positiveDuration(options.actorLifetimeMs, DEFAULT_ACTOR_LIFETIME_MS, "MCP credential lifetime");
    this.actorInactivityTtlMs = positiveDuration(options.actorInactivityTtlMs, DEFAULT_ACTOR_INACTIVITY_TTL_MS, "MCP credential inactivity TTL");
    this.lastSeenPersistIntervalMs = positiveDuration(options.lastSeenPersistIntervalMs, DEFAULT_LAST_SEEN_PERSIST_INTERVAL_MS, "MCP last-seen persist interval");
    this.rotationGraceMs = nonNegativeDuration(options.rotationGraceMs, DEFAULT_ROTATION_GRACE_MS, "MCP rotation grace period");
    this.handoffTtlMs = positiveDuration(options.handoffTtlMs, DEFAULT_HANDOFF_TTL_MS, "MCP handoff lifetime");
    this.now = options.now || Date.now;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dataDir, 0o700);
    this.bootstrapTokenPath = path.join(dataDir, "mcp-token");
    this.accessFile = path.join(dataDir, "mcp-access.json");
    this.bootstrapSecret = loadOrCreateSecret(this.bootstrapTokenPath);
    this.load();
  }

  /**
   * Creates an unscoped legacy actor, or recovers and rotates the actor bound to
   * a stable client ID. Possession of the installation bootstrap token is
   * required by the HTTP route that calls this method.
   */
  registerActor(clientId?: string): McpActorCredential {
    this.pruneHandoffs();
    if (clientId) {
      const existingActorId = this.actorsByClientId.get(clientId);
      if (existingActorId) return this.rotateActor(existingActorId);
    }
    const actorId = crypto.randomUUID();
    const now = this.now();
    const actor: StoredActor = {
      clientId: clientId || null,
      tokenHash: "",
      previousTokenHash: null,
      previousTokenExpiresAt: null,
      createdAt: now,
      credentialIssuedAt: now,
      credentialExpiresAt: now,
      lastSeenAt: now,
      revokedAt: null
    };
    this.actors.set(actorId, actor);
    if (clientId) this.actorsByClientId.set(clientId, actorId);
    return this.rotateActor(actorId);
  }

  refreshActor(actorId: string): McpActorCredential {
    return this.rotateActor(actorId);
  }

  isBootstrapRequest(req: Request): boolean {
    const token = readBearer(req);
    return token !== null && safeEqual(token, this.bootstrapSecret);
  }

  authenticateActor(req: Request): string | null {
    const token = readBearer(req);
    if (!token) return null;
    const tokenHash = hashToken(token);
    const actorId = this.actorsByHash.get(tokenHash) || null;
    if (!actorId) return null;
    const actor = this.actors.get(actorId);
    const now = this.now();
    if (!actor || actor.revokedAt !== null || !this.isCredentialUsable(actor, tokenHash, now)) return null;
    actor.lastSeenAt = now;
    this.scheduleLastSeenPersist();
    return actorId;
  }

  assignThread(threadId: string, actorId: string): void {
    if (!this.isActiveActor(actorId)) throw new Error("Unknown or revoked MCP actor");
    if (this.threadOwners.has(threadId)) throw new Error("Thread already has an MCP owner");
    this.threadOwners.set(threadId, actorId);
    this.persist();
  }

  claimThreads(threadIds: readonly string[], actorId: string): string[] {
    if (!this.isActiveActor(actorId)) throw new Error("Unknown or revoked MCP actor");
    const claimed = [...new Set(threadIds)];
    for (const threadId of claimed) this.threadOwners.set(threadId, actorId);
    if (claimed.length) this.persist();
    return claimed;
  }

  releaseThread(threadId: string): void {
    if (!this.threadOwners.delete(threadId)) return;
    this.persist();
  }

  releaseThreads(threadIds: Iterable<string>): string[] {
    const released: string[] = [];
    for (const threadId of threadIds) {
      if (this.threadOwners.delete(threadId)) released.push(threadId);
    }
    if (released.length) this.persist();
    return released;
  }

  reconcileThreads(existingThreadIds: ReadonlySet<string>): string[] {
    return this.releaseThreads([...this.threadOwners.keys()].filter((threadId) => !existingThreadIds.has(threadId)));
  }

  ownsThread(actorId: string, threadId: string): boolean {
    return this.threadOwners.get(threadId) === actorId;
  }

  listOwnedThreads(actorId: string): string[] {
    return [...this.threadOwners].filter(([, owner]) => owner === actorId).map(([threadId]) => threadId);
  }

  listAgentThreads(): string[] {
    return [...this.threadOwners.keys()];
  }

  ownerForThread(threadId: string): string | null {
    return this.threadOwners.get(threadId) || null;
  }

  createHandoff(targetActorId: string): McpHandoff {
    if (!this.isActiveActor(targetActorId)) throw new Error("Unknown or revoked MCP actor");
    this.pruneHandoffs();
    const handoffToken = crypto.randomBytes(32).toString("base64url");
    const now = this.now();
    const expiresAt = now + this.handoffTtlMs;
    this.handoffs.set(hashToken(handoffToken), { targetActorId, createdAt: now, expiresAt });
    this.persist();
    return { handoffToken, expiresAt };
  }

  handoffThreads(sourceActorId: string, handoffToken: string, requestedThreadIds?: readonly string[]): { targetActorId: string; threadIds: string[] } {
    if (!this.isActiveActor(sourceActorId)) throw new Error("Unknown or revoked MCP actor");
    this.pruneHandoffs();
    const handoffHash = hashToken(handoffToken);
    const handoff = this.handoffs.get(handoffHash);
    if (!handoff || !this.isActiveActor(handoff.targetActorId)) throw new Error("Invalid or expired MCP handoff token");
    if (handoff.targetActorId === sourceActorId) throw new Error("MCP ownership cannot be handed to the same actor");
    const threadIds = requestedThreadIds === undefined
      ? this.listOwnedThreads(sourceActorId)
      : [...new Set(requestedThreadIds)];
    if (!threadIds.length) throw new Error("No owned MCP threads were selected for handoff");
    for (const threadId of threadIds) {
      if (!this.ownsThread(sourceActorId, threadId)) throw new Error(`MCP actor does not own thread ${threadId}`);
    }
    for (const threadId of threadIds) this.threadOwners.set(threadId, handoff.targetActorId);
    this.handoffs.delete(handoffHash);
    this.persist();
    return { targetActorId: handoff.targetActorId, threadIds };
  }

  /** Revokes every credential and converts owned sessions back to local ownership. */
  revokeActor(actorId: string): string[] {
    const actor = this.actors.get(actorId);
    if (!actor || actor.revokedAt !== null) return [];
    this.removeActorIndexes(actorId, actor);
    actor.revokedAt = this.now();
    const released = this.listOwnedThreads(actorId);
    for (const threadId of released) this.threadOwners.delete(threadId);
    for (const [handoffHash, handoff] of this.handoffs) {
      if (handoff.targetActorId === actorId) this.handoffs.delete(handoffHash);
    }
    this.persist();
    return released;
  }

  close(): void {
    if (this.lastSeenDirty) this.persist();
    else if (this.lastSeenPersistTimer) clearTimeout(this.lastSeenPersistTimer);
    this.lastSeenPersistTimer = null;
  }

  requireBootstrap = (req: Request, res: Response, next: NextFunction): void => {
    if (!this.isBootstrapRequest(req)) {
      res.status(401).json({ error: "A valid ForgeDeck MCP bootstrap token is required" });
      return;
    }
    next();
  };

  private rotateActor(actorId: string): McpActorCredential {
    const actor = this.actors.get(actorId);
    if (!actor || actor.revokedAt !== null) throw new Error("Unknown or revoked MCP actor");
    const now = this.now();
    if (actor.previousTokenHash) this.actorsByHash.delete(actor.previousTokenHash);
    if (actor.tokenHash) {
      actor.previousTokenHash = actor.tokenHash;
      actor.previousTokenExpiresAt = Math.min(actor.credentialExpiresAt, now + this.rotationGraceMs);
      if (actor.previousTokenExpiresAt > now) this.actorsByHash.set(actor.previousTokenHash, actorId);
    } else {
      actor.previousTokenHash = null;
      actor.previousTokenExpiresAt = null;
    }
    const token = crypto.randomBytes(32).toString("base64url");
    actor.tokenHash = hashToken(token);
    actor.credentialIssuedAt = now;
    actor.credentialExpiresAt = now + this.actorLifetimeMs;
    actor.lastSeenAt = now;
    this.actorsByHash.set(actor.tokenHash, actorId);
    this.persist();
    return {
      actorId,
      token,
      credentialIssuedAt: actor.credentialIssuedAt,
      credentialExpiresAt: actor.credentialExpiresAt
    };
  }

  private load(): void {
    let stored = EMPTY_ACCESS;
    try {
      if (fs.existsSync(this.accessFile)) stored = JSON.parse(fs.readFileSync(this.accessFile, "utf8")) as StoredAccess;
    } catch (error) {
      logger.warn("Ignoring invalid MCP access file", { error });
    }
    const now = this.now();
    let normalized = stored.version !== 2;
    for (const [actorId, value] of Object.entries(stored.actors || {})) {
      const actor = normalizeStoredActor(value, this.actorLifetimeMs);
      if (!actor) {
        normalized = true;
        continue;
      }
      this.actors.set(actorId, actor);
      if (actor.revokedAt !== null) continue;
      if (actor.clientId) {
        const previous = this.actorsByClientId.get(actor.clientId);
        if (previous) {
          logger.warn("Ignoring duplicate MCP client identity", { actorId, clientId: actor.clientId });
          normalized = true;
          continue;
        }
        this.actorsByClientId.set(actor.clientId, actorId);
      }
      if (this.isCurrentCredentialUsable(actor, now)) this.actorsByHash.set(actor.tokenHash, actorId);
      if (actor.previousTokenHash && actor.previousTokenExpiresAt !== null && actor.previousTokenExpiresAt > now) {
        this.actorsByHash.set(actor.previousTokenHash, actorId);
      } else if (actor.previousTokenHash || actor.previousTokenExpiresAt !== null) {
        actor.previousTokenHash = null;
        actor.previousTokenExpiresAt = null;
        normalized = true;
      }
    }
    for (const [threadId, actorId] of Object.entries(stored.threadOwners || {})) {
      if (this.isActiveActor(actorId)) this.threadOwners.set(threadId, actorId);
      else normalized = true;
    }
    for (const [handoffHash, handoff] of Object.entries(stored.handoffs || {})) {
      if (validStoredHandoff(handoff) && handoff.expiresAt > now && this.isActiveActor(handoff.targetActorId)) {
        this.handoffs.set(handoffHash, handoff);
      } else {
        normalized = true;
      }
    }
    if (normalized) this.persist();
  }

  private isCredentialUsable(actor: StoredActor, tokenHash: string, now: number): boolean {
    if (tokenHash === actor.tokenHash) return this.isCurrentCredentialUsable(actor, now);
    return tokenHash === actor.previousTokenHash
      && actor.previousTokenExpiresAt !== null
      && actor.previousTokenExpiresAt > now;
  }

  private isCurrentCredentialUsable(actor: StoredActor, now: number): boolean {
    return Boolean(actor.tokenHash)
      && actor.credentialExpiresAt > now
      && now - actor.lastSeenAt < this.actorInactivityTtlMs;
  }

  private isActiveActor(actorId: string): boolean {
    const actor = this.actors.get(actorId);
    return Boolean(actor && actor.revokedAt === null);
  }

  private removeActorIndexes(actorId: string, actor: StoredActor): void {
    if (actor.tokenHash) this.actorsByHash.delete(actor.tokenHash);
    if (actor.previousTokenHash) this.actorsByHash.delete(actor.previousTokenHash);
    if (actor.clientId && this.actorsByClientId.get(actor.clientId) === actorId) this.actorsByClientId.delete(actor.clientId);
  }

  private pruneHandoffs(): void {
    const now = this.now();
    let changed = false;
    for (const [handoffHash, handoff] of this.handoffs) {
      if (handoff.expiresAt > now && this.isActiveActor(handoff.targetActorId)) continue;
      this.handoffs.delete(handoffHash);
      changed = true;
    }
    if (changed) this.persist();
  }

  /** Batch authentication heartbeats so reads never perform synchronous disk I/O. */
  private scheduleLastSeenPersist(): void {
    this.lastSeenDirty = true;
    if (this.lastSeenPersistTimer) return;
    this.lastSeenPersistTimer = setTimeout(() => {
      this.lastSeenPersistTimer = null;
      if (!this.lastSeenDirty) return;
      try {
        this.persist();
      } catch (error) {
        logger.warn("Could not persist MCP actor last-seen updates", { error });
        this.scheduleLastSeenPersist();
      }
    }, this.lastSeenPersistIntervalMs);
    this.lastSeenPersistTimer.unref();
  }

  private persist(): void {
    const temporary = `${this.accessFile}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    const value: StoredAccess = {
      version: 2,
      actors: Object.fromEntries(this.actors),
      threadOwners: Object.fromEntries(this.threadOwners),
      handoffs: Object.fromEntries(this.handoffs)
    };
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, this.accessFile);
    fs.chmodSync(this.accessFile, 0o600);
    this.lastSeenDirty = false;
    if (this.lastSeenPersistTimer) clearTimeout(this.lastSeenPersistTimer);
    this.lastSeenPersistTimer = null;
  }
}

function loadOrCreateSecret(tokenPath: string): string {
  if (fs.existsSync(tokenPath)) {
    fs.chmodSync(tokenPath, 0o600);
    return fs.readFileSync(tokenPath, "utf8").trim();
  }
  const secret = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(tokenPath, `${secret}\n`, { mode: 0o600, flag: "wx" });
  return secret;
}

function readBearer(req: Request): string | null {
  const authorization = req.headers.authorization;
  const match = typeof authorization === "string" ? /^Bearer\s+(.+)$/i.exec(authorization.trim()) : null;
  return match?.[1] || null;
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function safeEqual(value: string, expected: string): boolean {
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizeStoredActor(value: unknown, actorLifetimeMs: number): StoredActor | null {
  const actor = value as Partial<StoredActor> | null;
  if (!actor
    || typeof actor.tokenHash !== "string"
    || !Number.isFinite(actor.createdAt)
    || !Number.isFinite(actor.lastSeenAt)) return null;
  const credentialIssuedAt = finiteNumber(actor.credentialIssuedAt) ?? actor.createdAt!;
  return {
    clientId: typeof actor.clientId === "string" && actor.clientId ? actor.clientId : null,
    tokenHash: actor.tokenHash,
    previousTokenHash: typeof actor.previousTokenHash === "string" && actor.previousTokenHash ? actor.previousTokenHash : null,
    previousTokenExpiresAt: finiteNumber(actor.previousTokenExpiresAt),
    createdAt: actor.createdAt!,
    credentialIssuedAt,
    credentialExpiresAt: finiteNumber(actor.credentialExpiresAt) ?? credentialIssuedAt + actorLifetimeMs,
    lastSeenAt: actor.lastSeenAt!,
    revokedAt: finiteNumber(actor.revokedAt)
  };
}

function validStoredHandoff(value: unknown): value is StoredHandoff {
  const handoff = value as Partial<StoredHandoff> | null;
  return Boolean(handoff)
    && typeof handoff!.targetActorId === "string"
    && Number.isFinite(handoff!.createdAt)
    && Number.isFinite(handoff!.expiresAt);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveDuration(value: number | undefined, fallback: number, label: string): number {
  const duration = value ?? fallback;
  if (!Number.isFinite(duration) || duration <= 0) throw new RangeError(`${label} must be positive`);
  return duration;
}

function nonNegativeDuration(value: number | undefined, fallback: number, label: string): number {
  const duration = value ?? fallback;
  if (!Number.isFinite(duration) || duration < 0) throw new RangeError(`${label} must not be negative`);
  return duration;
}
