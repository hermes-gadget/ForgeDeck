import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import type { CookieSecureMode } from "./config.js";

const COOKIE_NAME = "forgedeck_session";
const AUTH_DISABLED_SESSION_ID = "authentication-disabled";
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 32;
const DEFAULT_LOGIN_MAX_ATTEMPTS = 5;
const DEFAULT_LOGIN_WINDOW_MS = 15 * 60_000;
const DEFAULT_LOGIN_ATTEMPT_STATE_MAX = 1_000;
const DEFAULT_LOGIN_GLOBAL_MAX_ATTEMPTS = 200;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

type Session = { expiresAt: number; timer: NodeJS.Timeout };
type Attempt = { count: number; resetAt: number };

export type SessionInvalidationReason = "logout" | "expired";
export type SessionInvalidation = { sessionId: string; reason: SessionInvalidationReason };
export type AuthManagerOptions = {
  enabled?: boolean;
  password?: string;
  cookieSecure?: CookieSecureMode;
  sessionTtlMs?: number;
  maxSessions?: number;
  loginMaxAttempts?: number;
  loginWindowMs?: number;
  loginAttemptStateMax?: number;
  loginGlobalMaxAttempts?: number;
};
export type LoginResult = {
  ok: boolean;
  sessionId?: string;
  reason?: "invalid_credentials" | "rate_limited" | "session_limit";
  retryAfter?: number;
};

export class AuthManager {
  private readonly secret: string | null;
  private readonly sessions = new Map<string, Session>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly invalidationListeners = new Set<(event: SessionInvalidation) => void>();
  private readonly cookieSecure: CookieSecureMode;
  private readonly sessionTtlMs: number;
  private readonly maxSessions: number;
  private readonly loginMaxAttempts: number;
  private readonly loginWindowMs: number;
  private readonly loginAttemptStateMax: number;
  private readonly loginGlobalMaxAttempts: number;
  private globalAttempts: Attempt | null = null;
  private readonly pruneTimer: NodeJS.Timeout;
  readonly enabled: boolean;
  readonly generatedTokenPath: string | null;

  constructor(dataDir: string, options: CookieSecureMode | AuthManagerOptions = {}) {
    const normalized = typeof options === "string" ? { cookieSecure: options } : options;
    this.cookieSecure = normalized.cookieSecure ?? "auto";
    this.sessionTtlMs = positiveInteger(normalized.sessionTtlMs, DEFAULT_SESSION_TTL_MS, "session TTL");
    this.maxSessions = positiveInteger(normalized.maxSessions, DEFAULT_MAX_SESSIONS, "maximum sessions");
    this.loginMaxAttempts = positiveInteger(normalized.loginMaxAttempts, DEFAULT_LOGIN_MAX_ATTEMPTS, "login maximum attempts");
    this.loginWindowMs = positiveInteger(normalized.loginWindowMs, DEFAULT_LOGIN_WINDOW_MS, "login window");
    this.loginAttemptStateMax = positiveInteger(normalized.loginAttemptStateMax, DEFAULT_LOGIN_ATTEMPT_STATE_MAX, "login attempt state cap");
    this.loginGlobalMaxAttempts = positiveInteger(normalized.loginGlobalMaxAttempts, DEFAULT_LOGIN_GLOBAL_MAX_ATTEMPTS, "global login maximum attempts");

    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dataDir, 0o700);
    this.enabled = normalized.enabled ?? true;
    if (!this.enabled) {
      this.secret = null;
      this.generatedTokenPath = null;
      this.pruneTimer = setInterval(() => this.prune(), 60_000);
      this.pruneTimer.unref();
      return;
    }
    const configured = normalized.password;
    const tokenPath = path.join(dataDir, "access-token");

    if (configured) {
      this.secret = configured;
      this.generatedTokenPath = null;
    } else if (fs.existsSync(tokenPath)) {
      fs.chmodSync(tokenPath, 0o600);
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

    this.pruneTimer = setInterval(() => this.prune(), Math.min(60_000, this.sessionTtlMs));
    this.pruneTimer.unref();
  }

  login(clientIdentity: string, candidate: string): LoginResult {
    if (!this.enabled) {
      return { ok: true, sessionId: crypto.randomBytes(32).toString("base64url") };
    }
    const now = Date.now();
    this.pruneAttempts(now);
    const clientKey = hashIdentity(clientIdentity);
    const attempt = this.attempts.get(clientKey);
    const globalBlocked = this.globalAttempts && this.globalAttempts.resetAt > now
      && this.globalAttempts.count >= this.loginGlobalMaxAttempts;
    if (globalBlocked || (attempt && attempt.resetAt > now && attempt.count >= this.loginMaxAttempts)) {
      return { ok: false, reason: "rate_limited", retryAfter: retryAfterSeconds(globalBlocked ? this.globalAttempts!.resetAt : attempt!.resetAt, now) };
    }

    const ok = safeEqual(candidate, this.secret!);
    if (!ok) {
      if (!attempt && this.attempts.size >= this.loginAttemptStateMax) {
        return { ok: false, reason: "rate_limited", retryAfter: retryAfterSeconds(earliestReset(this.attempts, now + this.loginWindowMs), now) };
      }
      const resetAt = attempt?.resetAt && attempt.resetAt > now ? attempt.resetAt : now + this.loginWindowMs;
      this.attempts.set(clientKey, { count: (attempt?.resetAt && attempt.resetAt > now ? attempt.count : 0) + 1, resetAt });
      const globalResetAt = this.globalAttempts?.resetAt && this.globalAttempts.resetAt > now
        ? this.globalAttempts.resetAt
        : now + this.loginWindowMs;
      this.globalAttempts = {
        count: (this.globalAttempts?.resetAt && this.globalAttempts.resetAt > now ? this.globalAttempts.count : 0) + 1,
        resetAt: globalResetAt
      };
      return { ok: false, reason: "invalid_credentials" };
    }

    this.attempts.delete(clientKey);
    this.pruneSessions(now);
    if (this.sessions.size >= this.maxSessions) {
      return { ok: false, reason: "session_limit", retryAfter: retryAfterSeconds(earliestSessionExpiry(this.sessions, now + this.sessionTtlMs), now) };
    }
    const sessionId = crypto.randomBytes(32).toString("base64url");
    const expiresAt = now + this.sessionTtlMs;
    const timer = this.expiryTimer(sessionId, expiresAt);
    this.sessions.set(sessionId, { expiresAt, timer });
    return { ok: true, sessionId };
  }

  setCookie(req: Request, res: Response, sessionId: string): void {
    res.cookie(COOKIE_NAME, sessionId, {
      httpOnly: true,
      sameSite: "strict",
      secure: this.secureCookieFor(req),
      path: "/",
      maxAge: this.sessionTtlMs,
      priority: "high"
    });
  }

  logout(req: Request, res: Response): void {
    const sessionId = readCookie(req, COOKIE_NAME);
    if (sessionId) this.invalidateSession(sessionId, "logout");
    res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "strict", secure: this.secureCookieFor(req), path: "/", priority: "high" });
  }

  authenticatedSessionId(req: Request): string | null {
    if (!this.enabled) return AUTH_DISABLED_SESSION_ID;
    const id = readCookie(req, COOKIE_NAME);
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= Date.now()) {
      if (session) this.invalidateSession(id, "expired");
      return null;
    }
    return id;
  }

  isAuthenticated(req: Request): boolean {
    return this.authenticatedSessionId(req) !== null;
  }

  requireAuth = (req: Request, res: Response, next: NextFunction): void => {
    const sessionId = this.authenticatedSessionId(req);
    if (!sessionId) {
      res.status(401).json({ error: "Authentication required", code: "AUTH_REQUIRED" });
      return;
    }
    res.locals.authSessionId = sessionId;
    next();
  };

  onSessionInvalidated(listener: (event: SessionInvalidation) => void): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  close(): void {
    clearInterval(this.pruneTimer);
    for (const session of this.sessions.values()) clearTimeout(session.timer);
    this.sessions.clear();
    this.attempts.clear();
    this.invalidationListeners.clear();
    this.globalAttempts = null;
  }

  get activeSessionCount(): number {
    this.pruneSessions(Date.now());
    return this.sessions.size;
  }

  private invalidateSession(sessionId: string, reason: SessionInvalidationReason): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    clearTimeout(session.timer);
    for (const listener of this.invalidationListeners) {
      try { listener({ sessionId, reason }); } catch { /* session revocation must not be reversible */ }
    }
  }

  private expiryTimer(sessionId: string, expiresAt: number): NodeJS.Timeout {
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(1, expiresAt - Date.now()));
    const timer = setTimeout(() => {
      const session = this.sessions.get(sessionId);
      if (!session) return;
      if (session.expiresAt <= Date.now()) this.invalidateSession(sessionId, "expired");
      else session.timer = this.expiryTimer(sessionId, session.expiresAt);
    }, delay);
    timer.unref();
    return timer;
  }

  private prune(): void {
    const now = Date.now();
    this.pruneSessions(now);
    this.pruneAttempts(now);
  }

  private pruneSessions(now: number): void {
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.invalidateSession(id, "expired");
    }
  }

  private pruneAttempts(now: number): void {
    for (const [clientKey, attempt] of this.attempts) {
      if (attempt.resetAt <= now) this.attempts.delete(clientKey);
    }
    if (this.globalAttempts && this.globalAttempts.resetAt <= now) this.globalAttempts = null;
  }

  private secureCookieFor(req: Request): boolean {
    return this.cookieSecure === "on" || (this.cookieSecure === "auto" && req.secure);
  }
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error(`Auth ${label} must be a positive integer`);
  return resolved;
}

function safeEqual(value: string, expected: string): boolean {
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hashIdentity(value: string): string {
  return crypto.createHash("sha256").update(value.slice(0, 1_024)).digest("base64url");
}

function retryAfterSeconds(resetAt: number, now: number): number {
  return Math.max(1, Math.ceil((resetAt - now) / 1_000));
}

function earliestReset(attempts: ReadonlyMap<string, Attempt>, fallback: number): number {
  let earliest = fallback;
  for (const attempt of attempts.values()) earliest = Math.min(earliest, attempt.resetAt);
  return earliest;
}

function earliestSessionExpiry(sessions: ReadonlyMap<string, Session>, fallback: number): number {
  let earliest = fallback;
  for (const session of sessions.values()) earliest = Math.min(earliest, session.expiresAt);
  return earliest;
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      try { return decodeURIComponent(rest.join("=")); } catch { return null; }
    }
  }
  return null;
}
