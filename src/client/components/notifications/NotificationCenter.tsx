import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Bell, BellRing, CheckCircle2, ListPlus, ShieldQuestion, Trash2, X } from "lucide-react";
import { useSwipeDismiss } from "../../hooks/use-swipe-dismiss";
import { readStoredJson, writeStoredJson } from "../../state/preferences";
import type { NotificationPreferences } from "../../types";

const STORAGE_KEY = "forgedeck-notifications";
const MAX_ENTRIES = 50;
const TOAST_DURATION_MS = 6_000;

export type NotificationKind = "completed" | "failed" | "approval" | "queued";
export type DesktopNotificationPermission = NotificationPermission | "unsupported";

export type ForgeNotification = {
  id: string;
  kind: NotificationKind;
  threadId: string;
  sessionName: string;
  title: string;
  message: string;
  createdAt: number;
  seen: boolean;
};

type NewNotification = Omit<ForgeNotification, "id" | "createdAt" | "seen">;

export function useNotificationCenter(onFocusSession: (threadId: string) => void) {
  const [entries, setEntries] = useState<ForgeNotification[]>(readStoredNotifications);
  const [toasts, setToasts] = useState<ForgeNotification[]>([]);
  const [open, setOpen] = useState(false);
  const [permission, setPermission] = useState<DesktopNotificationPermission>(readDesktopPermission);
  const focusRef = useRef(onFocusSession);
  const permissionRef = useRef(permission);
  focusRef.current = onFocusSession;
  permissionRef.current = permission;

  useEffect(() => { writeStoredJson(STORAGE_KEY, entries); }, [entries]);
  useEffect(() => {
    if (!toasts.length) return;
    const oldest = toasts[toasts.length - 1];
    const remaining = Math.max(0, oldest.createdAt + TOAST_DURATION_MS - Date.now());
    const timer = window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== oldest.id)), remaining);
    return () => clearTimeout(timer);
  }, [toasts]);
  useEffect(() => {
    const refresh = () => setPermission(readDesktopPermission());
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  const requestPermission = useCallback(async (): Promise<DesktopNotificationPermission> => {
    if (typeof window.Notification === "undefined") {
      setPermission("unsupported");
      return "unsupported";
    }
    try {
      const next = await window.Notification.requestPermission();
      setPermission(next);
      return next;
    } catch {
      setPermission(readDesktopPermission());
      return readDesktopPermission();
    }
  }, []);

  const push = useCallback((input: NewNotification, desktop = false) => {
    const entry: ForgeNotification = { ...input, id: createId(), createdAt: Date.now(), seen: false };
    setEntries((current) => [entry, ...current].slice(0, MAX_ENTRIES));
    setToasts((current) => [entry, ...current].slice(0, 4));
    if (desktop && permissionRef.current === "granted" && (document.visibilityState !== "visible" || !document.hasFocus())) {
      try {
        const notification = new window.Notification(`ForgeDeck · ${input.title}`, {
          body: `${input.sessionName}: ${input.message}`,
          tag: `forgedeck-${input.kind}-${input.threadId}`
        });
        notification.onclick = () => {
          window.focus();
          focusRef.current(input.threadId);
          notification.close();
        };
      } catch {
        // The persistent in-app entry and toast remain available as a fallback.
      }
    }
  }, []);

  const openCenter = useCallback(() => {
    setOpen(true);
    setEntries((current) => current.some((entry) => !entry.seen)
      ? current.map((entry) => ({ ...entry, seen: true }))
      : current);
  }, []);
  const closeCenter = useCallback(() => setOpen(false), []);
  const focusNotification = useCallback((entry: ForgeNotification) => {
    setEntries((current) => current.map((candidate) => candidate.id === entry.id ? { ...candidate, seen: true } : candidate));
    setToasts((current) => current.filter((candidate) => candidate.id !== entry.id));
    setOpen(false);
    focusRef.current(entry.threadId);
  }, []);
  const dismiss = useCallback((id: string) => {
    setEntries((current) => current.filter((entry) => entry.id !== id));
    setToasts((current) => current.filter((entry) => entry.id !== id));
  }, []);
  const clear = useCallback(() => setEntries([]), []);
  const dismissToast = useCallback((id: string) => setToasts((current) => current.filter((entry) => entry.id !== id)), []);
  const unseenCount = useMemo(() => entries.filter((entry) => !entry.seen).length, [entries]);

  return {
    entries, toasts, open, permission, unseenCount,
    push, openCenter, closeCenter, focusNotification, dismiss, clear, dismissToast, requestPermission
  };
}

export function NotificationCenter({ entries, open, onClose, onFocus, onDismiss, onClear }: {
  entries: ForgeNotification[];
  open: boolean;
  onClose: () => void;
  onFocus: (entry: ForgeNotification) => void;
  onDismiss: (id: string) => void;
  onClear: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);
  const swipeDismiss = useSwipeDismiss<HTMLElement>(onClose, { direction: "right", enabled: open });
  if (!open) return null;
  return <aside {...swipeDismiss} className="notification-center swipe-dismiss-right" id="notification-center-drawer" role="dialog" aria-modal="false" aria-labelledby="notification-center-title">
    <header>
      <div><BellRing size={18} /><span><strong id="notification-center-title">Notification center</strong><small>{entries.length ? `${entries.length} recent event${entries.length === 1 ? "" : "s"}` : "No recent events"}</small></span></div>
      <div>{entries.length > 0 && <button onClick={onClear} aria-label="Clear all notifications"><Trash2 size={15} /></button>}<button ref={closeRef} onClick={onClose} aria-label="Close notification center"><X size={17} /></button></div>
    </header>
    <div className="notification-center-list">
      {entries.length === 0 ? <div className="notification-center-empty"><Bell size={27} /><strong>Nothing needs your attention</strong><span>Opted-in session events and queued work will appear here.</span></div> : entries.map((entry) => <article className={`notification-entry kind-${entry.kind}`} key={entry.id}>
        <button className="notification-entry-main" onClick={() => onFocus(entry)}>
          <span className="notification-entry-icon">{notificationIcon(entry.kind)}</span>
          <span><span><strong>{entry.title}</strong><time dateTime={new Date(entry.createdAt).toISOString()}>{formatTime(entry.createdAt)}</time></span><b>{entry.sessionName}</b><small>{entry.message}</small></span>
        </button>
        <button className="notification-entry-dismiss" onClick={() => onDismiss(entry.id)} aria-label={`Dismiss ${entry.title} notification`}><X size={14} /></button>
      </article>)}
    </div>
  </aside>;
}

export function NotificationToasts({ entries, onFocus, onDismiss }: {
  entries: ForgeNotification[];
  onFocus: (entry: ForgeNotification) => void;
  onDismiss: (id: string) => void;
}) {
  if (!entries.length) return null;
  return <div className="notification-toasts" aria-live="polite" aria-atomic="false">
    {entries.map((entry) => <NotificationToast key={entry.id} entry={entry} onFocus={onFocus} onDismiss={onDismiss} />)}
  </div>;
}

function NotificationToast({ entry, onFocus, onDismiss }: {
  entry: ForgeNotification;
  onFocus: (entry: ForgeNotification) => void;
  onDismiss: (id: string) => void;
}) {
  const swipeDismiss = useSwipeDismiss<HTMLDivElement>(() => onDismiss(entry.id), { direction: "either" });
  return <div {...swipeDismiss} className={`notification-toast kind-${entry.kind} swipe-dismiss-horizontal`} role="status">
    <button className="notification-toast-main" onClick={() => onFocus(entry)}>{notificationIcon(entry.kind)}<span><strong>{entry.title}</strong><small>{entry.sessionName} · {entry.message}</small></span></button>
    <button className="notification-toast-dismiss" onClick={() => onDismiss(entry.id)} aria-label="Dismiss notification"><X size={15} /></button>
  </div>;
}

export function SessionNotificationPreferences({ value, permission, onChange }: {
  value: NotificationPreferences;
  permission: DesktopNotificationPermission;
  onChange: (value: NotificationPreferences) => void;
}) {
  const enabled = value.onCompletion || value.onFailure || value.onApprovalNeeded;
  return <details className="notification-settings">
    <summary className={`icon-button ${enabled ? "enabled" : ""}`} aria-label="Session notification settings" title="Session notification settings"><BellRing size={16} /></summary>
    <div className="notification-settings-panel">
      <strong>Notify for this session</strong>
      <p>Choose when ForgeDeck should bring this session back to your attention.</p>
      <label><input type="checkbox" checked={value.onCompletion} onChange={(event) => onChange({ ...value, onCompletion: event.target.checked })} /><span>Completion<small>When a turn finishes successfully</small></span></label>
      <label><input type="checkbox" checked={value.onFailure} onChange={(event) => onChange({ ...value, onFailure: event.target.checked })} /><span>Failure<small>When a turn ends with an error</small></span></label>
      <label><input type="checkbox" checked={value.onApprovalNeeded} onChange={(event) => onChange({ ...value, onApprovalNeeded: event.target.checked })} /><span>Approval needed<small>When work pauses for your decision</small></span></label>
      <div className={`notification-permission permission-${permission}`}>{permissionMessage(permission, enabled)}</div>
    </div>
  </details>;
}

function notificationIcon(kind: NotificationKind) {
  if (kind === "completed") return <CheckCircle2 size={17} />;
  if (kind === "failed") return <AlertTriangle size={17} />;
  if (kind === "approval") return <ShieldQuestion size={17} />;
  return <ListPlus size={17} />;
}

function permissionMessage(permission: DesktopNotificationPermission, enabled: boolean): string {
  if (permission === "unsupported") return "Desktop alerts are unavailable in this browser. In-app toasts will still appear.";
  if (permission === "denied") return "Desktop alerts are blocked. In-app toasts will still appear; allow notifications in your browser's site settings to enable desktop alerts.";
  if (permission === "granted") return "Desktop alerts are enabled while ForgeDeck is in the background.";
  return enabled ? "Your browser will ask for desktop notification permission." : "Enabling an alert will request desktop notification permission.";
}

function readDesktopPermission(): DesktopNotificationPermission {
  return typeof window.Notification === "undefined" ? "unsupported" : window.Notification.permission;
}

function readStoredNotifications(): ForgeNotification[] {
  const value = readStoredJson(STORAGE_KEY);
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): ForgeNotification[] => {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || !isNotificationKind(candidate.kind)) return [];
    if (typeof candidate.threadId !== "string" || typeof candidate.sessionName !== "string" || typeof candidate.title !== "string" || typeof candidate.message !== "string") return [];
    return [{
      id: candidate.id,
      kind: candidate.kind,
      threadId: candidate.threadId,
      sessionName: candidate.sessionName,
      title: candidate.title,
      message: candidate.message,
      createdAt: typeof candidate.createdAt === "number" ? candidate.createdAt : Date.now(),
      seen: candidate.seen === true
    }];
  }).slice(0, MAX_ENTRIES);
}

function isNotificationKind(value: unknown): value is NotificationKind {
  return value === "completed" || value === "failed" || value === "approval" || value === "queued";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() || `notification-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
