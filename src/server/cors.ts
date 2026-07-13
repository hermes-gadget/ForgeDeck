import type { RequestHandler } from "express";

/** Allows same-host browser requests plus an explicit set of credentialed origins. */
export function createCorsMiddleware(allowedOrigins: ReadonlySet<string>): RequestHandler {
  return (req, res, next): void => {
    const origin = req.headers.origin;
    if (!origin) {
      next();
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      res.status(403).json({ error: "Invalid request origin", code: "INVALID_ORIGIN" });
      return;
    }
    const sameHost = Boolean(req.headers.host) && parsed.host === req.headers.host && ["http:", "https:"].includes(parsed.protocol);
    if (!sameHost && !allowedOrigins.has(parsed.origin)) {
      res.status(403).json({ error: "Cross-origin request rejected", code: "ORIGIN_REJECTED" });
      return;
    }
    res.vary("Origin");
    res.set({
      "Access-Control-Allow-Origin": parsed.origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET,HEAD,POST,PATCH,DELETE,OPTIONS",
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
