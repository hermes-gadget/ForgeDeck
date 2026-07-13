import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ExternalCodexMonitor, findWritableRolloutPaths, isApplyPatchCall, isInjectedUserContext, readLatestLifecycle } from "./external-monitor.js";

test("standalone Codex context records are hidden from chat", () => {
  assert.equal(isInjectedUserContext("<environment_context>\n  <cwd>/workspace</cwd>\n</environment_context>"), true);
  assert.equal(isInjectedUserContext("<codex_internal_context source=\"goal\">continue</codex_internal_context>"), true);
});

test("real user messages mentioning environment context remain visible", () => {
  assert.equal(isInjectedUserContext("Please fix this: <environment_context>example</environment_context>"), false);
  assert.equal(isInjectedUserContext("testing followup in ForgeDeck"), false);
});

test("apply_patch wrappers are not classified as shell commands", () => {
  assert.equal(isApplyPatchCall('text(await tools.apply_patch("*** Begin Patch\\n*** End Patch"))'), true);
  assert.equal(isApplyPatchCall('await tools.exec_command({ cmd: "npm test" })'), false);
});

test("writable rollout discovery distinguishes live sessions from stale files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-proc-"));
  const rollout = path.join(os.homedir(), ".codex", "sessions", "2026", "rollout-live.jsonl");
  const fd = path.join(root, "123", "fd");
  const fdinfo = path.join(root, "123", "fdinfo");
  fs.mkdirSync(fd, { recursive: true });
  fs.mkdirSync(fdinfo, { recursive: true });
  fs.symlinkSync(rollout, path.join(fd, "44"));
  fs.writeFileSync(path.join(fdinfo, "44"), "pos:\t42\nflags:\t0100001\n");
  fs.symlinkSync(path.join(os.homedir(), ".codex", "sessions", "2026", "rollout-read.jsonl"), path.join(fd, "45"));
  fs.writeFileSync(path.join(fdinfo, "45"), "pos:\t0\nflags:\t0100000\n");

  try {
    assert.deepEqual(findWritableRolloutPaths(root), new Set([rollout]));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writable rollout discovery degrades safely without procfs", () => {
  assert.equal(findWritableRolloutPaths(path.join(os.tmpdir(), "forgedeck-missing-proc")), null);
});

test("latest lifecycle state is recovered from beyond the retained activity tail", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-rollout-"));
  const rollout = path.join(directory, "rollout.jsonl");
  const started = JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-live" } });
  const noise = `${JSON.stringify({ type: "event_msg", payload: { type: "token_count", detail: "x".repeat(4_000) } })}\n`;
  fs.writeFileSync(rollout, `${started}\n${noise.repeat(280)}`);
  try {
    assert.deepEqual(readLatestLifecycle(rollout), { active: true, turnId: "turn-live" });
    fs.appendFileSync(rollout, `${JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted", turn_id: "turn-live" } })}\n`);
    assert.deepEqual(readLatestLifecycle(rollout), { active: false, turnId: null });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("lifecycle reads refuse symlink rollout paths", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-rollout-link-"));
  const target = path.join(directory, "target.jsonl");
  const link = path.join(directory, "rollout.jsonl");
  fs.writeFileSync(target, `${JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })}\n`);
  fs.symlinkSync(target, link);
  try {
    assert.throws(() => readLatestLifecycle(link), (error: unknown) => (error as NodeJS.ErrnoException).code === "ELOOP");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("dead external processes require consecutive confirmations before interruption", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-monitor-"));
  const notifications: Array<{ method: string }> = [];
  const monitor = new ExternalCodexMonitor((notification) => notifications.push(notification), directory);
  const tracker = {
    id: "thread-live", path: path.join(directory, "rollout.jsonl"), cwd: directory, offset: 0, partial: "",
    active: true, activeTurnId: "turn-live", missingWritablePolls: 0, lastObservedAt: Date.now(), calls: new Map(), recent: []
  };
  const reconcile = (monitor as unknown as { reconcileProcessState: (value: typeof tracker, paths: Set<string>, initial: boolean) => void }).reconcileProcessState.bind(monitor);
  try {
    reconcile(tracker, new Set(), false);
    reconcile(tracker, new Set(), false);
    assert.equal(tracker.active, true);
    assert.equal(notifications.length, 0);
    reconcile(tracker, new Set(), false);
    assert.equal(tracker.active, false);
    assert.deepEqual(notifications.map((notification) => notification.method), ["thread/status/changed", "turn/completed"]);
  } finally {
    monitor.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("external inventory reports removals and drops archived trackers", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-monitor-"));
  const sessionsDirectory = path.join(directory, "sessions");
  const rollout = path.join(sessionsDirectory, "rollout.jsonl");
  fs.mkdirSync(sessionsDirectory, { recursive: true });
  fs.writeFileSync(rollout, `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })}\n`);
  const databasePath = path.join(directory, "state_5.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, archived INTEGER, updated_at INTEGER, updated_at_ms INTEGER)");
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, 0, ?, ?)").run("thread-one", rollout, directory, Math.floor(Date.now() / 1_000), Date.now());
  db.close();
  const inventories: Array<{ ids: string[]; unavailable: string[] }> = [];
  const notifications: string[] = [];
  const monitor = new ExternalCodexMonitor(
    (notification) => notifications.push(notification.method),
    directory,
    (inventory) => inventories.push({ ids: [...inventory.threadIds], unavailable: [...inventory.unavailableThreadIds] })
  );
  const poll = (monitor as unknown as { poll: () => Promise<void>; lastInventoryAt: number }).poll.bind(monitor);
  try {
    await poll();
    assert.deepEqual(inventories.at(-1), { ids: ["thread-one"], unavailable: [] });
    const writer = new DatabaseSync(databasePath);
    writer.prepare("UPDATE threads SET archived = 1 WHERE id = ?").run("thread-one");
    writer.close();
    (monitor as unknown as { lastInventoryAt: number }).lastInventoryAt = 0;
    await poll();
    assert.deepEqual(inventories.at(-1), { ids: [], unavailable: [] });
    assert.ok(notifications.includes("thread/archived"));
  } finally {
    monitor.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
