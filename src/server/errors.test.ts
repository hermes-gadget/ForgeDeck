import assert from "node:assert/strict";
import test from "node:test";
import {
  BackendUnavailableError,
  CapacityError,
  ConflictError,
  InternalError,
  NotFoundError,
  serializeError,
  ValidationError
} from "./errors.js";

test("stable errors retain operational fields and hide their cause when serialized", () => {
  const cause = new Error("provider secret");
  const error = new BackendUnavailableError("Codex is temporarily unavailable", {
    cause,
    requestId: "req-1",
    retryAfter: 2,
    scope: "runtime"
  });

  assert.equal(error.cause, cause);
  assert.deepEqual(serializeError(error), {
    type: "BackendUnavailableError",
    code: "BACKEND_UNAVAILABLE",
    message: "Codex is temporarily unavailable",
    retryable: true,
    requestId: "req-1",
    scope: "runtime",
    sessionId: null,
    status: 503,
    retryAfter: 2
  });
  assert.doesNotMatch(JSON.stringify(serializeError(error)), /provider secret/);
});

test("every public error class has stable status and retryability defaults", () => {
  const errors = [
    new ValidationError("invalid"),
    new NotFoundError("missing"),
    new ConflictError("conflict"),
    new CapacityError("busy"),
    new BackendUnavailableError("offline"),
    new InternalError()
  ];

  assert.deepEqual(errors.map(({ type, status, retryable }) => ({ type, status, retryable })), [
    { type: "ValidationError", status: 400, retryable: false },
    { type: "NotFoundError", status: 404, retryable: false },
    { type: "ConflictError", status: 409, retryable: false },
    { type: "CapacityError", status: 429, retryable: true },
    { type: "BackendUnavailableError", status: 503, retryable: true },
    { type: "InternalError", status: 500, retryable: false }
  ]);
});
