import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_SESSION_TTL_MS,
  SessionManager,
  SessionOperationConflictError,
  WorkspaceLeaseConflictError,
  deriveSessionName,
  isSessionExpired,
  normalizeTags
} from "./session-manager.js";

test("session names are derived from the first meaningful prompt line", () => {
  assert.equal(deriveSessionName("\n  ## Fix checkout races\nMore context"), "Fix checkout races");
  assert.equal(deriveSessionName(""), "New session");
  assert.ok(deriveSessionName("x".repeat(140)).length <= 100);
});

test("TTL handles Codex second timestamps and excludes active sessions", () => {
  const now = Date.UTC(2026, 6, 13);
  const expired = { id: "thread-old", updatedAt: (now - DEFAULT_SESSION_TTL_MS - 1) / 1_000, status: { type: "idle" } };
  assert.equal(isSessionExpired(expired, new Set(), DEFAULT_SESSION_TTL_MS, now), true);
  assert.equal(isSessionExpired(expired, new Set(["thread-old"]), DEFAULT_SESSION_TTL_MS, now), false);
  assert.equal(isSessionExpired({ ...expired, status: { type: "active" } }, new Set(), DEFAULT_SESSION_TTL_MS, now), false);
  assert.equal(isSessionExpired({ ...expired, pinned: true }, new Set(), DEFAULT_SESSION_TTL_MS, now), false);
  assert.equal(isSessionExpired({ ...expired, archiveState: "archived" }, new Set(), DEFAULT_SESSION_TTL_MS, now), false);
});

test("archive lifecycle preserves metadata, restore is reversible, and pins exempt retention", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-archive-lifecycle-"));
  let manager = await SessionManager.create(directory, () => 1_000, { metadataRetentionMs: 100 });
  try {
    await manager.setMetadata("thread-archive", { name: "Important work", model: "gpt-test" });
    const archived = await manager.markArchived("thread-archive", "ttl", "system");
    assert.equal(archived.archiveState, "archived");
    assert.equal(archived.archiveReason, "ttl");
    assert.equal(archived.name, "Important work");
    await manager.setPinned("thread-archive", true);
    manager.close();

    manager = await SessionManager.create(directory, () => 5_000, { metadataRetentionMs: 100 });
    assert.equal(manager.hasMetadata("thread-archive"), true);
    assert.equal(manager.metadataFor("thread-archive").pinned, true);
    const restored = await manager.markRestored("thread-archive");
    assert.equal(restored.archiveState, "active");
    assert.equal(restored.archivedAt, null);
    assert.equal(restored.archiveReason, null);
    assert.equal(restored.name, "Important work");

    await manager.markArchived("thread-archive", "manual", "user");
    await manager.setPinned("thread-archive", false);
    manager.close();
    manager = await SessionManager.create(directory, () => 10_000, { metadataRetentionMs: 100 });
    assert.equal(manager.hasMetadata("thread-archive"), false);
  } finally {
    manager.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("session operations are serialized by thread but independent across threads", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-sessions-"));
  const manager = await SessionManager.create(directory);
  const order: string[] = [];
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  try {
    const first = manager.withSession("one", async () => { order.push("one:start"); await gate; order.push("one:end"); });
    const second = manager.withSession("one", () => { order.push("one:second"); });
    const other = manager.withSession("two", () => { order.push("two"); });
    await other;
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["one:start", "two", "one:end", "one:second"]);
  } finally {
    manager.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("workspace leases allow shared inspection, reject conflicting writers, and release on archive", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-workspace-leases-"));
  const workspace = path.join(directory, "workspace");
  const nestedWorkspace = path.join(workspace, "packages", "app");
  fs.mkdirSync(nestedWorkspace, { recursive: true });
  let now = 1_000;
  const manager = await SessionManager.create(directory, () => now++);
  try {
    await manager.setMetadata("reader-session-1", { cwd: workspace, workspaceLeaseMode: "read-only" });
    await manager.setMetadata("reader-session-2", { cwd: workspace, workspaceLeaseMode: "read-only" });
    await manager.setMetadata("writer-session-1", { cwd: workspace });
    await manager.setMetadata("nested-writer-1", { cwd: nestedWorkspace });

    const first = manager.acquireWorkspaceLease("reader-session-1");
    const second = manager.acquireWorkspaceLease("reader-session-2");
    assert.equal(first.mode, "read-only");
    assert.equal(second.mode, "read-only");
    assert.deepEqual(manager.workspaceLeaseStatus(workspace), {
      root: workspace,
      state: "read-only",
      leases: [first, second]
    });
    assert.throws(
      () => manager.acquireWorkspaceLease("writer-session-1"),
      (error: unknown) => error instanceof WorkspaceLeaseConflictError
        && error.code === "WORKSPACE_LEASE_CONFLICT"
        && error.conflicts.length === 2
    );
    assert.throws(() => manager.acquireWorkspaceLease("nested-writer-1"), WorkspaceLeaseConflictError);

    assert.equal(manager.releaseWorkspaceLease("reader-session-1")?.sessionId, "reader-session-1");
    manager.releaseWorkspaceLease("reader-session-2");
    const writer = manager.acquireWorkspaceLease("writer-session-1");
    assert.equal(writer.mode, "exclusive");
    assert.equal(manager.enrich({ id: "writer-session-1" }).workspaceLease?.sessionId, "writer-session-1");

    await manager.markArchived("writer-session-1", "manual");
    assert.equal(manager.workspaceLeaseForSession("writer-session-1"), null);
    assert.equal(manager.workspaceLeaseStatus(workspace).state, "available");
  } finally {
    manager.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("workspace leases allow non-overlapping declared file scopes in the same cwd", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-file-leases-"));
  const workspace = path.join(directory, "workspace");
  fs.mkdirSync(workspace);
  const manager = await SessionManager.create(directory);
  try {
    await manager.setMetadata("server-writer", { cwd: workspace, workspaceFileScope: ["server.py"] });
    await manager.setMetadata("html-writer", { cwd: workspace, workspaceFileScope: ["index.html"] });

    assert.deepEqual(manager.acquireWorkspaceLease("server-writer").fileScope, ["server.py"]);
    assert.deepEqual(manager.acquireWorkspaceLease("html-writer").fileScope, ["index.html"]);
    assert.equal(manager.workspaceLeaseStatus(workspace).leases.length, 2);
  } finally {
    manager.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("workspace leases reject overlapping declared file scopes in the same cwd", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-file-lease-conflict-"));
  const workspace = path.join(directory, "workspace");
  fs.mkdirSync(workspace);
  const manager = await SessionManager.create(directory);
  try {
    await manager.setMetadata("first-writer", { cwd: workspace, workspaceFileScope: ["src/server.py"] });
    await manager.setMetadata("second-writer", { cwd: workspace, workspaceFileScope: ["src/server.py"] });
    manager.acquireWorkspaceLease("first-writer");

    assert.throws(
      () => manager.acquireWorkspaceLease("second-writer"),
      (error: unknown) => error instanceof WorkspaceLeaseConflictError
        && error.conflicts[0]?.fileScope?.[0] === "src/server.py"
    );
  } finally {
    manager.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("workspace leases preserve whole-directory conflicts when no file scope is declared", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-directory-lease-conflict-"));
  const workspace = path.join(directory, "workspace");
  fs.mkdirSync(workspace);
  const manager = await SessionManager.create(directory);
  try {
    await manager.setMetadata("legacy-writer", { cwd: workspace });
    await manager.setMetadata("scoped-writer", { cwd: workspace, workspaceFileScope: ["index.html"] });
    manager.acquireWorkspaceLease("legacy-writer");

    assert.throws(() => manager.acquireWorkspaceLease("scoped-writer"), WorkspaceLeaseConflictError);
  } finally {
    manager.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("session workflow operations are durable and idempotent across reopen", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-operations-"));
  let now = 1_000;
  let manager = await SessionManager.create(directory, () => now++);
  try {
    const first = await manager.createSessionOperation("create", "create-request-1", { cwd: "/workspace", model: "test-model" });
    assert.equal(first.created, true);
    assert.equal(first.operation.status, "pending");
    assert.equal(first.operation.attemptCount, 0);

    const duplicate = await manager.createSessionOperation("create", "create-request-1", { model: "test-model", cwd: "/workspace" });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.operation.id, first.operation.id);

    await assert.rejects(
      manager.createSessionOperation("create", "create-request-1", { cwd: "/different", model: "test-model" }),
      SessionOperationConflictError
    );

    await manager.updateSessionOperation(first.operation.id, {
      status: "retrying",
      step: "discovering_remote",
      remoteThreadId: "thread-durable",
      attemptCount: 2,
      compensation: { remoteMutation: "indeterminate", remoteCleanup: "pending" },
      nextAttemptAt: 5_000
    });
    manager.close();

    manager = await SessionManager.create(directory, () => now++);
    const recovered = manager.incompleteSessionOperations();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].id, first.operation.id);
    assert.equal(recovered[0].remoteThreadId, "thread-durable");
    assert.equal(recovered[0].attemptCount, 2);
    assert.deepEqual(recovered[0].compensation, { remoteCleanup: "pending", remoteMutation: "indeterminate" });
    assert.equal(manager.incompleteSessionOperationFor("create", "thread-durable")?.id, first.operation.id);

    const completed = await manager.updateSessionOperation(first.operation.id, {
      status: "succeeded",
      step: "completed",
      result: { threadId: "thread-durable" },
      nextAttemptAt: null
    });
    assert.equal(completed.completedAt !== null, true);
    assert.deepEqual(completed.result, { threadId: "thread-durable" });
    assert.deepEqual(manager.incompleteSessionOperations(), []);
  } finally {
    manager.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("metadata is normalized, persisted, and retained in audit history", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-sessions-"));
  let now = 1_000;
  try {
    const manager = await SessionManager.create(directory, () => now++);
    const metadata = await manager.setMetadata("thread-123", { tags: ["Bug", "bug", " Release "], category: " Work " });
    assert.deepEqual(metadata.tags, ["Bug", "Release"]);
    assert.equal(metadata.category, "Work");
    await manager.record("thread-123", "created", "user");

    const restored = await SessionManager.create(directory, () => now++);
    assert.deepEqual(restored.metadataFor("thread-123").tags, ["Bug", "Release"]);
    assert.deepEqual((await restored.history("thread-123")).map((event) => event.action), ["organized", "created"]);
    manager.close();
    restored.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid and excessive tags are rejected", () => {
  assert.throws(() => normalizeTags("bug"), /array/);
  assert.throws(() => normalizeTags(Array.from({ length: 11 }, (_, index) => `tag-${index}`)), /at most 10/);
});

test("session creation settings persist, enrich, and filter", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-sessions-"));
  try {
    const manager = await SessionManager.create(directory, () => 10_000);
    await manager.setMetadata("spark-thread", { sessionClass: "spark", backend: "codex", model: "gpt-5.3-codex-spark" });
    await manager.setMetadata("codex-thread", {
      sessionClass: "standard",
      backend: "codex",
      model: "gpt-5.3-codex",
      effort: "xhigh"
    });
    const restored = await SessionManager.create(directory, () => 20_000);
    const artifactStatus = {
      status: "not-configured" as const,
      artifactCount: 0,
      validArtifactCount: 0,
      requiredGateCount: 0,
      metGateCount: 0,
      unmetGates: []
    };
    assert.deepEqual(restored.listAllSessions("spark").map((session) => session.id), ["spark-thread"]);
    assert.equal(restored.enrich({ id: "spark-thread" }).sessionClass, "spark");
    assert.deepEqual(restored.enrich({ id: "codex-thread" }), {
      id: "codex-thread",
      tags: [],
      category: null,
      sessionClass: "standard",
      backend: "codex",
      provider: "codex",
      artifactStatus,
      policyWarnings: [],
      workspaceLeaseMode: "exclusive",
      workspaceLease: null,
      model: "gpt-5.3-codex",
      reasoningEffort: "xhigh",
      effort: "xhigh"
    });
    assert.equal(restored.enrich({ id: "untracked", model: "gpt-5.3-codex-spark" }).sessionClass, "spark");
    const providerOrigin = restored.enrich({
      id: "codex-thread",
      source: "cli",
      gitInfo: { branch: null, repositoryUrl: null, remote: "origin" }
    });
    assert.equal(Object.hasOwn(providerOrigin, "source"), false);
    assert.deepEqual(providerOrigin.gitInfo, { remote: "origin" });
    manager.close();
    restored.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("blueprint runs retain their resolved immutable version, environment, and model configuration", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-blueprint-run-"));
  try {
    const manager = await SessionManager.create(directory, () => 30_000);
    await manager.setMetadata("blueprint-thread", {
      backend: "codex",
      preset: "quick",
      model: "gpt-5.6-luna",
      effort: "low",
      blueprintId: "release-agent",
      blueprintVersion: 3,
      blueprintEnvironment: "staging",
      blueprintModelConfiguration: { backend: "codex", preset: "quick", model: "gpt-5.6-luna", effort: "low" }
    });
    const enriched = manager.enrich({ id: "blueprint-thread" });
    assert.equal(enriched.blueprintId, "release-agent");
    assert.equal(enriched.blueprintVersion, 3);
    assert.equal(enriched.blueprintEnvironment, "staging");
    assert.equal(enriched.preset, "quick");
    assert.deepEqual(enriched.blueprintModelConfiguration, { backend: "codex", preset: "quick", model: "gpt-5.6-luna", effort: "low" });
    manager.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("revisioned timelines support replay, universal search, and outcome analytics", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-timeline-"));
  let now = 10_000;
  let manager = await SessionManager.create(directory, () => now++);
  const threadId = "thread-timeline-12345678";
  try {
    const prompt = `Investigate the checkout timeout ${"with detailed evidence ".repeat(30)}`;
    await manager.setMetadata(threadId, {
      name: "Checkout investigation",
      model: "gpt-test",
      lastPrompt: prompt
    });
    manager.recordTimelineEvent(threadId, "codex", {
      method: "turn/started",
      params: { threadId, model: "gpt-test", turn: { startedAt: 2_000_000_000_000 } }
    }, { id: "sse:41", revision: 41, at: 2_000_000_000_000 });
    manager.recordTimelineEvent(threadId, "codex", {
      method: "turn/completed",
      params: { threadId, turn: { status: "completed", startedAt: 2_000_000_000_000, completedAt: 2_000_000_005_000 } }
    }, { id: "sse:42", revision: 42, at: 2_000_000_005_000 });
    manager.recordTimelineEvent(threadId, "codex", {
      method: "turn/completed",
      params: {
        threadId,
        turn: { status: "failed", startedAt: 2_000_000_010_000, completedAt: 2_000_000_012_000, error: { message: "Request 9821 timed out at /workspace/checkout.ts" } }
      }
    }, { id: "sse:43", revision: 43, at: 2_000_000_012_000 });

    assert.deepEqual(manager.timeline(threadId).map((event) => [event.type, event.revision, event.outcome]), [
      ["prompt/submitted", 0, null],
      ["codex", 41, null],
      ["codex", 42, "success"],
      ["codex", 43, "failed"]
    ]);
    assert.equal(manager.searchSessions({ q: "detailed evidence", model: "gpt-test" })[0]?.sessionId, threadId);
    assert.equal(manager.searchSessions({ outcome: "failed" })[0]?.error, "Request 9821 timed out at /workspace/checkout.ts");

    const analytics = manager.outcomeAnalytics();
    assert.equal(analytics.totals.runs, 2);
    assert.equal(analytics.totals.successRate, 50);
    assert.equal(analytics.totals.avgCompletionTimeMs, 3_500);
    assert.equal(analytics.byModel[0]?.model, "gpt-test");
    assert.match(analytics.commonErrors[0]?.pattern || "", /Request <n> timed out at <path>/);
    manager.close();

    manager = await SessionManager.create(directory, () => now++);
    assert.equal(manager.latestTimelineRevision(), 43);
    assert.equal(manager.nextTimelineRevision(), 44);
    assert.equal(manager.timeline(threadId).length, 4);
  } finally {
    manager.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("universal search does not promote non-terminal diagnostics to session outcome errors", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-search-outcome-"));
  const manager = await SessionManager.create(directory, () => 10_000);
  const threadId = "thread-success-with-diagnostic";
  try {
    await manager.setMetadata(threadId, {
      name: "Successful session",
      model: "gpt-test",
      lastPrompt: "Complete the requested change"
    });
    manager.recordTimelineEvent(threadId, "codex", {
      method: "mcpServer/startupStatus/updated",
      params: {
        threadId,
        message: "MCP client for `forgedeck` failed to start: initialize response"
      }
    }, { id: "sse:51", revision: 51, at: 2_000_000_001_000 });
    manager.recordTimelineEvent(threadId, "codex", {
      method: "turn/completed",
      params: {
        threadId,
        turn: { status: "completed", startedAt: 2_000_000_000_000, completedAt: 2_000_000_002_000 }
      }
    }, { id: "sse:52", revision: 52, at: 2_000_000_002_000 });

    const result = manager.searchSessions().find((entry) => entry.sessionId === threadId);
    assert.equal(result?.outcome, "success");
    assert.equal(result?.error, null);
    assert.deepEqual(manager.outcomeAnalytics().commonErrors, []);
    assert.match(manager.timeline(threadId)[1]?.error || "", /MCP client/);
  } finally {
    manager.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
