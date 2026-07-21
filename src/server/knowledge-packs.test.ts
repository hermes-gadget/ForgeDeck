import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { KnowledgePackConflictError, KnowledgePackManager } from "./knowledge-packs.js";
import { SessionManager } from "./session-manager.js";
import { TransactionalStore } from "./store.js";

test("workspace knowledge packs persist rendered content and refresh after file changes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-knowledge-pack-"));
  const workspace = path.join(directory, "workspace");
  const source = path.join(workspace, "README.md");
  await fs.mkdir(workspace);
  await fs.writeFile(source, "First repository guide\n", "utf8");
  let store = await TransactionalStore.open(path.join(directory, "data"), 10_000);
  let now = 1_000;
  try {
    let manager = new KnowledgePackManager(store, () => now++);
    const created = await manager.create({
      name: "Repository guide",
      scope: "workspace",
      workspace,
      sources: [{ type: "file", reference: "README.md" }]
    });
    assert.equal(created.status, "ready");
    assert.match(created.content, /First repository guide/);
    assert.match(created.contentHash || "", /^sha256:[a-f0-9]{64}$/);
    const firstRefresh = created.refreshedAt;

    store.close();
    store = await TransactionalStore.open(path.join(directory, "data"), 10_000);
    manager = new KnowledgePackManager(store, () => now++);
    const cached = (await manager.list())[0];
    assert.equal(cached?.refreshedAt, firstRefresh);
    assert.match(cached?.content || "", /First repository guide/);

    await fs.writeFile(source, "Updated repository guide\n", "utf8");
    await fs.utimes(source, new Date(5_000), new Date(5_000));
    const refreshed = (await manager.list())[0];
    assert.match(refreshed?.content || "", /Updated repository guide/);
    assert.notEqual(refreshed?.contentHash, created.contentHash);
    assert.notEqual(refreshed?.refreshedAt, firstRefresh);

    await fs.rm(source);
    assert.equal((await manager.list())[0]?.status, "error");
    await fs.writeFile(source, "Recreated repository guide\n", "utf8");
    await fs.utimes(source, new Date(6_000), new Date(6_000));
    const recreated = (await manager.list())[0];
    assert.equal(recreated?.status, "ready");
    assert.match(recreated?.content || "", /Recreated repository guide/);
  } finally {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("global and workspace scopes select context for new sessions", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-knowledge-scope-"));
  const workspace = path.join(directory, "workspace");
  const otherWorkspace = path.join(directory, "other");
  const globalFile = path.join(directory, "global.md");
  await fs.mkdir(workspace);
  await fs.mkdir(otherWorkspace);
  await fs.writeFile(globalFile, "Global operating conventions", "utf8");
  await fs.writeFile(path.join(workspace, "local.md"), "Local repository map", "utf8");
  const store = await TransactionalStore.open(path.join(directory, "data"), 10_000);
  try {
    const manager = new KnowledgePackManager(store, () => 2_000);
    const global = await manager.create({
      name: "Global conventions",
      scope: "global",
      workspace: null,
      sources: [{ type: "file", reference: globalFile }]
    });
    const local = await manager.create({
      name: "Local map",
      scope: "workspace",
      workspace,
      sources: [{ type: "path", reference: "local.md" }]
    });
    assert.deepEqual(manager.packIdsForWorkspace(workspace), [global.id, local.id]);
    assert.deepEqual(manager.packIdsForWorkspace(otherWorkspace), [global.id]);
    const context = await manager.contextForIds([global.id, local.id]);
    assert.match(context, /Global operating conventions/);
    assert.match(context, /Local repository map/);
    assert.match(context, /<knowledge-pack-context>/);
  } finally {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("session pack selection and one-time injection state persist across handoffs", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-knowledge-handoff-"));
  const workspace = path.join(directory, "workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "guide.md"), "Persistent handoff context", "utf8");
  let now = 10_000;
  let sessions = await SessionManager.create(path.join(directory, "data"), () => now++);
  try {
    const pack = await sessions.knowledgePacks.create({
      name: "Handoff guide",
      scope: "workspace",
      workspace,
      sources: [{ type: "file", reference: "guide.md" }]
    });
    await sessions.setMetadata("thread-handoff", {
      cwd: workspace,
      knowledgePackIds: [pack.id],
      knowledgeContextInjectedAt: null
    });
    sessions.close();

    sessions = await SessionManager.create(path.join(directory, "data"), () => now++);
    assert.deepEqual(sessions.metadataFor("thread-handoff").knowledgePackIds, [pack.id]);
    assert.equal(sessions.metadataFor("thread-handoff").knowledgeContextInjectedAt, null);
    assert.match(await sessions.knowledgePacks.contextForIds([pack.id]), /Persistent handoff context/);
    await sessions.markKnowledgeContextInjected("thread-handoff");
    assert.ok(sessions.metadataFor("thread-handoff").knowledgeContextInjectedAt);
  } finally {
    sessions.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("pack names are unique within a scope", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-knowledge-name-"));
  const source = path.join(directory, "source.md");
  await fs.writeFile(source, "Context", "utf8");
  const store = await TransactionalStore.open(path.join(directory, "data"), 10_000);
  try {
    const manager = new KnowledgePackManager(store);
    await manager.create({ name: "Shared", scope: "global", workspace: null, sources: [{ type: "file", reference: source }] });
    await assert.rejects(
      manager.create({ name: "shared", scope: "global", workspace: null, sources: [{ type: "file", reference: source }] }),
      KnowledgePackConflictError
    );
  } finally {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("URL sources stay cached until explicit refresh", async () => {
  let body = "Remote guide version one";
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-knowledge-url-"));
  const store = await TransactionalStore.open(path.join(directory, "data"), 10_000);
  try {
    const manager = new KnowledgePackManager(store);
    const created = await manager.create({
      name: "Remote guide",
      scope: "global",
      workspace: null,
      sources: [{ type: "url", reference: `http://127.0.0.1:${address.port}/guide` }]
    });
    assert.match(created.content, /version one/);
    body = "Remote guide version two";
    assert.match((await manager.get(created.id))?.content || "", /version one/);
    assert.match((await manager.refresh(created.id))?.content || "", /version two/);
  } finally {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
