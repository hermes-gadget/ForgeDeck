export type ForgeDeckErrorType =
  | "ValidationError"
  | "NotFoundError"
  | "ConflictError"
  | "CapacityError"
  | "BackendUnavailableError"
  | "InternalError";

export type ErrorScope =
  | "authentication"
  | "runtime"
  | "sessions"
  | "workspace"
  | "approvals"
  | "background"
  | "api";

export type ForgeDeckErrorOptions = {
  code?: string;
  retryable?: boolean;
  cause?: unknown;
  requestId?: string | null;
  status?: number;
  retryAfter?: number;
  scope?: ErrorScope;
  sessionId?: string | null;
};

export type SerializedForgeDeckError = {
  type: ForgeDeckErrorType;
  code: string;
  message: string;
  retryable: boolean;
  requestId: string | null;
  scope: ErrorScope;
  sessionId: string | null;
  status: number;
  retryAfter?: number;
};

/**
 * A server-side error whose message is safe to expose. The original cause is
 * retained for structured logs only and is deliberately omitted from JSON.
 */
export abstract class ForgeDeckError extends Error {
  abstract readonly type: ForgeDeckErrorType;
  override readonly cause: unknown;
  readonly safeMessage: string;
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;
  readonly retryAfter?: number;
  readonly scope?: ErrorScope;
  readonly sessionId: string | null;
  requestId: string | null;

  protected constructor(
    safeMessage: string,
    defaults: { code: string; retryable: boolean; status: number },
    options: ForgeDeckErrorOptions = {}
  ) {
    super(safeMessage, options.cause === undefined ? undefined : { cause: options.cause });
    this.cause = options.cause;
    this.safeMessage = safeMessage;
    this.code = options.code || defaults.code;
    this.retryable = options.retryable ?? defaults.retryable;
    this.status = options.status ?? defaults.status;
    this.retryAfter = positiveInteger(options.retryAfter);
    this.requestId = options.requestId || null;
    this.scope = options.scope;
    this.sessionId = options.sessionId || null;
  }
}

export class ValidationError extends ForgeDeckError {
  readonly type = "ValidationError" as const;

  constructor(safeMessage: string, options: ForgeDeckErrorOptions = {}) {
    super(safeMessage, { code: "INVALID_REQUEST", retryable: false, status: 400 }, options);
    this.name = this.type;
  }
}

export class NotFoundError extends ForgeDeckError {
  readonly type = "NotFoundError" as const;

  constructor(safeMessage: string, options: ForgeDeckErrorOptions = {}) {
    super(safeMessage, { code: "NOT_FOUND", retryable: false, status: 404 }, options);
    this.name = this.type;
  }
}

export class ConflictError extends ForgeDeckError {
  readonly type = "ConflictError" as const;

  constructor(safeMessage: string, options: ForgeDeckErrorOptions = {}) {
    super(safeMessage, { code: "CONFLICT", retryable: false, status: 409 }, options);
    this.name = this.type;
  }
}

export class CapacityError extends ForgeDeckError {
  readonly type = "CapacityError" as const;

  constructor(safeMessage: string, options: ForgeDeckErrorOptions = {}) {
    super(safeMessage, { code: "CAPACITY_EXHAUSTED", retryable: true, status: 429 }, options);
    this.name = this.type;
  }
}

export class BackendUnavailableError extends ForgeDeckError {
  readonly type = "BackendUnavailableError" as const;

  constructor(safeMessage: string, options: ForgeDeckErrorOptions = {}) {
    super(safeMessage, { code: "BACKEND_UNAVAILABLE", retryable: true, status: 503 }, options);
    this.name = this.type;
  }
}

export class InternalError extends ForgeDeckError {
  readonly type = "InternalError" as const;

  constructor(safeMessage = "Unexpected server error", options: ForgeDeckErrorOptions = {}) {
    super(safeMessage, { code: "INTERNAL_ERROR", retryable: false, status: 500 }, options);
    this.name = this.type;
  }
}

export function serializeError(
  error: ForgeDeckError,
  fallback: { requestId?: string | null; scope?: ErrorScope; sessionId?: string | null } = {}
): SerializedForgeDeckError {
  if (!error.requestId && fallback.requestId) error.requestId = fallback.requestId;
  return {
    type: error.type,
    code: error.code,
    message: error.safeMessage,
    retryable: error.retryable,
    requestId: error.requestId,
    scope: error.scope || fallback.scope || "api",
    sessionId: error.sessionId || fallback.sessionId || null,
    status: error.status,
    ...(error.retryAfter ? { retryAfter: error.retryAfter } : {})
  };
}

function positiveInteger(value: number | undefined): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}
