import type { NextFunction, Request, Response } from "express";

type RateLimitOptions = {
  windowMs: number;
  max: number;
  key?: (req: Request) => string;
};

type Window = { count: number; resetAt: number };

export function createRateLimiter(options: RateLimitOptions) {
  if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) throw new Error("Rate-limit window must be positive");
  if (!Number.isInteger(options.max) || options.max <= 0) throw new Error("Rate-limit maximum must be a positive integer");
  const windows = new Map<string, Window>();
  const timer = setInterval(() => prune(windows), Math.max(10_000, options.windowMs));
  timer.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = options.key?.(req) || req.ip || req.socket.remoteAddress || "unknown";
    let window = windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + options.windowMs };
      windows.set(key, window);
    }
    window.count += 1;
    const remaining = Math.max(0, options.max - window.count);
    const retryAfter = Math.max(1, Math.ceil((window.resetAt - now) / 1000));
    res.set({
      "RateLimit-Limit": String(options.max),
      "RateLimit-Remaining": String(remaining),
      "RateLimit-Reset": String(Math.ceil(window.resetAt / 1000))
    });
    if (window.count > options.max) {
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: "Too many requests. Try again later.", code: "RATE_LIMITED", retryAfter });
      return;
    }
    next();
  };
}

function prune(windows: Map<string, Window>): void {
  const now = Date.now();
  for (const [key, window] of windows) if (window.resetAt <= now) windows.delete(key);
}
