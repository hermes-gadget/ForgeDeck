import { performance } from "node:perf_hooks";
import type { Request, RequestHandler } from "express";
import { logger } from "./logger.js";

type MutableRouteStats = {
  count: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
};

export type RouteStats = {
  count: number;
  errors: number;
  averageMs: number;
  maxMs: number;
  lastMs: number;
};

/** Collects inexpensive in-process latency data without recording bodies or query values. */
export class ApiProfiler {
  private readonly routes = new Map<string, MutableRouteStats>();

  constructor(
    private readonly slowRequestMs: number,
    private readonly log: (message: string) => void = (message) => logger.warn(message),
    private readonly maxRoutes = 256
  ) {}

  readonly middleware: RequestHandler = (req, res, next) => {
    const startedAt = performance.now();
    res.once("finish", () => {
      const elapsedMs = performance.now() - startedAt;
      let route = routeName(req);
      if (!this.routes.has(route) && this.routes.size >= Math.max(0, this.maxRoutes - 1)) route = `${req.method} [other routes]`;
      const current = this.routes.get(route) || { count: 0, errors: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
      current.count += 1;
      if (res.statusCode >= 500) current.errors += 1;
      current.totalMs += elapsedMs;
      current.maxMs = Math.max(current.maxMs, elapsedMs);
      current.lastMs = elapsedMs;
      this.routes.set(route, current);
      if (this.slowRequestMs > 0 && elapsedMs >= this.slowRequestMs) {
        this.log(`[ForgeDeck] Slow API request: ${route} returned ${res.statusCode} in ${elapsedMs.toFixed(1)}ms`);
      }
    });
    next();
  };

  snapshot(): Record<string, RouteStats> {
    return Object.fromEntries([...this.routes].sort(([left], [right]) => left.localeCompare(right)).map(([route, stats]) => [route, {
      count: stats.count,
      errors: stats.errors,
      averageMs: round(stats.totalMs / stats.count),
      maxMs: round(stats.maxMs),
      lastMs: round(stats.lastMs)
    }]));
  }
}

function routeName(req: Request): string {
  const route = (req as Request & { route?: { path?: unknown } }).route?.path;
  const pathname = typeof route === "string" ? `${req.baseUrl}${route}` : sanitizePath(req.path);
  return `${req.method} ${pathname}`;
}

function sanitizePath(value: string): string {
  return value
    .replace(/\/threads\/[a-zA-Z0-9_-]{8,128}/g, "/threads/:threadId")
    .replace(/\/approvals\/[^/]+/g, "/approvals/:requestId")
    .replace(/\/queue\/[^/]+/g, "/queue/:queueId");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
