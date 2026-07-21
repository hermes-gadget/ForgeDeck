import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { QueueDrainScheduler, TransactionalStore } from "./store.js";

test("schema version one stores migrate in place before usage, budget, and blueprint writes", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-store-migration-"));
  const databaseFile = path.join(dataDir, "session-store.sqlite");
  const legacy = new DatabaseSync(databaseFile);
  legacy.exec(`
    CREATE TABLE store_state (
      singleton INTEGER PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      backup_revision INTEGER NOT NULL DEFAULT 0,
      legacy_migrated INTEGER NOT NULL DEFAULT 0,
      audit_bytes INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    INSERT INTO store_state(singleton, schema_version) VALUES (1, 1);
  `);
  legacy.close();

  const store = await TransactionalStore.open(dataDir, 10_000);
  try {
    store.upsertBudgetPolicy({
      scopeType: "run",
      scopeId: "migrated-run",
      softLimitJson: JSON.stringify({ requestCount: 1 }),
      hardLimitJson: JSON.stringify({ requestCount: 2 }),
      exhaustionPolicy: "pause",
      updatedAt: 1
    });
    assert.equal(store.listBudgetPolicies("run", "migrated-run").length, 1);
    store.insertBlueprintVersion({
      id: "migrated-blueprint",
      version: 1,
      name: "Migrated blueprint",
      description: "",
      payload: JSON.stringify({ schemaVersion: 1 }),
      createdAt: 1
    });
    assert.equal(store.latestBlueprintVersion("migrated-blueprint")?.version, 1);
  } finally {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("schema version three stores migrate in place before durable session operations", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-operation-migration-"));
  const databaseFile = path.join(dataDir, "session-store.sqlite");
  const legacy = new DatabaseSync(databaseFile);
  legacy.exec(`
    CREATE TABLE store_state (
      singleton INTEGER PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      backup_revision INTEGER NOT NULL DEFAULT 0,
      legacy_migrated INTEGER NOT NULL DEFAULT 0,
      audit_bytes INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    INSERT INTO store_state(singleton, schema_version) VALUES (1, 3);
  `);
  legacy.close();

  const store = await TransactionalStore.open(dataDir, 10_000);
  try {
    const inserted = store.insertSessionOperation({
      id: "11111111-1111-4111-8111-111111111111",
      kind: "archive",
      idempotencyKey: "archive-thread-one",
      requestFingerprint: "fingerprint",
      status: "pending",
      step: "queued",
      remoteThreadId: "thread-one",
      attempts: 0,
      inputJson: JSON.stringify({ threadId: "thread-one" }),
      compensationJson: JSON.stringify({ remoteArchive: "pending" }),
      resultJson: null,
      errorJson: null,
      nextAttemptAt: null,
      createdAt: 10,
      updatedAt: 10,
      completedAt: null
    });
    assert.equal(inserted.created, true);
    assert.equal(store.listIncompleteSessionOperations()[0]?.remoteThreadId, "thread-one");
  } finally {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("durable queues preserve delivery state and recover interrupted claims after reopen", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-queue-store-"));
  let store = await TransactionalStore.open(dataDir, 10_000);
  try {
    store.enqueue({ threadId: "thread-queue", id: "queue-1", payload: JSON.stringify({ text: "first" }), createdAt: 10 });
    store.enqueue({ threadId: "thread-queue", id: "queue-2", payload: JSON.stringify({ text: "second" }), createdAt: 20 });

    const first = store.claimQueueHead("thread-queue", 100);
    assert.equal(first?.id, "queue-1");
    assert.equal(first?.attempts, 1);
    assert.equal(store.retryQueueItem("queue-1", "adapter unavailable", 300), true);
    const second = store.claimQueueHead("thread-queue", 200);
    assert.equal(second?.id, "queue-2");
    store.close();

    store = await TransactionalStore.open(dataDir, 10_000);
    assert.deepEqual(store.listQueue("thread-queue").map(({ id, state, attempts }) => ({ id, state, attempts })), [
      { id: "queue-1", state: "retrying", attempts: 1 },
      { id: "queue-2", state: "starting", attempts: 1 }
    ]);
    assert.equal(store.recoverQueueClaims(250, 400), 1);
    assert.equal(store.claimQueueHead("thread-queue", 400)?.id, "queue-1");
    assert.equal(store.completeQueueItem("queue-1"), true);
    assert.equal(store.claimQueueHead("thread-queue", 400)?.id, "queue-2");
    assert.equal(store.completeQueueItem("queue-2"), true);
    assert.deepEqual(store.listQueue("thread-queue"), []);
  } finally {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("run guardian state survives store reopen for active-run recovery", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-guardian-store-"));
  let store = await TransactionalStore.open(dataDir, 10_000);
  try {
    store.upsertRunGuardian({
      threadId: "thread-guardian",
      payload: JSON.stringify({ threadId: "thread-guardian", phase: "retrying", recoveryAttempts: 1 }),
      updatedAt: 100
    });
    store.close();
    store = await TransactionalStore.open(dataDir, 10_000);
    assert.deepEqual(store.listRunGuardians().map((row) => JSON.parse(row.payload)), [
      { threadId: "thread-guardian", phase: "retrying", recoveryAttempts: 1 }
    ]);
    assert.equal(store.removeRunGuardian("thread-guardian"), true);
    assert.equal(store.getRunGuardian("thread-guardian"), null);
  } finally {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("canonical item history remains durable and separate from transient session metadata", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-canonical-history-"));
  let store = await TransactionalStore.open(dataDir, 10_000);
  try {
    store.upsertMetadata(metadataRow("thread-history", 1));
    store.upsertCanonicalItem({
      threadId: "thread-history",
      itemId: "item-1",
      payload: JSON.stringify({ id: "item-1", type: "commandExecution", aggregatedOutput: "complete output" }),
      updatedAt: 10
    });
    assert.equal(store.removeMetadata("thread-history"), true);
    store.close();

    store = await TransactionalStore.open(dataDir, 10_000);
    assert.equal(store.getMetadata("thread-history"), null);
    assert.deepEqual(store.listCanonicalItems("thread-history").map((row) => JSON.parse(row.payload)), [
      { id: "item-1", type: "commandExecution", aggregatedOutput: "complete output" }
    ]);
    assert.equal(store.purgeCanonicalItemsBefore(11, 10), 1);
    assert.deepEqual(store.listCanonicalItems("thread-history"), []);
  } finally {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("queue drain scheduling retains a wake-up that arrives during an active drain", async () => {
  let releaseFirst!: () => void;
  const firstDrain = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const scheduler = new QueueDrainScheduler(async () => {
    calls += 1;
    if (calls === 1) await firstDrain;
  }, { minimumRetryMs: 5, maximumRetryMs: 20 });

  try {
    scheduler.request("thread-queue");
    await waitUntil(() => calls === 1);
    scheduler.request("thread-queue");
    releaseFirst();
    await waitUntil(() => calls === 2 && !scheduler.hasPendingWake("thread-queue"));
    assert.equal(calls, 2);
  } finally {
    scheduler.close();
  }
});

test("archive cleanup state recovers from the last validated backup when the primary store is corrupt", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-archive-recovery-"));
  let store = await TransactionalStore.open(dataDir, 10_000);
  const archivedThreadId = "thread-archived";
  const survivingThreadId = "thread-surviving";
  try {
    store.upsertMetadata(metadataRow(archivedThreadId, 1));
    store.upsertMetadata(metadataRow(survivingThreadId, 2));
    assert.equal(store.removeMetadata(archivedThreadId), true);
    const archivedRevision = await store.checkpoint();
    const databaseFile = store.databaseFile;
    store.close();

    await fs.writeFile(databaseFile, "not a sqlite database");
    store = await TransactionalStore.open(dataDir, 10_000);
    assert.equal(store.recovery.source, "backup");
    assert.equal(store.revision, archivedRevision);
    assert.equal(store.getMetadata(archivedThreadId), null);
    assert.equal(store.getMetadata(survivingThreadId)?.threadId, survivingThreadId);
    assert.equal(store.recovery.preservedCorruptFiles.some((file) => file.includes(".corrupt-")), true);
  } finally {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("retention maintenance deletes metadata and audit rows in bounded chunks", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-store-maintenance-"));
  const store = await TransactionalStore.open(dataDir, 10_000);
  try {
    for (let index = 1; index <= 5; index += 1) {
      store.upsertMetadata(metadataRow(`thread-${index}`, index));
      store.appendAudit({
        id: `audit-${index}`,
        threadId: `thread-${index}`,
        action: "test",
        at: index,
        actor: "test",
        detailsJson: null,
        byteSize: 10
      }, null, 1_000);
    }

    assert.equal(store.purgeMetadataBefore(10, 2).length, 2);
    assert.equal(store.listMetadata().length, 3);
    assert.equal(store.purgeMetadataBefore(10, 2).length, 2);
    assert.equal(store.purgeMetadataBefore(10, 2).length, 1);
    assert.equal(store.listMetadata().length, 0);

    assert.equal(store.compactAudit(10, 1_000, 2), 2);
    assert.equal(store.compactAudit(10, 1_000, 2), 2);
    assert.equal(store.compactAudit(10, 1_000, 2), 1);
    assert.deepEqual(store.history("thread-1", 10), []);
  } finally {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

function metadataRow(threadId: string, updatedAt: number) {
  return { threadId, payload: JSON.stringify({ threadId, updatedAt }), createdAt: 1, updatedAt };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for queue drain state");
}
