import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { AuthManager } from "./auth.js";
import { formatRevisionedSseEvent, SseSessionRegistry } from "./sse-session.js";
import type { AddressInfo } from "node:net";
import type { Response } from "express";

test("revisioned SSE messages expose the same monotonic id in the wire frame and envelope", () => {
  const first = formatRevisionedSseEvent("codex", { method: "turn/started" }, 41, "thread-1");
  const second = formatRevisionedSseEvent("codex", { method: "turn/completed" }, 42, "thread-1");
  assert.match(first, /^id: 41\nevent: codex\n/);
  assert.match(first, /"eventId":41,"schemaVersion":1,"threadId":"thread-1"/);
  assert.match(second, /^id: 42\nevent: codex\n/);
});

test("thread fan-out includes only subscribed clients while global fan-out includes all clients", () => {
  const streams = new SseSessionRegistry(8, 3);
  const first = fakeResponse();
  const second = fakeResponse();
  const firstHeartbeat = setInterval(() => undefined, 60_000);
  const secondHeartbeat = setInterval(() => undefined, 60_000);
  firstHeartbeat.unref();
  secondHeartbeat.unref();
  streams.add(first, "session-1", firstHeartbeat, "browser-1", ["thread-11111111"]);
  streams.add(second, "session-1", secondHeartbeat, "browser-2", ["thread-22222222"]);

  assert.deepEqual([...streams.responses()], [first, second]);
  assert.deepEqual([...streams.responses("thread-11111111")], [first]);
  assert.deepEqual([...streams.responses("thread-22222222")], [second]);

  assert.equal(streams.setSubscriptions("session-1", "browser-1", ["thread-22222222"]), true);
  assert.deepEqual([...streams.responses("thread-11111111")], []);
  assert.deepEqual([...streams.responses("thread-22222222")], [second, first]);
  assert.equal(streams.setSubscriptions("session-1", "missing-browser", []), false);
  streams.closeAll();
});

test("logging out closes every SSE stream bound to that authenticated session", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-sse-auth-"));
  const auth = new AuthManager(directory, { password: "a-secure-test-password", sessionTtlMs: 60_000 });
  const streams = new SseSessionRegistry(8, 3);
  const stopListening = auth.onSessionInvalidated(({ sessionId, reason }) => streams.closeSession(sessionId, reason));
  const app = express();
  app.use(express.json());
  app.post("/login", (req, res) => {
    const result = auth.login(req.socket.remoteAddress || "unknown", String(req.body?.token || ""));
    if (!result.ok || !result.sessionId) { res.status(401).end(); return; }
    auth.setCookie(req, res, result.sessionId);
    res.json({ ok: true });
  });
  app.use("/events", auth.requireAuth);
  app.get("/events", (_req, res) => {
    const sessionId = String(res.locals.authSessionId);
    res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.flushHeaders();
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 10_000);
    heartbeat.unref();
    streams.add(res, sessionId, heartbeat);
    res.write("event: connected\ndata: {}\n\n");
  });
  app.post("/logout", auth.requireAuth, (req, res) => {
    auth.logout(req, res);
    res.json({ ok: true });
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  context.after(async () => {
    stopListening();
    streams.closeAll();
    auth.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${origin}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "a-secure-test-password" })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);

  const eventResponse = await fetch(`${origin}/events`, { headers: { Cookie: cookie } });
  assert.equal(eventResponse.status, 200);
  const reader = eventResponse.body!.getReader();
  const first = await reader.read();
  assert.match(Buffer.from(first.value || []).toString(), /event: connected/);

  const logout = await fetch(`${origin}/logout`, { method: "POST", headers: { Cookie: cookie } });
  assert.equal(logout.status, 200);
  const tail = await readUntilClosed(reader);
  assert.match(tail, /event: session-ended/);
  assert.match(tail, /"reason":"logout"/);
  assert.equal(streams.size, 0);
});

async function readUntilClosed(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  let output = "";
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await readWithTimeout(reader);
    if (result.done) return output;
    output += Buffer.from(result.value).toString();
  }
  throw new Error("SSE stream did not close");
}

function readWithTimeout(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SSE stream did not close")), 2_000);
    void reader.read().then(
      (result) => { clearTimeout(timer); resolve(result); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

function fakeResponse(): Response {
  return {
    writableEnded: false,
    end() { this.writableEnded = true; return this; }
  } as unknown as Response;
}
