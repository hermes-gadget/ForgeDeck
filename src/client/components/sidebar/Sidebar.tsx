import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle, Archive, ArrowDownAZ, BarChart3, Bell, BookOpen, Bot, CheckSquare, CircleStop, Clock3, Folder, Gauge, LayoutGrid,
  Eraser, ListFilter, ListPlus, LoaderCircle, LockKeyhole, LogOut, MessageSquareText, Package, PanelLeftClose, Pin, PinOff, Plus, Search, ShieldCheck, Sparkles, Square, Target
} from "lucide-react";
import { DEFAULT_THREAD_FILTERS, type InventoryFacet, type InventoryFacets, type SortDirection, type SortMode, type ThreadFilters } from "../../hooks/use-thread-inventory";
import { useSwipeDismiss } from "../../hooks/use-swipe-dismiss";
import { useThreadLiveState } from "../../state/thread-store";
import { activityTitle, buildSessionCardDetails, relativeActivity, SessionStateBadge } from "../session-card/SessionCardDetails";
import type { Bootstrap, Thread, Usage } from "../../types";
import type { ErrorEntry } from "../error-center/ErrorCenter";
import type { SessionOperation } from "../session-actions/SessionActionDialog";

export type SidebarView = "session" | "control" | "spark" | "missions" | "compare" | "evals" | "archive";
export type BatchAction = "pin";
const SIDEBAR_VIEWS: SidebarView[] = ["session", "control", "spark"];

type SidebarProps = {
  open: boolean;
  bootstrap: Bootstrap;
  threads: readonly Thread[];
  totalCount: number;
  selectedId: string | null;
  view: SidebarView;
  controlIds: ReadonlySet<string>;
  sparkIds: ReadonlySet<string>;
  pinned: ReadonlySet<string>;
  search: string;
  sortMode: SortMode;
  sortDirection: SortDirection;
  filters: ThreadFilters;
  facets: InventoryFacets;
  hasMore: boolean;
  loadingMore: boolean;
  idleCount: number;
  unseenNotificationCount: number;
  errors: readonly ErrorEntry[];
  waitingThreadIds: ReadonlySet<string>;
  onClose: () => void;
  onNew: () => void;
  onView: (view: SidebarView) => void;
  onSearch: (value: string) => void;
  onSort: (value: SortMode) => void;
  onSortDirection: () => void;
  onFilters: (filters: ThreadFilters) => void;
  onLoadMore: () => Promise<void>;
  onSelect: (threadId: string) => void;
  onTogglePin: (threadId: string) => void;
  onToggleBoard: (threadId: string) => void;
  onBatchAction: (action: BatchAction, threadIds: string[]) => Promise<string[]>;
  onSessionAction: (operation: SessionOperation, threadIds: string[]) => void;
  onClearIdle: () => void;
  onNotifications: () => void;
  onInsights: () => void;
  onKnowledgePacks: () => void;
  onPolicies: () => void;
  onLogout: () => void;
};

export const Sidebar = memo(function Sidebar({
  open, bootstrap, threads, totalCount, selectedId, view, controlIds, sparkIds, pinned, search, sortMode, sortDirection, filters, facets, hasMore, loadingMore, idleCount, unseenNotificationCount, errors, waitingThreadIds,
  onClose, onNew, onView, onSearch, onSort, onSortDirection, onFilters, onLoadMore, onSelect, onTogglePin, onToggleBoard, onBatchAction, onSessionAction, onClearIdle, onNotifications, onInsights, onKnowledgePacks, onPolicies, onLogout
}: SidebarProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const viewRefs = useRef(new Map<SidebarView, HTMLButtonElement>());
  const sessionRefs = useRef(new Map<string, HTMLButtonElement>());
  const [selectionMode, setSelectionMode] = useState(false);
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 1024px)").matches);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(selectedId);
  const [busy, setBusy] = useState(false);
  const [batchMessage, setBatchMessage] = useState("");
  const lastSelectionIndex = useRef<number | null>(null);
  const visibleIds = useMemo(() => threads.map((thread) => thread.id), [threads]);
  const modifierLabel = /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "⌘" : "Ctrl+";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (document.querySelector("[aria-modal='true']")) return;
      if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !target?.matches("input, textarea, select, [contenteditable=true]")) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1024px)");
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!compact || !open) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [compact, onClose, open]);

  const swipeDismiss = useSwipeDismiss<HTMLElement>(onClose, { direction: "left", enabled: compact && open });

  useEffect(() => {
    const available = new Set(visibleIds);
    setSelected((current) => {
      const next = new Set([...current].filter((id) => available.has(id)));
      return next.size === current.size ? current : next;
    });
    setActiveSessionId((current) => current && available.has(current)
      ? current
      : selectedId && available.has(selectedId) ? selectedId : visibleIds[0] || null);
  }, [selectedId, visibleIds]);

  const setViewRef = useCallback((candidate: SidebarView, element: HTMLButtonElement | null) => {
    if (element) viewRefs.current.set(candidate, element);
    else viewRefs.current.delete(candidate);
  }, []);
  const setSessionRef = useCallback((threadId: string, element: HTMLButtonElement | null) => {
    if (element) sessionRefs.current.set(threadId, element);
    else sessionRefs.current.delete(threadId);
  }, []);
  const focusView = useCallback((candidate: SidebarView) => {
    onView(candidate);
    viewRefs.current.get(candidate)?.focus();
  }, [onView]);
  const handleViewKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>, candidate: SidebarView) => {
    const current = SIDEBAR_VIEWS.indexOf(candidate);
    const target = event.key === "Home" ? 0
      : event.key === "End" ? SIDEBAR_VIEWS.length - 1
        : event.key === "ArrowRight" ? (current + 1) % SIDEBAR_VIEWS.length
          : event.key === "ArrowLeft" ? (current - 1 + SIDEBAR_VIEWS.length) % SIDEBAR_VIEWS.length : -1;
    if (target < 0) return;
    event.preventDefault();
    focusView(SIDEBAR_VIEWS[target]);
  }, [focusView]);
  const toggleSelection = useCallback((threadId: string, index: number, shiftKey: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (shiftKey && lastSelectionIndex.current !== null) {
        const start = Math.min(index, lastSelectionIndex.current);
        const end = Math.max(index, lastSelectionIndex.current);
        const shouldSelect = !next.has(threadId);
        for (let cursor = start; cursor <= end; cursor += 1) {
          const id = visibleIds[cursor];
          if (id) shouldSelect ? next.add(id) : next.delete(id);
        }
      } else {
        next.has(threadId) ? next.delete(threadId) : next.add(threadId);
      }
      lastSelectionIndex.current = index;
      return next;
    });
  }, [visibleIds]);
  const handleSessionKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>, threadId: string, index: number) => {
    if (selectionMode && event.key === " ") {
      event.preventDefault();
      toggleSelection(threadId, index, event.shiftKey);
      return;
    }
    const target = event.key === "Home" ? 0
      : event.key === "End" ? visibleIds.length - 1
        : event.key === "ArrowDown" ? Math.min(visibleIds.length - 1, index + 1)
          : event.key === "ArrowUp" ? Math.max(0, index - 1) : -1;
    if (target < 0 || target === index) return;
    event.preventDefault();
    const nextId = visibleIds[target];
    setActiveSessionId(nextId);
    sessionRefs.current.get(nextId)?.focus();
  }, [selectionMode, toggleSelection, visibleIds]);

  const runBatch = useCallback(async () => {
    const ids = [...selected];
    if (!ids.length) return;
    setBusy(true);
    setBatchMessage("");
    try {
      const failed = await onBatchAction("pin", ids);
      setSelected(new Set(failed));
      setBatchMessage(failed.length ? `Not completed: ${failed.join(", ")}` : `Pin state updated for ${ids.length} session${ids.length === 1 ? "" : "s"}.`);
    } catch (error) {
      setBatchMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [onBatchAction, selected]);

  const toggleSelectionMode = useCallback(() => {
    setSelectionMode((current) => {
      if (current) setSelected(new Set());
      return !current;
    });
  }, []);

  return <aside {...swipeDismiss} className={`sidebar ${open ? "open" : ""}`} aria-label="ForgeDeck sessions" aria-hidden={compact && !open ? true : undefined} inert={compact && !open}>
    <div className="brand-row">
      <Brand />
      <div className="brand-actions"><button className="sidebar-policies" onClick={onPolicies} aria-label="Manage session policies"><ShieldCheck size={15} /></button><button className="sidebar-knowledge" onClick={onKnowledgePacks} aria-label="Manage knowledge packs"><BookOpen size={15} /></button><button className="sidebar-insights" onClick={onInsights} aria-label="Open universal search and outcome analytics"><BarChart3 size={15} /></button><button className={`sidebar-notifications ${unseenNotificationCount ? "unseen" : ""}`} onClick={onNotifications} aria-label={`Open notification center${unseenNotificationCount ? `, ${unseenNotificationCount} unseen` : ""}`}><Bell size={15} />{unseenNotificationCount > 0 && <span>{unseenNotificationCount > 99 ? "99+" : unseenNotificationCount}</span>}</button><button ref={closeRef} className="icon-button mobile-only" onClick={onClose} aria-label="Close sidebar"><PanelLeftClose size={16} /></button></div>
    </div>
    <button className="new-session" onClick={onNew} aria-keyshortcuts="Meta+N Control+N" title={`New session (${modifierLabel}N)`}><Plus size={18} /> New session <kbd>{modifierLabel}N</kbd></button>
    <div className="view-switch" role="tablist" aria-label="Workspace view">
      <button ref={(element) => setViewRef("session", element)} id="workspace-tab-session" role="tab" aria-controls="workspace-panel" aria-label="Session workspace" aria-selected={view === "session"} tabIndex={view === "control" || view === "spark" ? -1 : 0} className={view === "session" ? "active" : ""} title={`Chat · ${modifierLabel}[ / ${modifierLabel}]`} onKeyDown={(event) => handleViewKeyDown(event, "session")} onClick={() => onView("session")}><MessageSquareText size={12} />Chat</button>
      <button ref={(element) => setViewRef("control", element)} id="workspace-tab-control" role="tab" aria-controls="workspace-panel" aria-label={`Control Center, ${controlIds.size} sessions`} aria-selected={view === "control"} tabIndex={view === "control" ? 0 : -1} className={view === "control" ? "active" : ""} title={`Board · ${modifierLabel}[ / ${modifierLabel}]`} onKeyDown={(event) => handleViewKeyDown(event, "control")} onClick={() => onView("control")}><LayoutGrid size={12} />Board<span>{controlIds.size}</span></button>
      <button ref={(element) => setViewRef("spark", element)} id="workspace-tab-spark" role="tab" aria-controls="workspace-panel" aria-label={`SparkBoard, ${sparkIds.size} sessions`} aria-selected={view === "spark"} tabIndex={view === "spark" ? 0 : -1} className={view === "spark" ? "active" : ""} title={`Spark · ${modifierLabel}[ / ${modifierLabel}]`} onKeyDown={(event) => handleViewKeyDown(event, "spark")} onClick={() => onView("spark")}><Sparkles size={12} />Spark<span>{sparkIds.size}</span></button>
    </div>
    <UsageCard usage={bootstrap.usage} backendStatus={bootstrap.backendStatus} />
    <div className="session-tools">
      <label className="search-box" title="Search sessions (/)"><Search size={15} /><span className="sr-only">Search sessions</span><input ref={searchRef} value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Find a session…  /" /></label>
      <select value={sortMode} onChange={(event) => onSort(event.target.value as SortMode)} aria-label="Sort sessions; pinned sessions stay first" title="Sort sessions">
        <option value="updated">Recent activity</option><option value="created">Newest created</option><option value="status">Status</option><option value="name">Name</option><option value="directory">Directory</option>
      </select>
      <button className="sort-direction" onClick={onSortDirection} aria-label={`Sort ${sortDirection === "asc" ? "descending" : "ascending"}`} title={`Sort ${sortDirection === "asc" ? "descending" : "ascending"}`}><ArrowDownAZ className={sortDirection === "desc" ? "sort-descending" : ""} size={14} /></button>
    </div>
    <div className="session-filter-row">
      <select value={filters.status} onChange={(event) => onFilters({ ...filters, status: event.target.value as ThreadFilters["status"] })} aria-label="Filter by status">
        <option value="all">All status</option><option value="active">Active</option><option value="idle">Idle</option><option value="error">Errors</option>
      </select>
      <select value={filters.backend} onChange={(event) => onFilters({ ...filters, backend: event.target.value as ThreadFilters["backend"] })} aria-label="Filter by provider">
        <option value="all">All providers</option><option value="codex">Codex / Spark</option>
      </select>
    </div>
    <details className="inventory-facets">
      <summary><ListFilter size={12} />More filters{activeFacetCount(filters) > 0 && <b>{activeFacetCount(filters)}</b>}</summary>
      <div>
        <FacetSelect label="Class" value={filters.sessionClass} values={facets.sessionClass} allLabel="All classes" allValue="all" onChange={(value) => onFilters({ ...filters, sessionClass: value as ThreadFilters["sessionClass"] })} />
        <FacetSelect label="Model" value={filters.model} values={facets.model} allLabel="All models" onChange={(model) => onFilters({ ...filters, model })} />
        <FacetSelect label="Workspace" value={filters.workspace} values={facets.workspace} allLabel="All workspaces" format={basename} onChange={(workspace) => onFilters({ ...filters, workspace })} />
        <FacetSelect label="Label" value={filters.label} values={facets.labels} allLabel="All labels" onChange={(label) => onFilters({ ...filters, label })} />
        <FacetSelect label="Queue" value={filters.queueState} values={facets.queueState} allLabel="Any queue" allValue="all" onChange={(value) => onFilters({ ...filters, queueState: value as ThreadFilters["queueState"] })} />
        <FacetSelect label="Owner" value={filters.owner} values={facets.owner} allLabel="All owners" onChange={(owner) => onFilters({ ...filters, owner })} />
        <FacetSelect label="Source" value={filters.source} values={facets.source} allLabel="All sources" allValue="all" onChange={(value) => onFilters({ ...filters, source: value as ThreadFilters["source"] })} />
        <FacetSelect label="Archive" value={filters.archiveState} values={facets.archiveState} allLabel="Active + archived" allValue="all" onChange={(value) => onFilters({ ...filters, archiveState: value as ThreadFilters["archiveState"] })} />
        <label>From<input type="date" value={filters.dateFrom} onChange={(event) => onFilters({ ...filters, dateFrom: event.target.value })} /></label>
        <label>To<input type="date" value={filters.dateTo} onChange={(event) => onFilters({ ...filters, dateTo: event.target.value })} /></label>
        <button type="button" className="clear-facets" disabled={activeFacetCount(filters) === 0} onClick={() => onFilters({ ...DEFAULT_THREAD_FILTERS })}>Clear filters</button>
      </div>
    </details>
    <div className="session-heading">
      <span>Sessions</span><span className="session-count">{threads.length}{threads.length !== totalCount ? ` / ${totalCount}` : ""}</span>
      <span className="session-heading-actions">
        <button className="clear-idle" onClick={onClearIdle} disabled={!idleCount} aria-label={`Clear ${idleCount} idle session${idleCount === 1 ? "" : "s"}`} title="Archive idle sessions"><Eraser size={13} />{idleCount > 0 && <span>{idleCount}</span>}</button>
        <button className={`select-toggle ${selectionMode ? "active" : ""}`} onClick={toggleSelectionMode} aria-pressed={selectionMode} aria-label={selectionMode ? "Exit session selection mode" : "Select multiple sessions"} title={selectionMode ? "Exit selection mode" : "Select multiple"}><CheckSquare size={13} /></button>
      </span>
    </div>
    <nav className="session-list" aria-label="Sessions" aria-keyshortcuts="ArrowUp ArrowDown Home End">
      {threads.map((thread, index) => <SessionCard key={thread.id} thread={thread} selected={view === "session" && thread.id === selectedId}
        pinned={pinned.has(thread.id)} inBoard={thread.sessionClass === "spark" ? sparkIds.has(thread.id) : controlIds.has(thread.id)}
        selectionMode={selectionMode} checked={selected.has(thread.id)} rovingActive={thread.id === activeSessionId} errors={errors} waiting={waitingThreadIds.has(thread.id)}
        onSelect={onSelect} onPin={onTogglePin} onBoard={onToggleBoard} onFocus={() => setActiveSessionId(thread.id)}
        onKeyDown={(event) => handleSessionKeyDown(event, thread.id, index)} setRef={(element) => setSessionRef(thread.id, element)}
        onCheck={(event) => toggleSelection(thread.id, index, event.shiftKey)} />)}
      {hasMore && <button className="inventory-more" disabled={loadingMore} onClick={() => void onLoadMore()}>{loadingMore ? <LoaderCircle className="spin" size={13} /> : null}{loadingMore ? "Loading…" : `Load more (${Math.max(0, totalCount - threads.length)} remaining)`}</button>}
      {!threads.length && <div className="empty-list"><MessageSquareText size={20} /><span>No sessions found</span></div>}
    </nav>
    {selectionMode && <div className="batch-toolbar" aria-label="Batch session actions">
      {batchMessage && <span className="batch-result" role="status" title={batchMessage}>{batchMessage}</span>}
      <button onClick={() => setSelected(selected.size === visibleIds.length ? new Set() : new Set(visibleIds))} disabled={busy} aria-label="Select all visible sessions">{selected.size === visibleIds.length && visibleIds.length ? <CheckSquare size={14} /> : <Square size={14} />}{selected.size || "All"}</button>
      <button onClick={() => void runBatch()} disabled={busy || !selected.size} aria-label="Pin selected sessions">{busy ? <LoaderCircle className="spin" size={14} /> : <Pin size={14} />}</button>
      <button onClick={() => onSessionAction("stop", [...selected])} disabled={busy || !selected.size} aria-label="Stop selected sessions"><CircleStop size={14} /></button>
      <button className="danger" onClick={() => onSessionAction("archive", [...selected])} disabled={busy || !selected.size} aria-label="Archive selected sessions"><Archive size={14} /></button>
    </div>}
    <div className="account-row">
      <div className="avatar">{initials(bootstrap.account.account?.email || "Codex")}</div>
      <div><strong>{bootstrap.account.account?.email || "Local Codex"}</strong></div>
      <button className="icon-button" onClick={onLogout} aria-label="Log out of ForgeDeck"><LogOut size={17} /></button>
    </div>
  </aside>;
});

type SessionCardProps = {
  thread: Thread; selected: boolean; pinned: boolean; inBoard: boolean; selectionMode: boolean; checked: boolean; rovingActive: boolean;
  errors: readonly ErrorEntry[]; waiting: boolean;
  onSelect: (threadId: string) => void; onPin: (threadId: string) => void; onBoard: (threadId: string) => void;
  onFocus: () => void; onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void; setRef: (element: HTMLButtonElement | null) => void;
  onCheck: (event: React.MouseEvent<HTMLButtonElement>) => void;
};

const SessionCard = memo(function SessionCard({ thread, selected, pinned, inBoard, selectionMode, checked, rovingActive, errors, waiting, onSelect, onPin, onBoard, onFocus, onKeyDown, setRef, onCheck }: SessionCardProps) {
  const live = useThreadLiveState(thread.id);
  const effective = live.status && live.status.type !== thread.status.type ? { ...thread, status: live.status } : thread;
  const details = buildSessionCardDetails(effective, { completed: live.completed, completedAt: live.completedAt, queueDepth: Math.max(live.queue.length, thread.queueDepth || 0), waiting, errors });
  const state = details.state;
  const running = state === "running";
  const spark = thread.sessionClass === "spark";
  const tokens = live.tokenUsage?.totalTokens ?? (thread.goal?.tokensUsed || null);
  const archived = thread.archiveState === "archived";
  const guardianStatus = guardianStatusText(thread);
  const previewId = useId();
  return <article className={`session-card state-${state} ${selected ? "selected" : ""} ${spark ? "provider-spark" : "provider-codex"}`}>
    {selectionMode && <button className="session-checkbox" tabIndex={-1} onClick={onCheck} aria-label={`${checked ? "Deselect" : "Select"} ${threadTitle(thread)}`} aria-pressed={checked}>{checked ? <CheckSquare size={15} /> : <Square size={15} />}</button>}
    <button ref={setRef} className="session-card-main" tabIndex={rovingActive ? 0 : -1} onFocus={onFocus} onKeyDown={onKeyDown} onClick={() => onSelect(thread.id)} aria-current={selected ? "page" : undefined} aria-pressed={selectionMode ? checked : undefined} aria-describedby={previewId}>
      <span className="session-copy">
        <span className="session-title-row"><ProviderIcon thread={thread} size={12} /><strong title={threadTitle(thread)}>{threadTitle(thread)}</strong>{archived && <em className="provider-badge archived">Archived</em>}{thread.workspaceLease && <em className={`workspace-lease-badge ${thread.workspaceLease.mode}`} title={`${thread.workspaceLease.mode} lease on ${thread.workspaceLease.root}`}><LockKeyhole size={9} />{thread.workspaceLease.mode === "exclusive" ? "Lock" : "RO"}</em>}<SessionStateBadge state={state} /></span>
        <span className="session-task-line" title={details.task}><MessageSquareText size={11} /><span>{details.task}</span></span>
        {details.goal && <span className="session-goal-line" title={details.goal}><Target size={11} /><span>{details.goal}</span></span>}
        {details.lastError ? <span className="session-attention error" title={details.lastError}><AlertTriangle size={11} /><b>{details.errorCount || 1}</b><span>{details.lastError}</span></span>
          : thread.policyWarnings?.length ? <span className="session-attention policy-warning" title={thread.policyWarnings.join("\n")}><AlertTriangle size={11} /><span>{thread.policyWarnings[0]}</span></span>
            : guardianStatus ? <span className={`session-attention guardian ${thread.guardian?.phase}`} title={guardianStatus}><Clock3 size={11} /><span>{guardianStatus}</span></span>
            : details.artifactStatus === "pending" ? <span className="session-attention gates" title={thread.artifactStatus?.unmetGates.map((gate) => `${gate.name}: ${gate.reason}`).join("\n")}><Package size={11} /><span>{details.unmetGateCount} required completion gate{details.unmetGateCount === 1 ? "" : "s"} unmet</span></span>
              : state === "done" && details.outcome ? <span className="session-attention outcome" title={details.outcome}><span>{details.outcome}</span></span> : null}
        <span className="session-metrics">
          <span title={`${details.model} · ${details.effort} reasoning`}><Bot size={11} />{details.model}<i>{details.effort}</i></span>
          {details.queueDepth > 0 && <span className="queue" title={`${details.queueDepth} queued message${details.queueDepth === 1 ? "" : "s"}`}><ListPlus size={11} />{details.queueDepth}</span>}
          {(details.artifactCount > 0 || details.artifactStatus !== "not-configured") && <span className={`artifacts ${details.artifactStatus}`} title={`${details.artifactCount} artifact${details.artifactCount === 1 ? "" : "s"}; completion gates ${details.artifactStatus}`}><Package size={11} />{details.artifactCount}{details.artifactStatus === "passed" ? " ✓" : details.unmetGateCount ? ` / ${details.unmetGateCount} unmet` : ""}</span>}
          <span className="activity" title={`Last activity: ${activityTitle(details.lastActivityAt)}`}><Clock3 size={11} />{relativeActivity(details.lastActivityAt)}</span>
          <span className="tokens" title={tokens === null ? "Token usage unavailable" : `${tokens.toLocaleString()} tokens used`}><Gauge size={11} />{tokens === null ? "—" : formatTokenCount(tokens)}</span>
        </span>
      </span>
    </button>
    <span className="session-actions">
      {running && <LoaderCircle className="spin running-icon" size={14} />}
      <button tabIndex={rovingActive ? 0 : -1} disabled={archived} onClick={() => onBoard(thread.id)} aria-label={`${inBoard ? "Remove" : "Add"} ${threadTitle(thread)} ${inBoard ? "from" : "to"} ${spark ? "SparkBoard" : "Control Center"}`} aria-pressed={inBoard}>{spark ? <Sparkles size={14} className={inBoard ? "control-active" : ""} /> : <LayoutGrid size={14} className={inBoard ? "control-active" : ""} />}</button>
      <button tabIndex={rovingActive ? 0 : -1} onClick={() => onPin(thread.id)} aria-label={`${pinned ? "Unpin" : "Pin"} ${threadTitle(thread)}`} aria-pressed={pinned}>{pinned ? <PinOff size={14} /> : <Pin size={14} />}</button>
    </span>
    <span className="session-hover-preview" id={previewId} role="tooltip">
      <span className="session-preview-heading"><ProviderIcon thread={thread} size={13} /><strong>{threadTitle(thread)}</strong><SessionStateBadge state={state} /></span>
      <span><b>Task</b>{details.task}</span>
      {details.goal && <span><b>Goal</b>{details.goal}</span>}
      {details.outcome && <span className={details.lastError ? "preview-error" : ""}><b>{details.lastError ? "Last error" : "Outcome"}</b>{details.outcome}</span>}
      <span className="session-preview-meta"><Folder size={11} />{basename(thread.cwd)}{thread.gitInfo?.branch ? ` · ${thread.gitInfo.branch}` : ""} · {details.model} / {details.effort} · {activityTitle(details.lastActivityAt)}{thread.workspaceLease ? ` · ${thread.workspaceLease.mode} lease` : " · no active lease"}{details.queueDepth ? ` · ${details.queueDepth} queued` : ""}{details.artifactCount ? ` · ${details.artifactCount} artifacts` : ""}{details.unmetGateCount ? ` · ${details.unmetGateCount} gates unmet` : details.artifactStatus === "passed" ? " · gates passed" : ""}{details.errorCount ? ` · ${details.errorCount} errors` : ""}</span>
    </span>
  </article>;
});

export function Brand() {
  return <div className="brand"><div className="brand-mark"><span /><span /><span /></div><div><strong>ForgeDeck</strong><small>Command deck</small></div></div>;
}

function FacetSelect({ label, value, values, allLabel, allValue = "", format = (item) => item, onChange }: {
  label: string; value: string; values: InventoryFacet[]; allLabel: string; allValue?: string;
  format?: (value: string) => string; onChange: (value: string) => void;
}) {
  const options = value && value !== allValue && !values.some((facet) => facet.value === value)
    ? [{ value, count: 0 }, ...values]
    : values;
  return <label>{label}<select value={value} onChange={(event) => onChange(event.target.value)}><option value={allValue}>{allLabel}</option>{options.map((facet) => <option key={facet.value} value={facet.value} title={facet.value}>{format(facet.value)} ({facet.count})</option>)}</select></label>;
}

function activeFacetCount(filters: ThreadFilters): number {
  return (Object.keys(DEFAULT_THREAD_FILTERS) as Array<keyof ThreadFilters>)
    .filter((key) => filters[key] !== DEFAULT_THREAD_FILTERS[key]).length;
}

type ProviderUsageRowProps = { icon: ReactNode; provider: "codex" | "spark"; name: string; available: boolean; percent?: number | null };
function ProviderUsageRow({ icon, provider, name, available, percent = null }: ProviderUsageRowProps) {
  const roundedPercent = percent === null ? null : Math.round(percent);
  return <div className={`provider-usage-row provider-${provider} ${available ? "" : "unavailable"}`}><span className="provider-usage-icon">{icon}</span><strong>{name}</strong>{!available ? <span className="provider-usage-status">Unavailable</span> : <span className="provider-usage-meter"><span>{roundedPercent === null ? "—" : `${roundedPercent}%`}</span><progress max={100} value={roundedPercent ?? 0} aria-label={`${name} usage`} /></span>}</div>;
}

function UsageCard({ usage, backendStatus }: { usage: Usage | null; backendStatus?: Bootstrap["backendStatus"] }) {
  const legacyCodex = usage?.rateLimitsByLimitId?.codex || usage?.rateLimits;
  const clamp = (value?: number) => value === undefined ? null : Math.min(100, Math.max(0, value));
  return <section className="usage-card" aria-label="Provider usage"><div className="usage-top"><span><Gauge size={15} /> Usage</span></div><div className="provider-usage-list">
    <ProviderUsageRow icon={<Bot size={14} />} provider="codex" name="Codex" available={backendStatus?.codex.available ?? Boolean(legacyCodex?.primary)} percent={clamp(backendStatus?.codex.rateLimit?.primary?.usedPercent ?? legacyCodex?.primary?.usedPercent)} />
    <ProviderUsageRow icon={<Sparkles size={14} />} provider="spark" name="Spark" available={backendStatus?.spark.available ?? false} percent={clamp(backendStatus?.spark.rateLimit?.primary?.usedPercent)} />
  </div></section>;
}

function ProviderIcon({ thread, size }: { thread: Thread; size: number }) {
  return thread.sessionClass === "spark" ? <Sparkles size={size} color="var(--color-provider-spark)" /> : <Bot size={size} color="var(--color-provider-codex)" />;
}
function threadTitle(thread: Thread) { return thread.name || thread.preview || "Untitled session"; }
function basename(value: string) { return value.split("/").filter(Boolean).pop() || value; }
function initials(value: string) { return value.split(/[@.\s_-]/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "FD"; }
function guardianStatusText(thread: Thread): string | null {
  const state = thread.guardian;
  if (!state) return null;
  if (state.phase === "stalled") return "Stalled";
  if (state.phase === "retrying") return `Stalled — retrying (${state.recoveryAttempts}/${state.maxRecoveryAttempts})`;
  if (state.phase === "escalating") return `Escalating to ${state.actionModel || state.policy.escalationModel || "stronger model"}`;
  if (state.phase === "paused") return "Paused — operator notified";
  if (state.phase === "failed") return `Guardian failed${state.error ? ` — ${state.error}` : ""}`;
  return null;
}
function formatTokenCount(tokens: number) { return tokens < 1_000 ? String(tokens) : tokens < 1_000_000 ? `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k` : `${(tokens / 1_000_000).toFixed(1)}m`; }
