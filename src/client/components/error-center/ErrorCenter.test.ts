import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../../api/client.js";
import {
  errorDedupeKey,
  INCIDENT_SEPARATION_MS,
  mergeErrorOccurrence
} from "./ErrorCenter.js";

function sessionError(requestId: string): ApiError {
  return new ApiError("Unexpected server error", {
    type: "InternalError",
    status: 500,
    code: "INTERNAL_ERROR",
    retryable: false,
    requestId,
    scope: "sessions",
    sessionId: "thread-12345678"
  });
}

test("automatic polling repeats remain one incident until a quiet period", () => {
  let entries = mergeErrorOccurrence([], sessionError("request-1"), 1_000);
  entries = mergeErrorOccurrence(entries, sessionError("request-2"), 11_000);
  entries = mergeErrorOccurrence(entries, sessionError("request-3"), 21_000);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].count, 1);
  assert.equal(entries[0].requestId, "request-3");
  assert.equal(entries[0].lastOccurredAt, 21_000);

  entries = mergeErrorOccurrence(entries, sessionError("request-4"), 21_000 + INCIDENT_SEPARATION_MS + 1);
  assert.equal(entries[0].count, 2);
});

test("network failures deduplicate globally while the transport is unavailable", () => {
  const apiFailure = new ApiError("ForgeDeck could not be reached", {
    type: "BackendUnavailableError",
    code: "NETWORK_ERROR",
    scope: "api"
  });
  const sessionFailure = new ApiError("ForgeDeck could not be reached", {
    type: "BackendUnavailableError",
    code: "NETWORK_ERROR",
    scope: "sessions",
    sessionId: "thread-12345678"
  });

  assert.equal(errorDedupeKey(apiFailure), errorDedupeKey(sessionFailure));
});
