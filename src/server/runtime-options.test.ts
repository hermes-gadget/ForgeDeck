import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";
import { createServerRuntimeOptions } from "./runtime-options.js";

test("production construction propagates every dependency setting explicitly", () => {
  const projectRoot = "/srv/forgedeck";
  const environment = {
    FORGEDECK_AUTH: "on",
    FORGEDECK_PASSWORD: "construction-test-password",
    FORGEDECK_COOKIE_SECURE: "on",
    FORGEDECK_AUTH_SESSION_TTL_HOURS: "2",
    FORGEDECK_AUTH_MAX_SESSIONS: "41",
    FORGEDECK_LOGIN_MAX_ATTEMPTS: "7",
    FORGEDECK_LOGIN_WINDOW_MS: "123000",
    FORGEDECK_LOGIN_ATTEMPT_STATE_MAX: "321",
    FORGEDECK_LOGIN_GLOBAL_MAX_ATTEMPTS: "654",
    FORGEDECK_MCP_ACTOR_LIFETIME_HOURS: "48",
    FORGEDECK_MCP_ACTOR_INACTIVITY_TTL_HOURS: "6",
    FORGEDECK_METADATA_RETENTION_HOURS: "12",
    FORGEDECK_AUDIT_RETENTION_HOURS: "11",
    FORGEDECK_AUDIT_MAX_BYTES: "70000",
    FORGEDECK_MAINTENANCE_CHUNK_SIZE: "17",
    FORGEDECK_ROOTS: ["/workspace/one", "/workspace/two"].join(path.delimiter),
    FORGEDECK_WORKSPACE_SEARCH_MAX_ENTRIES: "1234",
    FORGEDECK_WORKSPACE_SEARCH_MAX_DEPTH: "4",
    FORGEDECK_WORKSPACE_SEARCH_RESULT_LIMIT: "19",
    FORGEDECK_ALLOW_HIDDEN_SEARCH: "on",
    FORGEDECK_READ_MAX_CONCURRENT: "11",
    FORGEDECK_MUTATION_MAX_CONCURRENT: "3",
    CODEX_BIN: "/opt/codex-custom",
    CODEX_APP_SERVER_URL: "wss://codex.example.test/socket",
    FORGEDECK_STANDARD_MAX_CONCURRENT: "7",
    FORGEDECK_SPARK_MAX_CONCURRENT: "8",
    FORGEDECK_QUOTA_HEADROOM_PERCENT: "13.5",
    FORGEDECK_QUOTA_RESET_PROXIMITY_MS: "1234",
    FORGEDECK_QUOTA_STALE_MS: "5678",
    FORGEDECK_ADMISSION_POLICY: "pause",
    FORGEDECK_COST_CATALOG_JSON: JSON.stringify({
      version: "construction-v1",
      currency: "GBP",
      models: { custom: { totalTokens: 123 } }
    }),
    FORGEDECK_MODEL_CACHE_TTL_MS: "2345",
    FORGEDECK_SLOW_REQUEST_MS: "456",
    FORGEDECK_LIVE_OUTPUT_BUDGET_BYTES: "300000",
    CODEX_HOME: "custom-codex-home",
    FORGEDECK_EXTERNAL_MONITOR: "off",
    FORGEDECK_EXTERNAL_MONITOR_POLL_MS: "700",
    FORGEDECK_EXTERNAL_MONITOR_LIVENESS_MS: "900",
    FORGEDECK_EXTERNAL_MONITOR_THREAD_LIMIT: "21",
    FORGEDECK_EXTERNAL_MONITOR_MAX_READ_BYTES: "70000",
    FORGEDECK_RATE_LIMIT: "222",
    FORGEDECK_RATE_WINDOW_MS: "3333",
    FORGEDECK_LOG_LEVEL: "debug",
    FORGEDECK_REQUEST_LOG_SAMPLE_RATE: "0.25",
    NODE_ENV: "test",
    PATH: "/custom/bin",
    KEEP_ME: "adapter-value"
  } satisfies NodeJS.ProcessEnv;
  const config = loadConfig(projectRoot, environment);
  const options = createServerRuntimeOptions(config, environment);

  assert.deepEqual(options.logging, { level: "debug", requestSampleRate: 0.25, includeErrorStacks: true });
  assert.deepEqual(options.auth, {
    enabled: true,
    password: "construction-test-password",
    cookieSecure: "on",
    sessionTtlMs: 2 * 3_600_000,
    maxSessions: 41,
    loginMaxAttempts: 7,
    loginWindowMs: 123_000,
    loginAttemptStateMax: 321,
    loginGlobalMaxAttempts: 654
  });
  assert.deepEqual(options.mcpAccess, {
    actorLifetimeMs: 48 * 3_600_000,
    actorInactivityTtlMs: 6 * 3_600_000
  });
  assert.deepEqual(options.sessions, {
    metadataRetentionMs: 12 * 3_600_000,
    auditRetentionMs: 11 * 3_600_000,
    auditMaxBytes: 70_000,
    maintenanceChunkSize: 17
  });
  assert.deepEqual(options.workspaces, {
    roots: ["/workspace/one", "/workspace/two"],
    search: { maxEntries: 1234, maxDepth: 4, resultLimit: 19, allowHidden: true }
  });
  assert.deepEqual(options.readOperations, { maxConcurrency: 11, minConcurrency: 4 });
  assert.deepEqual(options.mutationOperations, { maxConcurrency: 3, minConcurrency: 1 });
  assert.equal(options.codex.bin, "/opt/codex-custom");
  assert.equal(options.codex.appServerUrl, "wss://codex.example.test/socket");
  assert.equal(options.codex.environment.KEEP_ME, "adapter-value");
  assert.match(options.codex.environment.PATH || "", /^\/custom\/bin/);
  assert.deepEqual(options.capacity, { "codex/standard": 7, "codex/spark": 8 });
  assert.deepEqual(options.admission, {
    headroomPercent: 13.5,
    resetProximityMs: 1234,
    quotaStaleMs: 5678,
    defaultExhaustionPolicy: "pause",
    costCatalog: config.costCatalog
  });
  assert.deepEqual(options.caches, { modelTtlMs: 2345 });
  assert.deepEqual(options.profiler, { slowRequestMs: 456 });
  assert.deepEqual(options.liveRecovery, { maxBytes: 300_000 });
  assert.deepEqual(options.externalMonitor, {
    enabled: false,
    codexHome: "/srv/forgedeck/custom-codex-home",
    monitor: {
      pollMs: 700,
      livenessMs: 900,
      threadLimit: 21,
      maxReadBytes: 70_000,
      maxOutputBytes: 300_000
    }
  });
  assert.deepEqual(options.rateLimit, { windowMs: 3333, max: 222 });
  assert.equal(Object.isFrozen(options), true);
  assert.equal(Object.isFrozen(options.auth), true);
  assert.equal(Object.isFrozen(options.codex.environment), true);
});
