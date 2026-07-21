import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Clock3, History, LoaderCircle, RotateCcw, X } from "lucide-react";
import { api } from "../../api/client";
import type { SessionTimeline, TimelineEvent } from "../../types";

type SessionReplayProps = {
  threadId: string;
  onClose: () => void;
  onError: (error: unknown) => void;
};

export function SessionReplay({ threadId, onClose, onError }: SessionReplayProps) {
  const [timeline, setTimeline] = useState<SessionTimeline | null>(null);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void api<SessionTimeline>(`/api/sessions/${encodeURIComponent(threadId)}/timeline`, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        setTimeline(response);
        setCursor(Math.max(0, response.events.length - 1));
      })
      .catch((error) => {
        if ((error as Error).name !== "AbortError") onError(error);
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [onError, threadId]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  const events = useMemo(() => timeline?.events || [], [timeline]);
  const selected = events[cursor] || null;
  const visibleEvents = useMemo(() => events.slice(Math.max(0, cursor - 49), cursor + 1).reverse(), [cursor, events]);
  const startAt = events[0]?.timestamp || null;
  const endAt = events.at(-1)?.timestamp || null;

  return <div className="modal-backdrop replay-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="replay-dialog" role="dialog" aria-modal="true" aria-labelledby="replay-title">
      <header>
        <div><span className="replay-icon"><History size={18} /></span><span><small>Session replay</small><h2 id="replay-title">{timeline?.session.name || "Event timeline"}</h2></span></div>
        <button className="icon-button" onClick={onClose} aria-label="Close session replay"><X size={18} /></button>
      </header>
      {loading ? <div className="replay-loading"><LoaderCircle className="spin" size={20} />Loading event history…</div> : !events.length ? <div className="replay-empty"><RotateCcw size={24} /><strong>No recorded events yet</strong><span>New session activity will appear here as revisioned events arrive.</span></div> : <>
        <div className="replay-scrubber">
          <div className="replay-scrubber-labels"><span>{formatDateTime(startAt)}</span><strong>{cursor + 1} / {events.length} events</strong><span>{formatDateTime(endAt)}</span></div>
          <div className="replay-range-wrap">
            <div className="replay-track-markers" aria-hidden="true">{events.map((event, index) => <i key={event.id} className={`${event.outcome || ""} ${index <= cursor ? "seen" : ""}`} style={{ left: `${events.length === 1 ? 50 : (index / (events.length - 1)) * 100}%` }} />)}</div>
            <input type="range" min={0} max={Math.max(0, events.length - 1)} value={cursor} onChange={(event) => setCursor(Number(event.target.value))} aria-label="Replay timeline position" />
          </div>
          {selected && <div className={`replay-current ${selected.outcome || ""}`}>
            <EventStatus event={selected} />
            <span><strong>{selected.summary}</strong><small><Clock3 size={11} />{formatDateTime(selected.timestamp)} · revision {selected.revision}{selected.model ? ` · ${selected.model}` : ""}</small></span>
            <code>{selected.type}</code>
          </div>}
        </div>
        <div className="replay-event-list" aria-live="polite">
          {visibleEvents.map((event) => <article key={event.id} className={event.id === selected?.id ? "selected" : ""}>
            <button onClick={() => setCursor(events.indexOf(event))}>
              <EventStatus event={event} />
              <span><strong>{event.summary}</strong><small>{formatTime(event.timestamp)} · r{event.revision}</small></span>
              <em>{event.type}</em>
            </button>
            {event.id === selected?.id && Object.keys(event.payloadSummary).length > 0 && <dl>{Object.entries(event.payloadSummary).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{formatValue(value)}</dd></div>)}</dl>}
          </article>)}
        </div>
      </>}
      {timeline?.truncated && <footer>Showing the most recent {timeline.events.length.toLocaleString()} events.</footer>}
    </section>
  </div>;
}

function EventStatus({ event }: { event: TimelineEvent }) {
  if (event.outcome === "success") return <CheckCircle2 className="event-status success" size={16} />;
  if (event.outcome === "failed" || event.error) return <AlertCircle className="event-status failed" size={16} />;
  return <span className="event-status neutral" aria-hidden="true" />;
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  return JSON.stringify(value);
}
