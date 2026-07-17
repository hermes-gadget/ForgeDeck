import assert from "node:assert/strict";
import test from "node:test";
import { CapacityManager } from "./capacity.js";
import { ClaudeBridge, parseClaudeUsageOutput } from "./claude-bridge.js";

type Result = { stdout: string; stderr: string };

class FakeTmux {
  readonly sessions = new Set<string>();
  readonly options = new Map<string, string>();
  readonly literalKeys: string[] = [];
  readonly controlKeys: string[] = [];
  readonly createdAt = new Map<string, number>();
  readonly killFailures = new Set<string>();
  capture = "";
  failNextLiteralSend = false;
  completeOnEnter = true;
  onControlKey?: (target: string, key: string) => void;

  completeTurn(target: string, exitCode = 0, output = ""): void {
    const marker = this.options.get(`${target}:@forgedeck_claude_completion_marker`);
    assert.ok(marker, "Expected an active Claude completion marker");
    this.capture = [this.capture, output, `${marker}:${exitCode}`].filter(Boolean).join("\n");
  }

  run = async (file: string, args: string[]): Promise<Result> => {
    assert.equal(file, "tmux");
    const command = args[0];
    const target = valueAfter(args, "-t");
    if (command === "has-session") {
      if (!this.sessions.has(target)) throw new Error("missing");
      return emptyResult();
    }
    if (command === "new-session") {
      const name = valueAfter(args, "-s");
      this.sessions.add(name);
      this.createdAt.set(name, Math.floor(Date.now() / 1_000));
      return emptyResult();
    }
    if (command === "set-option") {
      this.options.set(`${target}:${args.at(-2)}`, args.at(-1) || "");
      return emptyResult();
    }
    if (command === "show-options") {
      return { stdout: this.options.get(`${target}:${args.at(-1)}`) || "", stderr: "" };
    }
    if (command === "send-keys") {
      if (args.includes("-l")) {
        if (this.failNextLiteralSend) {
          this.failNextLiteralSend = false;
          throw new Error("send failed");
        }
        this.literalKeys.push(args.at(-1) || "");
      } else {
        const key = args.at(-1) || "";
        this.controlKeys.push(key);
        this.onControlKey?.(target, key);
        if (key === "Enter" && this.completeOnEnter) this.completeTurn(target);
      }
      return emptyResult();
    }
    if (command === "capture-pane") return { stdout: this.capture, stderr: "" };
    if (command === "list-sessions") {
      const format = args.at(-1) || "";
      const entries = [...this.sessions].map((name) => format.includes("session_created")
        ? `${name}\t${this.createdAt.get(name) || Math.floor(Date.now() / 1_000)}`
        : name);
      return { stdout: entries.join("\n"), stderr: "" };
    }
    if (command === "kill-session") {
      if (this.killFailures.has(target)) throw new Error("kill failed");
      this.sessions.delete(target);
      return emptyResult();
    }
    throw new Error(`Unexpected tmux command: ${args.join(" ")}`);
  };
}

test("ClaudeBridge reads plan usage through Claude Code's zero-token slash command", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const bridge = new ClaudeBridge({
    claudeBin: "/opt/claude",
    environment: {},
    run: async (file, args) => {
      calls.push({ file, args });
      return {
        stdout: JSON.stringify({
          type: "result",
          is_error: false,
          duration_api_ms: 0,
          result: "Current session: 54% used · resets Jul 18, 12:29am (Europe/London)\nCurrent week (all models): 4% used"
        }),
        stderr: ""
      };
    }
  });

  const usage = await bridge.readUsage();

  assert.equal(usage?.usedPercent, 54);
  assert.equal(typeof usage?.observedAt, "number");
  assert.deepEqual(calls, [{
    file: "/opt/claude",
    args: ["-p", "/usage", "--output-format", "json", "--no-session-persistence"]
  }]);
});

test("Claude usage parsing returns null when the account has no plan percentage", () => {
  const output = JSON.stringify({ type: "result", is_error: false, result: "Total cost: $0.55" });
  assert.equal(parseClaudeUsageOutput(output, 123), null);
});

test("Claude usage parsing rejects malformed command output", () => {
  assert.throws(() => parseClaudeUsageOutput("not-json"), /valid JSON/);
  assert.throws(() => parseClaudeUsageOutput(JSON.stringify({ is_error: true, result: "failed" })), /command failed/);
});

test("ClaudeBridge starts print mode in tmux and resumes the parsed Claude session", async () => {
  const tmux = new FakeTmux();
  const threadId = "11111111-1111-4111-8111-111111111111";
  const claudeSessionId = "22222222-2222-4222-8222-222222222222";
  const bridge = new ClaudeBridge({ claudeBin: "/opt/claude", environment: {}, run: tmux.run });
  tmux.completeOnEnter = false;

  await bridge.start({
    threadId,
    cwd: "/workspace",
    model: "claude-sonnet-4-6",
    effort: "high",
    permissionMode: "plan",
    prompt: "Fix the quoted 'value'",
    maxTurns: 15
  });
  assert.equal(tmux.sessions.has(`claude-${threadId}`), true);
  assert.match(tmux.literalKeys[0], /'\/opt\/claude' '-p'/);
  assert.match(tmux.literalKeys[0], /'--verbose' '--output-format' 'stream-json'/);
  assert.match(tmux.literalKeys[0], /'--max-turns' '15'/);
  assert.match(tmux.literalKeys[0], /'--session-id'/);
  assert.doesNotMatch(tmux.literalKeys[0], /tmux set-option/);

  tmux.completeTurn(`claude-${threadId}`, 0, JSON.stringify({ session_id: claudeSessionId, result: "done" }));
  const completed = await waitForInactive(bridge, threadId);
  assert.equal(completed.active, false);
  assert.doesNotMatch(completed.text, /__FD_CLAUDE_DONE_/);
  await bridge.sendMessage(threadId, "Continue");
  assert.match(tmux.literalKeys.at(-1) || "", new RegExp(`'--resume' '${claudeSessionId}'`));
  tmux.completeTurn(`claude-${threadId}`);
  assert.equal((await waitForInactive(bridge, threadId)).active, false);

  await bridge.stop(threadId);
  await bridge.archive(threadId);
  assert.equal(tmux.sessions.has(`claude-${threadId}`), false);
});

test("ClaudeBridge recovers only owned claude-prefixed tmux sessions", async () => {
  const tmux = new FakeTmux();
  const owned = "claude-33333333-3333-4333-8333-333333333333";
  const unowned = "claude-44444444-4444-4444-8444-444444444444";
  tmux.sessions.add(owned);
  tmux.sessions.add(unowned);
  tmux.sessions.add("unrelated-shell");
  tmux.options.set(`${owned}:@forgedeck_claude_owner`, "forgedeck");
  const bridge = new ClaudeBridge({ claudeBin: "claude", environment: {}, run: tmux.run });

  assert.deepEqual(await bridge.recoverOrphans(), ["33333333-3333-4333-8333-333333333333"]);
});

test("ClaudeBridge recovery reuses one durable active turn idempotently", async () => {
  const tmux = new FakeTmux();
  const threadId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const target = `claude-${threadId}`;
  const marker = `__FD_CLAUDE_DONE_${"e".repeat(32)}`;
  tmux.sessions.add(target);
  tmux.options.set(`${target}:@forgedeck_claude_owner`, "forgedeck");
  tmux.options.set(`${target}:@forgedeck_claude_active`, "1");
  tmux.options.set(`${target}:@forgedeck_claude_completion_marker`, marker);
  tmux.options.set(`${target}:@forgedeck_claude_turn_state`, "running");
  tmux.options.set(`${target}:@forgedeck_claude_active_since`, String(Math.floor(Date.now() / 1_000)));
  const bridge = new ClaudeBridge({ claudeBin: "claude", environment: {}, run: tmux.run });
  const states: string[] = [];
  bridge.on("turnState", (snapshot) => states.push(snapshot.state));

  assert.deepEqual(await bridge.recoverOrphans(), [threadId]);
  assert.deepEqual(await bridge.recoverOrphans(), [threadId]);
  assert.equal((await bridge.status(threadId)).turn?.id, marker);
  assert.deepEqual(states, ["running"]);

  tmux.completeTurn(target);
  await bridge.status(threadId);
  assert.deepEqual(states, ["running", "completed"]);
});

test("ClaudeBridge serializes sends for the same thread", async () => {
  const tmux = new FakeTmux();
  const threadId = "55555555-5555-4555-8555-555555555555";
  const bridge = new ClaudeBridge({ claudeBin: "claude", environment: {}, run: tmux.run });
  await bridge.start({ threadId, cwd: "/workspace" });

  const results = await Promise.allSettled([
    bridge.sendMessage(threadId, "First"),
    bridge.sendMessage(threadId, "Second")
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
  assert.equal(results.filter((result) => result.status === "rejected").length, 0);
  assert.equal(tmux.literalKeys.length, 2);
  assert.match(tmux.literalKeys[0], /'First'/);
  assert.match(tmux.literalKeys[1], /'Second'/);
});

test("ClaudeBridge exposes separate acceptance and terminal completion signals", async () => {
  const tmux = new FakeTmux();
  const threadId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const target = `claude-${threadId}`;
  const bridge = new ClaudeBridge({ claudeBin: "claude", environment: {}, run: tmux.run });
  const states: string[] = [];
  bridge.on("turnState", (snapshot) => states.push(snapshot.state));
  tmux.completeOnEnter = false;
  await bridge.start({ threadId, cwd: "/workspace" });

  const handle = await bridge.sendMessage(threadId, "Long task");
  assert.equal((await handle.accepted).state, "accepted");
  assert.equal(handle.snapshot().state, "running");
  assert.deepEqual(states, ["accepted", "running"]);

  let settled = false;
  void handle.completion.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false);

  tmux.completeTurn(target, 0, JSON.stringify({ session_id: threadId, result: "done" }));
  await bridge.status(threadId);
  const terminal = await handle.completion;
  assert.equal(terminal.state, "completed");
  assert.equal(terminal.reason, "completed");
  assert.deepEqual(states, ["accepted", "running", "completed"]);
});

test("Claude turn events hold admission capacity until authoritative completion", async () => {
  const tmux = new FakeTmux();
  const firstThreadId = "12121212-1212-4212-8212-121212121212";
  const secondThreadId = "34343434-3434-4434-8434-343434343434";
  const bridge = new ClaudeBridge({ claudeBin: "claude", environment: {}, run: tmux.run });
  const capacity = new CapacityManager({ "codex/standard": 1, "codex/spark": 1, claude: 1 });
  tmux.completeOnEnter = false;
  bridge.on("turnState", (snapshot) => {
    if (snapshot.state === "completed" || snapshot.state === "failed") capacity.release(snapshot.threadId);
    else capacity.reconcile("claude", snapshot.threadId);
  });
  await bridge.start({ threadId: firstThreadId, cwd: "/workspace" });
  await bridge.start({ threadId: secondThreadId, cwd: "/workspace" });

  const submit = async (threadId: string, text: string) => {
    await capacity.acquire("claude", threadId, Date.now() + 1_000);
    return bridge.sendMessage(threadId, text);
  };
  await submit(firstThreadId, "First task");
  const secondSubmission = submit(secondThreadId, "Second task");
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(tmux.literalKeys.length, 1);
  assert.equal(capacity.metrics().claude.activeCount, 1);
  assert.equal(capacity.metrics().claude.waitingCount, 1);

  tmux.completeTurn(`claude-${firstThreadId}`);
  await bridge.status(firstThreadId);
  await secondSubmission;
  assert.equal(tmux.literalKeys.length, 2);
  assert.equal(capacity.metrics().claude.activeCount, 1);
  assert.equal(capacity.metrics().claude.waitingCount, 0);

  tmux.completeTurn(`claude-${secondThreadId}`);
  await bridge.status(secondThreadId);
  assert.equal(capacity.metrics().claude.activeCount, 0);
});

test("ClaudeBridge resets active state when command submission fails", async () => {
  const tmux = new FakeTmux();
  const threadId = "66666666-6666-4666-8666-666666666666";
  const target = `claude-${threadId}`;
  const bridge = new ClaudeBridge({ claudeBin: "claude", environment: {}, run: tmux.run });
  await bridge.start({ threadId, cwd: "/workspace" });
  tmux.failNextLiteralSend = true;

  await assert.rejects(bridge.sendMessage(threadId, "Fail"), /send failed/);
  assert.equal(tmux.options.get(`${target}:@forgedeck_claude_active`), "0");

  await bridge.sendMessage(threadId, "Retry");
  assert.equal(tmux.literalKeys.length, 1);
});

test("ClaudeBridge stop waits for authoritative completion after interrupt", async () => {
  const tmux = new FakeTmux();
  const threadId = "77777777-7777-4777-8777-777777777777";
  const target = `claude-${threadId}`;
  const bridge = new ClaudeBridge({ claudeBin: "claude", environment: {}, run: tmux.run });
  const states: string[] = [];
  bridge.on("turnState", (snapshot) => states.push(snapshot.state));
  await bridge.start({ threadId, cwd: "/workspace" });
  tmux.completeOnEnter = false;
  await bridge.sendMessage(threadId, "Task to stop");
  let stateWhenInterrupted = "";
  tmux.onControlKey = (_target, key) => {
    if (key === "C-c") stateWhenInterrupted = tmux.options.get(`${target}:@forgedeck_claude_turn_state`) || "";
  };
  const stopping = bridge.stop(threadId);
  await waitUntil(() => tmux.controlKeys.includes("C-c"));
  assert.equal(tmux.options.get(`${target}:@forgedeck_claude_active`), "1");
  assert.equal(stateWhenInterrupted, "interrupting");
  tmux.completeTurn(target, 130);
  await bridge.status(threadId);
  const completed = await stopping;
  assert.ok(completed);
  assert.equal(completed.state, "completed");
  assert.equal(completed.exitCode, 130);
  assert.equal(completed.reason, "interrupted");
  assert.deepEqual(states, ["accepted", "running", "interrupting", "completed"]);
});

test("ClaudeBridge reports process loss as a terminal failed turn", async () => {
  const tmux = new FakeTmux();
  const threadId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const target = `claude-${threadId}`;
  const bridge = new ClaudeBridge({ claudeBin: "claude", environment: {}, run: tmux.run });
  tmux.completeOnEnter = false;
  await bridge.start({ threadId, cwd: "/workspace" });
  const handle = await bridge.sendMessage(threadId, "Task");

  tmux.sessions.delete(target);
  const status = await bridge.status(threadId);
  const terminal = await handle.completion;
  assert.equal(status.active, false);
  assert.equal(terminal.state, "failed");
  assert.equal(terminal.reason, "process_lost");
});

test("ClaudeBridge archive marks, waits, then terminates an unresponsive turn", async () => {
  const tmux = new FakeTmux();
  const threadId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const target = `claude-${threadId}`;
  const bridge = new ClaudeBridge({ claudeBin: "claude", environment: {}, run: tmux.run, interruptAckTimeoutMs: 20 });
  const states: string[] = [];
  bridge.on("turnState", (snapshot) => states.push(snapshot.state));
  tmux.completeOnEnter = false;
  await bridge.start({ threadId, cwd: "/workspace" });
  await bridge.sendMessage(threadId, "Task");

  await bridge.archive(threadId);
  assert.equal(tmux.sessions.has(target), false);
  assert.deepEqual(states, ["accepted", "running", "interrupting", "failed"]);
});

test("ClaudeBridge requires its exact marker instead of treating JSON as completion", async () => {
  const tmux = new FakeTmux();
  const threadId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const bridge = new ClaudeBridge({ claudeBin: "claude", environment: {}, run: tmux.run });
  tmux.completeOnEnter = false;
  await bridge.start({ threadId, cwd: "/workspace", prompt: "Task" });
  tmux.capture = JSON.stringify({ type: "result", session_id: threadId, result: "done" });

  assert.equal((await bridge.status(threadId)).active, true);
  tmux.completeTurn(`claude-${threadId}`);
  assert.equal((await waitForInactive(bridge, threadId)).active, false);
});

test("ClaudeBridge publishes changed active output without treating it as completion", async () => {
  const tmux = new FakeTmux();
  const threadId = "abababab-abab-4bab-8bab-abababababab";
  const bridge = new ClaudeBridge({ claudeBin: "claude", environment: {}, run: tmux.run });
  const outputs: string[] = [];
  bridge.on("output", (snapshot) => outputs.push(snapshot.text));
  tmux.completeOnEnter = false;
  await bridge.start({ threadId, cwd: "/workspace", prompt: "Task" });
  tmux.capture = JSON.stringify({ type: "system", subtype: "init", session_id: threadId });
  await waitUntil(() => outputs.length === 1);
  assert.equal((await bridge.status(threadId)).active, true);

  tmux.capture += `\n${JSON.stringify({ type: "assistant", message: { id: "message-1", content: [{ type: "text", text: "Working" }] } })}`;
  await waitUntil(() => outputs.length === 2);
  assert.match(outputs[1], /Working/);
  assert.equal((await bridge.status(threadId)).active, true);

  tmux.completeTurn(`claude-${threadId}`);
  await waitForInactive(bridge, threadId);
});

test("ClaudeBridge stale cleanup settles every kill before reporting failures", async () => {
  const tmux = new FakeTmux();
  const failed = "claude-88888888-8888-4888-8888-888888888888";
  const removed = "claude-99999999-9999-4999-8999-999999999999";
  const stale = Math.floor(Date.now() / 1_000) - 25 * 60 * 60;
  tmux.sessions.add(failed);
  tmux.sessions.add(removed);
  tmux.createdAt.set(failed, stale);
  tmux.createdAt.set(removed, stale);
  tmux.options.set(`${failed}:@forgedeck_claude_owner`, "forgedeck");
  tmux.options.set(`${removed}:@forgedeck_claude_owner`, "forgedeck");
  tmux.killFailures.add(failed);
  const bridge = new ClaudeBridge({ claudeBin: "claude", environment: {}, run: tmux.run });

  await assert.rejects(
    (bridge as unknown as { cleanStaleSessionsNow(): Promise<void> }).cleanStaleSessionsNow(),
    AggregateError
  );
  assert.equal(tmux.sessions.has(failed), true);
  assert.equal(tmux.sessions.has(removed), false);
});

test("ClaudeBridge derives a UUID session id for slug thread ids and shields dash-prefixed prompts", async () => {
  const tmux = new FakeTmux();
  const threadId = `claude-${"a1b2c3d4".repeat(4)}`;
  const target = `claude-${threadId}`;
  const parsedSessionId = "33334444-5555-4666-8777-888899990000";
  const bridge = new ClaudeBridge({ claudeBin: "/opt/claude", environment: {}, run: tmux.run });
  tmux.completeOnEnter = false;

  await bridge.start({ threadId, cwd: "/workspace", prompt: "-p looks like a flag" });
  const command = tmux.literalKeys[0];
  const sessionId = /'--session-id' '([0-9a-f-]{36})'/.exec(command)?.[1];
  assert.ok(sessionId, "expected a --session-id argument");
  assert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(command, /'--' '-p looks like a flag'/);

  tmux.completeTurn(target, 0, JSON.stringify({ session_id: parsedSessionId, result: "done" }));
  await waitForInactive(bridge, threadId);
  await waitUntil(() => tmux.options.get(`${target}:@forgedeck_claude_session_id`) === parsedSessionId);

  await bridge.sendMessage(threadId, "next");
  assert.match(tmux.literalKeys.at(-1) || "", new RegExp(`'--resume' '${parsedSessionId}'`));
});

test("ClaudeBridge resumes the persisted Claude session identity after recovery", async () => {
  const tmux = new FakeTmux();
  const threadId = "claude-1111222233334444aaaabbbbccccdddd";
  const target = `claude-${threadId}`;
  const persisted = "aaaabbbb-cccc-4ddd-8eee-ffff00001111";
  tmux.sessions.add(target);
  tmux.options.set(`${target}:@forgedeck_claude_owner`, "forgedeck");
  tmux.options.set(`${target}:@forgedeck_claude_session_id`, persisted);
  const bridge = new ClaudeBridge({ claudeBin: "claude", environment: {}, run: tmux.run });

  await bridge.sendMessage(threadId, "continue");
  assert.match(tmux.literalKeys.at(-1) || "", new RegExp(`'--resume' '${persisted}'`));
});

test("ClaudeBridge starts a new conversation after recovery without durable evidence", async () => {
  const tmux = new FakeTmux();
  const threadId = "claude-5555666677778888aaaabbbbccccdddd";
  const target = `claude-${threadId}`;
  tmux.sessions.add(target);
  tmux.options.set(`${target}:@forgedeck_claude_owner`, "forgedeck");
  const bridge = new ClaudeBridge({ claudeBin: "claude", environment: {}, run: tmux.run });

  await bridge.sendMessage(threadId, "hello");
  const command = tmux.literalKeys.at(-1) || "";
  assert.match(command, /'--session-id' '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'/);
  assert.doesNotMatch(command, /--resume/);
});

test("ClaudeBridge self-heals when its session id is already in use", async () => {
  const tmux = new FakeTmux();
  const threadId = "claude-9999888877776666aaaabbbbccccdddd";
  const target = `claude-${threadId}`;
  const bridge = new ClaudeBridge({ claudeBin: "claude", environment: {}, run: tmux.run });
  tmux.completeOnEnter = false;
  await bridge.start({ threadId, cwd: "/workspace" });

  const handle = await bridge.sendMessage(threadId, "first");
  const derived = /'--session-id' '([0-9a-f-]{36})'/.exec(tmux.literalKeys[0])?.[1];
  assert.ok(derived, "expected a derived session id");
  tmux.completeTurn(target, 1, `Error: Session ID ${derived} is already in use.`);
  await waitForInactive(bridge, threadId);
  assert.equal((await handle.completion).state, "failed");

  await bridge.sendMessage(threadId, "second");
  assert.match(tmux.literalKeys.at(-1) || "", new RegExp(`'--resume' '${derived}'`));
});

test("ClaudeBridge restarts the conversation when Claude loses it", async () => {
  const tmux = new FakeTmux();
  const threadId = "claude-0000111122223333aaaabbbbccccdddd";
  const target = `claude-${threadId}`;
  const bridge = new ClaudeBridge({ claudeBin: "claude", environment: {}, run: tmux.run });
  tmux.completeOnEnter = false;
  await bridge.start({ threadId, cwd: "/workspace" });

  const first = await bridge.sendMessage(threadId, "first");
  const derived = /'--session-id' '([0-9a-f-]{36})'/.exec(tmux.literalKeys[0])?.[1];
  assert.ok(derived);
  tmux.completeTurn(target, 0);
  await waitForInactive(bridge, threadId);
  assert.equal((await first.completion).state, "completed");

  const second = await bridge.sendMessage(threadId, "second");
  assert.match(tmux.literalKeys.at(-1) || "", new RegExp(`'--resume' '${derived}'`));
  tmux.completeTurn(target, 1, `No conversation found with session ID: ${derived}`);
  await waitForInactive(bridge, threadId);
  assert.equal((await second.completion).state, "failed");

  await bridge.sendMessage(threadId, "third");
  assert.match(tmux.literalKeys.at(-1) || "", new RegExp(`'--session-id' '${derived}'`));
});

test("ClaudeBridge treats a missing tmux server as no sessions and can still create the first one", async () => {
  const tmux = new FakeTmux();
  const threadId = "claude-abcd1234abcd1234aaaabbbbccccdddd";
  const originalRun = tmux.run;
  tmux.run = async (file: string, args: string[]): Promise<Result> => {
    if (args[0] === "has-session" && !tmux.sessions.size) throw new Error("no server running on /tmp/tmux-1000/default");
    return originalRun(file, args);
  };
  const bridge = new ClaudeBridge({ claudeBin: "claude", environment: {}, run: tmux.run });

  assert.equal(await bridge.exists(threadId), false);
  await bridge.start({ threadId, cwd: "/workspace", prompt: "first ever session" });
  assert.equal(tmux.sessions.has(`claude-${threadId}`), true);
});

test("ClaudeBridge rejects effort levels and permission modes the Claude CLI would refuse", async () => {
  const tmux = new FakeTmux();
  const threadId = "claude-f0f1f2f3f4f5f6f7aaaabbbbccccdddd";
  const bridge = new ClaudeBridge({ claudeBin: "claude", environment: {}, run: tmux.run });

  await assert.rejects(bridge.start({ threadId, cwd: "/workspace", effort: "ultra" }), /effort/);
  await assert.rejects(bridge.start({ threadId, cwd: "/workspace", permissionMode: "yolo" }), /permission mode/);
  await bridge.start({ threadId, cwd: "/workspace" });
  await assert.rejects(bridge.setEffort(threadId, "extreme"), /effort/);
  await assert.rejects(bridge.setPermissionMode(threadId, "never"), /permission mode/);
  await bridge.setPermissionMode(threadId, "acceptEdits");
  await bridge.setEffort(threadId, "xhigh");
});

function valueAfter(values: string[], marker: string): string {
  const index = values.indexOf(marker);
  return index >= 0 ? values[index + 1] || "" : "";
}

function emptyResult(): Result {
  return { stdout: "", stderr: "" };
}

async function waitForInactive(bridge: ClaudeBridge, threadId: string): Promise<Awaited<ReturnType<ClaudeBridge["status"]>>> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const status = await bridge.status(threadId);
    if (!status.active) return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Claude turn ${threadId} did not complete`);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for Claude lifecycle state");
}
