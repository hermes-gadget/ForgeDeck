import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Bell, Copy, RefreshCw, Trash2, X } from "lucide-react";
import { ApiError, type ErrorScope, type ServerErrorType } from "../../api/client";
import { useSwipeDismiss } from "../../hooks/use-swipe-dismiss";
import { readStoredJson, writeStoredJson } from "../../state/preferences";

const STORAGE_KEY = "forgedeck-errors";
const MAX_ENTRIES = 50;
const ERROR_AGGREGATION_VERSION = 2 as const;
export const INCIDENT_SEPARATION_MS = 60_000;

export type ErrorEntry = {
  aggregationVersion: typeof ERROR_AGGREGATION_VERSION;
  id: string;
  dedupeKey: string;
  type: ServerErrorType;
  code: string;
  message: string;
  retryable: boolean;
  requestId: string | null;
  scope: ErrorScope;
  sessionId: string | null;
  count: number;
  firstOccurredAt: number;
  lastOccurredAt: number;
  retry: (() => Promise<unknown>) | null;
  retrying: boolean;
};

export function useErrorCenter() {
  const [entries, setEntries] = useState<ErrorEntry[]>(readStoredErrors);
  const [open, setOpen] = useState(false);
  const keys = useRef(new Set(entries.map((entry) => entry.dedupeKey)));

  useEffect(() => {
    writeStoredJson(STORAGE_KEY, entries.map(({ retry: _retry, retrying: _retrying, ...entry }) => entry));
  }, [entries]);

  const report = useCallback((caught: unknown) => {
    if ((caught as Error)?.name === "AbortError") return;
    const error = normalizeClientError(caught);
    const dedupeKey = errorDedupeKey(error);
    const now = Date.now();
    const isNew = !keys.current.has(dedupeKey);
    if (isNew) {
      keys.current.add(dedupeKey);
      setOpen(true);
    }
    setEntries((current) => mergeErrorOccurrence(current, error, now));
  }, []);

  // Live reconnect and fallback polling already expose transport state in the
  // header. A short service restart should not also become a persistent error
  // entry; explicit user actions continue to use `report` and remain visible.
  const reportAutomatic = useCallback((caught: unknown) => {
    if (isConnectionFailure(caught)) return;
    report(caught);
  }, [report]);

  const dismiss = useCallback((id: string) => {
    setEntries((current) => {
      const removed = current.find((entry) => entry.id === id);
      if (removed) keys.current.delete(removed.dedupeKey);
      return current.filter((entry) => entry.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
    keys.current.clear();
    setEntries([]);
  }, []);

  const retry = useCallback(async (id: string): Promise<boolean> => {
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry?.retry) return false;
    setEntries((current) => current.map((candidate) => candidate.id === id ? { ...candidate, retrying: true } : candidate));
    try {
      await entry.retry();
      dismiss(id);
      return true;
    } catch (error) {
      setEntries((current) => current.map((candidate) => candidate.id === id ? { ...candidate, retrying: false } : candidate));
      report(error);
      return false;
    }
  }, [dismiss, entries, report]);

  return { entries, open, setOpen, report, reportAutomatic, dismiss, clear, retry };
}

/** Merge polling repeats into one incident; count only recurrences after a quiet period. */
export function mergeErrorOccurrence(current: ErrorEntry[], error: ApiError, now = Date.now()): ErrorEntry[] {
  const dedupeKey = errorDedupeKey(error);
  const existing = current.find((entry) => entry.dedupeKey === dedupeKey);
  if (existing) {
    const separateIncident = now - existing.lastOccurredAt > INCIDENT_SEPARATION_MS;
    return [{
      ...existing,
      aggregationVersion: ERROR_AGGREGATION_VERSION,
      retryable: error.retryable,
      requestId: error.requestId || existing.requestId,
      sessionId: error.sessionId || existing.sessionId,
      count: existing.count + Number(separateIncident),
      lastOccurredAt: now,
      retry: error.retry || existing.retry,
      retrying: false
    }, ...current.filter((entry) => entry.id !== existing.id)];
  }
  return [{
    aggregationVersion: ERROR_AGGREGATION_VERSION,
    id: createId(),
    dedupeKey,
    type: error.type,
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    requestId: error.requestId,
    scope: error.scope,
    sessionId: error.sessionId,
    count: 1,
    firstOccurredAt: now,
    lastOccurredAt: now,
    retry: error.retry,
    retrying: false
  }, ...current].slice(0, MAX_ENTRIES);
}

export function errorDedupeKey(error: Pick<ApiError, "type" | "code" | "message" | "scope" | "sessionId">): string {
  const connectionFailure = error.code === "NETWORK_ERROR" || error.code === "REQUEST_TIMEOUT";
  return connectionFailure
    ? [error.type, error.code, "transport", "", error.message].join("|")
    : [error.type, error.code, error.scope, error.sessionId || "", error.message].join("|");
}

function isConnectionFailure(caught: unknown): boolean {
  return caught instanceof ApiError && (caught.code === "NETWORK_ERROR" || caught.code === "REQUEST_TIMEOUT");
}

export function ErrorCenter({
  entries,
  open,
  sessionNames,
  onOpen,
  onClose,
  onDismiss,
  onClear,
  onRetry
}: {
  entries: ErrorEntry[];
  open: boolean;
  sessionNames: Readonly<Record<string, string>>;
  onOpen: () => void;
  onClose: () => void;
  onDismiss: (id: string) => void;
  onClear: () => void;
  onRetry: (id: string) => void;
}) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openedByTriggerRef = useRef(false);
  const swipeDismiss = useSwipeDismiss<HTMLElement>(onClose, { direction: "right", enabled: open });
  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const shouldManageFocus = openedByTriggerRef.current;
    if (shouldManageFocus) closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (shouldManageFocus) trigger?.focus();
      openedByTriggerRef.current = false;
    };
  }, [onClose, open]);
  const copyRequestId = async (entry: ErrorEntry) => {
    if (!entry.requestId) return;
    await navigator.clipboard.writeText(entry.requestId);
    setCopiedId(entry.id);
    window.setTimeout(() => setCopiedId((current) => current === entry.id ? null : current), 1_500);
  };

  return <>
    <button ref={triggerRef} className={`error-center-trigger ${entries.length ? "has-errors" : ""}`} onClick={() => { openedByTriggerRef.current = true; onOpen(); }} aria-label={`Open error center${entries.length ? `, ${entries.length} errors` : ""}`} aria-expanded={open} aria-controls={open ? "error-center-drawer" : undefined}>
      <Bell size={17} />
      {entries.length > 0 && <span>{entries.length > 99 ? "99+" : entries.length}</span>}
    </button>
    {open && <aside {...swipeDismiss} className="error-center swipe-dismiss-right" id="error-center-drawer" role="dialog" aria-modal="false" aria-labelledby="error-center-title">
      <header>
        <div><AlertTriangle size={18} /><span><strong id="error-center-title">Error center</strong><small>{entries.length ? `${entries.length} persistent issue${entries.length === 1 ? "" : "s"}` : "No recorded issues"}</small></span></div>
        <div>{entries.length > 0 && <button onClick={onClear} aria-label="Clear all errors"><Trash2 size={15} /></button>}<button ref={closeRef} onClick={onClose} aria-label="Close error center"><X size={17} /></button></div>
      </header>
      <div className="error-center-list">
        {entries.length === 0 ? <div className="error-center-empty"><Bell size={27} /><strong>All clear</strong><span>New errors will stay here until you dismiss them.</span></div> : entries.map((entry) => <article className="error-entry" key={entry.id}>
          <div className="error-entry-heading"><span className={`error-type type-${entry.type}`}>{typeLabel(entry.type)}</span>{entry.count > 1 && <span className="error-count">×{entry.count}</span>}<time dateTime={new Date(entry.lastOccurredAt).toISOString()}>{formatTime(entry.lastOccurredAt)}</time><button onClick={() => onDismiss(entry.id)} aria-label="Dismiss error"><X size={14} /></button></div>
          <p>{entry.message}</p>
          <dl><div><dt>Scope</dt><dd>{scopeLabel(entry.scope)}</dd></div><div><dt>Session</dt><dd title={entry.sessionId || undefined}>{entry.sessionId ? sessionNames[entry.sessionId] || shortId(entry.sessionId) : "All sessions"}</dd></div></dl>
          <div className="error-entry-actions">
            {entry.requestId ? <button className="request-id" onClick={() => void copyRequestId(entry)} title={entry.requestId}><Copy size={13} /><code>{copiedId === entry.id ? "Copied" : shortId(entry.requestId)}</code></button> : <span className="request-id unavailable">No request ID</span>}
            {entry.retryable && <button className="retry-error" disabled={!entry.retry || entry.retrying} onClick={() => onRetry(entry.id)} title={!entry.retry ? "Retry is unavailable after reloading the page" : undefined}><RefreshCw className={entry.retrying ? "spin" : ""} size={13} />{entry.retrying ? "Retrying" : "Retry"}</button>}
          </div>
        </article>)}
      </div>
    </aside>}
  </>;
}

function normalizeClientError(caught: unknown): ApiError {
  if (caught instanceof ApiError) return caught;
  return new ApiError(caught instanceof Error ? caught.message : "An unexpected browser error occurred", {
    type: "InternalError",
    code: "CLIENT_ERROR",
    retryable: false,
    requestId: createId(),
    scope: "api"
  });
}

function readStoredErrors(): ErrorEntry[] {
  const value = readStoredJson(STORAGE_KEY);
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): ErrorEntry[] => {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || typeof candidate.message !== "string") return [];
    if (!isErrorType(candidate.type) || !isScope(candidate.scope)) return [];
    const code = typeof candidate.code === "string" ? candidate.code : "REQUEST_FAILED";
    const sessionId = typeof candidate.sessionId === "string" ? candidate.sessionId : null;
    const dedupeKey = errorDedupeKey({
      type: candidate.type,
      code,
      message: candidate.message,
      scope: candidate.scope,
      sessionId
    });
    return [{
      aggregationVersion: ERROR_AGGREGATION_VERSION,
      id: candidate.id,
      dedupeKey,
      type: candidate.type,
      code,
      message: candidate.message,
      retryable: candidate.retryable === true,
      requestId: typeof candidate.requestId === "string" ? candidate.requestId : null,
      scope: candidate.scope,
      sessionId,
      // Version-one counts represented automatic polling attempts. Collapse
      // them during migration so existing ×70-style storms become one incident.
      count: candidate.aggregationVersion === ERROR_AGGREGATION_VERSION
        && typeof candidate.count === "number" && candidate.count > 0 ? candidate.count : 1,
      firstOccurredAt: typeof candidate.firstOccurredAt === "number" ? candidate.firstOccurredAt : Date.now(),
      lastOccurredAt: typeof candidate.lastOccurredAt === "number" ? candidate.lastOccurredAt : Date.now(),
      retry: null,
      retrying: false
    }];
  }).slice(0, MAX_ENTRIES);
}

function typeLabel(type: ServerErrorType): string {
  return ({
    ValidationError: "Validation",
    NotFoundError: "Not found",
    ConflictError: "Conflict",
    CapacityError: "Capacity",
    BackendUnavailableError: "Backend",
    InternalError: "Internal"
  })[type];
}

function scopeLabel(scope: ErrorScope): string {
  return ({ authentication: "Authentication", runtime: "Runtime", sessions: "Sessions", workspace: "Workspace", approvals: "Approvals", background: "Background tasks", api: "ForgeDeck API" })[scope];
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() || `error-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isErrorType(value: unknown): value is ServerErrorType {
  return typeof value === "string" && ["ValidationError", "NotFoundError", "ConflictError", "CapacityError", "BackendUnavailableError", "InternalError"].includes(value);
}

function isScope(value: unknown): value is ErrorScope {
  return typeof value === "string" && ["authentication", "runtime", "sessions", "workspace", "approvals", "background", "api"].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
