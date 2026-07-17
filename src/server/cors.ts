import type { RequestHandler } from "express";

export type OriginPolicy = {
  publicOrigin: string;
  allowedOrigins?: ReadonlySet<string>;
};

/** Enforces an exact canonical browser origin, with explicit cross-origin exceptions. */
export function createCorsMiddleware(policy: OriginPolicy): RequestHandler {
  const allowedOrigins = new Set([policy.publicOrigin, ...(policy.allowedOrigins || [])]);
  return (req, res, next): void => {
    const originHeader = req.headers.origin;
    if (!originHeader) {
      next();
      return;
    }
    const origin = requestOrigin(originHeader);
    if (!origin) {
      res.status(403).json({ error: "Invalid request origin", code: "INVALID_ORIGIN" });
      return;
    }
    if (!allowedOrigins.has(origin)) {
      res.status(403).json({ error: "Cross-origin request rejected", code: "ORIGIN_REJECTED" });
      return;
    }
    res.vary("Origin");
    res.set({
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Authorization,Content-Type,X-Request-Id",
      "Access-Control-Max-Age": "600"
    });
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

function requestOrigin(value: string): string | null {
  let parsed: URL;
  try { parsed = new URL(value); } catch { return null; }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin === "null" || parsed.username || parsed.password) return null;
  if (parsed.pathname !== "/" || parsed.search || parsed.hash || value !== parsed.origin) return null;
  return parsed.origin;
}
