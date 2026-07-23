import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, backup as backupDatabase, type SQLInputValue, type StatementResultingChanges } from "node:sqlite";

const STORE_SCHEMA_VERSION = 12;
const BUSY_TIMEOUT_MS = 15_000;
const DEFAULT_BACKUP_INTERVAL_REVISIONS = 128;

export type MetadataStoreRow = {
  threadId: string;
  payload: string;
  createdAt: number;
  updatedAt: number;
};

export type CanonicalItemStoreRow = {
  threadId: string;
  itemId: string;
  payload: string;
  updatedAt: number;
};

export type RunGuardianStoreRow = {
  threadId: string;
  payload: string;
  updatedAt: number;
};

export type ArtifactStoreRow = {
  id: string;
  sessionId: string;
  name: string;
  type: "FileArtifact" | "PatchArtifact" | "TestResultArtifact" | "CommandArtifact" | "ReviewVerdictArtifact";
  schemaJson: string;
  version: number;
  producerSession: string;
  producerJson: string;
  provenanceJson: string;
  contentHash: string;
  retentionJson: string;
  contentJson: string | null;
  referenceJson: string | null;
  validationJson: string;
  createdAt: number;
  updatedAt: number;
};

export type AuditStoreRow = {
  id: string;
  threadId: string;
  action: string;
  at: number;
  actor: string;
  detailsJson: string | null;
  byteSize: number;
};

export type SessionEventOutcome = "success" | "failed" | "interrupted";

export type SessionEventStoreRow = {
  id: string;
  revision: number;
  threadId: string;
  type: string;
  at: number;
  summary: string;
  payloadJson: string;
  searchText: string;
  model: string | null;
  outcome: SessionEventOutcome | null;
  error: string | null;
  durationMs: number | null;
};

export type QueueDeliveryState = "queued" | "starting" | "retrying" | "failed";

export type DurableQueueRow = {
  threadId: string;
  id: string;
  payload: string;
  createdAt: number;
  state: QueueDeliveryState;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: number | null;
  claimedAt: number | null;
};

export type SessionOperationKind = "create" | "archive";
export type SessionOperationStatus = "pending" | "running" | "compensating" | "retrying" | "succeeded" | "failed";

export type SessionOperationStoreRow = {
  id: string;
  kind: SessionOperationKind;
  idempotencyKey: string;
  requestFingerprint: string;
  status: SessionOperationStatus;
  step: string;
  remoteThreadId: string | null;
  attempts: number;
  inputJson: string;
  compensationJson: string;
  resultJson: string | null;
  errorJson: string | null;
  nextAttemptAt: number | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type UsageProvider = "codex" | "spark";
export type BudgetScopeType = "run" | "blueprint" | "workspace";
export type BudgetExhaustionPolicy = "wait" | "pause" | "downgrade" | "fallback";

/** Raw, provider-reported usage facts. Currency estimates are stored separately. */
export type UsageEventStoreRow = {
  id: string;
  sourceEventId: string | null;
  observedAt: number;
  provider: UsageProvider;
  model: string;
  runId: string;
  workspaceId: string | null;
  blueprintId: string | null;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  cumulativeInputTokens: number | null;
  cumulativeOutputTokens: number | null;
  cumulativeCachedInputTokens: number | null;
  cumulativeReasoningOutputTokens: number | null;
  cumulativeTotalTokens: number | null;
};

/** A replaceable estimate derived from one raw usage event and one catalog version. */
export type CostEstimateStoreRow = {
  usageEventId: string;
  catalogVersion: string;
  currency: string;
  estimatedMicros: number;
};

export type QuotaEventStoreRow = {
  id: string;
  observedAt: number;
  provider: UsageProvider;
  limitId: string;
  usedPercent: number;
  remainingPercent: number;
  resetAt: number | null;
  rawJson: string;
};

export type BudgetPolicyStoreRow = {
  scopeType: BudgetScopeType;
  scopeId: string;
  softLimitJson: string | null;
  hardLimitJson: string | null;
  exhaustionPolicy: BudgetExhaustionPolicy;
  updatedAt: number;
};

export type PolicyStoreRow = {
  id: string;
  name: string;
  field: "session_class" | "model" | "reasoning_effort" | "workspace" | "time_of_day" | "max_concurrency" | "max_tokens_per_session";
  operator: "equals" | "not_equals" | "contains" | "less_than" | "less_than_or_equal" | "greater_than" | "greater_than_or_equal";
  valueJson: string;
  action: "allow" | "warn" | "block";
  createdAt: number;
  updatedAt: number;
};

export type BlueprintVersionStoreRow = {
  id: string;
  version: number;
  name: string;
  description: string;
  payload: string;
  createdAt: number;
};

export type ScheduleStoreRow = {
  id: string;
  name: string;
  blueprintId: string;
  blueprintVersion: number;
  variablesJson: string;
  workspace: string | null;
  timingJson: string;
  createdAt: number;
  updatedAt: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
};

export type ScheduleRunStatus = "pending" | "running" | "succeeded" | "failed";

export type ScheduleRunStoreRow = {
  id: string;
  scheduleId: string;
  scheduledAt: number;
  startedAt: number;
  completedAt: number | null;
  status: ScheduleRunStatus;
  operationId: string | null;
  threadId: string | null;
  error: string | null;
};

export type EvalRunStoreStatus = "queued" | "running" | "completed" | "failed";

export type EvalRunStoreRow = {
  id: string;
  version: number;
  status: EvalRunStoreStatus;
  payload: string;
  createdAt: number;
  updatedAt: number;
};

export type ComparisonRunStoreStatus = "queued" | "running" | "judging" | "completed" | "failed";

export type ComparisonRunStoreRow = {
  id: string;
  status: ComparisonRunStoreStatus;
  payload: string;
  createdAt: number;
  updatedAt: number;
};

export type MissionVersionStoreRow = {
  id: string;
  version: number;
  name: string;
  description: string;
  payload: string;
  createdAt: number;
};

export type MissionState = "pending" | "running" | "completed" | "failed" | "paused";

export type MissionRunStoreRow = {
  id: string;
  missionId: string;
  missionVersion: number;
  state: MissionState;
  payload: string;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type KnowledgePackStoreRow = {
  id: string;
  name: string;
  scope: "global" | "workspace";
  workspace: string | null;
  sourcesJson: string;
  cachedContent: string | null;
  contentHash: string | null;
  sourceStateJson: string;
  refreshError: string | null;
  createdAt: number;
  updatedAt: number;
  refreshedAt: number | null;
};

export type UsageAggregateStoreRow = {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  estimatedCostMicros: number;
};

export type StoreRecovery = {
  source: "primary" | "backup" | "empty";
  primaryRevision: number;
  backupRevision: number;
  preservedCorruptFiles: string[];
};

type DatabaseInspection = {
  valid: boolean;
  revision: number;
};

type StoreStateRow = {
  revision: number;
  backup_revision: number;
  legacy_migrated: number;
  audit_bytes: number;
};

type CountRow = { count: number };
type AuditBytesRow = { audit_bytes: number };

/**
 * Transactional persistence for session metadata, audit events, and durable
 * queues. SQLite's WAL and BEGIN IMMEDIATE provide atomic commits and
 * cross-process file locking without rewriting an entire JSON snapshot.
 */
export class TransactionalStore {
  readonly databaseFile: string;
  readonly backupFile: string;
  readonly recovery: StoreRecovery;

  private closed = false;
  private backupInFlight: Promise<number> | null = null;
  private backupFailure: unknown = null;

  private constructor(
    private readonly database: DatabaseSync,
    databaseFile: string,
    backupFile: string,
    recovery: StoreRecovery,
    private readonly backupIntervalRevisions: number
  ) {
    this.databaseFile = databaseFile;
    this.backupFile = backupFile;
    this.recovery = recovery;
  }

  static async open(dataDir: string, backupIntervalRevisions = DEFAULT_BACKUP_INTERVAL_REVISIONS): Promise<TransactionalStore> {
    if (!Number.isInteger(backupIntervalRevisions) || backupIntervalRevisions <= 0) {
      throw new RangeError("Backup interval must be a positive integer");
    }
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const databaseFile = path.join(dataDir, "session-store.sqlite");
    const backupFile = `${databaseFile}.bak`;
    const recovery = await recoverDatabase(databaseFile, backupFile);
    const database = new DatabaseSync(databaseFile);
    try {
      configureDatabase(database);
      createSchema(database);
      validateOpenDatabase(database);
    } catch (error) {
      try { database.close(); } catch { /* retain the initialization error */ }
      throw error;
    }
    const store = new TransactionalStore(database, databaseFile, backupFile, recovery, backupIntervalRevisions);
    store.reconcileAuditBytes();
    await fs.chmod(databaseFile, 0o600).catch(() => undefined);
    return store;
  }

  get revision(): number {
    return this.state().revision;
  }

  get backupRevision(): number {
    return this.state().backup_revision;
  }

  get legacyMigrationComplete(): boolean {
    return this.state().legacy_migrated === 1;
  }

  getMetadata(threadId: string): MetadataStoreRow | null {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT thread_id AS threadId, payload, created_at AS createdAt, updated_at AS updatedAt
      FROM session_metadata WHERE thread_id = ?
    `).get(threadId) as MetadataStoreRow | undefined;
    return row || null;
  }

  listMetadata(): MetadataStoreRow[] {
    this.assertOpen();
    return this.database.prepare(`
      SELECT thread_id AS threadId, payload, created_at AS createdAt, updated_at AS updatedAt
      FROM session_metadata ORDER BY rowid
    `).all() as MetadataStoreRow[];
  }

  upsertMetadata(
    row: MetadataStoreRow,
    audit?: AuditStoreRow,
    auditRetentionCutoff: number | null = null,
    auditMaxBytes?: number
  ): void {
    validateMetadataRow(row);
    if (audit) validateAuditRow(audit);
    if (auditRetentionCutoff !== null) assertFiniteNonNegative(auditRetentionCutoff, "Audit retention cutoff");
    if (auditMaxBytes !== undefined) assertPositiveInteger(auditMaxBytes, "Audit maximum size");
    this.write(() => {
      this.database.prepare(`
        INSERT INTO session_metadata(thread_id, payload, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          payload = excluded.payload,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `).run(row.threadId, row.payload, row.createdAt, row.updatedAt);
      if (audit) {
        this.insertAudit(audit);
        if (auditMaxBytes !== undefined) this.compactAuditRows(auditRetentionCutoff, auditMaxBytes);
      }
      return { value: undefined, changed: true };
    });
  }

  touchMetadata(threadId: string, updatedAt: number): boolean {
    assertFiniteNonNegative(updatedAt, "Metadata update timestamp");
    return this.write(() => {
      const result = this.database.prepare(`
        UPDATE session_metadata
        SET updated_at = ?, payload = json_set(payload, '$.updatedAt', ?)
        WHERE thread_id = ?
      `).run(updatedAt, updatedAt, threadId);
      const changed = changeCount(result) > 0;
      return { value: changed, changed };
    });
  }

  removeMetadata(threadId: string): boolean {
    return this.write(() => {
      const changed = changeCount(this.database.prepare("DELETE FROM session_metadata WHERE thread_id = ?").run(threadId)) > 0;
      return { value: changed, changed };
    });
  }

  getRunGuardian(threadId: string): RunGuardianStoreRow | null {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT thread_id AS threadId, payload, updated_at AS updatedAt
      FROM run_guardians WHERE thread_id = ?
    `).get(threadId) as RunGuardianStoreRow | undefined;
    return row || null;
  }

  listRunGuardians(): RunGuardianStoreRow[] {
    this.assertOpen();
    return this.database.prepare(`
      SELECT thread_id AS threadId, payload, updated_at AS updatedAt
      FROM run_guardians ORDER BY updated_at, thread_id
    `).all() as RunGuardianStoreRow[];
  }

  upsertRunGuardian(row: RunGuardianStoreRow): void {
    if (!row.threadId) throw new Error("Guardian thread ID must not be empty");
    validateJson(row.payload, "Guardian state");
    assertFiniteNonNegative(row.updatedAt, "Guardian update timestamp");
    this.write(() => {
      this.database.prepare(`
        INSERT INTO run_guardians(thread_id, payload, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          payload = excluded.payload,
          updated_at = excluded.updated_at
      `).run(row.threadId, row.payload, row.updatedAt);
      return { value: undefined, changed: true };
    });
  }

  removeRunGuardian(threadId: string): boolean {
    return this.write(() => {
      const changed = changeCount(this.database.prepare("DELETE FROM run_guardians WHERE thread_id = ?").run(threadId)) > 0;
      return { value: changed, changed };
    });
  }

  insertKnowledgePack(row: KnowledgePackStoreRow): void {
    validateKnowledgePackRow(row);
    this.write(() => {
      this.database.prepare(`
        INSERT INTO knowledge_packs(
          id, name, scope, workspace, sources_json, cached_content, content_hash,
          source_state_json, refresh_error, created_at, updated_at, refreshed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id, row.name, row.scope, row.workspace, row.sourcesJson, row.cachedContent,
        row.contentHash, row.sourceStateJson, row.refreshError, row.createdAt,
        row.updatedAt, row.refreshedAt
      );
      return { value: undefined, changed: true };
    });
  }

  getKnowledgePack(id: string): KnowledgePackStoreRow | null {
    this.assertOpen();
    return this.selectKnowledgePacks("WHERE id = ?", id)[0] || null;
  }

  listKnowledgePacks(): KnowledgePackStoreRow[] {
    this.assertOpen();
    return this.selectKnowledgePacks("ORDER BY scope, workspace, name COLLATE NOCASE, id");
  }

  invalidateKnowledgePack(id: string, updatedAt: number): boolean {
    assertFiniteNonNegative(updatedAt, "Knowledge pack invalidation timestamp");
    return this.write(() => {
      const result = this.database.prepare(`
        UPDATE knowledge_packs
        SET cached_content = NULL, content_hash = NULL, source_state_json = '[]',
            refresh_error = NULL, updated_at = ?
        WHERE id = ?
      `).run(updatedAt, id);
      const changed = changeCount(result) > 0;
      return { value: changed, changed };
    });
  }

  updateKnowledgePackCache(
    id: string,
    cache: Pick<KnowledgePackStoreRow, "cachedContent" | "contentHash" | "sourceStateJson" | "refreshError" | "updatedAt" | "refreshedAt">
  ): boolean {
    if (cache.cachedContent !== null && cache.contentHash === null) throw new Error("Cached knowledge pack content requires a hash");
    if (cache.cachedContent === null && cache.contentHash !== null) throw new Error("Knowledge pack hash requires cached content");
    validateJson(cache.sourceStateJson, "Knowledge pack source state");
    assertFiniteNonNegative(cache.updatedAt, "Knowledge pack update timestamp");
    if (cache.refreshedAt !== null) assertFiniteNonNegative(cache.refreshedAt, "Knowledge pack refresh timestamp");
    return this.write(() => {
      const result = this.database.prepare(`
        UPDATE knowledge_packs
        SET cached_content = ?, content_hash = ?, source_state_json = ?,
            refresh_error = ?, updated_at = ?, refreshed_at = ?
        WHERE id = ?
      `).run(
        cache.cachedContent, cache.contentHash, cache.sourceStateJson,
        cache.refreshError, cache.updatedAt, cache.refreshedAt, id
      );
      const changed = changeCount(result) > 0;
      return { value: changed, changed };
    });
  }

  removeKnowledgePack(id: string): boolean {
    return this.write(() => {
      const changed = changeCount(this.database.prepare("DELETE FROM knowledge_packs WHERE id = ?").run(id)) > 0;
      return { value: changed, changed };
    });
  }

  nextArtifactVersion(sessionId: string, type: ArtifactStoreRow["type"], name: string): number {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT coalesce(max(version), 0) + 1 AS version
      FROM artifacts WHERE session_id = ? AND type = ? AND name = ?
    `).get(sessionId, type, name) as { version: number };
    return row.version;
  }

  insertArtifact(row: ArtifactStoreRow): void {
    validateArtifactRow(row);
    this.write(() => {
      this.database.prepare(`
        INSERT INTO artifacts(
          id, session_id, name, type, schema_json, version, producer_session, producer_json,
          provenance_json, content_hash, retention_json, content_json, reference_json,
          validation_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id, row.sessionId, row.name, row.type, row.schemaJson, row.version, row.producerSession,
        row.producerJson, row.provenanceJson, row.contentHash, row.retentionJson, row.contentJson,
        row.referenceJson, row.validationJson, row.createdAt, row.updatedAt
      );
      return { value: undefined, changed: true };
    });
  }

  getArtifact(id: string): ArtifactStoreRow | null {
    this.assertOpen();
    return this.selectArtifacts("WHERE id = ?", id)[0] || null;
  }

  listArtifacts(sessionId: string): ArtifactStoreRow[] {
    this.assertOpen();
    return this.selectArtifacts("WHERE session_id = ? ORDER BY created_at, rowid", sessionId);
  }

  removeSessionArtifacts(sessionId: string, includePersistent = false): number {
    return this.write(() => {
      const result = this.database.prepare(`
        DELETE FROM artifacts
        WHERE session_id = ?
          AND (? = 1 OR json_extract(retention_json, '$.policy') != 'persistent')
      `).run(sessionId, includePersistent ? 1 : 0);
      const changed = changeCount(result);
      return { value: changed, changed: changed > 0 };
    });
  }

  purgeMetadataBefore(cutoff: number, maxRows = Number.MAX_SAFE_INTEGER): string[] {
    assertFiniteNonNegative(cutoff, "Metadata retention cutoff");
    assertPositiveInteger(maxRows, "Metadata purge chunk size");
    return this.write(() => {
      const rows = this.database.prepare(`
        DELETE FROM session_metadata
        WHERE rowid IN (
          SELECT rowid FROM session_metadata
          WHERE max(created_at, updated_at) > 0 AND max(created_at, updated_at) < ?
          ORDER BY max(created_at, updated_at), rowid
          LIMIT ?
        )
        RETURNING thread_id AS threadId
      `).all(cutoff, maxRows) as Array<{ threadId: string }>;
      return { value: rows.map((row) => row.threadId), changed: rows.length > 0 };
    });
  }

  purgeArchivedMetadataBefore(cutoff: number, maxRows = Number.MAX_SAFE_INTEGER): string[] {
    assertFiniteNonNegative(cutoff, "Archived metadata retention cutoff");
    assertPositiveInteger(maxRows, "Archived metadata purge chunk size");
    return this.write(() => {
      const rows = this.database.prepare(`
        DELETE FROM session_metadata
        WHERE rowid IN (
          SELECT rowid FROM session_metadata
          WHERE json_extract(payload, '$.archiveState') = 'archived'
            AND coalesce(json_extract(payload, '$.pinned'), 0) = 0
            AND coalesce(json_extract(payload, '$.archivedAt'), updated_at) > 0
            AND coalesce(json_extract(payload, '$.archivedAt'), updated_at) < ?
          ORDER BY coalesce(json_extract(payload, '$.archivedAt'), updated_at), rowid
          LIMIT ?
        )
        RETURNING thread_id AS threadId
      `).all(cutoff, maxRows) as Array<{ threadId: string }>;
      return { value: rows.map((row) => row.threadId), changed: rows.length > 0 };
    });
  }

  upsertCanonicalItem(row: CanonicalItemStoreRow): void {
    validateCanonicalItemRow(row);
    this.write(() => {
      this.database.prepare(`
        INSERT INTO canonical_items(thread_id, item_id, payload, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(thread_id, item_id) DO UPDATE SET
          payload = excluded.payload,
          updated_at = excluded.updated_at
      `).run(row.threadId, row.itemId, row.payload, row.updatedAt);
      return { value: undefined, changed: true };
    });
  }

  replaceCanonicalItems(threadId: string, rows: readonly CanonicalItemStoreRow[]): void {
    if (!threadId) throw new Error("Canonical history thread ID must not be empty");
    for (const row of rows) {
      validateCanonicalItemRow(row);
      if (row.threadId !== threadId) throw new Error("Canonical item belongs to a different thread");
    }
    this.write(() => {
      const removed = changeCount(this.database.prepare("DELETE FROM canonical_items WHERE thread_id = ?").run(threadId));
      const insert = this.database.prepare(`
        INSERT INTO canonical_items(thread_id, item_id, payload, updated_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const row of rows) insert.run(row.threadId, row.itemId, row.payload, row.updatedAt);
      return { value: undefined, changed: removed > 0 || rows.length > 0 };
    });
  }

  listCanonicalItems(threadId: string): CanonicalItemStoreRow[] {
    this.assertOpen();
    return this.database.prepare(`
      SELECT thread_id AS threadId, item_id AS itemId, payload, updated_at AS updatedAt
      FROM canonical_items WHERE thread_id = ? ORDER BY rowid
    `).all(threadId) as CanonicalItemStoreRow[];
  }

  purgeCanonicalItemsBefore(cutoff: number, maxRows = Number.MAX_SAFE_INTEGER): number {
    assertFiniteNonNegative(cutoff, "Canonical history retention cutoff");
    assertPositiveInteger(maxRows, "Canonical history purge chunk size");
    return this.write(() => {
      const result = this.database.prepare(`
        DELETE FROM canonical_items WHERE rowid IN (
          SELECT rowid FROM canonical_items WHERE updated_at < ? ORDER BY updated_at, rowid LIMIT ?
        )
      `).run(cutoff, maxRows);
      const changed = changeCount(result);
      return { value: changed, changed: changed > 0 };
    });
  }

  appendAudit(row: AuditStoreRow, retentionCutoff: number | null, maxBytes: number): void {
    validateAuditRow(row);
    if (retentionCutoff !== null) assertFiniteNonNegative(retentionCutoff, "Audit retention cutoff");
    assertPositiveInteger(maxBytes, "Audit maximum size");
    this.write(() => {
      this.insertAudit(row);
      this.compactAuditRows(retentionCutoff, maxBytes);
      return { value: undefined, changed: true };
    });
  }

  history(threadId: string, limit: number): AuditStoreRow[] {
    this.assertOpen();
    assertPositiveInteger(limit, "Audit history limit");
    const rows = this.database.prepare(`
      SELECT id, thread_id AS threadId, action, at, actor,
             details_json AS detailsJson, byte_size AS byteSize
      FROM audit_events
      WHERE thread_id = ?
      ORDER BY at DESC, rowid DESC
      LIMIT ?
    `).all(threadId, limit) as AuditStoreRow[];
    return rows.reverse();
  }

  appendSessionEvent(row: SessionEventStoreRow): boolean {
    validateSessionEventRow(row);
    return this.write(() => {
      const result = this.database.prepare(`
        INSERT OR IGNORE INTO session_events(
          id, revision, thread_id, type, at, summary, payload_json,
          search_text, model, outcome, error, duration_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id, row.revision, row.threadId, row.type, row.at, row.summary,
        row.payloadJson, row.searchText, row.model, row.outcome, row.error, row.durationMs
      );
      const changed = changeCount(result) > 0;
      if (changed) this.database.prepare("UPDATE event_stream_state SET revision = max(revision, ?) WHERE singleton = 1").run(row.revision);
      return { value: changed, changed };
    });
  }

  appendNextSessionEvent(row: Omit<SessionEventStoreRow, "id" | "revision">): SessionEventStoreRow {
    return this.write(() => {
      const revisionRow = this.database.prepare(`
        UPDATE event_stream_state SET revision = revision + 1 WHERE singleton = 1
        RETURNING revision
      `).get() as { revision: number } | undefined;
      if (!revisionRow) throw new Error("Event stream state is missing");
      const event: SessionEventStoreRow = { ...row, id: `sse:${revisionRow.revision}`, revision: revisionRow.revision };
      validateSessionEventRow(event);
      this.database.prepare(`
        INSERT INTO session_events(
          id, revision, thread_id, type, at, summary, payload_json,
          search_text, model, outcome, error, duration_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id, event.revision, event.threadId, event.type, event.at, event.summary,
        event.payloadJson, event.searchText, event.model, event.outcome, event.error, event.durationMs
      );
      return { value: event, changed: true };
    });
  }

  listSessionEvents(threadId: string, limit: number): SessionEventStoreRow[] {
    this.assertOpen();
    if (!threadId) throw new Error("Timeline thread ID must not be empty");
    assertPositiveInteger(limit, "Timeline event limit");
    const rows = this.database.prepare(`
      SELECT id, revision, thread_id AS threadId, type, at, summary,
             payload_json AS payloadJson, search_text AS searchText, model,
             outcome, error, duration_ms AS durationMs
      FROM session_events
      WHERE thread_id = ?
      ORDER BY at DESC, rowid DESC
      LIMIT ?
    `).all(threadId, limit) as SessionEventStoreRow[];
    return rows.reverse();
  }

  listAllSessionEvents(): SessionEventStoreRow[] {
    this.assertOpen();
    return this.database.prepare(`
      SELECT id, revision, thread_id AS threadId, type, at, summary,
             payload_json AS payloadJson, search_text AS searchText, model,
             outcome, error, duration_ms AS durationMs
      FROM session_events
      ORDER BY at, rowid
    `).all() as SessionEventStoreRow[];
  }

  latestEventStreamRevision(): number {
    this.assertOpen();
    const row = this.database.prepare("SELECT revision FROM event_stream_state WHERE singleton = 1").get() as { revision: number };
    return row.revision;
  }

  nextEventStreamRevision(): number {
    return this.write(() => {
      const row = this.database.prepare(`
        UPDATE event_stream_state SET revision = revision + 1 WHERE singleton = 1
        RETURNING revision
      `).get() as { revision: number } | undefined;
      if (!row) throw new Error("Event stream state is missing");
      return { value: row.revision, changed: true };
    });
  }

  compactAudit(retentionCutoff: number | null, maxBytes: number, maxRows = Number.MAX_SAFE_INTEGER): number {
    if (retentionCutoff !== null) assertFiniteNonNegative(retentionCutoff, "Audit retention cutoff");
    assertPositiveInteger(maxBytes, "Audit maximum size");
    assertPositiveInteger(maxRows, "Audit compaction chunk size");
    return this.write(() => {
      const before = this.auditCount();
      this.compactAuditRows(retentionCutoff, maxBytes, maxRows);
      const removed = before - this.auditCount();
      return { value: removed, changed: removed > 0 };
    });
  }

  importLegacy(metadata: readonly MetadataStoreRow[], audit: readonly AuditStoreRow[]): boolean {
    for (const row of metadata) validateMetadataRow(row);
    for (const row of audit) validateAuditRow(row);
    return this.write(() => {
      if (this.legacyMigrationComplete) return { value: false, changed: false };
      const insertMetadata = this.database.prepare(`
        INSERT OR IGNORE INTO session_metadata(thread_id, payload, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `);
      const insertAudit = this.database.prepare(`
        INSERT OR IGNORE INTO audit_events(id, thread_id, action, at, actor, details_json, byte_size)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of metadata) insertMetadata.run(row.threadId, row.payload, row.createdAt, row.updatedAt);
      for (const row of audit) {
        insertAudit.run(row.id, row.threadId, row.action, row.at, row.actor, row.detailsJson, row.byteSize);
      }
      this.database.prepare("UPDATE store_state SET legacy_migrated = 1 WHERE singleton = 1").run();
      return { value: true, changed: true };
    });
  }

  listQueue(threadId?: string): DurableQueueRow[] {
    this.assertOpen();
    const sql = `
      SELECT thread_id AS threadId, id, payload, created_at AS createdAt, state,
             attempts, last_error AS lastError, next_attempt_at AS nextAttemptAt,
             claimed_at AS claimedAt
      FROM queue_items
      ${threadId === undefined ? "" : "WHERE thread_id = ?"}
      ORDER BY thread_id, created_at, rowid
    `;
    return (threadId === undefined ? this.database.prepare(sql).all() : this.database.prepare(sql).all(threadId)) as DurableQueueRow[];
  }

  enqueue(row: Omit<DurableQueueRow, "state" | "attempts" | "lastError" | "nextAttemptAt" | "claimedAt">): void {
    validateJson(row.payload, "Queue payload");
    assertFiniteNonNegative(row.createdAt, "Queue creation timestamp");
    this.write(() => {
      this.database.prepare(`
        INSERT INTO queue_items(thread_id, id, payload, created_at, state, attempts)
        VALUES (?, ?, ?, ?, 'queued', 0)
      `).run(row.threadId, row.id, row.payload, row.createdAt);
      return { value: undefined, changed: true };
    });
  }

  claimQueueHead(threadId: string, now: number): DurableQueueRow | null {
    assertFiniteNonNegative(now, "Queue claim timestamp");
    return this.write(() => {
      const row = this.database.prepare(`
        SELECT thread_id AS threadId, id, payload, created_at AS createdAt, state,
               attempts, last_error AS lastError, next_attempt_at AS nextAttemptAt,
               claimed_at AS claimedAt
        FROM queue_items
        WHERE thread_id = ?
          AND state IN ('queued', 'retrying')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY created_at, rowid
        LIMIT 1
      `).get(threadId, now) as DurableQueueRow | undefined;
      if (!row) return { value: null, changed: false };
      this.database.prepare(`
        UPDATE queue_items
        SET state = 'starting', attempts = attempts + 1, last_error = NULL,
            next_attempt_at = NULL, claimed_at = ?
        WHERE id = ?
      `).run(now, row.id);
      return {
        value: {
          ...row,
          state: "starting" as const,
          attempts: row.attempts + 1,
          lastError: null,
          nextAttemptAt: null,
          claimedAt: now
        },
        changed: true
      };
    });
  }

  retryQueueItem(id: string, error: string, nextAttemptAt: number): boolean {
    assertFiniteNonNegative(nextAttemptAt, "Queue retry timestamp");
    return this.updateQueueFailure(id, "retrying", error, nextAttemptAt);
  }

  failQueueItem(id: string, error: string): boolean {
    return this.updateQueueFailure(id, "failed", error, null);
  }

  completeQueueItem(id: string): boolean {
    return this.write(() => {
      const changed = changeCount(this.database.prepare("DELETE FROM queue_items WHERE id = ?").run(id)) > 0;
      return { value: changed, changed };
    });
  }

  recoverQueueClaims(staleBefore: number, retryAt: number): number {
    assertFiniteNonNegative(staleBefore, "Queue lease cutoff");
    assertFiniteNonNegative(retryAt, "Queue recovery timestamp");
    return this.write(() => {
      const result = this.database.prepare(`
        UPDATE queue_items
        SET state = 'retrying', last_error = 'Recovered interrupted delivery',
            next_attempt_at = ?, claimed_at = NULL
        WHERE state = 'starting' AND claimed_at < ?
      `).run(retryAt, staleBefore);
      const changed = changeCount(result);
      return { value: changed, changed: changed > 0 };
    });
  }

  insertSessionOperation(row: SessionOperationStoreRow): { operation: SessionOperationStoreRow; created: boolean } {
    validateSessionOperationRow(row);
    return this.write(() => {
      const result = this.database.prepare(`
        INSERT OR IGNORE INTO session_operations(
          id, kind, idempotency_key, request_fingerprint, status, step, remote_thread_id,
          attempts, input_json, compensation_json, result_json, error_json, next_attempt_at,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id, row.kind, row.idempotencyKey, row.requestFingerprint, row.status, row.step, row.remoteThreadId,
        row.attempts, row.inputJson, row.compensationJson, row.resultJson, row.errorJson, row.nextAttemptAt,
        row.createdAt, row.updatedAt, row.completedAt
      );
      const created = changeCount(result) > 0;
      const operation = created ? row : this.selectSessionOperationByKey(row.kind, row.idempotencyKey);
      if (!operation) throw new Error("Could not resolve the idempotent session operation");
      return { value: { operation, created }, changed: created };
    });
  }

  getSessionOperation(id: string): SessionOperationStoreRow | null {
    this.assertOpen();
    return this.selectSessionOperation("id = ?", id);
  }

  getSessionOperationByKey(kind: SessionOperationKind, idempotencyKey: string): SessionOperationStoreRow | null {
    this.assertOpen();
    return this.selectSessionOperationByKey(kind, idempotencyKey);
  }

  listIncompleteSessionOperations(): SessionOperationStoreRow[] {
    this.assertOpen();
    return this.selectSessionOperations(`
      WHERE status IN ('pending', 'running', 'compensating', 'retrying')
      ORDER BY created_at, rowid
    `);
  }

  findIncompleteSessionOperation(kind: SessionOperationKind, remoteThreadId: string): SessionOperationStoreRow | null {
    this.assertOpen();
    return this.selectSessionOperation(
      "kind = ? AND remote_thread_id = ? AND status IN ('pending', 'running', 'compensating', 'retrying') ORDER BY created_at LIMIT 1",
      kind,
      remoteThreadId
    );
  }

  updateSessionOperation(row: SessionOperationStoreRow): boolean {
    validateSessionOperationRow(row);
    return this.write(() => {
      const result = this.database.prepare(`
        UPDATE session_operations SET
          status = ?, step = ?, remote_thread_id = ?, attempts = ?, input_json = ?, compensation_json = ?,
          result_json = ?, error_json = ?, next_attempt_at = ?, updated_at = ?, completed_at = ?
        WHERE id = ?
      `).run(
        row.status, row.step, row.remoteThreadId, row.attempts, row.inputJson, row.compensationJson,
        row.resultJson, row.errorJson, row.nextAttemptAt, row.updatedAt, row.completedAt, row.id
      );
      const changed = changeCount(result) > 0;
      return { value: changed, changed };
    });
  }

  appendUsageEvent(row: UsageEventStoreRow, estimate: CostEstimateStoreRow | null = null): boolean {
    validateUsageEventRow(row);
    if (estimate) {
      validateCostEstimateRow(estimate);
      if (estimate.usageEventId !== row.id) throw new Error("Cost estimate must reference its usage event");
    }
    return this.write(() => {
      const inserted = changeCount(this.database.prepare(`
        INSERT OR IGNORE INTO usage_events(
          id, source_event_id, observed_at, provider, model, run_id, workspace_id, blueprint_id,
          request_count, input_tokens, output_tokens, cached_input_tokens, reasoning_output_tokens, total_tokens,
          cumulative_input_tokens, cumulative_output_tokens, cumulative_cached_input_tokens,
          cumulative_reasoning_output_tokens, cumulative_total_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id, row.sourceEventId, row.observedAt, row.provider, row.model, row.runId, row.workspaceId, row.blueprintId,
        row.requestCount, row.inputTokens, row.outputTokens, row.cachedInputTokens, row.reasoningOutputTokens, row.totalTokens,
        row.cumulativeInputTokens, row.cumulativeOutputTokens, row.cumulativeCachedInputTokens,
        row.cumulativeReasoningOutputTokens, row.cumulativeTotalTokens
      )) > 0;
      if (inserted && estimate) {
        this.database.prepare(`
          INSERT INTO cost_estimates(usage_event_id, catalog_version, currency, estimated_micros)
          VALUES (?, ?, ?, ?)
        `).run(estimate.usageEventId, estimate.catalogVersion, estimate.currency, estimate.estimatedMicros);
      }
      return { value: inserted, changed: inserted };
    });
  }

  latestUsageCumulative(runId: string, provider: UsageProvider, model: string): UsageEventStoreRow | null {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT id, source_event_id AS sourceEventId, observed_at AS observedAt, provider, model,
             run_id AS runId, workspace_id AS workspaceId, blueprint_id AS blueprintId,
             request_count AS requestCount, input_tokens AS inputTokens, output_tokens AS outputTokens,
             cached_input_tokens AS cachedInputTokens, reasoning_output_tokens AS reasoningOutputTokens,
             total_tokens AS totalTokens, cumulative_input_tokens AS cumulativeInputTokens,
             cumulative_output_tokens AS cumulativeOutputTokens,
             cumulative_cached_input_tokens AS cumulativeCachedInputTokens,
             cumulative_reasoning_output_tokens AS cumulativeReasoningOutputTokens,
             cumulative_total_tokens AS cumulativeTotalTokens
      FROM usage_events
      WHERE run_id = ? AND provider = ? AND model = ? AND cumulative_total_tokens IS NOT NULL
      ORDER BY observed_at DESC, rowid DESC LIMIT 1
    `).get(runId, provider, model) as UsageEventStoreRow | undefined;
    return row || null;
  }

  listUsageEvents(limit = 100, runId?: string): UsageEventStoreRow[] {
    this.assertOpen();
    assertPositiveInteger(limit, "Usage event limit");
    const selection = `
      SELECT id, source_event_id AS sourceEventId, observed_at AS observedAt, provider, model,
             run_id AS runId, workspace_id AS workspaceId, blueprint_id AS blueprintId,
             request_count AS requestCount, input_tokens AS inputTokens, output_tokens AS outputTokens,
             cached_input_tokens AS cachedInputTokens, reasoning_output_tokens AS reasoningOutputTokens,
             total_tokens AS totalTokens, cumulative_input_tokens AS cumulativeInputTokens,
             cumulative_output_tokens AS cumulativeOutputTokens,
             cumulative_cached_input_tokens AS cumulativeCachedInputTokens,
             cumulative_reasoning_output_tokens AS cumulativeReasoningOutputTokens,
             cumulative_total_tokens AS cumulativeTotalTokens
      FROM usage_events ${runId === undefined ? "" : "WHERE run_id = ?"}
      ORDER BY observed_at DESC, rowid DESC LIMIT ?
    `;
    return (runId === undefined
      ? this.database.prepare(selection).all(limit)
      : this.database.prepare(selection).all(runId, limit)) as UsageEventStoreRow[];
  }

  listCostEstimates(limit = 100, runId?: string): CostEstimateStoreRow[] {
    this.assertOpen();
    assertPositiveInteger(limit, "Cost estimate limit");
    const selection = `
      SELECT c.usage_event_id AS usageEventId, c.catalog_version AS catalogVersion,
             c.currency, c.estimated_micros AS estimatedMicros
      FROM cost_estimates c JOIN usage_events u ON u.id = c.usage_event_id
      ${runId === undefined ? "" : "WHERE u.run_id = ?"}
      ORDER BY u.observed_at DESC, u.rowid DESC LIMIT ?
    `;
    return (runId === undefined
      ? this.database.prepare(selection).all(limit)
      : this.database.prepare(selection).all(runId, limit)) as CostEstimateStoreRow[];
  }

  usageAggregate(scopeType: BudgetScopeType, scopeId: string, catalogVersion?: string | null): UsageAggregateStoreRow {
    this.assertOpen();
    const column = scopeColumn(scopeType);
    const costJoin = catalogVersion === undefined
      ? "c.usage_event_id = u.id"
      : catalogVersion === null
        ? "0"
        : "c.usage_event_id = u.id AND c.catalog_version = ?";
    const row = this.database.prepare(`
      SELECT coalesce(sum(u.request_count), 0) AS requestCount,
             coalesce(sum(u.input_tokens), 0) AS inputTokens,
             coalesce(sum(u.output_tokens), 0) AS outputTokens,
             coalesce(sum(u.cached_input_tokens), 0) AS cachedInputTokens,
             coalesce(sum(u.reasoning_output_tokens), 0) AS reasoningOutputTokens,
             coalesce(sum(u.total_tokens), 0) AS totalTokens,
             coalesce(sum(c.estimated_micros), 0) AS estimatedCostMicros
      FROM usage_events u LEFT JOIN cost_estimates c ON ${costJoin}
      WHERE u.${column} = ?
    `).get(...(catalogVersion === undefined || catalogVersion === null ? [scopeId] : [catalogVersion, scopeId])) as UsageAggregateStoreRow;
    return row;
  }

  appendQuotaEvent(row: QuotaEventStoreRow): boolean {
    validateQuotaEventRow(row);
    return this.write(() => {
      const inserted = changeCount(this.database.prepare(`
        INSERT OR IGNORE INTO provider_quota_events(
          id, observed_at, provider, limit_id, used_percent, remaining_percent, reset_at, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(row.id, row.observedAt, row.provider, row.limitId, row.usedPercent, row.remainingPercent, row.resetAt, row.rawJson)) > 0;
      return { value: inserted, changed: inserted };
    });
  }

  latestQuotaEvents(): QuotaEventStoreRow[] {
    this.assertOpen();
    return this.database.prepare(`
      SELECT q.id, q.observed_at AS observedAt, q.provider, q.limit_id AS limitId,
             q.used_percent AS usedPercent, q.remaining_percent AS remainingPercent,
             q.reset_at AS resetAt, q.raw_json AS rawJson
      FROM provider_quota_events q
      WHERE q.rowid = (
        SELECT q2.rowid FROM provider_quota_events q2
        WHERE q2.provider = q.provider AND q2.limit_id = q.limit_id
        ORDER BY q2.observed_at DESC, q2.rowid DESC LIMIT 1
      )
      ORDER BY q.provider, q.limit_id
    `).all() as QuotaEventStoreRow[];
  }

  upsertBudgetPolicy(row: BudgetPolicyStoreRow): void {
    validateBudgetPolicyRow(row);
    this.write(() => {
      this.database.prepare(`
        INSERT INTO budget_policies(scope_type, scope_id, soft_limit_json, hard_limit_json, exhaustion_policy, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_type, scope_id) DO UPDATE SET
          soft_limit_json = excluded.soft_limit_json,
          hard_limit_json = excluded.hard_limit_json,
          exhaustion_policy = excluded.exhaustion_policy,
          updated_at = excluded.updated_at
      `).run(row.scopeType, row.scopeId, row.softLimitJson, row.hardLimitJson, row.exhaustionPolicy, row.updatedAt);
      return { value: undefined, changed: true };
    });
  }

  removeBudgetPolicy(scopeType: BudgetScopeType, scopeId: string): boolean {
    return this.write(() => {
      const changed = changeCount(this.database.prepare(
        "DELETE FROM budget_policies WHERE scope_type = ? AND scope_id = ?"
      ).run(scopeType, scopeId)) > 0;
      return { value: changed, changed };
    });
  }

  listBudgetPolicies(scopeType?: BudgetScopeType, scopeId?: string): BudgetPolicyStoreRow[] {
    this.assertOpen();
    const filters: string[] = [];
    const parameters: string[] = [];
    if (scopeType !== undefined) {
      filters.push("scope_type = ?");
      parameters.push(scopeType);
    }
    if (scopeId !== undefined) {
      filters.push("scope_id = ?");
      parameters.push(scopeId);
    }
    return this.database.prepare(`
      SELECT scope_type AS scopeType, scope_id AS scopeId, soft_limit_json AS softLimitJson,
             hard_limit_json AS hardLimitJson, exhaustion_policy AS exhaustionPolicy, updated_at AS updatedAt
      FROM budget_policies ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
      ORDER BY scope_type, scope_id
    `).all(...parameters) as BudgetPolicyStoreRow[];
  }

  upsertPolicy(row: PolicyStoreRow): void {
    validatePolicyRow(row);
    this.write(() => {
      this.database.prepare(`
        INSERT INTO policies(id, name, field, operator, value_json, action, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          field = excluded.field,
          operator = excluded.operator,
          value_json = excluded.value_json,
          action = excluded.action,
          updated_at = excluded.updated_at
      `).run(row.id, row.name, row.field, row.operator, row.valueJson, row.action, row.createdAt, row.updatedAt);
      return { value: undefined, changed: true };
    });
  }

  getPolicy(id: string): PolicyStoreRow | null {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT id, name, field, operator, value_json AS valueJson, action,
             created_at AS createdAt, updated_at AS updatedAt
      FROM policies WHERE id = ?
    `).get(id) as PolicyStoreRow | undefined;
    return row || null;
  }

  listPolicies(): PolicyStoreRow[] {
    this.assertOpen();
    return this.database.prepare(`
      SELECT id, name, field, operator, value_json AS valueJson, action,
             created_at AS createdAt, updated_at AS updatedAt
      FROM policies ORDER BY created_at, id
    `).all() as PolicyStoreRow[];
  }

  removePolicy(id: string): boolean {
    return this.write(() => {
      const changed = changeCount(this.database.prepare("DELETE FROM policies WHERE id = ?").run(id)) > 0;
      return { value: changed, changed };
    });
  }

  insertBlueprintVersion(row: BlueprintVersionStoreRow): void {
    validateBlueprintVersionRow(row);
    this.write(() => {
      this.database.prepare(`
        INSERT INTO blueprint_versions(id, version, name, description, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(row.id, row.version, row.name, row.description, row.payload, row.createdAt);
      return { value: undefined, changed: true };
    });
  }

  getBlueprintVersion(id: string, version: number): BlueprintVersionStoreRow | null {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT id, version, name, description, payload, created_at AS createdAt
      FROM blueprint_versions WHERE id = ? AND version = ?
    `).get(id, version) as BlueprintVersionStoreRow | undefined;
    return row || null;
  }

  latestBlueprintVersion(id: string): BlueprintVersionStoreRow | null {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT id, version, name, description, payload, created_at AS createdAt
      FROM blueprint_versions WHERE id = ? ORDER BY version DESC LIMIT 1
    `).get(id) as BlueprintVersionStoreRow | undefined;
    return row || null;
  }

  listBlueprintVersions(id: string): BlueprintVersionStoreRow[] {
    this.assertOpen();
    return this.database.prepare(`
      SELECT id, version, name, description, payload, created_at AS createdAt
      FROM blueprint_versions WHERE id = ? ORDER BY version
    `).all(id) as BlueprintVersionStoreRow[];
  }

  searchLatestBlueprintVersions(query: string, limit: number): BlueprintVersionStoreRow[] {
    this.assertOpen();
    const pattern = `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    return this.database.prepare(`
      SELECT candidate.id, candidate.version, candidate.name, candidate.description,
             candidate.payload, candidate.created_at AS createdAt
      FROM blueprint_versions candidate
      WHERE candidate.version = (
        SELECT max(latest.version) FROM blueprint_versions latest WHERE latest.id = candidate.id
      )
        AND (? = '' OR candidate.name LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR candidate.description LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR candidate.id LIKE ? ESCAPE '\\' COLLATE NOCASE)
      ORDER BY candidate.name COLLATE NOCASE, candidate.id
      LIMIT ?
    `).all(query, pattern, pattern, pattern, limit) as BlueprintVersionStoreRow[];
  }

  latestBlueprintVersionsByName(name: string): BlueprintVersionStoreRow[] {
    this.assertOpen();
    return this.database.prepare(`
      SELECT candidate.id, candidate.version, candidate.name, candidate.description,
             candidate.payload, candidate.created_at AS createdAt
      FROM blueprint_versions candidate
      WHERE candidate.version = (
        SELECT max(latest.version) FROM blueprint_versions latest WHERE latest.id = candidate.id
      )
        AND candidate.name = ? COLLATE NOCASE
      ORDER BY candidate.id
    `).all(name) as BlueprintVersionStoreRow[];
  }

  insertSchedule(row: ScheduleStoreRow): void {
    validateScheduleRow(row);
    this.write(() => {
      this.database.prepare(`
        INSERT INTO schedules(
          id, name, blueprint_id, blueprint_version, variables_json, workspace, timing_json,
          created_at, updated_at, last_run_at, next_run_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id, row.name, row.blueprintId, row.blueprintVersion, row.variablesJson, row.workspace,
        row.timingJson, row.createdAt, row.updatedAt, row.lastRunAt, row.nextRunAt
      );
      return { value: undefined, changed: true };
    });
  }

  updateSchedule(row: ScheduleStoreRow): boolean {
    validateScheduleRow(row);
    return this.write(() => {
      const changed = changeCount(this.database.prepare(`
        UPDATE schedules SET
          name = ?, blueprint_id = ?, blueprint_version = ?, variables_json = ?, workspace = ?,
          timing_json = ?, updated_at = ?, next_run_at = ?
        WHERE id = ?
      `).run(
        row.name, row.blueprintId, row.blueprintVersion, row.variablesJson, row.workspace,
        row.timingJson, row.updatedAt, row.nextRunAt, row.id
      )) > 0;
      return { value: changed, changed };
    });
  }

  getSchedule(id: string): ScheduleStoreRow | null {
    this.assertOpen();
    return this.selectSchedules("WHERE id = ?", id)[0] || null;
  }

  listSchedules(): ScheduleStoreRow[] {
    this.assertOpen();
    return this.selectSchedules("ORDER BY name COLLATE NOCASE, created_at, id");
  }

  listDueSchedules(now: number, limit: number): ScheduleStoreRow[] {
    this.assertOpen();
    assertFiniteNonNegative(now, "Schedule due timestamp");
    assertPositiveInteger(limit, "Schedule due limit");
    return this.selectSchedules("WHERE next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, id LIMIT ?", now, limit);
  }

  deleteSchedule(id: string): boolean {
    return this.write(() => {
      const changed = changeCount(this.database.prepare("DELETE FROM schedules WHERE id = ?").run(id)) > 0;
      return { value: changed, changed };
    });
  }

  claimScheduleRun(row: ScheduleRunStoreRow, expectedNextRunAt: number, nextRunAt: number | null): boolean {
    validateScheduleRunRow(row);
    assertFiniteNonNegative(expectedNextRunAt, "Expected schedule timestamp");
    if (nextRunAt !== null) assertFiniteNonNegative(nextRunAt, "Next schedule timestamp");
    return this.write(() => {
      const claimed = changeCount(this.database.prepare(`
        UPDATE schedules SET last_run_at = ?, next_run_at = ?
        WHERE id = ? AND next_run_at = ?
      `).run(row.startedAt, nextRunAt, row.scheduleId, expectedNextRunAt)) > 0;
      if (claimed) this.insertScheduleRun(row);
      return { value: claimed, changed: claimed };
    });
  }

  listScheduleRuns(scheduleId: string, limit = 20): ScheduleRunStoreRow[] {
    this.assertOpen();
    assertPositiveInteger(limit, "Schedule run limit");
    return this.selectScheduleRuns("WHERE schedule_id = ? ORDER BY scheduled_at DESC, rowid DESC LIMIT ?", scheduleId, limit);
  }

  listUnfinishedScheduleRuns(limit = 100): ScheduleRunStoreRow[] {
    this.assertOpen();
    assertPositiveInteger(limit, "Unfinished schedule run limit");
    return this.selectScheduleRuns("WHERE status IN ('pending', 'running') ORDER BY scheduled_at, rowid LIMIT ?", limit);
  }

  updateScheduleRun(row: ScheduleRunStoreRow): boolean {
    validateScheduleRunRow(row);
    return this.write(() => {
      const changed = changeCount(this.database.prepare(`
        UPDATE schedule_runs SET
          completed_at = ?, status = ?, operation_id = ?, thread_id = ?, error = ?
        WHERE id = ?
      `).run(row.completedAt, row.status, row.operationId, row.threadId, row.error, row.id)) > 0;
      return { value: changed, changed };
    });
  }

  insertMissionVersion(row: MissionVersionStoreRow): void {
    validateMissionVersionRow(row);
    this.write(() => {
      this.database.prepare(`
        INSERT INTO mission_versions(id, version, name, description, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(row.id, row.version, row.name, row.description, row.payload, row.createdAt);
      return { value: undefined, changed: true };
    });
  }

  getMissionVersion(id: string, version: number): MissionVersionStoreRow | null {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT id, version, name, description, payload, created_at AS createdAt
      FROM mission_versions WHERE id = ? AND version = ?
    `).get(id, version) as MissionVersionStoreRow | undefined;
    return row || null;
  }

  latestMissionVersion(id: string): MissionVersionStoreRow | null {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT id, version, name, description, payload, created_at AS createdAt
      FROM mission_versions WHERE id = ? ORDER BY version DESC LIMIT 1
    `).get(id) as MissionVersionStoreRow | undefined;
    return row || null;
  }

  listLatestMissionVersions(): MissionVersionStoreRow[] {
    this.assertOpen();
    return this.database.prepare(`
      SELECT versions.id, versions.version, versions.name, versions.description,
             versions.payload, versions.created_at AS createdAt
      FROM mission_versions versions
      WHERE versions.version = (
        SELECT max(candidate.version) FROM mission_versions candidate WHERE candidate.id = versions.id
      )
      ORDER BY versions.name COLLATE NOCASE, versions.created_at, versions.id
    `).all() as MissionVersionStoreRow[];
  }

  deleteMission(id: string): boolean {
    this.assertOpen();
    return this.write(() => {
      const changed = changeCount(this.database.prepare("DELETE FROM mission_versions WHERE id = ?").run(id)) > 0;
      return { value: changed, changed };
    });
  }

  insertMissionRun(row: MissionRunStoreRow): void {
    validateMissionRunRow(row);
    this.write(() => {
      this.database.prepare(`
        INSERT INTO mission_runs(
          id, mission_id, mission_version, state, payload, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id, row.missionId, row.missionVersion, row.state, row.payload,
        row.createdAt, row.updatedAt, row.completedAt
      );
      return { value: undefined, changed: true };
    });
  }

  getMissionRun(id: string): MissionRunStoreRow | null {
    this.assertOpen();
    return this.selectMissionRuns("WHERE id = ?", id)[0] || null;
  }

  latestMissionRun(missionId: string, missionVersion: number): MissionRunStoreRow | null {
    this.assertOpen();
    return this.selectMissionRuns(
      "WHERE mission_id = ? AND mission_version = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      missionId,
      missionVersion
    )[0] || null;
  }

  listUnfinishedMissionRuns(limit = 100): MissionRunStoreRow[] {
    this.assertOpen();
    assertPositiveInteger(limit, "Mission run limit");
    return this.selectMissionRuns(
      "WHERE state IN ('pending', 'running', 'paused') ORDER BY created_at, rowid LIMIT ?",
      limit
    );
  }

  updateMissionRun(row: MissionRunStoreRow): boolean {
    validateMissionRunRow(row);
    return this.write(() => {
      const changed = changeCount(this.database.prepare(`
        UPDATE mission_runs
        SET state = ?, payload = ?, updated_at = ?, completed_at = ?
        WHERE id = ?
      `).run(row.state, row.payload, row.updatedAt, row.completedAt, row.id)) > 0;
      return { value: changed, changed };
    });
  }

  insertEvalRun(row: Omit<EvalRunStoreRow, "version">): EvalRunStoreRow {
    validateEvalRunRow({ ...row, version: 1 });
    return this.write(() => {
      const latest = this.database.prepare(`
        SELECT max(version) AS version FROM eval_runs WHERE id = ?
      `).get(row.id) as { version: number | null };
      const stored = { ...row, version: (latest.version || 0) + 1 };
      this.database.prepare(`
        INSERT INTO eval_runs(id, version, status, payload, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(stored.id, stored.version, stored.status, stored.payload, stored.createdAt, stored.updatedAt);
      return { value: stored, changed: true };
    });
  }

  updateEvalRun(row: EvalRunStoreRow): boolean {
    validateEvalRunRow(row);
    return this.write(() => {
      const changed = changeCount(this.database.prepare(`
        UPDATE eval_runs SET status = ?, payload = ?, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(row.status, row.payload, row.updatedAt, row.id, row.version)) > 0;
      return { value: changed, changed };
    });
  }

  getEvalRun(id: string, version?: number): EvalRunStoreRow | null {
    this.assertOpen();
    if (version !== undefined) assertPositiveInteger(version, "Eval version");
    return this.selectEvalRuns(
      version === undefined
        ? "WHERE id = ? ORDER BY version DESC LIMIT 1"
        : "WHERE id = ? AND version = ? LIMIT 1",
      ...(version === undefined ? [id] : [id, version])
    )[0] || null;
  }

  listEvalRuns(limit = 100): EvalRunStoreRow[] {
    this.assertOpen();
    assertPositiveInteger(limit, "Eval run limit");
    return this.selectEvalRuns("ORDER BY created_at DESC, id, version DESC LIMIT ?", limit);
  }

  insertComparisonRun(row: ComparisonRunStoreRow): void {
    validateComparisonRunRow(row);
    this.write(() => {
      this.database.prepare(`
        INSERT INTO comparison_runs(id, status, payload, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(row.id, row.status, row.payload, row.createdAt, row.updatedAt);
      return { value: undefined, changed: true };
    });
  }

  updateComparisonRun(row: ComparisonRunStoreRow): boolean {
    validateComparisonRunRow(row);
    return this.write(() => {
      const changed = changeCount(this.database.prepare(`
        UPDATE comparison_runs SET status = ?, payload = ?, updated_at = ? WHERE id = ?
      `).run(row.status, row.payload, row.updatedAt, row.id)) > 0;
      return { value: changed, changed };
    });
  }

  getComparisonRun(id: string): ComparisonRunStoreRow | null {
    this.assertOpen();
    return this.selectComparisonRuns("WHERE id = ? LIMIT 1", id)[0] || null;
  }

  listComparisonRuns(limit = 100): ComparisonRunStoreRow[] {
    this.assertOpen();
    assertPositiveInteger(limit, "Comparison run limit");
    return this.selectComparisonRuns("ORDER BY created_at DESC, id LIMIT ?", limit);
  }

  async checkpoint(): Promise<number> {
    this.assertOpen();
    if (this.backupFailure && !this.backupInFlight) {
      const error = this.backupFailure;
      this.backupFailure = null;
      throw error;
    }
    if (this.backupInFlight) {
      const revision = await this.backupInFlight;
      if (this.backupFailure) {
        const error = this.backupFailure;
        this.backupFailure = null;
        throw error;
      }
      return revision;
    }
    this.backupInFlight = this.createBackup().finally(() => { this.backupInFlight = null; });
    return this.backupInFlight;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.backupInFlight) {
      void this.backupInFlight.then(
        () => this.database.close(),
        () => this.database.close()
      );
    } else {
      this.database.close();
    }
  }

  private state(): StoreStateRow {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT revision, backup_revision, legacy_migrated, audit_bytes
      FROM store_state WHERE singleton = 1
    `).get() as StoreStateRow | undefined;
    if (!row) throw new Error("Transactional store state is missing");
    return row;
  }

  private selectSchedules(suffix: string, ...parameters: SQLInputValue[]): ScheduleStoreRow[] {
    return this.database.prepare(`
      SELECT id, name, blueprint_id AS blueprintId, blueprint_version AS blueprintVersion,
             variables_json AS variablesJson, workspace, timing_json AS timingJson,
             created_at AS createdAt, updated_at AS updatedAt, last_run_at AS lastRunAt,
             next_run_at AS nextRunAt
      FROM schedules ${suffix}
    `).all(...parameters) as ScheduleStoreRow[];
  }

  private insertScheduleRun(row: ScheduleRunStoreRow): void {
    this.database.prepare(`
      INSERT INTO schedule_runs(
        id, schedule_id, scheduled_at, started_at, completed_at, status,
        operation_id, thread_id, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.scheduleId, row.scheduledAt, row.startedAt, row.completedAt,
      row.status, row.operationId, row.threadId, row.error
    );
  }

  private selectScheduleRuns(suffix: string, ...parameters: SQLInputValue[]): ScheduleRunStoreRow[] {
    return this.database.prepare(`
      SELECT id, schedule_id AS scheduleId, scheduled_at AS scheduledAt, started_at AS startedAt,
             completed_at AS completedAt, status, operation_id AS operationId,
             thread_id AS threadId, error
      FROM schedule_runs ${suffix}
    `).all(...parameters) as ScheduleRunStoreRow[];
  }

  private selectMissionRuns(suffix: string, ...parameters: SQLInputValue[]): MissionRunStoreRow[] {
    return this.database.prepare(`
      SELECT id, mission_id AS missionId, mission_version AS missionVersion, state,
             payload, created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt
      FROM mission_runs ${suffix}
    `).all(...parameters) as MissionRunStoreRow[];
  }

  private selectEvalRuns(suffix: string, ...parameters: SQLInputValue[]): EvalRunStoreRow[] {
    return this.database.prepare(`
      SELECT id, version, status, payload, created_at AS createdAt, updated_at AS updatedAt
      FROM eval_runs ${suffix}
    `).all(...parameters) as EvalRunStoreRow[];
  }

  private selectComparisonRuns(suffix: string, ...parameters: SQLInputValue[]): ComparisonRunStoreRow[] {
    return this.database.prepare(`
      SELECT id, status, payload, created_at AS createdAt, updated_at AS updatedAt
      FROM comparison_runs ${suffix}
    `).all(...parameters) as ComparisonRunStoreRow[];
  }

  private selectArtifacts(suffix: string, ...parameters: SQLInputValue[]): ArtifactStoreRow[] {
    return this.database.prepare(`
      SELECT id, session_id AS sessionId, name, type, schema_json AS schemaJson, version,
             producer_session AS producerSession, producer_json AS producerJson,
             provenance_json AS provenanceJson, content_hash AS contentHash,
             retention_json AS retentionJson, content_json AS contentJson,
             reference_json AS referenceJson, validation_json AS validationJson,
             created_at AS createdAt, updated_at AS updatedAt
      FROM artifacts ${suffix}
    `).all(...parameters) as ArtifactStoreRow[];
  }

  private selectKnowledgePacks(suffix: string, ...parameters: SQLInputValue[]): KnowledgePackStoreRow[] {
    return this.database.prepare(`
      SELECT id, name, scope, workspace, sources_json AS sourcesJson,
             cached_content AS cachedContent, content_hash AS contentHash,
             source_state_json AS sourceStateJson, refresh_error AS refreshError,
             created_at AS createdAt, updated_at AS updatedAt, refreshed_at AS refreshedAt
      FROM knowledge_packs ${suffix}
    `).all(...parameters) as KnowledgePackStoreRow[];
  }

  private write<T>(operation: () => { value: T; changed: boolean }): T {
    this.assertOpen();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      if (result.changed) this.database.prepare("UPDATE store_state SET revision = revision + 1 WHERE singleton = 1").run();
      this.database.exec("COMMIT");
      if (result.changed) this.scheduleBackupIfDue();
      return result.value;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve the original transaction error */ }
      throw error;
    }
  }

  private insertAudit(row: AuditStoreRow): void {
    this.database.prepare(`
      INSERT INTO audit_events(id, thread_id, action, at, actor, details_json, byte_size)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, row.threadId, row.action, row.at, row.actor, row.detailsJson, row.byteSize);
  }

  private compactAuditRows(retentionCutoff: number | null, maxBytes: number, maxRows = Number.MAX_SAFE_INTEGER): void {
    let removed = 0;
    if (retentionCutoff !== null) {
      removed = changeCount(this.database.prepare(`
        DELETE FROM audit_events WHERE rowid IN (
          SELECT rowid FROM audit_events WHERE at < ? ORDER BY at, rowid LIMIT ?
        )
      `).run(retentionCutoff, maxRows));
    }
    let totalBytes = this.state().audit_bytes;
    const remainingLimit = maxRows - removed;
    if (totalBytes <= maxBytes || remainingLimit <= 0) return;
    const removableCount = Math.max(0, this.auditCount() - 1);
    const rows = this.database.prepare(`
      SELECT id, byte_size AS byteSize FROM audit_events ORDER BY at, rowid LIMIT ?
    `).all(Math.min(remainingLimit, removableCount)) as Array<{ id: string; byteSize: number }>;
    const remove = this.database.prepare("DELETE FROM audit_events WHERE id = ?");
    for (const row of rows) {
      if (totalBytes <= maxBytes) break;
      remove.run(row.id);
      totalBytes -= row.byteSize;
    }
  }

  private auditCount(): number {
    return (this.database.prepare("SELECT count(*) AS count FROM audit_events").get() as CountRow).count;
  }

  private reconcileAuditBytes(): void {
    const actual = (this.database.prepare("SELECT coalesce(sum(byte_size), 0) AS audit_bytes FROM audit_events").get() as AuditBytesRow).audit_bytes;
    if (actual !== this.state().audit_bytes) {
      this.database.prepare("UPDATE store_state SET audit_bytes = ? WHERE singleton = 1").run(actual);
    }
  }

  private updateQueueFailure(id: string, state: "retrying" | "failed", error: string, nextAttemptAt: number | null): boolean {
    const message = error.trim().slice(0, 2_000) || "Queue delivery failed";
    return this.write(() => {
      const result = this.database.prepare(`
        UPDATE queue_items
        SET state = ?, last_error = ?, next_attempt_at = ?, claimed_at = NULL
        WHERE id = ?
      `).run(state, message, nextAttemptAt, id);
      const changed = changeCount(result) > 0;
      return { value: changed, changed };
    });
  }

  private selectSessionOperationByKey(kind: SessionOperationKind, idempotencyKey: string): SessionOperationStoreRow | null {
    return this.selectSessionOperation("kind = ? AND idempotency_key = ?", kind, idempotencyKey);
  }

  private selectSessionOperation(where: string, ...parameters: SQLInputValue[]): SessionOperationStoreRow | null {
    return this.selectSessionOperations(`WHERE ${where}`, ...parameters)[0] || null;
  }

  private selectSessionOperations(suffix: string, ...parameters: SQLInputValue[]): SessionOperationStoreRow[] {
    return this.database.prepare(`
      SELECT id, kind, idempotency_key AS idempotencyKey, request_fingerprint AS requestFingerprint,
             status, step, remote_thread_id AS remoteThreadId, attempts, input_json AS inputJson,
             compensation_json AS compensationJson, result_json AS resultJson, error_json AS errorJson,
             next_attempt_at AS nextAttemptAt, created_at AS createdAt, updated_at AS updatedAt,
             completed_at AS completedAt
      FROM session_operations ${suffix}
    `).all(...parameters) as SessionOperationStoreRow[];
  }

  private scheduleBackupIfDue(): void {
    const state = this.state();
    if (this.backupInFlight || state.revision - state.backup_revision < this.backupIntervalRevisions) return;
    this.backupInFlight = this.createBackup().catch((error: unknown) => {
      this.backupFailure = error;
      return -1;
    }).finally(() => { this.backupInFlight = null; });
  }

  private async createBackup(): Promise<number> {
    const revision = this.revision;
    const temporary = `${this.backupFile}.${process.pid}.${Date.now()}.tmp`;
    await fs.rm(temporary, { force: true });
    try {
      await backupDatabase(this.database, temporary);
      const inspection = inspectDatabase(temporary);
      if (!inspection.valid || inspection.revision < revision) {
        throw new Error(`Store backup validation failed at revision ${revision}`);
      }
      await removeDatabaseSidecars(temporary);
      const handle = await fs.open(temporary, "r+");
      try {
        await handle.chmod(0o600);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await removeDatabaseSidecars(this.backupFile);
      await fs.rename(temporary, this.backupFile);
      await syncDirectory(path.dirname(this.backupFile));
      this.database.prepare("UPDATE store_state SET backup_revision = ? WHERE singleton = 1").run(inspection.revision);
      return inspection.revision;
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      await removeDatabaseSidecars(temporary);
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Transactional store is closed");
  }
}

export type QueueDrainOutcome = void | { retryAfterMs?: number };
export type QueueDrainSchedulerOptions = {
  minimumRetryMs?: number;
  maximumRetryMs?: number;
  onFailure?: (key: string, error: unknown, retryInMs: number) => void;
};

type DrainState = {
  running: boolean;
  pendingWake: boolean;
  attempts: number;
  timer: NodeJS.Timeout | null;
};

/** Retains wake-ups that arrive during a drain and recovers transient failures. */
export class QueueDrainScheduler {
  private readonly states = new Map<string, DrainState>();
  private readonly minimumRetryMs: number;
  private readonly maximumRetryMs: number;
  private closed = false;

  constructor(
    private readonly drain: (key: string) => Promise<QueueDrainOutcome> | QueueDrainOutcome,
    private readonly options: QueueDrainSchedulerOptions = {}
  ) {
    this.minimumRetryMs = positiveDuration(options.minimumRetryMs, 250, "Minimum queue retry");
    this.maximumRetryMs = positiveDuration(options.maximumRetryMs, 30_000, "Maximum queue retry");
    if (this.maximumRetryMs < this.minimumRetryMs) throw new RangeError("Maximum queue retry must not be below the minimum");
  }

  request(key: string): void {
    if (this.closed) return;
    const state = this.states.get(key) || { running: false, pendingWake: false, attempts: 0, timer: null };
    this.states.set(key, state);
    state.pendingWake = true;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    this.start(key, state);
  }

  hasPendingWake(key: string): boolean {
    const state = this.states.get(key);
    return Boolean(state?.pendingWake || state?.running || state?.timer);
  }

  close(): void {
    this.closed = true;
    for (const state of this.states.values()) if (state.timer) clearTimeout(state.timer);
    this.states.clear();
  }

  private start(key: string, state: DrainState): void {
    if (this.closed || state.running || !state.pendingWake) return;
    state.running = true;
    void this.run(key, state);
  }

  private async run(key: string, state: DrainState): Promise<void> {
    let retryAfterMs: number | null = null;
    try {
      while (!this.closed && state.pendingWake) {
        state.pendingWake = false;
        try {
          const outcome = await this.drain(key);
          state.attempts = 0;
          if (outcome?.retryAfterMs !== undefined) {
            retryAfterMs = clampRetry(outcome.retryAfterMs, this.minimumRetryMs, this.maximumRetryMs);
            break;
          }
        } catch (error) {
          state.attempts += 1;
          retryAfterMs = Math.min(this.maximumRetryMs, this.minimumRetryMs * (2 ** Math.min(state.attempts - 1, 10)));
          this.options.onFailure?.(key, error, retryAfterMs);
          break;
        }
      }
    } finally {
      state.running = false;
      if (!this.closed) {
        if (state.pendingWake) {
          this.start(key, state);
        } else if (retryAfterMs !== null) {
          state.timer = setTimeout(() => {
            state.timer = null;
            state.pendingWake = true;
            this.start(key, state);
          }, retryAfterMs);
          state.timer.unref();
        } else {
          this.states.delete(key);
        }
      }
    }
  }
}

function configureDatabase(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
    PRAGMA trusted_schema = OFF;
  `);
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS store_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      backup_revision INTEGER NOT NULL DEFAULT 0,
      legacy_migrated INTEGER NOT NULL DEFAULT 0 CHECK (legacy_migrated IN (0, 1)),
      audit_bytes INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    INSERT OR IGNORE INTO store_state(singleton, schema_version) VALUES (1, ${STORE_SCHEMA_VERSION});

    CREATE TABLE IF NOT EXISTS event_stream_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
    ) STRICT;
    INSERT OR IGNORE INTO event_stream_state(singleton, revision) VALUES (1, 0);

    CREATE TABLE IF NOT EXISTS session_metadata (
      thread_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS session_metadata_retention
      ON session_metadata(updated_at, created_at);

    CREATE TABLE IF NOT EXISTS canonical_items (
      thread_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(thread_id, item_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS canonical_items_thread_history
      ON canonical_items(thread_id, updated_at, item_id);
    CREATE INDEX IF NOT EXISTS canonical_items_retention
      ON canonical_items(updated_at);

    CREATE TABLE IF NOT EXISTS run_guardians (
      thread_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS run_guardians_recovery
      ON run_guardians(updated_at, thread_id);

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('FileArtifact', 'PatchArtifact', 'TestResultArtifact', 'CommandArtifact', 'ReviewVerdictArtifact')),
      schema_json TEXT NOT NULL CHECK (json_valid(schema_json)),
      version INTEGER NOT NULL CHECK (version > 0),
      producer_session TEXT NOT NULL,
      producer_json TEXT NOT NULL CHECK (json_valid(producer_json)),
      provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
      content_hash TEXT NOT NULL,
      retention_json TEXT NOT NULL CHECK (json_valid(retention_json)),
      content_json TEXT CHECK (content_json IS NULL OR json_valid(content_json)),
      reference_json TEXT CHECK (reference_json IS NULL OR json_valid(reference_json)),
      validation_json TEXT NOT NULL CHECK (json_valid(validation_json)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(session_id, type, name, version)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS artifacts_session_history
      ON artifacts(session_id, created_at, type, name, version);
    CREATE INDEX IF NOT EXISTS artifacts_hash
      ON artifacts(content_hash);

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      action TEXT NOT NULL,
      at INTEGER NOT NULL,
      actor TEXT NOT NULL,
      details_json TEXT CHECK (details_json IS NULL OR json_valid(details_json)),
      byte_size INTEGER NOT NULL CHECK (byte_size > 0)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS audit_events_thread_history
      ON audit_events(thread_id, at DESC);
    CREATE INDEX IF NOT EXISTS audit_events_retention
      ON audit_events(at);

    CREATE TABLE IF NOT EXISTS session_events (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      thread_id TEXT NOT NULL,
      type TEXT NOT NULL,
      at INTEGER NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      search_text TEXT NOT NULL,
      model TEXT,
      outcome TEXT CHECK (outcome IS NULL OR outcome IN ('success', 'failed', 'interrupted')),
      error TEXT,
      duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS session_events_thread_timeline
      ON session_events(thread_id, at, revision);
    CREATE INDEX IF NOT EXISTS session_events_outcomes
      ON session_events(outcome, model, at);
    CREATE INDEX IF NOT EXISTS session_events_date
      ON session_events(at);

    CREATE TRIGGER IF NOT EXISTS audit_events_insert_size AFTER INSERT ON audit_events BEGIN
      UPDATE store_state SET audit_bytes = audit_bytes + NEW.byte_size WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS audit_events_delete_size AFTER DELETE ON audit_events BEGIN
      UPDATE store_state SET audit_bytes = max(0, audit_bytes - OLD.byte_size) WHERE singleton = 1;
    END;

    CREATE TABLE IF NOT EXISTS queue_items (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      created_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued', 'starting', 'retrying', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_error TEXT,
      next_attempt_at INTEGER,
      claimed_at INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS queue_items_delivery
      ON queue_items(thread_id, created_at, state, next_attempt_at);

    CREATE TABLE IF NOT EXISTS session_operations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('create', 'archive')),
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'compensating', 'retrying', 'succeeded', 'failed')),
      step TEXT NOT NULL,
      remote_thread_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      input_json TEXT NOT NULL CHECK (json_valid(input_json)),
      compensation_json TEXT NOT NULL CHECK (json_valid(compensation_json)),
      result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
      error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
      next_attempt_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      UNIQUE(kind, idempotency_key)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS session_operations_recovery
      ON session_operations(status, next_attempt_at, created_at);
    CREATE INDEX IF NOT EXISTS session_operations_remote_thread
      ON session_operations(kind, remote_thread_id, status);

    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      source_event_id TEXT UNIQUE,
      observed_at INTEGER NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('codex', 'spark')),
      model TEXT NOT NULL,
      run_id TEXT NOT NULL,
      workspace_id TEXT,
      blueprint_id TEXT,
      request_count INTEGER NOT NULL CHECK (request_count >= 0),
      input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
      output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
      cached_input_tokens INTEGER NOT NULL CHECK (cached_input_tokens >= 0),
      reasoning_output_tokens INTEGER NOT NULL CHECK (reasoning_output_tokens >= 0),
      total_tokens INTEGER NOT NULL CHECK (total_tokens >= 0),
      cumulative_input_tokens INTEGER,
      cumulative_output_tokens INTEGER,
      cumulative_cached_input_tokens INTEGER,
      cumulative_reasoning_output_tokens INTEGER,
      cumulative_total_tokens INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS usage_events_run ON usage_events(run_id, observed_at);
    CREATE INDEX IF NOT EXISTS usage_events_workspace ON usage_events(workspace_id, observed_at);
    CREATE INDEX IF NOT EXISTS usage_events_blueprint ON usage_events(blueprint_id, observed_at);
    CREATE INDEX IF NOT EXISTS usage_events_model ON usage_events(provider, model, observed_at);

    CREATE TABLE IF NOT EXISTS cost_estimates (
      usage_event_id TEXT PRIMARY KEY REFERENCES usage_events(id) ON DELETE CASCADE,
      catalog_version TEXT NOT NULL,
      currency TEXT NOT NULL,
      estimated_micros INTEGER NOT NULL CHECK (estimated_micros >= 0)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS provider_quota_events (
      id TEXT PRIMARY KEY,
      observed_at INTEGER NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('codex', 'spark')),
      limit_id TEXT NOT NULL,
      used_percent REAL NOT NULL CHECK (used_percent >= 0 AND used_percent <= 100),
      remaining_percent REAL NOT NULL CHECK (remaining_percent >= 0 AND remaining_percent <= 100),
      reset_at INTEGER,
      raw_json TEXT NOT NULL CHECK (json_valid(raw_json))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS provider_quota_latest
      ON provider_quota_events(provider, limit_id, observed_at DESC);

    CREATE TABLE IF NOT EXISTS budget_policies (
      scope_type TEXT NOT NULL CHECK (scope_type IN ('run', 'blueprint', 'workspace')),
      scope_id TEXT NOT NULL,
      soft_limit_json TEXT CHECK (soft_limit_json IS NULL OR json_valid(soft_limit_json)),
      hard_limit_json TEXT CHECK (hard_limit_json IS NULL OR json_valid(hard_limit_json)),
      exhaustion_policy TEXT NOT NULL CHECK (exhaustion_policy IN ('wait', 'pause', 'downgrade', 'fallback')),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(scope_type, scope_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS policies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      field TEXT NOT NULL CHECK (field IN ('session_class', 'model', 'reasoning_effort', 'workspace', 'time_of_day', 'max_concurrency', 'max_tokens_per_session')),
      operator TEXT NOT NULL CHECK (operator IN ('equals', 'not_equals', 'contains', 'less_than', 'less_than_or_equal', 'greater_than', 'greater_than_or_equal')),
      value_json TEXT NOT NULL CHECK (json_valid(value_json)),
      action TEXT NOT NULL CHECK (action IN ('allow', 'warn', 'block')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS policies_order ON policies(created_at, id);

    CREATE TABLE IF NOT EXISTS blueprint_versions (
      id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      created_at INTEGER NOT NULL,
      PRIMARY KEY(id, version)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS blueprint_versions_search
      ON blueprint_versions(name COLLATE NOCASE, id, version DESC);

    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      blueprint_id TEXT NOT NULL,
      blueprint_version INTEGER NOT NULL CHECK (blueprint_version > 0),
      variables_json TEXT NOT NULL CHECK (json_valid(variables_json) AND json_type(variables_json) = 'object'),
      workspace TEXT,
      timing_json TEXT NOT NULL CHECK (json_valid(timing_json) AND json_type(timing_json) = 'object'),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_run_at INTEGER,
      next_run_at INTEGER,
      FOREIGN KEY(blueprint_id, blueprint_version) REFERENCES blueprint_versions(id, version)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS schedules_due ON schedules(next_run_at, id);

    CREATE TABLE IF NOT EXISTS schedule_runs (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
      scheduled_at INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
      operation_id TEXT,
      thread_id TEXT,
      error TEXT,
      UNIQUE(schedule_id, scheduled_at)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS schedule_runs_history ON schedule_runs(schedule_id, scheduled_at DESC);
    CREATE INDEX IF NOT EXISTS schedule_runs_unfinished ON schedule_runs(status, scheduled_at);

    CREATE TABLE IF NOT EXISTS mission_versions (
      id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      created_at INTEGER NOT NULL,
      PRIMARY KEY(id, version)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS mission_versions_search
      ON mission_versions(name COLLATE NOCASE, id, version DESC);

    CREATE TABLE IF NOT EXISTS mission_runs (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      mission_version INTEGER NOT NULL CHECK (mission_version > 0),
      state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'completed', 'failed', 'paused')),
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY(mission_id, mission_version) REFERENCES mission_versions(id, version) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX IF NOT EXISTS mission_runs_history
      ON mission_runs(mission_id, mission_version, created_at DESC);
    CREATE INDEX IF NOT EXISTS mission_runs_unfinished
      ON mission_runs(state, created_at);

    CREATE TABLE IF NOT EXISTS eval_runs (
      id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
      payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(id, version)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS eval_runs_history ON eval_runs(created_at DESC, id, version DESC);
    CREATE INDEX IF NOT EXISTS eval_runs_unfinished ON eval_runs(status, updated_at);

    CREATE TABLE IF NOT EXISTS comparison_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'judging', 'completed', 'failed')),
      payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS comparison_runs_history ON comparison_runs(created_at DESC, id);
    CREATE INDEX IF NOT EXISTS comparison_runs_unfinished ON comparison_runs(status, updated_at);

    CREATE TABLE IF NOT EXISTS knowledge_packs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('global', 'workspace')),
      workspace TEXT,
      sources_json TEXT NOT NULL CHECK (json_valid(sources_json) AND json_type(sources_json) = 'array'),
      cached_content TEXT,
      content_hash TEXT,
      source_state_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_state_json) AND json_type(source_state_json) = 'array'),
      refresh_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      refreshed_at INTEGER,
      CHECK ((scope = 'global' AND workspace IS NULL) OR (scope = 'workspace' AND workspace IS NOT NULL)),
      CHECK ((cached_content IS NULL AND content_hash IS NULL) OR (cached_content IS NOT NULL AND content_hash IS NOT NULL)),
      UNIQUE(scope, workspace, name COLLATE NOCASE)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS knowledge_packs_scope ON knowledge_packs(scope, workspace, name COLLATE NOCASE);
    CREATE UNIQUE INDEX IF NOT EXISTS knowledge_packs_global_name
      ON knowledge_packs(name COLLATE NOCASE) WHERE scope = 'global';
    CREATE UNIQUE INDEX IF NOT EXISTS knowledge_packs_workspace_name
      ON knowledge_packs(workspace, name COLLATE NOCASE) WHERE scope = 'workspace';

    UPDATE store_state SET schema_version = ${STORE_SCHEMA_VERSION}
    WHERE singleton = 1 AND schema_version IN (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11);
    COMMIT;
  `);
}

function validateOpenDatabase(database: DatabaseSync): void {
  const result = database.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
  if (result?.quick_check !== "ok") throw new Error(`Transactional store failed validation: ${result?.quick_check || "no result"}`);
  const state = database.prepare("SELECT schema_version FROM store_state WHERE singleton = 1").get() as { schema_version: number } | undefined;
  if (!state || state.schema_version !== STORE_SCHEMA_VERSION) {
    throw new Error(`Unsupported transactional store schema ${state?.schema_version ?? "missing"}`);
  }
}

async function recoverDatabase(databaseFile: string, backupFile: string): Promise<StoreRecovery> {
  const primaryExists = await exists(databaseFile);
  const backupExists = await exists(backupFile);
  const primary = primaryExists ? inspectDatabase(databaseFile) : { valid: false, revision: -1 };
  const backup = backupExists ? inspectDatabase(backupFile) : { valid: false, revision: -1 };
  const preservedCorruptFiles: string[] = [];

  if (primaryExists && !primary.valid) preservedCorruptFiles.push(...await preserveCorruptDatabase(databaseFile));
  if (backupExists && !backup.valid) preservedCorruptFiles.push(...await preserveCorruptDatabase(backupFile));

  if (backup.valid && (!primary.valid || backup.revision > primary.revision)) {
    if (primary.valid) preservedCorruptFiles.push(...await preserveCorruptDatabase(databaseFile, "superseded"));
    await restoreDatabase(backupFile, databaseFile);
    return {
      source: "backup",
      primaryRevision: Math.max(0, primary.revision),
      backupRevision: backup.revision,
      preservedCorruptFiles
    };
  }

  return {
    source: primary.valid ? "primary" : "empty",
    primaryRevision: Math.max(0, primary.revision),
    backupRevision: Math.max(0, backup.revision),
    preservedCorruptFiles
  };
}

function inspectDatabase(file: string): DatabaseInspection {
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(file, { readOnly: true });
    const result = database.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    if (result?.quick_check !== "ok") return { valid: false, revision: -1 };
    const table = database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'store_state'").get();
    if (!table) return { valid: true, revision: 0 };
    const state = database.prepare("SELECT revision FROM store_state WHERE singleton = 1").get() as { revision?: number } | undefined;
    return { valid: Number.isInteger(state?.revision) && (state?.revision ?? -1) >= 0, revision: state?.revision ?? -1 };
  } catch {
    return { valid: false, revision: -1 };
  } finally {
    try { database?.close(); } catch { /* inspection already failed */ }
  }
}

async function preserveCorruptDatabase(file: string, label = "corrupt"): Promise<string[]> {
  const suffix = `.${label}-${Date.now()}`;
  const preserved: string[] = [];
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    if (!await exists(candidate)) continue;
    const destination = `${candidate}${suffix}`;
    await fs.rename(candidate, destination);
    preserved.push(destination);
  }
  return preserved;
}

async function restoreDatabase(source: string, destination: string): Promise<void> {
  const temporary = `${destination}.${process.pid}.${Date.now()}.restore.tmp`;
  await fs.copyFile(source, temporary);
  const handle = await fs.open(temporary, "r+");
  try {
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, destination);
  await syncDirectory(path.dirname(destination));
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function removeDatabaseSidecars(file: string): Promise<void> {
  await Promise.all([
    fs.rm(`${file}-wal`, { force: true }),
    fs.rm(`${file}-shm`, { force: true })
  ]);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function validateMetadataRow(row: MetadataStoreRow): void {
  if (!row.threadId) throw new Error("Metadata thread ID must not be empty");
  validateJson(row.payload, "Metadata payload");
  assertFiniteNonNegative(row.createdAt, "Metadata creation timestamp");
  assertFiniteNonNegative(row.updatedAt, "Metadata update timestamp");
}

function validateCanonicalItemRow(row: CanonicalItemStoreRow): void {
  if (!row.threadId || !row.itemId) throw new Error("Canonical item identity fields must not be empty");
  validateJson(row.payload, "Canonical item payload");
  assertFiniteNonNegative(row.updatedAt, "Canonical item update timestamp");
}

function validateArtifactRow(row: ArtifactStoreRow): void {
  if (!row.id || !row.sessionId || !row.name || !row.producerSession) {
    throw new Error("Artifact identity fields must not be empty");
  }
  if (!(["FileArtifact", "PatchArtifact", "TestResultArtifact", "CommandArtifact", "ReviewVerdictArtifact"] as const).includes(row.type)) {
    throw new Error("Artifact type is invalid");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(row.contentHash)) throw new Error("Artifact content hash is invalid");
  assertPositiveInteger(row.version, "Artifact version");
  validateJson(row.schemaJson, "Artifact schema");
  validateJson(row.producerJson, "Artifact producer");
  validateJson(row.provenanceJson, "Artifact provenance");
  validateJson(row.retentionJson, "Artifact retention");
  validateJson(row.validationJson, "Artifact validation");
  if (row.contentJson !== null) validateJson(row.contentJson, "Artifact content");
  if (row.referenceJson !== null) validateJson(row.referenceJson, "Artifact reference");
  assertFiniteNonNegative(row.createdAt, "Artifact creation timestamp");
  assertFiniteNonNegative(row.updatedAt, "Artifact update timestamp");
}

function validateKnowledgePackRow(row: KnowledgePackStoreRow): void {
  if (!row.id || !row.name) throw new Error("Knowledge pack identity fields must not be empty");
  if (row.scope !== "global" && row.scope !== "workspace") throw new Error("Knowledge pack scope is invalid");
  if ((row.scope === "global" && row.workspace !== null) || (row.scope === "workspace" && !row.workspace)) {
    throw new Error("Knowledge pack workspace does not match its scope");
  }
  validateJson(row.sourcesJson, "Knowledge pack sources");
  validateJson(row.sourceStateJson, "Knowledge pack source state");
  if ((row.cachedContent === null) !== (row.contentHash === null)) throw new Error("Knowledge pack cache content and hash must be stored together");
  assertFiniteNonNegative(row.createdAt, "Knowledge pack creation timestamp");
  assertFiniteNonNegative(row.updatedAt, "Knowledge pack update timestamp");
  if (row.refreshedAt !== null) assertFiniteNonNegative(row.refreshedAt, "Knowledge pack refresh timestamp");
}

function validateAuditRow(row: AuditStoreRow): void {
  if (!row.id || !row.threadId || !row.action || !row.actor) throw new Error("Audit event identity fields must not be empty");
  assertFiniteNonNegative(row.at, "Audit event timestamp");
  assertPositiveInteger(row.byteSize, "Audit event size");
  if (row.detailsJson !== null) validateJson(row.detailsJson, "Audit details");
}

function validateSessionEventRow(row: SessionEventStoreRow): void {
  if (!row.id || !row.threadId || !row.type || !row.summary) throw new Error("Timeline event identity fields must not be empty");
  if (!Number.isSafeInteger(row.revision) || row.revision < 0) throw new Error("Timeline event revision must be a non-negative safe integer");
  assertFiniteNonNegative(row.at, "Timeline event timestamp");
  validateJson(row.payloadJson, "Timeline event payload summary");
  if (row.durationMs !== null) assertFiniteNonNegative(row.durationMs, "Timeline event duration");
}

function validateSessionOperationRow(row: SessionOperationStoreRow): void {
  if (!row.id || !row.idempotencyKey || !row.requestFingerprint || !row.step) {
    throw new Error("Session operation identity fields must not be empty");
  }
  if (!( ["create", "archive"] as const).includes(row.kind)) throw new Error("Session operation kind is invalid");
  if (!( ["pending", "running", "compensating", "retrying", "succeeded", "failed"] as const).includes(row.status)) {
    throw new Error("Session operation status is invalid");
  }
  assertNonNegativeInteger(row.attempts, "Session operation attempts");
  validateJson(row.inputJson, "Session operation input");
  validateJson(row.compensationJson, "Session operation compensation");
  if (row.resultJson !== null) validateJson(row.resultJson, "Session operation result");
  if (row.errorJson !== null) validateJson(row.errorJson, "Session operation error");
  assertFiniteNonNegative(row.createdAt, "Session operation creation timestamp");
  assertFiniteNonNegative(row.updatedAt, "Session operation update timestamp");
  if (row.nextAttemptAt !== null) assertFiniteNonNegative(row.nextAttemptAt, "Session operation retry timestamp");
  if (row.completedAt !== null) assertFiniteNonNegative(row.completedAt, "Session operation completion timestamp");
}

function validateUsageEventRow(row: UsageEventStoreRow): void {
  if (!row.id || !row.model || !row.runId) throw new Error("Usage event identity fields must not be empty");
  if (!(["codex", "spark"] as const).includes(row.provider)) throw new Error("Usage provider is invalid");
  assertFiniteNonNegative(row.observedAt, "Usage observation timestamp");
  for (const [label, value] of Object.entries({
    requestCount: row.requestCount,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cachedInputTokens: row.cachedInputTokens,
    reasoningOutputTokens: row.reasoningOutputTokens,
    totalTokens: row.totalTokens
  })) assertNonNegativeInteger(value, `Usage ${label}`);
  for (const [label, value] of Object.entries({
    cumulativeInputTokens: row.cumulativeInputTokens,
    cumulativeOutputTokens: row.cumulativeOutputTokens,
    cumulativeCachedInputTokens: row.cumulativeCachedInputTokens,
    cumulativeReasoningOutputTokens: row.cumulativeReasoningOutputTokens,
    cumulativeTotalTokens: row.cumulativeTotalTokens
  })) if (value !== null) assertNonNegativeInteger(value, `Usage ${label}`);
}

function validateCostEstimateRow(row: CostEstimateStoreRow): void {
  if (!row.usageEventId || !row.catalogVersion || !/^[A-Z]{3}$/.test(row.currency)) {
    throw new Error("Cost estimate identity fields are invalid");
  }
  assertNonNegativeInteger(row.estimatedMicros, "Estimated cost");
}

function validateQuotaEventRow(row: QuotaEventStoreRow): void {
  if (!row.id || !row.limitId) throw new Error("Quota event identity fields must not be empty");
  if (!(["codex", "spark"] as const).includes(row.provider)) throw new Error("Quota provider is invalid");
  assertFiniteNonNegative(row.observedAt, "Quota observation timestamp");
  for (const [label, value] of [["used", row.usedPercent], ["remaining", row.remainingPercent]] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error(`Quota ${label} percentage must be between zero and 100`);
  }
  if (row.resetAt !== null) assertFiniteNonNegative(row.resetAt, "Quota reset timestamp");
  validateJson(row.rawJson, "Quota raw facts");
}

function validateBudgetPolicyRow(row: BudgetPolicyStoreRow): void {
  if (!row.scopeId) throw new Error("Budget scope ID must not be empty");
  if (!(["run", "blueprint", "workspace"] as const).includes(row.scopeType)) throw new Error("Budget scope is invalid");
  if (!(["wait", "pause", "downgrade", "fallback"] as const).includes(row.exhaustionPolicy)) throw new Error("Budget exhaustion policy is invalid");
  if (row.softLimitJson !== null) validateJson(row.softLimitJson, "Soft budget limit");
  if (row.hardLimitJson !== null) validateJson(row.hardLimitJson, "Hard budget limit");
  assertFiniteNonNegative(row.updatedAt, "Budget update timestamp");
}

function validatePolicyRow(row: PolicyStoreRow): void {
  if (!row.id || !row.name) throw new Error("Policy identity fields must not be empty");
  if (!( ["session_class", "model", "reasoning_effort", "workspace", "time_of_day", "max_concurrency", "max_tokens_per_session"] as const).includes(row.field)) {
    throw new Error("Policy field is invalid");
  }
  if (!( ["equals", "not_equals", "contains", "less_than", "less_than_or_equal", "greater_than", "greater_than_or_equal"] as const).includes(row.operator)) {
    throw new Error("Policy operator is invalid");
  }
  if (!( ["allow", "warn", "block"] as const).includes(row.action)) throw new Error("Policy action is invalid");
  validateJson(row.valueJson, "Policy condition value");
  assertFiniteNonNegative(row.createdAt, "Policy creation timestamp");
  assertFiniteNonNegative(row.updatedAt, "Policy update timestamp");
}

function validateBlueprintVersionRow(row: BlueprintVersionStoreRow): void {
  if (!row.id || !row.name) throw new Error("Blueprint identity fields must not be empty");
  assertPositiveInteger(row.version, "Blueprint version");
  validateJson(row.payload, "Blueprint payload");
  assertFiniteNonNegative(row.createdAt, "Blueprint creation timestamp");
}

function validateScheduleRow(row: ScheduleStoreRow): void {
  if (!row.id || !row.name || !row.blueprintId) throw new Error("Schedule identity fields must not be empty");
  assertPositiveInteger(row.blueprintVersion, "Schedule blueprint version");
  validateJson(row.variablesJson, "Schedule variables");
  validateJson(row.timingJson, "Schedule timing");
  assertFiniteNonNegative(row.createdAt, "Schedule creation timestamp");
  assertFiniteNonNegative(row.updatedAt, "Schedule update timestamp");
  if (row.lastRunAt !== null) assertFiniteNonNegative(row.lastRunAt, "Schedule last run timestamp");
  if (row.nextRunAt !== null) assertFiniteNonNegative(row.nextRunAt, "Schedule next run timestamp");
}

function validateScheduleRunRow(row: ScheduleRunStoreRow): void {
  if (!row.id || !row.scheduleId) throw new Error("Schedule run identity fields must not be empty");
  if (!( ["pending", "running", "succeeded", "failed"] as const).includes(row.status)) {
    throw new Error("Schedule run status is invalid");
  }
  assertFiniteNonNegative(row.scheduledAt, "Scheduled run timestamp");
  assertFiniteNonNegative(row.startedAt, "Schedule run start timestamp");
  if (row.completedAt !== null) assertFiniteNonNegative(row.completedAt, "Schedule run completion timestamp");
}

function validateMissionVersionRow(row: MissionVersionStoreRow): void {
  if (!row.id || !row.name) throw new Error("Mission identity fields must not be empty");
  assertPositiveInteger(row.version, "Mission version");
  validateJson(row.payload, "Mission payload");
  assertFiniteNonNegative(row.createdAt, "Mission creation timestamp");
}

function validateMissionRunRow(row: MissionRunStoreRow): void {
  if (!row.id || !row.missionId) throw new Error("Mission run identity fields must not be empty");
  assertPositiveInteger(row.missionVersion, "Mission run version");
  if (!( ["pending", "running", "completed", "failed", "paused"] as const).includes(row.state)) {
    throw new Error("Mission state is invalid");
  }
  validateJson(row.payload, "Mission run payload");
  assertFiniteNonNegative(row.createdAt, "Mission run creation timestamp");
  assertFiniteNonNegative(row.updatedAt, "Mission run update timestamp");
  if (row.completedAt !== null) assertFiniteNonNegative(row.completedAt, "Mission run completion timestamp");
}

function validateEvalRunRow(row: EvalRunStoreRow): void {
  if (!row.id) throw new Error("Eval run ID must not be empty");
  assertPositiveInteger(row.version, "Eval version");
  if (!( ["queued", "running", "completed", "failed"] as const).includes(row.status)) {
    throw new Error("Eval run status is invalid");
  }
  validateJson(row.payload, "Eval run payload");
  assertFiniteNonNegative(row.createdAt, "Eval creation timestamp");
  assertFiniteNonNegative(row.updatedAt, "Eval update timestamp");
}

function validateComparisonRunRow(row: ComparisonRunStoreRow): void {
  if (!row.id) throw new Error("Comparison run ID must not be empty");
  if (!( ["queued", "running", "judging", "completed", "failed"] as const).includes(row.status)) {
    throw new Error("Comparison run status is invalid");
  }
  validateJson(row.payload, "Comparison run payload");
  assertFiniteNonNegative(row.createdAt, "Comparison creation timestamp");
  assertFiniteNonNegative(row.updatedAt, "Comparison update timestamp");
}

function scopeColumn(scopeType: BudgetScopeType): "run_id" | "blueprint_id" | "workspace_id" {
  if (scopeType === "run") return "run_id";
  if (scopeType === "blueprint") return "blueprint_id";
  return "workspace_id";
}

function validateJson(value: string, label: string): void {
  try { JSON.parse(value); } catch (error) { throw new Error(`${label} must be valid JSON`, { cause: error }); }
}

function changeCount(result: StatementResultingChanges): number {
  return Number(result.changes);
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be non-negative`);
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative safe integer`);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer`);
}

function positiveDuration(value: number | undefined, fallback: number, label: string): number {
  const duration = value ?? fallback;
  if (!Number.isFinite(duration) || duration <= 0) throw new RangeError(`${label} must be positive`);
  return duration;
}

function clampRetry(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return maximum;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}
