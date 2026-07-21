import {
  parseHttpResponse,
  type ErrorScope,
  type ServerErrorPayload,
  type ServerErrorType
} from "../../shared/contracts";

export type { ErrorScope, ServerErrorPayload, ServerErrorType } from "../../shared/contracts";

export type ApiOptions = RequestInit & {
  allowUnauthenticated?: boolean;
  timeoutMs?: number;
  conditional?: boolean;
};

type ApiErrorFields = Partial<ServerErrorPayload> & {
  details?: unknown;
  retry?: (() => Promise<unknown>) | null;
};

export class ApiError extends Error {
  readonly type: ServerErrorType;
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId: string | null;
  readonly scope: ErrorScope;
  readonly sessionId: string | null;
  readonly retryAfter?: number;
  readonly details: unknown;
  readonly retry: (() => Promise<unknown>) | null;

  constructor(message: string, fields: ApiErrorFields = {}) {
    super(message);
    this.name = "ApiError";
    this.type = fields.type || errorTypeForStatus(fields.status || 0);
    this.status = fields.status || 0;
    this.code = fields.code || "REQUEST_FAILED";
    this.retryable = fields.retryable ?? (this.type === "CapacityError" || this.type === "BackendUnavailableError");
    this.requestId = fields.requestId || null;
    this.scope = fields.scope || "api";
    this.sessionId = fields.sessionId || null;
    this.retryAfter = fields.retryAfter;
    this.details = fields.details ?? null;
    this.retry = fields.retry || null;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const conditionalResponses = new Map<string, { etag: string; payload: unknown }>();

/** Typed JSON fetch with timeout, caller cancellation, request IDs, and safe retry metadata. */
export async function api<T = unknown>(url: string, options: ApiOptions = {}): Promise<T> {
  const { allowUnauthenticated = false, timeoutMs = DEFAULT_TIMEOUT_MS, conditional = false, signal: callerSignal, ...request } = options;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  const cached = conditional ? conditionalResponses.get(url) : undefined;
  const headers = new Headers(request.headers);
  const requestId = headers.get("X-Request-Id") || createRequestId();
  const scope = scopeForUrl(url);
  const sessionId = sessionIdForUrl(url);
  const retry = () => api(url, { ...options, signal: undefined });
  const transportRetryable = ["GET", "HEAD", "OPTIONS"].includes(String(request.method || "GET").toUpperCase());
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  headers.set("X-Request-Id", requestId);
  if (cached) headers.set("If-None-Match", cached.etag);

  let response: Response;
  try {
    response = await fetch(url, { ...request, signal, headers });
  } catch {
    if (callerSignal?.aborted) throw new DOMException("The request was cancelled", "AbortError");
    if (timeout.aborted) {
      throw new ApiError("ForgeDeck did not respond in time", {
        type: "BackendUnavailableError",
        status: 0,
        code: "REQUEST_TIMEOUT",
        retryable: transportRetryable,
        requestId,
        scope,
        sessionId,
        retry: transportRetryable ? retry : null
      });
    }
    throw new ApiError("ForgeDeck could not be reached", {
      type: "BackendUnavailableError",
      status: 0,
      code: "NETWORK_ERROR",
      retryable: transportRetryable,
      requestId,
      scope,
      sessionId,
      retry: transportRetryable ? retry : null
    });
  }

  if (response.status === 304) {
    if (cached) return cached.payload as T;
    throw new ApiError("The server returned an uncached revision", {
      type: "InternalError",
      status: 304,
      code: "INVALID_CACHE_RESPONSE",
      requestId,
      scope,
      sessionId
    });
  }
  const payload = await readPayload(response, { requestId, scope, sessionId });
  if (!response.ok) {
    if (response.status === 401 && !allowUnauthenticated && url !== "/api/auth") window.location.reload();
    const parsed = parseServerError(payload, {
      requestId: response.headers.get("X-Request-Id") || requestId,
      scope,
      sessionId,
      status: response.status
    });
    throw new ApiError(parsed.message, {
      ...parsed,
      details: payload,
      retry: parsed.retryable ? retry : null
    });
  }
  let validatedPayload: unknown;
  try {
    validatedPayload = parseHttpResponse(String(request.method || "GET"), url, payload);
  } catch (error) {
    throw new ApiError("ForgeDeck returned a response that does not match its API contract", {
      type: "InternalError",
      status: response.status,
      code: "INVALID_RESPONSE_CONTRACT",
      requestId,
      scope,
      sessionId,
      details: error
    });
  }
  if (conditional) {
    const etag = response.headers.get("etag");
    if (etag) conditionalResponses.set(url, { etag, payload: validatedPayload });
  }
  return validatedPayload as T;
}

export function apiErrorFromPayload(payload: unknown, fallback: Partial<ServerErrorPayload> = {}): ApiError {
  const parsed = parseServerError(payload, fallback);
  return new ApiError(parsed.message, { ...parsed, details: payload });
}

/** A detail read can race an intentional archive before its SSE tombstone arrives. */
export function isSessionRemovalError(error: unknown): error is ApiError {
  return error instanceof ApiError
    && (error.code === "SESSION_NOT_FOUND" || error.code === "SESSION_ARCHIVING");
}

export function clearConditionalApiCache(): void {
  conditionalResponses.clear();
}

async function readPayload(response: Response, context: Pick<ServerErrorPayload, "requestId" | "scope" | "sessionId">): Promise<unknown> {
  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch (error) {
      if ((error as Error)?.name === "AbortError") throw error;
      throw new ApiError("The server returned an invalid response", {
        type: "InternalError",
        status: response.status,
        code: "INVALID_RESPONSE",
        ...context
      });
    }
  }
  const text = await response.text();
  return text || null;
}

function parseServerError(payload: unknown, fallback: Partial<ServerErrorPayload>): ServerErrorPayload {
  const record = isRecord(payload) ? payload : null;
  const status = numberField(record?.status) ?? fallback.status ?? 0;
  const type = isErrorType(record?.type) ? record.type : fallback.type || errorTypeForStatus(status);
  const message = stringField(record?.message) || stringField(record?.error) || fallback.message || `Request failed (${status})`;
  const retryAfter = numberField(record?.retryAfter);
  return {
    type,
    code: stringField(record?.code) || fallback.code || "REQUEST_FAILED",
    message,
    retryable: booleanField(record?.retryable) ?? fallback.retryable ?? (type === "CapacityError" || type === "BackendUnavailableError"),
    requestId: stringField(record?.requestId) || fallback.requestId || null,
    scope: isErrorScope(record?.scope) ? record.scope : fallback.scope || "api",
    sessionId: stringField(record?.sessionId) || fallback.sessionId || null,
    status,
    ...(retryAfter ? { retryAfter } : {})
  };
}

function errorTypeForStatus(status: number): ServerErrorType {
  if (status === 404) return "NotFoundError";
  if (status === 409) return "ConflictError";
  if (status === 429) return "CapacityError";
  if (status === 502 || status === 503 || status === 504 || status === 0) return "BackendUnavailableError";
  if (status >= 500) return "InternalError";
  return "ValidationError";
}

function scopeForUrl(url: string): ErrorScope {
  const path = url.split("?", 1)[0] || url;
  if (/\/api\/(?:auth|login|logout)/.test(path)) return "authentication";
  if (/\/api\/(?:threads|queues|recovery|schedules|missions|evals|compare)/.test(path)) return "sessions";
  if (/\/api\/(?:directories|files)/.test(path)) return "workspace";
  if (/\/api\/approvals/.test(path)) return "approvals";
  if (/\/api\/(?:account|bootstrap|health)/.test(path)) return "runtime";
  return "api";
}

function sessionIdForUrl(url: string): string | null {
  const match = /\/api\/threads\/([a-zA-Z0-9_-]{8,128})(?:\/|\?|$)/.exec(url);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function createRequestId(): string {
  return globalThis.crypto?.randomUUID?.() || `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isErrorType(value: unknown): value is ServerErrorType {
  return typeof value === "string" && [
    "ValidationError", "NotFoundError", "ConflictError", "CapacityError", "BackendUnavailableError", "InternalError"
  ].includes(value);
}

function isErrorScope(value: unknown): value is ErrorScope {
  return typeof value === "string" && ["authentication", "runtime", "sessions", "workspace", "approvals", "background", "api"].includes(value);
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanField(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
