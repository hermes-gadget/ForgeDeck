import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";

const COOKIE_NAME = "forgedeck_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type Session = { expiresAt: number };
type Attempt = { count: number; resetAt: number };

export class AuthManager {
  private readonly secret: string;
  private readonly sessions = new Map<string, Session>();
  private readonly attempts = new Map<string, Attempt>();
  readonly generatedTokenPath: string | null;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const configured = process.env.FORGEDECK_PASSWORD;
    const tokenPath = path.join(dataDir, "access-token");

    if (configured) {
      this.secret = configured;
      this.generatedTokenPath = null;
    } else if (fs.existsSync(tokenPath)) {
      this.secret = fs.readFileSync(tokenPath, "utf8").trim();
      this.generatedTokenPath = tokenPath;
    } else {
      this.secret = crypto.randomBytes(24).toString("base64url");
      fs.writeFileSync(tokenPath, `${this.secret}\n`, { mode: 0o600, flag: "wx" });
      this.generatedTokenPath = tokenPath;
    }

    if (this.secret.length < 12) {
      throw new Error("FORGEDECK_PASSWORD must be at least 12 characters long");
    }

    setInterval(() => this.prune(), 60_000).unref();
  }

  login(ip: string, candidate: string): { ok: boolean; sessionId?: string; retryAfter?: number } {
    const now = Date.now();
    const attempt = this.attempts.get(ip);
    if (attempt && attempt.resetAt > now && attempt.count >= 10) {
      return { ok: false, retryAfter: Math.ceil((attempt.resetAt - now) / 1000) };
    }

    const ok = safeEqual(candidate, this.secret);
    if (!ok) {
      const next = !attempt || attempt.resetAt <= now
        ? { count: 1, resetAt: now + 15 * 60_000 }
        : { ...attempt, count: attempt.count + 1 };
      this.attempts.set(ip, next);
      return { ok: false };
    }

    this.attempts.delete(ip);
    const sessionId = crypto.randomBytes(32).toString("base64url");
    this.sessions.set(sessionId, { expiresAt: now + SESSION_TTL_MS });
    return { ok: true, sessionId };
  }

  setCookie(res: Response, sessionId: string): void {
    res.cookie(COOKIE_NAME, sessionId, {
      httpOnly: true,
      sameSite: "strict",
      secure: false,
      path: "/",
      maxAge: SESSION_TTL_MS
    });
  }

  logout(req: Request, res: Response): void {
    const sessionId = readCookie(req, COOKIE_NAME);
    if (sessionId) this.sessions.delete(sessionId);
    res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "strict", path: "/" });
  }

  isAuthenticated(req: Request): boolean {
    const id = readCookie(req, COOKIE_NAME);
    if (!id) return false;
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= Date.now()) {
      if (session) this.sessions.delete(id);
      return false;
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return true;
  }

  requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    if (!this.isAuthenticated(req)) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    next();
  };

  private prune(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
    for (const [ip, attempt] of this.attempts) {
      if (attempt.resetAt <= now) this.attempts.delete(ip);
    }
  }
}

function safeEqual(value: string, expected: string): boolean {
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}
