import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createCorsMiddleware } from "./cors.js";
import type { AddressInfo } from "node:net";

test("CORS middleware accepts the canonical and configured origins and rejects others", async (context) => {
  const app = express();
  app.use(createCorsMiddleware({
    publicOrigin: "http://deck.local",
    allowedOrigins: new Set(["https://deck.example.test"])
  }));
  app.get("/probe", (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/probe`;

  const canonical = await fetch(url, { headers: { Origin: "http://deck.local" } });
  assert.equal(canonical.status, 200);

  const ambientHost = await fetch(url, { headers: { Origin: `http://127.0.0.1:${port}` } });
  assert.equal(ambientHost.status, 403);

  const spoofedForwardedHost = await fetch(url, {
    headers: { Origin: "https://spoofed.example.test", "X-Forwarded-Host": "spoofed.example.test", "X-Forwarded-Proto": "https" }
  });
  assert.equal(spoofedForwardedHost.status, 403);

  const wrongScheme = await fetch(url, { headers: { Origin: "https://deck.local" } });
  assert.equal(wrongScheme.status, 403);

  const malformed = await fetch(url, { headers: { Origin: "http://deck.local/path" } });
  assert.equal(malformed.status, 403);
  assert.deepEqual(await malformed.json(), { error: "Invalid request origin", code: "INVALID_ORIGIN" });

  const configured = await fetch(url, { headers: { Origin: "https://deck.example.test" } });
  assert.equal(configured.status, 200);
  assert.equal(configured.headers.get("access-control-allow-origin"), "https://deck.example.test");
  assert.equal(configured.headers.get("access-control-allow-credentials"), "true");
  assert.match(configured.headers.get("access-control-allow-methods") || "", /(?:^|,)PUT(?:,|$)/);

  const preflight = await fetch(url, { method: "OPTIONS", headers: { Origin: "http://deck.local" } });
  assert.equal(preflight.status, 204);

  const nonBrowser = await fetch(url);
  assert.equal(nonBrowser.status, 200);

  const rejected = await fetch(url, { headers: { Origin: "https://untrusted.example.test" } });
  assert.equal(rejected.status, 403);
  assert.deepEqual(await rejected.json(), { error: "Cross-origin request rejected", code: "ORIGIN_REJECTED" });
});
