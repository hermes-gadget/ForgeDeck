import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, BarChart3, CheckCircle2, Clock3, LoaderCircle, Search, X } from "lucide-react";
import { api } from "../../api/client";
import type { OutcomeAnalytics, SessionSearchResult } from "../../types";

type InsightsPanelProps = {
  initialTab?: "search" | "analytics";
  onClose: () => void;
  onSelectSession: (threadId: string) => void;
  onError: (error: unknown) => void;
};

export function InsightsPanel({ initialTab = "search", onClose, onSelectSession, onError }: InsightsPanelProps) {
  const [tab, setTab] = useState(initialTab);
  const [query, setQuery] = useState("");
  const [model, setModel] = useState("");
  const [outcome, setOutcome] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [results, setResults] = useState<SessionSearchResult[]>([]);
  const [analytics, setAnalytics] = useState<OutcomeAnalytics | null>(null);
  const [searching, setSearching] = useState(true);
  const [loadingAnalytics, setLoadingAnalytics] = useState(true);

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      if (model.trim()) params.set("model", model.trim());
      if (outcome) params.set("outcome", outcome);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      setSearching(true);
      void api<{ data: SessionSearchResult[]; total: number }>(`/api/search?${params}`, { signal: controller.signal })
        .then((response) => { if (!controller.signal.aborted) setResults(response.data); })
        .catch((error) => { if ((error as Error).name !== "AbortError") onError(error); })
        .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [from, model, onError, outcome, query, to]);

  useEffect(() => {
    const controller = new AbortController();
    void api<OutcomeAnalytics>("/api/analytics", { signal: controller.signal })
      .then((response) => { if (!controller.signal.aborted) setAnalytics(response); })
      .catch((error) => { if ((error as Error).name !== "AbortError") onError(error); })
      .finally(() => { if (!controller.signal.aborted) setLoadingAnalytics(false); });
    return () => controller.abort();
  }, [onError]);

  const models = useMemo(() => [...new Set([
    ...results.map((result) => result.model),
    ...(analytics?.byModel.map((entry) => entry.model) || [])
  ].filter((value): value is string => Boolean(value)))].sort(), [analytics, results]);

  return <div className="modal-backdrop insights-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="insights-dialog" role="dialog" aria-modal="true" aria-labelledby="insights-title">
      <header>
        <div><span className="insights-icon">{tab === "search" ? <Search size={18} /> : <BarChart3 size={18} />}</span><span><small>Search & analytics</small><h2 id="insights-title">Search & outcomes</h2></span></div>
        <button className="icon-button" onClick={onClose} aria-label="Close search and analytics"><X size={18} /></button>
      </header>
      <div className="insights-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "search"} className={tab === "search" ? "active" : ""} onClick={() => setTab("search")}><Search size={14} />Universal search</button>
        <button role="tab" aria-selected={tab === "analytics"} className={tab === "analytics" ? "active" : ""} onClick={() => setTab("analytics")}><BarChart3 size={14} />Outcome analytics</button>
      </div>
      {tab === "search" ? <div className="universal-search-panel" role="tabpanel">
        <div className="universal-search-controls">
          <label className="universal-query"><Search size={16} /><span className="sr-only">Search prompts, sessions, and errors</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search prompt text, errors, sessions…" />{searching && <LoaderCircle className="spin" size={15} />}{query && <button type="button" className="query-clear" onClick={() => setQuery("")} aria-label="Clear search text"><X size={13} /></button>}</label>
          <label>Model<select value={model} onChange={(event) => setModel(event.target.value)}><option value="">All models</option>{models.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <label>Outcome<select value={outcome} onChange={(event) => setOutcome(event.target.value)}><option value="">All outcomes</option><option value="success">Success</option><option value="failed">Failed</option><option value="interrupted">Interrupted</option><option value="unknown">No outcome</option></select></label>
          <label>From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
          <label>To<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        </div>
        <div className="universal-results-heading"><span>{results.length} session{results.length === 1 ? "" : "s"}</span><small>Prompts, models, outcomes, errors, and dates</small></div>
        <div className="universal-results">
          {results.map((result) => <button key={result.sessionId} onClick={() => { onSelectSession(result.sessionId); onClose(); }}>
            <OutcomeIcon outcome={result.outcome} />
            <span className="universal-result-main"><span><strong>{result.name}</strong><OutcomeBadge outcome={result.outcome} /></span><small>{result.prompt || result.matchedEvent || "No prompt summary recorded"}</small>{result.error && <em>{result.error}</em>}</span>
            <span className="universal-result-meta"><strong>{result.model || "Unknown model"}</strong><time>{formatDate(result.completedAt || result.startedAt)}</time>{result.durationMs !== null && <small><Clock3 size={11} />{formatDuration(result.durationMs)}</small>}</span>
          </button>)}
          {!searching && !results.length && <div className="insights-empty"><Search size={23} /><strong>No sessions match</strong><span>Try removing a filter or using part of the prompt or error text.</span></div>}
        </div>
      </div> : <div className="analytics-panel" role="tabpanel">
        {loadingAnalytics || !analytics ? <div className="replay-loading"><LoaderCircle className="spin" size={20} />Calculating recorded outcomes…</div> : <>
          <div className="analytics-cards">
            <Metric label="Success rate" value={`${formatPercent(analytics.totals.successRate)}%`} detail={`${analytics.totals.successful} of ${analytics.totals.runs} runs`} tone="success" />
            <Metric label="Avg completion" value={formatDuration(analytics.totals.avgCompletionTimeMs)} detail="terminal runs with timing" />
            <Metric label="Failures" value={String(analytics.totals.failed)} detail={`${analytics.totals.sessions} recorded sessions`} tone={analytics.totals.failed ? "failed" : ""} />
          </div>
          <section className="model-outcomes"><header><strong>Performance by model</strong><span>Success rate and average completion time</span></header>
            <div className="analytics-table"><div className="analytics-table-head"><span>Model</span><span>Runs</span><span>Success</span><span>Avg time</span></div>{analytics.byModel.map((entry) => <div key={entry.model}><strong>{entry.model}</strong><span>{entry.runs}</span><span className="rate-cell"><i><b style={{ width: `${entry.successRate}%` }} /></i>{formatPercent(entry.successRate)}%</span><span>{formatDuration(entry.avgCompletionTimeMs)}</span></div>)}{!analytics.byModel.length && <div className="analytics-table-empty">No terminal outcomes recorded yet.</div>}</div>
          </section>
          <section className="common-errors"><header><strong>Common error patterns</strong><span>Variable IDs, paths, and numbers are normalized</span></header>
            {analytics.commonErrors.map((entry) => <article key={entry.pattern}><AlertTriangle size={14} /><span><strong>{entry.pattern}</strong><small>{entry.models.join(", ")}</small></span><b>{entry.count}</b></article>)}
            {!analytics.commonErrors.length && <div className="analytics-table-empty">No failure patterns recorded.</div>}
          </section>
        </>}
      </div>}
    </section>
  </div>;
}

function Metric({ label, value, detail, tone = "" }: { label: string; value: string; detail: string; tone?: string }) {
  return <article className={tone}><small>{label}</small><strong>{value}</strong><span>{detail}</span></article>;
}

function OutcomeIcon({ outcome }: { outcome: SessionSearchResult["outcome"] }) {
  return outcome === "success" ? <CheckCircle2 className="outcome-icon success" size={17} />
    : outcome === "failed" ? <AlertTriangle className="outcome-icon failed" size={17} />
      : <span className={`outcome-icon dot ${outcome}`} />;
}

function OutcomeBadge({ outcome }: { outcome: SessionSearchResult["outcome"] }) {
  return <em className={`outcome-badge ${outcome}`}>{outcome === "unknown" ? "No outcome" : outcome}</em>;
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatDuration(value: number | null): string {
  if (value === null) return "—";
  const seconds = Math.round(value / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}
