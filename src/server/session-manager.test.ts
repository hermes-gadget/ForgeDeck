import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SESSION_TTL_MS, SessionManager, deriveSessionName, isSessionExpired, normalizeTags } from "./session-manager.js";

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
});

test("session operations are serialized by thread but independent across threads", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-sessions-"));
  const manager = new SessionManager(directory);
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
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("metadata is normalized, persisted, and retained in audit history", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-sessions-"));
  let now = 1_000;
  try {
    const manager = new SessionManager(directory, () => now++);
    const metadata = manager.setMetadata("thread-123", { tags: ["Bug", "bug", " Release "], category: " Work " });
    assert.deepEqual(metadata.tags, ["Bug", "Release"]);
    assert.equal(metadata.category, "Work");
    manager.record("thread-123", "created", "user");

    const restored = new SessionManager(directory, () => now++);
    assert.deepEqual(restored.metadataFor("thread-123").tags, ["Bug", "Release"]);
    assert.deepEqual(restored.history("thread-123").map((event) => event.action), ["organized", "created"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid and excessive tags are rejected", () => {
  assert.throws(() => normalizeTags("bug"), /array/);
  assert.throws(() => normalizeTags(Array.from({ length: 11 }, (_, index) => `tag-${index}`)), /at most 10/);
});

test("session class and Claude metadata persist, enrich, and filter", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-sessions-"));
  try {
    const manager = new SessionManager(directory, () => 10_000);
    manager.setMetadata("spark-thread", { sessionClass: "spark", backend: "codex", model: "gpt-5.3-codex-spark" });
    manager.setMetadata("claude-thread", {
      sessionClass: "standard",
      backend: "claude",
      cwd: "/workspace",
      name: "Claude task",
      model: "claude-sonnet-4-6",
      effort: "high",
      permissionMode: "plan",
      maxTurns: 15
    });

    const restored = new SessionManager(directory, () => 20_000);
    assert.deepEqual(restored.listAllSessions("spark").map((session) => session.id), ["spark-thread"]);
    assert.equal(restored.enrich({ id: "spark-thread" }).sessionClass, "spark");
    assert.deepEqual(restored.enrich({ id: "claude-thread" }), {
      id: "claude-thread",
      tags: [],
      category: null,
      sessionClass: "standard",
      backend: "claude",
      claudeModel: "claude-sonnet-4-6",
      claudeEffort: "high",
      claudePermissionMode: "plan",
      claudeMaxTurns: 15
    });
    assert.equal(restored.enrich({ id: "untracked", model: "gpt-5.3-codex-spark" }).sessionClass, "spark");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
