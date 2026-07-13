import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";

type StoredActor = {
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
};

type StoredAccess = {
  actors: Record<string, StoredActor>;
  threadOwners: Record<string, string>;
};

const EMPTY_ACCESS: StoredAccess = { actors: {}, threadOwners: {} };

export class McpAccessManager {
  private readonly bootstrapSecret: string;
  private readonly accessFile: string;
  private readonly actors = new Map<string, StoredActor>();
  private readonly actorsByHash = new Map<string, string>();
  private readonly threadOwners = new Map<string, string>();
  readonly bootstrapTokenPath: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.bootstrapTokenPath = path.join(dataDir, "mcp-token");
    this.accessFile = path.join(dataDir, "mcp-access.json");
    this.bootstrapSecret = loadOrCreateSecret(this.bootstrapTokenPath);
    this.load();
  }

  registerActor(): { actorId: string; token: string } {
    const actorId = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const now = Date.now();
    this.actors.set(actorId, { tokenHash, createdAt: now, lastSeenAt: now });
    this.actorsByHash.set(tokenHash, actorId);
    this.persist();
    return { actorId, token };
  }

  isBootstrapRequest(req: Request): boolean {
    const token = readBearer(req);
    return token !== null && safeEqual(token, this.bootstrapSecret);
  }

  authenticateActor(req: Request): string | null {
    const token = readBearer(req);
    if (!token) return null;
    const actorId = this.actorsByHash.get(hashToken(token)) || null;
    if (actorId) {
      const actor = this.actors.get(actorId);
      if (actor) actor.lastSeenAt = Date.now();
    }
    return actorId;
  }

  assignThread(threadId: string, actorId: string): void {
    if (!this.actors.has(actorId)) throw new Error("Unknown MCP actor");
    if (this.threadOwners.has(threadId)) throw new Error("Thread already has an MCP owner");
    this.threadOwners.set(threadId, actorId);
    this.persist();
  }

  releaseThread(threadId: string): void {
    if (!this.threadOwners.delete(threadId)) return;
    this.persist();
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

  requireBootstrap = (req: Request, res: Response, next: NextFunction): void => {
    if (!this.isBootstrapRequest(req)) {
      res.status(401).json({ error: "A valid ForgeDeck MCP bootstrap token is required" });
      return;
    }
    next();
  };

  private load(): void {
    let stored = EMPTY_ACCESS;
    try {
      if (fs.existsSync(this.accessFile)) stored = JSON.parse(fs.readFileSync(this.accessFile, "utf8")) as StoredAccess;
    } catch (error) {
      console.error("[ForgeDeck] Ignoring invalid MCP access file:", error);
    }
    for (const [actorId, actor] of Object.entries(stored.actors || {})) {
      if (!actor || typeof actor.tokenHash !== "string") continue;
      this.actors.set(actorId, actor);
      this.actorsByHash.set(actor.tokenHash, actorId);
    }
    for (const [threadId, actorId] of Object.entries(stored.threadOwners || {})) {
      if (this.actors.has(actorId)) this.threadOwners.set(threadId, actorId);
    }
  }

  private persist(): void {
    const temporary = `${this.accessFile}.${process.pid}.tmp`;
    const value: StoredAccess = {
      actors: Object.fromEntries(this.actors),
      threadOwners: Object.fromEntries(this.threadOwners)
    };
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.accessFile);
  }
}

function loadOrCreateSecret(tokenPath: string): string {
  if (fs.existsSync(tokenPath)) return fs.readFileSync(tokenPath, "utf8").trim();
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
