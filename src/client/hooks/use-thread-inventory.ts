import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, isSessionRemovalError } from "../api/client";
import { threadStore, useActiveThreadIds, useThreadInventorySnapshot } from "../state/thread-store";
import type { Thread } from "../types";

export type SortMode = "updated" | "created" | "name" | "directory" | "status";
export type SortDirection = "asc" | "desc";
export type ThreadFilters = {
  status: "all" | "active" | "idle" | "error";
  backend: "all" | "codex" | "claude";
  sessionClass: "all" | "standard" | "spark";
  model: string;
  workspace: string;
  label: string;
  queueState: "all" | "empty" | "queued";
  owner: string;
  source: "all" | "user" | "mcp" | "external";
  archiveState: "active" | "archived" | "all";
  dateFrom: string;
  dateTo: string;
};

export type InventoryFacet = { value: string; count: number };
export type InventoryFacets = {
  status: InventoryFacet[];
  backend: InventoryFacet[];
  model: InventoryFacet[];
  workspace: InventoryFacet[];
  labels: InventoryFacet[];
  queueState: InventoryFacet[];
  owner: InventoryFacet[];
  source: InventoryFacet[];
  archiveState: InventoryFacet[];
  sessionClass: InventoryFacet[];
};

export const DEFAULT_THREAD_FILTERS: ThreadFilters = {
  status: "all",
  backend: "all",
  sessionClass: "all",
  model: "",
  workspace: "",
  label: "",
  queueState: "all",
  owner: "",
  source: "all",
  archiveState: "active",
  dateFrom: "",
  dateTo: ""
};

const EMPTY_FACETS: InventoryFacets = {
  status: [], backend: [], model: [], workspace: [], labels: [], queueState: [], owner: [], source: [], archiveState: [], sessionClass: []
};
const PAGE_SIZE = 100;

type UseThreadInventoryOptions = {
  enabled: boolean;
  search: string;
  sortMode: SortMode;
  sortDirection?: SortDirection;
  filters?: ThreadFilters;
  pinned: ReadonlySet<string>;
};

type InventoryResponse = {
  data: Thread[];
  nextCursor: string | null;
  revision: string;
  total: number;
  facets: InventoryFacets;
  refreshedAt: number;
};

export function useThreadInventory({
  enabled, search, sortMode, sortDirection = "desc", filters = DEFAULT_THREAD_FILTERS, pinned
}: UseThreadInventoryOptions) {
  const inventory = useThreadInventorySnapshot();
  const activeIds = useActiveThreadIds();
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  const [resultIds, setResultIds] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const nextCursorRef = useRef<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [facets, setFacets] = useState<InventoryFacets>(EMPTY_FACETS);
  const [revision, setRevision] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const inventoryController = useRef<AbortController | null>(null);
  const detailControllers = useRef(new Map<string, AbortController>());

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 180);
    return () => clearTimeout(timer);
  }, [search]);

  const queryString = useMemo(() => {
    const query = new URLSearchParams({
      limit: String(PAGE_SIZE),
      sortKey: serverSortKey(sortMode),
      sortDirection,
      archiveState: filters.archiveState
    });
    if (debouncedSearch.trim()) query.set("search", debouncedSearch.trim());
    if (filters.status !== "all") query.set("status", filters.status);
    if (filters.backend !== "all") query.set("provider", filters.backend);
    if (filters.sessionClass !== "all") query.set("sessionClass", filters.sessionClass);
    if (filters.model) query.set("model", filters.model);
    if (filters.workspace) query.set("workspace", filters.workspace);
    if (filters.label) query.set("label", filters.label);
    if (filters.queueState !== "all") query.set("queueState", filters.queueState);
    if (filters.owner) query.set("owner", filters.owner);
    if (filters.source !== "all") query.set("source", filters.source);
    if (filters.dateFrom) query.set("dateFrom", filters.dateFrom);
    if (filters.dateTo) query.set("dateTo", filters.dateTo);
    return query.toString();
  }, [debouncedSearch, filters, sortDirection, sortMode]);

  const defaultQuery = useMemo(() => !debouncedSearch.trim() && isDefaultFilters(filters), [debouncedSearch, filters]);

  const load = useCallback(async (append = false) => {
    inventoryController.current?.abort();
    const controller = new AbortController();
    inventoryController.current = controller;
    append ? setLoadingMore(true) : setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams(queryString);
      if (append && nextCursorRef.current) query.set("cursor", nextCursorRef.current);
      const page = await api<InventoryResponse>(`/api/threads?${query}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!append && defaultQuery) threadStore.replaceSummaries(page.data);
      else threadStore.mergeSummaries(page.data);
      setResultIds((current) => append ? uniqueIds([...current, ...page.data.map((thread) => thread.id)]) : page.data.map((thread) => thread.id));
      nextCursorRef.current = page.nextCursor;
      setNextCursor(page.nextCursor);
      setTotalCount(page.total);
      setFacets(page.facets || EMPTY_FACETS);
      setRevision(page.revision);
    } catch (caught) {
      if ((caught as Error).name !== "AbortError") {
        const next = caught instanceof Error ? caught : new Error(String(caught));
        setError(next);
        throw next;
      }
    } finally {
      if (inventoryController.current === controller) {
        inventoryController.current = null;
        append ? setLoadingMore(false) : setLoading(false);
      }
    }
  }, [defaultQuery, queryString]);

  useEffect(() => {
    if (!enabled) return;
    void load(false).catch(() => undefined);
    return () => inventoryController.current?.abort();
  }, [enabled, load]);

  const loadDetail = useCallback(async (threadId: string): Promise<Thread | null> => {
    detailControllers.current.get(threadId)?.abort();
    const controller = new AbortController();
    detailControllers.current.set(threadId, controller);
    try {
      const response = await api<{ thread: Thread }>(`/api/threads/${encodeURIComponent(threadId)}`, { signal: controller.signal });
      if (controller.signal.aborted) return null;
      threadStore.upsertDetail(response.thread);
      return response.thread;
    } catch (caught) {
      if ((caught as Error).name === "AbortError") return null;
      // External removals can make this request finish before the stream's
      // `threads: removed` event is applied. The response is also a tombstone.
      if (isSessionRemovalError(caught)) {
        const existed = Boolean(threadStore.getSummary(threadId));
        threadStore.removeThread(threadId);
        setResultIds((current) => current.filter((id) => id !== threadId));
        if (existed) setTotalCount((current) => Math.max(0, current - 1));
        return null;
      }
      throw caught;
    } finally {
      if (detailControllers.current.get(threadId) === controller) detailControllers.current.delete(threadId);
    }
  }, []);

  const cancelDetail = useCallback((threadId: string) => {
    detailControllers.current.get(threadId)?.abort();
    detailControllers.current.delete(threadId);
  }, []);

  useEffect(() => () => {
    inventoryController.current?.abort();
    for (const controller of detailControllers.current.values()) controller.abort();
    detailControllers.current.clear();
  }, []);

  const threads = useMemo(() => inventory.map((thread) => withLiveStatus(thread, activeIds)), [activeIds, inventory]);
  const byId = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);
  const filteredThreads = useMemo(() => {
    const result = resultIds.map((id) => byId.get(id)).filter((thread): thread is Thread => Boolean(thread));
    return result.sort((left, right) => Number(pinned.has(right.id)) - Number(pinned.has(left.id)));
  }, [byId, pinned, resultIds]);

  return {
    threads,
    filteredThreads,
    loading,
    loadingMore,
    error,
    totalCount,
    facets,
    revision,
    hasMore: Boolean(nextCursor),
    fullyLoaded: defaultQuery && !nextCursor && resultIds.length === totalCount,
    reload: useCallback(() => load(false), [load]),
    loadMore: useCallback(() => nextCursor ? load(true) : Promise.resolve(), [load, nextCursor]),
    loadDetail,
    cancelDetail,
    remove: useCallback((threadId: string) => {
      setResultIds((current) => current.filter((id) => id !== threadId));
      setTotalCount((current) => Math.max(0, current - 1));
      threadStore.removeThread(threadId);
    }, []),
    upsert: useCallback((thread: Thread) => threadStore.upsertSummary(thread), [])
  };
}

function serverSortKey(sortMode: SortMode): "updated_at" | "created_at" | "name" | "directory" | "status" {
  if (sortMode === "updated") return "updated_at";
  if (sortMode === "created") return "created_at";
  return sortMode;
}

function isDefaultFilters(filters: ThreadFilters): boolean {
  return filters.status === "all" && filters.backend === "all" && filters.sessionClass === "all"
    && !filters.model && !filters.workspace && !filters.label && filters.queueState === "all"
    && !filters.owner && filters.source === "all" && filters.archiveState === "active"
    && !filters.dateFrom && !filters.dateTo;
}

function withLiveStatus(thread: Thread, activeIds: ReadonlySet<string>): Thread {
  const active = activeIds.has(thread.id) || thread.turns.some((turn) => turn.status === "inProgress");
  return active && thread.status.type !== "active"
    ? { ...thread, status: { type: "active", activeFlags: [] } }
    : thread;
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}
