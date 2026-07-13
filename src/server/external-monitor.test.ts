import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findWritableRolloutPaths, isApplyPatchCall, isInjectedUserContext, readLatestLifecycle } from "./external-monitor.js";

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
