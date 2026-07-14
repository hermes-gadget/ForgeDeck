import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Archive, ArrowLeft, Bot, BrainCircuit, Check, ChevronRight, CircleStop,
  Clock3, Code2, Command, Folder, FolderOpen, Gauge, GitBranch, KeyRound,
  FileText, LayoutGrid, LoaderCircle, LogOut, Menu, MessageSquareText,
  PanelLeftClose, Pin, PinOff, Plus, RefreshCw, Search, Send, Server,
  Settings2, ShieldCheck, Sparkles, TerminalSquare, ListPlus, Target, Pause, Play,
  Moon, Sun, Tags, Trash2, X
} from "lucide-react";
import type { Bootstrap, ClaudeModelOption, CodexModel, LiveThreadState, PendingRequest, QueueEntry, Thread, ThreadItem, Usage } from "./types";

type SortMode = "updated" | "created" | "name" | "directory" | "status";
type ViewMode = "session" | "control" | "spark";
type SessionClass = "standard" | "spark";
type SessionBackend = "codex" | "claude";
type BoardVariant = "control" | "spark";
type ClaudePermissionMode = "default" | "plan" | "bypassPermissions";
type ThreadSettings = Record<string, { model: string; effort: string }>;
type LiveStreams = Record<string, Record<string, string>>;
type LiveItems = Record<string, Record<string, ThreadItem>>;
type ThemeMode = "dark" | "light";
type ThreadTokenUsage = { totalTokens: number; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningOutputTokens?: number };
type AssistSuggestion = { id: string; label: string; description: string; insert: string; kind: "command" | "file" | "directory" };

const LazyReactMarkdown = lazy(() => import("react-markdown"));

/** Defers the markdown parser until conversation content actually needs it. */
function ReactMarkdown({ children }: { children: string }) {
  return <Suspense fallback={<span>{children}</span>}><LazyReactMarkdown>{children}</LazyReactMarkdown></Suspense>;
}

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
const COMPLETED_CONTROL_TTL_MS = 15 * 60_000;
const POLL_INTERVALS = [0, 2_000, 4_000, 10_000, 30_000] as const;
const LIVE_UPDATE_INTERVAL_MS = 50;
const CLIENT_LIVE_OUTPUT_MAX_CHARS = 200_000;
const EMPTY_TEXT_STREAM: Record<string, string> = {};
const EMPTY_LIVE_ITEMS: Record<string, ThreadItem> = {};
const EMPTY_QUEUE: QueueEntry[] = [];
const EMPTY_CLAUDE_MODELS: ClaudeModelOption[] = [];
const SPARK_MODEL = "gpt-5.3-codex-spark";
const CLAUDE_EFFORTS = ["low", "medium", "high", "max"] as const;
const CLAUDE_LIVE_POLL_MS = 2_000;

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Thread | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>(readSortMode);
  const [pollInterval, setPollInterval] = useState(() => readPollInterval());
  const [theme, setTheme] = useState<ThemeMode>(() => readTheme());
  const [pinned, setPinned] = useState<Set<string>>(() => new Set(readStoredStringArray("forgedeck-pins")));
  const [settings, setSettings] = useState<ThreadSettings>(readThreadSettings);
  const [view, setView] = useState<ViewMode>(() => {
    const stored = readStoredString("forgedeck-view");
    return stored === "control" || stored === "spark" ? stored : "session";
  });
  const [controlIds, setControlIds] = useState<string[]>(() => readStoredStringArray("forgedeck-control-ids"));
  const [dismissedControlIds, setDismissedControlIds] = useState<Set<string>>(() => new Set(readStoredStringArray("forgedeck-control-dismissed")));
  const [sparkIds, setSparkIds] = useState<string[]>(() => readStoredStringArray("forgedeck-spark-ids"));
  const [dismissedSparkIds, setDismissedSparkIds] = useState<Set<string>>(() => new Set(readStoredStringArray("forgedeck-spark-dismissed")));
  const [newOpen, setNewOpen] = useState(false);
  const [newSessionClass, setNewSessionClass] = useState<SessionClass>("standard");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pending, setPending] = useState<PendingRequest[]>([]);
  const [liveText, setLiveText] = useState<LiveStreams>({});
  const [liveToolOutput, setLiveToolOutput] = useState<LiveStreams>({});
  const [liveItems, setLiveItems] = useState<LiveItems>({});
  const [liveStatuses, setLiveStatuses] = useState<Record<string, Thread["status"]>>({});
  const [activeThreadIds, setActiveThreadIds] = useState<Set<string>>(new Set());
  const [queues, setQueues] = useState<Record<string, QueueEntry[]>>({});
  const [completedSignals, setCompletedSignals] = useState<Set<string>>(() => new Set(readStoredStringArray("forgedeck-completed")));
  const [completionTimes, setCompletionTimes] = useState<Record<string, number>>({});
  const [tokenUsage, setTokenUsage] = useState<Record<string, ThreadTokenUsage>>(readStoredTokenUsage);
  const [activityVersion, setActivityVersion] = useState(0);
  const [runtime, setRuntime] = useState<"ready" | "offline" | "error">("ready");
  const [toast, setToast] = useState<string | null>(null);
  const selectedRef = useRef(selectedId);
  const searchRef = useRef(search);
  const activeThreadIdsRef = useRef(activeThreadIds);
  const dismissedControlIdsRef = useRef(dismissedControlIds);
  const dismissedSparkIdsRef = useRef(dismissedSparkIds);
  const activitySequence = useRef(0);
  const threadActivitySequence = useRef<Record<string, number>>({});
  const statusConfirmTimers = useRef<Record<string, number>>({});
  const refreshTimer = useRef<number | null>(null);
  const listTimer = useRef<number | null>(null);
  const listRequestSequence = useRef(0);
  const removedThreadIdsRef = useRef<Set<string>>(new Set());
  const detailRequestSequence = useRef<Record<string, number>>({});
  const controlSelectionInitialized = useRef(readStoredString("forgedeck-control-initialized") === "true" || readStoredString("forgedeck-control-ids") !== null);
  const sparkSelectionInitialized = useRef(readStoredString("forgedeck-spark-ids") !== null);

  useEffect(() => { selectedRef.current = selectedId; }, [selectedId]);
  searchRef.current = search;
  useEffect(() => { dismissedControlIdsRef.current = dismissedControlIds; }, [dismissedControlIds]);
  useEffect(() => { dismissedSparkIdsRef.current = dismissedSparkIds; }, [dismissedSparkIds]);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  const loadBootstrap = useCallback(async () => {
    const requestSequence = activitySequence.current;
    const data = await api<Bootstrap>("/api/bootstrap");
    setBootstrap((current) => sameBootstrapSummary(current, data) ? current : data);
    setPending((current) => samePendingRequests(current, data.pendingRequests) ? current : data.pendingRequests);
    setQueues((current) => sameQueues(current, data.queues || {}) ? current : data.queues || {});
    const activeIds = new Set(data.activeThreadIds || []);
    for (const [threadId, sequence] of Object.entries(threadActivitySequence.current)) {
      if (sequence > requestSequence && activeThreadIdsRef.current.has(threadId)) activeIds.add(threadId);
    }
    activeThreadIdsRef.current = activeIds;
    setActiveThreadIds((current) => sameSet(current, activeIds) ? current : activeIds);
    if (data.agentThreadIds?.length) {
      const sparkAgentIds = new Set(data.sparkAgentThreadIds || []);
      setControlIds((current) => {
        const missing = data.agentThreadIds!.filter((threadId) => !sparkAgentIds.has(threadId) && !dismissedControlIdsRef.current.has(threadId) && !current.includes(threadId));
        return missing.length ? [...current, ...missing] : current;
      });
    }
    if (data.sparkAgentThreadIds?.length) {
      setSparkIds((current) => {
        const missing = data.sparkAgentThreadIds!.filter((threadId) => !dismissedSparkIdsRef.current.has(threadId) && !current.includes(threadId));
        return missing.length ? [...current, ...missing] : current;
      });
    }
    setLiveStatuses((current) => {
      const next = { ...current };
      for (const [threadId, status] of Object.entries(next)) {
        if (status.type === "active" && !activeIds.has(threadId)) delete next[threadId];
      }
      for (const [threadId, state] of Object.entries(data.liveState || {})) {
        next[threadId] = state.active
          ? { type: "active", activeFlags: [] }
          : { type: "idle" };
      }
      for (const threadId of activeIds) next[threadId] = { type: "active", activeFlags: [] };
      return sameRecord(current, next, sameThreadStatus) ? current : next;
    });
    if (data.liveState) {
      setLiveItems((current) => mergeLiveState(current, data.liveState!, "items"));
      setLiveText((current) => mergeLiveState(current, data.liveState!, "agentText"));
      setLiveToolOutput((current) => mergeLiveState(current, data.liveState!, "toolOutput"));
      const seen = readStoredNumberRecord("forgedeck-completion-seen");
      setCompletedSignals((current) => {
        const next = new Set(current);
        for (const [threadId, state] of Object.entries(data.liveState!)) {
          if (state.active || activeIds.has(threadId)) next.delete(threadId);
          else if (state.completedAt && state.completedAt > (seen[threadId] || 0)) next.add(threadId);
        }
        return sameSet(current, next) ? current : next;
      });
      setCompletionTimes((current) => {
        const next = { ...current };
        for (const [threadId, state] of Object.entries(data.liveState!)) {
          if (state.active || activeIds.has(threadId)) delete next[threadId];
          else if (state.completedAt) next[threadId] = state.completedAt;
        }
        return sameNumberRecord(current, next) ? current : next;
      });
    }
    return data;
  }, []);

  const loadThreads = useCallback(async () => {
    const requestId = ++listRequestSequence.current;
    const requestedSearch = searchRef.current.trim();
    const collect = async (sessionClass: SessionClass) => {
      const inventory: Thread[] = [];
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ limit: "200", sortKey: "updated_at", sortDirection: "desc" });
        if (cursor) query.set("cursor", cursor);
        query.set("class", sessionClass);
        const response = await api<{ data: Thread[]; nextCursor: string | null }>(`/api/threads?${query}`);
        inventory.push(...response.data);
        cursor = response.nextCursor;
      } while (cursor);
      return inventory;
    };
    // Fetch both creation-time partitions explicitly so neither board depends
    // on an unfiltered endpoint's default behavior.
    const [standardInventory, sparkInventory] = await Promise.all([collect("standard"), collect("spark")]);
    const byId = new Map<string, Thread>();
    for (const thread of [...standardInventory, ...sparkInventory]) byId.set(thread.id, thread);
    const collected = [...byId.values()];
    if (requestId !== listRequestSequence.current || requestedSearch !== searchRef.current.trim()) return;
    const eligible = collected.filter((thread) => !removedThreadIdsRef.current.has(thread.id));
    const visible = requestedSearch
      ? eligible.filter((thread) => sessionSearchText(thread).includes(requestedSearch.toLocaleLowerCase()))
      : eligible;
    setThreads((current) => reconcileThreads(current, visible));
    setTokenUsage((current) => mergeThreadTokenUsage(current, visible));
    setSelectedId((current) => current && visible.some((thread) => thread.id === current) ? current : visible[0]?.id || null);
  }, []);

  const loadThread = useCallback(async (id: string, quiet = false) => {
    const requestId = (detailRequestSequence.current[id] || 0) + 1;
    detailRequestSequence.current[id] = requestId;
    if (!quiet) setLoadingDetail(true);
    try {
      const response = await api<{ thread: Thread }>(`/api/threads/${encodeURIComponent(id)}`);
      const usage = extractThreadTokenUsage(response.thread);
      if (usage) setTokenUsage((current) => sameTokenUsage(current[id], usage) ? current : { ...current, [id]: usage });
      if (detailRequestSequence.current[id] === requestId && selectedRef.current === id) {
        setDetail((current) => current && sameThreadSnapshot(current, response.thread) ? current : response.thread);
      }
    } finally {
      if (detailRequestSequence.current[id] === requestId && selectedRef.current === id) setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    void api<{ authenticated: boolean }>("/api/auth", { allowUnauthenticated: true })
      .then(({ authenticated: value }) => setAuthenticated(value))
      .catch(() => setAuthenticated(false));
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    void loadBootstrap().catch((error) => showError(error, setToast));
  }, [authenticated, loadBootstrap]);

  useEffect(() => {
    if (!authenticated) return;
    const timer = window.setTimeout(() => void loadThreads().catch((error) => showError(error, setToast)), search.trim() ? 250 : 0);
    return () => clearTimeout(timer);
  }, [search, authenticated, loadThreads]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    setSidebarOpen(false);
    void loadThread(selectedId).catch((error) => showError(error, setToast));
  }, [selectedId, loadThread]);

  // Poll only while the event stream is unavailable. Running the fallback beside
  // healthy SSE needlessly replaces the same DOM data every few seconds.
  useEffect(() => {
    if (!authenticated || runtime === "ready" || pollInterval === 0) return;
    const timer = window.setInterval(() => void loadThreads().catch(() => undefined), pollInterval);
    return () => clearInterval(timer);
  }, [authenticated, loadThreads, pollInterval, runtime]);

  useEffect(() => {
    if (!authenticated) return;
    const threadIds = threads.filter((thread) => isClaudeThread(thread) && (thread.status.type === "active" || hasInProgressTurn(thread))).map((thread) => thread.id);
    if (!threadIds.length) return;
    const refresh = async () => {
      const response = await api<{ results: Array<{ threadId: string; ok: boolean; value?: Thread }> }>("/api/threads/batch", {
        method: "POST",
        body: JSON.stringify({ operation: "read", threadIds })
      });
      const snapshots = new Map(response.results.filter((result) => result.ok && result.value).map((result) => [result.threadId, result.value!]));
      const completedIds = [...snapshots.values()].filter((thread) => thread.status.type !== "active" && !hasInProgressTurn(thread)).map((thread) => thread.id);
      setThreads((current) => {
        let changed = false;
        const next = current.map((thread) => {
          const snapshot = snapshots.get(thread.id);
          if (!snapshot || sameThreadSnapshot(thread, snapshot)) return thread;
          changed = true;
          return snapshot;
        });
        return changed ? next : current;
      });
      if (completedIds.length) {
        const completedAt = Date.now();
        setCompletedSignals((current) => {
          const next = new Set(current);
          for (const threadId of completedIds) next.add(threadId);
          return sameSet(current, next) ? current : next;
        });
        setCompletionTimes((current) => {
          const next = { ...current };
          for (const threadId of completedIds) next[threadId] = completedAt;
          return next;
        });
        const nextActiveIds = new Set(activeThreadIdsRef.current);
        for (const threadId of completedIds) nextActiveIds.delete(threadId);
        activeThreadIdsRef.current = nextActiveIds;
        setActiveThreadIds(nextActiveIds);
      }
    };
    const timer = window.setInterval(() => void refresh().catch(() => undefined), CLAUDE_LIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [authenticated, threads]);

  useEffect(() => {
    if (!authenticated || view !== "session" || !selectedId) return;
    const selectedIsClaude = threads.some((thread) => thread.id === selectedId && isClaudeThread(thread));
    if (!selectedIsClaude && (runtime === "ready" || pollInterval === 0)) return;
    const timer = window.setInterval(() => void loadThread(selectedId, true).catch(() => undefined), selectedIsClaude ? CLAUDE_LIVE_POLL_MS : pollInterval);
    return () => clearInterval(timer);
  }, [authenticated, view, selectedId, loadThread, pollInterval, runtime, threads]);

  useEffect(() => {
    if (!authenticated) return;
    const events = new EventSource("/events");
    let hasConnected = false;
    let needsReconnectRefresh = false;
    let serverRuntimeState: "ready" | "offline" | "error" = "ready";
    let reconnectTimer: number | null = null;
    let activityTimer: number | null = null;
    let liveFlushTimer: number | null = null;
    const liveCleanupTimers = new Set<number>();
    let pendingTextDeltas: LiveStreams = {};
    let pendingToolDeltas: LiveStreams = {};
    let pendingTokenUsage: Record<string, ThreadTokenUsage> = {};

    const scheduleListRefresh = (delay = 250) => {
      if (listTimer.current) clearTimeout(listTimer.current);
      listTimer.current = window.setTimeout(() => {
        listTimer.current = null;
        void loadThreads().catch(() => undefined);
      }, delay);
    };
    const scheduleConnectionRefresh = () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void Promise.all([loadBootstrap(), loadThreads()]).catch(() => undefined);
        if (selectedRef.current) void loadThread(selectedRef.current, true).catch(() => undefined);
      }, 100);
    };
    const scheduleActivityRefresh = () => {
      if (activityTimer) clearTimeout(activityTimer);
      activityTimer = window.setTimeout(() => {
        activityTimer = null;
        setActivityVersion((value) => value + 1);
      }, 250);
    };
    const flushLiveDeltas = () => {
      liveFlushTimer = null;
      const textDeltas = pendingTextDeltas;
      const toolDeltas = pendingToolDeltas;
      const usageUpdates = pendingTokenUsage;
      pendingTextDeltas = {};
      pendingToolDeltas = {};
      pendingTokenUsage = {};
      if (Object.keys(textDeltas).length) setLiveText((current) => appendLiveDeltas(current, textDeltas));
      if (Object.keys(toolDeltas).length) setLiveToolOutput((current) => appendLiveDeltas(current, toolDeltas));
      if (Object.keys(usageUpdates).length) setTokenUsage((current) => mergeTokenUsage(current, usageUpdates));
    };
    const scheduleLiveFlush = () => {
      if (!liveFlushTimer) liveFlushTimer = window.setTimeout(flushLiveDeltas, LIVE_UPDATE_INTERVAL_MS);
    };
    const queueLiveDelta = (target: "text" | "tool", threadId: string, itemId: string, delta: string) => {
      if (!delta) return;
      const pending = target === "text" ? pendingTextDeltas : pendingToolDeltas;
      pending[threadId] = { ...(pending[threadId] || {}), [itemId]: appendBoundedText(pending[threadId]?.[itemId] || "", delta) };
      scheduleLiveFlush();
    };
    const markActive = (threadId: string) => {
      activitySequence.current += 1;
      threadActivitySequence.current[threadId] = activitySequence.current;
      if (!activeThreadIdsRef.current.has(threadId)) {
        const next = new Set(activeThreadIdsRef.current).add(threadId);
        activeThreadIdsRef.current = next;
        setActiveThreadIds(next);
      }
      setLiveStatuses((current) => current[threadId]?.type === "active"
        ? current
        : { ...current, [threadId]: { type: "active", activeFlags: [] } });
      const timer = statusConfirmTimers.current[threadId];
      if (timer) {
        clearTimeout(timer);
        delete statusConfirmTimers.current[threadId];
      }
    };
    const reconcileTerminalStatus = (threadId: string) => {
      activitySequence.current += 1;
      threadActivitySequence.current[threadId] = activitySequence.current;
      const existing = statusConfirmTimers.current[threadId];
      if (existing) clearTimeout(existing);
      statusConfirmTimers.current[threadId] = window.setTimeout(() => {
        delete statusConfirmTimers.current[threadId];
        void loadBootstrap().catch(() => undefined);
        scheduleListRefresh(0);
      }, 300);
    };
    events.addEventListener("connected", () => {
      const isReconnect = hasConnected || needsReconnectRefresh;
      hasConnected = true;
      needsReconnectRefresh = false;
      setRuntime((current) => current === "ready" ? current : "ready");
      if (isReconnect) scheduleConnectionRefresh();
    });
    events.addEventListener("runtime", (event) => {
      const payload = parseEventData<{ state?: unknown }>(event);
      if (!payload || !["ready", "offline", "error"].includes(String(payload.state))) return;
      const state = payload.state as "ready" | "offline" | "error";
      const recovered = serverRuntimeState !== "ready" && state === "ready";
      serverRuntimeState = state;
      setRuntime((current) => current === state ? current : state);
      if (state === "ready" && (needsReconnectRefresh || recovered)) {
        needsReconnectRefresh = false;
        scheduleConnectionRefresh();
      }
    });
    events.addEventListener("approval", (event) => {
      const request = parseEventData<PendingRequest>(event);
      if (!request || request.id === undefined) return;
      setPending((current) => current.some((item) => String(item.id) === String(request.id)) ? current : [...current, request]);
    });
    events.addEventListener("approval-resolved", (event) => {
      const payload = parseEventData<{ id?: unknown }>(event);
      if (!payload || payload.id === undefined) return;
      const { id } = payload;
      setPending((current) => current.filter((item) => String(item.id) !== String(id)));
    });
    events.addEventListener("queue", (event) => {
      const payload = parseEventData<{ threadId?: unknown; queue?: unknown; error?: unknown }>(event);
      if (!payload || typeof payload.threadId !== "string" || !Array.isArray(payload.queue)) return;
      const threadId = payload.threadId;
      const queue = payload.queue as QueueEntry[];
      setQueues((current) => sameQueue(current[threadId] || EMPTY_QUEUE, queue)
        ? current
        : { ...current, [threadId]: queue });
      if (typeof payload.error === "string" && payload.error) setToast(`Queued turn could not start: ${payload.error}`);
    });
    events.addEventListener("threads", (event) => {
      const payload = parseEventData<{ action?: unknown; threadId?: unknown; reason?: unknown }>(event);
      if (!payload || typeof payload.threadId !== "string" || !["created", "updated", "removed"].includes(String(payload.action))) return;
      const threadId = payload.threadId;
      if (payload.action === "created") {
        removedThreadIdsRef.current.delete(threadId);
      }
      if (payload.action === "updated" && payload.reason === "archive_failed") {
        removedThreadIdsRef.current.delete(threadId);
      }
      if (payload.action === "removed") {
        removedThreadIdsRef.current.add(threadId);
        listRequestSequence.current += 1;
        delete pendingTextDeltas[threadId];
        delete pendingToolDeltas[threadId];
        delete pendingTokenUsage[threadId];
        setThreads((current) => current.filter((thread) => thread.id !== threadId));
        setSelectedId((current) => current === threadId ? null : current);
        setDetail((current) => current?.id === threadId ? null : current);
        setControlIds((current) => current.filter((id) => id !== threadId));
        setSparkIds((current) => current.filter((id) => id !== threadId));
        setLiveStatuses((current) => omitKey(current, threadId));
        setLiveText((current) => omitKey(current, threadId));
        setLiveToolOutput((current) => omitKey(current, threadId));
        setLiveItems((current) => omitKey(current, threadId));
        setQueues((current) => omitKey(current, threadId));
        setCompletedSignals((current) => withoutSetValue(current, threadId));
        setCompletionTimes((current) => omitKey(current, threadId));
        const next = withoutSetValue(activeThreadIdsRef.current, threadId);
        activeThreadIdsRef.current = next;
        setActiveThreadIds(next);
      }
      scheduleListRefresh(payload.action === "removed" ? 0 : 250);
    });
    events.addEventListener("codex", (event) => {
      const notification = parseEventData<{ method?: unknown; params?: unknown }>(event);
      if (!notification || typeof notification.method !== "string" || !isRecord(notification.params)) return;
      const threadId = typeof notification.params?.threadId === "string" ? notification.params.threadId : null;
      if (notification.method === "item/agentMessage/delta" && threadId) {
        const itemId = String(notification.params.itemId);
        const delta = String(notification.params.delta || "");
        queueLiveDelta("text", threadId, itemId, delta);
      }
      if ((notification.method === "item/commandExecution/outputDelta" || notification.method === "command/exec/outputDelta") && threadId) {
        const itemId = String(notification.params.itemId || notification.params.processId || "command");
        const delta = String(notification.params.delta || "");
        queueLiveDelta("tool", threadId, itemId, delta);
      }
      if ((notification.method === "item/started" || notification.method === "item/completed") && threadId && notification.params.item && typeof notification.params.item === "object") {
        const item = notification.params.item as ThreadItem;
        if (item.id) {
          setLiveItems((current) => setNestedValue(current, threadId, item.id!, item, sameThreadItem));
        }
      }
      if (notification.method === "thread/status/changed" && threadId && notification.params.status && typeof notification.params.status === "object") {
        const status = notification.params.status as Thread["status"];
        if (status.type === "active") {
          markActive(threadId);
        } else {
          setLiveStatuses((current) => sameThreadStatus(current[threadId], status) ? current : { ...current, [threadId]: status });
          reconcileTerminalStatus(threadId);
        }
        setDetail((current) => current?.id === threadId && !sameThreadStatus(current.status, status) ? { ...current, status } : current);
      }
      if (notification.method === "turn/started" && threadId) {
        markActive(threadId);
        setCompletedSignals((current) => withoutSetValue(current, threadId));
        setCompletionTimes((current) => omitKey(current, threadId));
      }
      if (notification.method === "turn/completed" && threadId) {
        // A raw completion can belong to one of several activity sources, or be
        // followed immediately by a queued turn. Keep showing active until the
        // aggregate bootstrap state confirms that all work has stopped.
        reconcileTerminalStatus(threadId);
      }
      if (notification.method === "thread/tokenUsage/updated" && threadId) {
        const usage = normalizeTokenUsage((notification.params.tokenUsage as { total?: unknown } | undefined)?.total);
        if (usage) {
          pendingTokenUsage[threadId] = usage;
          scheduleLiveFlush();
        }
      }
      if (notification.method === "account/rateLimits/updated") {
        void loadBootstrap().catch(() => undefined);
      }
      if (threadId === selectedRef.current && !notification.method.endsWith("/delta")) {
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        refreshTimer.current = window.setTimeout(() => {
          if (selectedRef.current) void loadThread(selectedRef.current, true).catch(() => undefined);
          if (notification.method === "turn/completed") {
            const cleanupTimer = window.setTimeout(() => {
              liveCleanupTimers.delete(cleanupTimer);
              setLiveText((current) => omitKey(current, threadId!));
              setLiveToolOutput((current) => omitKey(current, threadId!));
              setLiveItems((current) => omitKey(current, threadId!));
            }, 1_200);
            liveCleanupTimers.add(cleanupTimer);
          }
        }, 300);
      }
      if (threadId && /^(item\/|turn\/|thread\/(status|goal))/.test(notification.method) && !notification.method.endsWith("/delta")) {
        scheduleActivityRefresh();
      }
      if (/^(thread|turn)\//.test(notification.method)) {
        scheduleListRefresh(400);
      }
    });
    events.onerror = () => {
      needsReconnectRefresh = true;
      setRuntime((current) => current === "offline" ? current : "offline");
    };
    return () => {
      events.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (activityTimer) clearTimeout(activityTimer);
      if (liveFlushTimer) clearTimeout(liveFlushTimer);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      if (listTimer.current) clearTimeout(listTimer.current);
      refreshTimer.current = null;
      listTimer.current = null;
      for (const timer of liveCleanupTimers) clearTimeout(timer);
      for (const timer of Object.values(statusConfirmTimers.current)) clearTimeout(timer);
      statusConfirmTimers.current = {};
    };
  }, [authenticated, loadBootstrap, loadThread, loadThreads]);

  useEffect(() => {
    writeStoredJson("forgedeck-pins", [...pinned]);
  }, [pinned]);
  useEffect(() => writeStoredString("forgedeck-view", view), [view]);
  useEffect(() => writeStoredJson("forgedeck-control-ids", controlIds), [controlIds]);
  useEffect(() => writeStoredJson("forgedeck-control-dismissed", [...dismissedControlIds]), [dismissedControlIds]);
  useEffect(() => writeStoredJson("forgedeck-spark-ids", sparkIds), [sparkIds]);
  useEffect(() => writeStoredJson("forgedeck-spark-dismissed", [...dismissedSparkIds]), [dismissedSparkIds]);
  useEffect(() => writeStoredJson("forgedeck-completed", [...completedSignals]), [completedSignals]);
  useEffect(() => {
    const timer = window.setTimeout(() => writeStoredJson("forgedeck-token-usage", tokenUsage), 500);
    return () => clearTimeout(timer);
  }, [tokenUsage]);
  useEffect(() => writeStoredString("forgedeck-poll-interval", String(pollInterval)), [pollInterval]);
  useEffect(() => writeStoredString("forgedeck-theme", theme), [theme]);
  useEffect(() => {
    const prune = () => {
      const cutoff = Date.now() - COMPLETED_CONTROL_TTL_MS;
      setControlIds((current) => {
        const next = current.filter((threadId) => activeThreadIds.has(threadId) || !completionTimes[threadId] || completionTimes[threadId] > cutoff);
        return next.length === current.length ? current : next;
      });
      setSparkIds((current) => {
        const next = current.filter((threadId) => activeThreadIds.has(threadId) || !completionTimes[threadId] || completionTimes[threadId] > cutoff);
        return next.length === current.length ? current : next;
      });
    };
    prune();
    const timer = window.setInterval(prune, 30_000);
    return () => clearInterval(timer);
  }, [activeThreadIds, completionTimes]);
  useEffect(() => {
    if (threads.length && !controlSelectionInitialized.current) {
      controlSelectionInitialized.current = true;
      writeStoredString("forgedeck-control-initialized", "true");
      const initial = threads.filter((thread) => !isSparkThread(thread)).sort((a, b) => statusRank(b) - statusRank(a) || b.updatedAt - a.updatedAt).slice(0, 3).map((thread) => thread.id);
      setControlIds(initial);
    }
  }, [threads]);
  useEffect(() => {
    const activeIds = threads.filter((thread) => !isSparkThread(thread) && activeThreadIds.has(thread.id) && !dismissedControlIds.has(thread.id)).map((thread) => thread.id);
    const sparkThreadIdSet = new Set(threads.filter(isSparkThread).map((thread) => thread.id));
    setControlIds((current) => {
      const retained = current.filter((id) => !sparkThreadIdSet.has(id));
      const missing = activeIds.filter((id) => !retained.includes(id));
      return retained.length === current.length && !missing.length ? current : [...retained, ...missing];
    });
  }, [threads, activeThreadIds, dismissedControlIds]);
  useEffect(() => {
    if (!threads.length || sparkSelectionInitialized.current) return;
    sparkSelectionInitialized.current = true;
    const initialIds = threads.filter((thread) => isSparkThread(thread) && !dismissedSparkIds.has(thread.id)).map((thread) => thread.id);
    if (initialIds.length) setSparkIds(initialIds);
  }, [threads, dismissedSparkIds]);
  useEffect(() => {
    const activeIds = threads.filter((thread) => isSparkThread(thread) && activeThreadIds.has(thread.id) && !dismissedSparkIds.has(thread.id)).map((thread) => thread.id);
    if (!activeIds.length) return;
    setSparkIds((current) => {
      const missing = activeIds.filter((id) => !current.includes(id));
      return missing.length ? [...current, ...missing] : current;
    });
  }, [threads, activeThreadIds, dismissedSparkIds]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key.toLowerCase() === "n" && !event.ctrlKey && !event.metaKey && !event.altKey && !target?.matches("input, textarea, select, [contenteditable=true]")) {
        event.preventDefault();
        setNewSessionClass("standard");
        setNewOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  useEffect(() => writeStoredJson("forgedeck-settings", settings), [settings]);
  useEffect(() => writeStoredString("forgedeck-sort", sortMode), [sortMode]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(timer);
  }, [toast]);

  const effectiveThreads = useMemo(() => threads.map((thread) => {
    const status = isClaudeThread(thread)
      ? hasInProgressTurn(thread) ? { type: "active", activeFlags: [] } as Thread["status"] : thread.status
      : activeThreadIds.has(thread.id) || liveStatuses[thread.id]?.type === "active" || hasInProgressTurn(thread)
      ? { type: "active", activeFlags: [] } as Thread["status"]
      : liveStatuses[thread.id] || thread.status;
    return sameThreadStatus(thread.status, status) ? thread : { ...thread, status };
  }), [threads, liveStatuses, activeThreadIds]);

  const sortedThreads = useMemo(() => {
    const copy = [...effectiveThreads];
    copy.sort((a, b) => {
      const lifecycleOrder = statusRank(b, completedSignals.has(b.id)) - statusRank(a, completedSignals.has(a.id));
      if (lifecycleOrder) return lifecycleOrder;
      const pinOrder = Number(pinned.has(b.id)) - Number(pinned.has(a.id));
      if (pinOrder) return pinOrder;
      if (sortMode === "name") return threadTitle(a).localeCompare(threadTitle(b));
      if (sortMode === "directory") return a.cwd.localeCompare(b.cwd);
      if (sortMode === "status") return b.updatedAt - a.updatedAt;
      if (sortMode === "created") return b.createdAt - a.createdAt;
      return b.updatedAt - a.updatedAt;
    });
    return copy;
  }, [effectiveThreads, sortMode, pinned, completedSignals]);

  const defaultModel = bootstrap?.models.data.find((model) => model.isDefault) || bootstrap?.models.data[0];
  const selectedThread = useMemo(() => effectiveThreads.find((thread) => thread.id === selectedId), [effectiveThreads, selectedId]);
  const activeSettings = useMemo(() => selectedId && settings[selectedId]
    ? settings[selectedId]
    : selectedThread ? defaultSettingsForThread(selectedThread, bootstrap?.models.data || [], bootstrap?.claudeModelOptions || [], defaultModel) : null,
  [bootstrap?.claudeModelOptions, bootstrap?.models.data, defaultModel, selectedId, selectedThread, settings]);
  const controlThreads = useMemo(() => {
    const byId = new Map(effectiveThreads.map((thread) => [thread.id, thread]));
    return controlIds.map((id) => byId.get(id)).filter((thread): thread is Thread => Boolean(thread) && !isSparkThread(thread!));
  }, [effectiveThreads, controlIds]);
  const allStandardThreads = useMemo(() => effectiveThreads.filter((thread) => !isSparkThread(thread)), [effectiveThreads]);
  const sparkThreads = useMemo(() => {
    const byId = new Map(effectiveThreads.filter(isSparkThread).map((thread) => [thread.id, thread]));
    return sparkIds.map((id) => byId.get(id)).filter((thread): thread is Thread => Boolean(thread));
  }, [effectiveThreads, sparkIds]);
  const allSparkThreads = useMemo(() => effectiveThreads.filter(isSparkThread), [effectiveThreads]);
  const controlIdSet = useMemo(() => new Set(controlIds), [controlIds]);
  const sparkIdSet = useMemo(() => new Set(sparkIds), [sparkIds]);
  const effectiveDetail = useMemo(() => {
    if (detail && isClaudeThread(detail)) return detail;
    if (!detail || !(activeThreadIds.has(detail.id) || liveStatuses[detail.id]?.type === "active" || hasInProgressTurn(detail)) || detail.status.type === "active") return detail;
    return { ...detail, status: { type: "active", activeFlags: [] } as Thread["status"] };
  }, [activeThreadIds, detail, liveStatuses]);

  if (authenticated === null) return <Splash />;
  if (!authenticated) return <Login onSuccess={() => setAuthenticated(true)} />;
  if (!bootstrap) return <Splash label="Connecting to your Codex account…" />;

  const togglePin = (id: string) => setPinned((current) => {
    const next = new Set(current);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const addControl = (id: string) => {
    const nextDismissed = withoutSetValue(dismissedControlIdsRef.current, id);
    dismissedControlIdsRef.current = nextDismissed;
    setDismissedControlIds(nextDismissed);
    setControlIds((current) => current.includes(id) ? current : [...current, id]);
    setCompletionTimes((times) => omitKey(times, id));
  };

  const removeControl = (id: string) => {
    // Record the dismissal before updating the deck so bootstrap/active-session
    // discovery cannot race the close and put the panel back.
    dismissedControlIdsRef.current = new Set(dismissedControlIdsRef.current).add(id);
    setDismissedControlIds(new Set(dismissedControlIdsRef.current));
    setControlIds((current) => current.filter((item) => item !== id));
  };

  const toggleControl = (id: string) => {
    if (controlIds.includes(id)) removeControl(id);
    else addControl(id);
  };

  const addSpark = (id: string) => {
    const nextDismissed = withoutSetValue(dismissedSparkIdsRef.current, id);
    dismissedSparkIdsRef.current = nextDismissed;
    setDismissedSparkIds(nextDismissed);
    setSparkIds((current) => current.includes(id) ? current : [...current, id]);
    setCompletionTimes((times) => omitKey(times, id));
  };

  const removeSpark = (id: string) => {
    dismissedSparkIdsRef.current = new Set(dismissedSparkIdsRef.current).add(id);
    setDismissedSparkIds(new Set(dismissedSparkIdsRef.current));
    setSparkIds((current) => current.filter((item) => item !== id));
  };

  const toggleSpark = (id: string) => {
    if (sparkIds.includes(id)) removeSpark(id);
    else addSpark(id);
  };

  const markCompletionSeen = (id: string) => {
    setCompletedSignals((current) => withoutSetValue(current, id));
    const seen = readStoredNumberRecord("forgedeck-completion-seen");
    seen[id] = Date.now();
    writeStoredJson("forgedeck-completion-seen", seen);
  };

  const clearCompleted = (sessionClass: SessionClass) => {
    const ids = effectiveThreads
      .filter((thread) => (sessionClass === "spark") === isSparkThread(thread) && completedSignals.has(thread.id) && thread.status.type !== "active")
      .map((thread) => thread.id);
    if (!ids.length) return;
    const completedIds = new Set(ids);
    const setBoardIds = sessionClass === "spark" ? setSparkIds : setControlIds;
    setBoardIds((current) => current.filter((id) => !completedIds.has(id)));
    const dismissedRef = sessionClass === "spark" ? dismissedSparkIdsRef : dismissedControlIdsRef;
    const setDismissed = sessionClass === "spark" ? setDismissedSparkIds : setDismissedControlIds;
    const nextDismissed = new Set(dismissedRef.current);
    for (const id of ids) nextDismissed.add(id);
    dismissedRef.current = nextDismissed;
    setDismissed(nextDismissed);
    setCompletedSignals((current) => {
      const next = new Set(current);
      for (const id of ids) next.delete(id);
      return next;
    });
    const seen = readStoredNumberRecord("forgedeck-completion-seen");
    for (const id of ids) seen[id] = Math.max(Date.now(), completionTimes[id] || 0);
    writeStoredJson("forgedeck-completion-seen", seen);
  };

  const updateSettings = (next: { model: string; effort: string }) => {
    if (!selectedId) return;
    setSettings((current) => ({ ...current, [selectedId]: next }));
  };

  const onCreated = async (thread: Thread, model: string, effort: string, sessionClass: SessionClass) => {
    setSettings((current) => ({ ...current, [thread.id]: { model, effort } }));
    if (sessionClass === "spark") addSpark(thread.id);
    else addControl(thread.id);
    setNewOpen(false);
    await loadThreads();
    setSelectedId(thread.id);
  };

  const logout = async () => {
    await api("/api/logout", { method: "POST" });
    setAuthenticated(false);
    setBootstrap(null);
  };

  const runUiAction = (action: () => Promise<void>) => {
    void action().catch((error) => showError(error, setToast));
  };

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="brand-row">
          <Brand />
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar"><PanelLeftClose size={19} /></button>
        </div>

        <button className="new-session" onClick={() => { setNewSessionClass("standard"); setNewOpen(true); }}><Plus size={18} /> New session <kbd>N</kbd></button>

        <div className="view-switch" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
          <button className={view === "session" ? "active" : ""} onClick={() => { setView("session"); setSidebarOpen(false); }}><MessageSquareText size={14} />{view === "session" ? "Session" : ""}</button>
          <button className={view === "control" ? "active" : ""} onClick={() => { setView("control"); setSidebarOpen(false); }}><LayoutGrid size={14} />{view === "control" ? "Control center" : ""}<span>{controlThreads.length}</span></button>
          <button className={view === "spark" ? "active" : ""} style={view === "spark" ? { color: "#f5c451", background: "rgba(245, 196, 81, .1)", boxShadow: "inset 0 0 0 1px rgba(245, 196, 81, .2)" } : undefined} onClick={() => { setView("spark"); setSidebarOpen(false); }}><Sparkles size={14} />{view === "spark" ? "SparkBoard" : ""}<span>{sparkThreads.length}</span></button>
        </div>

        <UsageCard usage={bootstrap.usage} plan={bootstrap.account.account?.planType} backendStatus={bootstrap.backendStatus} />

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
            <SessionCard key={thread.id} thread={thread} selected={view === "session" && thread.id === selectedId} pinned={pinned.has(thread.id)} inBoard={isSparkThread(thread) ? sparkIdSet.has(thread.id) : controlIdSet.has(thread.id)} completed={completedSignals.has(thread.id)}
              tokens={tokensForThread(thread, tokenUsage[thread.id])} onSelect={() => { setSelectedId(thread.id); setView("session"); markCompletionSeen(thread.id); }} onPin={() => togglePin(thread.id)} onBoard={() => isSparkThread(thread) ? toggleSpark(thread.id) : toggleControl(thread.id)} />
          ))}
          {!sortedThreads.length && <div className="empty-list"><MessageSquareText size={20} /><span>No sessions found</span></div>}
        </nav>

        <div className="account-row">
          <div className="avatar">{initials(bootstrap.account.account?.email || "Codex")}</div>
          <div><strong>{bootstrap.account.account?.email || "Local Codex"}</strong><span>{formatPlan(bootstrap.account.account?.planType)} plan</span></div>
          <button className="icon-button" onClick={() => runUiAction(logout)} title="Log out of ForgeDeck"><LogOut size={17} /></button>
        </div>
      </aside>
      {sidebarOpen && <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} />}

      <main className="main-panel">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar"><Menu size={20} /></button>
          {view === "control" ? <BoardHeader variant="control" count={controlThreads.length} activeCount={controlThreads.filter((thread) => thread.status.type === "active").length} /> : view === "spark" ? <BoardHeader variant="spark" count={sparkThreads.length} activeCount={sparkThreads.filter((thread) => thread.status.type === "active").length} /> : effectiveDetail ? <ThreadHeader thread={effectiveDetail} pinned={pinned.has(effectiveDetail.id)} onPin={() => togglePin(effectiveDetail.id)}
            onRename={() => runUiAction(async () => {
              const name = prompt("Session name", threadTitle(effectiveDetail));
              if (!name?.trim()) return;
              await api(`/api/threads/${effectiveDetail.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
              await Promise.all([loadThread(effectiveDetail.id), loadThreads()]);
            })}
            onOrganize={() => runUiAction(async () => {
              const category = window.prompt("Session category (blank clears it)", effectiveDetail.category || "");
              if (category === null) return;
              const tags = window.prompt("Tags, separated by commas (blank clears them)", (effectiveDetail.tags || []).join(", "));
              if (tags === null) return;
              await api(`/api/threads/${effectiveDetail.id}`, {
                method: "PATCH",
                body: JSON.stringify({ category, tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean) })
              });
              await Promise.all([loadThread(effectiveDetail.id), loadThreads()]);
            })}
            onArchive={() => runUiAction(async () => {
              if (!confirm("Archive this session? Its Codex history will be kept.")) return;
              const archivedId = effectiveDetail.id;
              const nextId = sortedThreads.find((thread) => thread.id !== archivedId)?.id || null;
              removedThreadIdsRef.current.add(archivedId);
              listRequestSequence.current += 1;
              setThreads((current) => current.filter((thread) => thread.id !== archivedId));
              setControlIds((current) => current.filter((id) => id !== archivedId));
              setSparkIds((current) => current.filter((id) => id !== archivedId));
              setSelectedId(nextId);
              setDetail(null);
              try {
                await api(`/api/threads/${archivedId}`, { method: "DELETE" });
                await loadThreads();
              } catch (error) {
                removedThreadIdsRef.current.delete(archivedId);
                await loadThreads().catch(() => undefined);
                showError(error, setToast);
              }
            })} /> : <div className="topbar-placeholder">Session workspace</div>}
          <AppPreferences pollInterval={pollInterval} onPollInterval={setPollInterval} theme={theme} onTheme={() => setTheme((current) => current === "dark" ? "light" : "dark")} />
          <div className={`runtime-pill ${runtime}`}><span />{runtime === "ready" ? "Runtime online" : "Reconnecting"}</div>
        </header>

        {view === "control" ? (
          <ControlCenter threads={controlThreads} allThreads={allStandardThreads} models={bootstrap.models.data} claudeModels={bootstrap.claudeModelOptions || EMPTY_CLAUDE_MODELS} settings={settings} defaultModel={defaultModel}
            liveText={liveText} liveToolOutput={liveToolOutput} liveItems={liveItems} queues={queues} activityVersion={activityVersion}
            tokenUsage={tokenUsage} pollInterval={controlThreads.some(isClaudeThread) ? CLAUDE_LIVE_POLL_MS : runtime === "ready" ? 0 : pollInterval}
            onSettings={(threadId, next) => setSettings((current) => ({ ...current, [threadId]: next }))}
            completedSignals={completedSignals} onOpen={(id) => { setSelectedId(id); setView("session"); markCompletionSeen(id); }} onRemove={removeControl}
            onAdd={addControl} onClearCompleted={() => clearCompleted("standard")}
            onError={(error) => showError(error, setToast)} />
        ) : view === "spark" ? (
          <SparkBoard threads={sparkThreads} allThreads={allSparkThreads} models={bootstrap.models.data} claudeModels={EMPTY_CLAUDE_MODELS} settings={settings} defaultModel={defaultModel}
            liveText={liveText} liveToolOutput={liveToolOutput} liveItems={liveItems} queues={queues} activityVersion={activityVersion}
            tokenUsage={tokenUsage} pollInterval={runtime === "ready" ? 0 : pollInterval}
            onSettings={(threadId, next) => setSettings((current) => ({ ...current, [threadId]: next }))}
            completedSignals={completedSignals} onOpen={(id) => { setSelectedId(id); setView("session"); markCompletionSeen(id); }} onRemove={removeSpark}
            onAdd={addSpark} onClearCompleted={() => clearCompleted("spark")} onLaunch={() => { setNewSessionClass("spark"); setNewOpen(true); }}
            onError={(error) => showError(error, setToast)} />
        ) : effectiveDetail ? (
          <Chat key={effectiveDetail.id} thread={effectiveDetail} loading={loadingDetail} liveText={liveText[effectiveDetail.id] || EMPTY_TEXT_STREAM} liveToolOutput={liveToolOutput[effectiveDetail.id] || EMPTY_TEXT_STREAM} liveItems={liveItems[effectiveDetail.id] || EMPTY_LIVE_ITEMS} queue={queues[effectiveDetail.id] || EMPTY_QUEUE} models={bootstrap.models.data} claudeModels={bootstrap.claudeModelOptions || EMPTY_CLAUDE_MODELS}
            settings={activeSettings!} onSettings={updateSettings} onRefresh={() => loadThread(effectiveDetail.id)} onError={(error) => showError(error, setToast)} />
        ) : (
          <Welcome onNew={() => { setNewSessionClass("standard"); setNewOpen(true); }} />
        )}
      </main>

      {newOpen && <NewSessionModal bootstrap={bootstrap} sessionClass={newSessionClass} onClose={() => setNewOpen(false)} onCreated={onCreated} onError={(error) => showError(error, setToast)} />}
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

type ProviderUsageRowProps = { icon: ReactNode; name: string; color: string; available: boolean; percent?: number | null; subscription?: boolean };

function ProviderUsageRow({ icon, name, color, available, percent = null, subscription = false }: ProviderUsageRowProps) {
  const statusColor = available ? color : "#737b87";
  return <div style={{ display: "grid", gridTemplateColumns: "16px 43px minmax(0, 1fr)", alignItems: "center", gap: 7, minHeight: 18 }}>
    <span style={{ display: "grid", placeItems: "center", color: statusColor }}>{icon}</span>
    <strong style={{ color: available ? "var(--text)" : statusColor, fontSize: 11 }}>{name}</strong>
    {!available ? <span style={{ color: statusColor, fontSize: 10, textAlign: "right" }}>Unavailable</span> : subscription ?
      <span title="Subscription-based" style={{ color, fontSize: 10, fontWeight: 700, textAlign: "right" }}>Active</span> :
      <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
        <span style={{ width: 30, color, fontSize: 10, fontWeight: 700, textAlign: "right" }}>{percent === null ? "—" : `${Math.round(percent)}%`}</span>
        <span style={{ flex: 1, height: 5, overflow: "hidden", borderRadius: 999, background: "rgba(127, 136, 148, .24)" }}>
          <span style={{ display: "block", width: `${percent ?? 0}%`, height: "100%", borderRadius: "inherit", background: color }} />
        </span>
      </span>}
  </div>;
}

function UsageCard({ usage, plan, backendStatus }: { usage: Usage | null; plan?: string; backendStatus?: Bootstrap["backendStatus"] }) {
  const legacyCodex = usage?.rateLimitsByLimitId?.codex || usage?.rateLimits;
  const clampPercent = (value?: number) => value === undefined ? null : Math.min(100, Math.max(0, value));
  const codexPercent = clampPercent(backendStatus?.codex.rateLimit?.primary?.usedPercent ?? legacyCodex?.primary?.usedPercent);
  const sparkPercent = clampPercent(backendStatus?.spark.rateLimit?.primary?.usedPercent);
  const claudePercent = clampPercent(backendStatus?.claude.rateLimit?.primary?.usedPercent);
  const codexAvailable = backendStatus?.codex.available ?? Boolean(legacyCodex?.primary);
  return <section className="usage-card">
    <div className="usage-top"><span><Gauge size={15} /> Usage</span><strong>{formatPlan(plan)}</strong></div>
    <div style={{ display: "grid", gap: 9 }}>
      <ProviderUsageRow icon={<Bot size={14} />} name="Codex" color="#6e9dff" available={codexAvailable} percent={codexPercent} />
      <ProviderUsageRow icon={<Sparkles size={14} />} name="Spark" color="#f5c451" available={backendStatus?.spark.available ?? false} percent={sparkPercent} />
      <ProviderUsageRow icon={<BrainCircuit size={14} />} name="Claude" color="#cf75ff" available={backendStatus?.claude.available ?? false} percent={claudePercent} />
    </div>
  </section>;
}

type SessionCardProps = { thread: Thread; selected: boolean; pinned: boolean; inBoard: boolean; completed: boolean; tokens: number | null; onSelect: () => void; onPin: () => void; onBoard: () => void };

const SessionCard = memo(function SessionCard({ thread, selected, pinned, inBoard, completed, tokens, onSelect, onPin, onBoard }: SessionCardProps) {
  const state = sessionVisualState(thread, completed);
  const running = state === "running";
  const spark = isSparkThread(thread);
  const claude = isClaudeThread(thread);
  return <button className={`session-card state-${state} ${selected ? "selected" : ""}`} style={spark ? { boxShadow: "inset 2px 0 rgba(245, 196, 81, .55)" } : claude ? { boxShadow: "inset 2px 0 rgba(201, 105, 255, .5)" } : undefined} onClick={onSelect}>
    <span className={`status-dot ${state === "running" ? "active" : state}`} />
    <span className="session-copy">
      <span className="session-title-row"><ThreadProviderIcon thread={thread} size={11} /><strong>{threadTitle(thread)}</strong>{(spark || claude) && <em style={providerBadgeStyle(thread)}>{spark ? "Spark" : "Claude"}</em>}<em className={`session-state ${state}`}>{sessionStateLabel(state)}</em></span>
      <small><Folder size={12} />{basename(thread.cwd)}<i>·</i>{timeAgo(thread.updatedAt)}</small>
      {(thread.category || thread.tags?.length) && <span className="session-labels">{thread.category && <b>{thread.category}</b>}{thread.tags?.slice(0, 2).map((tag) => <i key={tag}>{tag}</i>)}</span>}
      <span className="session-metrics"><span><Clock3 size={11} />{formatDuration(threadDurationSeconds(thread))}</span><span><Gauge size={11} />{tokens === null ? "— tokens" : `${formatTokenCount(tokens)} tokens`}</span></span>
    </span>
    <span className="session-actions" onClick={(event) => event.stopPropagation()}>
      {running && <LoaderCircle className="spin running-icon" size={14} />}
      <span role="button" tabIndex={0} onClick={onBoard} title={inBoard ? `Remove from ${spark ? "SparkBoard" : "Control Center"}` : `Add to ${spark ? "SparkBoard" : "Control Center"}`}>{spark ? <Sparkles size={14} style={inBoard ? { color: "#f5c451" } : undefined} /> : <LayoutGrid size={14} className={inBoard ? "control-active" : ""} />}</span>
      <span role="button" tabIndex={0} onClick={onPin} title={pinned ? "Unpin" : "Pin"}>{pinned ? <PinOff size={14} /> : <Pin size={14} />}</span>
    </span>
  </button>;
}, (previous, next) => previous.thread === next.thread
  && previous.selected === next.selected
  && previous.pinned === next.pinned
  && previous.inBoard === next.inBoard
  && previous.completed === next.completed
  && previous.tokens === next.tokens);

function AppPreferences({ pollInterval, onPollInterval, theme, onTheme }: { pollInterval: number; onPollInterval: (value: number) => void; theme: ThemeMode; onTheme: () => void }) {
  return <div className="app-preferences">
    <label className="poll-setting" title="Polling fallback interval (live events remain enabled)">
      <RefreshCw size={14} />
      <select value={pollInterval} onChange={(event) => onPollInterval(Number(event.target.value))} aria-label="Auto-refresh interval">
        <option value={0}>Live only</option>
        <option value={2000}>Refresh 2s</option>
        <option value={4000}>Refresh 4s</option>
        <option value={10000}>Refresh 10s</option>
        <option value={30000}>Refresh 30s</option>
      </select>
    </label>
    <button className="icon-button theme-toggle" onClick={onTheme} title={`Use ${theme === "dark" ? "light" : "dark"} theme`} aria-label={`Use ${theme === "dark" ? "light" : "dark"} theme`}>
      {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
    </button>
  </div>;
}

function ThreadHeader({ thread, pinned, onPin, onRename, onOrganize, onArchive }: { thread: Thread; pinned: boolean; onPin: () => void; onRename: () => void; onOrganize: () => void; onArchive: () => void }) {
  return <div className="thread-header">
    <div className="thread-title"><div className="thread-icon" style={providerIconContainerStyle(thread)}><ThreadProviderIcon thread={thread} size={18} /></div><div><strong>{threadTitle(thread)}</strong><span><FolderOpen size={13} />{thread.cwd}{thread.gitInfo?.branch && <><i>·</i><GitBranch size={12} />{thread.gitInfo.branch}</>}{thread.category && <><i>·</i><b>{thread.category}</b></>}{thread.tags?.map((tag) => <em key={tag}>#{tag}</em>)}</span></div></div>
    <div className="header-actions"><button className="icon-button" onClick={onPin} title={pinned ? "Unpin" : "Pin"}>{pinned ? <PinOff size={17} /> : <Pin size={17} />}</button><button className="icon-button" onClick={onOrganize} title="Edit category and tags"><Tags size={17} /></button><button className="icon-button" onClick={onRename} title="Rename"><Settings2 size={17} /></button><button className="icon-button" onClick={onArchive} title="Archive"><Archive size={17} /></button></div>
  </div>;
}

function BoardHeader({ variant, count, activeCount }: { variant: BoardVariant; count: number; activeCount: number }) {
  const spark = variant === "spark";
  return <div className="control-header">
    <div className="control-header-icon" style={spark ? { color: "#f5c451", background: "rgba(245, 196, 81, .09)", borderColor: "rgba(245, 196, 81, .22)" } : undefined}>{spark ? <Sparkles size={18} /> : <LayoutGrid size={18} />}</div>
    <div><strong>{spark ? "SparkBoard" : "Control Center"}</strong><span>{count} session{count === 1 ? "" : "s"} on deck <i>·</i> <b style={spark ? { color: "#f5c451" } : undefined}>{activeCount} active now</b></span></div>
  </div>;
}

type ControlCenterProps = {
  threads: Thread[]; allThreads: Thread[]; models: CodexModel[]; claudeModels: ClaudeModelOption[]; settings: ThreadSettings; defaultModel?: CodexModel;
  liveText: LiveStreams; liveToolOutput: LiveStreams; liveItems: LiveItems; queues: Record<string, QueueEntry[]>; completedSignals: Set<string>; tokenUsage: Record<string, ThreadTokenUsage>; activityVersion: number; pollInterval: number;
  onSettings: (threadId: string, value: { model: string; effort: string }) => void;
  onOpen: (threadId: string) => void; onRemove: (threadId: string) => void; onAdd: (threadId: string) => void; onClearCompleted: () => void; onError: (error: unknown) => void;
  onLaunch?: () => void;
};

type SessionBoardProps = ControlCenterProps & { variant: BoardVariant };

const SessionBoard = memo(function SessionBoard({ variant, threads, allThreads, models, claudeModels, settings, defaultModel, liveText, liveToolOutput, liveItems, queues, completedSignals, tokenUsage, activityVersion, pollInterval, onSettings, onOpen, onRemove, onAdd, onClearCompleted, onLaunch, onError }: SessionBoardProps) {
  const spark = variant === "spark";
  const columns = useControlColumns();
  const pageSize = columns * 2;
  const [page, setPage] = useState(0);
  const [details, setDetails] = useState<Record<string, Thread>>({});
  const [reload, setReload] = useState(0);
  const errorRef = useRef(onError);
  const refreshSequence = useRef(0);
  const pageCount = Math.max(1, Math.ceil(threads.length / pageSize));
  const pageThreads = useMemo(() => threads.slice(page * pageSize, page * pageSize + pageSize), [page, pageSize, threads]);
  const idsKey = pageThreads.map((thread) => thread.id).join(",");
  const pageThreadIds = useMemo(() => pageThreads.map((thread) => thread.id), [pageThreads]);
  const available = useMemo(() => {
    const shownIds = new Set(threads.map((thread) => thread.id));
    return allThreads.filter((thread) => !shownIds.has(thread.id));
  }, [allThreads, threads]);
  const completedCount = useMemo(() => allThreads.filter((thread) => completedSignals.has(thread.id) && thread.status.type !== "active").length, [allThreads, completedSignals]);

  useEffect(() => { errorRef.current = onError; }, [onError]);
  useEffect(() => { if (page >= pageCount) setPage(pageCount - 1); }, [page, pageCount]);

  const refresh = useCallback(async () => {
    if (!pageThreadIds.length) return;
    const requestId = ++refreshSequence.current;
    const response = await api<{ results: Array<{ threadId: string; ok: boolean; value?: Thread }> }>("/api/threads/batch", {
      method: "POST",
      body: JSON.stringify({ operation: "read", threadIds: pageThreadIds })
    });
    if (requestId !== refreshSequence.current) return;
    setDetails((current) => {
      let next = current;
      for (const snapshot of response.results) {
        if (!snapshot.ok || !snapshot.value || sameThreadSnapshot(current[snapshot.value.id], snapshot.value)) continue;
        if (next === current) next = { ...current };
        next[snapshot.value.id] = snapshot.value;
      }
      return next;
    });
  // idsKey intentionally represents the current page's stable set of threads.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  useEffect(() => { void refresh().catch((error) => errorRef.current(error)); }, [refresh, activityVersion, reload]);
  useEffect(() => {
    if (pollInterval === 0) return;
    const timer = window.setInterval(() => void refresh().catch(() => undefined), pollInterval);
    return () => clearInterval(timer);
  }, [refresh, pollInterval]);

  const visibleColumns = Math.max(1, Math.min(columns, pageThreads.length));
  const visibleRows = Math.max(1, Math.ceil(pageThreads.length / visibleColumns));
  const displayThreads = useMemo(() => pageThreads.map((summary) => {
    const snapshot = details[summary.id];
    if (!snapshot) return summary;
    if (isClaudeThread(snapshot)) return snapshot;
    return sameThreadStatus(snapshot.status, summary.status) ? snapshot : { ...snapshot, status: summary.status };
  }), [details, pageThreads]);
  const requestRefresh = useCallback(() => setReload((value) => value + 1), []);

  return <section className="control-center" data-board={variant}>
    <div className="control-toolbar">
      <div><span className="live-beacon"><i />LIVE</span><p>Agent messages stream live. Completed panels close after 15 minutes.</p></div>
      <div className="control-toolbar-actions">
        <button className="clear-completed" onClick={onClearCompleted} disabled={completedCount === 0} title="Remove completed panels and acknowledge their notifications"><Trash2 size={13} /><span>Clear completed</span>{completedCount > 0 && <b>{completedCount}</b>}</button>
        {spark && onLaunch && <button className="clear-completed" style={{ color: "#f5c451", borderColor: "rgba(245, 196, 81, .28)", background: "rgba(245, 196, 81, .07)" }} onClick={onLaunch}><Sparkles size={13} /><span>Launch Spark session</span></button>}
        {!spark && available.length > 0 && <label className="add-panel"><Plus size={14} /><select value="" onChange={(event) => { if (event.target.value) onAdd(event.target.value); }}><option value="">Add session</option>{available.map((thread) => <option key={thread.id} value={thread.id}>{threadTitle(thread)}</option>)}</select></label>}
        <button className="icon-button" onClick={requestRefresh} title="Refresh panels"><RefreshCw size={16} /></button>
      </div>
    </div>

    {pageThreads.length ? <div className="control-grid" style={{ "--control-columns": visibleColumns, "--control-rows": visibleRows } as React.CSSProperties}>
      {displayThreads.map((thread) => {
        const threadSettings = settings[thread.id] || defaultSettingsForThread(thread, models, claudeModels, defaultModel);
        return <ControlCard key={thread.id} thread={thread} variant={variant} models={models} claudeModels={claudeModels} settings={threadSettings}
          liveText={liveText[thread.id] || EMPTY_TEXT_STREAM} liveToolOutput={liveToolOutput[thread.id] || EMPTY_TEXT_STREAM} liveItems={liveItems[thread.id] || EMPTY_LIVE_ITEMS} queue={queues[thread.id] || EMPTY_QUEUE} completed={completedSignals.has(thread.id)}
          tokens={tokensForThread(thread, tokenUsage[thread.id])}
          onSettings={onSettings} onOpen={onOpen} onRemove={onRemove}
          onRefresh={requestRefresh} onError={onError} />;
      })}
    </div> : spark ? <div className="control-empty"><Sparkles size={32} color="#f5c451" /><span style={{ marginTop: 14, color: "#8d762d", fontSize: 8, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase" }}>No spark sessions</span><h2>SparkBoard — Quick task fleet</h2><p>Launch a spark session for fast, lightweight tasks.</p>{onLaunch && <button className="primary-button" style={{ marginTop: 18, background: "#b88919", borderColor: "#d5ad3f" }} onClick={onLaunch}><Sparkles size={16} />Launch Spark session</button>}</div> : <div className="control-empty"><LayoutGrid size={28} /><h2>No sessions on deck</h2><p>Create a session or add one from the session list to start your Control Center.</p></div>}

    {pageCount > 1 && <div className="control-pages"><button disabled={page === 0} onClick={() => setPage((value) => value - 1)}><ArrowLeft size={14} />Previous</button><span>Page {page + 1} of {pageCount} · {columns} across × 2 rows</span><button disabled={page >= pageCount - 1} onClick={() => setPage((value) => value + 1)}>Next<ChevronRight size={14} /></button></div>}
  </section>;
}, (previous, next) => previous.variant === next.variant
  && previous.threads === next.threads
  && previous.allThreads === next.allThreads
  && previous.models === next.models
  && previous.claudeModels === next.claudeModels
  && previous.settings === next.settings
  && previous.defaultModel === next.defaultModel
  && previous.liveText === next.liveText
  && previous.liveToolOutput === next.liveToolOutput
  && previous.liveItems === next.liveItems
  && previous.queues === next.queues
  && previous.completedSignals === next.completedSignals
  && previous.tokenUsage === next.tokenUsage
  && previous.activityVersion === next.activityVersion
  && previous.pollInterval === next.pollInterval);

const ControlCenter = memo(function ControlCenter(props: ControlCenterProps) {
  return <SessionBoard {...props} variant="control" />;
});

const SparkBoard = memo(function SparkBoard(props: ControlCenterProps) {
  return <SessionBoard {...props} variant="spark" />;
});

type ControlCardProps = {
  thread: Thread; variant: BoardVariant; models: CodexModel[]; claudeModels: ClaudeModelOption[]; settings: { model: string; effort: string };
  liveText: Record<string, string>; liveToolOutput: Record<string, string>; liveItems: Record<string, ThreadItem>; queue: QueueEntry[]; completed: boolean; tokens: number | null;
  onSettings: (threadId: string, value: { model: string; effort: string }) => void; onOpen: (threadId: string) => void; onRemove: (threadId: string) => void; onRefresh: () => void; onError: (error: unknown) => void;
};

const ControlCard = memo(function ControlCard({ thread, variant, models, claudeModels, settings, liveText, liveToolOutput, liveItems, queue, completed, tokens, onSettings, onOpen, onRemove, onRefresh, onError }: ControlCardProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const assist = useComposerAssist(text, setText, thread.cwd);
  const body = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const claude = isClaudeThread(thread);
  const spark = variant === "spark" || isSparkThread(thread);
  const model = models.find((item) => item.model === settings.model) || models[0];
  const runningTurn = useMemo(() => [...(thread.turns || [])].reverse().find((turn) => turn.status === "inProgress"), [thread.turns]);
  const historyItems = useMemo(() => (thread.turns || []).flatMap((turn) => turn.items), [thread.turns]);
  const historyIds = useMemo(() => new Set(historyItems.map((item) => item.id).filter(Boolean)), [historyItems]);
  const streamingText = useMemo(() => Object.entries(liveText).filter(([id]) => !historyIds.has(id)), [historyIds, liveText]);
  const allItems = useMemo(() => [...historyItems, ...unseenLiveItems(historyItems, Object.values(liveItems)).filter((item) =>
    !(item.type === "agentMessage" && item.id && liveText[item.id])
  )], [historyItems, liveItems, liveText]);
  const items = useMemo(() => selectControlItems(allItems, 12), [allItems]);
  const toolCount = useMemo(() => items.filter((item) => isToolItem(item)).length, [items]);
  const running = thread.status.type === "active" || Boolean(runningTurn);
  const state = running ? "running" : sessionVisualState(thread, completed);
  const successfullyCompleted = state === "completed";

  const onFeedScroll = useCallback(() => {
    const element = body.current;
    if (element) stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
  }, []);
  useEffect(() => {
    if (!stickToBottom.current) return;
    const frame = requestAnimationFrame(() => {
      const element = body.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [items, liveToolOutput, streamingText]);

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
    if (claude || spark) return;
    const next = models.find((item) => item.model === modelId);
    if (next) onSettings(thread.id, { model: next.model, effort: next.defaultReasoningEffort });
  };

  const effortOptions = claude ? CLAUDE_EFFORTS : spark ? ["high"] : model?.supportedReasoningEfforts.map((option) => option.reasoningEffort) || [];

  return <article className={`control-card state-${state} ${running ? "running" : ""} ${successfullyCompleted ? "completed" : ""}`} style={controlCardAccentStyle(thread, variant)}>
    <header>
      <button className="control-title" onClick={() => onOpen(thread.id)}><span className={`status-dot ${state === "running" ? "active" : state}`} /><span><strong style={{ display: "flex", alignItems: "center", gap: 4 }}><ThreadProviderIcon thread={thread} size={11} /><span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{threadTitle(thread)}</span></strong><small><Folder size={11} />{basename(thread.cwd)}</small></span></button>
      <div className="control-card-actions"><span className={`done-label ${state}`}><b style={{ color: providerAccent(thread), font: "inherit" }}>{providerLabel(thread)}</b><i style={{ margin: "0 3px", opacity: .55, fontStyle: "normal" }}>·</i>{sessionStateLabel(state)}</span><PolicyButton thread={thread} running={running} onRefresh={onRefresh} onError={onError} compact />{queue.length > 0 && <span className="queue-count"><ListPlus size={11} />{queue.length}</span>}{toolCount > 0 && <span className="tool-count"><Command size={11} />{toolCount}</span>}<button onClick={() => onOpen(thread.id)} title="Open full session"><ChevronRight size={16} /></button><button onClick={() => onRemove(thread.id)} title={`Remove from ${spark ? "SparkBoard" : "Control Center"}`}><X size={15} /></button></div>
    </header>
    {thread.goal && <button type="button" className={`control-goal ${thread.goal.status}`} onClick={() => onOpen(thread.id)} title={thread.goal.objective}><Target size={11} /><span>{thread.goal.objective}</span><em>{goalStatusLabel(thread.goal.status)}</em></button>}
    <div className="control-metrics"><span><Clock3 size={10} />{formatDuration(threadDurationSeconds(thread))}</span><span><Gauge size={10} />{tokens === null ? "Token usage unavailable" : `${formatTokenCount(tokens)} tokens`}</span></div>
    <div className="control-feed" ref={body} onScroll={onFeedScroll}>
      {!items.length && !streamingText.some(([, value]) => Boolean(value)) && <div className="control-waiting"><ThreadProviderIcon thread={thread} size={21} /><span>{running ? `${providerLabel(thread)} is starting…` : "Waiting for a task"}</span></div>}
      {items.map((item, index) => <CompactItem key={item.id || `${item.type}-${index}`} item={item} provider={thread.backend} liveOutput={item.id ? liveToolOutput[item.id] : undefined} />)}
      {streamingText.map(([id, value]) => value && <div className="compact-message agent live" key={id}><span><ThreadProviderIcon thread={thread} size={12} /></span><div><ReactMarkdown>{value}</ReactMarkdown><i className="typing-cursor" /></div></div>)}
      {running && !streamingText.some(([, value]) => Boolean(value)) && <div className="compact-thinking"><LoaderCircle className="spin" size={13} />{providerLabel(thread)} working…</div>}
    </div>
    <div className="control-models"><select value={settings.model} disabled={claude || spark} onChange={(event) => changeModel(event.target.value)}>{claude ? claudeModels.map((item) => <option key={item.id} value={item.model}>{item.displayName}</option>) : spark ? <option value={SPARK_MODEL}>GPT-5.3 Codex Spark</option> : models.map((item) => <option key={item.id} value={item.model}>{item.displayName}</option>)}</select><select value={settings.effort} disabled={spark} onChange={(event) => onSettings(thread.id, { ...settings, effort: event.target.value })}>{effortOptions.map((effort) => <option key={effort} value={effort}>{EFFORT_LABELS[effort] || effort}</option>)}</select></div>
    {queue.length > 0 && <div className="control-queue"><span><ListPlus size={11} />Queued next</span>{queue.map((entry, index) => <div key={entry.id}><b>{index + 1}</b><em title={entry.text}>{entry.text}</em><button type="button" onClick={() => void api(`/api/threads/${thread.id}/queue/${entry.id}`, { method: "DELETE" }).catch(onError)} title="Remove queued task"><X size={11} /></button></div>)}</div>}
    <form className="control-composer" onSubmit={send}>
      <ComposerAssist suggestions={assist.suggestions} activeIndex={assist.activeIndex} onChoose={assist.choose} compact />
      <input value={text} onChange={(event) => setText(event.target.value)} onKeyDown={assist.onKeyDown} placeholder={running ? "Queue the next task…" : "Send a task…"} />
      <button className={running ? "queue" : ""} disabled={!text.trim() || sending} title={running ? "Queue next task" : "Send"}>{sending ? <LoaderCircle className="spin" size={14} /> : running ? <ListPlus size={14} /> : <Send size={14} />}</button>
      {running && <button type="button" className="stop" onClick={() => void stopThread(thread.id, onRefresh, onError)} title="Stop active turn"><CircleStop size={15} /></button>}
    </form>
  </article>;
}, (previous, next) => previous.thread === next.thread
  && previous.variant === next.variant
  && previous.models === next.models
  && previous.claudeModels === next.claudeModels
  && previous.settings === next.settings
  && previous.liveText === next.liveText
  && previous.liveToolOutput === next.liveToolOutput
  && previous.liveItems === next.liveItems
  && previous.queue === next.queue
  && previous.completed === next.completed
  && previous.tokens === next.tokens);

const CompactItem = memo(function CompactItem({ item, provider = "codex", liveOutput }: { item: ThreadItem; provider?: Thread["backend"]; liveOutput?: string }) {
  const providerName = provider === "claude" ? "Claude" : "Codex";
  if (item.type === "userMessage") {
    const text = item.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") || "";
    return <div className="compact-message user"><div>{text}</div><span>YOU</span></div>;
  }
  if (item.type === "agentMessage") return <div className="compact-message agent"><span>{provider === "claude" ? <BrainCircuit size={12} /> : <Bot size={12} />}</span><div><ReactMarkdown>{item.text || ""}</ReactMarkdown></div></div>;
  if (item.type === "reasoning") return <details className="compact-reasoning"><summary><BrainCircuit size={12} />Reasoning</summary><p>{item.summary?.join("\n")}</p></details>;
  if (item.type === "plan") return <div className="compact-tool plan"><LayoutGrid size={13} /><span><strong>Plan updated</strong><small>{truncate(item.text || "", 140)}</small></span></div>;
  if (item.type === "commandExecution") return <details className={`compact-tool ${item.status || ""}`} {...(item.status === "inProgress" ? { open: true } : {})}><summary><TerminalSquare size={13} /><span><strong>Command</strong><small>{item.command}</small></span><em>{item.status}</em></summary>{(item.aggregatedOutput || liveOutput) && <pre>{item.aggregatedOutput || liveOutput}</pre>}</details>;
  if (item.type === "fileChange") return <details className={`compact-tool ${item.status || ""}`} open><summary><Code2 size={13} /><span><strong>File changes</strong><small>{item.changes?.length || 0} file update{item.changes?.length === 1 ? "" : "s"}</small></span><em>{item.status}</em></summary><DiffView changes={item.changes || []} compact /></details>;
  if (isToolItem(item)) return <details className={`compact-tool ${String(item.status || "completed")}`}><summary><Command size={13} /><span><strong>{item.tool ? String(item.tool) : toolLabel(item.type)}</strong><small>{item.server ? String(item.server) : `${providerName} tool`}</small></span><em>{String(item.status || "completed")}</em></summary><pre>{JSON.stringify(item.result || item.error || item.arguments || item, null, 2)}</pre></details>;
  return null;
});

type ChatProps = {
  thread: Thread; loading: boolean; liveText: Record<string, string>; liveToolOutput: Record<string, string>; liveItems: Record<string, ThreadItem>; queue: QueueEntry[]; models: CodexModel[]; claudeModels: ClaudeModelOption[];
  settings: { model: string; effort: string }; onSettings: (value: { model: string; effort: string }) => void;
  onRefresh: () => Promise<void>; onError: (error: unknown) => void;
};

const Chat = memo(function Chat({ thread, loading, liveText, liveToolOutput, liveItems, queue, models, claudeModels, settings, onSettings, onRefresh, onError }: ChatProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const assist = useComposerAssist(text, setText, thread.cwd);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const claude = isClaudeThread(thread);
  const spark = isSparkThread(thread);
  const providerName = providerLabel(thread);
  const selectedModel = models.find((model) => model.model === settings.model) || models[0];
  const runningTurn = useMemo(() => [...thread.turns].reverse().find((turn) => turn.status === "inProgress"), [thread.turns]);
  const running = thread.status.type === "active" || Boolean(runningTurn);
  const historyItems = useMemo(() => thread.turns.flatMap((turn) => turn.items), [thread.turns]);
  const historyIds = useMemo(() => new Set(historyItems.map((item) => item.id).filter(Boolean)), [historyItems]);
  const streamingText = useMemo(() => Object.entries(liveText).filter(([id]) => !historyIds.has(id)), [historyIds, liveText]);
  const immediateItems = useMemo(() => unseenLiveItems(historyItems, Object.values(liveItems)).filter((item) =>
    !(item.type === "agentMessage" && item.id && liveText[item.id])
  ), [historyItems, liveItems, liveText]);

  const onTranscriptScroll = useCallback(() => {
    const element = scroller.current;
    if (element) stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  }, []);
  useEffect(() => {
    if (!stickToBottom.current) return;
    const frame = requestAnimationFrame(() => {
      const element = scroller.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [immediateItems, liveToolOutput, streamingText, thread.turns]);

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
    if (claude || spark) return;
    const model = models.find((item) => item.model === modelId)!;
    onSettings({ model: model.model, effort: model.defaultReasoningEffort });
  };

  const effortOptions = claude ? CLAUDE_EFFORTS : spark ? ["high"] : selectedModel?.supportedReasoningEfforts.map((option) => option.reasoningEffort) || [];

  return <div className="chat-layout">
    <div className="transcript" ref={scroller} onScroll={onTranscriptScroll}>
      {loading && <div className="transcript-loading"><LoaderCircle className="spin" /> Loading session history…</div>}
      {!loading && !thread.turns.length && <div className="empty-chat"><div><Sparkles size={26} /></div><h2>Ready at the forge</h2><p>Send the first task. It will keep running here even if you close this browser.</p></div>}
      {thread.turns.map((turn) => <TurnView key={turn.id} turn={turn} provider={thread.backend} liveToolOutput={liveToolOutput} />)}
      {immediateItems.map((item, index) => <ItemView key={item.id || `live-${index}`} item={item} provider={thread.backend} liveOutput={item.id ? liveToolOutput[item.id] : undefined} />)}
      {streamingText.map(([id, value]) => value && <div className="message agent live" key={id}><div className="message-avatar" style={claude ? { color: "#cf75ff", background: "rgba(126, 54, 160, .13)", borderColor: "rgba(201, 105, 255, .3)" } : spark ? { color: "#f5c451", background: "rgba(153, 113, 20, .12)", borderColor: "rgba(245, 196, 81, .28)" } : undefined}><ThreadProviderIcon thread={thread} size={16} /></div><div className="message-body"><div className="message-meta">{providerName} <span>working now</span></div><ReactMarkdown>{value}</ReactMarkdown><span className="typing-cursor" /></div></div>)}
      {runningTurn && !streamingText.some(([, value]) => Boolean(value)) && <div className="thinking-line"><LoaderCircle className="spin" size={17} /><span>{providerName} is working</span><i /><i /><i /></div>}
    </div>

    <div className="composer-zone">
      {thread.goal && <GoalBar thread={thread} onRefresh={onRefresh} onError={onError} />}
      {queue.length > 0 && <div className="queue-strip"><div><ListPlus size={14} /><strong>{queue.length} queued</strong><span>Runs automatically after the current turn</span></div><div>{queue.map((entry, index) => <div className="queue-entry" key={entry.id}><b>{index + 1}</b><span>{entry.text}</span><button onClick={() => void api(`/api/threads/${thread.id}/queue/${entry.id}`, { method: "DELETE" }).catch(onError)} title="Remove queued task"><X size={13} /></button></div>)}</div></div>}
      <form className="composer" onSubmit={submit}>
        <ComposerAssist suggestions={assist.suggestions} activeIndex={assist.activeIndex} onChoose={assist.choose} />
        <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder={running ? `Queue the next task while ${providerName} works…` : `Give ${providerName} a task…`}
          rows={3} onKeyDown={(event) => { if (assist.onKeyDown(event)) return; if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        <div className="composer-footer">
          <div className="model-controls">
            <label>{claude ? <BrainCircuit size={14} /> : spark ? <Sparkles size={14} /> : <Bot size={14} />}<select value={settings.model} disabled={claude || spark} onChange={(event) => changeModel(event.target.value)}>{claude ? claudeModels.map((model) => <option key={model.id} value={model.model}>{model.displayName}</option>) : spark ? <option value={SPARK_MODEL}>GPT-5.3 Codex Spark</option> : models.map((model) => <option key={model.id} value={model.model}>{model.displayName}</option>)}</select></label>
            <label><BrainCircuit size={14} /><select value={settings.effort} disabled={spark} onChange={(event) => onSettings({ ...settings, effort: event.target.value })}>{effortOptions.map((effort) => <option key={effort} value={effort}>{EFFORT_LABELS[effort] || effort}</option>)}</select></label>
            <PolicyButton thread={thread} running={running} onRefresh={onRefresh} onError={onError} />
          </div>
          <div className="composer-actions">{running && <button type="button" className="stop-button" onClick={() => void stopThread(thread.id, onRefresh, onError)}><CircleStop size={16} /> Stop</button>}
            <button className={`send-button ${running ? "queue" : ""}`} disabled={!text.trim() || sending}>{sending ? <LoaderCircle className="spin" size={17} /> : running ? <ListPlus size={16} /> : <Send size={16} />}<span>{running ? "Queue" : "Send"}</span></button></div>
        </div>
      </form>
      <p className="persistence-note"><Server size={12} />Safe to close this tab — work continues on the host.</p>
    </div>
  </div>;
}, (previous, next) => previous.thread === next.thread
  && previous.loading === next.loading
  && previous.liveText === next.liveText
  && previous.liveToolOutput === next.liveToolOutput
  && previous.liveItems === next.liveItems
  && previous.queue === next.queue
  && previous.models === next.models
  && previous.claudeModels === next.claudeModels
  && previous.settings === next.settings);

function PolicyButton({ thread, running, onRefresh, onError, compact = false }: { thread: Thread; running: boolean; onRefresh: () => void | Promise<void>; onError: (error: unknown) => void; compact?: boolean }) {
  if (isClaudeThread(thread)) {
    const mode = thread.claudePermissionMode || "default";
    const plan = mode === "plan";
    const bypass = mode === "bypassPermissions";
    return <button type="button" className={`policy-button ${bypass ? "yolo" : "workspace"} ${compact ? "compact" : ""}`} disabled title={plan ? "Claude plan mode: read and plan only" : bypass ? "Claude bypassPermissions mode" : "Claude workspace-write sandbox"} style={plan ? { color: "#9d85ff", borderColor: "rgba(157, 133, 255, .28)", background: "rgba(157, 133, 255, .07)" } : undefined}>{plan ? <FileText size={compact ? 11 : 13} /> : <ShieldCheck size={compact ? 11 : 13} />}<span>{plan ? "PLAN" : bypass ? "YOLO" : compact ? "SAFE" : "Workspace"}</span></button>;
  }
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

const TurnView = memo(function TurnView({ turn, provider, liveToolOutput = EMPTY_TEXT_STREAM }: { turn: Thread["turns"][number]; provider?: Thread["backend"]; liveToolOutput?: Record<string, string> }) {
  return <div className={`turn ${turn.status}`}>
    {turn.items.map((item, index) => <ItemView key={item.id || `${item.type}-${index}`} item={item} provider={provider} liveOutput={item.id ? liveToolOutput[item.id] : undefined} />)}
    {turn.status === "failed" && <div className="turn-error">{turn.error?.message || "This turn failed."}</div>}
  </div>;
}, (previous, next) => previous.turn === next.turn && previous.provider === next.provider && previous.turn.items.every((item) => !item.id || previous.liveToolOutput?.[item.id] === next.liveToolOutput?.[item.id]));

const ItemView = memo(function ItemView({ item, provider = "codex", liveOutput }: { item: ThreadItem; provider?: Thread["backend"]; liveOutput?: string }) {
  const providerName = provider === "claude" ? "Claude" : "Codex";
  if (item.type === "userMessage") {
    const text = item.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") || "";
    return <div className="message user"><div className="message-body"><div className="message-meta">You</div><p>{text}</p></div><div className="message-avatar">YOU</div></div>;
  }
  if (item.type === "agentMessage") return <div className="message agent"><div className="message-avatar" style={provider === "claude" ? { color: "#cf75ff", background: "rgba(126, 54, 160, .13)", borderColor: "rgba(201, 105, 255, .3)" } : undefined}>{provider === "claude" ? <BrainCircuit size={16} /> : <Bot size={16} />}</div><div className="message-body"><div className="message-meta">{providerName}</div><ReactMarkdown>{item.text || ""}</ReactMarkdown></div></div>;
  if (item.type === "reasoning") return <details className="reasoning-item"><summary><BrainCircuit size={15} />Reasoning <ChevronRight size={14} /></summary><div>{item.summary?.map((part, index) => <ReactMarkdown key={index}>{part}</ReactMarkdown>)}</div></details>;
  if (item.type === "commandExecution") return <details className="tool-item" {...(item.status === "inProgress" ? { open: true } : {})}><summary><TerminalSquare size={15} /><span><strong>Command</strong><code>{item.command}</code></span><em className={item.status}>{item.status}</em></summary>{(item.aggregatedOutput || liveOutput) && <pre>{item.aggregatedOutput || liveOutput}</pre>}</details>;
  if (item.type === "fileChange") return <details className="tool-item" open><summary><Code2 size={15} /><span><strong>Files changed</strong><code>{item.changes?.length || 0} update{item.changes?.length === 1 ? "" : "s"}</code></span><em className={item.status}>{item.status}</em></summary><DiffView changes={item.changes || []} /></details>;
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") return <details className="tool-item"><summary><Command size={15} /><span><strong>{item.tool || "Tool call"}</strong><code>{item.server || `${providerName} tool`}</code></span><em className={item.status}>{item.status}</em></summary><pre>{JSON.stringify(item.result || item.error || item.arguments, null, 2)}</pre></details>;
  if (item.type === "plan") return <div className="plan-item"><LayoutGrid size={15} /><ReactMarkdown>{item.text || ""}</ReactMarkdown></div>;
  if (["contextCompaction", "enteredReviewMode", "exitedReviewMode"].includes(item.type)) return null;
  return <details className="tool-item generic-tool"><summary><Sparkles size={15} /><span><strong>{toolLabel(item.type)}</strong><code>{item.id || `${providerName} activity`}</code></span><em className={String(item.status || "completed")}>{String(item.status || "completed")}</em></summary><pre>{JSON.stringify(item, null, 2)}</pre></details>;
});

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

function NewSessionModal({ bootstrap, sessionClass = "standard", onClose, onCreated, onError }: { bootstrap: Bootstrap; sessionClass?: SessionClass; onClose: () => void; onCreated: (thread: Thread, model: string, effort: string, sessionClass: SessionClass) => Promise<void>; onError: (error: unknown) => void }) {
  const spark = sessionClass === "spark";
  const defaultModel = bootstrap.models.data.find((model) => model.isDefault) || bootstrap.models.data[0];
  const claudeModels = bootstrap.claudeModelOptions || [];
  const claudeAvailable = bootstrap.claudeAvailable === true && claudeModels.length > 0;
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [tags, setTags] = useState("");
  const [prompt, setPrompt] = useState("");
  const [backend, setBackend] = useState<SessionBackend>("codex");
  const [model, setModel] = useState(spark ? SPARK_MODEL : defaultModel?.model || "");
  const [effort, setEffort] = useState(spark ? "high" : defaultModel?.defaultReasoningEffort || "medium");
  const [yolo, setYolo] = useState(false);
  const [claudePermissionMode, setClaudePermissionMode] = useState<ClaudePermissionMode>("default");
  const [browser, setBrowser] = useState<{ path: string | null; parent: string | null; entries: Array<{ name: string; path: string }> } | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selectedCodexModel = bootstrap.models.data.find((item) => item.model === model) || defaultModel;
  const selectedClaudeModel = claudeModels.find((item) => item.model === model) || claudeModels[0];
  const effortOptions = spark ? ["high"] : backend === "claude" ? CLAUDE_EFFORTS : selectedCodexModel?.supportedReasoningEfforts.map((option) => option.reasoningEffort) || [];

  const chooseBackend = (next: SessionBackend) => {
    if (spark || next === backend || (next === "claude" && !claudeAvailable)) return;
    setBackend(next);
    if (next === "claude") {
      setModel(claudeModels[0].model);
      setEffort("high");
      return;
    }
    setModel(defaultModel?.model || "");
    setEffort(defaultModel?.defaultReasoningEffort || "medium");
  };

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
      const response = await api<{ thread: Thread }>("/api/threads", {
        method: "POST",
        body: JSON.stringify({
          cwd: selectedPath,
          model: spark ? SPARK_MODEL : model,
          effort: spark ? "high" : effort,
          name,
          category,
          tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
          prompt,
          backend: spark ? "codex" : backend,
          class: sessionClass,
          ...(backend === "claude" && !spark ? { permissionMode: claudePermissionMode } : { yolo })
        })
      });
      await onCreated(response.thread, spark ? SPARK_MODEL : model, spark ? "high" : effort, sessionClass);
    } catch (error) { onError(error); } finally { setBusy(false); }
  };

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="new-modal" onSubmit={submit}>
      <div className="modal-header"><div><span className="eyebrow" style={spark ? { color: "#f5c451" } : backend === "claude" ? { color: "#cf75ff" } : undefined}>{spark ? "NEW SPARK SESSION" : backend === "claude" ? "NEW CLAUDE SESSION" : "NEW CODEX SESSION"}</span><h2>{spark ? "Launch a quick task" : "Choose your launch settings"}</h2></div><button type="button" className="icon-button" onClick={onClose}><X size={19} /></button></div>
      <div className="new-grid">
        <section className="directory-picker">
          <div className="section-label"><FolderOpen size={15} />Workspace directory</div>
          <div className="path-bar"><button type="button" disabled={!browser?.parent} onClick={() => { if (browser?.parent) void browse(browser.parent).catch(onError); }}><ArrowLeft size={15} /></button><span title={browser?.path || "Workspace roots"}>{browser?.path || "Available roots"}</span></div>
          <div className="folder-list">
            {!browser && <LoaderCircle className="spin" />}
            {browser?.entries.map((entry) => <button type="button" key={entry.path} onClick={() => { setSelectedPath(entry.path); void browse(entry.path).catch(onError); }} className={selectedPath === entry.path ? "selected" : ""}><Folder size={16} /><span>{entry.name}</span><ChevronRight size={15} /></button>)}
            {browser && !browser.entries.length && <div className="folder-empty">No child directories</div>}
          </div>
          <button type="button" className={`select-directory ${browser?.path && selectedPath === browser.path ? "chosen" : ""}`} disabled={!browser?.path} onClick={() => setSelectedPath(browser!.path)}>{selectedPath === browser?.path ? <Check size={16} /> : <FolderOpen size={16} />}{selectedPath === browser?.path ? "Selected" : "Use this directory"}</button>
        </section>
        <section className="launch-settings">
          <label className="field"><span>Session name <i>optional</i></span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Uses the first task line automatically" maxLength={100} /></label>
          <div className="organization-fields"><label className="field"><span>Category <i>optional</i></span><input value={category} onChange={(event) => setCategory(event.target.value)} placeholder="e.g. Product" maxLength={50} /></label><label className="field"><span>Tags <i>comma-separated</i></span><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="bug, release" /></label></div>
          {!spark && <div className="field"><span>Backend</span><div className="effort-grid"><button type="button" className={backend === "codex" ? "selected" : ""} onClick={() => chooseBackend("codex")}><Bot size={13} style={{ verticalAlign: "middle", marginRight: 5 }} />Codex</button><span title={!claudeAvailable ? "Claude Code CLI not installed or not authenticated" : undefined}><button type="button" aria-disabled={!claudeAvailable} className={backend === "claude" ? "selected" : ""} style={!claudeAvailable ? { opacity: .42, cursor: "not-allowed" } : backend === "claude" ? { color: "#cf75ff", borderColor: "rgba(201, 105, 255, .42)", background: "rgba(201, 105, 255, .09)" } : undefined} onClick={() => chooseBackend("claude")}><BrainCircuit size={13} style={{ verticalAlign: "middle", marginRight: 5 }} />Claude</button></span></div>{!claudeAvailable && <small>Claude Code CLI not installed or not authenticated</small>}</div>}
          <label className="field"><span>Model</span><select value={model} disabled={spark} onChange={(event) => {
            const nextModel = event.target.value;
            setModel(nextModel);
            if (backend === "codex") {
              const next = bootstrap.models.data.find((item) => item.model === nextModel);
              if (next) setEffort(next.defaultReasoningEffort);
            }
          }}>{spark ? <option value={SPARK_MODEL}>GPT-5.3 Codex Spark</option> : backend === "claude" ? claudeModels.map((item) => <option key={item.id} value={item.model}>{item.displayName}</option>) : bootstrap.models.data.map((item) => <option key={item.id} value={item.model}>{item.displayName}</option>)}</select><small>{spark ? "Fast, lightweight Codex model locked for SparkBoard tasks." : backend === "claude" ? selectedClaudeModel?.description : selectedCodexModel?.description}</small></label>
          <div className="field"><span>Thinking amount</span><div className="effort-grid">{effortOptions.map((option) => <button type="button" key={option} className={effort === option ? "selected" : ""} style={backend === "claude" && effort === option ? { color: "#cf75ff", borderColor: "rgba(201, 105, 255, .42)", background: "rgba(201, 105, 255, .09)" } : spark && effort === option ? { color: "#f5c451", borderColor: "rgba(245, 196, 81, .42)", background: "rgba(245, 196, 81, .09)" } : undefined} onClick={() => setEffort(option)}>{EFFORT_LABELS[option] || option}</button>)}</div></div>
          <label className="field prompt-field"><span>First task <i>optional</i></span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Start the session with a task, or leave it waiting…" rows={4} /></label>
        </section>
      </div>
      <div className="modal-footer">{backend === "claude" && !spark ? <div style={{ flex: 1, minWidth: 0 }}><span style={{ display: "block", marginBottom: 5, color: "#7a8490", fontSize: 8, textTransform: "uppercase", letterSpacing: .7 }}>Claude permissions</span><div className="effort-grid" style={{ flexWrap: "nowrap" }}><button type="button" className={claudePermissionMode === "default" ? "selected" : ""} onClick={() => setClaudePermissionMode("default")} title="Claude default permission mode"><ShieldCheck size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />Workspace-write sandbox</button><button type="button" className={claudePermissionMode === "plan" ? "selected" : ""} style={claudePermissionMode === "plan" ? { color: "#9d85ff", borderColor: "rgba(157, 133, 255, .42)", background: "rgba(157, 133, 255, .09)" } : undefined} onClick={() => setClaudePermissionMode("plan")} title="Read and plan only; no edits"><FileText size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />Plan mode</button><button type="button" className={claudePermissionMode === "bypassPermissions" ? "selected" : ""} onClick={() => setClaudePermissionMode("bypassPermissions")} title="No approvals; full system access"><Sparkles size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />YOLO mode</button></div></div> : <label className={`yolo-toggle ${yolo ? "enabled" : ""}`}><input type="checkbox" checked={yolo} onChange={(event) => setYolo(event.target.checked)} /><span className="toggle-track"><i /></span><span>{yolo ? "YOLO mode" : "Workspace-write sandbox"}<small>{yolo ? "No approvals · full system access" : "Approvals appear in ForgeDeck"}</small></span></label>}<button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" style={spark ? { background: "#b88919", borderColor: "#d5ad3f" } : backend === "claude" ? { background: "#8746a6", borderColor: "#b16bd1" } : undefined} disabled={!selectedPath || !model || busy}>{busy ? <LoaderCircle className="spin" size={17} /> : spark ? <Sparkles size={17} /> : backend === "claude" ? <BrainCircuit size={17} /> : <Sparkles size={17} />}Launch {spark ? "Spark session" : backend === "claude" ? "Claude session" : "session"}</button></div>
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
  const payload: unknown = response.headers.get("content-type")?.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    if (response.status === 401 && !options.allowUnauthenticated && url !== "/api/auth") window.location.reload();
    const message = isRecord(payload) && typeof payload.error === "string" ? payload.error : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return payload as T;
}

function threadTitle(thread: Thread): string { return thread.name || thread.preview || "Untitled session"; }
function sessionSearchText(thread: Thread): string {
  return [threadTitle(thread), thread.preview, thread.cwd, thread.category, thread.backend, thread.sessionClass, ...(thread.tags || [])].filter(Boolean).join(" ").toLocaleLowerCase();
}
function isClaudeThread(thread: Thread): boolean { return thread.backend === "claude"; }
function isSparkThread(thread: Thread): boolean { return thread.sessionClass === "spark"; }
function providerLabel(thread: Thread): "Codex" | "Claude" { return isClaudeThread(thread) ? "Claude" : "Codex"; }
function providerAccent(thread: Thread): string { return isClaudeThread(thread) ? "#cf75ff" : isSparkThread(thread) ? "#f5c451" : "#6e9dff"; }
function ThreadProviderIcon({ thread, size }: { thread: Thread; size: number }) {
  if (isClaudeThread(thread)) return <BrainCircuit size={size} color="#cf75ff" />;
  if (isSparkThread(thread)) return <Sparkles size={size} color="#f5c451" />;
  return <Bot size={size} color="#6e9dff" />;
}
function providerBadgeStyle(thread: Thread): React.CSSProperties {
  const accent = providerAccent(thread);
  return { flex: "0 0 auto", padding: "2px 4px", border: `1px solid ${accent}4d`, borderRadius: 4, color: accent, background: `${accent}12`, fontSize: 6.5, fontStyle: "normal", fontWeight: 700, letterSpacing: .45, textTransform: "uppercase" };
}
function providerIconContainerStyle(thread: Thread): React.CSSProperties | undefined {
  if (!isClaudeThread(thread) && !isSparkThread(thread)) return undefined;
  const accent = providerAccent(thread);
  return { color: accent, background: `${accent}14`, borderColor: `${accent}38` };
}
function controlCardAccentStyle(thread: Thread, variant: BoardVariant): React.CSSProperties | undefined {
  if (isClaudeThread(thread)) return { borderColor: "rgba(201, 105, 255, .38)", boxShadow: "inset 0 1px rgba(201, 105, 255, .05), 0 10px 32px rgba(75, 24, 99, .16)" };
  if (variant === "spark" || isSparkThread(thread)) return { borderColor: "rgba(245, 196, 81, .36)", boxShadow: "inset 0 1px rgba(245, 196, 81, .05), 0 10px 32px rgba(105, 77, 12, .14)" };
  return undefined;
}
function defaultSettingsForThread(thread: Thread, models: CodexModel[], claudeModels: ClaudeModelOption[], defaultModel?: CodexModel): { model: string; effort: string } {
  if (isSparkThread(thread)) return { model: SPARK_MODEL, effort: "high" };
  if (isClaudeThread(thread)) return { model: thread.claudeModel || claudeModels[0]?.model || "", effort: thread.claudeEffort || "high" };
  const model = defaultModel || models[0];
  return { model: model?.model || "", effort: model?.defaultReasoningEffort || "medium" };
}
function basename(value: string): string { return value.split("/").filter(Boolean).pop() || value; }
function initials(value: string): string { return value.split(/[@.\s_-]/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "CD"; }
function formatPlan(value?: string | null): string { return value ? value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (char) => char.toUpperCase()) : "Codex"; }
function hasInProgressTurn(thread: Thread): boolean { return Boolean(thread.turns?.some((turn) => turn.status === "inProgress")); }
function sessionVisualState(thread: Thread, completed = false): "running" | "idle" | "completed" | "error" {
  if (thread.status.type === "active" || hasInProgressTurn(thread)) return "running";
  if (thread.status.type === "systemError") return "error";
  return completed ? "completed" : "idle";
}
function sessionStateLabel(state: ReturnType<typeof sessionVisualState>): string {
  return state === "running" ? "Working" : state === "completed" ? "Done" : state === "error" ? "Error" : "Idle";
}
function statusRank(thread: Thread, completed = false): number {
  const state = sessionVisualState(thread, completed);
  return state === "running" ? 4 : state === "error" ? 3 : state === "idle" ? 2 : 1;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function readStoredJson(key: string): unknown {
  try {
    const raw = readStoredString(key);
    return raw === null ? null : JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
function readStoredString(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeStoredString(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* Storage may be disabled or full. */ }
}
function writeStoredJson(key: string, value: unknown): void {
  try { writeStoredString(key, JSON.stringify(value)); } catch { /* Ignore unserializable optional UI state. */ }
}
function readStoredStringArray(key: string): string[] {
  const value = readStoredJson(key);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function readStoredNumberRecord(key: string): Record<string, number> {
  const value = readStoredJson(key);
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
}
function readStoredTokenUsage(): Record<string, ThreadTokenUsage> {
  const value = readStoredJson("forgedeck-token-usage");
  if (!isRecord(value)) return {};
  const result: Record<string, ThreadTokenUsage> = {};
  for (const [threadId, candidate] of Object.entries(value)) {
    const usage = normalizeTokenUsage(candidate);
    if (usage) result[threadId] = usage;
  }
  return result;
}
function readThreadSettings(): ThreadSettings {
  const value = readStoredJson("forgedeck-settings");
  if (!isRecord(value)) return {};
  const result: ThreadSettings = {};
  for (const [threadId, candidate] of Object.entries(value)) {
    if (!isRecord(candidate) || typeof candidate.model !== "string" || typeof candidate.effort !== "string") continue;
    result[threadId] = { model: candidate.model, effort: candidate.effort };
  }
  return result;
}
function readSortMode(): SortMode {
  const stored = readStoredString("forgedeck-sort");
  return stored === "created" || stored === "name" || stored === "directory" || stored === "status" ? stored : "updated";
}
function parseEventData<T>(event: Event): T | null {
  const data = (event as MessageEvent<unknown>).data;
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}
function readPollInterval(): number {
  const stored = Number(readStoredString("forgedeck-poll-interval"));
  return POLL_INTERVALS.includes(stored as typeof POLL_INTERVALS[number]) ? stored : 4_000;
}
function readTheme(): ThemeMode {
  const stored = readStoredString("forgedeck-theme");
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
function normalizedTimestamp(value: number): number { return value > 10_000_000_000 ? value / 1_000 : value; }
function threadDurationSeconds(thread: Thread): number {
  let total = 0;
  let measuredTurns = 0;
  const now = Date.now() / 1_000;
  for (const turn of thread.turns || []) {
    if (!turn.startedAt) continue;
    const start = normalizedTimestamp(turn.startedAt);
    const end = turn.completedAt ? normalizedTimestamp(turn.completedAt) : turn.status === "inProgress" ? now : normalizedTimestamp(thread.updatedAt);
    total += Math.max(0, end - start);
    measuredTurns += 1;
  }
  if (measuredTurns) return total;
  const start = normalizedTimestamp(thread.createdAt);
  const end = sessionVisualState(thread) === "running" ? now : normalizedTimestamp(Math.max(thread.updatedAt, thread.createdAt));
  return Math.max(0, end - start);
}
function formatDuration(seconds: number): string {
  if (seconds < 60) return "<1m";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(tokens < 10_000_000 ? 1 : 0)}m`;
}
function normalizeTokenUsage(value: unknown): ThreadTokenUsage | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const numberValue = (key: string) => typeof record[key] === "number" && Number.isFinite(record[key]) ? Math.max(0, Number(record[key])) : undefined;
  const totalTokens = numberValue("totalTokens");
  if (totalTokens === undefined) return null;
  return {
    totalTokens,
    inputTokens: numberValue("inputTokens"),
    outputTokens: numberValue("outputTokens"),
    cachedInputTokens: numberValue("cachedInputTokens"),
    reasoningOutputTokens: numberValue("reasoningOutputTokens")
  };
}
function extractThreadTokenUsage(thread: Thread): ThreadTokenUsage | null {
  const candidate = (thread as Thread & { tokenUsage?: { total?: unknown } | unknown; usage?: unknown }).tokenUsage;
  if (candidate && typeof candidate === "object" && "total" in candidate) {
    const total = normalizeTokenUsage((candidate as { total?: unknown }).total);
    if (total) return total;
  }
  return normalizeTokenUsage(candidate) || normalizeTokenUsage((thread as Thread & { usage?: unknown }).usage);
}
function mergeThreadTokenUsage(current: Record<string, ThreadTokenUsage>, threads: Thread[]): Record<string, ThreadTokenUsage> {
  let next = current;
  for (const thread of threads) {
    const usage = extractThreadTokenUsage(thread);
    if (!usage || sameTokenUsage(current[thread.id], usage)) continue;
    if (next === current) next = { ...current };
    next[thread.id] = usage;
  }
  return next;
}
function tokensForThread(thread: Thread, usage?: ThreadTokenUsage): number | null {
  return usage?.totalTokens ?? (thread.goal?.tokensUsed && thread.goal.tokensUsed > 0 ? thread.goal.tokensUsed : null);
}
function timeAgo(timestamp: number): string {
  const seconds = Math.max(0, Date.now() / 1000 - timestamp);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
  return new Date(timestamp * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function showError(error: unknown, setter: (value: string) => void) { setter(error instanceof Error ? error.message : String(error)); }
function sameBootstrapSummary(current: Bootstrap | null, next: Bootstrap): boolean {
  if (!current) return false;
  return JSON.stringify([current.models, current.account, current.usage, current.backendStatus, current.roots, current.sparkAgentThreadIds, current.claudeAvailable, current.claudeModelOptions])
    === JSON.stringify([next.models, next.account, next.usage, next.backendStatus, next.roots, next.sparkAgentThreadIds, next.claudeAvailable, next.claudeModelOptions]);
}
function samePendingRequests(current: PendingRequest[], next: PendingRequest[]): boolean {
  return current.length === next.length && current.every((request, index) => request.id === next[index].id
    && request.method === next[index].method
    && request.receivedAt === next[index].receivedAt
    && JSON.stringify(request.params) === JSON.stringify(next[index].params));
}
function sameQueue(current: QueueEntry[], next: QueueEntry[]): boolean {
  return current.length === next.length && current.every((entry, index) => entry.id === next[index].id
    && entry.text === next[index].text
    && entry.model === next[index].model
    && entry.effort === next[index].effort
    && entry.createdAt === next[index].createdAt);
}
function sameQueues(current: Record<string, QueueEntry[]>, next: Record<string, QueueEntry[]>): boolean {
  return sameRecord(current, next, (currentQueue, nextQueue) => Boolean(currentQueue) && sameQueue(currentQueue!, nextQueue));
}
function sameSet<T>(current: Set<T>, next: Set<T>): boolean {
  return current.size === next.size && [...current].every((value) => next.has(value));
}
function sameRecord<T>(current: Record<string, T>, next: Record<string, T>, compare: (current: T | undefined, next: T) => boolean): boolean {
  const currentKeys = Object.keys(current);
  const nextKeys = Object.keys(next);
  return currentKeys.length === nextKeys.length && nextKeys.every((key) => compare(current[key], next[key]));
}
function sameNumberRecord(current: Record<string, number>, next: Record<string, number>): boolean {
  return sameRecord(current, next, (currentValue, nextValue) => currentValue === nextValue);
}
function sameThreadStatus(current: Thread["status"] | undefined, next: Thread["status"]): boolean {
  if (!current || current.type !== next.type) return false;
  const currentFlags = current.activeFlags || [];
  const nextFlags = next.activeFlags || [];
  return currentFlags.length === nextFlags.length && currentFlags.every((flag, index) => flag === nextFlags[index]);
}
function sameTokenUsage(current: ThreadTokenUsage | undefined, next: ThreadTokenUsage): boolean {
  return Boolean(current)
    && current!.totalTokens === next.totalTokens
    && current!.inputTokens === next.inputTokens
    && current!.outputTokens === next.outputTokens
    && current!.cachedInputTokens === next.cachedInputTokens
    && current!.reasoningOutputTokens === next.reasoningOutputTokens;
}
function threadItemRevision(item: ThreadItem | undefined): string {
  if (!item) return "";
  return [item.id, item.type, item.status, item.text?.length, item.aggregatedOutput?.length, item.exitCode,
    item.summary?.length, item.changes?.length, JSON.stringify(item.error || null)].join(":");
}
function sameThreadSnapshot(current: Thread | undefined | null, next: Thread): boolean {
  if (!current
    || current.id !== next.id
    || current.name !== next.name
    || current.preview !== next.preview
    || current.cwd !== next.cwd
    || current.createdAt !== next.createdAt
    || current.updatedAt !== next.updatedAt
    || current.recencyAt !== next.recencyAt
    || current.policy !== next.policy
    || current.backend !== next.backend
    || current.sessionClass !== next.sessionClass
    || current.claudeModel !== next.claudeModel
    || current.claudeEffort !== next.claudeEffort
    || current.claudePermissionMode !== next.claudePermissionMode
    || current.category !== next.category
    || current.gitInfo?.branch !== next.gitInfo?.branch
    || !sameThreadStatus(current.status, next.status)
    || current.turns.length !== next.turns.length
    || current.goal?.updatedAt !== next.goal?.updatedAt
    || current.goal?.status !== next.goal?.status
    || current.goal?.tokensUsed !== next.goal?.tokensUsed) return false;
  const currentTurn = current.turns.at(-1);
  const nextTurn = next.turns.at(-1);
  if (next.backend === "claude" && currentTurn?.items.at(-1)?.text !== nextTurn?.items.at(-1)?.text) return false;
  return currentTurn?.id === nextTurn?.id
    && currentTurn?.status === nextTurn?.status
    && currentTurn?.startedAt === nextTurn?.startedAt
    && currentTurn?.completedAt === nextTurn?.completedAt
    && currentTurn?.items.length === nextTurn?.items.length
    && threadItemRevision(currentTurn?.items.at(-1)) === threadItemRevision(nextTurn?.items.at(-1));
}
function reconcileThreads(current: Thread[], next: Thread[]): Thread[] {
  const byId = new Map(current.map((thread) => [thread.id, thread]));
  let unchanged = current.length === next.length;
  const reconciled = next.map((thread, index) => {
    const previous = byId.get(thread.id);
    const value = sameThreadSnapshot(previous, thread) ? previous! : thread;
    if (current[index] !== value) unchanged = false;
    return value;
  });
  return unchanged ? current : reconciled;
}
function sameThreadItem(current: ThreadItem | undefined, next: ThreadItem): boolean {
  return current === next || Boolean(current) && JSON.stringify(current) === JSON.stringify(next);
}
function setNestedValue<T>(current: Record<string, Record<string, T>>, groupId: string, itemId: string, value: T, compare: (current: T | undefined, next: T) => boolean): Record<string, Record<string, T>> {
  if (compare(current[groupId]?.[itemId], value)) return current;
  return { ...current, [groupId]: { ...(current[groupId] || {}), [itemId]: value } };
}
function appendLiveDeltas(current: LiveStreams, deltas: LiveStreams): LiveStreams {
  let next = current;
  for (const [threadId, itemDeltas] of Object.entries(deltas)) {
    const currentThread = current[threadId] || EMPTY_TEXT_STREAM;
    const nextThread = { ...currentThread };
    for (const [itemId, delta] of Object.entries(itemDeltas)) nextThread[itemId] = appendBoundedText(nextThread[itemId] || "", delta);
    if (next === current) next = { ...current };
    next[threadId] = nextThread;
  }
  return next;
}
function appendBoundedText(current: string, delta: string): string {
  const next = current + delta;
  if (next.length <= CLIENT_LIVE_OUTPUT_MAX_CHARS) return next;
  const marker = "…[earlier output truncated]\n";
  return marker + next.slice(-(CLIENT_LIVE_OUTPUT_MAX_CHARS - marker.length));
}
function mergeTokenUsage(current: Record<string, ThreadTokenUsage>, updates: Record<string, ThreadTokenUsage>): Record<string, ThreadTokenUsage> {
  let next = current;
  for (const [threadId, usage] of Object.entries(updates)) {
    if (sameTokenUsage(current[threadId], usage)) continue;
    if (next === current) next = { ...current };
    next[threadId] = usage;
  }
  return next;
}
function mergeLiveState<T>(current: Record<string, Record<string, T>>, state: Record<string, LiveThreadState>, key: "items" | "agentText" | "toolOutput"): Record<string, Record<string, T>> {
  let next = current;
  for (const [threadId, value] of Object.entries(state)) {
    const incoming = value[key] as Record<string, T>;
    const existing = current[threadId] || {};
    const merged = { ...existing, ...incoming };
    const equal = sameRecord(existing, merged, (currentValue, nextValue) => currentValue === nextValue || JSON.stringify(currentValue) === JSON.stringify(nextValue));
    if (equal) continue;
    if (next === current) next = { ...current };
    next[threadId] = merged;
  }
  return next;
}
function withoutSetValue<T>(values: Set<T>, value: T): Set<T> {
  if (!values.has(value)) return values;
  const next = new Set(values);
  next.delete(value);
  return next;
}
function useControlColumns(): number {
  const getColumns = () => window.innerWidth >= 1700 ? 4 : window.innerWidth >= 1150 ? 3 : window.innerWidth >= 680 ? 2 : 1;
  const [columns, setColumns] = useState(getColumns);
  useEffect(() => {
    const queries = [window.matchMedia("(min-width: 680px)"), window.matchMedia("(min-width: 1150px)"), window.matchMedia("(min-width: 1700px)")];
    const update = () => setColumns(getColumns());
    for (const query of queries) query.addEventListener("change", update);
    return () => { for (const query of queries) query.removeEventListener("change", update); };
  }, []);
  return columns;
}
function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return record;
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
