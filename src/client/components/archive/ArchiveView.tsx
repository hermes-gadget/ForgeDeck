import { useCallback, useEffect, useState } from "react";
import {
  Archive, CalendarClock, Clock3, Folder, Infinity as InfinityIcon, LoaderCircle, Pin, PinOff, RefreshCw, RotateCcw, ShieldCheck
} from "lucide-react";
import { api } from "../../api/client";
import type { ArchiveEntry, ArchiveResponse } from "../../types";

type ArchiveViewProps = {
  onError: (error: unknown) => void;
  onPinned: (threadId: string, pinned: boolean) => void;
  onRestored: (threadId: string) => Promise<void> | void;
};

export function ArchiveHeader() {
  return <div className="control-header archive-header">
    <div className="control-header-icon"><Archive size={18} /></div>
    <div><strong>Archive & retention</strong><span>Recovery, cleanup timing, and exemptions</span></div>
  </div>;
}

export function ArchiveView({ onError, onPinned, onRestored }: ArchiveViewProps) {
  const [response, setResponse] = useState<ArchiveResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async (signal?: AbortSignal, quiet = false) => {
    quiet ? setRefreshing(true) : setLoading(true);
    try {
      const next = await api<ArchiveResponse>("/api/archive", { signal });
      setResponse(next);
      setMessage("");
    } catch (error) {
      if ((error as { name?: unknown })?.name !== "AbortError") {
        setMessage(error instanceof Error ? error.message : "The archive could not be loaded.");
        onError(error);
      }
    } finally {
      quiet ? setRefreshing(false) : setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const setItemBusy = useCallback((threadId: string, value: boolean) => {
    setBusy((current) => {
      const next = new Set(current);
      value ? next.add(threadId) : next.delete(threadId);
      return next;
    });
  }, []);

  const togglePin = useCallback(async (entry: ArchiveEntry) => {
    if (busy.has(entry.id)) return;
    const pinned = !entry.pinned;
    setItemBusy(entry.id, true);
    try {
      await api(`/api/sessions/${encodeURIComponent(entry.id)}/pin`, {
        method: "POST",
        body: JSON.stringify({ pinned })
      });
      setResponse((current) => current ? {
        ...current,
        data: current.data.map((candidate) => candidate.id === entry.id
          ? {
            ...candidate,
            pinned,
            permanentDeletionAt: pinned ? null : retentionDeadline(candidate.archivedAt, current.retention.archiveRetentionHours),
            remainingTimeMs: pinned ? null : retentionRemaining(candidate.archivedAt, current.retention.archiveRetentionHours, Date.now()),
            daysUntilPermanentDeletion: pinned ? null : retentionDays(candidate.archivedAt, current.retention.archiveRetentionHours, Date.now())
          }
          : candidate)
      } : current);
      onPinned(entry.id, pinned);
    } catch (error) {
      onError(error);
    } finally {
      setItemBusy(entry.id, false);
    }
  }, [busy, onError, onPinned, setItemBusy]);

  const restore = useCallback(async (entry: ArchiveEntry) => {
    if (busy.has(entry.id) || !entry.restorable) return;
    setItemBusy(entry.id, true);
    try {
      await api(`/api/sessions/${encodeURIComponent(entry.id)}/restore`, { method: "POST", body: "{}" });
      setResponse((current) => current ? { ...current, data: current.data.filter((candidate) => candidate.id !== entry.id) } : current);
      await onRestored(entry.id);
    } catch (error) {
      onError(error);
    } finally {
      setItemBusy(entry.id, false);
    }
  }, [busy, onError, onRestored, setItemBusy]);

  const entries = response?.data || [];
  const retainedCount = entries.filter((entry) => entry.pinned).length;

  return <div className="archive-view">
    <section className="retention-policy" aria-labelledby="retention-policy-title">
      <div className="retention-policy-heading">
        <div><ShieldCheck size={17} /><span><strong id="retention-policy-title">Retention policy</strong><small>Pinned sessions are exempt from automatic TTL cleanup.</small></span></div>
        <button className="icon-button" onClick={() => void load(undefined, true)} disabled={refreshing} aria-label="Refresh archive"><RefreshCw className={refreshing ? "spin" : ""} size={15} /></button>
      </div>
      <div className="retention-policy-grid">
        <PolicyValue label="Standard session TTL" value={hoursLabel(response?.retention.ttlHours)} detail="Idle time before automatic archive" />
        <PolicyValue label="Spark session TTL" value={hoursLabel(response?.retention.sparkTtlHours)} detail="Idle time before automatic archive" />
        <PolicyValue label="Archive retention" value={hoursLabel(response?.retention.archiveRetentionHours)} detail="Time before permanent cleanup" />
        <PolicyValue label="Pinned exemptions" value={String(retainedCount)} detail="Retained until manually unpinned" />
      </div>
    </section>

    <div className="archive-list-heading"><div><strong>Archived sessions</strong><span>{entries.length} retained</span></div></div>
    {message && <div className="archive-message" role="alert">{message}<button onClick={() => void load()}>Try again</button></div>}
    {loading ? <div className="archive-empty"><LoaderCircle className="spin" size={24} />Loading archived sessions…</div>
      : entries.length ? <div className="archive-list">{entries.map((entry) => <ArchiveCard
        key={entry.id}
        entry={entry}
        now={now}
        retentionHours={response?.retention.archiveRetentionHours ?? null}
        busy={busy.has(entry.id)}
        onPin={() => void togglePin(entry)}
        onRestore={() => void restore(entry)}
      />)}</div>
        : !message && <div className="archive-empty"><Archive size={34} /><h2>The archive is empty</h2><p>Manually archived and TTL-cleaned sessions will appear here with their recovery window.</p></div>}
  </div>;
}

function PolicyValue({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <article><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function ArchiveCard({ entry, now, retentionHours, busy, onPin, onRestore }: {
  entry: ArchiveEntry;
  now: number;
  retentionHours: number | null;
  busy: boolean;
  onPin: () => void;
  onRestore: () => void;
}) {
  const remaining = entry.pinned ? null : entry.permanentDeletionAt
    ? Math.max(0, Date.parse(entry.permanentDeletionAt) - now)
    : retentionRemaining(entry.archivedAt, retentionHours, now);
  return <article className={`archive-card ${entry.pinned ? "pinned" : ""}`}>
    <header>
      <div className="archive-card-icon"><Archive size={17} /></div>
      <div className="archive-card-title"><strong>{entry.name}</strong><span>{entry.backend === "claude" ? "Claude" : "Codex"} · {entry.sessionClass === "spark" ? "Spark" : "Standard"}</span></div>
      <span className={`archive-reason ${entry.reason}`}>{entry.reason === "ttl" ? <Clock3 size={11} /> : <Archive size={11} />}{entry.reason === "ttl" ? "TTL cleanup" : "Manual archive"}</span>
    </header>
    <div className="archive-card-details">
      <span><CalendarClock size={13} /><b>Archived</b>{formatDate(entry.archivedAt)}</span>
      <span><Clock3 size={13} /><b>Session TTL</b>{entry.ttlHours === null ? "Disabled" : `${formatNumber(entry.ttlHours)} hours`}</span>
      {entry.cwd && <span title={entry.cwd}><Folder size={13} /><b>Workspace</b>{basename(entry.cwd)}</span>}
    </div>
    <div className={`archive-countdown ${entry.pinned ? "exempt" : remaining !== null && remaining <= 86_400_000 ? "urgent" : ""}`}>
      {entry.pinned ? <><Pin size={16} /><span><strong>Pinned · retained indefinitely</strong><small>Exempt from automatic TTL and permanent cleanup.</small></span></>
        : remaining === null ? <><InfinityIcon size={17} /><span><strong>No automatic deletion</strong><small>Archive retention is disabled by the operator.</small></span></>
          : <><Clock3 size={16} /><span><strong>{remaining <= 0 ? "Permanent deletion is due" : `${remainingLabel(remaining)} until permanent deletion`}</strong><small>{formatRemaining(remaining)} remaining in the recovery window.</small></span></>}
    </div>
    <footer>
      <button className={`archive-pin ${entry.pinned ? "active" : ""}`} disabled={busy} onClick={onPin} aria-pressed={entry.pinned} title="Pinned sessions are exempt from automatic TTL cleanup">{busy ? <LoaderCircle className="spin" size={14} /> : entry.pinned ? <PinOff size={14} /> : <Pin size={14} />}{entry.pinned ? "Unpin" : "Pin to retain"}</button>
      <button className="archive-restore" disabled={busy || !entry.restorable} onClick={onRestore} title={entry.restorable ? "Restore this session to the active inventory" : "This provider cannot restore an archived session"}><RotateCcw size={14} />{entry.restorable ? "Restore" : "Restore unavailable"}</button>
    </footer>
  </article>;
}

function retentionDeadline(archivedAt: string, hours: number | null): string | null {
  if (hours === null) return null;
  return new Date(Date.parse(archivedAt) + hours * 3_600_000).toISOString();
}

function retentionRemaining(archivedAt: string, hours: number | null, now: number): number | null {
  const deadline = retentionDeadline(archivedAt, hours);
  return deadline ? Math.max(0, Date.parse(deadline) - now) : null;
}

function retentionDays(archivedAt: string, hours: number | null, now: number): number | null {
  const remaining = retentionRemaining(archivedAt, hours, now);
  return remaining === null ? null : Math.ceil(remaining / 86_400_000);
}

function remainingLabel(milliseconds: number): string {
  const days = Math.ceil(milliseconds / 86_400_000);
  if (days >= 2) return `${days} days`;
  const hours = Math.ceil(milliseconds / 3_600_000);
  return hours > 1 ? `${hours} hours` : "Less than 1 hour";
}

function formatRemaining(milliseconds: number): string {
  if (milliseconds <= 0) return "No time";
  const days = Math.floor(milliseconds / 86_400_000);
  const hours = Math.ceil((milliseconds % 86_400_000) / 3_600_000);
  return days ? `${days}d${hours ? ` ${hours}h` : ""}` : `${Math.max(1, hours)}h`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function hoursLabel(value: number | null | undefined): string {
  return value == null ? "Disabled" : `${formatNumber(value)}h`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function basename(value: string): string {
  return value.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || value;
}
