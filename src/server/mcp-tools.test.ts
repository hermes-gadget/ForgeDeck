import assert from "node:assert/strict";
import test from "node:test";
import { mcpClaimSessionsInputSchema, mcpGetSessionInputSchema, mcpWaitSessionInputSchema } from "../shared/contracts.js";
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from "./mcp-sdk.js";
import { MAX_MCP_RESPONSE_DIFF_CHARS } from "./mcp-presenters.js";
import { createForgeDeckMcpServer } from "./mcp-tools.js";
import type { ForgeDeckApiClient } from "./mcp-client.js";

test("MCP session history input defaults to 30 and caps pages at 100 items", () => {
  assert.deepEqual(mcpGetSessionInputSchema.parse({ id: "thread-12345678" }), {
    id: "thread-12345678",
    brief: false,
    limit: 30,
    offset: 0
  });
  assert.throws(
    () => mcpGetSessionInputSchema.parse({ id: "thread-12345678", limit: 101 }),
    /Too big/
  );
  assert.throws(
    () => mcpGetSessionInputSchema.parse({ id: "thread-12345678", cursor: "cursor", offset: 1 }),
    /offset must be zero/
  );
});

test("MCP wait and claim inputs apply defaults and normalize comma-separated IDs", () => {
  assert.deepEqual(mcpWaitSessionInputSchema.parse({ id: "thread-12345678" }), {
    id: "thread-12345678",
    timeout: 600
  });
  assert.deepEqual(mcpClaimSessionsInputSchema.parse({
    ids: "thread-12345678, thread-abcdefgh,thread-12345678"
  }), { ids: ["thread-12345678", "thread-abcdefgh"] });
});

test("MCP tools expose schemas and invoke the ForgeDeck API through the real protocol", async () => {
  const calls: Array<{ endpoint: string; options?: unknown }> = [];
  const workspace = process.cwd();
  const bootstrap = {
    roots: [workspace],
    models: { data: [{ id: "gpt-test", model: "gpt-test", displayName: "Test", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }] },
    claudeModelOptions: []
  };
  const accountStatus = {
    account: { account: { planType: "test" } },
    usage: { rateLimits: { primary: { usedPercent: 12, resetsAt: 2_000_000_000 } } },
    runtime: { available: true },
    backendStatus: {
      codex: { available: true },
      spark: { available: false },
      claude: { available: false, activeCount: 0, rateLimit: { primary: { usedPercent: 0 } }, modelOptions: [] }
    },
    claudeAvailable: false
  };
  const inspectionThread = {
    id: "thread-12345678",
    name: "Inspection",
    preview: "Patch-heavy work",
    cwd: workspace,
    provider: "codex",
    model: "gpt-test",
    reasoningEffort: "high",
    createdAt: "2026-07-16T12:00:00.000Z",
    updatedAt: "2026-07-16T12:00:00.000Z",
    status: { type: "idle" },
    turns: [{
      id: "turn-inspection",
      status: "completed",
      items: Array.from({ length: 40 }, (_, index) => ({
        id: `change-${index}`,
        type: index >= 38 ? "agentMessage" : "fileChange",
        text: index === 38 ? "Nearly done" : index === 39 ? "All done" : undefined,
        changes: [{ path: `file-${index}.ts`, diff: "+".repeat(10_000) }]
      }))
    }]
  };
  const api: ForgeDeckApiClient = {
    async get<T>(endpoint: string): Promise<T> {
      calls.push({ endpoint });
      if (endpoint === "/api/bootstrap") return bootstrap as T;
      if (endpoint === "/api/account/status") return accountStatus as T;
      if (endpoint === "/api/mcp/owned-threads") return { data: [] } as T;
      if (endpoint.startsWith("/api/threads?")) return { data: [inspectionThread] } as T;
      if (endpoint === "/api/threads/thread-12345678") return { thread: inspectionThread } as T;
      if (endpoint === "/api/queues?threadIds=thread-12345678") return { data: { "thread-12345678": [] } } as T;
      if (endpoint === "/api/sessions/thread-12345678/artifacts") return {
        data: [],
        completion: {
          status: "not-configured", artifactCount: 0, validArtifactCount: 0,
          requiredGateCount: 0, metGateCount: 0, unmetGates: []
        }
      } as T;
      throw new Error(`Unexpected test GET ${endpoint}`);
    },
    async request<T>(endpoint: string, options?: unknown): Promise<T> {
      calls.push({ endpoint, options });
      if (endpoint.includes("/messages")) return { accepted: true } as T;
      if (endpoint === "/api/mcp/owned-threads/claim") {
        return { actorId: "current-actor", threadIds: ["thread-12345678"] } as T;
      }
      if (endpoint === "/api/threads") {
        const body = (options as { body?: { provider?: string; model?: string; reasoningEffort?: string } })?.body || {};
        const provider = body.provider === "claude" ? "claude" : "codex";
        return {
          operation: {
            id: "11111111-1111-4111-8111-111111111111",
            status: "succeeded",
            links: { self: "/api/operations/11111111-1111-4111-8111-111111111111" },
            result: {
              thread: {
                id: provider === "claude" ? "claude-created1" : "thread-created1",
                name: "Created",
                preview: "",
                cwd: workspace,
                provider,
                model: body.model || "gpt-test",
                reasoningEffort: body.reasoningEffort || "high",
                createdAt: "2026-07-16T12:00:00.000Z",
                updatedAt: "2026-07-16T12:00:00.000Z",
                status: { type: "idle" },
                turns: []
              },
              initialTurnStarted: false,
              warnings: []
            }
          }
        } as T;
      }
      if (endpoint === "/api/threads/thread-12345678"
        && (options as { method?: string } | undefined)?.method === "DELETE") {
        return {
          operation: {
            id: "22222222-2222-4222-8222-222222222222",
            status: "succeeded",
            links: { self: "/api/operations/22222222-2222-4222-8222-222222222222" },
            result: { accepted: true, archived: true, threadId: "thread-12345678" }
          }
        } as T;
      }
      throw new Error(`Unexpected test request ${endpoint}`);
    }
  };
  const server = createForgeDeckMcpServer(api);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new ProtocolClient(clientTransport);

  try {
    await clientTransport.start();
    await server.connect(serverTransport);
    await client.request("initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "forgedeck-test", version: "1" }
    });
    await client.notify("notifications/initialized");

    const listed = await client.request("tools/list", {}) as { tools: Array<Record<string, unknown>> };
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.has("forgedeck_list_options"), true);
    assert.equal(byName.has("forgedeck_send_message"), true);
    assert.equal(byName.has("forgedeck_list_artifacts"), true);
    assert.equal(byName.has("forgedeck_get_artifact"), true);
    assert.equal(byName.has("forgedeck_publish_artifact"), true);
    assert.equal(listed.tools.length, 19);
    assert.equal(byName.has("forgedeck_spawn"), true);
    assert.equal(byName.has("forgedeck_stop"), true);
    assert.equal(byName.has("forgedeck_remove"), true);
    for (const removedName of [
      "forgedeck_spawn_session", "forgedeck_spawn_sessions",
      "forgedeck_stop_session", "forgedeck_stop_sessions",
      "forgedeck_remove_session", "forgedeck_remove_sessions"
    ]) assert.equal(byName.has(removedName), false);
    assert.deepEqual(Object.keys((byName.get("forgedeck_spawn")?.inputSchema as { properties: object }).properties), ["items"]);
    assert.deepEqual(Object.keys((byName.get("forgedeck_stop")?.inputSchema as { properties: object }).properties), ["ids"]);
    assert.deepEqual(Object.keys((byName.get("forgedeck_remove")?.inputSchema as { properties: object }).properties), ["ids"]);
    assert.equal(listed.tools.every((tool) => String(tool.description).length <= 80), true);
    assert.equal(byName.has("forgedeck_create_handoff"), true);
    assert.equal(byName.has("forgedeck_handoff_sessions"), true);
    assert.equal(byName.has("forgedeck_revoke_identity"), true);
    assert.equal(byName.has("forgedeck_wait"), true);
    assert.equal(byName.has("forgedeck_claim_sessions"), true);
    assert.equal((byName.get("forgedeck_list_options")?.annotations as { readOnlyHint?: boolean }).readOnlyHint, true);
    assert.equal(typeof byName.get("forgedeck_send_message")?.outputSchema, "object");
    assert.equal(
      Object.hasOwn((byName.get("forgedeck_get_session")?.inputSchema as { properties: object }).properties, "brief"),
      true
    );

    const options = await client.request("tools/call", { name: "forgedeck_list_options", arguments: {} }) as ToolCallResult;
    assert.equal(options.isError, undefined);
    assert.deepEqual(options.structuredContent.workspace_roots, [workspace]);
    assert.equal((options.structuredContent.usage as { codex: { available: boolean } }).codex.available, true);
    assert.deepEqual(options.structuredContent.presets, [
      { preset: "quick", label: "Quick", model: "gpt-5.6-luna", effort: "low" },
      { preset: "balanced", label: "Balanced", model: "gpt-5.6-sol", effort: "medium" },
      { preset: "deep", label: "Deep", model: "gpt-5.6-sol", effort: "xhigh" }
    ]);

    const spawned = await client.request("tools/call", {
      name: "forgedeck_spawn",
      arguments: {
        items: [{
          cwd: workspace,
          preset: "quick",
          fileScope: ["server.py"]
        }]
      }
    }) as ToolCallResult;
    assert.equal(spawned.isError, undefined);
    const spawnResults = spawned.structuredContent.results as Array<{ session: { id: string } }>;
    assert.equal(spawnResults[0].session.id, "thread-created1");
    assert.equal(spawned.structuredContent.ok, 1);
    assert.equal(spawned.structuredContent.failed, 0);
    const createCall = calls.find((call) => call.endpoint === "/api/threads");
    assert.equal(typeof (createCall?.options as { idempotencyKey?: unknown })?.idempotencyKey, "string");
    assert.deepEqual((createCall?.options as { body?: unknown })?.body, {
      cwd: workspace,
      provider: "codex",
      preset: "quick",
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      sessionClass: "standard",
      yolo: false,
      fileScope: ["server.py"],
      permissionMode: "default",
      maxTurns: 100,
      name: undefined,
      category: undefined,
      tags: [],
      prompt: undefined
    });

    const mixedSpawned = await client.request("tools/call", {
      name: "forgedeck_spawn",
      arguments: {
        items: [
          { cwd: workspace, provider: "claude", model: "sonnet", effort: "high", permissionMode: "plan", maxTurns: 80 },
          { cwd: workspace, provider: "codex", model: "gpt-test", effort: "high" }
        ]
      }
    }) as ToolCallResult;
    assert.equal(mixedSpawned.isError, undefined);
    assert.equal(mixedSpawned.structuredContent.ok, 2);
    assert.equal(mixedSpawned.structuredContent.failed, 0);
    const mixedBodies = calls.filter((call) => call.endpoint === "/api/threads").slice(-2)
      .map((call) => (call.options as { body: Record<string, unknown> }).body);
    const claudeBody = mixedBodies.find((body) => body.provider === "claude");
    const codexBody = mixedBodies.find((body) => body.provider === "codex");
    assert.deepEqual(claudeBody, {
      cwd: workspace,
      provider: "claude",
      preset: undefined,
      model: "sonnet",
      reasoningEffort: "high",
      sessionClass: "standard",
      yolo: false,
      permissionMode: "plan",
      maxTurns: 80,
      name: undefined,
      category: undefined,
      tags: [],
      prompt: undefined
    });
    assert.equal(codexBody?.model, "gpt-test");
    assert.equal(codexBody?.maxTurns, 100);

    const sent = await client.request("tools/call", {
      name: "forgedeck_send_message",
      arguments: {
        id: "thread-12345678",
        text: "Continue",
        model: "gpt-test",
        effort: "high",
        queue: true
      }
    }) as ToolCallResult;
    assert.equal(sent.isError, undefined);
    assert.equal(sent.structuredContent.delivery, "started");
    assert.equal(calls.some((call) => call.endpoint === "/api/threads/thread-12345678/messages"), true);

    const removed = await client.request("tools/call", {
      name: "forgedeck_remove",
      arguments: { ids: ["thread-12345678"] }
    }) as ToolCallResult;
    assert.equal(removed.isError, undefined);
    assert.deepEqual(removed.structuredContent, {
      results: [{ id: "thread-12345678", ok: true, error: null }],
      ok: 1,
      failed: 0
    });

    const sessionList = await client.request("tools/call", {
      name: "forgedeck_list_sessions",
      arguments: {}
    }) as ToolCallResult;
    const listedSession = (sessionList.structuredContent.sessions as Array<Record<string, unknown>>)[0];
    assert.equal(listedSession.health, "ok");
    assert.equal(listedSession.last_activity, "2026-07-16T12:00:00.000Z");
    assert.equal(listedSession.preview, "Patch-heavy work");
    assert.equal(listedSession.model, "gpt-test");
    assert.equal(listedSession.effort, "high");
    assert.equal(listedSession.files_count, 40);

    const inspected = await client.request("tools/call", {
      name: "forgedeck_get_session",
      arguments: { id: "thread-12345678" }
    }) as ToolCallResult;
    assert.equal(inspected.isError, undefined);
    const firstPage = inspected.structuredContent.pagination as {
      limit: number; returned_items: number; has_more: boolean; next_cursor: string
    };
    assert.equal(firstPage.limit, 30);
    assert.equal(firstPage.returned_items, 30);
    assert.equal(firstPage.has_more, true);
    assert.equal(inspected.structuredContent.health, "ok");
    assert.equal(inspected.structuredContent.last_message, "All done");
    assert.deepEqual(
      inspected.structuredContent.files,
      Array.from({ length: 40 }, (_, index) => `file-${39 - index}.ts`)
    );
    const firstItems = (inspected.structuredContent.recent_turns as Array<{ items: Array<{ id: string; changes: Array<{ diff: string }> }> }>)[0].items;
    assert.equal(firstItems[0].id, "change-10");
    assert.equal(firstItems.at(-1)?.id, "change-39");
    assert.equal(firstItems.reduce((total, item) => total + item.changes[0].diff.length, 0), MAX_MCP_RESPONSE_DIFF_CHARS);

    const cursorPage = await client.request("tools/call", {
      name: "forgedeck_get_session",
      arguments: { id: "thread-12345678", cursor: firstPage.next_cursor }
    }) as ToolCallResult;
    assert.equal(cursorPage.isError, undefined);
    const cursorItems = (cursorPage.structuredContent.recent_turns as Array<{ items: Array<{ id: string }> }>)[0].items;
    assert.deepEqual(cursorItems.map((item) => item.id), Array.from({ length: 10 }, (_, index) => `change-${index}`));

    const offsetPage = await client.request("tools/call", {
      name: "forgedeck_get_session",
      arguments: { id: "thread-12345678", limit: 10, offset: 30 }
    }) as ToolCallResult;
    assert.equal(offsetPage.isError, undefined);
    const offsetItems = (offsetPage.structuredContent.recent_turns as Array<{ items: Array<{ id: string }> }>)[0].items;
    assert.deepEqual(offsetItems.map((item) => item.id), Array.from({ length: 10 }, (_, index) => `change-${index}`));

    const queueCallsBeforeBrief = calls.filter((call) => call.endpoint.startsWith("/api/queues?")).length;
    const brief = await client.request("tools/call", {
      name: "forgedeck_get_session",
      arguments: { id: "thread-12345678", brief: true }
    }) as ToolCallResult;
    assert.equal(brief.isError, undefined);
    assert.deepEqual(brief.structuredContent.recent_agent_messages, ["Nearly done", "All done"]);
    assert.equal(brief.structuredContent.last_message, "All done");
    assert.deepEqual(Object.keys(brief.structuredContent.session as object), [
      "id", "name", "state", "cwd", "provider", "model", "effort"
    ]);
    assert.equal(Object.hasOwn(brief.structuredContent, "recent_turns"), false);
    assert.equal(Object.hasOwn(brief.structuredContent, "queued_messages"), false);
    assert.equal(Object.hasOwn(brief.structuredContent, "artifacts"), false);
    assert.equal(Object.hasOwn(brief.structuredContent, "pagination"), false);
    assert.equal(calls.filter((call) => call.endpoint.startsWith("/api/queues?")).length, queueCallsBeforeBrief);

    const waited = await client.request("tools/call", {
      name: "forgedeck_wait",
      arguments: { id: "thread-12345678", timeout: 1 }
    }) as ToolCallResult;
    assert.equal(waited.isError, undefined);
    assert.equal((waited.structuredContent.session as { state: string }).state, "completed");
    assert.equal(waited.structuredContent.last_message, "All done");

    const claimed = await client.request("tools/call", {
      name: "forgedeck_claim_sessions",
      arguments: { ids: "thread-12345678" }
    }) as ToolCallResult;
    assert.equal(claimed.isError, undefined);
    assert.deepEqual(claimed.structuredContent, { ids: ["thread-12345678"], actor: "current-actor" });
    const claimCall = calls.find((call) => call.endpoint === "/api/mcp/owned-threads/claim");
    assert.deepEqual((claimCall?.options as { body?: unknown }).body, { threadIds: ["thread-12345678"] });
  } finally {
    await server.close();
  }
});


type ToolCallResult = { structuredContent: Record<string, unknown>; isError?: boolean };

class ProtocolClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(private readonly transport: InstanceType<typeof InMemoryTransport>) {
    transport.onmessage = (message) => {
      if (!("id" in message) || typeof message.id !== "number") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if ("error" in message) pending.reject(new Error(String(message.error.message)));
      else pending.resolve("result" in message ? message.result : undefined);
    };
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    await this.transport.send({ jsonrpc: "2.0", id, method, params });
    return result;
  }

  notify(method: string): Promise<void> {
    return this.transport.send({ jsonrpc: "2.0", method });
  }
}
