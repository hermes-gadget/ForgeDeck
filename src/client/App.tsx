import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import {
  Archive, ArrowLeft, Bot, BrainCircuit, Check, ChevronRight, CircleStop,
  Clock3, Code2, Command, Folder, FolderOpen, Gauge, GitBranch, KeyRound,
  LayoutGrid, LoaderCircle, LogOut, Menu, MessageSquareText, MoreHorizontal,
  PanelLeftClose, Pin, PinOff, Plus, RefreshCw, Search, Send, Server,
  Settings2, ShieldCheck, Sparkles, TerminalSquare, X
} from "lucide-react";
import type { Bootstrap, CodexModel, PendingRequest, Thread, ThreadItem, Usage } from "./types";

type SortMode = "updated" | "created" | "name" | "directory" | "status";
type ThreadSettings = Record<string, { model: string; effort: string }>;

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
  const [newOpen, setNewOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pending, setPending] = useState<PendingRequest[]>([]);
  const [liveText, setLiveText] = useState<Record<string, string>>({});
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

  useEffect(() => {
    if (!authenticated) return;
    const events = new EventSource("/events");
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
    events.addEventListener("codex", (event) => {
      const notification = JSON.parse((event as MessageEvent).data) as { method: string; params: Record<string, unknown> };
      const threadId = typeof notification.params?.threadId === "string" ? notification.params.threadId : null;
      if (notification.method === "item/agentMessage/delta" && threadId === selectedRef.current) {
        const itemId = String(notification.params.itemId);
        const delta = String(notification.params.delta || "");
        setLiveText((current) => ({ ...current, [itemId]: (current[itemId] || "") + delta }));
      }
      if (notification.method === "account/rateLimits/updated") {
        void loadBootstrap().catch(() => undefined);
      }
      if (threadId === selectedRef.current && !notification.method.endsWith("/delta")) {
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        refreshTimer.current = window.setTimeout(() => {
          if (selectedRef.current) void loadThread(selectedRef.current, true);
          if (notification.method === "item/completed" || notification.method === "turn/completed") setLiveText({});
        }, 300);
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

  const sortedThreads = useMemo(() => {
    const copy = [...threads];
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
  }, [threads, sortMode, pinned]);

  const defaultModel = bootstrap?.models.data.find((model) => model.isDefault) || bootstrap?.models.data[0];
  const activeSettings = selectedId && settings[selectedId]
    ? settings[selectedId]
    : defaultModel ? { model: defaultModel.model, effort: defaultModel.defaultReasoningEffort } : null;

  if (authenticated === null) return <Splash />;
  if (!authenticated) return <Login onSuccess={() => setAuthenticated(true)} />;
  if (!bootstrap) return <Splash label="Connecting to your Codex account…" />;

  const togglePin = (id: string) => setPinned((current) => {
    const next = new Set(current);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const updateSettings = (next: { model: string; effort: string }) => {
    if (!selectedId) return;
    setSettings((current) => ({ ...current, [selectedId]: next }));
  };

  const onCreated = async (thread: Thread, model: string, effort: string) => {
    setSettings((current) => ({ ...current, [thread.id]: { model, effort } }));
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
            <SessionCard key={thread.id} thread={thread} selected={thread.id === selectedId} pinned={pinned.has(thread.id)}
              onSelect={() => setSelectedId(thread.id)} onPin={() => togglePin(thread.id)} />
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
          {detail ? <ThreadHeader thread={detail} pinned={pinned.has(detail.id)} onPin={() => togglePin(detail.id)}
            onRename={async () => {
              const name = prompt("Session name", threadTitle(detail));
              if (!name?.trim()) return;
              await api(`/api/threads/${detail.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
              await Promise.all([loadThread(detail.id), loadThreads()]);
            }}
            onArchive={async () => {
              if (!confirm("Archive this session? Its Codex history will be kept.")) return;
              await api(`/api/threads/${detail.id}`, { method: "DELETE" });
              setSelectedId(null); setDetail(null); await loadThreads();
            }} /> : <div className="topbar-placeholder">Session workspace</div>}
          <div className={`runtime-pill ${runtime}`}><span />{runtime === "ready" ? "Runtime online" : "Reconnecting"}</div>
        </header>

        {detail ? (
          <Chat thread={detail} loading={loadingDetail} liveText={liveText} models={bootstrap.models.data}
            settings={activeSettings!} onSettings={updateSettings} onRefresh={() => loadThread(detail.id)} onError={(error) => showError(error, setToast)} />
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

function SessionCard({ thread, selected, pinned, onSelect, onPin }: { thread: Thread; selected: boolean; pinned: boolean; onSelect: () => void; onPin: () => void }) {
  const running = thread.status.type === "active";
  return <button className={`session-card ${selected ? "selected" : ""}`} onClick={onSelect}>
    <span className={`status-dot ${thread.status.type}`} />
    <span className="session-copy"><strong>{threadTitle(thread)}</strong><small><Folder size={12} />{basename(thread.cwd)}<i>·</i>{timeAgo(thread.updatedAt)}</small></span>
    <span className="session-actions" onClick={(event) => event.stopPropagation()}>
      {running && <LoaderCircle className="spin running-icon" size={14} />}
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

function Chat({ thread, loading, liveText, models, settings, onSettings, onRefresh, onError }: {
  thread: Thread; loading: boolean; liveText: Record<string, string>; models: CodexModel[];
  settings: { model: string; effort: string }; onSettings: (value: { model: string; effort: string }) => void;
  onRefresh: () => Promise<void>; onError: (error: unknown) => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const selectedModel = models.find((model) => model.model === settings.model) || models[0];
  const runningTurn = [...thread.turns].reverse().find((turn) => turn.status === "inProgress");

  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" }); }, [thread.turns, liveText]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || sending || runningTurn) return;
    const outgoing = text.trim(); setText(""); setSending(true);
    try {
      await api(`/api/threads/${thread.id}/messages`, { method: "POST", body: JSON.stringify({ text: outgoing, ...settings }) });
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
      {thread.turns.map((turn) => <TurnView key={turn.id} turn={turn} />)}
      {Object.entries(liveText).map(([id, value]) => value && <div className="message agent live" key={id}><div className="message-avatar"><Bot size={16} /></div><div className="message-body"><div className="message-meta">Codex <span>working now</span></div><ReactMarkdown>{value}</ReactMarkdown><span className="typing-cursor" /></div></div>)}
      {runningTurn && !Object.values(liveText).some(Boolean) && <div className="thinking-line"><LoaderCircle className="spin" size={17} /><span>Codex is working</span><i /><i /><i /></div>}
    </div>

    <div className="composer-zone">
      <form className="composer" onSubmit={submit}>
        <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder={runningTurn ? "This session is currently working…" : "Give Codex a task…"}
          disabled={Boolean(runningTurn)} rows={3} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        <div className="composer-footer">
          <div className="model-controls">
            <label><Bot size={14} /><select value={settings.model} onChange={(event) => changeModel(event.target.value)}>{models.map((model) => <option key={model.id} value={model.model}>{model.displayName}</option>)}</select></label>
            <label><BrainCircuit size={14} /><select value={settings.effort} onChange={(event) => onSettings({ ...settings, effort: event.target.value })}>{selectedModel.supportedReasoningEfforts.map((option) => <option key={option.reasoningEffort} value={option.reasoningEffort}>{EFFORT_LABELS[option.reasoningEffort] || option.reasoningEffort}</option>)}</select></label>
          </div>
          {runningTurn ? <button type="button" className="stop-button" onClick={() => void api(`/api/threads/${thread.id}/interrupt`, { method: "POST", body: JSON.stringify({ turnId: runningTurn.id }) }).catch(onError)}><CircleStop size={16} /> Stop</button>
            : <button className="send-button" disabled={!text.trim() || sending}>{sending ? <LoaderCircle className="spin" size={17} /> : <Send size={16} />}<span>Send</span></button>}
        </div>
      </form>
      <p className="persistence-note"><Server size={12} />Safe to close this tab — work continues on the host.</p>
    </div>
  </div>;
}

function TurnView({ turn }: { turn: Thread["turns"][number] }) {
  return <div className={`turn ${turn.status}`}>
    {turn.items.map((item, index) => <ItemView key={item.id || `${item.type}-${index}`} item={item} />)}
    {turn.status === "failed" && <div className="turn-error">{turn.error?.message || "This turn failed."}</div>}
  </div>;
}

function ItemView({ item }: { item: ThreadItem }) {
  if (item.type === "userMessage") {
    const text = item.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") || "";
    return <div className="message user"><div className="message-body"><div className="message-meta">You</div><p>{text}</p></div><div className="message-avatar">YOU</div></div>;
  }
  if (item.type === "agentMessage") return <div className="message agent"><div className="message-avatar"><Bot size={16} /></div><div className="message-body"><div className="message-meta">Codex</div><ReactMarkdown>{item.text || ""}</ReactMarkdown></div></div>;
  if (item.type === "reasoning") return <details className="reasoning-item"><summary><BrainCircuit size={15} />Reasoning <ChevronRight size={14} /></summary><div>{item.summary?.map((part, index) => <ReactMarkdown key={index}>{part}</ReactMarkdown>)}</div></details>;
  if (item.type === "commandExecution") return <details className="tool-item"><summary><TerminalSquare size={15} /><span><strong>Command</strong><code>{item.command}</code></span><em className={item.status}>{item.status}</em></summary>{item.aggregatedOutput && <pre>{item.aggregatedOutput}</pre>}</details>;
  if (item.type === "fileChange") return <details className="tool-item"><summary><Code2 size={15} /><span><strong>Files changed</strong><code>{item.changes?.length || 0} update{item.changes?.length === 1 ? "" : "s"}</code></span><em className={item.status}>{item.status}</em></summary><pre>{JSON.stringify(item.changes, null, 2)}</pre></details>;
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") return <details className="tool-item"><summary><Command size={15} /><span><strong>{item.tool || "Tool call"}</strong><code>{item.server || "Codex tool"}</code></span><em className={item.status}>{item.status}</em></summary><pre>{JSON.stringify(item.result || item.error || item.arguments, null, 2)}</pre></details>;
  if (item.type === "plan") return <div className="plan-item"><LayoutGrid size={15} /><ReactMarkdown>{item.text || ""}</ReactMarkdown></div>;
  return null;
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
      const response = await api<{ thread: Thread }>("/api/threads", { method: "POST", body: JSON.stringify({ cwd: selectedPath, model, effort, name, prompt }) });
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
      <div className="modal-footer"><div><ShieldCheck size={15} /><span>Workspace-write sandbox<br /><small>Approvals appear in ForgeDeck</small></span></div><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={!selectedPath || busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />}Launch session</button></div>
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
