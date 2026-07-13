import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { McpAccessManager } from "./mcp-access.js";

function request(token?: string): never {
  return { headers: token ? { authorization: `Bearer ${token}` } : {} } as never;
}

test("MCP actors can mutate only threads they created", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-mcp-access-"));
  try {
    const access = new McpAccessManager(directory);
    assert.equal(fs.statSync(access.bootstrapTokenPath).mode & 0o777, 0o600);
    const bootstrap = fs.readFileSync(access.bootstrapTokenPath, "utf8").trim();
    assert.equal(access.isBootstrapRequest(request(bootstrap)), true);

    const first = access.registerActor();
    const second = access.registerActor();
    assert.equal(access.authenticateActor(request(first.token)), first.actorId);
    assert.equal(access.authenticateActor(request(second.token)), second.actorId);

    access.assignThread("thread-created-by-first", first.actorId);
    assert.equal(access.ownsThread(first.actorId, "thread-created-by-first"), true);
    assert.equal(access.ownsThread(second.actorId, "thread-created-by-first"), false);
    assert.equal(access.ownsThread(first.actorId, "user-created-thread"), false);
    assert.deepEqual(access.listAgentThreads(), ["thread-created-by-first"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("MCP actor and ownership records survive a dashboard restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-mcp-persist-"));
  try {
    const first = new McpAccessManager(directory);
    const actor = first.registerActor();
    first.assignThread("persistent-thread", actor.actorId);

    const restarted = new McpAccessManager(directory);
    assert.equal(restarted.authenticateActor(request(actor.token)), actor.actorId);
    assert.equal(restarted.ownsThread(actor.actorId, "persistent-thread"), true);
    restarted.releaseThread("persistent-thread");
    assert.equal(restarted.ownsThread(actor.actorId, "persistent-thread"), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
