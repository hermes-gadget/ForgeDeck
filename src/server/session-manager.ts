import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { BlueprintManager } from "./blueprints.js";
import { ArtifactManager, type ArtifactCreateContext } from "./artifacts.js";
import { ComparisonManager } from "./comparisons.js";
import { DEFAULT_SESSION_TTL_MS } from "./config.js";
import { EvalManager } from "./evals.js";
import { ConflictError } from "./errors.js";
import { logger } from "./logger.js";
import { KnowledgePackManager } from "./knowledge-packs.js";
import { MissionManager } from "./missions.js";
import { PolicyManager } from "./policy-engine.js";
import { ScheduleManager } from "./schedules.js";
import {
  TransactionalStore,
  type AuditStoreRow,
  type BudgetPolicyStoreRow,
  type BudgetScopeType,
  type CostEstimateStoreRow,
  type CanonicalItemStoreRow,
  type MetadataStoreRow,
  type QuotaEventStoreRow,
  type SessionEventOutcome,
  type SessionEventStoreRow,
  type SessionOperationKind,
  type SessionOperationStatus,
  type SessionOperationStoreRow,
  type UsageAggregateStoreRow,
  type UsageEventStoreRow,
  type UsageProvider
} from "./store.js";
import type { RunGuardianState } from "./run-guardian.js";
import type { Artifact, ArtifactStatus, ModelPreset } from "../shared/contracts.js";

export { DEFAULT_SESSION_TTL_MS } from "./config.js";

export type SessionClass = "standard" | "spark";
export type SessionBackend = "codex" | "claude";
export type SessionArchiveReason = "manual" | "ttl";
export type WorkspaceLeaseMode = "read-only" | "exclusive";
export type WorkspaceLease = {
  sessionId: string;
  root: string;
  mode: WorkspaceLeaseMode;
  fileScope?: string[];
  acquiredAt: number;
};
export type WorkspaceLeaseStatus = {
  root: string;
  state: "available" | WorkspaceLeaseMode;
  leases: WorkspaceLease[];
};
export type BlueprintRunModelConfiguration = {
  backend: SessionBackend;
  model: string;
  effort: string | null;
  preset?: ModelPreset | null;
};

export type SessionMetadata = {
  tags: string[];
  category: string | null;
  createdAt: number;
  updatedAt: number;
  sessionClass: SessionClass;
  backend: SessionBackend;
  cwd: string | null;
  name: string | null;
  preset: ModelPreset | null;
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  maxTurns: number | null;
  lastPrompt: string | null;
  blueprintId: string | null;
  blueprintVersion: number | null;
  blueprintEnvironment: string | null;
  blueprintModelConfiguration: BlueprintRunModelConfiguration | null;
  archiveState: "active" | "archived";
  archivedAt: number | null;
  archiveReason: SessionArchiveReason | null;
  pinned: boolean;
  knowledgePackIds: string[];
  knowledgeContextInjectedAt: number | null;
  policyWarnings: string[];
  workspaceLeaseMode: WorkspaceLeaseMode;
  workspaceFileScope: string[] | null;
};

export type SessionAuditEvent = {
  id: string;
  threadId: string;
  action: string;
  at: number;
  actor: string;
  details?: Record<string, unknown>;
};

export type TimelineEvent = {
  id: string;
  revision: number;
  threadId: string;
  type: string;
  at: number;
  summary: string;
  payloadSummary: Record<string, unknown>;
  model: string | null;
  outcome: SessionEventOutcome | null;
  error: string | null;
  durationMs: number | null;
};

export type SessionSearchFilters = {
  q?: string;
  model?: string;
  outcome?: SessionEventOutcome | "unknown";
  from?: number | null;
  to?: number | null;
  limit?: number;
};

export type SessionSearchResult = {
  sessionId: string;
  name: string;
  prompt: string | null;
  model: string | null;
  outcome: SessionEventOutcome | "unknown";
  error: string | null;
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
  matchedEvent: string | null;
};

export type OutcomeAnalytics = {
  generatedAt: number;
  totals: {
    sessions: number;
    runs: number;
    successful: number;
    failed: number;
    successRate: number;
    avgCompletionTimeMs: number | null;
  };
  byModel: Array<{
    model: string;
    runs: number;
    successful: number;
    failed: number;
    successRate: number;
    avgCompletionTimeMs: number | null;
  }>;
  commonErrors: Array<{ pattern: string; count: number; models: string[] }>;
};

export type SessionOperation = {
  id: string;
  kind: SessionOperationKind;
  idempotencyKey: string;
  requestFingerprint: string;
  status: SessionOperationStatus;
  step: string;
  remoteThreadId: string | null;
  attemptCount: number;
  input: Record<string, unknown>;
  compensation: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  nextAttemptAt: number | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type SessionOperationUpdate = Partial<Pick<SessionOperation,
  "status" | "step" | "remoteThreadId" | "attemptCount" | "compensation" |
  "result" | "error" | "nextAttemptAt" | "completedAt"
>>;

export class SessionOperationConflictError extends Error {
  constructor(readonly operation: SessionOperation) {
    super("The idempotency key is already associated with a different request");
    this.name = "SessionOperationConflictError";
  }
}

export class WorkspaceLeaseConflictError extends ConflictError {
  constructor(
    readonly root: string,
    readonly requestedBy: string,
    readonly requestedMode: WorkspaceLeaseMode,
    readonly conflicts: WorkspaceLease[]
  ) {
    const holders = conflicts.map((lease) => `${lease.sessionId} (${lease.mode})`).join(", ");
    super(
      `Workspace ${root} is already leased by ${holders}; session ${requestedBy} cannot acquire a ${requestedMode} lease until the conflicting work completes or is archived.`,
      { code: "WORKSPACE_LEASE_CONFLICT", scope: "workspace", sessionId: requestedBy }
    );
    this.name = "WorkspaceLeaseConflictError";
  }
}

type MetadataUpdate = {
  tags?: unknown;
  category?: unknown;
  sessionClass?: SessionClass;
  backend?: SessionBackend;
  cwd?: string | null;
  name?: string | null;
  preset?: ModelPreset | null;
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  maxTurns?: number | null;
  lastPrompt?: string | null;
  blueprintId?: string | null;
  blueprintVersion?: number | null;
  blueprintEnvironment?: string | null;
  blueprintModelConfiguration?: BlueprintRunModelConfiguration | null;
  knowledgePackIds?: string[];
  knowledgeContextInjectedAt?: number | null;
  policyWarnings?: string[];
  workspaceLeaseMode?: WorkspaceLeaseMode;
  workspaceFileScope?: string[] | null;
};
type ThreadLike = Record<string, unknown> & { id?: unknown; updatedAt?: unknown; recencyAt?: unknown; status?: unknown };
type SessionManagerOptions = {
  metadataRetentionMs?: number;
  auditRetentionMs?: number;
  auditMaxBytes?: number;
  maintenanceChunkSize?: number;
};

const DEFAULT_METADATA_RETENTION_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_AUDIT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_AUDIT_MAX_BYTES = 10 * 1024 * 1024;
const MAINTENANCE_INTERVAL_MS = 60 * 60_000;

/**
 * Owns ForgeDeck's session-local state. Codex remains the source of truth for
 * whether a thread exists; this store only adds organization and audit data.
 */
export class SessionManager {
  readonly blueprints: BlueprintManager;
  readonly schedules: ScheduleManager;
  readonly artifacts: ArtifactManager;
  readonly knowledgePacks: KnowledgePackManager;
  readonly policies: PolicyManager;
  readonly evals: EvalManager;
  readonly comparisons: ComparisonManager;
  readonly missions: MissionManager;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly workspaceLeases = new Map<string, Map<string, WorkspaceLease>>();
  private readonly workspaceLeaseRootsBySession = new Map<string, string>();
  private readonly metadataListeners = new Set<(threadId: string) => void>();
  private readonly metadataRetentionMs: number;
  private readonly auditRetentionMs: number;
  private readonly auditMaxBytes: number;
  private readonly maintenanceChunkSize: number;
  private maintenanceTimer: NodeJS.Timeout | null = null;

  private constructor(
    private readonly dataDir: string,
    private readonly now: () => number,
    private readonly store: TransactionalStore,
    options: SessionManagerOptions
  ) {
    this.blueprints = new BlueprintManager(store, now);
    this.schedules = new ScheduleManager(store, this.blueprints, now);
    this.artifacts = new ArtifactManager(store, dataDir, now);
    this.knowledgePacks = new KnowledgePackManager(store, now);
    this.policies = new PolicyManager(store, now);
    this.evals = new EvalManager(store, this.blueprints, now);
    this.comparisons = new ComparisonManager(store, now);
    this.missions = new MissionManager(store, this.blueprints, now);
    this.metadataRetentionMs = nonNegativeDuration(options.metadataRetentionMs, DEFAULT_METADATA_RETENTION_MS, "Metadata retention");
    this.auditRetentionMs = nonNegativeDuration(options.auditRetentionMs, DEFAULT_AUDIT_RETENTION_MS, "Audit retention");
    this.auditMaxBytes = positiveInteger(options.auditMaxBytes, DEFAULT_AUDIT_MAX_BYTES, "Audit maximum size");
    this.maintenanceChunkSize = positiveInteger(options.maintenanceChunkSize, 100, "Maintenance chunk size");
  }

  static async create(dataDir: string, now: () => number = Date.now, options: SessionManagerOptions = {}): Promise<SessionManager> {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const store = await TransactionalStore.open(dataDir);
    const manager = new SessionManager(dataDir, now, store, options);
    try {
      manager.reportStoreRecovery();
      await manager.migrateLegacyFiles();
      await manager.runMaintenance();
      if (store.revision !== store.backupRevision) await store.checkpoint();
      if (manager.metadataRetentionMs > 0 || manager.auditRetentionMs > 0) {
        manager.maintenanceTimer = setInterval(() => {
          void manager.runMaintenance().catch((error) => logger.warn("Could not maintain the session store", { error }));
        }, MAINTENANCE_INTERVAL_MS);
        manager.maintenanceTimer.unref();
      }
      return manager;
    } catch (error) {
      store.close();
      throw error;
    }
  }

  close(): void {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
    this.workspaceLeases.clear();
    this.workspaceLeaseRootsBySession.clear();
    this.store.close();
  }

  storageStatus(): {
    engine: "sqlite";
    status: "ok" | "error";
    revision?: number;
    backupRevision?: number;
    recoverySource?: "primary" | "backup" | "empty";
    error?: string;
  } {
    try {
      return {
        engine: "sqlite",
        status: "ok",
        revision: this.store.revision,
        backupRevision: this.store.backupRevision,
        recoverySource: this.store.recovery.source
      };
    } catch {
      return { engine: "sqlite", status: "error", error: "SQLite store is unavailable" };
    }
  }

  onMetadataChanged(listener: (threadId: string) => void): () => void {
    this.metadataListeners.add(listener);
    return () => this.metadataListeners.delete(listener);
  }

  /** Serialize operations which may race on the same Codex thread. */
  async withSession<T>(threadId: string, operation: () => Promise<T> | T): Promise<T> {
    return this.withLock(`thread:${threadId}`, operation);
  }

  /** Serialize inventory-changing operations such as create/list/archive. */
  async withInventory<T>(operation: () => Promise<T> | T): Promise<T> {
    return this.withLock("inventory", operation);
  }

  metadataFor(threadId: string): SessionMetadata {
    const stored = this.store.getMetadata(threadId);
    if (!stored) return emptyMetadata();
    return decodeMetadata(stored.payload);
  }

  acquireWorkspaceLease(
    sessionId: string,
    workspacePath: string | null = null,
    mode: WorkspaceLeaseMode = this.metadataFor(sessionId).workspaceLeaseMode
  ): WorkspaceLease {
    const metadata = this.metadataFor(sessionId);
    const root = normalizeWorkspaceLeaseRoot(workspacePath || metadata.cwd);
    const fileScope = metadata.workspaceFileScope;
    const existingRoot = this.workspaceLeaseRootsBySession.get(sessionId);
    if (existingRoot && existingRoot !== root) {
      throw new ConflictError(`Session ${sessionId} already holds a lease for ${existingRoot}`, {
        code: "SESSION_LEASE_ROOT_MISMATCH",
        scope: "workspace",
        sessionId
      });
    }
    const leases = this.workspaceLeases.get(root) || new Map<string, WorkspaceLease>();
    const overlappingLeases = [...this.workspaceLeases.entries()]
      .filter(([leasedRoot]) => workspaceLeaseRootsOverlap(root, leasedRoot))
      .flatMap(([, active]) => [...active.values()]);
    const conflicts = overlappingLeases.filter((lease) => lease.sessionId !== sessionId
      && (mode === "exclusive" || lease.mode === "exclusive")
      && workspaceLeaseScopesOverlap(root, fileScope, lease));
    if (conflicts.length) throw new WorkspaceLeaseConflictError(root, sessionId, mode, conflicts.map(cloneWorkspaceLease));
    const current = leases.get(sessionId);
    if (current?.mode === mode) return cloneWorkspaceLease(current);
    const lease: WorkspaceLease = {
      sessionId,
      root,
      mode,
      ...(fileScope ? { fileScope: [...fileScope] } : {}),
      acquiredAt: current?.acquiredAt || this.timestamp()
    };
    leases.set(sessionId, lease);
    this.workspaceLeases.set(root, leases);
    this.workspaceLeaseRootsBySession.set(sessionId, root);
    this.notifyMetadataChanged(sessionId);
    return cloneWorkspaceLease(lease);
  }

  releaseWorkspaceLease(sessionId: string): WorkspaceLease | null {
    const root = this.workspaceLeaseRootsBySession.get(sessionId);
    if (!root) return null;
    const leases = this.workspaceLeases.get(root);
    const released = leases?.get(sessionId) || null;
    leases?.delete(sessionId);
    if (leases?.size === 0) this.workspaceLeases.delete(root);
    this.workspaceLeaseRootsBySession.delete(sessionId);
    this.notifyMetadataChanged(sessionId);
    return released ? cloneWorkspaceLease(released) : null;
  }

  workspaceLeaseForSession(sessionId: string): WorkspaceLease | null {
    const root = this.workspaceLeaseRootsBySession.get(sessionId);
    const lease = root ? this.workspaceLeases.get(root)?.get(sessionId) : null;
    return lease ? cloneWorkspaceLease(lease) : null;
  }

  workspaceLeaseStatus(workspacePath: string): WorkspaceLeaseStatus {
    const root = normalizeWorkspaceLeaseRoot(workspacePath);
    const leases = [...this.workspaceLeases.entries()]
      .filter(([leasedRoot]) => workspaceLeaseRootsOverlap(root, leasedRoot))
      .flatMap(([, active]) => [...active.values()])
      .map(cloneWorkspaceLease)
      .sort((left, right) => left.acquiredAt - right.acquiredAt || left.sessionId.localeCompare(right.sessionId));
    return {
      root,
      state: leases.some((lease) => lease.mode === "exclusive") ? "exclusive" : leases.length ? "read-only" : "available",
      leases
    };
  }

  async setWorkspaceLeaseMode(sessionId: string, mode: WorkspaceLeaseMode, actor = "user"): Promise<SessionMetadata> {
    const metadata = await this.withLock("metadata", () => {
      const previousRow = this.store.getMetadata(sessionId);
      if (!previousRow) throw new ConflictError("Session metadata must exist before choosing a workspace lease mode", {
        code: "SESSION_NOT_TRACKED",
        scope: "sessions",
        sessionId
      });
      const previous = decodeMetadata(previousRow.payload);
      if (previous.workspaceLeaseMode === mode) return cloneMetadata(previous);
      const timestamp = this.timestamp();
      const next = { ...previous, workspaceLeaseMode: mode, updatedAt: timestamp };
      const event = this.createAuditEvent(sessionId, "workspace_lease_mode_changed", actor, { mode }, timestamp);
      this.store.upsertMetadata(toMetadataRow(sessionId, next), toAuditRow(event), this.auditCutoff(timestamp), this.auditMaxBytes);
      return cloneMetadata(next);
    });
    this.notifyMetadataChanged(sessionId);
    return metadata;
  }

  enrich<T extends ThreadLike>(thread: T): T & Pick<SessionMetadata, "tags" | "category" | "sessionClass" | "backend" | "policyWarnings"> & {
    provider: SessionBackend;
    preset?: ModelPreset;
    model?: string;
    reasoningEffort?: string;
    effort?: string;
    claudeModel?: string;
    claudeEffort?: string;
    claudePermissionMode?: string;
    claudeMaxTurns?: number;
    blueprintId?: string;
    blueprintVersion?: number;
    blueprintEnvironment?: string;
    blueprintModelConfiguration?: BlueprintRunModelConfiguration;
    pinned?: boolean;
    artifactStatus: ArtifactStatus;
    workspaceLeaseMode: WorkspaceLeaseMode;
    workspaceLease: WorkspaceLease | null;
  } {
    const threadId = typeof thread.id === "string" ? thread.id : "";
    // Provider payloads use `source` for their own transport/client origin
    // values (for example `cli`). ForgeDeck's public `source` field has a
    // different, narrower meaning and is added by the inventory adapter.
    // Never allow an upstream value to leak through to the HTTP contract.
    const providerThread = { ...thread };
    delete (providerThread as Record<string, unknown>).source;
    const gitInfo = (providerThread as Record<string, unknown>).gitInfo;
    if (gitInfo && typeof gitInfo === "object" && !Array.isArray(gitInfo)) {
      const normalizedGitInfo = { ...(gitInfo as Record<string, unknown>) };
      if (typeof normalizedGitInfo.branch !== "string") delete normalizedGitInfo.branch;
      if (typeof normalizedGitInfo.repositoryUrl !== "string") delete normalizedGitInfo.repositoryUrl;
      (providerThread as Record<string, unknown>).gitInfo = normalizedGitInfo;
    } else if (gitInfo !== undefined && gitInfo !== null) {
      delete (providerThread as Record<string, unknown>).gitInfo;
    }
    const stored = this.store.getMetadata(threadId);
    const metadata = stored ? decodeMetadata(stored.payload) : emptyMetadata();
    const backend = metadata.backend;
    const model = typeof thread.model === "string" ? thread.model : metadata.model;
    const effort = typeof thread.effort === "string" ? thread.effort : metadata.effort;
    const sessionClass = stored ? metadata.sessionClass : (model === "gpt-5.3-codex-spark" ? "spark" : "standard");
    return {
      ...providerThread,
      tags: metadata.tags,
      category: metadata.category,
      sessionClass,
      backend,
      policyWarnings: [...metadata.policyWarnings],
      provider: backend,
      artifactStatus: this.artifactStatus(threadId),
      workspaceLeaseMode: metadata.workspaceLeaseMode,
      workspaceLease: this.workspaceLeaseForSession(threadId),
      ...(metadata.pinned ? { pinned: true } : {}),
      ...(metadata.preset ? { preset: metadata.preset } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { reasoningEffort: effort, effort } : {}),
      ...(metadata.blueprintId ? { blueprintId: metadata.blueprintId } : {}),
      ...(metadata.blueprintVersion ? { blueprintVersion: metadata.blueprintVersion } : {}),
      ...(metadata.blueprintEnvironment ? { blueprintEnvironment: metadata.blueprintEnvironment } : {}),
      ...(metadata.blueprintModelConfiguration ? { blueprintModelConfiguration: { ...metadata.blueprintModelConfiguration } } : {}),
      ...(backend === "claude" ? {
        ...(metadata.model ? { claudeModel: metadata.model } : {}),
        ...(metadata.effort ? { claudeEffort: metadata.effort } : {}),
        ...(metadata.permissionMode ? { claudePermissionMode: metadata.permissionMode } : {}),
        ...(metadata.maxTurns ? { claudeMaxTurns: metadata.maxTurns } : {})
      } : {})
    };
  }

  async setMetadata(threadId: string, update: MetadataUpdate, actor = "user"): Promise<SessionMetadata> {
    const metadata = await this.withLock("metadata", () => {
      const previousRow = this.store.getMetadata(threadId);
      const previous = previousRow ? decodeMetadata(previousRow.payload) : null;
      const timestamp = this.timestamp();
      const next: SessionMetadata = {
        tags: update.tags === undefined ? [...(previous?.tags || [])] : normalizeTags(update.tags),
        category: update.category === undefined ? previous?.category || null : normalizeCategory(update.category),
        createdAt: previous?.createdAt || timestamp,
        updatedAt: timestamp,
        sessionClass: normalizeSessionClass(update.sessionClass, previous?.sessionClass),
        backend: normalizeBackend(update.backend, previous?.backend),
        cwd: update.cwd === undefined ? previous?.cwd || null : normalizeNullableString(update.cwd),
        name: update.name === undefined ? previous?.name || null : normalizeNullableString(update.name),
        preset: update.preset === undefined ? previous?.preset || null : normalizeModelPreset(update.preset),
        model: update.model === undefined ? previous?.model || null : normalizeNullableString(update.model),
        effort: update.effort === undefined ? previous?.effort || null : normalizeNullableString(update.effort),
        permissionMode: update.permissionMode === undefined ? previous?.permissionMode || null : normalizeNullableString(update.permissionMode),
        maxTurns: update.maxTurns === undefined ? previous?.maxTurns || null : normalizeNullableInteger(update.maxTurns),
        lastPrompt: update.lastPrompt === undefined ? previous?.lastPrompt || null : normalizeNullableString(update.lastPrompt),
        blueprintId: update.blueprintId === undefined ? previous?.blueprintId || null : normalizeNullableString(update.blueprintId),
        blueprintVersion: update.blueprintVersion === undefined ? previous?.blueprintVersion || null : normalizeNullableInteger(update.blueprintVersion),
        blueprintEnvironment: update.blueprintEnvironment === undefined ? previous?.blueprintEnvironment || null : normalizeNullableString(update.blueprintEnvironment),
        blueprintModelConfiguration: update.blueprintModelConfiguration === undefined
          ? previous?.blueprintModelConfiguration || null
          : normalizeBlueprintModelConfiguration(update.blueprintModelConfiguration),
        knowledgePackIds: update.knowledgePackIds === undefined
          ? [...(previous?.knowledgePackIds || [])]
          : normalizeKnowledgePackIds(update.knowledgePackIds),
        knowledgeContextInjectedAt: update.knowledgeContextInjectedAt === undefined
          ? previous?.knowledgeContextInjectedAt || null
          : finiteNullableNumber(update.knowledgeContextInjectedAt),
        policyWarnings: update.policyWarnings === undefined
          ? [...(previous?.policyWarnings || [])]
          : normalizePolicyWarnings(update.policyWarnings),
        workspaceLeaseMode: update.workspaceLeaseMode === undefined
          ? previous?.workspaceLeaseMode || "exclusive"
          : normalizeWorkspaceLeaseMode(update.workspaceLeaseMode),
        workspaceFileScope: update.workspaceFileScope === undefined
          ? previous?.workspaceFileScope || null
          : normalizeWorkspaceFileScope(update.workspaceFileScope),
        archiveState: previous?.archiveState || "active",
        archivedAt: previous?.archivedAt || null,
        archiveReason: previous?.archiveReason || null,
        pinned: previous?.pinned || false
      };
      const event = this.createAuditEvent(threadId, "organized", actor, { tags: next.tags, category: next.category }, timestamp);
      this.store.upsertMetadata(toMetadataRow(threadId, next), toAuditRow(event), this.auditCutoff(timestamp), this.auditMaxBytes);
      return cloneMetadata(next);
    });
    if (typeof update.lastPrompt === "string" && update.lastPrompt.trim()) {
      this.recordTimelineEvent(threadId, "prompt/submitted", {
        prompt: update.lastPrompt,
        model: update.model ?? metadata.model,
        actor
      });
    }
    this.notifyMetadataChanged(threadId);
    return metadata;
  }

  async setPolicyWarnings(threadId: string, warnings: string[], actor = "policy"): Promise<SessionMetadata> {
    const normalized = normalizePolicyWarnings(warnings);
    const metadata = await this.withLock("metadata", () => {
      const previousRow = this.store.getMetadata(threadId);
      const previous = previousRow ? decodeMetadata(previousRow.payload) : emptyMetadata();
      if (previous.policyWarnings.length === normalized.length
        && previous.policyWarnings.every((warning, index) => warning === normalized[index])) return cloneMetadata(previous);
      const timestamp = this.timestamp();
      const next = { ...previous, policyWarnings: normalized, updatedAt: timestamp };
      const event = this.createAuditEvent(
        threadId,
        normalized.length ? "policy_warning" : "policy_warning_cleared",
        actor,
        normalized.length ? { warnings: normalized } : undefined,
        timestamp
      );
      this.store.upsertMetadata(toMetadataRow(threadId, next), toAuditRow(event), this.auditCutoff(timestamp), this.auditMaxBytes);
      return cloneMetadata(next);
    });
    this.notifyMetadataChanged(threadId);
    return metadata;
  }

  async touch(threadId: string): Promise<void> {
    const changed = await this.withLock("metadata", () => {
      return this.store.touchMetadata(threadId, this.timestamp());
    });
    if (changed) this.notifyMetadataChanged(threadId);
  }

  async markKnowledgeContextInjected(threadId: string, actor = "knowledge-packs"): Promise<SessionMetadata> {
    const metadata = await this.withLock("metadata", () => {
      const previousRow = this.store.getMetadata(threadId);
      const previous = previousRow ? decodeMetadata(previousRow.payload) : emptyMetadata();
      if (previous.knowledgeContextInjectedAt !== null) return cloneMetadata(previous);
      const timestamp = this.timestamp();
      const next = { ...previous, knowledgeContextInjectedAt: timestamp, updatedAt: timestamp };
      const event = this.createAuditEvent(threadId, "knowledge_context_injected", actor, {
        knowledgePackIds: next.knowledgePackIds
      }, timestamp);
      this.store.upsertMetadata(toMetadataRow(threadId, next), toAuditRow(event), this.auditCutoff(timestamp), this.auditMaxBytes);
      return cloneMetadata(next);
    });
    this.notifyMetadataChanged(threadId);
    return metadata;
  }

  async markArchived(
    threadId: string,
    reason: SessionArchiveReason,
    actor = "system",
    details: Record<string, unknown> = {}
  ): Promise<SessionMetadata> {
    const metadata = await this.withLock("metadata", () => {
      const previousRow = this.store.getMetadata(threadId);
      const previous = previousRow ? decodeMetadata(previousRow.payload) : emptyMetadata();
      if (previousRow && previous.archiveState === "archived" && previous.archiveReason === reason) return cloneMetadata(previous);
      const timestamp = this.timestamp();
      const next: SessionMetadata = {
        ...previous,
        createdAt: previous.createdAt || timestamp,
        updatedAt: timestamp,
        archiveState: "archived",
        archivedAt: previous.archiveState === "archived" && previous.archivedAt ? previous.archivedAt : timestamp,
        archiveReason: reason
      };
      const event = this.createAuditEvent(threadId, "archived", actor, { ...details, reason }, timestamp);
      this.store.upsertMetadata(toMetadataRow(threadId, next), toAuditRow(event), this.auditCutoff(timestamp), this.auditMaxBytes);
      return cloneMetadata(next);
    });
    this.releaseWorkspaceLease(threadId);
    this.notifyMetadataChanged(threadId);
    return metadata;
  }

  async markRestored(threadId: string, actor = "user"): Promise<SessionMetadata> {
    const metadata = await this.withLock("metadata", () => {
      const previousRow = this.store.getMetadata(threadId);
      const previous = previousRow ? decodeMetadata(previousRow.payload) : emptyMetadata();
      if (previousRow && previous.archiveState === "active" && previous.archivedAt === null) return cloneMetadata(previous);
      const timestamp = this.timestamp();
      const next: SessionMetadata = {
        ...previous,
        createdAt: previous.createdAt || timestamp,
        updatedAt: timestamp,
        archiveState: "active",
        archivedAt: null,
        archiveReason: null
      };
      const event = this.createAuditEvent(threadId, "restored", actor, undefined, timestamp);
      this.store.upsertMetadata(toMetadataRow(threadId, next), toAuditRow(event), this.auditCutoff(timestamp), this.auditMaxBytes);
      return cloneMetadata(next);
    });
    this.notifyMetadataChanged(threadId);
    return metadata;
  }

  async setPinned(threadId: string, pinned: boolean, actor = "user"): Promise<SessionMetadata> {
    const metadata = await this.withLock("metadata", () => {
      const previousRow = this.store.getMetadata(threadId);
      const previous = previousRow ? decodeMetadata(previousRow.payload) : emptyMetadata();
      if (previousRow && previous.pinned === pinned) return cloneMetadata(previous);
      const timestamp = this.timestamp();
      const next: SessionMetadata = {
        ...previous,
        createdAt: previous.createdAt || timestamp,
        updatedAt: timestamp,
        pinned
      };
      const event = this.createAuditEvent(threadId, pinned ? "pinned" : "unpinned", actor, {
        ttlExempt: pinned
      }, timestamp);
      this.store.upsertMetadata(toMetadataRow(threadId, next), toAuditRow(event), this.auditCutoff(timestamp), this.auditMaxBytes);
      return cloneMetadata(next);
    });
    this.notifyMetadataChanged(threadId);
    return metadata;
  }

  listAllSessions(sessionClass?: SessionClass): Array<SessionMetadata & { id: string }> {
    const result: Array<SessionMetadata & { id: string }> = [];
    for (const row of this.store.listMetadata()) {
      const metadata = decodeMetadata(row.payload);
      if (sessionClass && metadata.sessionClass !== sessionClass) continue;
      result.push({ id: row.threadId, ...metadata });
    }
    return result;
  }

  async removeMetadata(threadId: string): Promise<boolean> {
    const removed = await this.withLock("metadata", () => this.store.removeMetadata(threadId));
    this.releaseWorkspaceLease(threadId);
    if (removed) this.notifyMetadataChanged(threadId);
    return removed;
  }

  listRunGuardianStates(): RunGuardianState[] {
    return this.store.listRunGuardians().map((row) => JSON.parse(row.payload) as RunGuardianState);
  }

  saveRunGuardianState(state: RunGuardianState): void {
    this.store.upsertRunGuardian({
      threadId: state.threadId,
      payload: JSON.stringify(state),
      updatedAt: state.updatedAt
    });
  }

  removeRunGuardianState(threadId: string): boolean {
    return this.store.removeRunGuardian(threadId);
  }

  trackedThreadIds(includeArchived = false): string[] {
    return this.store.listMetadata()
      .filter((row) => includeArchived || decodeMetadata(row.payload).archiveState === "active")
      .map((row) => row.threadId);
  }

  hasMetadata(threadId: string): boolean {
    return this.store.getMetadata(threadId) !== null;
  }

  async record(threadId: string, action: string, actor = "system", details?: Record<string, unknown>): Promise<SessionAuditEvent> {
    return this.withLock("audit", () => {
      const event = this.createAuditEvent(threadId, action, actor, details);
      this.store.appendAudit(toAuditRow(event), this.auditCutoff(event.at), this.auditMaxBytes);
      return event;
    });
  }

  async history(threadId: string, limit = 100): Promise<SessionAuditEvent[]> {
    const boundedLimit = Math.max(1, Math.min(1_000, Math.round(limit)));
    return this.store.history(threadId, boundedLimit).map(fromAuditRow);
  }

  latestTimelineRevision(): number {
    return this.store.latestEventStreamRevision();
  }

  nextTimelineRevision(): number {
    return this.store.nextEventStreamRevision();
  }

  recordTimelineEvent(
    threadId: string,
    type: string,
    payload: unknown,
    options: { id?: string; revision?: number; at?: number; model?: string | null } = {}
  ): boolean {
    if (!threadId) throw new Error("Timeline thread ID must not be empty");
    const metadata = this.metadataFor(threadId);
    const at = options.at ?? this.timestamp();
    const revision = options.revision ?? this.store.latestEventStreamRevision();
    const details = summarizeTimelineEvent(type, payload, options.model ?? metadata.model);
    return this.store.appendSessionEvent({
      id: options.id || `event:${randomUUID()}`,
      revision,
      threadId,
      type,
      at,
      summary: details.summary,
      payloadJson: JSON.stringify(details.payloadSummary),
      searchText: details.searchText,
      model: details.model,
      outcome: details.outcome,
      error: details.error,
      durationMs: details.durationMs
    });
  }

  recordNextTimelineEvent(threadId: string, type: string, payload: unknown, model?: string | null): number {
    if (!threadId) throw new Error("Timeline thread ID must not be empty");
    const metadata = this.metadataFor(threadId);
    const details = summarizeTimelineEvent(type, payload, model ?? metadata.model);
    return this.store.appendNextSessionEvent({
      threadId,
      type,
      at: this.timestamp(),
      summary: details.summary,
      payloadJson: JSON.stringify(details.payloadSummary),
      searchText: details.searchText,
      model: details.model,
      outcome: details.outcome,
      error: details.error,
      durationMs: details.durationMs
    }).revision;
  }

  timeline(threadId: string, limit = 2_000): TimelineEvent[] {
    const boundedLimit = Math.max(1, Math.min(10_000, Math.round(limit)));
    return this.store.listSessionEvents(threadId, boundedLimit).map(toTimelineEvent);
  }

  searchSessions(filters: SessionSearchFilters = {}): SessionSearchResult[] {
    const query = (filters.q || "").trim().toLocaleLowerCase("en-US");
    const modelFilter = (filters.model || "").trim().toLocaleLowerCase("en-US");
    const limit = Math.max(1, Math.min(500, Math.round(filters.limit || 100)));
    const states = new Map<string, SearchRollup>();
    for (const session of this.listAllSessions()) {
      const searchable = [session.name, session.lastPrompt, session.model, session.cwd, session.category, ...session.tags]
        .filter((value): value is string => typeof value === "string").join(" ").toLocaleLowerCase("en-US");
      states.set(session.id, {
        sessionId: session.id,
        name: session.name,
        prompt: session.lastPrompt,
        model: session.model,
        outcome: "unknown",
        error: null,
        startedAt: session.createdAt,
        completedAt: null,
        durationMs: null,
        lastAt: session.updatedAt,
        matchedEvent: null,
        queryMatched: !query || searchable.includes(query),
        models: new Set(session.model ? [session.model.toLocaleLowerCase("en-US")] : [])
      });
    }
    for (const event of this.store.listAllSessionEvents()) {
      const state = states.get(event.threadId) || emptySearchRollup(event.threadId, event.at);
      states.set(event.threadId, state);
      state.startedAt = Math.min(state.startedAt || event.at, event.at);
      state.lastAt = Math.max(state.lastAt, event.at);
      if (event.model) {
        state.model = event.model;
        state.models.add(event.model.toLocaleLowerCase("en-US"));
      }
      if (event.type === "prompt/submitted") {
        const payload = parseJsonObject(event.payloadJson, "Timeline prompt summary");
        if (typeof payload.prompt === "string") state.prompt = payload.prompt;
      }
      if (event.outcome) {
        state.outcome = event.outcome;
        state.completedAt = event.at;
        state.durationMs = event.durationMs;
        state.error = event.outcome === "failed" ? event.error : null;
      }
      if (query && event.searchText.toLocaleLowerCase("en-US").includes(query)) {
        state.queryMatched = true;
        state.matchedEvent = event.summary;
      }
    }
    return [...states.values()]
      .filter((state) => state.queryMatched)
      .filter((state) => !modelFilter || state.models.has(modelFilter))
      .filter((state) => !filters.outcome || state.outcome === filters.outcome)
      .filter((state) => filters.from == null || state.lastAt >= filters.from)
      .filter((state) => filters.to == null || state.startedAt <= filters.to)
      .sort((left, right) => right.lastAt - left.lastAt)
      .slice(0, limit)
      .map((state) => ({
        sessionId: state.sessionId,
        name: state.name || deriveSessionName(state.prompt, state.sessionId),
        prompt: state.prompt,
        model: state.model,
        outcome: state.outcome,
        error: state.error,
        startedAt: state.startedAt,
        completedAt: state.completedAt,
        durationMs: state.durationMs ?? (state.completedAt === null ? null : Math.max(0, state.completedAt - state.startedAt)),
        matchedEvent: state.matchedEvent
      }));
  }

  outcomeAnalytics(): OutcomeAnalytics {
    const events = this.store.listAllSessionEvents();
    const terminal = events.filter((event) => event.outcome !== null);
    const sessions = new Set(events.map((event) => event.threadId));
    const models = new Map<string, AnalyticsRollup>();
    const errors = new Map<string, { count: number; models: Set<string> }>();
    let successful = 0;
    let failed = 0;
    let durationTotal = 0;
    let durationCount = 0;
    for (const event of terminal) {
      const success = event.outcome === "success";
      success ? successful += 1 : failed += 1;
      if (event.durationMs !== null) {
        durationTotal += event.durationMs;
        durationCount += 1;
      }
      const model = event.model || "Unknown model";
      const rollup = models.get(model) || { runs: 0, successful: 0, failed: 0, durationTotal: 0, durationCount: 0 };
      rollup.runs += 1;
      success ? rollup.successful += 1 : rollup.failed += 1;
      if (event.durationMs !== null) {
        rollup.durationTotal += event.durationMs;
        rollup.durationCount += 1;
      }
      models.set(model, rollup);
      if (event.outcome === "failed" && event.error) {
        const pattern = normalizeErrorPattern(event.error);
        const errorRollup = errors.get(pattern) || { count: 0, models: new Set<string>() };
        errorRollup.count += 1;
        errorRollup.models.add(model);
        errors.set(pattern, errorRollup);
      }
    }
    return {
      generatedAt: this.timestamp(),
      totals: {
        sessions: sessions.size,
        runs: terminal.length,
        successful,
        failed,
        successRate: rate(successful, terminal.length),
        avgCompletionTimeMs: durationCount ? Math.round(durationTotal / durationCount) : null
      },
      byModel: [...models.entries()].map(([model, rollup]) => ({
        model,
        runs: rollup.runs,
        successful: rollup.successful,
        failed: rollup.failed,
        successRate: rate(rollup.successful, rollup.runs),
        avgCompletionTimeMs: rollup.durationCount ? Math.round(rollup.durationTotal / rollup.durationCount) : null
      })).sort((left, right) => right.runs - left.runs || left.model.localeCompare(right.model)),
      commonErrors: [...errors.entries()].map(([pattern, rollup]) => ({
        pattern,
        count: rollup.count,
        models: [...rollup.models].sort()
      })).sort((left, right) => right.count - left.count || left.pattern.localeCompare(right.pattern)).slice(0, 10)
    };
  }

  async persistCanonicalItem(threadId: string, item: Record<string, unknown>): Promise<void> {
    if (typeof item.id !== "string" || !item.id) throw new Error("Canonical item ID must not be empty");
    const row: CanonicalItemStoreRow = {
      threadId,
      itemId: item.id,
      payload: JSON.stringify(item),
      updatedAt: this.timestamp()
    };
    await this.withLock(`canonical:${threadId}`, () => this.store.upsertCanonicalItem(row));
  }

  async persistCanonicalHistory(thread: Record<string, unknown>): Promise<void> {
    const threadId = typeof thread.id === "string" ? thread.id : "";
    if (!threadId) throw new Error("Canonical history thread ID must not be empty");
    const updatedAt = this.timestamp();
    const items = new Map<string, Record<string, unknown>>();
    if (Array.isArray(thread.turns)) {
      for (const turn of thread.turns) {
        if (!turn || typeof turn !== "object" || !Array.isArray((turn as { items?: unknown }).items)) continue;
        for (const item of (turn as { items: unknown[] }).items) {
          if (!item || typeof item !== "object" || typeof (item as { id?: unknown }).id !== "string") continue;
          items.set((item as { id: string }).id, item as Record<string, unknown>);
        }
      }
    }
    const rows = [...items.entries()].map(([itemId, item]) => ({
      threadId,
      itemId,
      payload: JSON.stringify(item),
      updatedAt
    }));
    await this.withLock(`canonical:${threadId}`, () => this.store.replaceCanonicalItems(threadId, rows));
  }

  canonicalItems(threadId: string): Record<string, unknown>[] {
    return this.store.listCanonicalItems(threadId).map((row) => JSON.parse(row.payload) as Record<string, unknown>);
  }

  listArtifacts(threadId: string): Artifact[] {
    return this.artifacts.list(threadId);
  }

  artifactById(artifactId: string): Artifact | null {
    return this.artifacts.get(artifactId);
  }

  async createArtifact(threadId: string, input: unknown, context: ArtifactCreateContext): Promise<Artifact> {
    const artifact = await this.withLock(`artifacts:${threadId}`, () => this.artifacts.create(threadId, input, context));
    this.notifyMetadataChanged(threadId);
    return artifact;
  }

  async captureArtifactItem(threadId: string, item: Record<string, unknown>): Promise<Artifact[]> {
    const cwd = this.metadataFor(threadId).cwd;
    const artifacts = await this.withLock(`artifacts:${threadId}`, () => this.artifacts.captureRuntimeItem(threadId, item, cwd));
    if (artifacts.length) this.notifyMetadataChanged(threadId);
    return artifacts;
  }

  artifactStatus(threadId: string): ArtifactStatus {
    if (!threadId) return this.artifacts.completionStatus(threadId, []);
    const metadata = this.metadataFor(threadId);
    if (!metadata.blueprintId) return this.artifacts.completionStatus(threadId, []);
    try {
      const blueprint = this.blueprints.get(metadata.blueprintId, metadata.blueprintVersion);
      return this.artifacts.completionStatus(threadId, blueprint?.definition.completionGates || []);
    } catch {
      return this.artifacts.completionStatus(threadId, []);
    }
  }

  appendUsageEvent(row: UsageEventStoreRow, estimate: CostEstimateStoreRow | null = null): boolean {
    return this.store.appendUsageEvent(row, estimate);
  }

  latestUsageCumulative(runId: string, provider: UsageProvider, model: string): UsageEventStoreRow | null {
    return this.store.latestUsageCumulative(runId, provider, model);
  }

  listUsageEvents(limit = 100, runId?: string): UsageEventStoreRow[] {
    return this.store.listUsageEvents(limit, runId);
  }

  listCostEstimates(limit = 100, runId?: string): CostEstimateStoreRow[] {
    return this.store.listCostEstimates(limit, runId);
  }

  usageAggregate(scopeType: BudgetScopeType, scopeId: string, catalogVersion?: string | null): UsageAggregateStoreRow {
    return this.store.usageAggregate(scopeType, scopeId, catalogVersion);
  }

  appendQuotaEvent(row: QuotaEventStoreRow): boolean {
    return this.store.appendQuotaEvent(row);
  }

  latestQuotaEvents(): QuotaEventStoreRow[] {
    return this.store.latestQuotaEvents();
  }

  upsertBudgetPolicy(row: BudgetPolicyStoreRow): void {
    this.store.upsertBudgetPolicy(row);
  }

  removeBudgetPolicy(scopeType: BudgetScopeType, scopeId: string): boolean {
    return this.store.removeBudgetPolicy(scopeType, scopeId);
  }

  listBudgetPolicies(scopeType?: BudgetScopeType, scopeId?: string): BudgetPolicyStoreRow[] {
    return this.store.listBudgetPolicies(scopeType, scopeId);
  }

  async createSessionOperation(
    kind: SessionOperationKind,
    idempotencyKey: string,
    input: Record<string, unknown>,
    remoteThreadId: string | null = null
  ): Promise<{ operation: SessionOperation; created: boolean }> {
    const normalizedKey = normalizeIdempotencyKey(idempotencyKey);
    const inputJson = canonicalJson(input);
    const requestFingerprint = createHash("sha256").update(inputJson).digest("hex");
    return this.withLock(`operation-key:${kind}:${normalizedKey}`, () => {
      const timestamp = this.timestamp();
      const result = this.store.insertSessionOperation({
        id: randomUUID(),
        kind,
        idempotencyKey: normalizedKey,
        requestFingerprint,
        status: "pending",
        step: "queued",
        remoteThreadId,
        attempts: 0,
        inputJson,
        compensationJson: "{}",
        resultJson: null,
        errorJson: null,
        nextAttemptAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null
      });
      const operation = decodeSessionOperation(result.operation);
      if (operation.requestFingerprint !== requestFingerprint) throw new SessionOperationConflictError(operation);
      return { operation, created: result.created };
    });
  }

  getSessionOperation(operationId: string): SessionOperation | null {
    const row = this.store.getSessionOperation(operationId);
    return row ? decodeSessionOperation(row) : null;
  }

  incompleteSessionOperations(): SessionOperation[] {
    return this.store.listIncompleteSessionOperations().map(decodeSessionOperation);
  }

  incompleteSessionOperationFor(kind: SessionOperationKind, remoteThreadId: string): SessionOperation | null {
    const row = this.store.findIncompleteSessionOperation(kind, remoteThreadId);
    return row ? decodeSessionOperation(row) : null;
  }

  async updateSessionOperation(operationId: string, update: SessionOperationUpdate): Promise<SessionOperation> {
    return this.withLock(`operation:${operationId}`, () => {
      const row = this.store.getSessionOperation(operationId);
      if (!row) throw new Error(`Session operation ${operationId} was not found`);
      const current = decodeSessionOperation(row);
      const next: SessionOperation = {
        ...current,
        ...update,
        input: current.input,
        compensation: update.compensation === undefined ? current.compensation : cloneJsonObject(update.compensation),
        result: update.result === undefined ? current.result : cloneNullableJsonObject(update.result),
        error: update.error === undefined ? current.error : cloneNullableJsonObject(update.error),
        updatedAt: this.timestamp()
      };
      if ((next.status === "succeeded" || next.status === "failed") && next.completedAt === null) next.completedAt = next.updatedAt;
      if (next.status !== "succeeded" && next.status !== "failed" && update.completedAt === undefined) next.completedAt = null;
      const stored = encodeSessionOperation(next);
      if (!this.store.updateSessionOperation(stored)) throw new Error(`Session operation ${operationId} was not found`);
      return decodeSessionOperation(stored);
    });
  }

  private async withLock<T>(key: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.locks.get(key) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    this.locks.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  private notifyMetadataChanged(threadId: string): void {
    for (const listener of this.metadataListeners) listener(threadId);
  }

  private async purgeStaleMetadata(): Promise<number> {
    if (this.metadataRetentionMs === 0) return 0;
    const cutoff = Math.max(0, this.timestamp() - this.metadataRetentionMs);
    let removed = 0;
    while (true) {
      const removedIds = await this.withLock("metadata", () => this.store.purgeArchivedMetadataBefore(cutoff, this.maintenanceChunkSize));
      for (const threadId of removedIds) this.notifyMetadataChanged(threadId);
      removed += removedIds.length;
      if (removedIds.length < this.maintenanceChunkSize) return removed;
      await yieldToEventLoop();
    }
  }

  private async runMaintenance(): Promise<void> {
    await this.purgeStaleMetadata();
    const timestamp = this.timestamp();
    if (this.metadataRetentionMs > 0) {
      const cutoff = Math.max(0, timestamp - this.metadataRetentionMs);
      while (await this.withLock("canonical-retention", () => this.store.purgeCanonicalItemsBefore(cutoff, this.maintenanceChunkSize)) >= this.maintenanceChunkSize) {
        await yieldToEventLoop();
      }
    }
    while (true) {
      const removed = await this.withLock("audit", () => this.store.compactAudit(
        this.auditCutoff(timestamp),
        this.auditMaxBytes,
        this.maintenanceChunkSize
      ));
      if (removed < this.maintenanceChunkSize) break;
      await yieldToEventLoop();
    }
    if (this.store.revision !== this.store.backupRevision) await this.store.checkpoint();
  }

  private auditCutoff(timestamp: number): number | null {
    return this.auditRetentionMs === 0 ? null : Math.max(0, timestamp - this.auditRetentionMs);
  }

  private timestamp(): number {
    const timestamp = this.now();
    if (!Number.isFinite(timestamp) || timestamp < 0) throw new RangeError("Session store clock must return a non-negative finite timestamp");
    return Math.round(timestamp);
  }

  private createAuditEvent(
    threadId: string,
    action: string,
    actor: string,
    details?: Record<string, unknown>,
    at = this.timestamp()
  ): SessionAuditEvent {
    if (!threadId) throw new Error("Audit thread ID must not be empty");
    if (!action.trim()) throw new Error("Audit action must not be empty");
    if (!actor.trim()) throw new Error("Audit actor must not be empty");
    return {
      id: randomUUID(),
      threadId,
      action,
      at,
      actor,
      ...(details && Object.keys(details).length ? { details } : {})
    };
  }

  private reportStoreRecovery(): void {
    const recovery = this.store.recovery;
    if (recovery.source === "backup") {
      logger.warn("Recovered the transactional session store from its validated backup", {
        primaryRevision: recovery.primaryRevision,
        backupRevision: recovery.backupRevision
      });
    }
    if (recovery.preservedCorruptFiles.length) {
      logger.warn("Preserved invalid transactional store files during recovery", { files: recovery.preservedCorruptFiles });
    }
  }

  private async migrateLegacyFiles(): Promise<void> {
    if (this.store.legacyMigrationComplete) return;
    const metadata = await this.readLegacyMetadata();
    const audit = await this.readLegacyAudit();
    this.store.importLegacy(metadata, audit);
  }

  private async readLegacyMetadata(): Promise<MetadataStoreRow[]> {
    const primaryFile = path.join(this.dataDir, "session-metadata.json");
    const backupFile = `${primaryFile}.bak`;
    const primary = await readText(primaryFile);
    const backup = await readText(backupFile);
    if (primary === null && backup === null) return [];

    let backupRecords = new Map<string, SessionMetadata>();
    if (backup !== null) {
      try {
        backupRecords = parseLegacyMetadataSnapshot(backup).records;
      } catch (error) {
        await this.preserveInvalidLegacyFile(backupFile, backup);
        logger.warn("Ignoring invalid legacy session metadata backup", { error });
      }
    }

    let records = backupRecords;
    if (primary !== null) {
      try {
        const parsed = parseLegacyMetadataSnapshot(primary);
        records = parsed.records;
        if (parsed.invalidRecords > 0) {
          await this.preserveInvalidLegacyFile(primaryFile, primary);
          logger.warn("Skipped invalid records in legacy session metadata", { invalidRecords: parsed.invalidRecords });
        }
      } catch (error) {
        await this.preserveInvalidLegacyFile(primaryFile, primary);
        const salvaged = parseLegacyMetadataObject(salvageMetadataRecords(primary)).records;
        records = new Map(backupRecords);
        for (const [threadId, metadata] of salvaged) records.set(threadId, metadata);
        logger.warn("Recovered invalid legacy session metadata from backup and complete records", {
          error,
          backupRecords: backupRecords.size,
          salvagedRecords: salvaged.size
        });
      }
    }

    return [...records].map(([threadId, metadata]) => toMetadataRow(threadId, metadata));
  }

  private async readLegacyAudit(): Promise<AuditStoreRow[]> {
    const auditFile = path.join(this.dataDir, "session-audit.jsonl");
    const contents = await readText(auditFile);
    if (contents === null) return [];
    const events: AuditStoreRow[] = [];
    let invalidLines = 0;
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(toAuditRow(parseLegacyAuditEvent(line)));
      } catch {
        invalidLines += 1;
      }
    }
    if (invalidLines > 0) {
      await this.preserveInvalidLegacyFile(auditFile, contents);
      logger.warn("Skipped invalid records in legacy session audit history", { invalidLines });
    }
    return events;
  }

  private async preserveInvalidLegacyFile(file: string, contents: string): Promise<void> {
    const corruptFile = `${file}.corrupt-${this.timestamp()}-${randomUUID()}`;
    const handle = await fs.open(corruptFile, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

type TimelineSummary = Pick<SessionEventStoreRow, "model" | "outcome" | "error" | "durationMs"> & {
  summary: string;
  payloadSummary: Record<string, unknown>;
  searchText: string;
};

type SearchRollup = {
  sessionId: string;
  name: string | null;
  prompt: string | null;
  model: string | null;
  outcome: SessionEventOutcome | "unknown";
  error: string | null;
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
  lastAt: number;
  matchedEvent: string | null;
  queryMatched: boolean;
  models: Set<string>;
};

type AnalyticsRollup = {
  runs: number;
  successful: number;
  failed: number;
  durationTotal: number;
  durationCount: number;
};

function summarizeTimelineEvent(type: string, payload: unknown, fallbackModel: string | null): TimelineSummary {
  const record = asRecord(payload);
  const params = asRecord(record?.params);
  const turn = asRecord(params?.turn) || asRecord(record?.turn);
  const prompt = type === "prompt/submitted" ? stringValue(record?.prompt) : null;
  const method = stringValue(record?.method);
  const state = stringValue(record?.state);
  const action = stringValue(record?.action);
  const reason = stringValue(record?.reason);
  const status = stringValue(turn?.status) || stringValue(record?.status);
  const model = stringValue(record?.model) || stringValue(params?.model) || stringValue(turn?.model) || fallbackModel;
  const error = firstError(record, params, turn);
  const outcome = terminalOutcome(type, method, state, status);
  const durationMs = outcome ? eventDuration(record, turn) : null;
  const payloadSummary: Record<string, unknown> = {};
  if (method) payloadSummary.method = method;
  if (state) payloadSummary.state = state;
  if (action) payloadSummary.action = action;
  if (reason) payloadSummary.reason = truncate(reason, 300);
  if (status) payloadSummary.status = status;
  if (model) payloadSummary.model = model;
  if (prompt) payloadSummary.prompt = truncate(prompt.trim(), 500);
  if (error) payloadSummary.error = truncate(error, 500);
  if (durationMs !== null) payloadSummary.durationMs = durationMs;
  const item = asRecord(params?.item);
  const itemType = stringValue(item?.type);
  if (itemType) payloadSummary.itemType = itemType;
  const delta = stringValue(params?.delta);
  if (delta) payloadSummary.deltaCharacters = delta.length;
  const queue = Array.isArray(record?.queue) ? record.queue : null;
  if (queue) payloadSummary.queueDepth = queue.length;
  const summary = timelineSummaryText(type, { method, state, action, reason, status, itemType, outcome, error });
  return {
    summary: truncate(summary, 300),
    payloadSummary,
    searchText: [type, summary, prompt, model, error, method, state, action, reason, status, itemType].filter(Boolean).join(" "),
    model,
    outcome,
    error,
    durationMs
  };
}

function timelineSummaryText(type: string, values: {
  method: string | null;
  state: string | null;
  action: string | null;
  reason: string | null;
  status: string | null;
  itemType: string | null;
  outcome: SessionEventOutcome | null;
  error: string | null;
}): string {
  if (type === "prompt/submitted") return "Prompt submitted";
  if (values.method === "turn/started") return "Turn started";
  if (values.method === "turn/completed") {
    if (values.outcome === "failed") return `Turn failed${values.error ? `: ${values.error}` : ""}`;
    if (values.outcome === "interrupted") return "Turn interrupted";
    return "Turn completed";
  }
  if (values.method === "item/started") return `${readable(values.itemType || "item")} started`;
  if (values.method === "item/completed") return `${readable(values.itemType || "item")} completed`;
  if (values.method === "item/agentMessage/delta") return "Agent response updated";
  if (type === "claude-turn") {
    if (values.state === "failed") return `Claude turn failed${values.error ? `: ${values.error}` : ""}`;
    return `Claude turn ${readable(values.state || "updated")}`;
  }
  if (type === "guardian") return `Guardian ${readable(values.reason || values.state || "updated")}`;
  if (type === "queue") return values.error ? `Queue error: ${values.error}` : "Queue updated";
  if (type === "threads") return `Session ${readable(values.action || "updated")}`;
  if (values.method) return readable(values.method.replaceAll("/", " "));
  return [readable(type), values.action || values.state || values.status || values.reason].filter(Boolean).join(" · ");
}

function terminalOutcome(type: string, method: string | null, state: string | null, status: string | null): SessionEventOutcome | null {
  const terminal = method === "turn/completed" || (type === "claude-turn" && (state === "completed" || state === "failed"));
  if (!terminal) return null;
  const normalized = (status || state || "completed").toLocaleLowerCase("en-US");
  if (normalized === "failed" || normalized === "error") return "failed";
  if (normalized === "interrupted" || normalized === "cancelled" || normalized === "canceled") return "interrupted";
  return "success";
}

function eventDuration(record: Record<string, unknown> | null, turn: Record<string, unknown> | null): number | null {
  const startedAt = timestampValue(turn?.startedAt) ?? timestampValue(record?.startedAt) ?? timestampValue(record?.acceptedAt);
  const completedAt = timestampValue(turn?.completedAt) ?? timestampValue(record?.completedAt);
  return startedAt === null || completedAt === null ? null : Math.max(0, completedAt - startedAt);
}

function firstError(...records: Array<Record<string, unknown> | null>): string | null {
  for (const record of records) {
    if (!record) continue;
    const direct = record.error;
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    const nested = asRecord(direct);
    const nestedMessage = stringValue(nested?.message) || stringValue(nested?.error);
    if (nestedMessage) return nestedMessage;
    const message = stringValue(record.message);
    if (message && /(?:error|fail|unable|invalid|denied|timeout)/i.test(message)) return message;
  }
  return null;
}

function toTimelineEvent(row: SessionEventStoreRow): TimelineEvent {
  return {
    id: row.id,
    revision: row.revision,
    threadId: row.threadId,
    type: row.type,
    at: row.at,
    summary: row.summary,
    payloadSummary: parseJsonObject(row.payloadJson, "Timeline payload summary"),
    model: row.model,
    outcome: row.outcome,
    error: row.error,
    durationMs: row.durationMs
  };
}

function emptySearchRollup(threadId: string, at: number): SearchRollup {
  return {
    sessionId: threadId,
    name: null,
    prompt: null,
    model: null,
    outcome: "unknown",
    error: null,
    startedAt: at,
    completedAt: null,
    durationMs: null,
    lastAt: at,
    matchedEvent: null,
    queryMatched: false,
    models: new Set<string>()
  };
}

function normalizeErrorPattern(error: string): string {
  return truncate(error.trim()
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<id>")
    .replace(/(?:[A-Za-z]:)?[\\/](?:[^\s:]+[\\/])+[^\s:]+/g, "<path>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
    .replace(/\s+/g, " "), 240) || "Unknown error";
}

function timestampValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value < 100_000_000_000 ? value * 1_000 : value;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, Math.max(0, length - 1)).trimEnd()}…`;
}

function readable(value: string): string {
  const normalized = value.replace(/[-_]/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return normalized ? `${normalized[0]?.toUpperCase()}${normalized.slice(1)}` : "Updated";
}

function rate(successful: number, total: number): number {
  return total ? Math.round((successful / total) * 10_000) / 100 : 0;
}

function decodeSessionOperation(row: SessionOperationStoreRow): SessionOperation {
  return {
    id: row.id,
    kind: row.kind,
    idempotencyKey: row.idempotencyKey,
    requestFingerprint: row.requestFingerprint,
    status: row.status,
    step: row.step,
    remoteThreadId: row.remoteThreadId,
    attemptCount: row.attempts,
    input: parseJsonObject(row.inputJson, "Session operation input"),
    compensation: parseJsonObject(row.compensationJson, "Session operation compensation"),
    result: row.resultJson === null ? null : parseJsonObject(row.resultJson, "Session operation result"),
    error: row.errorJson === null ? null : parseJsonObject(row.errorJson, "Session operation error"),
    nextAttemptAt: row.nextAttemptAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt
  };
}

function encodeSessionOperation(operation: SessionOperation): SessionOperationStoreRow {
  return {
    id: operation.id,
    kind: operation.kind,
    idempotencyKey: operation.idempotencyKey,
    requestFingerprint: operation.requestFingerprint,
    status: operation.status,
    step: operation.step,
    remoteThreadId: operation.remoteThreadId,
    attempts: operation.attemptCount,
    inputJson: canonicalJson(operation.input),
    compensationJson: canonicalJson(operation.compensation),
    resultJson: operation.result === null ? null : canonicalJson(operation.result),
    errorJson: operation.error === null ? null : canonicalJson(operation.error),
    nextAttemptAt: operation.nextAttemptAt,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    completedAt: operation.completedAt
  };
}

function normalizeIdempotencyKey(value: string): string {
  if (typeof value !== "string") throw new Error("Idempotency key must be a string");
  const key = value.trim();
  if (!key || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new Error("Idempotency key must contain between 1 and 200 visible characters");
  }
  return key;
}

function canonicalJson(value: Record<string, unknown>): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, sortJsonValue(child)]));
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be an object`);
  return parsed as Record<string, unknown>;
}

function cloneJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return parseJsonObject(canonicalJson(value), "JSON value");
}

function cloneNullableJsonObject(value: Record<string, unknown> | null): Record<string, unknown> | null {
  return value === null ? null : cloneJsonObject(value);
}

function toMetadataRow(threadId: string, metadata: SessionMetadata): MetadataStoreRow {
  return {
    threadId,
    payload: JSON.stringify(metadata),
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt
  };
}

function decodeMetadata(payload: string): SessionMetadata {
  return normalizeStoredMetadata(JSON.parse(payload) as unknown);
}

function normalizeStoredMetadata(value: unknown): SessionMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Session metadata must be an object");
  const candidate = value as Partial<SessionMetadata>;
  return {
    tags: normalizeTags(candidate.tags),
    category: normalizeCategory(candidate.category),
    createdAt: finiteNumber(candidate.createdAt),
    updatedAt: finiteNumber(candidate.updatedAt),
    sessionClass: candidate.sessionClass === "spark" ? "spark" : "standard",
    backend: candidate.backend === "claude" ? "claude" : "codex",
    cwd: normalizeNullableString(candidate.cwd),
    name: normalizeNullableString(candidate.name),
    preset: normalizeModelPreset((candidate as Record<string, unknown>).preset),
    model: normalizeNullableString(candidate.model),
    effort: normalizeNullableString(candidate.effort),
    permissionMode: normalizeNullableString(candidate.permissionMode),
    maxTurns: normalizeNullableInteger(candidate.maxTurns),
    lastPrompt: normalizeNullableString((candidate as Record<string, unknown>).lastPrompt),
    blueprintId: normalizeNullableString((candidate as Record<string, unknown>).blueprintId),
    blueprintVersion: normalizeNullableInteger((candidate as Record<string, unknown>).blueprintVersion),
    blueprintEnvironment: normalizeNullableString((candidate as Record<string, unknown>).blueprintEnvironment),
    blueprintModelConfiguration: normalizeBlueprintModelConfiguration((candidate as Record<string, unknown>).blueprintModelConfiguration),
    archiveState: candidate.archiveState === "archived" ? "archived" : "active",
    archivedAt: finiteNullableNumber(candidate.archivedAt),
    archiveReason: candidate.archiveReason === "ttl" ? "ttl" : candidate.archiveReason === "manual" ? "manual" : null,
    pinned: candidate.pinned === true,
    knowledgePackIds: normalizeKnowledgePackIds((candidate as Record<string, unknown>).knowledgePackIds),
    knowledgeContextInjectedAt: finiteNullableNumber((candidate as Record<string, unknown>).knowledgeContextInjectedAt),
    policyWarnings: normalizePolicyWarnings((candidate as Record<string, unknown>).policyWarnings),
    workspaceLeaseMode: normalizeWorkspaceLeaseMode((candidate as Record<string, unknown>).workspaceLeaseMode),
    workspaceFileScope: normalizeWorkspaceFileScope((candidate as Record<string, unknown>).workspaceFileScope)
  };
}

function toAuditRow(event: SessionAuditEvent): AuditStoreRow {
  const serialized = JSON.stringify(event);
  if (serialized === undefined) throw new Error("Audit event could not be serialized");
  const detailsJson = event.details === undefined ? null : JSON.stringify(event.details);
  if (event.details !== undefined && detailsJson === undefined) throw new Error("Audit details could not be serialized");
  return {
    id: event.id,
    threadId: event.threadId,
    action: event.action,
    at: event.at,
    actor: event.actor,
    detailsJson,
    byteSize: Buffer.byteLength(serialized) + 1
  };
}

function fromAuditRow(row: AuditStoreRow): SessionAuditEvent {
  return {
    id: row.id,
    threadId: row.threadId,
    action: row.action,
    at: row.at,
    actor: row.actor,
    ...(row.detailsJson ? { details: parseDetails(row.detailsJson) } : {})
  };
}

function parseDetails(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Audit details must be an object");
  return parsed as Record<string, unknown>;
}

function parseLegacyAuditEvent(line: string): SessionAuditEvent {
  const parsed = JSON.parse(line) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Audit event must be an object");
  const event = parsed as Partial<SessionAuditEvent>;
  if (typeof event.id !== "string" || !event.id || typeof event.threadId !== "string" || !event.threadId) throw new Error("Invalid audit identity");
  if (typeof event.action !== "string" || !event.action || typeof event.actor !== "string" || !event.actor) throw new Error("Invalid audit action");
  if (typeof event.at !== "number" || !Number.isFinite(event.at) || event.at < 0) throw new Error("Invalid audit timestamp");
  if (event.details !== undefined && (!event.details || typeof event.details !== "object" || Array.isArray(event.details))) {
    throw new Error("Invalid audit details");
  }
  return event as SessionAuditEvent;
}

function parseLegacyMetadataSnapshot(value: string): { records: Map<string, SessionMetadata>; invalidRecords: number } {
  const parsed = parseObject(value);
  if ("data" in parsed && "revision" in parsed && "checksum" in parsed) {
    const data = parsed.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Legacy metadata envelope data is invalid");
    const checksum = createHash("sha256").update(JSON.stringify(data)).digest("hex");
    if (parsed.checksum !== checksum) throw new Error("Legacy metadata checksum does not match");
    return parseLegacyMetadataObject(data as Record<string, unknown>);
  }
  return parseLegacyMetadataObject(parsed);
}

function parseLegacyMetadataObject(value: Record<string, unknown>): { records: Map<string, SessionMetadata>; invalidRecords: number } {
  const records = new Map<string, SessionMetadata>();
  let invalidRecords = 0;
  for (const [threadId, candidate] of Object.entries(value)) {
    try {
      records.set(threadId, normalizeStoredMetadata(candidate));
    } catch {
      invalidRecords += 1;
    }
  }
  return { records, invalidRecords };
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parseObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Session metadata must be a JSON object");
  return parsed as Record<string, unknown>;
}

function salvageMetadataRecords(value: string): Record<string, unknown> {
  const salvaged: Record<string, unknown> = {};
  let cursor = value.indexOf("{") + 1;
  if (cursor <= 0) return salvaged;
  while (cursor < value.length) {
    while (/[\s,]/.test(value[cursor] || "")) cursor += 1;
    if (value[cursor] === "}") break;
    if (value[cursor] !== "\"") { cursor += 1; continue; }
    const keyEnd = jsonStringEnd(value, cursor);
    if (keyEnd < 0) break;
    let key: string;
    try { key = JSON.parse(value.slice(cursor, keyEnd + 1)) as string; } catch { cursor = keyEnd + 1; continue; }
    cursor = keyEnd + 1;
    while (/\s/.test(value[cursor] || "")) cursor += 1;
    if (value[cursor] !== ":") continue;
    cursor += 1;
    while (/\s/.test(value[cursor] || "")) cursor += 1;
    if (value[cursor] !== "{") continue;
    const objectEnd = jsonObjectEnd(value, cursor);
    if (objectEnd < 0) break;
    try { salvaged[key] = JSON.parse(value.slice(cursor, objectEnd + 1)) as unknown; } catch { /* skip only this damaged record */ }
    cursor = objectEnd + 1;
  }
  return salvaged;
}

function jsonStringEnd(value: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    if (escaped) { escaped = false; continue; }
    if (value[index] === "\\") { escaped = true; continue; }
    if (value[index] === "\"") return index;
  }
  return -1;
}

function jsonObjectEnd(value: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  return -1;
}

function nonNegativeDuration(value: number | undefined, fallback: number, label: string): number {
  const duration = value ?? fallback;
  if (!Number.isFinite(duration) || duration < 0) throw new RangeError(`${label} must be non-negative`);
  return duration;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const number = value ?? fallback;
  if (!Number.isInteger(number) || number <= 0) throw new RangeError(`${label} must be a positive integer`);
  return number;
}

function normalizeSessionClass(value: unknown, previous: SessionClass | undefined): SessionClass {
  if (value === undefined) return previous || "standard";
  if (value !== "standard" && value !== "spark") throw new Error("Invalid session class");
  return value;
}

function normalizeBackend(value: unknown, previous: SessionBackend | undefined): SessionBackend {
  if (value === undefined) return previous || "codex";
  if (value !== "codex" && value !== "claude") throw new Error("Invalid session backend");
  return value;
}

function normalizeWorkspaceLeaseMode(value: unknown): WorkspaceLeaseMode {
  if (value === undefined || value === null || value === "exclusive") return "exclusive";
  if (value === "read-only") return value;
  throw new Error("Invalid workspace lease mode");
}

export function deriveSessionName(prompt: unknown, fallback = "New session"): string {
  if (typeof prompt !== "string") return fallback;
  const firstLine = prompt.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!firstLine) return fallback;
  const cleaned = firstLine.replace(/^(?:#{1,6}|[-*+] |\d+[.)] )\s*/, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return fallback;
  if (cleaned.length <= 100) return cleaned;
  const truncated = cleaned.slice(0, 100);
  const boundary = truncated.lastIndexOf(" ");
  return `${(boundary >= 60 ? truncated.slice(0, boundary) : truncated.slice(0, 99)).trimEnd()}…`;
}

export function isSessionExpired(thread: ThreadLike, activeThreadIds: ReadonlySet<string>, ttlMs = DEFAULT_SESSION_TTL_MS, now = Date.now()): boolean {
  if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new RangeError("Session TTL must be non-negative");
  const threadId = typeof thread.id === "string" ? thread.id : "";
  if (!threadId || ttlMs === 0 || activeThreadIds.has(threadId) || thread.pinned === true || thread.archiveState === "archived") return false;
  const status = thread.status && typeof thread.status === "object" ? (thread.status as { type?: unknown }).type : null;
  if (status === "active") return false;
  const updatedAt = Math.max(normalizeTimestamp(thread.updatedAt), normalizeTimestamp(thread.recencyAt));
  return updatedAt > 0 && now - updatedAt > ttlMs;
}

export function normalizeTags(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("Tags must be an array of strings");
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") throw new Error("Tags must be an array of strings");
    const tag = raw.trim().replace(/\s+/g, " ");
    if (!tag) continue;
    if (tag.length > 32) throw new Error("Tags must be 32 characters or fewer");
    const key = tag.normalize("NFKC").toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      tags.push(tag);
    }
  }
  if (tags.length > 10) throw new Error("A session can have at most 10 tags");
  return tags;
}

export function normalizeCategory(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error("Category must be a string or null");
  const category = value.trim().replace(/\s+/g, " ");
  if (!category) return null;
  if (category.length > 50) throw new Error("Category must be 50 characters or fewer");
  return category;
}

function normalizeTimestamp(value: unknown): number {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number < 10_000_000_000 ? number * 1_000 : number;
}

function finiteNumber(value: unknown): number {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function finiteNullableNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function emptyMetadata(): SessionMetadata {
  return {
    tags: [], category: null, createdAt: 0, updatedAt: 0, sessionClass: "standard", backend: "codex",
    cwd: null, name: null, preset: null, model: null, effort: null, permissionMode: null, maxTurns: null, lastPrompt: null,
    blueprintId: null, blueprintVersion: null, blueprintEnvironment: null, blueprintModelConfiguration: null,
    archiveState: "active", archivedAt: null, archiveReason: null, pinned: false,
    knowledgePackIds: [], knowledgeContextInjectedAt: null, policyWarnings: [], workspaceLeaseMode: "exclusive",
    workspaceFileScope: null
  };
}

function cloneMetadata(metadata: SessionMetadata): SessionMetadata {
  return {
    ...metadata,
    tags: [...metadata.tags],
    knowledgePackIds: [...metadata.knowledgePackIds],
    policyWarnings: [...metadata.policyWarnings],
    workspaceFileScope: metadata.workspaceFileScope ? [...metadata.workspaceFileScope] : null,
    blueprintModelConfiguration: metadata.blueprintModelConfiguration ? { ...metadata.blueprintModelConfiguration } : null
  };
}

function normalizeWorkspaceLeaseRoot(value: string | null): string {
  if (!value || !path.isAbsolute(value)) {
    throw new ConflictError("A session must have an absolute workspace path before it can acquire a lease", {
      code: "WORKSPACE_LEASE_ROOT_REQUIRED",
      scope: "workspace"
    });
  }
  return path.resolve(value);
}

function cloneWorkspaceLease(lease: WorkspaceLease): WorkspaceLease {
  return { ...lease, ...(lease.fileScope ? { fileScope: [...lease.fileScope] } : {}) };
}

function workspaceLeaseScopesOverlap(root: string, fileScope: string[] | null, existing: WorkspaceLease): boolean {
  if (!fileScope || !existing.fileScope) return true;
  const requestedPaths = fileScope.map((entry) => path.resolve(root, entry));
  const existingPaths = existing.fileScope.map((entry) => path.resolve(existing.root, entry));
  return requestedPaths.some((requested) => existingPaths.some((active) => workspaceLeaseRootsOverlap(requested, active)));
}

function workspaceLeaseRootsOverlap(left: string, right: string): boolean {
  const relativeLeft = path.relative(left, right);
  const relativeRight = path.relative(right, left);
  return relativeLeft === "" || (!relativeLeft.startsWith(`..${path.sep}`) && relativeLeft !== ".." && !path.isAbsolute(relativeLeft))
    || (!relativeRight.startsWith(`..${path.sep}`) && relativeRight !== ".." && !path.isAbsolute(relativeRight));
}

function normalizeWorkspaceFileScope(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error("Workspace file scope must contain between 1 and 100 relative paths");
  }
  const normalized = value.map((entry) => {
    if (typeof entry !== "string") throw new Error("Workspace file scope entries must be strings");
    const candidate = entry.trim().replace(/\\/g, "/");
    if (!candidate || candidate.length > 1_024 || path.posix.isAbsolute(candidate) || /^[A-Za-z]:\//.test(candidate)) {
      throw new Error("Workspace file scope entries must be relative paths");
    }
    const relative = path.posix.normalize(candidate).replace(/^\.\//, "");
    if (relative === ".." || relative.startsWith("../")) {
      throw new Error("Workspace file scope entries must remain within the workspace");
    }
    return relative;
  });
  return [...new Set(normalized)].sort();
}

function normalizeKnowledgePackIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => (
    typeof item === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(item)
  )))];
}

function normalizePolicyWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string")
    .map((item) => item.trim()).filter(Boolean))].slice(0, 20).map((item) => item.slice(0, 1_000));
}

function normalizeBlueprintModelConfiguration(value: unknown): BlueprintRunModelConfiguration | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<BlueprintRunModelConfiguration>;
  const model = normalizeNullableString(candidate.model);
  if (!model) return null;
  const preset = normalizeModelPreset(candidate.preset);
  return {
    backend: candidate.backend === "claude" ? "claude" : "codex",
    model,
    effort: normalizeNullableString(candidate.effort),
    ...(preset ? { preset } : {})
  };
}

function normalizeModelPreset(value: unknown): ModelPreset | null {
  return value === "quick" || value === "balanced" || value === "deep" ? value : null;
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeNullableInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}
