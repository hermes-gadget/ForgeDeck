import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTRACT_SCHEMA_VERSION,
  MODEL_PRESETS,
  createSessionRequestSchema,
  mcpSpawnSessionInputSchema,
  mcpSessionSummarySchema,
  messageRequestSchema,
  parseHttpRequest,
  parseHttpResponse,
  parseSseEnvelope,
  serializeSseEnvelope,
  timestampSchema,
  webhookTriggerRequestSchema
} from "./contracts.js";

test("session requests normalize canonical names and retain legacy aliases at the adapter", () => {
  const legacy = createSessionRequestSchema.parse({
    cwd: "/workspace",
    backend: "claude",
    class: "standard",
    model: "sonnet",
    effort: "high"
  });
  assert.equal(legacy.provider, "claude");
  assert.equal(legacy.sessionClass, "standard");
  assert.equal(legacy.reasoningEffort, "high");
  assert.equal(legacy.leaseMode, "exclusive");
  assert.equal(legacy.fileScope, undefined);

  const canonical = createSessionRequestSchema.parse({
    cwd: "/workspace",
    provider: "codex",
    sessionClass: "spark",
    model: "gpt-5.3-codex-spark",
    reasoningEffort: "high",
    guardian: { stallTimeoutMinutes: 8, escalationModel: "gpt-5.6-sol" }
  });
  assert.equal(canonical.provider, "codex");
  assert.equal(canonical.sessionClass, "spark");
  assert.equal(canonical.reasoningEffort, "high");
  assert.deepEqual(canonical.guardian, { stallTimeoutMinutes: 8, escalationModel: "gpt-5.6-sol" });

  assert.equal(createSessionRequestSchema.safeParse({
    cwd: "/workspace",
    provider: "codex",
    backend: "claude",
    model: "gpt-test"
  }).success, false);
  assert.equal(createSessionRequestSchema.safeParse({
    cwd: "/workspace",
    model: "gpt-test",
    leaseMode: "read-only",
    yolo: true
  }).success, false);
  assert.deepEqual(createSessionRequestSchema.parse({
    cwd: "/workspace",
    model: "gpt-test",
    fileScope: ["server.py", "src/index.ts"]
  }).fileScope, ["server.py", "src/index.ts"]);
  assert.equal(createSessionRequestSchema.safeParse({
    cwd: "/workspace",
    model: "gpt-test",
    fileScope: ["../outside.ts"]
  }).success, false);
  assert.equal(createSessionRequestSchema.safeParse({
    cwd: "/workspace",
    model: "gpt-test",
    fileScope: ["/etc/passwd"]
  }).success, false);
});

test("model presets resolve transparently and reject conflicting manual settings", () => {
  assert.deepEqual(MODEL_PRESETS, {
    quick: { label: "Quick", model: "gpt-5.6-luna", effort: "low" },
    balanced: { label: "Balanced", model: "gpt-5.6-sol", effort: "medium" },
    deep: { label: "Deep", model: "gpt-5.6-sol", effort: "xhigh" }
  });
  const quick = createSessionRequestSchema.parse({ cwd: "/workspace", preset: "quick" });
  assert.equal(quick.preset, "quick");
  assert.equal(quick.model, "gpt-5.6-luna");
  assert.equal(quick.reasoningEffort, "low");
  assert.equal(createSessionRequestSchema.safeParse({
    cwd: "/workspace", preset: "deep", model: "gpt-5.6-luna", reasoningEffort: "low"
  }).success, false);
  assert.equal(createSessionRequestSchema.safeParse({ cwd: "/workspace", provider: "claude", preset: "balanced" }).success, false);

  assert.equal(mcpSpawnSessionInputSchema.safeParse({ cwd: "/workspace", preset: "balanced" }).success, true);
  assert.equal(mcpSpawnSessionInputSchema.safeParse({ cwd: "/workspace", model: "gpt-test" }).success, false);
  assert.deepEqual(mcpSpawnSessionInputSchema.parse({ cwd: "/workspace", preset: "balanced" }), {
    cwd: "/workspace",
    provider: "codex",
    preset: "balanced",
    class: "standard",
    yolo: false,
    permissionMode: "default",
    maxTurns: 100,
    tags: []
  });
  assert.equal(mcpSpawnSessionInputSchema.safeParse({
    cwd: "/workspace", provider: "claude", model: "sonnet", effort: "high",
    permissionMode: "plan", maxTurns: 80
  }).success, true);
  assert.equal(mcpSpawnSessionInputSchema.safeParse({
    cwd: "/workspace", provider: "claude", model: "sonnet", effort: "high", maxTurns: 101
  }).success, false);
});

test("message requests accept effort only as a temporary alias", () => {
  const parsed = messageRequestSchema.parse({ text: "Continue", model: "gpt-test", effort: "medium" });
  assert.equal(parsed.reasoningEffort, "medium");
  assert.equal(messageRequestSchema.safeParse({
    text: "Continue",
    model: "gpt-test",
    effort: "medium",
    reasoningEffort: "high"
  }).success, false);
});

test("comparison contracts require distinct model branches and normalize result timestamps", () => {
  const request = parseHttpRequest("POST", "/api/compare", {
    prompt: "Review this workspace",
    workspace: "/workspace",
    models: [
      { provider: "codex", model: "model-a", reasoningEffort: "low" },
      { provider: "codex", model: "model-b", reasoningEffort: "high" }
    ]
  }) as {
    prompt: string;
    workspace: string;
    models: Array<{ provider: "codex" | "claude"; model: string; reasoningEffort: string | null }>;
    judge: null;
  };
  assert.equal(request.models.length, 2);
  assert.equal(request.judge, null);
  assert.throws(() => parseHttpRequest("POST", "/api/compare", { ...request, models: [request.models[0], request.models[0]] }));
  assert.throws(() => parseHttpRequest("POST", "/api/compare", { ...request, models: [request.models[0]] }));
});

test("policy HTTP contracts validate field-specific values and CRUD responses", () => {
  const request = parseHttpRequest("POST", "/api/policies", {
    name: "Concurrency ceiling",
    condition: { field: "max_concurrency", operator: "greater_than_or_equal", value: 4 },
    action: "block"
  }) as { condition: { value: number } };
  assert.equal(request.condition.value, 4);
  assert.throws(() => parseHttpRequest("POST", "/api/policies", {
    name: "Invalid time",
    condition: { field: "time_of_day", operator: "greater_than", value: "25:00" },
    action: "warn"
  }));
  assert.deepEqual(parseHttpRequest("DELETE", "/api/policies", { id: "11111111-1111-4111-8111-111111111111" }), {
    id: "11111111-1111-4111-8111-111111111111"
  });
  const response = parseHttpResponse("GET", "/api/policies", {
    data: [{
      id: "11111111-1111-4111-8111-111111111111",
      name: "Concurrency ceiling",
      condition: { field: "max_concurrency", operator: "greater_than_or_equal", value: 4 },
      action: "block",
      createdAt: 1,
      updatedAt: 1
    }]
  }) as { data: Array<{ createdAt: string }> };
  assert.equal(response.data[0]?.createdAt, "1970-01-01T00:00:01.000Z");
});

test("webhook trigger requests accept bounded blueprint inputs and optional overrides", () => {
  assert.deepEqual(webhookTriggerRequestSchema.parse({ blueprint: " Release agent " }), {
    blueprint: "Release agent",
    variables: {}
  });
  assert.equal(webhookTriggerRequestSchema.safeParse({
    blueprint: "Release agent",
    variables: { SERVICE: "checkout", RETRIES: 2, DRY_RUN: true },
    workspace: "/workspace",
    model: "gpt-test"
  }).success, true);
  assert.equal(webhookTriggerRequestSchema.safeParse({
    blueprint: "Release agent",
    variables: { nested: { unsafe: true } }
  }).success, false);
  assert.equal(webhookTriggerRequestSchema.safeParse({ blueprint: "Release agent", extra: true }).success, false);
});

test("protocol timestamps normalize legacy epoch seconds and milliseconds to ISO 8601", () => {
  assert.equal(timestampSchema.parse(2_000_000_000), "2033-05-18T03:33:20.000Z");
  assert.equal(timestampSchema.parse(2_000_000_000_000), "2033-05-18T03:33:20.000Z");
  assert.equal(timestampSchema.parse("2033-05-18T03:33:20.000Z"), "2033-05-18T03:33:20.000Z");
  assert.equal(timestampSchema.safeParse("18 May 2033").success, false);
});

test("SSE contracts validate the envelope, event id, thread id, and typed payload", () => {
  const envelope = serializeSseEnvelope("queue", {
    threadId: "thread-12345678",
    queue: [{ id: "queue-1", text: "Continue", model: "gpt-test", effort: "high", createdAt: 2_000_000_000 }],
    error: null
  }, 42, "thread-12345678");
  assert.equal(envelope.schemaVersion, CONTRACT_SCHEMA_VERSION);
  assert.equal(envelope.payload.queue[0]?.createdAt, "2033-05-18T03:33:20.000Z");
  assert.equal(parseSseEnvelope("queue", envelope, "42").eventId, 42);
  assert.throws(() => parseSseEnvelope("queue", envelope, "41"), /does not match/);
  assert.throws(() => parseSseEnvelope("queue", { ...envelope, payload: { queue: "invalid" } }));

  const guardian = serializeSseEnvelope("guardian", {
    threadId: "thread-12345678",
    reason: "retrying",
    guardian: {
      threadId: "thread-12345678",
      phase: "retrying",
      active: true,
      recoveryAttempts: 1,
      maxRecoveryAttempts: 3,
      lastActivityAt: 2_000_000_000,
      stalledAt: 2_000_000_000,
      lastActionAt: 2_000_000_000,
      actionModel: null,
      operatorNotifiedAt: null,
      recoveredAt: null,
      updatedAt: 2_000_000_000,
      error: null,
      policy: { stallTimeoutMs: 60_000, escalationModel: null }
    }
  }, 43, "thread-12345678");
  assert.equal(guardian.payload.guardian.lastActivityAt, "2033-05-18T03:33:20.000Z");
});

test("HTTP and MCP adapters reuse resource schemas and emit canonical provider fields", () => {
  const response = parseHttpResponse("GET", "/api/threads/thread-12345678", {
    thread: {
      id: "thread-12345678",
      name: null,
      preview: "",
      cwd: "/workspace",
      backend: "claude",
      claudeModel: "sonnet",
      claudeEffort: "high",
      createdAt: 2_000_000_000,
      updatedAt: 2_000_000_001,
      recencyAt: null,
      status: { type: "idle" },
      turns: []
    }
  }) as { thread: { provider: string; model: string | null; reasoningEffort: string | null; createdAt: string } };
  assert.deepEqual(
    [response.thread.provider, response.thread.model, response.thread.reasoningEffort],
    ["claude", "sonnet", "high"]
  );
  assert.match(response.thread.createdAt, /^2033-05-18T/);

  const mcp = mcpSessionSummarySchema.parse({
    id: "thread-12345678",
    name: null,
    preview: "",
    cwd: "/workspace",
    created_at: 2_000_000_000,
    updated_at: 2_000_000_001,
    category: null,
    tags: [],
    provider: "claude",
    backend: "claude",
    session_class: "standard",
    model: "sonnet",
    reasoning_effort: "high",
    state: "idle",
    agent_owned: true,
    mutation_access: "allowed"
  });
  assert.equal(mcp.provider, "claude");
  assert.equal(mcp.created_at, "2033-05-18T03:33:20.000Z");
});

test("durable operation resources expose resumable state and normalize timestamps", () => {
  const response = parseHttpResponse("GET", "/api/operations/11111111-1111-4111-8111-111111111111", {
    operation: {
      id: "11111111-1111-4111-8111-111111111111",
      kind: "create",
      idempotencyKey: "create-1",
      status: "retrying",
      currentStep: "discovering_remote",
      remoteThreadId: null,
      attemptCount: 2,
      compensation: { remoteMutation: "indeterminate", discoveryBaselineSize: 4 },
      terminal: false,
      result: null,
      error: { code: "CODEX_TIMEOUT" },
      nextAttemptAt: 2_000_000_001,
      createdAt: 2_000_000_000,
      updatedAt: 2_000_000_000,
      completedAt: null,
      links: { self: "/api/operations/11111111-1111-4111-8111-111111111111" }
    }
  }) as { operation: { status: string; attemptCount: number; createdAt: string; nextAttemptAt: string } };
  assert.equal(response.operation.status, "retrying");
  assert.equal(response.operation.attemptCount, 2);
  assert.equal(response.operation.createdAt, "2033-05-18T03:33:20.000Z");
  assert.equal(response.operation.nextAttemptAt, "2033-05-18T03:33:21.000Z");
});

test("guardian action routes accept empty retries and bounded explicit escalations", () => {
  assert.deepEqual(parseHttpRequest("POST", "/api/sessions/thread-12345678/guardian/retry", undefined), {});
  assert.deepEqual(parseHttpRequest("POST", "/api/sessions/thread-12345678/guardian/escalate", { model: "gpt-5.6-sol" }), {
    model: "gpt-5.6-sol"
  });
  assert.throws(() => parseHttpRequest("POST", "/api/sessions/thread-12345678/guardian/escalate", { model: "bad model" }));
});

test("archive APIs expose reasons, countdowns, restore, and TTL exemptions", () => {
  assert.deepEqual(parseHttpRequest("POST", "/api/sessions/thread-12345678/restore", undefined), {});
  assert.deepEqual(parseHttpRequest("POST", "/api/sessions/thread-12345678/pin", { pinned: true }), { pinned: true });
  assert.throws(() => parseHttpRequest("POST", "/api/sessions/thread-12345678/pin", { pinned: "yes" }));

  const response = parseHttpResponse("GET", "/api/archive", {
    data: [{
      id: "thread-12345678",
      name: "Archived work",
      cwd: "/workspace",
      backend: "codex",
      sessionClass: "standard",
      archivedAt: 2_000_000_000_000,
      reason: "ttl",
      pinned: false,
      restorable: true,
      ttlHours: 24,
      permanentDeletionAt: 2_002_592_000_000,
      remainingTimeMs: 2_592_000_000,
      daysUntilPermanentDeletion: 30
    }],
    retention: { ttlHours: 24, sparkTtlHours: 1, archiveRetentionHours: 720 }
  }) as { data: Array<{ archivedAt: string; permanentDeletionAt: string | null }> };
  assert.equal(response.data[0].archivedAt, "2033-05-18T03:33:20.000Z");
  assert.equal(response.data[0].permanentDeletionAt, "2033-06-17T03:33:20.000Z");
});

test("workspace lease APIs validate modes and normalize active lease timestamps", () => {
  assert.deepEqual(parseHttpRequest("POST", "/api/sessions/thread-12345678/lease", { mode: "read-only" }), {
    mode: "read-only"
  });
  assert.deepEqual(parseHttpRequest("POST", "/api/sessions/thread-12345678/lease", { mode: null }), {
    mode: null
  });
  assert.throws(() => parseHttpRequest("POST", "/api/sessions/thread-12345678/lease", { mode: "shared-write" }));

  const response = parseHttpResponse("GET", "/api/workspaces/%2Fworkspace/leases", {
    root: "/workspace",
    state: "exclusive",
    leases: [{
      sessionId: "thread-12345678",
      root: "/workspace",
      mode: "exclusive",
      acquiredAt: 2_000_000_000
    }]
  }) as { leases: Array<{ acquiredAt: string }> };
  assert.equal(response.leases[0].acquiredAt, "2033-05-18T03:33:20.000Z");
});

test("timeline, universal search, and analytics responses normalize event timestamps", () => {
  const timeline = parseHttpResponse("GET", "/api/sessions/thread-12345678/timeline", {
    session: { id: "thread-12345678", name: "Checkout", model: "gpt-test" },
    events: [{
      id: "sse:12",
      revision: 12,
      threadId: "thread-12345678",
      type: "codex",
      timestamp: 2_000_000_000,
      summary: "Turn completed",
      payloadSummary: { method: "turn/completed" },
      model: "gpt-test",
      outcome: "success",
      error: null,
      durationMs: 1_500
    }],
    truncated: false
  }) as { events: Array<{ timestamp: string }> };
  assert.equal(timeline.events[0]?.timestamp, "2033-05-18T03:33:20.000Z");

  const search = parseHttpResponse("GET", "/api/search?q=checkout", {
    data: [{
      sessionId: "thread-12345678",
      name: "Checkout",
      prompt: "Fix checkout",
      model: "gpt-test",
      outcome: "success",
      error: null,
      startedAt: 2_000_000_000,
      completedAt: 2_000_000_001,
      durationMs: 1_000,
      matchedEvent: "Prompt submitted"
    }],
    total: 1
  }) as { data: Array<{ completedAt: string }> };
  assert.equal(search.data[0]?.completedAt, "2033-05-18T03:33:21.000Z");

  const analytics = parseHttpResponse("GET", "/api/analytics", {
    generatedAt: 2_000_000_001,
    totals: { sessions: 1, runs: 1, successful: 1, failed: 0, successRate: 100, avgCompletionTimeMs: 1_000 },
    byModel: [{ model: "gpt-test", runs: 1, successful: 1, failed: 0, successRate: 100, avgCompletionTimeMs: 1_000 }],
    commonErrors: []
  }) as { generatedAt: string };
  assert.equal(analytics.generatedAt, "2033-05-18T03:33:21.000Z");
});

test("artifact HTTP contracts validate typed submissions, provenance, and completion gates", () => {
  const request = parseHttpRequest("POST", "/api/sessions/thread-12345678/artifacts", {
    type: "ReviewVerdictArtifact",
    name: "security-review",
    retention: { policy: "persistent", sensitive: false },
    provenance: { trust: "human" },
    content: {
      verdict: "approved",
      summary: "No blocking findings",
      findings: []
    }
  }) as { type: string; content: { verdict: string } };
  assert.equal(request.type, "ReviewVerdictArtifact");
  assert.equal(request.content.verdict, "approved");
  assert.throws(() => parseHttpRequest("POST", "/api/sessions/thread-12345678/artifacts", {
    type: "TestResultArtifact",
    name: "tests",
    content: { command: "npm test", status: "passed", exitCode: 0, unexpected: true }
  }));

  const response = parseHttpResponse("GET", "/api/sessions/thread-12345678/artifacts", {
    data: [],
    completion: {
      status: "pending",
      artifactCount: 0,
      validArtifactCount: 0,
      requiredGateCount: 1,
      metGateCount: 0,
      unmetGates: [{
        name: "tests",
        description: "Tests pass",
        required: true,
        artifactType: "TestResultArtifact",
        reason: "No valid TestResultArtifact satisfies this gate",
        trust: "deterministic"
      }]
    }
  }) as { completion: { status: string; unmetGates: unknown[] } };
  assert.equal(response.completion.status, "pending");
  assert.equal(response.completion.unmetGates.length, 1);
});

test("session export contracts accept structured JSON and Markdown downloads", () => {
  const json = parseHttpResponse("GET", "/api/sessions/thread-12345678/export?format=json", {
    schemaVersion: 1,
    provenance: {
      sessionId: "thread-12345678",
      exportedAt: 2_000_000_000_000,
      createdAt: 2_000_000_000_000,
      updatedAt: 2_000_000_001_000,
      blueprintId: null,
      blueprintVersion: null
    },
    session: {
      name: "Export",
      preview: null,
      status: "completed",
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      sessionClass: "standard",
      workspace: "ForgeDeck",
      category: null,
      tags: [],
      durationMs: 1_000,
      turnCount: 0
    },
    prompt: null,
    runs: [],
    artifactSummaries: [],
    keyOutputs: [],
    privacy: {
      secretsRedacted: true,
      rawToolOutputIncluded: false,
      absoluteWorkspacePathsIncluded: false
    }
  }) as { provenance: { updatedAt: string } };
  assert.equal(json.provenance.updatedAt, "2033-05-18T03:33:21.000Z");
  assert.equal(parseHttpResponse("GET", "/api/sessions/thread-12345678/export?format=markdown", "# Export\n"), "# Export\n");
});

test("schedule contracts validate timing and normalize durable run timestamps", () => {
  const request = parseHttpRequest("POST", "/api/schedules", {
    name: "Morning review",
    blueprintId: "review-agent",
    variables: { TARGET: "payments" },
    timing: { type: "cron", expression: "0 9 * * 1-5" }
  }) as { timing: { type: string; expression: string } };
  assert.deepEqual(request.timing, { type: "cron", expression: "0 9 * * 1-5" });
  assert.throws(() => parseHttpRequest("POST", "/api/schedules", {
    blueprintId: "review-agent",
    timing: { type: "interval", intervalMs: 1_000 }
  }));

  const response = parseHttpResponse("GET", "/api/schedules", {
    data: [{
      id: "schedule-1",
      name: "Morning review",
      blueprintId: "review-agent",
      blueprintVersion: 2,
      variables: { TARGET: "payments" },
      workspace: "/workspace",
      timing: { type: "cron", expression: "0 9 * * 1-5" },
      createdAt: 2_000_000_000_000,
      updatedAt: 2_000_000_000_000,
      lastRunAt: 2_000_000_000_000,
      nextRunAt: 2_000_000_060_000,
      recentRuns: [{
        id: "run-1",
        scheduleId: "schedule-1",
        scheduledAt: 2_000_000_000_000,
        startedAt: 2_000_000_000_000,
        completedAt: 2_000_000_001_000,
        status: "succeeded",
        operationId: "operation-1",
        threadId: "thread-12345678",
        error: null
      }]
    }]
  }) as { data: Array<{ createdAt: string; recentRuns: Array<{ completedAt: string }> }> };
  assert.match(response.data[0]!.createdAt, /^2033-05-18T/);
  assert.match(response.data[0]!.recentRuns[0]!.completedAt, /^2033-05-18T/);
});

test("mission contracts validate DAG mappings and normalize durable progress", () => {
  const request = parseHttpRequest("POST", "/api/missions", {
    name: "Release mission",
    nodes: [{
      id: "analyze",
      blueprintId: "review-agent",
      dependsOn: [],
      inputMapping: { TARGET: { source: "mission", key: "target" } },
      outputMapping: { summary: "text" }
    }]
  }) as { nodes: Array<{ inputMapping: Record<string, unknown> }> };
  assert.equal(request.nodes[0]?.inputMapping.TARGET !== undefined, true);
  assert.throws(() => parseHttpRequest("POST", "/api/missions", {
    name: "Invalid",
    nodes: [{ id: "node", blueprintId: "agent", inputMapping: { X: { source: "unknown" } } }]
  }));

  const response = parseHttpResponse("GET", "/api/missions", {
    data: [{
      schemaVersion: 1,
      id: "release-mission",
      name: "Release mission",
      description: "",
      version: 1,
      createdAt: 2_000_000_000_000,
      nodes: [{
        id: "analyze",
        name: "Analyze",
        blueprintId: "review-agent",
        blueprintVersion: 2,
        dependsOn: [],
        inputMapping: { TARGET: { source: "mission", key: "target" } },
        outputMapping: { summary: "text" }
      }],
      state: "running",
      latestRun: {
        id: "11111111-1111-4111-8111-111111111111",
        missionId: "release-mission",
        missionVersion: 1,
        state: "running",
        inputs: { target: "payments" },
        workspace: "/workspace",
        outputs: {},
        nodes: [{
          nodeId: "analyze",
          state: "running",
          inputs: { TARGET: "payments" },
          outputs: {},
          operationId: "operation-1",
          threadId: "thread-12345678",
          error: null,
          startedAt: 2_000_000_000_000,
          completedAt: null
        }],
        error: null,
        createdAt: 2_000_000_000_000,
        startedAt: 2_000_000_000_000,
        updatedAt: 2_000_000_001_000,
        completedAt: null
      }
    }]
  }) as { data: Array<{ createdAt: string; latestRun: { updatedAt: string } }> };
  assert.match(response.data[0]!.createdAt, /^2033-05-18T/);
  assert.match(response.data[0]!.latestRun.updatedAt, /^2033-05-18T/);
});

test("eval contracts validate definitions and normalize versioned results", () => {
  const request = parseHttpRequest("POST", "/api/evals", {
    name: "Model comparison",
    blueprintId: "review-agent",
    variables: { TARGET: "payments" },
    workspace: "/workspace",
    models: [{ provider: "codex", model: "gpt-5.6-sol", reasoningEffort: "medium" }],
    successCriteria: {
      requiredPhrases: ["tests pass"],
      forbiddenPhrases: ["cannot"],
      maxDurationMs: 60_000,
      maxTotalTokens: 5_000,
      requireBlueprintGates: true
    }
  }) as { models: unknown[]; successCriteria: { maxTotalTokens: number } };
  assert.equal(request.models.length, 1);
  assert.equal(request.successCriteria.maxTotalTokens, 5_000);
  assert.throws(() => parseHttpRequest("POST", "/api/evals", {
    name: "Duplicate models",
    blueprintId: "review-agent",
    workspace: "/workspace",
    models: [
      { provider: "codex", model: "gpt-5.6-sol" },
      { provider: "codex", model: "gpt-5.6-sol" }
    ],
    successCriteria: {}
  }));

  const response = parseHttpResponse("GET", "/api/evals/11111111-1111-4111-8111-111111111111", {
    eval: {
      schemaVersion: 1,
      id: "11111111-1111-4111-8111-111111111111",
      version: 2,
      name: "Model comparison",
      blueprint: { id: "review-agent", version: 3, name: "Review agent" },
      variables: { TARGET: "payments" },
      workspace: "/workspace",
      prompt: "Review payments",
      successCriteria: {
        requiredPhrases: [], forbiddenPhrases: [], maxDurationMs: null,
        maxTotalTokens: null, requireBlueprintGates: true
      },
      status: "completed",
      passed: true,
      createdAt: 2_000_000_000_000,
      startedAt: 2_000_000_001_000,
      completedAt: 2_000_000_002_000,
      results: [{
        model: { provider: "codex", model: "gpt-5.6-sol", reasoningEffort: "medium" },
        status: "passed",
        operationId: "22222222-2222-4222-8222-222222222222",
        threadId: "thread-12345678",
        startedAt: 2_000_000_001_000,
        completedAt: 2_000_000_002_000,
        durationMs: 1_000,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        output: "Done",
        error: null,
        score: { scorerVersion: 1, passed: true, criteria: [] }
      }]
    }
  }) as { eval: { version: number; completedAt: string; results: Array<{ totalTokens: number }> } };
  assert.equal(response.eval.version, 2);
  assert.equal(response.eval.completedAt, "2033-05-18T03:33:22.000Z");
  assert.equal(response.eval.results[0].totalTokens, 150);
});

test("knowledge pack contracts validate scopes, sources, and cached previews", () => {
  const request = parseHttpRequest("POST", "/api/knowledge-packs", {
    name: "Repository guide",
    scope: "workspace",
    workspace: "/workspace",
    sources: [
      { type: "file", reference: "README.md" },
      { type: "url", reference: "https://example.com/guide" }
    ]
  }) as { workspace: string; sources: Array<{ type: string }> };
  assert.equal(request.workspace, "/workspace");
  assert.deepEqual(request.sources.map((source) => source.type), ["file", "url"]);
  assert.throws(() => parseHttpRequest("POST", "/api/knowledge-packs", {
    name: "Invalid",
    scope: "workspace",
    sources: [{ type: "path", reference: "docs" }]
  }));

  const response = parseHttpResponse("GET", "/api/knowledge-packs?workspace=/workspace", {
    data: [{
      id: "11111111-1111-4111-8111-111111111111",
      name: "Repository guide",
      scope: "workspace",
      workspace: "/workspace",
      sources: [{ type: "file", reference: "README.md" }],
      content: "Cached context",
      contentHash: `sha256:${"a".repeat(64)}`,
      status: "ready",
      errors: [],
      charCount: 14,
      createdAt: 2_000_000_000_000,
      updatedAt: 2_000_000_000_000,
      refreshedAt: 2_000_000_000_000
    }]
  }) as { data: Array<{ createdAt: string }> };
  assert.match(response.data[0]!.createdAt, /^2033-05-18T/);
});
