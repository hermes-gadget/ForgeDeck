import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Archive, ArrowLeft, BookOpen, Command as CommandIcon, EllipsisVertical, FileDown, FileJson, FileText, Folder, GitBranch, History, KeyRound, LoaderCircle,
  Menu, Monitor, Moon, Pin, PinOff, Plus, RefreshCw, Settings2, ShieldCheck, Sparkles, Sun, Tags, X
} from "lucide-react";
import { api, apiErrorFromPayload, clearConditionalApiCache } from "./api/client";
import { ApprovalTray } from "./components/ApprovalTray";
import { ArchiveHeader, ArchiveView } from "./components/archive/ArchiveView";
import { Chat } from "./components/chat/Chat";
import { CommandPalette } from "./components/command-palette/CommandPalette";
import { BoardHeader, ControlCenter, FleetSummary, SparkBoard } from "./components/control-center/ControlCenter";
import { ErrorCenter, useErrorCenter } from "./components/error-center/ErrorCenter";
import { EvalHeader, EvalLab } from "./components/evals/EvalLab";
import { ComparisonHeader, ComparisonLab } from "./components/comparisons/ComparisonLab";
import { InsightsPanel } from "./components/insights/InsightsPanel";
import { KnowledgePacksDialog } from "./components/knowledge-packs/KnowledgePacksDialog";
import { MissionsHeader, MissionsView } from "./components/missions/MissionsView";
import { NewSessionModal, type SessionClass } from "./components/new-session/NewSessionModal";
import { PoliciesDialog } from "./components/policies/PoliciesDialog";
import {
  NotificationCenter, NotificationToasts, SessionNotificationPreferences, useNotificationCenter,
  type DesktopNotificationPermission
} from "./components/notifications/NotificationCenter";
import { Brand, Sidebar, type BatchAction, type SidebarView } from "./components/sidebar/Sidebar";
import {
  SessionActionDialog, type SessionActionRequest, type SessionActionResult, type SessionActionTarget, type SessionOperation
} from "./components/session-actions/SessionActionDialog";
import { SessionReplay } from "./components/session-replay/SessionReplay";
import { useEventStream, type BackendHealth, type LiveNotificationEvent, type TransportState } from "./hooks/use-event-stream";
import { DEFAULT_THREAD_FILTERS, useThreadInventory, type SortDirection, type SortMode, type ThreadFilters } from "./hooks/use-thread-inventory";
import { hasLaunchConfiguration, markOnboardingSeen, notificationPreferences, readStoredString, readStoredStringArray, readThreadSettings, writeStoredJson, writeStoredString } from "./state/preferences";
import { mergeBackendStatus, reconcileBackendStatusResponse, type VersionedBackendStatusPatch } from "./state/backend-status";
import { normalizeThreadSettings, resolveThreadSettings, settingsFromThread, threadStore, useThreadDetail } from "./state/thread-store";
import type {
  AccountStatus, AdmissionEvent, Bootstrap, LiveRecoverySnapshot, LiveThreadState, NotificationPreferences, PendingRequest, QueueEntry,
  SessionSettings, StartupConfiguration, Thread
} from "./types";

type ThemeMode = "system" | "dark" | "light";
type ThreadSettings = Record<string, SessionSettings>;

const POLL_INTERVALS = [0, 2_000, 4_000, 10_000, 30_000] as const;
const EMPTY_ACCOUNT_STATUS: AccountStatus = {
  account: { account: null, requiresOpenaiAuth: false },
  usage: null,
  activeThreadIds: [],
  agentThreadIds: [],
  sparkAgentThreadIds: [],
  sparkActiveThreadIds: [],
  claudeAvailable: false
};

export default function App() {
  const mobileLayout = useMediaQuery("(max-width: 767px)");
  const systemDarkTheme = useMediaQuery("(prefers-color-scheme: dark)");
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [startup, setStartup] = useState<StartupConfiguration | null>(null);
  const [accountStatus, setAccountStatus] = useState<AccountStatus | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(readLinkedSessionId);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>(readSortMode);
  const [sortDirection, setSortDirection] = useState<SortDirection>(readSortDirection);
  const [filters, setFilters] = useState<ThreadFilters>(DEFAULT_THREAD_FILTERS);
  const [pollInterval, setPollInterval] = useState(readPollInterval);
  const [theme, setTheme] = useState<ThemeMode>(readTheme);
  const [pinned, setPinned] = useState<Set<string>>(() => new Set(readStoredStringArray("forgedeck-pins")));
  const [settings, setSettings] = useState<ThreadSettings>(readThreadSettings);
  const [view, setView] = useState<SidebarView>(readView);
  const [controlIds, setControlIds] = useState<string[]>(() => readStoredStringArray("forgedeck-control-ids"));
  const [sparkIds, setSparkIds] = useState<string[]>(() => readStoredStringArray("forgedeck-spark-ids"));
  const [dismissedControlIds, setDismissedControlIds] = useState<Set<string>>(() => new Set(readStoredStringArray("forgedeck-control-dismissed")));
  const [dismissedSparkIds, setDismissedSparkIds] = useState<Set<string>>(() => new Set(readStoredStringArray("forgedeck-spark-dismissed")));
  const [newOpen, setNewOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newSessionClass, setNewSessionClass] = useState<SessionClass>("standard");
  const [newQuickStart, setNewQuickStart] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [sessionActionRequest, setSessionActionRequest] = useState<SessionActionRequest | null>(null);
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [knowledgePacksOpen, setKnowledgePacksOpen] = useState(false);
  const [policiesOpen, setPoliciesOpen] = useState(false);
  const [replayThreadId, setReplayThreadId] = useState<string | null>(null);
  const [visibleBoardIds, setVisibleBoardIds] = useState<string[]>([]);
  const {
    entries: errors,
    open: errorsOpen,
    setOpen: setErrorsOpen,
    report: reportError,
    reportAutomatic: reportAutomaticError,
    dismiss: dismissError,
    clear: clearErrors,
    retry: retryError
  } = useErrorCenter();
  const notificationFocusRef = useRef<string | null>(null);
  const focusNotificationSession = useCallback((threadId: string) => {
    notificationFocusRef.current = threadId;
    setSelectedId(threadId);
    setView("session");
    setSidebarOpen(false);
    setSearch("");
    setFilters({ ...DEFAULT_THREAD_FILTERS });
    threadStore.markCompletionSeen(threadId);
  }, []);
  const notifications = useNotificationCenter(focusNotificationSession);
  const selectedRef = useRef(selectedId);
  const settingsRef = useRef(settings);
  const currentThreadRef = useRef<Thread | null>(null);
  const mobileMenuRef = useRef<HTMLButtonElement>(null);
  const bootstrapController = useRef<AbortController | null>(null);
  const statusController = useRef<AbortController | null>(null);
  const statusRequest = useRef<Promise<void> | null>(null);
  const backendStatusPatch = useRef<VersionedBackendStatusPatch>({ generation: 0, value: {} });
  const settingsMetadataSignatures = useRef(new Map<string, string>());
  const controlInitialized = useRef(readStoredString("forgedeck-control-ids") !== null);
  const recoveryThreadIdsRef = useRef<string[]>([]);
  const onboardingCheckedRef = useRef(false);
  const bootstrap = useMemo<Bootstrap | null>(
    () => startup ? { ...startup, ...(accountStatus || EMPTY_ACCOUNT_STATUS) } : null,
    [accountStatus, startup]
  );

  const {
    threads, filteredThreads, totalCount: inventoryTotal, facets, hasMore, loadingMore, fullyLoaded,
    reload, loadMore, loadDetail, cancelDetail, remove
  } = useThreadInventory({
    enabled: authenticated === true,
    search,
    sortMode,
    sortDirection,
    filters,
    pinned
  });
  const selectedSummary = useMemo(() => threads.find((thread) => thread.id === selectedId) || null, [selectedId, threads]);
  const selectedDetail = useThreadDetail(selectedId || "");
  const currentThread = selectedDetail || selectedSummary;
  selectedRef.current = selectedId;
  settingsRef.current = settings;
  currentThreadRef.current = currentThread;

  const handleError = reportError;
  const handleBackgroundError = reportAutomaticError;
  const handleSessionEnded = useCallback(() => {
    bootstrapController.current?.abort();
    statusController.current?.abort();
    clearConditionalApiCache();
    setAuthenticated(false);
    setStartup(null);
    setAccountStatus(null);
  }, []);
  const handleAdmission = useCallback((event: AdmissionEvent) => {
    const alert = event.decision?.alerts.find((candidate) => candidate.severity === "hard")
      || event.decision?.alerts[0];
    if (alert) setToast(alert.message);
  }, []);
  const handleLiveNotification = useCallback((event: LiveNotificationEvent) => {
    const preferences = notificationPreferences(settingsRef.current[event.threadId]);
    if (event.kind === "completed" && !preferences.onCompletion) return;
    if (event.kind === "failed" && !preferences.onFailure) return;
    if (event.kind === "approval" && !preferences.onApprovalNeeded) return;
    const thread = threadStore.getSummary(event.threadId);
    const sessionName = thread ? threadTitle(thread) : event.threadId;
    const details = notificationCopy(event);
    notifications.push({
      kind: event.kind,
      threadId: event.threadId,
      sessionName,
      title: details.title,
      message: details.message
    }, event.kind !== "queued");
  }, [notifications]);

  const loadBootstrap = useCallback(async () => {
    bootstrapController.current?.abort();
    const controller = new AbortController();
    bootstrapController.current = controller;
    try {
      const data = await api<StartupConfiguration>("/api/bootstrap", { conditional: true, signal: controller.signal });
      if (controller.signal.aborted) return;
      setStartup(data);
      for (const error of data.errors || []) reportError(apiErrorFromPayload(error, { scope: "runtime" }));
    } finally {
      if (bootstrapController.current === controller) bootstrapController.current = null;
    }
  }, [reportError]);

  const loadAccountStatus = useCallback((): Promise<void> => {
    if (statusRequest.current) return statusRequest.current;
    const patchGeneration = backendStatusPatch.current.generation;
    const controller = new AbortController();
    statusController.current = controller;
    const request = api<AccountStatus>("/api/account/status", { conditional: true, signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setAccountStatus(reconcileBackendStatusResponse(data, patchGeneration, backendStatusPatch.current));
        for (const error of data.errors || []) reportError(apiErrorFromPayload(error, { scope: "runtime" }));
      })
      .finally(() => {
        if (statusController.current === controller) statusController.current = null;
        if (statusRequest.current === request) statusRequest.current = null;
      });
    statusRequest.current = request;
    return request;
  }, [reportError]);

  const handleBackendStatus = useCallback((patch: Parameters<typeof mergeBackendStatus>[1]) => {
    backendStatusPatch.current = {
      generation: backendStatusPatch.current.generation + 1,
      value: patch
    };
    setAccountStatus((current) => current ? mergeBackendStatus(current, patch) : current);
  }, []);

  const readApprovals = useCallback(async (): Promise<PendingRequest[]> => {
    const response = await api<{ data: PendingRequest[] }>("/api/approvals");
    return response.data;
  }, []);

  const refreshThread = useCallback(async (threadId: string, quiet = false) => {
    if (!quiet && selectedRef.current === threadId) setLoadingDetail(true);
    try { return await loadDetail(threadId); }
    finally { if (selectedRef.current === threadId) setLoadingDetail(false); }
  }, [loadDetail]);

  const removeThreadState = useCallback((threadId: string) => {
    cancelDetail(threadId);
    remove(threadId);
    setControlIds((ids) => ids.filter((id) => id !== threadId));
    setSparkIds((ids) => ids.filter((id) => id !== threadId));
    setPinned((ids) => { const next = new Set(ids); next.delete(threadId); return next; });
    setSettings((current) => { if (!current[threadId]) return current; const next = { ...current }; delete next[threadId]; return next; });
    setSelectedId((current) => current === threadId ? null : current);
  }, [cancelDetail, remove]);
  const getSelectedThreadId = useCallback(() => selectedRef.current, []);
  const readRecovery = useCallback((): Promise<LiveRecoverySnapshot> => {
    return readThreadRecoverySnapshot(recoveryThreadIdsRef.current.slice(0, 256));
  }, []);
  const shouldReconcileThread = useCallback((threadId: string) => recoveryThreadIdsRef.current.includes(threadId), []);
  const relevantLiveIds = useMemo(() => {
    const ids = new Set<string>();
    if (view === "session" && selectedId) ids.add(selectedId);
    if (view === "control" || view === "spark") for (const threadId of visibleBoardIds) ids.add(threadId);
    return [...ids].sort();
  }, [selectedId, view, visibleBoardIds]);
  recoveryThreadIdsRef.current = relevantLiveIds;
  const relevantLiveSignature = relevantLiveIds.join(",");

  const {
    backendHealth, transport, lastSyncedAt, nextReconnectAt, reconnect,
    pending, replacePending, resolvePending
  } = useEventStream({
    enabled: authenticated === true,
    subscribedThreadIds: relevantLiveIds,
    fallbackPollInterval: pollInterval,
    refreshStatus: loadAccountStatus,
    readApprovals,
    refreshInventory: reload,
    refreshThread,
    readRecovery,
    selectedThreadId: getSelectedThreadId,
    shouldReconcileThread,
    onThreadRemoved: removeThreadState,
    onSessionEnded: handleSessionEnded,
    onAdmission: handleAdmission,
    onBackendStatus: handleBackendStatus,
    onNotification: handleLiveNotification,
    onError: handleBackgroundError
  });
  const waitingThreadIds = useMemo(() => new Set(pending.flatMap((request) => {
    const threadId = request.params && typeof request.params.threadId === "string" ? request.params.threadId : null;
    return threadId ? [threadId] : [];
  })), [pending]);

  useEffect(() => {
    const controller = new AbortController();
    void api<{ authenticated: boolean }>("/api/auth", { allowUnauthenticated: true, signal: controller.signal })
      .then(({ authenticated: value }) => setAuthenticated(value))
      .catch((error) => { if (error.name !== "AbortError") setAuthenticated(false); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (authenticated !== true) return;
    void Promise.all([
      loadBootstrap(),
      loadAccountStatus(),
      readApprovals().then(replacePending)
    ]).catch(handleBackgroundError);
    return () => {
      bootstrapController.current?.abort();
      statusController.current?.abort();
    };
  }, [authenticated, handleBackgroundError, loadAccountStatus, loadBootstrap, readApprovals, replacePending]);
  useEffect(() => {
    if (authenticated !== true || !startup || onboardingCheckedRef.current) return;
    onboardingCheckedRef.current = true;
    if (hasLaunchConfiguration()) return;
    const controller = new AbortController();
    void Promise.all([
      api<{ total: number }>("/api/threads?limit=1&archiveState=all", { signal: controller.signal }),
      api<{ data: unknown[] }>("/api/blueprints?limit=1", { signal: controller.signal })
    ]).then(([inventory, blueprints]) => {
      if (!controller.signal.aborted && inventory.total === 0 && blueprints.data.length === 0) setOnboardingOpen(true);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [authenticated, startup]);
  useEffect(() => {
    if (!threads.length) return;
    const notificationTarget = notificationFocusRef.current;
    if (notificationTarget) {
      if (threads.some((thread) => thread.id === notificationTarget)) notificationFocusRef.current = null;
      setSelectedId(notificationTarget);
      return;
    }
    setSelectedId((current) => current && threads.some((thread) => thread.id === current) ? current : threads[0].id);
  }, [threads]);
  useEffect(() => {
    if (!selectedId || view !== "session") return;
    void refreshThread(selectedId).catch(handleBackgroundError);
    return () => cancelDetail(selectedId);
  }, [cancelDetail, handleBackgroundError, refreshThread, selectedId, view]);

  useEffect(() => {
    if (authenticated !== true || !relevantLiveIds.length) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void readThreadRecoverySnapshot(relevantLiveIds.slice(0, 256), controller.signal).then((snapshot) => {
        if (controller.signal.aborted) return;
        threadStore.applyRecoverySnapshot(snapshot);
      }).catch(handleBackgroundError);
    }, 50);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  // The sorted signature coalesces equivalent ID sets across status object revisions.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, relevantLiveSignature]);

  useEffect(() => {
    if (!bootstrap) return;
    const models = bootstrap.models.data;
    const defaultModel = models.find((model) => model.isDefault) || models[0];
    const claudeModels = bootstrap.claudeModelOptions || [];
    setSettings((current) => {
      let next = current;
      for (const thread of threads) {
        const metadata = settingsFromThread(thread);
        const signature = `${metadata.model || ""}:${metadata.effort || ""}`;
        const previousSignature = settingsMetadataSignatures.current.get(thread.id);
        if (previousSignature === signature && current[thread.id]) continue;
        const normalized = resolveThreadSettings(thread, models, claudeModels, current[thread.id], defaultModel);
        settingsMetadataSignatures.current.set(thread.id, signature);
        if (current[thread.id]?.model === normalized.model && current[thread.id]?.effort === normalized.effort) continue;
        if (next === current) next = { ...current };
        next[thread.id] = normalized;
      }
      return next;
    });
  }, [bootstrap, threads]);
  useEffect(() => {
    if (!bootstrap || !currentThread) return;
    const persisted = settingsFromThread(currentThread);
    const signature = `${persisted.model || ""}:${persisted.effort || ""}`;
    if (settingsMetadataSignatures.current.get(currentThread.id) === signature && settings[currentThread.id]) return;
    const defaultChoice = bootstrap.models.data.find((model) => model.isDefault) || bootstrap.models.data[0];
    setSettings((current) => {
      const normalized = resolveThreadSettings(currentThread, bootstrap.models.data, bootstrap.claudeModelOptions || [], current[currentThread.id], defaultChoice);
      settingsMetadataSignatures.current.set(currentThread.id, signature);
      return current[currentThread.id]?.model === normalized.model && current[currentThread.id]?.effort === normalized.effort
        ? current : { ...current, [currentThread.id]: normalized };
    });
  }, [bootstrap, currentThread, settings]);

  useEffect(() => {
    if (!bootstrap) return;
    // Account status can retain MCP ownership for sessions that are archived or
    // otherwise absent from the active inventory. Only board sessions the
    // inventory can render; when a newly spawned session arrives, the threads
    // dependency reruns this effect and adds it immediately.
    const inventoryIds = new Set(threads.map((thread) => thread.id));
    const sparkAgents = new Set(bootstrap.sparkAgentThreadIds || []);
    setControlIds((current) => {
      const missing = (bootstrap.agentThreadIds || []).filter((id) => inventoryIds.has(id) && !sparkAgents.has(id) && !dismissedControlIds.has(id) && !current.includes(id));
      return missing.length ? [...current, ...missing] : current;
    });
    setSparkIds((current) => {
      const missing = (bootstrap.sparkAgentThreadIds || []).filter((id) => inventoryIds.has(id) && !dismissedSparkIds.has(id) && !current.includes(id));
      return missing.length ? [...current, ...missing] : current;
    });
  }, [bootstrap, dismissedControlIds, dismissedSparkIds, threads]);
  useEffect(() => {
    if (!threads.length || controlInitialized.current) return;
    controlInitialized.current = true;
    setControlIds(threads.filter((thread) => thread.sessionClass !== "spark").slice(0, 3).map((thread) => thread.id));
  }, [threads]);
  useEffect(() => {
    const activeStandard = threads.filter((thread) => thread.sessionClass !== "spark" && thread.status.type === "active" && !dismissedControlIds.has(thread.id)).map((thread) => thread.id);
    const activeSpark = threads.filter((thread) => thread.sessionClass === "spark" && thread.status.type === "active" && !dismissedSparkIds.has(thread.id)).map((thread) => thread.id);
    if (activeStandard.length) setControlIds((current) => [...current, ...activeStandard.filter((id) => !current.includes(id))]);
    if (activeSpark.length) setSparkIds((current) => [...current, ...activeSpark.filter((id) => !current.includes(id))]);
  }, [dismissedControlIds, dismissedSparkIds, threads]);
  useEffect(() => {
    const serverPinned = threads.filter((thread) => thread.pinned).map((thread) => thread.id);
    if (!serverPinned.length) return;
    setPinned((current) => {
      const next = new Set(current);
      for (const threadId of serverPinned) next.add(threadId);
      return next.size === current.size ? current : next;
    });
  }, [threads]);

  // Prune stale control/spark IDs that no longer exist in the thread inventory
  useEffect(() => {
    if (!threads.length || !fullyLoaded) return;
    const existingIds = new Set(threads.map((t) => t.id));
    setControlIds((current) => current.filter((id) => existingIds.has(id)));
    setSparkIds((current) => current.filter((id) => existingIds.has(id)));
  }, [fullyLoaded, threads]);

  useLayoutEffect(() => {
    const resolvedTheme = theme === "system" ? systemDarkTheme ? "dark" : "light" : theme;
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.dataset.themeMode = theme;
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [systemDarkTheme, theme]);
  useEffect(() => writeStoredJson("forgedeck-pins", [...pinned]), [pinned]);
  useEffect(() => writeStoredJson("forgedeck-settings", settings), [settings]);
  useEffect(() => writeStoredString("forgedeck-sort", sortMode), [sortMode]);
  useEffect(() => writeStoredString("forgedeck-sort-direction", sortDirection), [sortDirection]);
  useEffect(() => writeStoredString("forgedeck-view", view), [view]);
  useEffect(() => writeStoredString("forgedeck-poll-interval", String(pollInterval)), [pollInterval]);
  useEffect(() => writeStoredString("forgedeck-theme", theme), [theme]);
  useEffect(() => writeStoredJson("forgedeck-control-ids", controlIds), [controlIds]);
  useEffect(() => writeStoredJson("forgedeck-spark-ids", sparkIds), [sparkIds]);
  useEffect(() => writeStoredJson("forgedeck-control-dismissed", [...dismissedControlIds]), [dismissedControlIds]);
  useEffect(() => writeStoredJson("forgedeck-spark-dismissed", [...dismissedSparkIds]), [dismissedSparkIds]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4_500);
    return () => clearTimeout(timer);
  }, [toast]);
  const handleCloseSidebar = useCallback(() => {
    setSidebarOpen(false);
    window.requestAnimationFrame(() => mobileMenuRef.current?.focus());
  }, []);
  const handleOpenSidebar = useCallback(() => setSidebarOpen(true), []);
  const handleOpenInsights = useCallback(() => { setInsightsOpen(true); setSidebarOpen(false); }, []);
  const handleCloseInsights = useCallback(() => setInsightsOpen(false), []);
  const handleCloseReplay = useCallback(() => setReplayThreadId(null), []);
  const handleNew = useCallback(() => { setNewSessionClass("standard"); setNewQuickStart(false); setNewOpen(true); }, []);
  const handleNewSpark = useCallback(() => { setNewSessionClass("spark"); setNewQuickStart(false); setNewOpen(true); }, []);
  const handleCloseNew = useCallback(() => setNewOpen(false), []);
  const handleDismissOnboarding = useCallback(() => { markOnboardingSeen(); setOnboardingOpen(false); }, []);
  const handleOnboardingQuickStart = useCallback(() => {
    markOnboardingSeen();
    setOnboardingOpen(false);
    setNewSessionClass("standard");
    setNewQuickStart(true);
    setNewOpen(true);
  }, []);
  const handleLoginSuccess = useCallback(() => setAuthenticated(true), []);
  const handleSearch = useCallback((value: string) => setSearch(value), []);
  const handleSort = useCallback((value: SortMode) => { setSortMode(value); setSortDirection(value === "name" || value === "directory" ? "asc" : "desc"); }, []);
  const handleSortDirection = useCallback(() => setSortDirection((current) => current === "asc" ? "desc" : "asc"), []);
  const handleFilters = useCallback((value: ThreadFilters) => setFilters(value), []);
  const handlePollInterval = useCallback((value: number) => setPollInterval(value), []);
  const handleDismissToast = useCallback(() => setToast(null), []);
  const handleRetryError = useCallback((id: string) => {
    void retryError(id).then((succeeded) => { if (succeeded) setToast("Retry succeeded."); });
  }, [retryError]);
  const handleView = useCallback((next: SidebarView) => { setView(next); setSidebarOpen(false); }, []);
  const handleSelect = useCallback((threadId: string) => {
    notificationFocusRef.current = null;
    setSelectedId(threadId);
    setView("session");
    setSidebarOpen(false);
    threadStore.markCompletionSeen(threadId);
  }, []);
  const handleInsightSession = useCallback((threadId: string) => {
    if (threadStore.getSummary(threadId)) handleSelect(threadId);
    else setReplayThreadId(threadId);
  }, [handleSelect]);
  const handleTogglePin = useCallback((threadId: string) => {
    const nextPinned = !pinned.has(threadId);
    setPinned((current) => { const next = new Set(current); nextPinned ? next.add(threadId) : next.delete(threadId); return next; });
    void api(`/api/sessions/${encodeURIComponent(threadId)}/pin`, {
      method: "POST",
      body: JSON.stringify({ pinned: nextPinned })
    }).catch((error) => {
      setPinned((current) => { const next = new Set(current); nextPinned ? next.delete(threadId) : next.add(threadId); return next; });
      handleError(error);
    });
  }, [handleError, pinned]);
  const handleAddControl = useCallback((threadId: string) => { setDismissedControlIds((current) => { const next = new Set(current); next.delete(threadId); return next; }); setControlIds((current) => current.includes(threadId) ? current : [...current, threadId]); }, []);
  const handleRemoveControl = useCallback((threadId: string) => { setDismissedControlIds((current) => new Set(current).add(threadId)); setControlIds((current) => current.filter((id) => id !== threadId)); }, []);
  const handleAddSpark = useCallback((threadId: string) => { setDismissedSparkIds((current) => { const next = new Set(current); next.delete(threadId); return next; }); setSparkIds((current) => current.includes(threadId) ? current : [...current, threadId]); }, []);
  const handleRemoveSpark = useCallback((threadId: string) => { setDismissedSparkIds((current) => new Set(current).add(threadId)); setSparkIds((current) => current.filter((id) => id !== threadId)); }, []);
  const requestSessionAction = useCallback((operation: SessionOperation, threadIds: string[]) => {
    const uniqueIds = [...new Set(threadIds)].filter(Boolean);
    if (uniqueIds.length) setSessionActionRequest((current) => current || { operation, threadIds: uniqueIds });
  }, []);
  const handleCloseSessionAction = useCallback(() => setSessionActionRequest(null), []);
  const handleToggleBoard = useCallback((threadId: string) => {
    const thread = threadStore.getSummary(threadId);
    const inBoard = thread?.sessionClass === "spark" ? sparkIds.includes(threadId) : controlIds.includes(threadId);
    if (inBoard) requestSessionAction("remove", [threadId]);
    else if (thread?.sessionClass === "spark") handleAddSpark(threadId);
    else handleAddControl(threadId);
  }, [controlIds, handleAddControl, handleAddSpark, requestSessionAction, sparkIds]);
  const handleSettings = useCallback((threadId: string, next: SessionSettings) => setSettings((current) => ({ ...current, [threadId]: next })), []);
  const handleSelectedSettings = useCallback((next: SessionSettings) => { if (selectedRef.current) handleSettings(selectedRef.current, next); }, [handleSettings]);
  const handleSelectedNotificationSettings = useCallback((next: NotificationPreferences) => {
    const threadId = selectedRef.current;
    if (!threadId) return;
    const current = settingsRef.current[threadId];
    if (!current) return;
    handleSettings(threadId, { ...current, notifications: next });
    if ((next.onCompletion || next.onFailure || next.onApprovalNeeded) && notifications.permission === "default") {
      void notifications.requestPermission();
    }
  }, [handleSettings, notifications]);
  const handleOpenBoardThread = useCallback((threadId: string) => handleSelect(threadId), [handleSelect]);
  const handleRefreshBoardThread = useCallback((threadId: string) => refreshThread(threadId, true), [refreshThread]);
  const handleVisibleBoardThreads = useCallback((threadIds: string[]) => {
    setVisibleBoardIds((current) => sameStringArray(current, threadIds) ? current : threadIds);
  }, []);
  const handleRefreshSelectedThread = useCallback(() => selectedRef.current ? refreshThread(selectedRef.current) : Promise.resolve(null), [refreshThread]);
  const handleClearControl = useCallback(() => setControlIds((ids) => ids.filter((id) => !threadStore.getLive(id).completed)), []);
  const handleClearSpark = useCallback(() => setSparkIds((ids) => ids.filter((id) => !threadStore.getLive(id).completed)), []);
  const idleThreadIds = useMemo(() => threads.filter((thread) => thread.status.type !== "active").map((thread) => thread.id), [threads]);

  const handleBatchAction = useCallback(async (_action: BatchAction, threadIds: string[]): Promise<string[]> => {
    const nextPinned = !threadIds.every((id) => pinned.has(id));
    const settled = await Promise.allSettled(threadIds.map((threadId) => api(`/api/sessions/${encodeURIComponent(threadId)}/pin`, {
      method: "POST",
      body: JSON.stringify({ pinned: nextPinned })
    })));
    const failed = threadIds.filter((_, index) => settled[index]?.status === "rejected");
    const succeeded = threadIds.filter((_, index) => settled[index]?.status === "fulfilled");
    setPinned((current) => {
      const next = new Set(current);
      for (const id of succeeded) nextPinned ? next.add(id) : next.delete(id);
      return next;
    });
    return failed;
  }, [pinned]);
  const handleReportedBatchAction = useCallback(async (action: BatchAction, threadIds: string[]): Promise<string[]> => {
    try {
      return await handleBatchAction(action, threadIds);
    } catch (error) {
      handleError(error);
      throw error;
    }
  }, [handleBatchAction, handleError]);

  const handleClearIdle = useCallback(() => requestSessionAction("archive", idleThreadIds), [idleThreadIds, requestSessionAction]);

  const handleCreated = useCallback(async (thread: Thread, requested: SessionSettings, sessionClass: SessionClass) => {
    const models = bootstrap?.models.data || [];
    const defaultModel = models.find((model) => model.isDefault) || models[0];
    const persisted = settingsFromThread(thread);
    const canonical = resolveThreadSettings(thread, models, bootstrap?.claudeModelOptions || [], requested, defaultModel);
    settingsMetadataSignatures.current.set(thread.id, `${persisted.model || ""}:${persisted.effort || ""}`);
    handleSettings(thread.id, canonical);
    threadStore.upsertSummary(thread);
    sessionClass === "spark" ? handleAddSpark(thread.id) : handleAddControl(thread.id);
    markOnboardingSeen();
    setOnboardingOpen(false);
    setNewOpen(false);
    await reload();
    setSelectedId(thread.id);
    setView("session");
  }, [bootstrap, handleAddControl, handleAddSpark, handleSettings, reload]);

  const handleLogout = useCallback(() => { void api("/api/logout", { method: "POST" }).then(handleSessionEnded).catch(handleError); }, [handleError, handleSessionEnded]);
  const handlePinCurrent = useCallback(() => { if (currentThreadRef.current) handleTogglePin(currentThreadRef.current.id); }, [handleTogglePin]);
  const handleRename = useCallback(() => { const thread = currentThreadRef.current; if (!thread) return; const name = window.prompt("Session name", threadTitle(thread)); if (!name?.trim()) return; void api(`/api/threads/${thread.id}`, { method: "PATCH", body: JSON.stringify({ name: name.trim() }) }).then(() => Promise.all([refreshThread(thread.id), reload()])).catch(handleError); }, [handleError, refreshThread, reload]);
  const handleOrganize = useCallback(() => { const thread = currentThreadRef.current; if (!thread) return; const category = window.prompt("Session category (blank clears it)", thread.category || ""); if (category === null) return; const tags = window.prompt("Tags, separated by commas", (thread.tags || []).join(", ")); if (tags === null) return; void api(`/api/threads/${thread.id}`, { method: "PATCH", body: JSON.stringify({ category, tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean) }) }).then(() => Promise.all([refreshThread(thread.id), reload()])).catch(handleError); }, [handleError, refreshThread, reload]);
  const handleArchiveCurrent = useCallback(() => { const thread = currentThreadRef.current; if (thread) requestSessionAction("archive", [thread.id]); }, [requestSessionAction]);
  const handleArchivePinned = useCallback((threadId: string, nextPinned: boolean) => {
    setPinned((current) => { const next = new Set(current); nextPinned ? next.add(threadId) : next.delete(threadId); return next; });
  }, []);
  const handleArchiveRestored = useCallback(async (threadId: string) => {
    await reload();
    setToast("Session restored to the active inventory.");
    setSelectedId(threadId);
  }, [reload]);
  const handleStopCurrent = useCallback(() => { const thread = currentThreadRef.current; if (thread) requestSessionAction("stop", [thread.id]); }, [requestSessionAction]);
  const handleToggleTheme = useCallback(() => setTheme((current) => {
    const dark = current === "dark" || (current === "system" && systemDarkTheme);
    return dark ? "light" : "dark";
  }), [systemDarkTheme]);
  const handleOpenPalette = useCallback(() => {
    setSidebarOpen(false);
    setErrorsOpen(false);
    notifications.closeCenter();
    setPaletteOpen(true);
  }, [notifications, setErrorsOpen]);
  const handleClosePalette = useCallback(() => setPaletteOpen(false), []);
  const handleNavigateRelative = useCallback((direction: -1 | 1) => {
    setView((current) => {
      const views: SidebarView[] = ["session", "control", "spark"];
      const index = views.indexOf(current);
      if (index === -1) return views[direction === 1 ? 0 : views.length - 1];
      return views[(index + direction + views.length) % views.length];
    });
    setSidebarOpen(false);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || document.querySelector("[aria-modal='true']")) return;
      const key = event.key.toLocaleLowerCase();
      if (key === "k") {
        event.preventDefault();
        handleOpenPalette();
      } else if (key === "n") {
        event.preventDefault();
        handleNew();
      } else if (key === "w") {
        event.preventDefault();
        const thread = currentThreadRef.current;
        if (!thread) setToast("Select a session to close.");
        else if (thread.archiveState === "archived") setToast("This session is already archived.");
        else handleArchiveCurrent();
      } else if (event.key === "[") {
        event.preventDefault();
        handleNavigateRelative(-1);
      } else if (event.key === "]") {
        event.preventDefault();
        handleNavigateRelative(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleArchiveCurrent, handleNavigateRelative, handleNew, handleOpenPalette]);

  const controlIdSet = useMemo(() => new Set(controlIds), [controlIds]);
  const sparkIdSet = useMemo(() => new Set(sparkIds), [sparkIds]);
  const controlThreads = useMemo(() => controlIds.map((id) => threads.find((thread) => thread.id === id)).filter((thread): thread is Thread => Boolean(thread) && thread!.sessionClass !== "spark"), [controlIds, threads]);
  const sparkThreads = useMemo(() => sparkIds.map((id) => threads.find((thread) => thread.id === id)).filter((thread): thread is Thread => Boolean(thread)), [sparkIds, threads]);
  const filteredStandardThreads = useMemo(() => filteredThreads.filter((thread) => thread.sessionClass !== "spark"), [filteredThreads]);
  const filteredSparkThreads = useMemo(() => filteredThreads.filter((thread) => thread.sessionClass === "spark"), [filteredThreads]);
  const defaultModel = bootstrap?.models.data.find((model) => model.isDefault) || bootstrap?.models.data[0];
  const activeSettings = useMemo(() => {
    if (!currentThread || !bootstrap) return null;
    const persisted = settingsFromThread(currentThread);
    const signature = `${persisted.model || ""}:${persisted.effort || ""}`;
    return settingsMetadataSignatures.current.get(currentThread.id) === signature
      ? normalizeThreadSettings(currentThread, bootstrap.models.data, bootstrap.claudeModelOptions || [], settings[currentThread.id], defaultModel)
      : resolveThreadSettings(currentThread, bootstrap.models.data, bootstrap.claudeModelOptions || [], settings[currentThread.id], defaultModel);
  }, [bootstrap, currentThread, defaultModel, settings]);
  const sessionNames = useMemo(() => Object.fromEntries(threads.map((thread) => [thread.id, threadTitle(thread)])), [threads]);
  const displayedBackendHealth = backendHealth === "unknown"
    ? backendHealthFromStatus(accountStatus?.runtime || startup?.health.runtime)
    : backendHealth;
  const modifierLabel = shortcutModifierLabel();
  const resolvedTheme = theme === "system" ? systemDarkTheme ? "dark" : "light" : theme;
  const currentRunning = Boolean(currentThread && (
    threadStore.getActiveIds().has(currentThread.id)
    || threadStore.getLive(currentThread.id).status?.type === "active"
    || currentThread.status.type === "active"
  ));
  const paletteSessions = useMemo(() => threads.map((thread) => ({
    id: thread.id,
    title: threadTitle(thread),
    cwd: thread.cwd,
    category: thread.category,
    tags: thread.tags
  })), [threads]);
  const sessionActionTargets = useMemo<SessionActionTarget[]>(() => (sessionActionRequest?.threadIds || []).map((threadId) => {
    const thread = threads.find((candidate) => candidate.id === threadId) || threadStore.getSummary(threadId);
    const live = threadStore.getLive(threadId);
    return {
      id: threadId,
      title: thread ? threadTitle(thread) : threadId,
      running: threadStore.getActiveIds().has(threadId) || live.status?.type === "active" || thread?.status.type === "active",
      queued: live.queue.length || thread?.queueDepth || 0,
      onBoard: controlIds.includes(threadId) || sparkIds.includes(threadId),
      archived: thread?.archiveState === "archived"
    };
  }), [controlIds, sessionActionRequest, sparkIds, threads]);

  const runSessionAction = useCallback(async (operation: SessionOperation, targets: SessionActionTarget[]): Promise<SessionActionResult[]> => {
    if (operation === "delete") return targets.map((target) => ({ threadId: target.id, status: "skipped", message: "Permanent delete is unavailable" }));
    if (operation === "remove") {
      return targets.map((target) => {
        if (!target.onBoard) return { threadId: target.id, status: "skipped", message: "Not on a board" };
        const thread = threads.find((candidate) => candidate.id === target.id) || threadStore.getSummary(target.id);
        thread?.sessionClass === "spark" ? handleRemoveSpark(target.id) : handleRemoveControl(target.id);
        return { threadId: target.id, status: "succeeded", message: "Removed from board" };
      });
    }
    if (operation === "stop") {
      const settled = await Promise.allSettled(targets.map(async (target): Promise<SessionActionResult> => {
        if (!target.running) return { threadId: target.id, status: "skipped", message: "No running turn" };
        await api(`/api/threads/${target.id}/interrupt`, { method: "POST", body: "{}" });
        void refreshThread(target.id, true).catch(handleError);
        return { threadId: target.id, status: "succeeded", message: "Turn interrupted" };
      }));
      return settled.map((result, index) => result.status === "fulfilled" ? result.value : actionFailure(targets[index].id, result.reason, handleError));
    }

    const archiveIds = targets.filter((target) => !target.archived).map((target) => target.id);
    const archived = new Map<string, SessionActionResult>();
    if (archiveIds.length) {
      try {
        const response = await api<{ results: Array<{ threadId: string; ok: boolean; error?: unknown }> }>("/api/threads/batch", { method: "POST", body: JSON.stringify({ operation: "archive", threadIds: archiveIds }) });
        for (const result of response.results) {
          if (result.ok) {
            archived.set(result.threadId, { threadId: result.threadId, status: "succeeded", message: "Archive accepted" });
            removeThreadState(result.threadId);
          } else {
            archived.set(result.threadId, actionFailure(result.threadId, result.error, handleError));
          }
        }
      } catch (error) {
        for (const threadId of archiveIds) archived.set(threadId, actionFailure(threadId, error, handleError));
      }
      await reload().catch(handleError);
    }
    return targets.map((target) => target.archived
      ? { threadId: target.id, status: "skipped", message: "Already archived" }
      : archived.get(target.id) || { threadId: target.id, status: "failed", message: "Archive returned no result" });
  }, [handleError, handleRemoveControl, handleRemoveSpark, refreshThread, reload, removeThreadState, threads]);

  const undoBoardRemoval = useCallback((threadIds: string[]) => {
    for (const threadId of threadIds) {
      const thread = threads.find((candidate) => candidate.id === threadId) || threadStore.getSummary(threadId);
      thread?.sessionClass === "spark" ? handleAddSpark(threadId) : handleAddControl(threadId);
    }
  }, [handleAddControl, handleAddSpark, threads]);

  if (authenticated === null) return <Splash />;
  if (!authenticated) return <Login onSuccess={handleLoginSuccess} />;
  if (!bootstrap) return <Splash label="Connecting to your Codex account…" />;

  return <div className="app-shell">
    <Sidebar open={sidebarOpen} bootstrap={bootstrap} threads={filteredThreads} totalCount={inventoryTotal} selectedId={selectedId} view={view} controlIds={controlIdSet} sparkIds={sparkIdSet} pinned={pinned} search={search} sortMode={sortMode} sortDirection={sortDirection} filters={filters} facets={facets} hasMore={hasMore} loadingMore={loadingMore} idleCount={idleThreadIds.length} unseenNotificationCount={notifications.unseenCount} errors={errors} waitingThreadIds={waitingThreadIds}
      onClose={handleCloseSidebar} onNew={handleNew} onView={handleView} onSearch={handleSearch} onSort={handleSort} onSortDirection={handleSortDirection} onFilters={handleFilters} onLoadMore={loadMore} onSelect={handleSelect} onTogglePin={handleTogglePin} onToggleBoard={handleToggleBoard} onBatchAction={handleReportedBatchAction} onSessionAction={requestSessionAction} onClearIdle={handleClearIdle} onNotifications={notifications.openCenter} onInsights={handleOpenInsights} onKnowledgePacks={() => setKnowledgePacksOpen(true)} onPolicies={() => setPoliciesOpen(true)} onLogout={handleLogout} />
    {sidebarOpen && <button type="button" className="sidebar-scrim" onClick={handleCloseSidebar} aria-label="Close sidebar" />}
    <main className="main-panel">
      <header className="topbar"><button ref={mobileMenuRef} className="icon-button mobile-menu" onClick={handleOpenSidebar} aria-label="Open sidebar"><Menu size={20} /></button>
        {view === "control" ? <BoardHeader variant="control" count={controlThreads.length} activeCount={controlThreads.filter((thread) => thread.status.type === "active").length} /> : view === "spark" ? <BoardHeader variant="spark" count={sparkThreads.length} activeCount={sparkThreads.filter((thread) => thread.status.type === "active").length} /> : view === "missions" ? <MissionsHeader /> : view === "compare" ? <ComparisonHeader /> : view === "evals" ? <EvalHeader /> : view === "archive" ? <ArchiveHeader /> : currentThread ? <ThreadHeader thread={currentThread} settings={activeSettings} notificationPermission={notifications.permission} pinned={pinned.has(currentThread.id)} archiveShortcut={`${modifierLabel}W`} onNotifications={handleSelectedNotificationSettings} onReplay={() => setReplayThreadId(currentThread.id)} onPin={handlePinCurrent} onRename={handleRename} onOrganize={handleOrganize} onArchive={handleArchiveCurrent} /> : <div className="topbar-placeholder">Session workspace</div>}
        <AppPreferences pollInterval={pollInterval} onPollInterval={handlePollInterval} theme={theme} modifierLabel={modifierLabel} onCommands={handleOpenPalette} onTheme={setTheme} />
        <ConnectionStatus transport={transport} backendHealth={displayedBackendHealth} lastSyncedAt={lastSyncedAt} nextReconnectAt={nextReconnectAt} pollInterval={pollInterval} onReconnect={reconnect} />
      </header>
      {mobileLayout && <div className="mobile-monitor-summary">
        <FleetSummary threads={threads} bootstrap={bootstrap} approvalCount={pending.length} errors={errors} compact onError={handleError} />
      </div>}
      <section className="workspace-panel" id="workspace-panel" role="tabpanel" aria-labelledby={`workspace-tab-${view}`}>
      {view === "control" ? <ControlCenter threads={controlThreads} allThreads={filteredStandardThreads} fleetThreads={threads} bootstrap={bootstrap} approvalCount={pending.length} showFleetSummary={!mobileLayout} errors={errors} waitingThreadIds={waitingThreadIds} models={bootstrap.models.data} claudeModels={bootstrap.claudeModelOptions || []} settings={settings} defaultModel={defaultModel} pollInterval={0} onSettings={handleSettings} onOpen={handleOpenBoardThread} onRemove={(threadId) => requestSessionAction("remove", [threadId])} onAdd={handleAddControl} onClearCompleted={handleClearControl} onVisibleThreadsChange={handleVisibleBoardThreads} onSessionAction={requestSessionAction} onRefresh={handleRefreshBoardThread} onError={handleError} />
        : view === "spark" ? <SparkBoard threads={sparkThreads} allThreads={filteredSparkThreads} errors={errors} waitingThreadIds={waitingThreadIds} models={bootstrap.models.data} claudeModels={[]} settings={settings} defaultModel={defaultModel} pollInterval={0} onSettings={handleSettings} onOpen={handleOpenBoardThread} onRemove={(threadId) => requestSessionAction("remove", [threadId])} onAdd={handleAddSpark} onClearCompleted={handleClearSpark} onVisibleThreadsChange={handleVisibleBoardThreads} onLaunch={handleNewSpark} onSessionAction={requestSessionAction} onRefresh={handleRefreshBoardThread} onError={handleError} />
        : view === "missions" ? <MissionsView onError={handleError} />
        : view === "compare" ? <ComparisonLab bootstrap={bootstrap} onOpenSession={handleSelect} onError={handleError} />
        : view === "evals" ? <EvalLab bootstrap={bootstrap} onOpenSession={handleSelect} onError={handleError} />
        : view === "archive" ? <ArchiveView onError={handleError} onPinned={handleArchivePinned} onRestored={handleArchiveRestored} />
        : currentThread && activeSettings ? <Chat key={currentThread.id} thread={currentThread} loading={loadingDetail} models={bootstrap.models.data} claudeModels={bootstrap.claudeModelOptions || []} settings={activeSettings} onSettings={handleSelectedSettings} onRefresh={handleRefreshSelectedThread} onSessionAction={(operation) => requestSessionAction(operation, [currentThread.id])} onError={handleError} />
        : <Welcome onNew={handleNew} />}
      </section>
    </main>
    {onboardingOpen && !newOpen && <OnboardingOverlay onClose={handleDismissOnboarding} onQuickStart={handleOnboardingQuickStart} />}
    {newOpen && <NewSessionModal bootstrap={bootstrap} sessionClass={newSessionClass} quickStart={newQuickStart} recentThreads={threads} onClose={handleCloseNew} onCreated={handleCreated} onError={handleError} />}
    {insightsOpen && <InsightsPanel onClose={handleCloseInsights} onSelectSession={handleInsightSession} onError={handleError} />}
    {knowledgePacksOpen && <KnowledgePacksDialog roots={bootstrap.roots} onClose={() => setKnowledgePacksOpen(false)} onError={handleError} />}
    {policiesOpen && <PoliciesDialog bootstrap={bootstrap} onClose={() => setPoliciesOpen(false)} onError={handleError} />}
    {replayThreadId && <SessionReplay threadId={replayThreadId} onClose={handleCloseReplay} onError={handleError} />}
    {sessionActionRequest && <SessionActionDialog request={sessionActionRequest} targets={sessionActionTargets} onRun={runSessionAction} onUndoRemove={undoBoardRemoval} onClose={handleCloseSessionAction} />}
    {paletteOpen && <CommandPalette sessions={paletteSessions} selectedTitle={currentThread ? threadTitle(currentThread) : null}
      canStop={currentRunning} canArchive={Boolean(currentThread && currentThread.archiveState !== "archived")} theme={resolvedTheme} modifierLabel={modifierLabel}
      onClose={handleClosePalette} onNew={handleNew} onSelectSession={handleSelect} onStop={handleStopCurrent} onArchive={handleArchiveCurrent}
      onNavigate={handleView} onNavigateRelative={handleNavigateRelative} onToggleTheme={handleToggleTheme} />}
    {pending.length > 0 && <ApprovalTray requests={pending} onResolved={resolvePending} onError={handleError} />}
    <NotificationCenter entries={notifications.entries} open={notifications.open} onClose={notifications.closeCenter} onFocus={notifications.focusNotification} onDismiss={notifications.dismiss} onClear={notifications.clear} />
    <NotificationToasts entries={notifications.toasts} onFocus={notifications.focusNotification} onDismiss={notifications.dismissToast} />
    <ErrorCenter entries={errors} open={errorsOpen} sessionNames={sessionNames} onOpen={() => setErrorsOpen(true)} onClose={() => setErrorsOpen(false)} onDismiss={dismissError} onClear={clearErrors} onRetry={handleRetryError} />
    {toast && <div className="toast" role="status"><ShieldCheck size={17} />{toast}<button onClick={handleDismissToast} aria-label="Dismiss notification"><X size={15} /></button></div>}
  </div>;
}

type ThreadRecoveryResponse = {
  revision: number;
  threadId: string;
  state: LiveThreadState | null;
  queue: QueueEntry[];
  active: boolean;
};

async function readThreadRecoverySnapshot(threadIds: readonly string[], signal?: AbortSignal): Promise<LiveRecoverySnapshot> {
  if (!threadIds.length) {
    const { revision } = await api<{ revision: number }>("/api/events/revision", { signal });
    return { revision, threadRevisions: {}, data: {}, queues: {}, activeThreadIds: [] };
  }
  const responses = await mapWithConcurrency(threadIds, 8, (threadId) => api<ThreadRecoveryResponse>(
    `/api/threads/${encodeURIComponent(threadId)}/recovery`,
    { signal }
  ));
  const threadRevisions: Record<string, number> = {};
  const data: Record<string, LiveThreadState> = {};
  const queues: Record<string, QueueEntry[]> = {};
  const activeThreadIds: string[] = [];
  for (const response of responses) {
    threadRevisions[response.threadId] = response.revision;
    if (response.state) data[response.threadId] = response.state;
    queues[response.threadId] = response.queue;
    if (response.active) activeThreadIds.push(response.threadId);
  }
  return {
    revision: Math.min(...responses.map((response) => response.revision)),
    threadRevisions,
    data,
    queues,
    activeThreadIds
  };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await operation(values[index]);
    }
  }));
  return results;
}

function OnboardingOverlay({ onClose, onQuickStart }: { onClose: () => void; onQuickStart: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled)")];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); previousFocus?.focus(); };
  }, [onClose]);

  return <div className="modal-backdrop onboarding-backdrop">
    <div ref={dialogRef} className="onboarding-dialog" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" aria-describedby="onboarding-description">
      <button type="button" className="icon-button onboarding-close" onClick={onClose} aria-label="Dismiss welcome guide"><X size={18} /></button>
      <div className="onboarding-mark"><div className="brand-mark large"><span /><span /><span /></div></div>
      <span className="eyebrow">First run</span>
      <h1 id="onboarding-title">Get a session running</h1>
      <p id="onboarding-description">Three steps: pick a workspace, choose a model, then launch. Sessions keep working on this machine even if you close the browser.</p>
      <div className="onboarding-steps">
        <article><span>1</span><div><strong>Workspace</strong><small>The project directory the agent can work in.</small></div></article>
        <article><span>2</span><div><strong>Model</strong><small>Start with the recommended defaults; ForgeDeck remembers them.</small></div></article>
        <article><span>3</span><div><strong>Task</strong><small>Launch now, or open an empty session and type later.</small></div></article>
      </div>
      <div className="onboarding-template"><BookOpen size={18} /><div><strong>Quick-start: workspace tour</strong><span>Read-only tour of the project with suggested next tasks.</span></div></div>
      <div className="onboarding-actions"><button type="button" className="secondary-button" onClick={onClose}>Skip</button><button type="button" className="primary-button" onClick={onQuickStart}><Sparkles size={16} />Use quick-start</button></div>
    </div>
  </div>;
}

function Splash({ label = "Warming up ForgeDeck…" }: { label?: string }) { return <div className="splash"><Brand /><LoaderCircle className="spin" size={22} /><span>{label}</span></div>; }

function Login({ onSuccess }: { onSuccess: () => void }) {
  const [token, setToken] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(""); try { await api("/api/login", { method: "POST", body: JSON.stringify({ token }), allowUnauthenticated: true }); onSuccess(); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); } finally { setBusy(false); } };
  return <div className="login-page"><div className="login-glow" /><form className="login-card" onSubmit={submit}><Brand /><div className="login-icon"><KeyRound size={25} /></div><h1>Unlock ForgeDeck</h1><p>Paste the access key from startup output, or from <code>.data/access-token</code> on this host.</p><label>Access key<input autoFocus type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Access key" /></label>{error && <div className="form-error" role="alert">{error}</div>}<button className="primary-button" disabled={busy || !token}>{busy ? <LoaderCircle className="spin" size={17} /> : <ArrowLeft className="enter-arrow" size={17} />}Continue</button><div className="private-note"><ShieldCheck size={15} />Provider credentials stay on the host — never in the browser.</div></form></div>;
}

function AppPreferences({ pollInterval, theme, modifierLabel, onPollInterval, onCommands, onTheme }: {
  pollInterval: number;
  theme: ThemeMode;
  modifierLabel: string;
  onPollInterval: (value: number) => void;
  onCommands: () => void;
  onTheme: (value: ThemeMode) => void;
}) {
  const ThemeIcon = theme === "system" ? Monitor : theme === "light" ? Sun : Moon;
  return <div className="app-preferences"><button type="button" className="command-palette-trigger" onClick={onCommands} aria-label="Open command palette" aria-keyshortcuts="Meta+K Control+K" title={`Open command palette (${modifierLabel}K)`}><CommandIcon size={14} /><kbd>{modifierLabel}K</kbd></button><label className="poll-setting"><RefreshCw size={14} /><select value={pollInterval} onChange={(event) => onPollInterval(Number(event.target.value))} aria-label="Polling fallback interval"><option value={0}>Auto fallback</option><option value={2000}>Fallback 2s</option><option value={4000}>Fallback 4s</option><option value={10000}>Fallback 10s</option><option value={30000}>Fallback 30s</option></select></label><label className="theme-setting"><ThemeIcon size={15} /><select value={theme} onChange={(event) => onTheme(event.target.value as ThemeMode)} aria-label="Color theme"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label></div>;
}

function ConnectionStatus({ transport, backendHealth, lastSyncedAt, nextReconnectAt, pollInterval, onReconnect }: {
  transport: TransportState;
  backendHealth: BackendHealth;
  lastSyncedAt: number | null;
  nextReconnectAt: number | null;
  pollInterval: number;
  onReconnect: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const interval = pollInterval > 0 ? pollInterval : 10_000;
  const primary = transport === "live" ? "Live"
    : transport === "polling" ? `Polling every ${formatInterval(interval)}`
      : transport === "offline" ? "Offline" : "Reconnecting";
  const lastSync = lastSyncedAt === null ? "Not synced yet" : `Last synced ${Math.max(0, Math.floor((now - lastSyncedAt) / 1_000))} seconds ago`;
  const backend = backendHealth === "unknown" ? "Backend health unknown" : `Backend ${backendHealth}`;
  const retry = nextReconnectAt === null ? "" : ` Automatic retry in ${Math.max(0, Math.ceil((nextReconnectAt - now) / 1_000))} seconds.`;
  return <div className={`connection-status ${transport}`} title={`${primary}. ${lastSync}. ${backend}.${retry}`}>
    <span className="sr-only" role="status" aria-atomic="true">{primary}. {backend}.</span>
    <i className="connection-dot" aria-hidden="true" />
    <span className="connection-copy" aria-hidden="true"><span><b>{primary}</b>{backendHealth !== "ready" && backendHealth !== "unknown" && <em>{backend}</em>}</span><small>{lastSync}</small></span>
    {transport !== "live" && <button type="button" onClick={onReconnect} disabled={transport === "reconnecting" && nextReconnectAt === null} aria-label="Reconnect live stream now" title="Reconnect live stream now"><RefreshCw size={13} /></button>}
  </div>;
}

function formatInterval(interval: number): string {
  return interval % 1_000 === 0 ? `${interval / 1_000}s` : `${(interval / 1_000).toFixed(1)}s`;
}

function backendHealthFromStatus(status: Record<string, unknown> | undefined): BackendHealth {
  if (!status) return "unknown";
  if (status.available === true || status.state === "ready") return "ready";
  if (status.state === "error") return "error";
  if (status.available === false || ["offline", "connecting", "stopping", "stopped"].includes(String(status.state))) return "offline";
  return "unknown";
}

function ThreadHeader({ thread, settings, notificationPermission, pinned, archiveShortcut, onNotifications, onReplay, onPin, onRename, onOrganize, onArchive }: {
  thread: Thread;
  settings: SessionSettings | null;
  notificationPermission: DesktopNotificationPermission;
  pinned: boolean;
  archiveShortcut: string;
  onNotifications: (preferences: NotificationPreferences) => void;
  onReplay: () => void;
  onPin: () => void;
  onRename: () => void;
  onOrganize: () => void;
  onArchive: () => void;
}) {
  const archived = thread.archiveState === "archived";
  const exportBase = `/api/sessions/${encodeURIComponent(thread.id)}/export`;
  return <div className="thread-header">
    <div className="thread-title"><div className="thread-icon"><Sparkles size={18} /></div><div><strong>{threadTitle(thread)}{archived ? " · Archived" : ""}</strong><span><Folder size={12} />{thread.cwd}{thread.gitInfo?.branch && <><i>·</i><GitBranch size={11} /><b>{thread.gitInfo.branch}</b></>}{settings?.model && <><i>·</i><em>{settings.model} · {settings.effort}</em></>}</span></div></div>
    <div className="header-actions desktop-header-actions">
      {settings && <SessionNotificationPreferences value={notificationPreferences(settings)} permission={notificationPermission} onChange={onNotifications} />}
      <button className="icon-button" onClick={onReplay} aria-label="Open session replay" title="Session replay"><History size={16} /></button>
      <details className="session-export"><summary className="icon-button" aria-label="Export session" title="Export session"><FileDown size={16} /></summary><div className="session-export-panel"><strong>Export session</strong><span>Secrets are redacted and raw tool output is excluded.</span><a href={`${exportBase}?format=markdown`} download={`forgedeck-session-${thread.id}.md`}><FileText size={15} /><span><b>Markdown</b><small>Human-readable report</small></span></a><a href={`${exportBase}?format=json`} download={`forgedeck-session-${thread.id}.json`}><FileJson size={15} /><span><b>JSON</b><small>Structured run record</small></span></a></div></details>
      <button className="icon-button" onClick={onPin} aria-label={pinned ? "Unpin session" : "Pin session"} aria-pressed={pinned}>{pinned ? <PinOff size={16} /> : <Pin size={16} />}</button>
      <button className="icon-button" disabled={archived} onClick={onRename} aria-label="Rename session"><Settings2 size={16} /></button>
      <button className="icon-button" disabled={archived} onClick={onOrganize} aria-label="Edit category and tags"><Tags size={16} /></button>
      <button className="icon-button danger" disabled={archived} onClick={onArchive} aria-label={archived ? "Session is archived" : "Archive session"} aria-keyshortcuts="Meta+W Control+W" title={archived ? "Session is archived" : `Archive session (${archiveShortcut})`}><Archive size={16} /></button>
    </div>
    <div className="mobile-header-actions">
      {settings && <SessionNotificationPreferences value={notificationPreferences(settings)} permission={notificationPermission} onChange={onNotifications} />}
      <details className="mobile-session-menu">
        <summary className="icon-button" aria-label="Open session actions"><EllipsisVertical size={18} /></summary>
        <div className="mobile-session-menu-panel">
          <strong>Session actions</strong>
          <button onClick={onReplay}><History size={16} />Replay</button>
          <a href={`${exportBase}?format=markdown`} download={`forgedeck-session-${thread.id}.md`}><FileText size={16} />Export Markdown</a>
          <a href={`${exportBase}?format=json`} download={`forgedeck-session-${thread.id}.json`}><FileJson size={16} />Export JSON</a>
          <button onClick={onPin}>{pinned ? <PinOff size={16} /> : <Pin size={16} />}{pinned ? "Unpin" : "Pin"}</button>
          <button disabled={archived} onClick={onRename}><Settings2 size={16} />Rename</button>
          <button disabled={archived} onClick={onOrganize}><Tags size={16} />Category and tags</button>
          <button className="danger" disabled={archived} onClick={onArchive}><Archive size={16} />{archived ? "Archived" : "Archive"}</button>
        </div>
      </details>
    </div>
  </div>;
}

function Welcome({ onNew }: { onNew: () => void }) { return <div className="welcome"><div className="welcome-mark"><div className="brand-mark large"><span /><span /><span /></div></div><h1>No session selected</h1><p>Pick one from the sidebar, or launch a new session in any workspace. Work continues on this machine if you close the tab.</p><button className="primary-button" onClick={onNew}><Plus size={17} />New session</button></div>; }

function threadTitle(thread: Thread) { return thread.name || thread.preview || "Untitled session"; }
function notificationCopy(event: LiveNotificationEvent): { title: string; message: string } {
  if (event.kind === "completed") return { title: "Session completed", message: "The current turn finished successfully." };
  if (event.kind === "failed") return { title: "Session failed", message: event.message ? truncateNotification(event.message) : "The current turn ended with an error." };
  if (event.kind === "approval") return { title: "Approval needed", message: "Work is paused until you review the pending request." };
  const count = event.queuedCount || 1;
  return {
    title: "Session queued",
    message: count > 1 ? `${count} new tasks were added to the queue.` : event.message ? `Queued: ${truncateNotification(event.message)}` : "A task was added to the queue."
  };
}
function truncateNotification(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 160 ? `${normalized.slice(0, 157)}…` : normalized;
}
function actionFailure(threadId: string, error: unknown, report: (error: unknown) => void, prefix?: string): SessionActionResult {
  const normalized = error instanceof Error ? error : apiErrorFromPayload(error, { scope: "sessions", sessionId: threadId });
  report(normalized);
  return { threadId, status: "failed", message: prefix ? `${prefix}: ${normalized.message}` : normalized.message };
}
function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function readSortMode(): SortMode { const value = readStoredString("forgedeck-sort"); return value === "created" || value === "name" || value === "directory" || value === "status" ? value : "updated"; }
function readSortDirection(): SortDirection { return readStoredString("forgedeck-sort-direction") === "asc" ? "asc" : "desc"; }
function readPollInterval() { const value = Number(readStoredString("forgedeck-poll-interval")); return POLL_INTERVALS.includes(value as typeof POLL_INTERVALS[number]) ? value : 4_000; }
function readTheme(): ThemeMode { const value = readStoredString("forgedeck-theme"); return value === "dark" || value === "light" || value === "system" ? value : "system"; }
function readView(): SidebarView { const value = readStoredString("forgedeck-view"); return value === "control" || value === "spark" || value === "missions" || value === "compare" || value === "evals" || value === "archive" ? value : "session"; }
function shortcutModifierLabel(): string { return /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "⌘" : "Ctrl+"; }
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}
function readLinkedSessionId(): string | null {
  const value = new URLSearchParams(window.location.search).get("session");
  return value && /^[a-zA-Z0-9_-]{8,128}$/.test(value) ? value : null;
}
