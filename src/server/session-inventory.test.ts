import assert from "node:assert/strict";
import test from "node:test";
import { SessionInventoryIndex, type InventoryItem, type InventoryQuery } from "./session-inventory.js";

const baseQuery: InventoryQuery = {
  limit: 2,
  sortKey: "updated_at",
  sortDirection: "desc",
  filters: { archiveState: "active" }
};

test("inventory scans are coalesced until TTL expiry or revision invalidation", async () => {
  let loads = 0;
  let now = 1_000;
  const index = new SessionInventoryIndex(async () => {
    loads += 1;
    return [thread("one", 1)];
  }, { now: () => now, refreshTtlMs: 100, snapshotRetentionMs: 1_000 });

  const first = await index.query(baseQuery);
  const cached = await index.query(baseQuery);
  assert.equal(loads, 1);
  assert.equal(cached.revision, first.revision);

  index.invalidate();
  const invalidated = await index.query(baseQuery);
  assert.equal(loads, 2);
  assert.notEqual(invalidated.revision, first.revision);

  now += 101;
  await index.query(baseQuery);
  assert.equal(loads, 3);
});

test("keyset cursors keep paginating their original revision during concurrent updates", async () => {
  let inventory = [thread("a", 40), thread("b", 30), thread("c", 20), thread("d", 10)];
  const index = new SessionInventoryIndex(async () => inventory, { snapshotRetentionMs: 10_000 });

  const first = await index.query(baseQuery);
  assert.deepEqual(first.data.map((item) => item.id), ["a", "b"]);
  assert.ok(first.nextCursor);

  inventory = [thread("new", 50), ...inventory];
  index.invalidate();
  const newest = await index.query(baseQuery);
  assert.deepEqual(newest.data.map((item) => item.id), ["new", "a"]);
  assert.notEqual(newest.revision, first.revision);

  const second = await index.query({ ...baseQuery, cursor: first.nextCursor! });
  assert.equal(second.revision, first.revision);
  assert.deepEqual(second.data.map((item) => item.id), ["c", "d"]);
});

test("cursors expire after the bounded snapshot retention window", async () => {
  let now = 1_000;
  const index = new SessionInventoryIndex(async () => [thread("a", 2), thread("b", 1)], {
    now: () => now,
    refreshTtlMs: 50,
    snapshotRetentionMs: 100
  });
  const first = await index.query({ ...baseQuery, limit: 1 });
  assert.ok(first.nextCursor);
  now += 101;
  await assert.rejects(
    () => index.query({ ...baseQuery, limit: 1, cursor: first.nextCursor! }),
    (error: unknown) => (error as { code?: unknown }).code === "INVENTORY_CURSOR_EXPIRED"
  );
});

test("inventory search covers prompts and facets filter combined provider summaries", async () => {
  const index = new SessionInventoryIndex(async () => [
    thread("codex", 30, {
      name: "API cleanup",
      model: "gpt-5",
      cwd: "/work/forge",
      tags: ["backend"],
      category: "maintenance",
      queueState: "queued",
      owner: "mcp:12345678",
      source: "mcp",
      turns: [{ items: [{ type: "userMessage", content: [{ type: "text", text: "Find the sapphire regression" }] }] }]
    }),
    thread("claude", 20, {
      backend: "claude",
      model: "sonnet",
      cwd: "/work/site",
      tags: ["frontend"],
      source: "user",
      owner: "local"
    }),
    thread("archived", 10, { archiveState: "archived", source: "external" })
  ]);

  const search = await index.query({ ...baseQuery, limit: 20, search: "sapphire" });
  assert.deepEqual(search.data.map((item) => item.id), ["codex"]);
  assert.deepEqual(search.facets.archiveState, [{ value: "active", count: 1 }]);

  const active = await index.query({ ...baseQuery, limit: 20 });
  assert.deepEqual(active.facets.archiveState, [{ value: "active", count: 2 }, { value: "archived", count: 1 }]);

  const filtered = await index.query({
    ...baseQuery,
    limit: 20,
    filters: {
      archiveState: "active",
      backend: "codex",
      model: "gpt-5",
      workspace: "/work/forge",
      label: "backend",
      queueState: "queued",
      owner: "mcp:12345678",
      source: "mcp",
      dateFrom: 25_000,
      dateTo: 35_000
    }
  });
  assert.deepEqual(filtered.data.map((item) => item.id), ["codex"]);
  assert.deepEqual(filtered.facets.labels, [{ value: "backend", count: 1 }, { value: "maintenance", count: 1 }]);

  const archived = await index.query({ ...baseQuery, limit: 20, filters: { archiveState: "archived" } });
  assert.deepEqual(archived.data.map((item) => item.id), ["archived"]);
});

function thread(id: string, updatedAt: number, overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id,
    name: id,
    preview: "",
    cwd: "/work",
    backend: "codex",
    sessionClass: "standard",
    model: "gpt-5",
    createdAt: updatedAt,
    updatedAt,
    status: { type: "idle" },
    turns: [],
    tags: [],
    queueState: "empty",
    owner: "local",
    source: "user",
    archiveState: "active",
    ...overrides
  };
}
