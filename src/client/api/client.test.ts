import assert from "node:assert/strict";
import test from "node:test";
import { api, apiErrorFromPayload, ApiError, isSessionRemovalError } from "./client.js";

test("API errors preserve typed server fields and expose a retry action", async () => {
  const originalFetch = globalThis.fetch;
  const requestIds: string[] = [];
  let calls = 0;
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    requestIds.push(new Headers(init?.headers).get("X-Request-Id") || "");
    if (calls === 1) {
      return Response.json({
        error: "Codex runtime is temporarily unavailable",
        type: "BackendUnavailableError",
        code: "CODEX_UNAVAILABLE",
        message: "Codex runtime is temporarily unavailable",
        retryable: true,
        requestId: "request-123",
        scope: "sessions",
        sessionId: "thread-12345678",
        status: 503,
        retryAfter: 2
      }, { status: 503 });
    }
    return Response.json({
      thread: {
        id: "thread-12345678",
        createdAt: "2026-07-16T12:00:00.000Z",
        updatedAt: "2026-07-16T12:00:00.000Z",
        status: { type: "idle" }
      }
    });
  }) as typeof fetch;

  try {
    let caught: ApiError | null = null;
    try {
      await api("/api/threads/thread-12345678");
    } catch (error) {
      caught = error as ApiError;
    }
    assert.ok(caught instanceof ApiError);
    assert.equal(caught.type, "BackendUnavailableError");
    assert.equal(caught.retryable, true);
    assert.equal(caught.requestId, "request-123");
    assert.equal(caught.scope, "sessions");
    assert.equal(caught.sessionId, "thread-12345678");
    assert.ok(caught.retry);
    const retried = await caught.retry!() as { thread: { id: string } };
    assert.equal(retried.thread.id, "thread-12345678");
    assert.equal(calls, 2);
    assert.ok(requestIds.every(Boolean));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SSE error payloads use the same typed client error", () => {
  const error = apiErrorFromPayload({
    type: "CapacityError",
    code: "BACKEND_CAPACITY_EXHAUSTED",
    message: "The selected backend is at capacity",
    retryable: true,
    requestId: "capacity-request",
    scope: "sessions",
    sessionId: "thread-abcdefgh",
    status: 429
  });

  assert.equal(error.type, "CapacityError");
  assert.equal(error.code, "BACKEND_CAPACITY_EXHAUSTED");
  assert.equal(error.requestId, "capacity-request");
});

test("only intentional archive/removal responses are treated as tombstones", () => {
  assert.equal(isSessionRemovalError(new ApiError("Session has been removed", {
    status: 404, code: "SESSION_NOT_FOUND", scope: "sessions", sessionId: "thread-12345678"
  })), true);
  assert.equal(isSessionRemovalError(new ApiError("This session is being archived", {
    status: 409, code: "SESSION_ARCHIVING", scope: "sessions", sessionId: "thread-12345678"
  })), true);
  assert.equal(isSessionRemovalError(new ApiError("This session is temporarily unavailable", {
    status: 404, code: "SESSION_UNAVAILABLE", scope: "sessions", sessionId: "thread-12345678"
  })), false);
});

test("an aborted response body remains an AbortError", async () => {
  const originalFetch = globalThis.fetch;
  const response = Response.json({ ok: true });
  response.json = async () => { throw new DOMException("The operation was aborted", "AbortError"); };
  globalThis.fetch = (async () => response) as typeof fetch;

  try {
    await assert.rejects(api("/api/diagnostics/performance"), (error: unknown) => {
      assert.equal((error as Error).name, "AbortError");
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
