import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeBridge } from "./claude-bridge.js";

type Result = { stdout: string; stderr: string };

class FakeTmux {
  readonly sessions = new Set<string>();
  readonly options = new Map<string, string>();
  readonly literalKeys: string[] = [];
  capture = "";

  run = async (file: string, args: string[]): Promise<Result> => {
    assert.equal(file, "tmux");
    const command = args[0];
    const target = valueAfter(args, "-t");
    if (command === "has-session") {
      if (!this.sessions.has(target)) throw new Error("missing");
      return emptyResult();
    }
    if (command === "new-session") {
      this.sessions.add(valueAfter(args, "-s"));
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
      if (args.includes("-l")) this.literalKeys.push(args.at(-1) || "");
      return emptyResult();
    }
    if (command === "capture-pane") return { stdout: this.capture, stderr: "" };
    if (command === "list-sessions") return { stdout: [...this.sessions].join("\n"), stderr: "" };
    if (command === "kill-session") {
      this.sessions.delete(target);
      return emptyResult();
    }
    throw new Error(`Unexpected tmux command: ${args.join(" ")}`);
  };
}

test("ClaudeBridge starts print mode in tmux and resumes the parsed Claude session", async () => {
  const tmux = new FakeTmux();
  const threadId = "11111111-1111-4111-8111-111111111111";
  const claudeSessionId = "22222222-2222-4222-8222-222222222222";
  const bridge = new ClaudeBridge("/opt/claude", tmux.run);

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
  assert.match(tmux.literalKeys[0], /'--max-turns' '15'/);
  assert.match(tmux.literalKeys[0], /'--session-id'/);

  tmux.capture = JSON.stringify({ session_id: claudeSessionId, result: "done" });
  assert.equal((await bridge.status(threadId)).active, true);
  await bridge.stop(threadId);
  await bridge.sendMessage(threadId, "Continue");
  assert.match(tmux.literalKeys.at(-1) || "", new RegExp(`'--resume' '${claudeSessionId}'`));

  await bridge.archive(threadId);
  assert.equal(tmux.sessions.has(`claude-${threadId}`), false);
});

test("ClaudeBridge recovers claude-prefixed tmux sessions only", async () => {
  const tmux = new FakeTmux();
  tmux.sessions.add("claude-33333333-3333-4333-8333-333333333333");
  tmux.sessions.add("unrelated-shell");
  const bridge = new ClaudeBridge("claude", tmux.run);

  assert.deepEqual(await bridge.recoverOrphans(), ["33333333-3333-4333-8333-333333333333"]);
});

function valueAfter(values: string[], marker: string): string {
  const index = values.indexOf(marker);
  return index >= 0 ? values[index + 1] || "" : "";
}

function emptyResult(): Result {
  return { stdout: "", stderr: "" };
}
