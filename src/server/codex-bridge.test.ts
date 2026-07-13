import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { CodexBridge, CodexBridgeError, type CodexNotification } from "./codex-bridge.js";

type ProtocolHarness = { handleLine: (line: string) => void };

function deliver(bridge: CodexBridge, message: unknown): void {
  (bridge as unknown as ProtocolHarness).handleLine(JSON.stringify(message));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
    await wait(5);
  }
}

async function withMockServer(run: (server: WebSocketServer) => Promise<void>): Promise<void> {
  const previousUrl = process.env.CODEX_APP_SERVER_URL;
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  process.env.CODEX_APP_SERVER_URL = `ws://127.0.0.1:${address.port}`;
  try {
    await run(server);
  } finally {
    if (previousUrl === undefined) delete process.env.CODEX_APP_SERVER_URL;
    else process.env.CODEX_APP_SERVER_URL = previousUrl;
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function installProtocolHandler(server: WebSocketServer, onRequest: (socket: WebSocket, message: Record<string, unknown>) => void): void {
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as Record<string, unknown>;
      if (message.method === "initialize") {
        socket.send(JSON.stringify({ id: message.id, result: { userAgent: "test" } }));
        return;
      }
      if (typeof message.id === "number") onRequest(socket, message);
    });
  });
}

test("idle status reliably completes a running session without duplicating a late completion", async () => {
  const bridge = new CodexBridge({ sessionIdleGraceMs: 5 });
  const notifications: CodexNotification[] = [];
  bridge.on("notification", (notification) => notifications.push(notification));

  deliver(bridge, {
    method: "turn/started",
    params: { threadId: "thread-123", turn: { id: "turn-123", status: "inProgress" } }
  });
  assert.equal(bridge.listSessions().length, 1);

  deliver(bridge, {
    method: "thread/status/changed",
    params: { threadId: "thread-123", status: { type: "idle" } }
  });
  await wait(15);

  assert.equal(bridge.listSessions().length, 0);
  assert.equal(notifications.filter((notification) => notification.method === "turn/completed").length, 1);
  assert.equal(notifications.at(-1)?.params?.synthetic, true);

  deliver(bridge, {
    method: "turn/completed",
    params: { threadId: "thread-123", turn: { id: "turn-123", status: "completed" } }
  });
  assert.equal(notifications.filter((notification) => notification.method === "turn/completed").length, 1);
  bridge.stop();
});

test("streaming deltas are coalesced and flushed before completion", async () => {
  const bridge = new CodexBridge({ streamFlushIntervalMs: 5 });
  const notifications: CodexNotification[] = [];
  bridge.on("notification", (notification) => notifications.push(notification));

  for (const delta of ["hello", " ", "world"]) {
    deliver(bridge, {
      method: "item/agentMessage/delta",
      params: { threadId: "thread-456", itemId: "item-1", delta }
    });
  }
  deliver(bridge, {
    method: "item/completed",
    params: { threadId: "thread-456", item: { id: "item-1", type: "agentMessage" } }
  });

  assert.equal(notifications.length, 2);
  assert.equal(notifications[0].params?.delta, "hello world");
  assert.equal(notifications[1].method, "item/completed");
  bridge.stop();
});

test("server requests are bounded by their TTL", async () => {
  const bridge = new CodexBridge({ serverRequestTtlMs: 5 });
  const resolved: Array<{ id: string | number; reason?: string }> = [];
  bridge.on("serverRequestResolved", (event) => resolved.push(event));

  deliver(bridge, { id: 7, method: "item/tool/requestUserInput", params: { questions: [] } });
  assert.equal(bridge.listServerRequests().length, 1);
  await wait(15);
  assert.equal(bridge.listServerRequests().length, 0);
  assert.deepEqual(resolved, [{ id: 7, reason: "expired" }]);
  bridge.stop();
});

test("archiving a session dismisses every pending request for that thread", () => {
  const bridge = new CodexBridge();
  const resolved: Array<{ id: string | number; reason?: string }> = [];
  bridge.on("serverRequestResolved", (event) => resolved.push(event));
  deliver(bridge, { id: 8, method: "item/tool/requestUserInput", params: { threadId: "thread-archive", questions: [] } });
  deliver(bridge, { id: 9, method: "item/fileChange/requestApproval", params: { threadId: "thread-other" } });
  assert.equal(bridge.dismissServerRequestsForThread("thread-archive"), 1);
  assert.deepEqual(bridge.listServerRequests().map((request) => request.id), [9]);
  assert.deepEqual(resolved, [{ id: 8, reason: "session_archived" }]);
  bridge.stop();
});

test("a safe RPC recovers across a transient transport crash with exponential retry", async () => {
  await withMockServer(async (server) => {
    let attempts = 0;
    installProtocolHandler(server, (socket, message) => {
      if (message.method !== "thread/read") return;
      attempts += 1;
      if (attempts === 1) socket.terminate();
      else socket.send(JSON.stringify({ id: message.id, result: { thread: { id: "thread-789" } } }));
    });

    const bridge = new CodexBridge({ requestRetries: 2, retryBaseDelayMs: 1, retryMaxDelayMs: 2 });
    bridge.on("error", () => undefined);
    try {
      const result = await bridge.request<{ thread: { id: string } }>("thread/read", { threadId: "thread-789" }, 1_000);
      assert.equal(result.thread.id, "thread-789");
      assert.equal(attempts, 2);
      assert.equal(bridge.getMetrics().retryAttempts, 1);
      assert.equal(bridge.getMetrics().successRate, 1);
    } finally {
      bridge.stop();
    }
  });
});

test("a dispatched turn/start is not replayed after an ambiguous connection loss", async () => {
  await withMockServer(async (server) => {
    let attempts = 0;
    installProtocolHandler(server, (socket, message) => {
      if (message.method !== "turn/start") return;
      attempts += 1;
      socket.terminate();
    });

    const bridge = new CodexBridge({ requestRetries: 2, retryBaseDelayMs: 1, retryMaxDelayMs: 2 });
    bridge.on("error", () => undefined);
    try {
      await assert.rejects(bridge.request("turn/start", { threadId: "thread-abc", input: [] }, 1_000));
      assert.equal(attempts, 1);
      assert.equal(bridge.getMetrics().retryAttempts, 0);
      assert.equal(bridge.getMetrics().failedRequests, 1);
    } finally {
      bridge.stop();
    }
  });
});

test("active session state is reconciled after a connection crash", async () => {
  await withMockServer(async (server) => {
    installProtocolHandler(server, (socket, message) => {
      if (message.method === "thread/read") {
        socket.send(JSON.stringify({
          id: message.id,
          result: { thread: { status: { type: "idle" }, turns: [{ id: "turn-recover", status: "completed" }] } }
        }));
      }
    });

    const bridge = new CodexBridge({
      reconnectBaseDelayMs: 1,
      reconnectMaxDelayMs: 2,
      sessionRecoveryTimeoutMs: 100
    });
    const notifications: CodexNotification[] = [];
    bridge.on("notification", (notification) => notifications.push(notification));
    bridge.on("error", () => undefined);
    try {
      await bridge.start();
      const firstConnection = [...server.clients][0];
      firstConnection.send(JSON.stringify({
        method: "turn/started",
        params: { threadId: "thread-recover", turn: { id: "turn-recover", status: "inProgress" } }
      }));
      await waitFor(() => bridge.listSessions().length === 1);
      firstConnection.terminate();

      await waitFor(() => bridge.getStatus().state === "ready" && bridge.listSessions().length === 0);
      const completions = notifications.filter((notification) => notification.method === "turn/completed");
      assert.equal(completions.length, 1);
      assert.equal(completions[0].params?.reason, "reconciled_after_silence");
    } finally {
      bridge.stop();
    }
  });
});

test("running session tracking is capped to prevent unbounded retention", () => {
  const bridge = new CodexBridge({ maxTrackedSessions: 2 });
  const completions: CodexNotification[] = [];
  bridge.on("notification", (notification) => {
    if (notification.method === "turn/completed") completions.push(notification);
  });

  for (const suffix of ["one", "two", "three"]) {
    deliver(bridge, {
      method: "turn/started",
      params: { threadId: `thread-${suffix}`, turn: { id: `turn-${suffix}`, status: "inProgress" } }
    });
  }

  assert.equal(bridge.listSessions().length, 2);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].params?.reason, "session_tracking_limit_reached");
  bridge.stop();
});

test("timed out RPCs are removed from pending state and reflected in metrics", async () => {
  await withMockServer(async (server) => {
    installProtocolHandler(server, () => {
      // Deliberately leave the request unanswered.
    });
    const bridge = new CodexBridge({ requestRetries: 2 });
    bridge.on("error", () => undefined);
    try {
      await assert.rejects(
        bridge.request("thread/read", { threadId: "thread-timeout" }, 25),
        (error: unknown) => error instanceof CodexBridgeError && error.code === "TIMEOUT"
      );
      const metrics = bridge.getMetrics();
      assert.equal(metrics.pendingRpcCalls, 0);
      assert.equal(metrics.queueDepth, 0);
      assert.equal(metrics.failedRequests, 1);
      assert.equal(metrics.timedOutRequests, 1);
    } finally {
      bridge.stop();
    }
  });
});
