import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import {
  Archive, ArrowLeft, Bot, BrainCircuit, Check, ChevronRight, CircleStop,
  Clock3, Code2, Command, Folder, FolderOpen, Gauge, GitBranch, KeyRound,
  LayoutGrid, LoaderCircle, LogOut, Menu, MessageSquareText, MoreHorizontal,
  PanelLeftClose, Pin, PinOff, Plus, RefreshCw, Search, Send, Server,
  Settings2, ShieldCheck, Sparkles, TerminalSquare, ListPlus, Target, Pause, Play, X
} from "lucide-react";
import type { Bootstrap, CodexModel, LiveThreadState, PendingRequest, QueueEntry, Thread, ThreadItem, Usage } from "./types";

type SortMode = "updated" | "created" | "name" | "directory" | "status";
type ViewMode = "session" | "control";
type ThreadSettings = Record<string, { model: string; effort: string }>;
type LiveStreams = Record<string, Record<string, string>>;
type LiveItems = Record<string, Record<string, ThreadItem>>;
type AssistSuggestion = { id: string; label: string; description: string; insert: string; kind: "command" | "file" | "directory" };

const SLASH_COMMANDS: AssistSuggestion[] = [
  { id: "compact", label: "/compact", description: "Compact the session context", insert: "/compact", kind: "command" },
  { id: "goal", label: "/goal", description: "Set or manage a persistent task goal", insert: "/goal ", kind: "command" },
  { id: "stop", label: "/stop", description: "Stop the active turn", insert: "/stop", kind: "command" },
  { id: "rename", label: "/rename", description: "Rename this session", insert: "/rename ", kind: "command" },
  { id: "archive", label: "/archive", description: "Archive this session", insert: "/archive", kind: "command" },
  { id: "mention", label: "/mention", description: "Autocomplete a workspace file", insert: "@", kind: "command" }
];

const EFFORT_LABELS: Record<string, string> = {
  none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High",
  xhigh: "Extra high", max: "Maximum", ultra: "Ultra"
};

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Thread | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>(() => localStorage.getItem("forgedeck-sort") as SortMode || "updated");
  const [pinned, setPinned] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem("forgedeck-pins") || "[]")));
  const [settings, setSettings] = useState<ThreadSettings>(() => JSON.parse(localStorage.getItem("forgedeck-settings") || "{}"));
  const [view, setView] = useState<ViewMode>(() => localStorage.getItem("forgedeck-view") === "control" ? "control" : "session");
  const [controlIds, setControlIds] = useState<string[]>(() => JSON.parse(localStorage.getItem("forgedeck-control-ids") || "[]"));
  const [newOpen, setNewOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pending, setPending] = useState<PendingRequest[]>([]);
  const [liveText, setLiveText] = useState<LiveStreams>({});
  const [liveToolOutput, setLiveToolOutput] = useState<LiveStreams>({});
  const [liveItems, setLiveItems] = useState<LiveItems>({});
  const [liveStatuses, setLiveStatuses] = useState<Record<string, Thread["status"]>>({});
  const [activeThreadIds, setActiveThreadIds] = useState<Set<string>>(new Set());
  const [queues, setQueues] = useState<Record<string, QueueEntry[]>>({});
  const [completedSignals, setCompletedSignals] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem("forgedeck-completed") || "[]")));
  const [activityVersion, setActivityVersion] = useState(0);
  const [runtime, setRuntime] = useState<"ready" | "offline" | "error">("ready");
  const [toast, setToast] = useState<string | null>(null);
  const selectedRef = useRef(selectedId);
  const refreshTimer = useRef<number | null>(null);
  const listTimer = useRef<number | null>(null);

  useEffect(() => { selectedRef.current = selectedId; }, [selectedId]);

  const loadBootstrap = useCallback(async () => {
    const data = await api<Bootstrap>("/api/bootstrap");
    setBootstrap(data);
    setPending(data.pendingRequests);
    setQueues(data.queues || {});
    setActiveThreadIds(new Set(data.activeThreadIds || []));
    if (data.activeThreadIds?.length) {
      setLiveStatuses((current) => Object.fromEntries([
        ...Object.entries(current),
        ...data.activeThreadIds!.map((threadId) => [threadId, { type: "active", activeFlags: [] } as Thread["status"]])
      ]));
    }
    if (data.liveState) {
      setLiveItems((current) => mergeLiveState(current, data.liveState!, "items"));
      setLiveText((current) => mergeLiveState(current, data.liveState!, "agentText"));
      setLiveToolOutput((current) => mergeLiveState(current, data.liveState!, "toolOutput"));
      const seen = JSON.parse(localStorage.getItem("forgedeck-completion-seen") || "{}") as Record<string, number>;
      setCompletedSignals((current) => {
        const next = new Set(current);
        for (const [threadId, state] of Object.entries(data.liveState!)) {
          if (!state.active && state.completedAt && state.completedAt > (seen[threadId] || 0)) next.add(threadId);
        }
        return next;
      });
    }
    return data;
  }, []);

  const loadThreads = useCallback(async () => {
    const collected: Thread[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: "200", sortKey: "updated_at", sortDirection: "desc" });
      if (search.trim()) query.set("search", search.trim());
      if (cursor) query.set("cursor", cursor);
      const response = await api<{ data: Thread[]; nextCursor: string | null }>(`/api/threads?${query}`);
      collected.push(...response.data);
      cursor = response.nextCursor;
    } while (cursor);
    setThreads(collected);
    setSelectedId((current) => current || collected[0]?.id || null);
  }, [search]);

  const loadThread = useCallback(async (id: string, quiet = false) => {
    if (!quiet) setLoadingDetail(true);
    try {
      const response = await api<{ thread: Thread }>(`/api/threads/${encodeURIComponent(id)}`);
      if (selectedRef.current === id) setDetail(response.thread);
    } finally {
      if (!quiet) setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    void api<{ authenticated: boolean }>("/api/auth", { allowUnauthenticated: true })
      .then(({ authenticated: value }) => setAuthenticated(value))
      .catch(() => setAuthenticated(false));
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    Promise.all([loadBootstrap(), loadThreads()]).catch((error) => showError(error, setToast));
  }, [authenticated, loadBootstrap, loadThreads]);

  useEffect(() => {
    if (!authenticated) return;
    const timer = window.setTimeout(() => void loadThreads().catch((error) => showError(error, setToast)), 250);
    return () => clearTimeout(timer);
  }, [search, authenticated, loadThreads]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    setSidebarOpen(false);
    void loadThread(selectedId).catch((error) => showError(error, setToast));
  }, [selectedId, loadThread]);

  // SSE is the fast path; these lightweight polls are a resilience fallback for
  // browsers, proxies, or sleeping devices that temporarily drop the event stream.
  useEffect(() => {
    if (!authenticated) return;
    const timer = window.setInterval(() => void loadThreads().catch(() => undefined), 4_000);
    return () => clearInterval(timer);
  }, [authenticated, loadThreads]);

  useEffect(() => {
    if (!authenticated || view !== "session" || !selectedId) return;
    const timer = window.setInterval(() => void loadThread(selectedId, true).catch(() => undefined), 1_500);
    return () => clearInterval(timer);
  }, [authenticated, view, selectedId, loadThread]);

  useEffect(() => {
    if (!authenticated) return;
    const events = new EventSource("/events");
    events.addEventListener("connected", () => {
      setRuntime("ready");
      void loadBootstrap().catch(() => undefined);
      void loadThreads().catch(() => undefined);
    });
    events.addEventListener("runtime", (event) => {
      const payload = JSON.parse((event as MessageEvent).data);
      setRuntime(payload.state);
      if (payload.state === "ready") {
        void loadThreads();
        if (selectedRef.current) void loadThread(selectedRef.current, true);
      }
    });
    events.addEventListener("approval", (event) => {
      const request = JSON.parse((event as MessageEvent).data) as PendingRequest;
      setPending((current) => current.some((item) => String(item.id) === String(request.id)) ? current : [...current, request]);
    });
    events.addEventListener("approval-resolved", (event) => {
      const { id } = JSON.parse((event as MessageEvent).data);
      setPending((current) => current.filter((item) => String(item.id) !== String(id)));
    });
    events.addEventListener("queue", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { threadId: string; queue: QueueEntry[]; error?: string | null };
      setQueues((current) => ({ ...current, [payload.threadId]: payload.queue }));
      if (payload.error) setToast(`Queued turn could not start: ${payload.error}`);
    });
    events.addEventListener("codex", (event) => {
      const notification = JSON.parse((event as MessageEvent).data) as { method: string; params: Record<string, unknown> };
      const threadId = typeof notification.params?.threadId === "string" ? notification.params.threadId : null;
      if (notification.method === "item/agentMessage/delta" && threadId) {
        const itemId = String(notification.params.itemId);
        const delta = String(notification.params.delta || "");
        setLiveText((current) => ({
          ...current,
          [threadId]: { ...(current[threadId] || {}), [itemId]: (current[threadId]?.[itemId] || "") + delta }
        }));
      }
      if ((notification.method === "item/commandExecution/outputDelta" || notification.method === "command/exec/outputDelta") && threadId) {
        const itemId = String(notification.params.itemId || notification.params.processId || "command");
        const delta = String(notification.params.delta || "");
        setLiveToolOutput((current) => ({
          ...current,
          [threadId]: { ...(current[threadId] || {}), [itemId]: (current[threadId]?.[itemId] || "") + delta }
        }));
      }
      if ((notification.method === "item/started" || notification.method === "item/completed") && threadId && notification.params.item && typeof notification.params.item === "object") {
        const item = notification.params.item as ThreadItem;
        if (item.id) {
          setLiveItems((current) => ({
            ...current,
            [threadId]: { ...(current[threadId] || {}), [item.id!]: item }
          }));
        }
      }
      if (notification.method === "thread/status/changed" && threadId && notification.params.status && typeof notification.params.status === "object") {
        const status = notification.params.status as Thread["status"];
        setLiveStatuses((current) => ({ ...current, [threadId]: status }));
        setDetail((current) => current?.id === threadId ? { ...current, status } : current);
      }
      if (notification.method === "turn/started" && threadId) {
        setActiveThreadIds((current) => new Set(current).add(threadId));
        setCompletedSignals((current) => withoutSetValue(current, threadId));
      }
      if (notification.method === "turn/completed" && threadId) {
        setActiveThreadIds((current) => withoutSetValue(current, threadId));
        setCompletedSignals((current) => new Set(current).add(threadId));
      }
      if (notification.method === "thread/status/changed" && threadId && (notification.params.status as Thread["status"] | undefined)?.type === "active") {
        setActiveThreadIds((current) => new Set(current).add(threadId));
      }
      if (notification.method === "account/rateLimits/updated") {
        void loadBootstrap().catch(() => undefined);
      }
      if (threadId === selectedRef.current && !notification.method.endsWith("/delta")) {
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        refreshTimer.current = window.setTimeout(() => {
          if (selectedRef.current) void loadThread(selectedRef.current, true);
          if (notification.method === "turn/completed") {
            window.setTimeout(() => {
              setLiveText((current) => omitKey(current, threadId!));
              setLiveToolOutput((current) => omitKey(current, threadId!));
              setLiveItems((current) => omitKey(current, threadId!));
            }, 1_200);
          }
        }, 300);
      }
      if (threadId && /^(item\/|turn\/|thread\/(status|goal))/.test(notification.method) && !notification.method.endsWith("/delta")) {
        setActivityVersion((value) => value + 1);
      }
      if (/^(thread|turn)\//.test(notification.method)) {
        if (listTimer.current) clearTimeout(listTimer.current);
        listTimer.current = window.setTimeout(() => void loadThreads(), 650);
      }
    });
    events.onerror = () => setRuntime("offline");
    return () => events.close();
  }, [authenticated, loadBootstrap, loadThread, loadThreads]);

  useEffect(() => {
    localStorage.setItem("forgedeck-pins", JSON.stringify([...pinned]));
  }, [pinned]);
  useEffect(() => localStorage.setItem("forgedeck-view", view), [view]);
  useEffect(() => localStorage.setItem("forgedeck-control-ids", JSON.stringify(controlIds)), [controlIds]);
  useEffect(() => localStorage.setItem("forgedeck-completed", JSON.stringify([...completedSignals])), [completedSignals]);
  useEffect(() => {
    if (threads.length && controlIds.length === 0) {
      const initial = [...threads].sort((a, b) => statusRank(b) - statusRank(a) || b.updatedAt - a.updatedAt).slice(0, 3).map((thread) => thread.id);
      setControlIds(initial);
    }
  }, [threads, controlIds.length]);
  useEffect(() => {
    const activeIds = threads.filter((thread) => activeThreadIds.has(thread.id)).map((thread) => thread.id);
    if (!activeIds.length) return;
    setControlIds((current) => {
      const missing = activeIds.filter((id) => !current.includes(id));
      return missing.length ? [...current, ...missing] : current;
    });
  }, [threads, activeThreadIds]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key.toLowerCase() === "n" && !event.ctrlKey && !event.metaKey && !event.altKey && !target?.matches("input, textarea, select, [contenteditable=true]")) {
        event.preventDefault();
        setNewOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  useEffect(() => localStorage.setItem("forgedeck-settings", JSON.stringify(settings)), [settings]);
  useEffect(() => localStorage.setItem("forgedeck-sort", sortMode), [sortMode]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(timer);
  }, [toast]);

  const effectiveThreads = useMemo(() => threads.map((thread) =>
    activeThreadIds.has(thread.id)
      ? { ...thread, status: { type: "active", activeFlags: [] } as Thread["status"] }
      : liveStatuses[thread.id] ? { ...thread, status: liveStatuses[thread.id] } : thread
  ), [threads, liveStatuses, activeThreadIds]);

  const sortedThreads = useMemo(() => {
    const copy = [...effectiveThreads];
    copy.sort((a, b) => {
      const pinOrder = Number(pinned.has(b.id)) - Number(pinned.has(a.id));
      if (pinOrder) return pinOrder;
      if (sortMode === "name") return threadTitle(a).localeCompare(threadTitle(b));
      if (sortMode === "directory") return a.cwd.localeCompare(b.cwd);
      if (sortMode === "status") return statusRank(b) - statusRank(a) || b.updatedAt - a.updatedAt;
      if (sortMode === "created") return b.createdAt - a.createdAt;
      return b.updatedAt - a.updatedAt;
    });
    return copy;
  }, [effectiveThreads, sortMode, pinned]);

  const defaultModel = bootstrap?.models.data.find((model) => model.isDefault) || bootstrap?.models.data[0];
  const activeSettings = selectedId && settings[selectedId]
    ? settings[selectedId]
    : defaultModel ? { model: defaultModel.model, effort: defaultModel.defaultReasoningEffort } : null;
  const controlThreads = useMemo(() => {
    const byId = new Map(effectiveThreads.map((thread) => [thread.id, thread]));
    return controlIds.map((id) => byId.get(id)).filter((thread): thread is Thread => Boolean(thread));
  }, [effectiveThreads, controlIds]);
  const effectiveDetail = detail && activeThreadIds.has(detail.id)
    ? { ...detail, status: { type: "active", activeFlags: [] } as Thread["status"] }
    : detail;

  if (authenticated === null) return <Splash />;
  if (!authenticated) return <Login onSuccess={() => setAuthenticated(true)} />;
  if (!bootstrap) return <Splash label="Connecting to your Codex account…" />;

  const togglePin = (id: string) => setPinned((current) => {
    const next = new Set(current);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const toggleControl = (id: string) => setControlIds((current) =>
    current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
  );

  const markCompletionSeen = (id: string) => {
    setCompletedSignals((current) => withoutSetValue(current, id));
    const seen = JSON.parse(localStorage.getItem("forgedeck-completion-seen") || "{}") as Record<string, number>;
    seen[id] = Date.now();
    localStorage.setItem("forgedeck-completion-seen", JSON.stringify(seen));
  };

  const updateSettings = (next: { model: string; effort: string }) => {
    if (!selectedId) return;
    setSettings((current) => ({ ...current, [selectedId]: next }));
  };

  const onCreated = async (thread: Thread, model: string, effort: string) => {
    setSettings((current) => ({ ...current, [thread.id]: { model, effort } }));
    setControlIds((current) => current.includes(thread.id) ? current : [...current, thread.id]);
    setNewOpen(false);
    await loadThreads();
    setSelectedId(thread.id);
  };

  const logout = async () => {
    await api("/api/logout", { method: "POST" });
    setAuthenticated(false);
    setBootstrap(null);
  };

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="brand-row">
          <Brand />
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar"><PanelLeftClose size={19} /></button>
        </div>

        <button className="new-session" onClick={() => setNewOpen(true)}><Plus size={18} /> New session <kbd>N</kbd></button>

        <div className="view-switch">
          <button className={view === "session" ? "active" : ""} onClick={() => setView("session")}><MessageSquareText size={14} />Session</button>
          <button className={view === "control" ? "active" : ""} onClick={() => setView("control")}><LayoutGrid size={14} />Control center<span>{controlThreads.length}</span></button>
        </div>

        <UsageCard usage={bootstrap.usage} plan={bootstrap.account.account?.planType} />

        <div className="session-tools">
          <label className="search-box"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a session…" /></label>
          <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)} aria-label="Sort sessions">
            <option value="updated">Recent activity</option>
            <option value="created">Newest created</option>
            <option value="status">Running first</option>
            <option value="name">Name</option>
            <option value="directory">Directory</option>
          </select>
        </div>

        <div className="session-heading"><span>Sessions</span><span>{threads.length}</span></div>
        <nav className="session-list">
          {sortedThreads.map((thread) => (
            <SessionCard key={thread.id} thread={thread} selected={view === "session" && thread.id === selectedId} pinned={pinned.has(thread.id)} inControl={controlIds.includes(thread.id)} completed={completedSignals.has(thread.id)}
              onSelect={() => { setSelectedId(thread.id); setView("session"); markCompletionSeen(thread.id); }} onPin={() => togglePin(thread.id)} onControl={() => toggleControl(thread.id)} />
          ))}
          {!sortedThreads.length && <div className="empty-list"><MessageSquareText size={20} /><span>No sessions found</span></div>}
        </nav>

        <div className="account-row">
          <div className="avatar">{initials(bootstrap.account.account?.email || "Codex")}</div>
          <div><strong>{bootstrap.account.account?.email || "Local Codex"}</strong><span>{formatPlan(bootstrap.account.account?.planType)} plan</span></div>
          <button className="icon-button" onClick={() => void logout()} title="Log out of ForgeDeck"><LogOut size={17} /></button>
        </div>
      </aside>
      {sidebarOpen && <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} />}

      <main className="main-panel">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar"><Menu size={20} /></button>
          {view === "control" ? <ControlHeader count={controlThreads.length} activeCount={effectiveThreads.filter((thread) => thread.status.type === "active").length} /> : effectiveDetail ? <ThreadHeader thread={effectiveDetail} pinned={pinned.has(effectiveDetail.id)} onPin={() => togglePin(effectiveDetail.id)}
            onRename={async () => {
              const name = prompt("Session name", threadTitle(effectiveDetail));
              if (!name?.trim()) return;
              await api(`/api/threads/${effectiveDetail.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
              await Promise.all([loadThread(effectiveDetail.id), loadThreads()]);
            }}
            onArchive={async () => {
              if (!confirm("Archive this session? Its Codex history will be kept.")) return;
              await api(`/api/threads/${effectiveDetail.id}`, { method: "DELETE" });
              setSelectedId(null); setDetail(null); await loadThreads();
            }} /> : <div className="topbar-placeholder">Session workspace</div>}
          <div className={`runtime-pill ${runtime}`}><span />{runtime === "ready" ? "Runtime online" : "Reconnecting"}</div>
        </header>

        {view === "control" ? (
          <ControlCenter threads={controlThreads} allThreads={effectiveThreads} models={bootstrap.models.data} settings={settings} defaultModel={defaultModel}
            liveText={liveText} liveToolOutput={liveToolOutput} liveItems={liveItems} queues={queues} activityVersion={activityVersion}
            onSettings={(threadId, next) => setSettings((current) => ({ ...current, [threadId]: next }))}
            completedSignals={completedSignals} onOpen={(id) => { setSelectedId(id); setView("session"); markCompletionSeen(id); }} onRemove={toggleControl}
            onAdd={(id) => setControlIds((current) => current.includes(id) ? current : [...current, id])}
            onError={(error) => showError(error, setToast)} />
        ) : effectiveDetail ? (
          <Chat thread={effectiveDetail} loading={loadingDetail} liveText={liveText[effectiveDetail.id] || {}} liveToolOutput={liveToolOutput[effectiveDetail.id] || {}} liveItems={liveItems[effectiveDetail.id] || {}} queue={queues[effectiveDetail.id] || []} models={bootstrap.models.data}
            settings={activeSettings!} onSettings={updateSettings} onRefresh={() => loadThread(effectiveDetail.id)} onError={(error) => showError(error, setToast)} />
        ) : (
          <Welcome onNew={() => setNewOpen(true)} />
        )}
      </main>

      {newOpen && <NewSessionModal bootstrap={bootstrap} onClose={() => setNewOpen(false)} onCreated={onCreated} onError={(error) => showError(error, setToast)} />}
      {pending.length > 0 && <ApprovalTray requests={pending} onResolved={(id) => setPending((items) => items.filter((item) => String(item.id) !== String(id)))} onError={(error) => showError(error, setToast)} />}
      {toast && <div className="toast"><ShieldCheck size={17} />{toast}<button onClick={() => setToast(null)}><X size={15} /></button></div>}
    </div>
  );
}

function Brand() {
  return <div className="brand"><div className="brand-mark"><span /><span /><span /></div><div><strong>ForgeDeck</strong><small>CODEX COMMAND</small></div></div>;
}

function Splash({ label = "Warming up ForgeDeck…" }: { label?: string }) {
  return <div className="splash"><Brand /><LoaderCircle className="spin" size={22} /><span>{label}</span></div>;
}

function Login({ onSuccess }: { onSuccess: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await api("/api/login", { method: "POST", body: JSON.stringify({ token }), allowUnauthenticated: true });
      onSuccess();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally { setBusy(false); }
  };
  return <div className="login-page">
    <div className="login-glow" />
    <form className="login-card" onSubmit={submit}>
      <Brand />
      <div className="login-icon"><KeyRound size={25} /></div>
      <h1>Enter the command deck</h1>
      <p>Use the access key shown when ForgeDeck started, or from <code>.data/access-token</code> on the host.</p>
      <label>Access key<input autoFocus type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Paste your private access key" /></label>
      {error && <div className="form-error">{error}</div>}
      <button className="primary-button" disabled={busy || !token}>{busy ? <LoaderCircle className="spin" size={17} /> : <ArrowLeft className="enter-arrow" size={17} />}Enter ForgeDeck</button>
      <div className="private-note"><ShieldCheck size={15} />Your Codex credentials never pass through the browser.</div>
    </form>
  </div>;
}

function UsageCard({ usage, plan }: { usage: Usage | null; plan?: string }) {
  const snapshot = usage?.rateLimitsByLimitId?.codex || usage?.rateLimits;
  const percent = Math.min(100, Math.max(0, snapshot?.primary?.usedPercent || 0));
  const reset = snapshot?.primary?.resetsAt ? relativeReset(snapshot.primary.resetsAt) : "Not available";
  return <section className="usage-card">
    <div className="usage-top"><span><Gauge size={15} /> Plan usage</span><strong>{formatPlan(plan)}</strong></div>
    <div className="usage-main">
      <div className="usage-ring" style={{ "--usage": `${percent * 3.6}deg` } as React.CSSProperties}><div><b>{Math.round(percent)}%</b><span>used</span></div></div>
      <div className="usage-copy"><strong>{100 - Math.round(percent)}% remaining</strong><span><Clock3 size={13} /> Resets {reset}</span></div>
    </div>
  </section>;
}

function SessionCard({ thread, selected, pinned, inControl, completed, onSelect, onPin, onControl }: { thread: Thread; selected: boolean; pinned: boolean; inControl: boolean; completed: boolean; onSelect: () => void; onPin: () => void; onControl: () => void }) {
  const running = thread.status.type === "active";
  return <button className={`session-card ${selected ? "selected" : ""} ${completed && !running ? "completed" : ""}`} onClick={onSelect}>
    <span className={`status-dot ${thread.status.type}`} />
    <span className="session-copy"><strong>{threadTitle(thread)}</strong><small><Folder size={12} />{basename(thread.cwd)}<i>·</i>{timeAgo(thread.updatedAt)}</small></span>
    <span className="session-actions" onClick={(event) => event.stopPropagation()}>
      {running && <LoaderCircle className="spin running-icon" size={14} />}
      <span role="button" tabIndex={0} onClick={onControl} title={inControl ? "Remove from Control Center" : "Add to Control Center"}><LayoutGrid size={14} className={inControl ? "control-active" : ""} /></span>
      <span role="button" tabIndex={0} onClick={onPin} title={pinned ? "Unpin" : "Pin"}>{pinned ? <PinOff size={14} /> : <Pin size={14} />}</span>
    </span>
  </button>;
}

function ThreadHeader({ thread, pinned, onPin, onRename, onArchive }: { thread: Thread; pinned: boolean; onPin: () => void; onRename: () => void; onArchive: () => void }) {
  return <div className="thread-header">
    <div className="thread-title"><div className="thread-icon"><Code2 size={18} /></div><div><strong>{threadTitle(thread)}</strong><span><FolderOpen size={13} />{thread.cwd}{thread.gitInfo?.branch && <><i>·</i><GitBranch size={12} />{thread.gitInfo.branch}</>}</span></div></div>
    <div className="header-actions"><button className="icon-button" onClick={onPin} title={pinned ? "Unpin" : "Pin"}>{pinned ? <PinOff size={17} /> : <Pin size={17} />}</button><button className="icon-button" onClick={onRename} title="Rename"><Settings2 size={17} /></button><button className="icon-button" onClick={onArchive} title="Archive"><Archive size={17} /></button></div>
  </div>;
}

function ControlHeader({ count, activeCount }: { count: number; activeCount: number }) {
  return <div className="control-header">
    <div className="control-header-icon"><LayoutGrid size={18} /></div>
    <div><strong>Control Center</strong><span>{count} session{count === 1 ? "" : "s"} on deck <i>·</i> <b>{activeCount} active now</b></span></div>
  </div>;
}

function ControlCenter({ threads, allThreads, models, settings, defaultModel, liveText, liveToolOutput, liveItems, queues, completedSignals, activityVersion, onSettings, onOpen, onRemove, onAdd, onError }: {
  threads: Thread[]; allThreads: Thread[]; models: CodexModel[]; settings: ThreadSettings; defaultModel?: CodexModel;
  liveText: LiveStreams; liveToolOutput: LiveStreams; liveItems: LiveItems; queues: Record<string, QueueEntry[]>; completedSignals: Set<string>; activityVersion: number;
  onSettings: (threadId: string, value: { model: string; effort: string }) => void;
  onOpen: (threadId: string) => void; onRemove: (threadId: string) => void; onAdd: (threadId: string) => void; onError: (error: unknown) => void;
}) {
  const columns = useControlColumns();
  const pageSize = columns * 2;
  const [page, setPage] = useState(0);
  const [details, setDetails] = useState<Record<string, Thread>>({});
  const [reload, setReload] = useState(0);
  const errorRef = useRef(onError);
  const pageCount = Math.max(1, Math.ceil(threads.length / pageSize));
  const pageThreads = threads.slice(page * pageSize, page * pageSize + pageSize);
  const idsKey = pageThreads.map((thread) => thread.id).join(",");
  const available = allThreads.filter((thread) => !threads.some((shown) => shown.id === thread.id));

  useEffect(() => { errorRef.current = onError; }, [onError]);
  useEffect(() => { if (page >= pageCount) setPage(pageCount - 1); }, [page, pageCount]);

  const refresh = useCallback(async () => {
    if (!pageThreads.length) return;
    const snapshots = await Promise.allSettled(pageThreads.map(async (thread) => {
      const response = await api<{ thread: Thread }>(`/api/threads/${encodeURIComponent(thread.id)}`);
      return response.thread;
    }));
    setDetails((current) => {
      const next = { ...current };
      for (const snapshot of snapshots) if (snapshot.status === "fulfilled") next[snapshot.value.id] = snapshot.value;
      return next;
    });
  // idsKey intentionally represents the current page's stable set of threads.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  useEffect(() => { void refresh().catch((error) => errorRef.current(error)); }, [refresh, activityVersion, reload]);
  useEffect(() => {
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 1_500);
    return () => clearInterval(timer);
  }, [refresh]);

  const visibleColumns = Math.max(1, Math.min(columns, pageThreads.length));
  const visibleRows = Math.max(1, Math.ceil(pageThreads.length / visibleColumns));

  return <section className="control-center">
    <div className="control-toolbar">
      <div><span className="live-beacon"><i />LIVE</span><p>Agent messages and tool output stream into every panel.</p></div>
      <div className="control-toolbar-actions">
        {available.length > 0 && <label className="add-panel"><Plus size={14} /><select value="" onChange={(event) => { if (event.target.value) onAdd(event.target.value); }}><option value="">Add session</option>{available.map((thread) => <option key={thread.id} value={thread.id}>{threadTitle(thread)}</option>)}</select></label>}
        <button className="icon-button" onClick={() => setReload((value) => value + 1)} title="Refresh panels"><RefreshCw size={16} /></button>
      </div>
    </div>

    {pageThreads.length ? <div className="control-grid" style={{ "--control-columns": visibleColumns, "--control-rows": visibleRows } as React.CSSProperties}>
      {pageThreads.map((summary) => {
        const snapshot = details[summary.id];
        const thread = snapshot ? { ...snapshot, status: summary.status } : summary;
        const threadSettings = settings[thread.id] || (defaultModel ? { model: defaultModel.model, effort: defaultModel.defaultReasoningEffort } : { model: models[0]?.model || "", effort: models[0]?.defaultReasoningEffort || "medium" });
        return <ControlCard key={thread.id} thread={thread} models={models} settings={threadSettings}
          liveText={liveText[thread.id] || {}} liveToolOutput={liveToolOutput[thread.id] || {}} liveItems={liveItems[thread.id] || {}} queue={queues[thread.id] || []} completed={completedSignals.has(thread.id)}
          onSettings={(next) => onSettings(thread.id, next)} onOpen={() => onOpen(thread.id)} onRemove={() => onRemove(thread.id)}
          onRefresh={() => setReload((value) => value + 1)} onError={onError} />;
      })}
    </div> : <div className="control-empty"><LayoutGrid size={28} /><h2>No sessions on deck</h2><p>Create a session or add one from the session list to start your Control Center.</p></div>}

    {pageCount > 1 && <div className="control-pages"><button disabled={page === 0} onClick={() => setPage((value) => value - 1)}><ArrowLeft size={14} />Previous</button><span>Page {page + 1} of {pageCount} · {columns} across × 2 rows</span><button disabled={page >= pageCount - 1} onClick={() => setPage((value) => value + 1)}>Next<ChevronRight size={14} /></button></div>}
  </section>;
}

function ControlCard({ thread, models, settings, liveText, liveToolOutput, liveItems, queue, completed, onSettings, onOpen, onRemove, onRefresh, onError }: {
  thread: Thread; models: CodexModel[]; settings: { model: string; effort: string };
  liveText: Record<string, string>; liveToolOutput: Record<string, string>; liveItems: Record<string, ThreadItem>; queue: QueueEntry[]; completed: boolean;
  onSettings: (value: { model: string; effort: string }) => void; onOpen: () => void; onRemove: () => void; onRefresh: () => void; onError: (error: unknown) => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const assist = useComposerAssist(text, setText, thread.cwd);
  const body = useRef<HTMLDivElement>(null);
  const model = models.find((item) => item.model === settings.model) || models[0];
  const runningTurn = [...(thread.turns || [])].reverse().find((turn) => turn.status === "inProgress");
  const historyItems = (thread.turns || []).flatMap((turn) => turn.items);
  const historyIds = new Set(historyItems.map((item) => item.id).filter(Boolean));
  const streamingText = Object.entries(liveText).filter(([id]) => !historyIds.has(id));
  const allItems = [...historyItems, ...unseenLiveItems(historyItems, Object.values(liveItems)).filter((item) =>
    !(item.type === "agentMessage" && item.id && liveText[item.id])
  )];
  const items = selectControlItems(allItems, 12);
  const toolCount = items.filter((item) => isToolItem(item)).length;
  const running = thread.status.type === "active" || Boolean(runningTurn);

  useEffect(() => { body.current?.scrollTo({ top: body.current.scrollHeight, behavior: "smooth" }); }, [thread.turns, liveText, liveToolOutput, liveItems]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || sending) return;
    const outgoing = text.trim(); setText(""); setSending(true);
    try {
      const slash = parseSlashCommand(outgoing);
      if (slash?.command === "mention") {
        setText("@");
      } else if (slash) {
        if (!await executeSlashCommand(thread, slash)) { setText(outgoing); return; }
      } else {
        await api(`/api/threads/${thread.id}/${running ? "queue" : "messages"}`, { method: "POST", body: JSON.stringify({ text: outgoing, ...settings }) });
      }
      onRefresh();
    } catch (error) { setText(outgoing); onError(error); } finally { setSending(false); }
  };

  const changeModel = (modelId: string) => {
    const next = models.find((item) => item.model === modelId);
    if (next) onSettings({ model: next.model, effort: next.defaultReasoningEffort });
  };

  return <article className={`control-card ${running ? "running" : ""} ${completed && !running ? "completed" : ""}`}>
    <header>
      <button className="control-title" onClick={onOpen}><span className={`status-dot ${running ? "active" : thread.status.type}`} /><span><strong>{threadTitle(thread)}</strong><small><Folder size={11} />{basename(thread.cwd)}</small></span></button>
      <div className="control-card-actions">{completed && !running && <span className="done-label">Done</span>}<PolicyButton thread={thread} running={running} onRefresh={onRefresh} onError={onError} compact />{queue.length > 0 && <span className="queue-count"><ListPlus size={11} />{queue.length}</span>}{toolCount > 0 && <span className="tool-count"><Command size={11} />{toolCount}</span>}<button onClick={onOpen} title="Open full session"><ChevronRight size={16} /></button><button onClick={onRemove} title="Remove from Control Center"><X size={15} /></button></div>
    </header>
    {thread.goal && <button type="button" className={`control-goal ${thread.goal.status}`} onClick={onOpen} title={thread.goal.objective}><Target size={11} /><span>{thread.goal.objective}</span><em>{goalStatusLabel(thread.goal.status)}</em></button>}
    <div className="control-feed" ref={body}>
      {!items.length && !streamingText.some(([, value]) => Boolean(value)) && <div className="control-waiting"><Bot size={21} /><span>{running ? "Agent is starting…" : "Waiting for a task"}</span></div>}
      {items.map((item, index) => <CompactItem key={item.id || `${item.type}-${index}`} item={item} liveOutput={item.id ? liveToolOutput[item.id] : undefined} />)}
      {streamingText.map(([id, value]) => value && <div className="compact-message agent live" key={id}><span><Bot size={12} /></span><div><ReactMarkdown>{value}</ReactMarkdown><i className="typing-cursor" /></div></div>)}
      {running && !streamingText.some(([, value]) => Boolean(value)) && <div className="compact-thinking"><LoaderCircle className="spin" size={13} />Agent working…</div>}
    </div>
    <div className="control-models"><select value={settings.model} onChange={(event) => changeModel(event.target.value)}>{models.map((item) => <option key={item.id} value={item.model}>{item.displayName}</option>)}</select><select value={settings.effort} onChange={(event) => onSettings({ ...settings, effort: event.target.value })}>{model?.supportedReasoningEfforts.map((option) => <option key={option.reasoningEffort} value={option.reasoningEffort}>{EFFORT_LABELS[option.reasoningEffort] || option.reasoningEffort}</option>)}</select></div>
    {queue.length > 0 && <div className="control-queue"><span><ListPlus size={11} />Queued next</span>{queue.map((entry, index) => <div key={entry.id}><b>{index + 1}</b><em title={entry.text}>{entry.text}</em><button type="button" onClick={() => void api(`/api/threads/${thread.id}/queue/${entry.id}`, { method: "DELETE" }).catch(onError)} title="Remove queued task"><X size={11} /></button></div>)}</div>}
    <form className="control-composer" onSubmit={send}>
      <ComposerAssist suggestions={assist.suggestions} activeIndex={assist.activeIndex} onChoose={assist.choose} compact />
      <input value={text} onChange={(event) => setText(event.target.value)} onKeyDown={assist.onKeyDown} placeholder={running ? "Queue the next task…" : "Send a task…"} />
      <button className={running ? "queue" : ""} disabled={!text.trim() || sending} title={running ? "Queue next task" : "Send"}>{sending ? <LoaderCircle className="spin" size={14} /> : running ? <ListPlus size={14} /> : <Send size={14} />}</button>
      {running && <button type="button" className="stop" onClick={() => void stopThread(thread.id, onRefresh, onError)} title="Stop active turn"><CircleStop size={15} /></button>}
    </form>
  </article>;
}

function CompactItem({ item, liveOutput }: { item: ThreadItem; liveOutput?: string }) {
  if (item.type === "userMessage") {
    const text = item.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") || "";
    return <div className="compact-message user"><div>{text}</div><span>YOU</span></div>;
  }
  if (item.type === "agentMessage") return <div className="compact-message agent"><span><Bot size={12} /></span><div><ReactMarkdown>{item.text || ""}</ReactMarkdown></div></div>;
  if (item.type === "reasoning") return <details className="compact-reasoning"><summary><BrainCircuit size={12} />Reasoning</summary><p>{item.summary?.join("\n")}</p></details>;
  if (item.type === "plan") return <div className="compact-tool plan"><LayoutGrid size={13} /><span><strong>Plan updated</strong><small>{truncate(item.text || "", 140)}</small></span></div>;
  if (item.type === "commandExecution") return <details className={`compact-tool ${item.status || ""}`} {...(item.status === "inProgress" ? { open: true } : {})}><summary><TerminalSquare size={13} /><span><strong>Command</strong><small>{item.command}</small></span><em>{item.status}</em></summary>{(item.aggregatedOutput || liveOutput) && <pre>{item.aggregatedOutput || liveOutput}</pre>}</details>;
  if (item.type === "fileChange") return <details className={`compact-tool ${item.status || ""}`} open><summary><Code2 size={13} /><span><strong>File changes</strong><small>{item.changes?.length || 0} file update{item.changes?.length === 1 ? "" : "s"}</small></span><em>{item.status}</em></summary><DiffView changes={item.changes || []} compact /></details>;
  if (isToolItem(item)) return <details className={`compact-tool ${String(item.status || "completed")}`}><summary><Command size={13} /><span><strong>{item.tool ? String(item.tool) : toolLabel(item.type)}</strong><small>{item.server ? String(item.server) : "Codex tool"}</small></span><em>{String(item.status || "completed")}</em></summary><pre>{JSON.stringify(item.result || item.error || item.arguments || item, null, 2)}</pre></details>;
  return null;
}

function Chat({ thread, loading, liveText, liveToolOutput, liveItems, queue, models, settings, onSettings, onRefresh, onError }: {
  thread: Thread; loading: boolean; liveText: Record<string, string>; liveToolOutput: Record<string, string>; liveItems: Record<string, ThreadItem>; queue: QueueEntry[]; models: CodexModel[];
  settings: { model: string; effort: string }; onSettings: (value: { model: string; effort: string }) => void;
  onRefresh: () => Promise<void>; onError: (error: unknown) => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const assist = useComposerAssist(text, setText, thread.cwd);
  const scroller = useRef<HTMLDivElement>(null);
  const selectedModel = models.find((model) => model.model === settings.model) || models[0];
  const runningTurn = [...thread.turns].reverse().find((turn) => turn.status === "inProgress");
  const running = thread.status.type === "active" || Boolean(runningTurn);
  const historyItems = thread.turns.flatMap((turn) => turn.items);
  const historyIds = new Set(historyItems.map((item) => item.id).filter(Boolean));
  const streamingText = Object.entries(liveText).filter(([id]) => !historyIds.has(id));
  const immediateItems = unseenLiveItems(historyItems, Object.values(liveItems)).filter((item) =>
    !(item.type === "agentMessage" && item.id && liveText[item.id])
  );

  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" }); }, [thread.turns, liveText, liveToolOutput, liveItems]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || sending) return;
    const outgoing = text.trim(); setText(""); setSending(true);
    try {
      const slash = parseSlashCommand(outgoing);
      if (slash?.command === "mention") {
        setText("@");
      } else if (slash) {
        if (!await executeSlashCommand(thread, slash)) { setText(outgoing); return; }
      } else {
        await api(`/api/threads/${thread.id}/${running ? "queue" : "messages"}`, { method: "POST", body: JSON.stringify({ text: outgoing, ...settings }) });
      }
      await onRefresh();
    } catch (error) { setText(outgoing); onError(error); } finally { setSending(false); }
  };

  const changeModel = (modelId: string) => {
    const model = models.find((item) => item.model === modelId)!;
    onSettings({ model: model.model, effort: model.defaultReasoningEffort });
  };

  return <div className="chat-layout">
    <div className="transcript" ref={scroller}>
      {loading && <div className="transcript-loading"><LoaderCircle className="spin" /> Loading session history…</div>}
      {!loading && !thread.turns.length && <div className="empty-chat"><div><Sparkles size={26} /></div><h2>Ready at the forge</h2><p>Send the first task. It will keep running here even if you close this browser.</p></div>}
      {thread.turns.map((turn) => <TurnView key={turn.id} turn={turn} liveToolOutput={liveToolOutput} />)}
      {immediateItems.map((item, index) => <ItemView key={item.id || `live-${index}`} item={item} liveOutput={item.id ? liveToolOutput[item.id] : undefined} />)}
      {streamingText.map(([id, value]) => value && <div className="message agent live" key={id}><div className="message-avatar"><Bot size={16} /></div><div className="message-body"><div className="message-meta">Codex <span>working now</span></div><ReactMarkdown>{value}</ReactMarkdown><span className="typing-cursor" /></div></div>)}
      {runningTurn && !streamingText.some(([, value]) => Boolean(value)) && <div className="thinking-line"><LoaderCircle className="spin" size={17} /><span>Codex is working</span><i /><i /><i /></div>}
    </div>

    <div className="composer-zone">
      {thread.goal && <GoalBar thread={thread} onRefresh={onRefresh} onError={onError} />}
      {queue.length > 0 && <div className="queue-strip"><div><ListPlus size={14} /><strong>{queue.length} queued</strong><span>Runs automatically after the current turn</span></div><div>{queue.map((entry, index) => <div className="queue-entry" key={entry.id}><b>{index + 1}</b><span>{entry.text}</span><button onClick={() => void api(`/api/threads/${thread.id}/queue/${entry.id}`, { method: "DELETE" }).catch(onError)} title="Remove queued task"><X size={13} /></button></div>)}</div></div>}
      <form className="composer" onSubmit={submit}>
        <ComposerAssist suggestions={assist.suggestions} activeIndex={assist.activeIndex} onChoose={assist.choose} />
        <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder={running ? "Queue the next task while Codex works…" : "Give Codex a task…"}
          rows={3} onKeyDown={(event) => { if (assist.onKeyDown(event)) return; if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        <div className="composer-footer">
          <div className="model-controls">
            <label><Bot size={14} /><select value={settings.model} onChange={(event) => changeModel(event.target.value)}>{models.map((model) => <option key={model.id} value={model.model}>{model.displayName}</option>)}</select></label>
            <label><BrainCircuit size={14} /><select value={settings.effort} onChange={(event) => onSettings({ ...settings, effort: event.target.value })}>{selectedModel.supportedReasoningEfforts.map((option) => <option key={option.reasoningEffort} value={option.reasoningEffort}>{EFFORT_LABELS[option.reasoningEffort] || option.reasoningEffort}</option>)}</select></label>
            <PolicyButton thread={thread} running={running} onRefresh={onRefresh} onError={onError} />
          </div>
          <div className="composer-actions">{running && <button type="button" className="stop-button" onClick={() => void stopThread(thread.id, onRefresh, onError)}><CircleStop size={16} /> Stop</button>}
            <button className={`send-button ${running ? "queue" : ""}`} disabled={!text.trim() || sending}>{sending ? <LoaderCircle className="spin" size={17} /> : running ? <ListPlus size={16} /> : <Send size={16} />}<span>{running ? "Queue" : "Send"}</span></button></div>
        </div>
      </form>
      <p className="persistence-note"><Server size={12} />Safe to close this tab — work continues on the host.</p>
    </div>
  </div>;
}

function PolicyButton({ thread, running, onRefresh, onError, compact = false }: { thread: Thread; running: boolean; onRefresh: () => void | Promise<void>; onError: (error: unknown) => void; compact?: boolean }) {
  const yolo = thread.policy === "yolo";
  const toggle = async () => {
    if (running) return;
    if (!yolo && !window.confirm("Enable YOLO mode for this session? Future turns will run with full system access and no approvals.")) return;
    try {
      await api(`/api/threads/${thread.id}/policy`, { method: "PATCH", body: JSON.stringify({ yolo: !yolo }) });
      await onRefresh();
    } catch (error) { onError(error); }
  };
  return <button type="button" className={`policy-button ${yolo ? "yolo" : "workspace"} ${compact ? "compact" : ""}`} disabled={running} onClick={() => void toggle()} title={running ? "Finish or stop the turn to change permissions" : yolo ? "Switch to workspace-write with approvals" : "Enable YOLO mode"}><ShieldCheck size={compact ? 11 : 13} /><span>{yolo ? "YOLO" : compact ? "SAFE" : "Workspace"}</span></button>;
}

async function stopThread(threadId: string, onRefresh: () => void | Promise<void>, onError: (error: unknown) => void): Promise<void> {
  try {
    await api(`/api/threads/${threadId}/interrupt`, { method: "POST", body: "{}" });
    await onRefresh();
  } catch (error) { onError(error); }
}

function GoalBar({ thread, onRefresh, onError }: { thread: Thread; onRefresh: () => Promise<void>; onError: (error: unknown) => void }) {
  const goal = thread.goal!;
  const run = async (args: string) => {
    try {
      await api(`/api/threads/${thread.id}/command`, { method: "POST", body: JSON.stringify({ command: "goal", args }) });
      await onRefresh();
    } catch (error) { onError(error); }
  };
  const edit = () => {
    const objective = window.prompt("Goal objective", goal.objective);
    if (objective?.trim() && objective.trim() !== goal.objective) void run(objective.trim());
  };
  const progress = goal.tokenBudget ? Math.min(100, Math.round(goal.tokensUsed / goal.tokenBudget * 100)) : null;
  return <div className={`goal-bar ${goal.status}`}>
    <span className="goal-icon"><Target size={14} /></span>
    <div><span><strong>Goal</strong><em>{goalStatusLabel(goal.status)}</em>{progress !== null && <small>{progress}% token budget</small>}</span><p>{goal.objective}</p></div>
    <div className="goal-actions">
      <button type="button" onClick={() => void run(goal.status === "paused" ? "resume" : "pause")} title={goal.status === "paused" ? "Resume goal" : "Pause goal"}>{goal.status === "paused" ? <Play size={13} /> : <Pause size={13} />}</button>
      <button type="button" onClick={edit} title="Edit goal"><Settings2 size={13} /></button>
      <button type="button" onClick={() => void run("clear")} title="Clear goal"><X size={13} /></button>
    </div>
  </div>;
}

function TurnView({ turn, liveToolOutput = {} }: { turn: Thread["turns"][number]; liveToolOutput?: Record<string, string> }) {
  return <div className={`turn ${turn.status}`}>
    {turn.items.map((item, index) => <ItemView key={item.id || `${item.type}-${index}`} item={item} liveOutput={item.id ? liveToolOutput[item.id] : undefined} />)}
    {turn.status === "failed" && <div className="turn-error">{turn.error?.message || "This turn failed."}</div>}
  </div>;
}

function ItemView({ item, liveOutput }: { item: ThreadItem; liveOutput?: string }) {
  if (item.type === "userMessage") {
    const text = item.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") || "";
    return <div className="message user"><div className="message-body"><div className="message-meta">You</div><p>{text}</p></div><div className="message-avatar">YOU</div></div>;
  }
  if (item.type === "agentMessage") return <div className="message agent"><div className="message-avatar"><Bot size={16} /></div><div className="message-body"><div className="message-meta">Codex</div><ReactMarkdown>{item.text || ""}</ReactMarkdown></div></div>;
  if (item.type === "reasoning") return <details className="reasoning-item"><summary><BrainCircuit size={15} />Reasoning <ChevronRight size={14} /></summary><div>{item.summary?.map((part, index) => <ReactMarkdown key={index}>{part}</ReactMarkdown>)}</div></details>;
  if (item.type === "commandExecution") return <details className="tool-item" {...(item.status === "inProgress" ? { open: true } : {})}><summary><TerminalSquare size={15} /><span><strong>Command</strong><code>{item.command}</code></span><em className={item.status}>{item.status}</em></summary>{(item.aggregatedOutput || liveOutput) && <pre>{item.aggregatedOutput || liveOutput}</pre>}</details>;
  if (item.type === "fileChange") return <details className="tool-item" open><summary><Code2 size={15} /><span><strong>Files changed</strong><code>{item.changes?.length || 0} update{item.changes?.length === 1 ? "" : "s"}</code></span><em className={item.status}>{item.status}</em></summary><DiffView changes={item.changes || []} /></details>;
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") return <details className="tool-item"><summary><Command size={15} /><span><strong>{item.tool || "Tool call"}</strong><code>{item.server || "Codex tool"}</code></span><em className={item.status}>{item.status}</em></summary><pre>{JSON.stringify(item.result || item.error || item.arguments, null, 2)}</pre></details>;
  if (item.type === "plan") return <div className="plan-item"><LayoutGrid size={15} /><ReactMarkdown>{item.text || ""}</ReactMarkdown></div>;
  if (["contextCompaction", "enteredReviewMode", "exitedReviewMode"].includes(item.type)) return null;
  return <details className="tool-item generic-tool"><summary><Sparkles size={15} /><span><strong>{toolLabel(item.type)}</strong><code>{item.id || "Codex activity"}</code></span><em className={String(item.status || "completed")}>{String(item.status || "completed")}</em></summary><pre>{JSON.stringify(item, null, 2)}</pre></details>;
}

function DiffView({ changes, compact = false }: { changes: Array<Record<string, unknown>>; compact?: boolean }) {
  return <div className={`diff-view ${compact ? "compact" : ""}`}>{changes.map((change, index) => {
    const filePath = String(change.path || change.file || `File ${index + 1}`);
    const diff = String(change.diff || change.unified_diff || "");
    const kindValue = change.kind && typeof change.kind === "object" ? (change.kind as { type?: unknown }).type : change.kind;
    const kind = String(kindValue || "update");
    const additions = diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const deletions = diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    return <section className="diff-file" key={`${filePath}-${index}`}>
      <header><Code2 size={12} /><strong>{filePath}</strong><span className={`diff-kind ${kind}`}>{kind}</span><em><b>+{additions}</b><i>-{deletions}</i></em></header>
      {diff ? <pre>{diff.split("\n").map((line, lineIndex) => <span className={line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "remove" : line.startsWith("@@") ? "hunk" : line.startsWith("+++") || line.startsWith("---") ? "file" : "context"} key={lineIndex}>{line || " "}</span>)}</pre> : <div className="diff-empty">Diff content unavailable</div>}
    </section>;
  })}</div>;
}

function useComposerAssist(text: string, setText: (value: string) => void, cwd: string) {
  const [files, setFiles] = useState<AssistSuggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const slashMatch = text.match(/^\/([^\s]*)$/);
  const mentionMatch = text.match(/(?:^|\s)@([^\s@]*)$/);
  const mentionQuery = mentionMatch?.[1];

  useEffect(() => {
    if (mentionQuery === undefined) { setFiles([]); return; }
    const timer = window.setTimeout(() => {
      void api<{ data: Array<{ name: string; relativePath: string; type: "file" | "directory" }> }>(`/api/files?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(mentionQuery)}`)
        .then((response) => setFiles(response.data.map((entry) => ({
          id: `${entry.type}:${entry.relativePath}`, label: entry.relativePath, description: entry.type,
          insert: entry.relativePath, kind: entry.type
        }))))
        .catch(() => setFiles([]));
    }, 120);
    return () => clearTimeout(timer);
  }, [cwd, mentionQuery]);

  const suggestions = useMemo(() => {
    if (dismissedFor === text) return [];
    if (slashMatch) {
      const needle = slashMatch[1].toLowerCase();
      return SLASH_COMMANDS.filter((item) => item.id.startsWith(needle) || item.label.includes(needle));
    }
    return mentionMatch ? files : [];
  }, [text, dismissedFor, slashMatch?.[1], mentionMatch?.[1], files]);

  useEffect(() => setActiveIndex(0), [suggestions.length, text]);

  const choose = (suggestion: AssistSuggestion) => {
    if (suggestion.kind === "command") setText(suggestion.insert);
    else setText(text.replace(/(^|\s)@[^\s@]*$/, `$1@${suggestion.insert}${suggestion.kind === "directory" ? "/" : " "}`));
    setDismissedFor(null);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): boolean => {
    if (!suggestions.length) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
      return true;
    }
    if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
      event.preventDefault();
      choose(suggestions[activeIndex] || suggestions[0]);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissedFor(text);
      return true;
    }
    return false;
  };
  return { suggestions, activeIndex, choose, onKeyDown };
}

function ComposerAssist({ suggestions, activeIndex, onChoose, compact = false }: { suggestions: AssistSuggestion[]; activeIndex: number; onChoose: (suggestion: AssistSuggestion) => void; compact?: boolean }) {
  if (!suggestions.length) return null;
  return <div className={`composer-assist ${compact ? "compact" : ""}`}>{suggestions.slice(0, compact ? 6 : 10).map((suggestion, index) => <button type="button" className={index === activeIndex ? "active" : ""} key={suggestion.id} onMouseDown={(event) => event.preventDefault()} onClick={() => onChoose(suggestion)}><span>{suggestion.kind === "command" ? <Command size={13} /> : suggestion.kind === "directory" ? <Folder size={13} /> : <Code2 size={13} />}</span><strong>{suggestion.label}</strong><small>{suggestion.description}</small><kbd>{index === activeIndex ? "Tab" : ""}</kbd></button>)}</div>;
}

function parseSlashCommand(value: string): { command: string; args: string | null } | null {
  const match = value.match(/^\/([a-z-]+)(?:\s+([\s\S]+))?$/i);
  return match ? { command: match[1].toLowerCase(), args: match[2]?.trim() || null } : null;
}

async function executeSlashCommand(thread: Thread, slash: { command: string; args: string | null }): Promise<boolean> {
  let args = slash.args;
  if (slash.command === "goal" && (!args || args.toLowerCase() === "set")) {
    const objective = window.prompt("Goal objective", thread.goal?.objective || "");
    if (!objective?.trim()) return false;
    args = objective.trim();
  }
  await api(`/api/threads/${thread.id}/command`, { method: "POST", body: JSON.stringify({ ...slash, args }) });
  return true;
}

function goalStatusLabel(status: NonNullable<Thread["goal"]>["status"]): string {
  return ({ active: "Active", paused: "Paused", blocked: "Blocked", usageLimited: "Usage limited", budgetLimited: "Budget limited", complete: "Complete" })[status];
}

function Welcome({ onNew }: { onNew: () => void }) {
  return <div className="welcome"><div className="welcome-mark"><div className="brand-mark large"><span /><span /><span /></div></div><span className="eyebrow">LOCAL · PERSISTENT · YOUR ACCOUNT</span><h1>Your Codex fleet,<br /><em>one command deck.</em></h1><p>Launch independent coding sessions in any workspace. They keep moving when your browser doesn’t.</p><button className="primary-button" onClick={onNew}><Plus size={17} />Launch a session</button><div className="feature-row"><span><Server size={17} />Runs on this machine</span><span><ShieldCheck size={17} />Private by default</span><span><LayoutGrid size={17} />Unlimited workspaces</span></div></div>;
}

function NewSessionModal({ bootstrap, onClose, onCreated, onError }: { bootstrap: Bootstrap; onClose: () => void; onCreated: (thread: Thread, model: string, effort: string) => void; onError: (error: unknown) => void }) {
  const defaultModel = bootstrap.models.data.find((model) => model.isDefault) || bootstrap.models.data[0];
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState(defaultModel.model);
  const [effort, setEffort] = useState(defaultModel.defaultReasoningEffort);
  const [yolo, setYolo] = useState(false);
  const [browser, setBrowser] = useState<{ path: string | null; parent: string | null; entries: Array<{ name: string; path: string }> } | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selectedModel = bootstrap.models.data.find((item) => item.model === model) || defaultModel;

  const browse = useCallback(async (target?: string) => {
    const query = target ? `?path=${encodeURIComponent(target)}` : "";
    setBrowser(await api(`/api/directories${query}`));
  }, []);
  useEffect(() => { void browse().catch(onError); }, [browse, onError]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedPath) return;
    setBusy(true);
    try {
      const response = await api<{ thread: Thread }>("/api/threads", { method: "POST", body: JSON.stringify({ cwd: selectedPath, model, effort, name, prompt, yolo }) });
      onCreated(response.thread, model, effort);
    } catch (error) { onError(error); } finally { setBusy(false); }
  };

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="new-modal" onSubmit={submit}>
      <div className="modal-header"><div><span className="eyebrow">NEW CODEX SESSION</span><h2>Choose your launch settings</h2></div><button type="button" className="icon-button" onClick={onClose}><X size={19} /></button></div>
      <div className="new-grid">
        <section className="directory-picker">
          <div className="section-label"><FolderOpen size={15} />Workspace directory</div>
          <div className="path-bar"><button type="button" disabled={!browser?.parent} onClick={() => browser?.parent && void browse(browser.parent)}><ArrowLeft size={15} /></button><span title={browser?.path || "Workspace roots"}>{browser?.path || "Available roots"}</span></div>
          <div className="folder-list">
            {!browser && <LoaderCircle className="spin" />}
            {browser?.entries.map((entry) => <button type="button" key={entry.path} onClick={() => { setSelectedPath(entry.path); void browse(entry.path); }} className={selectedPath === entry.path ? "selected" : ""}><Folder size={16} /><span>{entry.name}</span><ChevronRight size={15} /></button>)}
            {browser && !browser.entries.length && <div className="folder-empty">No child directories</div>}
          </div>
          <button type="button" className={`select-directory ${browser?.path && selectedPath === browser.path ? "chosen" : ""}`} disabled={!browser?.path} onClick={() => setSelectedPath(browser!.path)}>{selectedPath === browser?.path ? <Check size={16} /> : <FolderOpen size={16} />}{selectedPath === browser?.path ? "Selected" : "Use this directory"}</button>
        </section>
        <section className="launch-settings">
          <label className="field"><span>Session name <i>optional</i></span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Ship the billing redesign" maxLength={100} /></label>
          <label className="field"><span>Model</span><select value={model} onChange={(event) => { const next = bootstrap.models.data.find((item) => item.model === event.target.value)!; setModel(next.model); setEffort(next.defaultReasoningEffort); }}>{bootstrap.models.data.map((item) => <option key={item.id} value={item.model}>{item.displayName}</option>)}</select><small>{selectedModel.description}</small></label>
          <div className="field"><span>Thinking amount</span><div className="effort-grid">{selectedModel.supportedReasoningEfforts.map((option) => <button type="button" key={option.reasoningEffort} className={effort === option.reasoningEffort ? "selected" : ""} onClick={() => setEffort(option.reasoningEffort)}>{EFFORT_LABELS[option.reasoningEffort] || option.reasoningEffort}</button>)}</div></div>
          <label className="field prompt-field"><span>First task <i>optional</i></span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Start the session with a task, or leave it waiting…" rows={4} /></label>
        </section>
      </div>
      <div className="modal-footer"><label className={`yolo-toggle ${yolo ? "enabled" : ""}`}><input type="checkbox" checked={yolo} onChange={(event) => setYolo(event.target.checked)} /><span className="toggle-track"><i /></span><span>{yolo ? "YOLO mode" : "Workspace-write sandbox"}<small>{yolo ? "No approvals · full system access" : "Approvals appear in ForgeDeck"}</small></span></label><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={!selectedPath || busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />}Launch session</button></div>
    </form>
  </div>;
}

function ApprovalTray({ requests, onResolved, onError }: { requests: PendingRequest[]; onResolved: (id: string | number) => void; onError: (error: unknown) => void }) {
  const request = requests[0];
  const params = request.params || {};
  const questions = Array.isArray(params.questions) ? params.questions as Array<{ id: string; header: string; question: string; isSecret: boolean; options: Array<{ label: string; description: string }> | null }> : [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  useEffect(() => setAnswers({}), [request.id]);
  const isKnown = request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval";
  const isQuestion = request.method === "item/tool/requestUserInput";
  const decide = async (decision: string) => {
    try {
      await api(`/api/approvals/${encodeURIComponent(String(request.id))}`, { method: "POST", body: JSON.stringify({ decision }) });
      onResolved(request.id);
    } catch (error) { onError(error); }
  };
  const answerQuestions = async () => {
    try {
      const mapped = Object.fromEntries(questions.map((question) => [question.id, { answers: [answers[question.id] || ""] }]));
      await api(`/api/approvals/${encodeURIComponent(String(request.id))}`, { method: "POST", body: JSON.stringify({ result: { answers: mapped } }) });
      onResolved(request.id);
    } catch (error) { onError(error); }
  };
  return <div className="approval-tray">
    <div className="approval-title"><div><ShieldCheck size={18} /><span>Codex needs approval <small>{requests.length > 1 ? `${requests.length} requests waiting` : "Session paused safely"}</small></span></div></div>
    <div className="approval-content">
      <strong>{request.method.includes("commandExecution") ? "Run this command?" : request.method.includes("fileChange") ? "Apply these file changes?" : "Codex is requesting input"}</strong>
      {params.command ? <code>{String(params.command)}</code> : <p>{String(params.reason || "Review this request before continuing.")}</p>}
      {Boolean(params.cwd) && <small><Folder size={12} />{String(params.cwd)}</small>}
      {isQuestion && <div className="approval-questions">{questions.map((question) => <label key={question.id}><span>{question.header}<small>{question.question}</small></span>{question.options?.length ? <select value={answers[question.id] || ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}><option value="" disabled>Choose…</option>{question.options.map((option) => <option key={option.label} value={option.label}>{option.label} — {option.description}</option>)}</select> : <input type={question.isSecret ? "password" : "text"} value={answers[question.id] || ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} />}</label>)}</div>}
    </div>
    {isKnown ? <div className="approval-actions"><button onClick={() => void decide("decline")} className="deny">Decline</button><button onClick={() => void decide("accept")}>Allow once</button><button onClick={() => void decide("acceptForSession")} className="approve"><Check size={15} />Allow for session</button></div>
      : isQuestion ? <div className="approval-actions"><button className="approve" disabled={questions.some((question) => !answers[question.id])} onClick={() => void answerQuestions()}><Check size={15} />Send answer</button></div>
      : <div className="approval-actions"><span className="unsupported-request">Open the Codex CLI to answer this structured request.</span></div>}
  </div>;
}

type ApiOptions = RequestInit & { allowUnauthenticated?: boolean };
async function api<T = unknown>(url: string, options: ApiOptions = {}): Promise<T> {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options.headers } });
  const payload = response.headers.get("content-type")?.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    if (response.status === 401 && !options.allowUnauthenticated && url !== "/api/auth") window.location.reload();
    throw new Error(payload?.error || `Request failed (${response.status})`);
  }
  return payload as T;
}

function threadTitle(thread: Thread): string { return thread.name || thread.preview || "Untitled session"; }
function basename(value: string): string { return value.split("/").filter(Boolean).pop() || value; }
function initials(value: string): string { return value.split(/[@.\s_-]/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "CD"; }
function formatPlan(value?: string | null): string { return value ? value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (char) => char.toUpperCase()) : "Codex"; }
function statusRank(thread: Thread): number { return thread.status.type === "active" ? 3 : thread.status.type === "systemError" ? 2 : thread.status.type === "idle" ? 1 : 0; }
function timeAgo(timestamp: number): string {
  const seconds = Math.max(0, Date.now() / 1000 - timestamp);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
  return new Date(timestamp * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function relativeReset(timestamp: number): string {
  const seconds = Math.max(0, timestamp - Date.now() / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return days ? `in ${days}d ${hours}h` : `in ${hours}h`;
}
function showError(error: unknown, setter: (value: string) => void) { setter(error instanceof Error ? error.message : String(error)); }
function mergeLiveState<T>(current: Record<string, Record<string, T>>, state: Record<string, LiveThreadState>, key: "items" | "agentText" | "toolOutput"): Record<string, Record<string, T>> {
  const next = { ...current };
  for (const [threadId, value] of Object.entries(state)) {
    next[threadId] = { ...(next[threadId] || {}), ...(value[key] as Record<string, T>) };
  }
  return next;
}
function withoutSetValue<T>(values: Set<T>, value: T): Set<T> {
  const next = new Set(values);
  next.delete(value);
  return next;
}
function useControlColumns(): number {
  const getColumns = () => window.innerWidth >= 1700 ? 4 : window.innerWidth >= 1150 ? 3 : window.innerWidth >= 680 ? 2 : 1;
  const [columns, setColumns] = useState(getColumns);
  useEffect(() => {
    const onResize = () => setColumns(getColumns());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return columns;
}
function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}
function truncate(value: string, limit: number): string { return value.length > limit ? `${value.slice(0, limit - 1)}…` : value; }
function toolLabel(type: string): string {
  return type.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (character) => character.toUpperCase());
}
function isToolItem(item: ThreadItem): boolean {
  return !["userMessage", "agentMessage", "reasoning", "plan", "contextCompaction", "hookPrompt"].includes(item.type);
}

function messageFingerprint(item: ThreadItem): string | null {
  if (item.type === "agentMessage") return `agent:${(item.text || "").trim()}`;
  if (item.type !== "userMessage") return null;
  const text = item.content?.filter((part) => part.type === "text").map((part) => part.text || "").join("\n").trim() || "";
  return `user:${text}`;
}

function unseenLiveItems(history: ThreadItem[], live: ThreadItem[]): ThreadItem[] {
  const historyIds = new Set(history.map((item) => item.id).filter(Boolean));
  const historyMessageCounts = new Map<string, number>();
  const canonicalUserMessages = new Set(live.filter((item) => item.type === "userMessage" && item.id && !item.id.startsWith("user-")).map(messageFingerprint).filter((value): value is string => Boolean(value)));
  for (const item of history) {
    const fingerprint = messageFingerprint(item);
    if (fingerprint) historyMessageCounts.set(fingerprint, (historyMessageCounts.get(fingerprint) || 0) + 1);
  }
  return live.filter((item) => {
    if (item.id && historyIds.has(item.id)) return false;
    const fingerprint = messageFingerprint(item);
    if (item.type === "userMessage" && item.id?.startsWith("user-") && fingerprint && canonicalUserMessages.has(fingerprint)) return false;
    if (!fingerprint) return true;
    const historyCount = historyMessageCounts.get(fingerprint) || 0;
    if (historyCount > 0) {
      historyMessageCounts.set(fingerprint, historyCount - 1);
      return false;
    }
    return true;
  });
}

function selectControlItems(items: ThreadItem[], limit: number): ThreadItem[] {
  const selected = new Set<number>();
  for (let index = Math.max(0, items.length - limit); index < items.length; index += 1) selected.add(index);
  let retainedChanges = 0;
  for (let index = items.length - 1; index >= 0 && retainedChanges < 2; index -= 1) {
    if (items[index].type === "fileChange") {
      selected.add(index);
      retainedChanges += 1;
    }
  }
  return [...selected].sort((a, b) => a - b).map((index) => items[index]);
}
