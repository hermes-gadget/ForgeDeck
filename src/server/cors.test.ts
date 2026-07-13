import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createCorsMiddleware } from "./cors.js";

test("CORS middleware accepts same-host and configured origins and rejects others", async (context) => {
  const app = express();
  app.use(createCorsMiddleware(new Set(["https://deck.example.test"])));
  app.get("/probe", (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/probe`;

  const sameHost = await fetch(url, { headers: { Origin: `http://127.0.0.1:${port}` } });
  assert.equal(sameHost.status, 200);

  const configured = await fetch(url, { headers: { Origin: "https://deck.example.test" } });
  assert.equal(configured.status, 200);
  assert.equal(configured.headers.get("access-control-allow-origin"), "https://deck.example.test");
  assert.equal(configured.headers.get("access-control-allow-credentials"), "true");

  const rejected = await fetch(url, { headers: { Origin: "https://untrusted.example.test" } });
  assert.equal(rejected.status, 403);
  assert.deepEqual(await rejected.json(), { error: "Cross-origin request rejected", code: "ORIGIN_REJECTED" });
});
