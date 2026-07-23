import { memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Activity, AlertTriangle, Bot, CheckCircle2, ChevronDown, ChevronRight, CircleStop,
  Clock3, Copy, Database, Gauge, LayoutGrid, ListPlus, LoaderCircle, MessageSquareText, Package, Pencil, Plus, RefreshCw, Send, Server,
  Sparkles, Target, Timer, Trash2, Users, Wifi, X
} from "lucide-react";
import { api } from "../../api/client";
import { useSwipeDismiss } from "../../hooks/use-swipe-dismiss";
import { readStoredString, writeStoredString } from "../../state/preferences";
import { normalizeThreadSettings, threadStore, useThreadDetail, useThreadLiveState } from "../../state/thread-store";
import { AutoFollowIndicator, CompactItem, ComposerAssist, executeComposerText, PolicyButton, RecoveryNotice, useActivityAnnouncement, useComposerAssist, useStickyBottom } from "../chat/Chat";
import { activityTitle, buildSessionCardDetails, relativeActivity, SessionStateBadge } from "../session-card/SessionCardDetails";
import type { ErrorEntry } from "../error-center/ErrorCenter";
import type { SessionOperation } from "../session-actions/SessionActionDialog";
import type {
  AgentBlueprintManifest, AgentSchedule, BlueprintVariableValue, Bootstrap, CodexModel,
  ScheduleTiming, SessionSettings, Thread, ThreadItem
} from "../../types";

export type BoardVariant = "control" | "spark";
type BoardDensity = "comfortable" | "compact";
type BoardSort = "board" | "name" | "state" | "activity" | "created";
type BoardGroup = "none" | "backend" | "model" | "state" | "workspace";
type ThreadSettings = Record<string, SessionSettings>;

const BOARD_STATE_ORDER = ["error", "waiting", "running", "queued", "idle", "done"] as const;

export type ControlCenterProps = {
  threads: readonly Thread[];
  allThreads: readonly Thread[];
  fleetThreads?: readonly Thread[];
  bootstrap?: Bootstrap;
  approvalCount?: number;
  showFleetSummary?: boolean;
  errors?: readonly ErrorEntry[];
  waitingThreadIds?: ReadonlySet<string>;
  models: CodexModel[];
  settings: ThreadSettings;
  defaultModel?: CodexModel;
  pollInterval: number;
  onSettings: (threadId: string, settings: SessionSettings) => void;
  onOpen: (threadId: string) => void;
  onRemove: (threadId: string) => void;
  onAdd: (threadId: string) => void;
  onClearCompleted: () => void;
  onVisibleThreadsChange: (threadIds: string[]) => void;
  onSessionAction: (operation: SessionOperation, threadIds: string[]) => void;
  onLaunch?: () => void;
  onRefresh: (threadId: string) => Promise<unknown>;
  onError: (error: unknown) => void;
};

export function BoardHeader({ variant, count, activeCount }: { variant: BoardVariant; count: number; activeCount: number }) {
  const spark = variant === "spark";
  return <div className="control-header"><div className={`control-header-icon ${spark ? "spark" : ""}`}>{spark ? <Sparkles size={18} /> : <LayoutGrid size={18} />}</div><div><strong>{spark ? "SparkBoard" : "Control Center"}</strong><span>{count} panel{count === 1 ? "" : "s"} <i>·</i> <b>{activeCount} running</b></span></div></div>;
}

export const ControlCenter = memo(function ControlCenter(props: ControlCenterProps) { return <SessionBoard {...props} variant="control" />; });
export const SparkBoard = memo(function SparkBoard(props: ControlCenterProps) { return <SessionBoard {...props} variant="spark" />; });

function SessionBoard({ variant, threads, allThreads, fleetThreads, bootstrap, approvalCount, showFleetSummary = true, errors, waitingThreadIds, models, settings, defaultModel, pollInterval, onSettings, onOpen, onRemove, onAdd, onClearCompleted, onVisibleThreadsChange, onSessionAction, onLaunch, onRefresh, onError }: ControlCenterProps & { variant: BoardVariant }) {
  const spark = variant === "spark";
  const containerRef = useRef<HTMLDivElement>(null);
  const [density, setDensity] = useState<BoardDensity>(() => readBoardPreference(variant, "density", ["comfortable", "compact"], "comfortable"));
  const [sortMode, setSortMode] = useState<BoardSort>(() => readBoardPreference(variant, "sort", ["board", "name", "state", "activity", "created"], "board"));
  const [groupMode, setGroupMode] = useState<BoardGroup>(() => readBoardPreference(variant, "group", ["none", "backend", "model", "state", "workspace"], "none"));
  const latestThreadsRef = useRef(threads);
  latestThreadsRef.current = threads;
  const [layoutOrder, setLayoutOrder] = useState(() => sortBoardThreads(threads, sortMode, []).map((thread) => thread.id));
  const appliedSortModeRef = useRef(sortMode);
  const [columns, setColumns] = useState(1);
  const [page, setPage] = useState(0);
  const threadIdsSignature = threads.map((thread) => thread.id).join("\u0000");
  useEffect(() => {
    const currentThreads = latestThreadsRef.current;
    const currentIds = new Set(currentThreads.map((thread) => thread.id));
    setLayoutOrder((current) => {
      if (appliedSortModeRef.current !== sortMode || current.length === 0) {
        return sortBoardThreads(currentThreads, sortMode, current).map((thread) => thread.id);
      }
      const surviving = current.filter((threadId) => currentIds.has(threadId));
      const known = new Set(surviving);
      const additions = sortBoardThreads(currentThreads.filter((thread) => !known.has(thread.id)), sortMode, current);
      const next = [...surviving, ...additions.map((thread) => thread.id)];
      return next.length === current.length && next.every((threadId, index) => threadId === current[index]) ? current : next;
    });
    appliedSortModeRef.current = sortMode;
  }, [sortMode, threadIdsSignature]);
  useEffect(() => writeStoredString(boardPreferenceKey(variant, "density"), density), [density, variant]);
  useEffect(() => writeStoredString(boardPreferenceKey(variant, "sort"), sortMode), [sortMode, variant]);
  useEffect(() => writeStoredString(boardPreferenceKey(variant, "group"), groupMode), [groupMode, variant]);

  const threadById = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);
  const orderedThreads = useMemo(() => {
    const ordered = layoutOrder.flatMap((threadId) => {
      const thread = threadById.get(threadId);
      return thread ? [thread] : [];
    });
    const known = new Set(layoutOrder);
    return [...ordered, ...sortBoardThreads(threads.filter((thread) => !known.has(thread.id)), sortMode, layoutOrder)];
  }, [layoutOrder, sortMode, threadById, threads]);
  const rowCount = density === "compact" ? 3 : 2;
  const pageSize = columns * rowCount;
  const totalPages = Math.max(1, Math.ceil(orderedThreads.length / pageSize));
  const pageThreads = useMemo(() => orderedThreads.slice(page * pageSize, page * pageSize + pageSize), [orderedThreads, page, pageSize]);
  const pageThreadIds = useMemo(() => pageThreads.map((thread) => thread.id), [pageThreads]);
  const pageGroups = useMemo(() => groupBoardThreads(pageThreads, groupMode, settings, waitingThreadIds, errors || []), [errors, groupMode, pageThreads, settings, waitingThreadIds]);
  const available = useMemo(() => allThreads.filter((thread) => thread.archiveState !== "archived" && !threads.some((visible) => visible.id === thread.id)), [allThreads, threads]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = (width: number) => {
      const minimumWidth = density === "compact" ? spark ? 170 : 240 : spark ? 210 : 300;
      const maximumColumns = density === "compact" ? spark ? 10 : 6 : spark ? 8 : 4;
      setColumns(Math.max(1, Math.min(maximumColumns, Math.floor(width / minimumWidth))));
    };
    update(element.clientWidth);
    const observer = new ResizeObserver((entries) => update(entries[0]?.contentRect.width || element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [density, spark]);
  useEffect(() => setPage((current) => Math.min(current, totalPages - 1)), [totalPages]);
  useEffect(() => {
    onVisibleThreadsChange(pageThreadIds);
    return () => onVisibleThreadsChange([]);
  }, [onVisibleThreadsChange, pageThreadIds]);

  const refreshPage = useCallback(async (signal?: AbortSignal) => {
    const ids = pageThreads.map((thread) => thread.id);
    if (!ids.length) return;
    const response = await api<{ results: Array<{ threadId: string; ok: boolean; value?: Thread }> }>("/api/threads/batch", { method: "POST", body: JSON.stringify({ operation: "read", threadIds: ids }), signal });
    for (const result of response.results) if (result.ok && result.value) threadStore.upsertDetail(result.value);
  }, [pageThreads]);
  useEffect(() => {
    const controller = new AbortController();
    void refreshPage(controller.signal).catch((error) => { if (error.name !== "AbortError") onError(error); });
    return () => controller.abort();
  }, [onError, refreshPage]);
  useEffect(() => {
    if (!pollInterval) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => void refreshPage(controller.signal).catch(() => undefined), pollInterval);
    return () => { clearInterval(timer); controller.abort(); };
  }, [pollInterval, refreshPage]);

  const completedCount = pageThreads.filter((thread) => threadStore.getLive(thread.id).completed).length;
  const renderCard = (thread: Thread) => <ControlCard key={thread.id} density={density} summary={thread} errors={errors || []} waiting={waitingThreadIds?.has(thread.id) || false} models={models} localSettings={settings[thread.id]} defaultModel={defaultModel} onSettings={onSettings} onOpen={onOpen} onRemove={onRemove} onSessionAction={onSessionAction} onRefresh={onRefresh} onError={onError} />;
  return <div className={`control-center density-${density}`} ref={containerRef}>
    {!spark && showFleetSummary && <FleetSummary threads={fleetThreads || threads} bootstrap={bootstrap} approvalCount={approvalCount || 0} errors={errors || []} onError={onError} />}
    {!spark && <SchedulePanel onError={onError} />}
    <div className="control-toolbar"><div><span className="live-beacon"><i /> LIVE</span><p>{spark ? "Fast parallel task lanes" : "Monitor and direct multiple sessions at once"}</p></div><div className="control-toolbar-actions">
      <div className="density-toggle" role="group" aria-label="Board density"><button className={density === "comfortable" ? "active" : ""} aria-pressed={density === "comfortable"} onClick={() => { setDensity("comfortable"); setPage(0); }}>Comfortable</button><button className={density === "compact" ? "active" : ""} aria-pressed={density === "compact"} onClick={() => { setDensity("compact"); setPage(0); }}>Compact</button></div>
      <label className="board-layout-select"><span>Sort</span><select aria-label="Sort board" value={sortMode} onChange={(event) => { setSortMode(event.target.value as BoardSort); setPage(0); }}><option value="board">Board order</option><option value="name">Name</option><option value="state">State</option><option value="activity">Last activity</option><option value="created">Creation date</option></select></label>
      <label className="board-layout-select"><span>Group</span><select aria-label="Group board" value={groupMode} onChange={(event) => { setGroupMode(event.target.value as BoardGroup); setPage(0); }}><option value="none">None</option><option value="backend">Backend</option><option value="model">Model</option><option value="state">State</option><option value="workspace">Workspace</option></select></label>
      <button className="clear-completed" disabled={!completedCount} onClick={onClearCompleted}><Trash2 size={13} />Clear{completedCount > 0 && <b>{completedCount}</b>}</button>
      {spark && onLaunch && <button className="clear-completed" onClick={onLaunch}><Sparkles size={13} /> Launch Spark</button>}
      <label className="add-panel"><Plus size={13} /><span className="sr-only">Add session to board from the current inventory facets</span><select defaultValue="" title="Sessions matching the current search and inventory facets" onChange={(event) => { if (event.target.value) { onAdd(event.target.value); event.target.value = ""; } }}><option value="" disabled>Add filtered session</option>{available.map((thread) => <option key={thread.id} value={thread.id}>{threadOptionLabel(thread)}</option>)}</select></label>
      <button className="icon-button" onClick={() => void refreshPage().catch(onError)} aria-label="Refresh board"><RefreshCw size={15} /></button>
    </div></div>
    {pageThreads.length ? groupMode === "none"
      ? <div className={`control-grid density-${density} columns-${Math.max(1, Math.min(columns, pageThreads.length))} rows-${Math.max(1, Math.ceil(pageThreads.length / columns))}`}>{pageThreads.map(renderCard)}</div>
      : <div className={`control-groups density-${density}`}>{pageGroups.map((group) => <section className="control-group" key={group.key}><header className="control-group-heading"><span title={group.title}>{group.label}</span><b>{group.threads.length}</b></header><div className={`control-grid group-grid density-${density} columns-${Math.max(1, Math.min(columns, group.threads.length))}`}>{group.threads.map(renderCard)}</div></section>)}</div>
      : <div className="control-empty"><h2>{spark ? "No Spark sessions on the board" : "No sessions on the board"}</h2><p>Add a session from the sidebar to monitor progress and send tasks here.</p></div>}
    {totalPages > 1 && <div className="control-pages"><button disabled={page === 0} onClick={() => setPage((value) => value - 1)}><ChevronRight className="previous-icon" size={13} />Previous</button><span>Page {page + 1} of {totalPages}</span><button disabled={page >= totalPages - 1} onClick={() => setPage((value) => value + 1)}>Next<ChevronRight size={13} /></button></div>}
  </div>;
}

function boardPreferenceKey(variant: BoardVariant, field: "density" | "sort" | "group"): string {
  return `forgedeck-${variant}-board-${field}`;
}

function readBoardPreference<T extends string>(variant: BoardVariant, field: "density" | "sort" | "group", values: readonly T[], fallback: T): T {
  const stored = readStoredString(boardPreferenceKey(variant, field));
  return stored && values.includes(stored as T) ? stored as T : fallback;
}

function sortBoardThreads(threads: readonly Thread[], mode: BoardSort, stableOrder: readonly string[]): Thread[] {
  if (mode === "board") return [...threads];
  const ranks = new Map(stableOrder.map((threadId, index) => [threadId, index]));
  const fallbackRank = stableOrder.length;
  return threads.map((thread, index) => ({ thread, index })).sort((left, right) => {
    let comparison = 0;
    if (mode === "name") comparison = threadTitle(left.thread).localeCompare(threadTitle(right.thread), undefined, { numeric: true, sensitivity: "base" });
    if (mode === "state") comparison = boardStateRank(boardThreadState(left.thread)) - boardStateRank(boardThreadState(right.thread));
    if (mode === "activity") comparison = boardActivityAt(right.thread) - boardActivityAt(left.thread);
    if (mode === "created") comparison = timestampValue(right.thread.createdAt) - timestampValue(left.thread.createdAt);
    if (comparison) return comparison;
    const leftRank = ranks.get(left.thread.id) ?? fallbackRank + left.index;
    const rightRank = ranks.get(right.thread.id) ?? fallbackRank + right.index;
    return leftRank - rightRank || left.thread.id.localeCompare(right.thread.id);
  }).map(({ thread }) => thread);
}

function boardActivityAt(thread: Thread): number {
  return buildSessionCardDetails(thread).lastActivityAt;
}

function timestampValue(value: string | number): number {
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function boardThreadState(thread: Thread, waiting = false, errors: readonly ErrorEntry[] = []) {
  const live = threadStore.getLive(thread.id);
  return buildSessionCardDetails(thread, {
    completed: live.completed,
    completedAt: live.completedAt,
    queueDepth: Math.max(live.queue.length, thread.queueDepth || 0),
    waiting,
    errors
  }).state;
}

function boardStateRank(state: ReturnType<typeof boardThreadState>): number {
  const rank = BOARD_STATE_ORDER.indexOf(state);
  return rank < 0 ? BOARD_STATE_ORDER.length : rank;
}

function groupBoardThreads(threads: readonly Thread[], mode: BoardGroup, settings: ThreadSettings, waitingThreadIds: ReadonlySet<string> | undefined, errors: readonly ErrorEntry[]) {
  const groups = new Map<string, { key: string; label: string; title: string; threads: Thread[]; rank: number }>();
  for (const thread of threads) {
    let key = "all";
    let label = "All sessions";
    let title = label;
    let rank = 0;
    if (mode === "backend") {
      key = thread.backend;
      label = providerLabel(thread);
      title = `${label} backend`;
    } else if (mode === "model") {
      key = settings[thread.id]?.model || thread.model || "unassigned";
      label = key === "unassigned" ? "No model" : key;
      title = label;
    } else if (mode === "state") {
      const state = boardThreadState(thread, waitingThreadIds?.has(thread.id) || false, errors);
      key = state;
      label = state[0].toUpperCase() + state.slice(1);
      title = `${label} sessions`;
      rank = boardStateRank(state);
    } else if (mode === "workspace") {
      key = thread.cwd || "unassigned";
      label = thread.cwd ? basename(thread.cwd) : "No workspace";
      title = thread.cwd || label;
    }
    const group = groups.get(key);
    if (group) group.threads.push(thread);
    else groups.set(key, { key, label, title, threads: [thread], rank });
  }
  return [...groups.values()].sort((left, right) => mode === "state" ? left.rank - right.rank : left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: "base" }));
}

type ScheduleFormTiming = "once" | "interval" | "cron";

function SchedulePanel({ onError }: { onError: (error: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [schedules, setSchedules] = useState<AgentSchedule[]>([]);
  const [blueprints, setBlueprints] = useState<AgentBlueprintManifest[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [blueprintId, setBlueprintId] = useState("");
  const [blueprintVersion, setBlueprintVersion] = useState<number | null>(null);
  const [workspace, setWorkspace] = useState("");
  const [timingType, setTimingType] = useState<ScheduleFormTiming>("interval");
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [cronExpression, setCronExpression] = useState("0 9 * * 1-5");
  const [runAt, setRunAt] = useState(() => localDateTimeValue(Date.now() + 60 * 60_000));
  const [variables, setVariables] = useState<Record<string, BlueprintVariableValue>>({});
  const selectedBlueprint = useMemo(
    () => blueprints.find((blueprint) => blueprint.id === blueprintId) || null,
    [blueprintId, blueprints]
  );

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const [scheduleResponse, blueprintResponse] = await Promise.all([
      api<{ data: AgentSchedule[] }>("/api/schedules?historyLimit=10", { signal }),
      api<{ data: AgentBlueprintManifest[] }>("/api/blueprints?limit=200", { signal })
    ]);
    setSchedules(scheduleResponse.data);
    setBlueprints(blueprintResponse.data);
    setBlueprintId((current) => current || blueprintResponse.data[0]?.id || "");
    setBlueprintVersion((current) => current || blueprintResponse.data[0]?.version || null);
    setLoading(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch((error) => {
      if (error.name !== "AbortError") { setLoading(false); onError(error); }
    });
    const timer = window.setInterval(() => void refresh(controller.signal).catch(() => undefined), 60_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [onError, refresh]);

  const clearForm = useCallback(() => {
    setEditingId(null);
    setName("");
    setWorkspace("");
    setTimingType("interval");
    setIntervalMinutes(60);
    setCronExpression("0 9 * * 1-5");
    setRunAt(localDateTimeValue(Date.now() + 60 * 60_000));
    setVariables({});
  }, []);

  const chooseBlueprint = (id: string) => {
    setBlueprintId(id);
    const blueprint = blueprints.find((candidate) => candidate.id === id);
    setBlueprintVersion(blueprint?.version || null);
    setVariables(Object.fromEntries((blueprint?.definition.variables || [])
      .filter((variable) => !variable.secret && variable.default !== undefined)
      .map((variable) => [variable.name, variable.default!])));
  };

  const updateVariable = (variableName: string, value: BlueprintVariableValue | undefined) => {
    setVariables((current) => {
      const next = { ...current };
      if (value === undefined) delete next[variableName];
      else next[variableName] = value;
      return next;
    });
  };

  const beginCreate = () => {
    clearForm();
    const id = blueprints[0]?.id || "";
    chooseBlueprint(id);
    setFormOpen(true);
  };

  const beginEdit = (schedule: AgentSchedule) => {
    setEditingId(schedule.id);
    setName(schedule.name);
    setBlueprintId(schedule.blueprintId);
    setBlueprintVersion(schedule.blueprintVersion);
    setWorkspace(schedule.workspace || "");
    setVariables(schedule.variables);
    setTimingType(schedule.timing.type);
    if (schedule.timing.type === "interval") setIntervalMinutes(schedule.timing.intervalMs / 60_000);
    if (schedule.timing.type === "cron") setCronExpression(schedule.timing.expression);
    if (schedule.timing.type === "once") {
      setRunAt(localDateTimeValue(Math.max(Date.parse(schedule.timing.runAt), Date.now() + 60_000)));
    }
    setFormOpen(true);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!blueprintId || saving) return;
    setSaving(true);
    try {
      let timing: ScheduleTiming;
      if (timingType === "interval") timing = { type: "interval", intervalMs: Math.round(intervalMinutes * 60_000) };
      else if (timingType === "cron") timing = { type: "cron", expression: cronExpression.trim() };
      else timing = { type: "once", runAt: new Date(runAt).toISOString() };
      const body = JSON.stringify({
        ...(name.trim() ? { name: name.trim() } : {}),
        blueprintId,
        blueprintVersion,
        variables,
        workspace: workspace.trim() || null,
        timing
      });
      await api(editingId ? `/api/schedules/${editingId}` : "/api/schedules", {
        method: editingId ? "PUT" : "POST",
        body
      });
      await refresh();
      clearForm();
      setFormOpen(false);
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  };

  const removeSchedule = async (schedule: AgentSchedule) => {
    if (!window.confirm(`Delete schedule “${schedule.name}”? Its run history will also be removed.`)) return;
    try {
      await api(`/api/schedules/${schedule.id}`, { method: "DELETE" });
      if (editingId === schedule.id) { clearForm(); setFormOpen(false); }
      await refresh();
    } catch (error) {
      onError(error);
    }
  };

  return <section className={`schedule-panel ${open ? "open" : ""}`}>
    <header><button className="schedule-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}><Timer size={15} /><span><strong>Scheduled runs</strong><small>{loading ? "Loading…" : `${schedules.length} configured`}</small></span><ChevronDown size={14} /></button>{open && <button className="schedule-add" onClick={beginCreate} disabled={!blueprints.length}><Plus size={13} />New schedule</button>}</header>
    {open && <div className="schedule-body">
      {formOpen && <form className="schedule-form" onSubmit={submit}>
        <div className="schedule-form-heading"><strong>{editingId ? "Edit schedule" : "Create schedule"}</strong><button type="button" onClick={() => { clearForm(); setFormOpen(false); }} aria-label="Close schedule form"><X size={14} /></button></div>
        <label><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={selectedBlueprint ? `${selectedBlueprint.name} schedule` : "Schedule name"} maxLength={100} /></label>
        <label><span>Blueprint</span><select value={blueprintId} onChange={(event) => chooseBlueprint(event.target.value)} required><option value="" disabled>Select a blueprint</option>{blueprints.map((blueprint) => <option key={blueprint.id} value={blueprint.id}>{blueprint.name} · v{blueprint.version}</option>)}</select></label>
        <label><span>Timing</span><select value={timingType} onChange={(event) => setTimingType(event.target.value as ScheduleFormTiming)}><option value="once">One shot</option><option value="interval">Interval</option><option value="cron">Cron</option></select></label>
        {timingType === "once" && <label><span>Run at</span><input type="datetime-local" value={runAt} min={localDateTimeValue(Date.now())} onChange={(event) => setRunAt(event.target.value)} required /></label>}
        {timingType === "interval" && <label><span>Every (minutes)</span><input type="number" min={1} max={525_600} step={1} value={intervalMinutes} onChange={(event) => setIntervalMinutes(Number(event.target.value))} required /></label>}
        {timingType === "cron" && <label><span>Cron expression</span><input className="mono" value={cronExpression} onChange={(event) => setCronExpression(event.target.value)} placeholder="0 9 * * 1-5" required /></label>}
        {selectedBlueprint?.definition.workspace.selector === "current" && <label className="schedule-wide"><span>Workspace</span><input value={workspace} onChange={(event) => setWorkspace(event.target.value)} placeholder="/absolute/path/to/workspace" required /></label>}
        {(selectedBlueprint?.definition.variables || []).filter((variable) => !variable.secret).map((variable) => <label key={variable.name}><span>{variable.name}{variable.required ? " *" : ""}</span>{variable.type === "boolean" ? <select value={String(variables[variable.name] ?? variable.default ?? false)} onChange={(event) => updateVariable(variable.name, event.target.value === "true")}><option value="false">False</option><option value="true">True</option></select> : <input type={variable.type === "number" ? "number" : "text"} value={String(variables[variable.name] ?? "")} required={variable.required && variable.default === undefined} onChange={(event) => updateVariable(variable.name, event.target.value === "" ? undefined : variable.type === "number" ? Number(event.target.value) : event.target.value)} placeholder={variable.description || variable.name} />}</label>)}
        <div className="schedule-form-actions"><button type="button" onClick={() => { clearForm(); setFormOpen(false); }}>Cancel</button><button type="submit" disabled={saving || !blueprintId}>{saving ? <LoaderCircle className="spin" size={13} /> : null}{editingId ? "Save changes" : "Create schedule"}</button></div>
      </form>}
      {!loading && !schedules.length && !formOpen && <div className="schedule-empty"><Timer size={20} /><span>No scheduled runs yet. Create one from an agent blueprint.</span></div>}
      <div className="schedule-list">{schedules.map((schedule) => <article key={schedule.id} className="schedule-card"><div className="schedule-card-main"><span className={`schedule-state ${schedule.nextRunAt ? "active" : "done"}`}><Timer size={13} /></span><span><strong>{schedule.name}</strong><small>{formatScheduleTiming(schedule.timing)} · {schedule.nextRunAt ? `next ${formatScheduleDate(schedule.nextRunAt)}` : "no future run"}</small></span></div><div className="schedule-card-actions"><button onClick={() => beginEdit(schedule)} aria-label={`Edit ${schedule.name}`}><Pencil size={13} /></button><button onClick={() => void removeSchedule(schedule)} aria-label={`Delete ${schedule.name}`}><Trash2 size={13} /></button></div>{schedule.recentRuns.length > 0 && <details><summary>Recent runs <b>{schedule.recentRuns.length}</b></summary><div>{schedule.recentRuns.map((run) => <p key={run.id} className={run.status}><i /> <span><strong>{run.status}</strong><time dateTime={run.startedAt}>{formatScheduleDate(run.startedAt)}</time>{run.threadId && <code>{run.threadId.slice(0, 12)}</code>}</span>{run.error && <small title={run.error}>{run.error}</small>}</p>)}</div></details>}</article>)}</div>
    </div>}
  </section>;
}

function localDateTimeValue(timestamp: number): string {
  const date = new Date(timestamp);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(timestamp - offset).toISOString().slice(0, 16);
}

function formatScheduleDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "unknown";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

function formatScheduleTiming(timing: ScheduleTiming): string {
  if (timing.type === "once") return "One shot";
  if (timing.type === "cron") return `Cron ${timing.expression}`;
  const minutes = timing.intervalMs / 60_000;
  if (minutes % 1_440 === 0) return `Every ${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `Every ${minutes / 60}h`;
  return `Every ${minutes}m`;
}

type CapacityBackend = "codex/standard" | "codex/spark";
type CapacityMetric = { limit: number; activeCount: number; waitingCount: number };
type PerformanceReport = {
  codex: {
    reconnectAttempts: number;
    pendingRpcCalls: number;
    lastHeartbeatAt: number | null;
  };
  capacity: Record<CapacityBackend, CapacityMetric>;
  operations: {
    reads: { activeCount: number; waitingCount: number; saturated: boolean };
    mutations: { activeCount: number; waitingCount: number; saturated: boolean };
  };
  sampledAt: number;
};
type HealthReport = {
  status: "ok" | "degraded";
  timestamp: string;
  uptimeSeconds: number;
  subsystems: {
    codex: { available: boolean; state: string; lastHeartbeatAt: number | null };
    storage: Bootstrap["health"]["storage"];
    sessions: { active: number; queuedMessages: number };
    events: { status: string; clients: number };
  };
};

export function FleetSummary({ threads, bootstrap, approvalCount, errors, compact = false, onError }: {
  threads: readonly Thread[];
  bootstrap?: Bootstrap;
  approvalCount: number;
  errors: readonly ErrorEntry[];
  compact?: boolean;
  onError: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [performance, setPerformance] = useState<PerformanceReport | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const mounted = useRef(true);
  const refreshStatus = useCallback(async (signal?: AbortSignal) => {
    setRefreshing(true);
    const results = await Promise.allSettled([
      readHealth(signal),
      api<PerformanceReport>("/api/diagnostics/performance", { signal })
    ]);
    if (!mounted.current || signal?.aborted) return;
    const [healthResult, performanceResult] = results;
    if (healthResult.status === "fulfilled") setHealth(healthResult.value);
    if (performanceResult.status === "fulfilled") setPerformance(performanceResult.value);
    const failed = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
    setStatusError(failed.length === results.length ? "Status details are temporarily unavailable" : null);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void refreshStatus(controller.signal);
    const timer = window.setInterval(() => void refreshStatus(controller.signal), 15_000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      controller.abort();
    };
  }, [refreshStatus]);
  useEffect(() => {
    if (open) void refreshStatus();
  }, [open, refreshStatus]);

  const counts = useMemo(() => fleetCounts(threads, approvalCount, health), [approvalCount, health, threads]);
  const capacities = useMemo(() => capacityRows(performance, bootstrap), [bootstrap, performance]);
  const runtimeAvailable = health?.subsystems.codex.available ?? recordBoolean(bootstrap?.health.runtime, "available");
  const storage = health?.subsystems.storage || bootstrap?.health.storage;
  const operationPressure = Boolean(performance?.operations.reads.saturated || performance?.operations.mutations.saturated);
  const rootIssue = runtimeAvailable === false || storage?.status === "error";
  const needsAttention = rootIssue || counts.error > 0 || approvalCount > 0 || operationPressure;
  const recentFailures = errors.slice(0, 5);
  const sessionCount = threads.filter((thread) => thread.archiveState !== "archived").length;
  const errorCount = Math.max(counts.error, errors.reduce((total, entry) => total + entry.count, 0));
  const capacityActive = capacities.reduce((total, row) => total + row.active, 0);
  const knownCapacity = capacities.every((row) => row.limit !== null)
    ? capacities.reduce((total, row) => total + (row.limit || 0), 0)
    : null;

  const copyDiagnostics = async () => {
    const payload = {
      generatedAt: new Date().toISOString(),
      server: bootstrap ? { name: bootstrap.server.name, version: bootstrap.version } : undefined,
      fleet: counts,
      capacity: Object.fromEntries(capacities.map((row) => [row.key, {
        active: row.active,
        limit: row.limit,
        waiting: row.waiting
      }])),
      status: {
        health: health?.status || bootstrap?.health.status || "unknown",
        uptimeSeconds: health?.uptimeSeconds ?? null,
        runtimeAvailable: runtimeAvailable ?? null,
        lastHeartbeatAt: performance?.codex.lastHeartbeatAt ?? health?.subsystems.codex.lastHeartbeatAt ?? null,
        reconnectCount: performance?.codex.reconnectAttempts ?? null,
        pendingRpcs: performance?.codex.pendingRpcCalls ?? null,
        activeSseClients: health?.subsystems.events.clients ?? null,
        storage: storage ? {
          engine: storage.engine || "sqlite",
          status: storage.status,
          writable: storage.writable,
          revision: storage.revision ?? null,
          backupRevision: storage.backupRevision ?? null,
          recoverySource: storage.recoverySource ?? null
        } : null
      },
      recentFailures: recentFailures.map((entry) => ({
        type: entry.type,
        code: entry.code,
        scope: entry.scope,
        occurrences: entry.count,
        lastOccurredAt: new Date(entry.lastOccurredAt).toISOString(),
        message: redactDiagnosticText(entry.message)
      }))
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch (error) {
      onError(error);
    }
  };

  const drawerSwipeDismiss = useSwipeDismiss<HTMLElement>(() => setOpen(false), { direction: "right", enabled: open });

  return <>
    <section className={`fleet-summary ${compact ? "compact" : ""} ${rootIssue ? "critical" : needsAttention ? "attention" : "healthy"}`} aria-label={compact ? "Mobile fleet summary" : "Fleet status summary"}>
      <button className="fleet-summary-toggle" onClick={() => setOpen(true)} aria-expanded={open} aria-controls={open ? "fleet-status-drawer" : undefined}>
        {compact ? <span className="mobile-fleet-stats">
          <MobileFleetStat icon={<Activity size={13} />} label="All" value={sessionCount} />
          <MobileFleetStat label="Run" value={counts.running} tone="running" />
          <MobileFleetStat icon={<AlertTriangle size={13} />} label="Err" value={errorCount} tone={errorCount ? "error" : ""} />
          <MobileFleetStat icon={<Gauge size={13} />} label="Cap" value={knownCapacity === null ? `${capacityActive}` : `${capacityActive}/${knownCapacity}`} tone={knownCapacity !== null && capacityActive >= knownCapacity ? "error" : ""} />
        </span> : <>
          <span className="fleet-overall"><Activity size={14} /><strong>{rootIssue ? "Service issue" : needsAttention ? "Attention" : "Fleet steady"}</strong></span>
          <span className="fleet-counts">
            <FleetCount label="Run" value={counts.running} tone="running" />
            <FleetCount label="Queue" value={counts.queued} tone="queued" />
            <FleetCount label="Wait" value={counts.waiting} tone="waiting" />
            <FleetCount label="Err" value={counts.error} tone={counts.error ? "error" : "waiting"} />
            <FleetCount label="OK?" value={counts.approval} tone={counts.approval ? "approval" : "waiting"} />
          </span>
          <span className="fleet-capacity">{capacities.map((row) => <span key={row.key} title={`${row.label}: ${row.active} active, ${row.waiting} waiting, ${row.limit ?? "unknown"} capacity`}><b>{row.label}</b><em>{row.limit === null ? `${row.active} active` : `${row.active}/${row.limit}`}{row.waiting > 0 ? ` +${row.waiting}` : ""}</em></span>)}</span>
        </>}
        <ChevronDown className="fleet-expand-icon" size={15} />
      </button>
    </section>
    {open && <><button className="fleet-drawer-scrim" onClick={() => setOpen(false)} aria-label="Close fleet status" /><aside {...drawerSwipeDismiss} className="fleet-drawer swipe-dismiss-right" id="fleet-status-drawer" aria-label="Fleet status details">
      <header><div><Activity size={18} /><span><strong>Fleet status</strong><small>{health ? `Updated ${formatAge(Date.parse(health.timestamp))}` : "Collecting server diagnostics"}</small></span></div><div><button onClick={() => void refreshStatus()} aria-label="Refresh fleet status"><RefreshCw className={refreshing ? "spin" : ""} size={15} /></button><button onClick={() => setOpen(false)} aria-label="Close fleet status"><X size={17} /></button></div></header>
      <div className="fleet-drawer-body">
        <section className={`fleet-condition ${rootIssue ? "critical" : needsAttention ? "attention" : "healthy"}`}>
          {rootIssue ? <AlertTriangle size={19} /> : <CheckCircle2 size={19} />}
          <div><strong>{rootIssue ? "Operator action recommended" : needsAttention ? "Fleet is operating with follow-up items" : "All monitored systems are operational"}</strong><span>{conditionSummary({ runtimeAvailable, storage, approvalCount, errorCount: counts.error, operationPressure })}</span></div>
        </section>
        {statusError && <p className="fleet-status-error">{statusError}</p>}
        <section className="fleet-detail-section"><h3>Server</h3><dl className="fleet-status-grid">
          <StatusDatum icon={<Server size={14} />} label="Uptime" value={health ? formatDuration(health.uptimeSeconds) : "—"} />
          <StatusDatum icon={<Wifi size={14} />} label="Heartbeat" value={formatHeartbeat(performance?.codex.lastHeartbeatAt ?? health?.subsystems.codex.lastHeartbeatAt)} />
          <StatusDatum icon={<RefreshCw size={14} />} label="Reconnect count" value={numberOrDash(performance?.codex.reconnectAttempts)} />
          <StatusDatum icon={<Activity size={14} />} label="Pending RPCs" value={numberOrDash(performance?.codex.pendingRpcCalls)} tone={(performance?.codex.pendingRpcCalls || 0) > 0 ? "notice" : undefined} />
          <StatusDatum icon={<Users size={14} />} label="Active SSE clients" value={numberOrDash(health?.subsystems.events.clients)} />
          <StatusDatum icon={<Database size={14} />} label="SQLite status" value={storage ? `${storage.status === "ok" ? "Healthy" : "Unavailable"}${storage.writable ? " · writable" : ""}` : "—"} tone={storage?.status === "error" ? "error" : undefined} />
        </dl></section>
        <section className="fleet-detail-section"><h3>Backend capacity</h3><div className="fleet-capacity-list">{capacities.map((row) => {
          const percent = row.limit ? Math.min(100, (row.active / row.limit) * 100) : 0;
          return <article key={row.key}><div><strong>{row.label}</strong><span>{row.limit === null ? `${row.active} active` : `${row.active} of ${row.limit} active`}{row.waiting ? ` · ${row.waiting} waiting` : ""}</span></div><div className="capacity-track"><i style={{ width: `${percent}%` }} /></div></article>;
        })}</div></section>
        <section className="fleet-detail-section"><h3>Recent failures <span>{recentFailures.length}/5</span></h3>{recentFailures.length ? <div className="fleet-failures">{recentFailures.map((entry) => <article key={entry.id}><div><strong>{entry.code}</strong>{entry.count > 1 && <b>×{entry.count}</b>}<time dateTime={new Date(entry.lastOccurredAt).toISOString()}>{formatAge(entry.lastOccurredAt)}</time></div><p>{redactDiagnosticText(entry.message)}</p><small>{entry.scope}</small></article>)}</div> : <div className="fleet-no-failures"><CheckCircle2 size={17} />No recent failures recorded</div>}</section>
      </div>
      <footer><span><Database size={13} />Secrets and identifiers are excluded</span><button onClick={() => void copyDiagnostics()}><Copy size={14} />{copied ? "Copied" : "Copy diagnostics"}</button></footer>
    </aside></>}
  </>;
}

function FleetCount({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <span className={`fleet-count ${tone}`}><b>{value}</b><em>{label}</em></span>;
}

function MobileFleetStat({ icon, label, value, tone = "" }: { icon?: ReactNode; label: string; value: number | string; tone?: string }) {
  return <span className={`mobile-fleet-stat ${tone}`}>{icon}<span><b>{value}</b><em>{label}</em></span></span>;
}

function StatusDatum({ icon, label, value, tone }: { icon: ReactNode; label: string; value: string; tone?: string }) {
  return <div className={tone || ""}><dt>{icon}<span>{label}</span></dt><dd>{value}</dd></div>;
}

function fleetCounts(threads: readonly Thread[], approval: number, health: HealthReport | null) {
  const activeThreads = threads.filter((thread) => thread.archiveState !== "archived");
  const running = activeThreads.filter(isThreadRunning).length;
  const error = activeThreads.filter(isThreadFailure).length;
  const queuedFromThreads = activeThreads.reduce((total, thread) => total + (thread.queueDepth || 0), 0);
  const waiting = activeThreads.filter((thread) => !isThreadRunning(thread) && !isThreadFailure(thread) && !(thread.queueDepth || 0)).length;
  return {
    running,
    queued: health?.subsystems.sessions.queuedMessages ?? queuedFromThreads,
    waiting,
    error,
    approval
  };
}

function isThreadRunning(thread: Thread): boolean {
  return thread.status.type === "active" || thread.turns.some((turn) => turn.status === "inProgress");
}

function isThreadFailure(thread: Thread): boolean {
  if (thread.status.type === "systemError" || thread.turns.at(-1)?.status === "failed") return true;
  return Boolean(thread.goal && ["blocked", "usageLimited", "budgetLimited"].includes(thread.goal.status));
}

function capacityRows(performance?: PerformanceReport | null, bootstrap?: Bootstrap) {
  const labels: Array<{ key: CapacityBackend; label: string; fallback: "codex" | "spark" }> = [
    { key: "codex/standard", label: "Codex", fallback: "codex" },
    { key: "codex/spark", label: "Spark", fallback: "spark" }
  ];
  return labels.map(({ key, label, fallback }) => {
    const metric = performance?.capacity[key];
    const active = metric?.activeCount ?? bootstrap?.backendStatus?.[fallback].activeCount ?? 0;
    return { key, label, active, limit: metric?.limit ?? null, waiting: metric?.waitingCount ?? 0 };
  });
}

async function readHealth(signal?: AbortSignal): Promise<HealthReport> {
  const response = await fetch("/api/health", { signal, headers: { Accept: "application/json" } });
  const payload = await response.json() as HealthReport;
  if (!payload || typeof payload !== "object" || !payload.subsystems) throw new Error("Invalid health response");
  return payload;
}

function conditionSummary({ runtimeAvailable, storage, approvalCount, errorCount, operationPressure }: {
  runtimeAvailable: boolean | undefined;
  storage: Bootstrap["health"]["storage"] | undefined;
  approvalCount: number;
  errorCount: number;
  operationPressure: boolean;
}): string {
  const conditions: string[] = [];
  if (runtimeAvailable === false) conditions.push("Codex runtime is unavailable");
  if (storage?.status === "error") conditions.push("SQLite storage needs attention");
  if (runtimeAvailable !== false && errorCount) conditions.push(`${errorCount} session${errorCount === 1 ? "" : "s"} need review`);
  if (approvalCount) conditions.push(`${approvalCount} approval${approvalCount === 1 ? "" : "s"} waiting`);
  if (operationPressure) conditions.push("request capacity is under pressure");
  return conditions.length ? conditions.join(" · ") : "No operator action is needed.";
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatHeartbeat(timestamp: number | null | undefined): string {
  return timestamp ? formatAge(timestamp) : "Not reported";
}

function formatAge(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3_600)}h ago`;
}

function numberOrDash(value: number | null | undefined): string {
  return typeof value === "number" ? value.toLocaleString() : "—";
}

function recordBoolean(value: Record<string, unknown> | undefined, key: string): boolean | undefined {
  return typeof value?.[key] === "boolean" ? value[key] : undefined;
}

function redactDiagnosticText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[opsu]_[A-Za-z0-9_]{12,})\b/g, "[REDACTED_TOKEN]")
    .replace(/(\b(?:token|password|passphrase|secret|authorization|api[_-]?key)\b\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\/(?:home|Users)\/[^/\s]+/g, "/[USER]");
}

type ControlCardProps = {
  density: BoardDensity; summary: Thread; errors: readonly ErrorEntry[]; waiting: boolean; models: CodexModel[]; localSettings?: SessionSettings; defaultModel?: CodexModel;
  onSettings: (threadId: string, settings: SessionSettings) => void; onOpen: (threadId: string) => void; onRemove: (threadId: string) => void;
  onSessionAction: (operation: SessionOperation, threadIds: string[]) => void;
  onRefresh: (threadId: string) => Promise<unknown>; onError: (error: unknown) => void;
};

const ControlCard = memo(function ControlCard({ density, summary, errors, waiting, models, localSettings, defaultModel, onSettings, onOpen, onRemove, onSessionAction, onRefresh, onError }: ControlCardProps) {
  const detail = useThreadDetail(summary.id);
  const live = useThreadLiveState(summary.id);
  const thread = detail || summary;
  const settings = normalizeThreadSettings(thread, models, localSettings, defaultModel);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const assist = useComposerAssist(text, setText, thread.cwd);
  const effectiveStatus = live.status || thread.status;
  const running = effectiveStatus.type === "active" || thread.turns.some((turn) => turn.status === "inProgress");
  const activityAnnouncement = useActivityAnnouncement(running, threadTitle(thread));
  const effectiveThread = effectiveStatus === thread.status ? thread : { ...thread, status: effectiveStatus };
  const details = buildSessionCardDetails(effectiveThread, { completed: live.completed, completedAt: live.completedAt, queueDepth: Math.max(live.queue.length, thread.queueDepth || 0), waiting, errors });
  const state = details.state;
  const history = useMemo(() => thread.turns.flatMap((turn) => turn.items), [thread.turns]);
  const historyIds = useMemo(() => new Set(history.map((item) => item.id).filter(Boolean)), [history]);
  const allItems = useMemo(() => [...history, ...Object.values(live.items).filter((item) => !item.id || !historyIds.has(item.id))], [history, historyIds, live.items]);
  const streaming = useMemo(() => Object.entries(live.agentText).filter(([id]) => !historyIds.has(id)), [historyIds, live.agentText]);
  const contentVersion = useMemo(() => ({ items: allItems, toolOutput: live.toolOutput, streaming }), [allItems, live.toolOutput, streaming]);
  const autoFollow = useStickyBottom<HTMLDivElement>(contentVersion);
  const items = usePausedRecentItems(allItems, autoFollow.isFollowing, density === "compact" ? 6 : 12);
  const tokens = live.tokenUsage?.totalTokens ?? thread.goal?.tokensUsed ?? null;
  const selectedModel = models.find((model) => model.model === settings.model);
  const efforts = thread.sessionClass === "spark" ? ["high"] : selectedModel?.supportedReasoningEfforts.map((option) => option.reasoningEffort) || [];
  const valid = Boolean(settings.model && efforts.includes(settings.effort));
  const guardianStatus = guardianStatusText(thread);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || sending || !valid) return;
    const outgoing = text.trim();
    setText(""); setSending(true);
    try {
      const result = await executeComposerText(thread, outgoing, settings, running);
      if (!result.sent) { setText(result.replacement); return; }
      await onRefresh(thread.id);
    } catch (error) { setText(outgoing); onError(error); } finally { setSending(false); }
  };

  return <article className={`control-card density-${density} state-${state}`}>
    <span className="sr-only" role="status" aria-atomic="true">{activityAnnouncement}</span>
    <header><button className="control-title" onClick={() => onOpen(thread.id)}><span><strong><ProviderIcon thread={thread} /><span title={threadTitle(thread)}>{threadTitle(thread)}</span><SessionStateBadge state={state} /></strong><small title={`${settings.model} · ${settings.effort} reasoning · ${thread.cwd}`}>{settings.model} · {settings.effort} · {basename(thread.cwd)}</small></span></button><span className="control-card-actions">{running && <LoaderCircle className="spin" size={13} />}<PolicyButton compact thread={thread} running={running} onRefresh={() => onRefresh(thread.id)} onError={onError} /><button onClick={() => onRemove(thread.id)} aria-label={`Remove ${threadTitle(thread)} from board`}><X size={14} /></button></span></header>
    <div className="control-task" title={details.task}><MessageSquareText size={11} /><span>{details.task}</span></div>
    {thread.goal && <button type="button" className={`control-goal ${thread.goal.status}`} onClick={() => onOpen(thread.id)} title={thread.goal.objective}><Target size={11} /><span>{thread.goal.objective}</span><em>{thread.goal.status}</em></button>}
    {thread.policyWarnings?.length ? <div className="control-policy-warning" title={thread.policyWarnings.join("\n")}><AlertTriangle size={11} /><span>{thread.policyWarnings[0]}</span></div> : null}
    {details.lastError ? <div className="control-outcome error" title={details.lastError}><AlertTriangle size={11} /><b>{details.errorCount || 1}</b><span>{details.lastError}</span></div>
      : details.artifactStatus === "pending" ? <div className="control-outcome gates" title={thread.artifactStatus?.unmetGates.map((gate) => `${gate.name}: ${gate.reason}`).join("\n")}><Package size={11} /><span>{details.unmetGateCount} required completion gate{details.unmetGateCount === 1 ? "" : "s"} unmet</span></div>
        : state === "done" && details.outcome ? <div className="control-outcome" title={details.outcome}><CheckCircle2 size={11} /><span>{details.outcome}</span></div> : null}
    <div className="control-metrics"><span className="activity" title={`Last activity: ${activityTitle(details.lastActivityAt)}`}><Clock3 size={10} />{relativeActivity(details.lastActivityAt)}</span>{details.queueDepth > 0 && <span className="queued" title={`${details.queueDepth} queued message${details.queueDepth === 1 ? "" : "s"}`}><ListPlus size={10} />{density === "compact" ? details.queueDepth : `${details.queueDepth} queued`}</span>}{(details.artifactCount > 0 || details.artifactStatus !== "not-configured") && <span className={`artifacts ${details.artifactStatus}`} title={`${details.artifactCount} artifacts; completion gates ${details.artifactStatus}`}><Package size={10} />{details.artifactCount}{details.artifactStatus === "passed" ? " ✓" : details.unmetGateCount ? density === "compact" ? `/${details.unmetGateCount}` : ` · ${details.unmetGateCount} unmet` : ""}</span>}{details.errorCount > 0 && <span className="errors" title={`${details.errorCount} recorded error${details.errorCount === 1 ? "" : "s"}`}><AlertTriangle size={10} />{details.errorCount}</span>}<span className="tokens" title={tokens === null ? "Token usage unavailable" : `${tokens.toLocaleString()} tokens used`}><Gauge size={10} />{tokens === null ? density === "compact" ? "—" : "— tokens" : density === "compact" ? formatTokens(tokens) : `${formatTokens(tokens)} tokens`}</span></div>
    {guardianStatus && <div className={`control-guardian ${thread.guardian?.phase}`}>{guardianStatus}</div>}
    {live.truncated && <RecoveryNotice compact onLoad={() => onRefresh(thread.id)} onError={onError} />}
    <div className="control-feed-shell"><div className="control-feed" ref={autoFollow.scrollerRef} onScroll={autoFollow.onScroll} role="region" aria-label={`Recent activity for ${threadTitle(thread)}`} aria-busy={running}>{!items.length && !streaming.some(([, value]) => value) && <div className="control-waiting"><ProviderIcon thread={thread} size={21} /><span>{running ? `${providerLabel(thread)} is starting…` : "Waiting for a task"}</span></div>}{items.map((item, index) => <CompactItem key={item.id || `${item.type}-${index}`} item={item} thread={thread} liveOutput={item.id ? live.toolOutput[item.id] : undefined} />)}{streaming.map(([id, value]) => value && <div className="compact-message agent live" key={id}><span><ProviderIcon thread={thread} /></span><div>{value}<i className="typing-cursor" /></div></div>)}</div><AutoFollowIndicator compact isFollowing={autoFollow.isFollowing} unseenCount={autoFollow.unseenCount} onJump={autoFollow.jumpToLatest} /></div>
    {live.queue.length > 0 && <div className="control-queue"><span><ListPlus size={11} />{live.queue.length} queued</span>{live.queue.map((entry, index) => <div key={entry.id}><b>{index + 1}</b><em>{entry.text}</em><button onClick={() => void api(`/api/threads/${thread.id}/queue/${entry.id}`, { method: "DELETE" }).catch(onError)} aria-label={`Remove queued task ${index + 1}`}><X size={10} /></button></div>)}</div>}
    <div className="control-models"><select aria-label={`Model for ${threadTitle(thread)}`} value={settings.model} disabled={thread.sessionClass === "spark"} onChange={(event) => { const model = models.find((candidate) => candidate.model === event.target.value); if (model) onSettings(thread.id, { ...settings, model: model.model, effort: model.defaultReasoningEffort }); }}>{thread.sessionClass === "spark" ? <option value="gpt-5.3-codex-spark">Spark</option> : models.map((model) => <option key={model.id} value={model.model}>{model.displayName}</option>)}</select><select aria-label={`Reasoning effort for ${threadTitle(thread)}`} value={settings.effort} disabled={thread.sessionClass === "spark"} onChange={(event) => onSettings(thread.id, { ...settings, effort: event.target.value })}>{efforts.map((effort) => <option key={effort}>{effort}</option>)}</select></div>
    <form className="control-composer" onSubmit={submit}><ComposerAssist suggestions={assist.suggestions} activeIndex={assist.activeIndex} onChoose={assist.choose} compact /><label className="sr-only" htmlFor={`control-composer-${thread.id}`}>Task for {threadTitle(thread)}</label><input id={`control-composer-${thread.id}`} value={text} onChange={(event) => setText(event.target.value)} onKeyDown={assist.onKeyDown} placeholder={valid ? running ? "Queue next task…" : "Send a task…" : "Choose valid settings"} /><button className={running ? "queue" : ""} disabled={!text.trim() || sending || !valid} aria-label={running ? "Queue task" : "Send task"}>{sending ? <LoaderCircle className="spin" size={13} /> : running ? <ListPlus size={13} /> : <Send size={13} />}</button>{running && <button type="button" className="stop" onClick={() => onSessionAction("stop", [thread.id])} aria-label={`Stop ${threadTitle(thread)}`}><CircleStop size={13} /></button>}</form>
  </article>;
});

function selectRecent<T>(items: T[], limit: number): T[] { return items.length <= limit ? items : items.slice(-limit); }
function usePausedRecentItems(items: ThreadItem[], following: boolean, limit: number): ThreadItem[] {
  const keyedItems = withControlKeys(items);
  const lastFollowing = useRef(selectRecent(keyedItems, limit));
  const pausedSnapshot = useRef<{ visible: Array<{ item: ThreadItem; key: string }>; known: Set<string> } | null>(null);
  if (following) {
    const recent = selectRecent(keyedItems, limit);
    lastFollowing.current = recent;
    pausedSnapshot.current = null;
    return recent.map(({ item }) => item);
  }
  pausedSnapshot.current ||= { visible: lastFollowing.current, known: new Set(keyedItems.map(({ key }) => key)) };
  const current = new Map(keyedItems.map((entry) => [entry.key, entry.item]));
  const visible = pausedSnapshot.current.visible.map((entry) => current.get(entry.key) || entry.item);
  const appended = keyedItems.filter(({ key }) => !pausedSnapshot.current!.known.has(key)).map(({ item }) => item);
  return [...visible, ...appended];
}
function withControlKeys(items: ThreadItem[]): Array<{ item: ThreadItem; key: string }> {
  const counts = new Map<string, number>();
  return items.map((item) => {
    const fingerprint = item.id || `${item.type}:${item.text || item.command || item.tool || item.server || "item"}`;
    const count = counts.get(fingerprint) || 0;
    counts.set(fingerprint, count + 1);
    return { item, key: `${fingerprint}:${count}` };
  });
}
function threadTitle(thread: Thread) { return thread.name || thread.preview || "Untitled session"; }
function basename(value: string) { return value.split("/").filter(Boolean).pop() || value; }
function providerLabel(thread: Thread) { return thread.sessionClass === "spark" ? "Spark" : "Codex"; }
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
function threadOptionLabel(thread: Thread) {
  const labels = [thread.category, ...(thread.tags || [])].filter(Boolean).slice(0, 2).join(", ");
  const model = thread.model;
  return [threadTitle(thread), basename(thread.cwd), model, labels].filter(Boolean).join(" · ");
}
function formatTokens(tokens: number) { return tokens < 1_000 ? String(tokens) : `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`; }
function ProviderIcon({ thread, size = 11 }: { thread: Thread; size?: number }) { return thread.sessionClass === "spark" ? <Sparkles size={size} color="var(--color-provider-spark)" /> : <Bot size={size} color="var(--color-provider-codex)" />; }
