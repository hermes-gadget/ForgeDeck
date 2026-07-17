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
  const access = new McpAccessManager(directory);
  try {
    assert.equal(fs.statSync(access.bootstrapTokenPath).mode & 0o777, 0o600);
    const bootstrap = fs.readFileSync(access.bootstrapTokenPath, "utf8").trim();
    assert.equal(access.isBootstrapRequest(request(bootstrap)), true);

    const first = access.registerActor("test:first");
    const second = access.registerActor("test:second");
    assert.equal(fs.statSync(path.join(directory, "mcp-access.json")).mode & 0o777, 0o600);
    assert.equal(access.authenticateActor(request(first.token)), first.actorId);
    assert.equal(access.authenticateActor(request(second.token)), second.actorId);

    access.assignThread("thread-created-by-first", first.actorId);
    assert.equal(access.ownsThread(first.actorId, "thread-created-by-first"), true);
    assert.equal(access.ownsThread(second.actorId, "thread-created-by-first"), false);
    assert.equal(access.ownsThread(first.actorId, "user-created-thread"), false);
    assert.deepEqual(access.listAgentThreads(), ["thread-created-by-first"]);
  } finally {
    access.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("MCP actor and ownership records survive a dashboard restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-mcp-persist-"));
  const first = new McpAccessManager(directory);
  let restarted: McpAccessManager | null = null;
  try {
    const actor = first.registerActor("persistent-client");
    first.assignThread("persistent-thread", actor.actorId);
    first.close();

    restarted = new McpAccessManager(directory);
    assert.equal(restarted.authenticateActor(request(actor.token)), actor.actorId);
    assert.equal(restarted.ownsThread(actor.actorId, "persistent-thread"), true);
    restarted.releaseThread("persistent-thread");
    assert.equal(restarted.ownsThread(actor.actorId, "persistent-thread"), false);
  } finally {
    first.close();
    restarted?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("MCP actors can explicitly claim sessions across identities", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-mcp-claim-"));
  const access = new McpAccessManager(directory);
  try {
    const previous = access.registerActor("previous-chat");
    const current = access.registerActor("current-chat");
    access.assignThread("cross-chat-thread", previous.actorId);

    assert.deepEqual(access.claimThreads(["cross-chat-thread", "cross-chat-thread"], current.actorId), ["cross-chat-thread"]);
    assert.equal(access.ownsThread(previous.actorId, "cross-chat-thread"), false);
    assert.equal(access.ownsThread(current.actorId, "cross-chat-thread"), true);
  } finally {
    access.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("scoped credential refresh and inactivity recovery preserve actor identity and ownership", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-mcp-rotate-"));
  let now = 1_000;
  const options = {
    actorLifetimeMs: 1_000,
    actorInactivityTtlMs: 100,
    rotationGraceMs: 20,
    now: () => now
  };
  const access = new McpAccessManager(directory, options);
  try {
    const original = access.registerActor("stable-client");
    access.assignThread("stable-thread", original.actorId);
    now += 50;
    const refreshed = access.refreshActor(original.actorId);
    assert.equal(refreshed.actorId, original.actorId);
    assert.notEqual(refreshed.token, original.token);
    assert.equal(access.authenticateActor(request(original.token)), original.actorId, "previous token has a short overlap");
    now += 21;
    assert.equal(access.authenticateActor(request(original.token)), null);

    now += 101;
    assert.equal(access.authenticateActor(request(refreshed.token)), null, "inactive credential expires without deleting identity");
    const recovered = access.registerActor("stable-client");
    assert.equal(recovered.actorId, original.actorId);
    assert.equal(access.authenticateActor(request(recovered.token)), original.actorId);
    assert.deepEqual(access.listOwnedThreads(original.actorId), ["stable-thread"]);
  } finally {
    access.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("one-time handoff transfers ownership and revocation releases remaining sessions", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-mcp-handoff-"));
  const access = new McpAccessManager(directory);
  try {
    const source = access.registerActor("handoff-source");
    const target = access.registerActor("handoff-target");
    access.assignThread("handoff-thread", source.actorId);
    access.assignThread("release-thread", source.actorId);

    const offer = access.createHandoff(target.actorId);
    const result = access.handoffThreads(source.actorId, offer.handoffToken, ["handoff-thread"]);
    assert.deepEqual(result, { targetActorId: target.actorId, threadIds: ["handoff-thread"] });
    assert.equal(access.ownsThread(target.actorId, "handoff-thread"), true);
    assert.throws(() => access.handoffThreads(source.actorId, offer.handoffToken, ["release-thread"]), /Invalid or expired/);

    assert.deepEqual(access.revokeActor(source.actorId), ["release-thread"]);
    assert.equal(access.authenticateActor(request(source.token)), null);
    assert.equal(access.ownerForThread("release-thread"), null);
    assert.equal(access.ownerForThread("handoff-thread"), target.actorId);
    const replacement = access.registerActor("handoff-source");
    assert.notEqual(replacement.actorId, source.actorId);
  } finally {
    access.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("MCP ownership reconciliation removes stale threads in one batch", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgedeck-mcp-reconcile-"));
  const access = new McpAccessManager(directory);
  let restarted: McpAccessManager | null = null;
  try {
    const actor = access.registerActor("reconcile-client");
    access.assignThread("existing-thread", actor.actorId);
    access.assignThread("phantom-thread", actor.actorId);
    assert.deepEqual(access.reconcileThreads(new Set(["existing-thread"])), ["phantom-thread"]);
    assert.deepEqual(access.listOwnedThreads(actor.actorId), ["existing-thread"]);
    access.close();
    restarted = new McpAccessManager(directory);
    assert.deepEqual(restarted.listOwnedThreads(actor.actorId), ["existing-thread"]);
  } finally {
    access.close();
    restarted?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
