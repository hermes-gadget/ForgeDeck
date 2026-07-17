import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SESSION_TTL_MS, loadConfig } from "./config.js";
import { logger } from "./logger.js";

test("server config parses bounded settings and trusted origins", () => {
  const config = loadConfig("/srv/forgedeck", {
    FORGEDECK_PORT: "9000",
    FORGEDECK_DATA_DIR: "runtime-data",
    FORGEDECK_TRUST_PROXY: "on",
    FORGEDECK_COOKIE_SECURE: "on",
    FORGEDECK_PUBLIC_ORIGIN: "https://deck.example.test/app",
    FORGEDECK_TRUSTED_ORIGINS: "https://deck.example.test, http://localhost:9000/path",
    FORGEDECK_ALLOWED_ORIGINS: "https://legacy.example.test",
    FORGEDECK_WEBHOOK_SECRET: "webhook-test-secret",
    FORGEDECK_RATE_LIMIT: "120",
    FORGEDECK_SESSION_TTL_HOURS: "1.5",
    FORGEDECK_SPARK_TTL_HOURS: "0.5",
    FORGEDECK_STANDARD_MAX_CONCURRENT: "7",
    FORGEDECK_SPARK_MAX_CONCURRENT: "20",
    FORGEDECK_CLAUDE_MAX_CONCURRENT: "5",
    FORGEDECK_QUOTA_HEADROOM_PERCENT: "12.5",
    FORGEDECK_QUOTA_RESET_PROXIMITY_MS: "90000",
    FORGEDECK_QUOTA_STALE_MS: "600000",
    FORGEDECK_ADMISSION_POLICY: "pause",
    FORGEDECK_COST_CATALOG_JSON: JSON.stringify({
      version: "catalog-test",
      currency: "USD",
      models: { "model-a": { totalTokens: 1_000_000 } }
    }),
    FORGEDECK_READ_MAX_CONCURRENT: "12",
    FORGEDECK_MUTATION_MAX_CONCURRENT: "4",
    FORGEDECK_MAINTENANCE_CHUNK_SIZE: "20",
    FORGEDECK_MCP_CLIENT_ID: "editor:test-client",
    FORGEDECK_LIVE_OUTPUT_BUDGET_BYTES: "262144",
    FORGEDECK_CLAUDE_BIN: "/opt/claude/bin/claude",
    FORGEDECK_EXTERNAL_MONITOR_POLL_MS: "1500"
  });

  assert.equal(config.port, 9000);
  assert.equal(config.dataDir, "/srv/forgedeck/runtime-data");
  assert.equal(config.trustProxy, true);
  assert.equal(config.cookieSecure, "on");
  assert.equal(config.publicOrigin, "https://deck.example.test");
  assert.deepEqual([...config.trustedOrigins], ["https://deck.example.test", "http://localhost:9000", "https://legacy.example.test"]);
  assert.equal(config.webhookSecret, "webhook-test-secret");
  assert.equal(config.apiRateLimit, 120);
  assert.equal(config.sessionTtlMs, 90 * 60_000);
  assert.equal(config.sparkTtlMs, 30 * 60_000);
  assert.equal(config.standardMaxConcurrent, 7);
  assert.equal(config.sparkMaxConcurrent, 20);
  assert.equal(config.claudeMaxConcurrent, 5);
  assert.equal(config.admissionHeadroomPercent, 12.5);
  assert.equal(config.admissionResetProximityMs, 90_000);
  assert.equal(config.admissionQuotaStaleMs, 600_000);
  assert.equal(config.admissionDefaultPolicy, "pause");
  assert.equal(config.costCatalog?.version, "catalog-test");
  assert.equal(config.operationReadConcurrency, 12);
  assert.equal(config.operationMutationConcurrency, 4);
  assert.equal(config.maintenanceChunkSize, 20);
  assert.equal(config.mcpClientId, "editor:test-client");
  assert.equal(config.liveOutputBudgetBytes, 256 * 1024);
  assert.equal(config.claudeBin, "/opt/claude/bin/claude");
  assert.equal(config.externalMonitorPollMs, 1500);
});

test("server config rejects invalid numeric and boolean values", () => {
  assert.throws(() => loadConfig("/srv/forgedeck", { FORGEDECK_PORT: "70000" }), /FORGEDECK_PORT/);
  assert.throws(() => loadConfig("/srv/forgedeck", { FORGEDECK_TRUST_PROXY: "sometimes" }), /FORGEDECK_TRUST_PROXY/);
  assert.throws(() => loadConfig("/srv/forgedeck", { FORGEDECK_TRUSTED_ORIGINS: "*" }), /wildcards/);
  assert.throws(() => loadConfig("/srv/forgedeck", { FORGEDECK_SPARK_MAX_CONCURRENT: "0" }), /FORGEDECK_SPARK_MAX_CONCURRENT/);
  assert.throws(() => loadConfig("/srv/forgedeck", { FORGEDECK_QUOTA_HEADROOM_PERCENT: "101" }), /FORGEDECK_QUOTA_HEADROOM_PERCENT/);
  assert.throws(() => loadConfig("/srv/forgedeck", { FORGEDECK_ADMISSION_POLICY: "fallback" }), /FORGEDECK_ADMISSION_POLICY/);
  assert.throws(() => loadConfig("/srv/forgedeck", { FORGEDECK_COST_CATALOG_JSON: "{}" }), /Cost catalog/);
  assert.throws(() => loadConfig("/srv/forgedeck", { FORGEDECK_MCP_CLIENT_ID: "two clients" }), /FORGEDECK_MCP_CLIENT_ID/);
});

test("server config applies ForgeDeck concurrency and TTL defaults", () => {
  const config = loadConfig("/srv/forgedeck", {});
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.webhookSecret, undefined);
  assert.equal(config.allowLan, false);
  assert.equal(config.publicOrigin, "http://127.0.0.1:4173");
  assert.equal(config.authSessionTtlMs, 24 * 60 * 60_000);
  assert.equal(config.authMaxSessions, 32);
  assert.equal(config.sessionTtlMs, DEFAULT_SESSION_TTL_MS);
  assert.equal(config.sparkTtlMs, 60 * 60_000);
  assert.equal(config.standardMaxConcurrent, 6);
  assert.equal(config.sparkMaxConcurrent, 16);
  assert.equal(config.claudeMaxConcurrent, 4);
  assert.equal(config.admissionHeadroomPercent, 10);
  assert.equal(config.admissionResetProximityMs, 5 * 60_000);
  assert.equal(config.admissionDefaultPolicy, "wait");
  assert.equal(config.costCatalog, null);
  assert.equal(config.operationReadConcurrency, 16);
  assert.equal(config.operationMutationConcurrency, 5);
  assert.equal(config.maintenanceChunkSize, 25);
  assert.equal(config.liveOutputBudgetBytes, 384 * 1024);
  assert.equal(config.claudeBin, "claude");
  assert.equal(config.mcpClientId, "forgedeck-stdio");
});

test("server config requires explicit LAN acknowledgement and a canonical origin for wildcard binds", () => {
  assert.throws(
    () => loadConfig("/srv/forgedeck", { FORGEDECK_HOST: "192.168.1.20" }),
    /FORGEDECK_ALLOW_LAN=on/
  );
  assert.throws(
    () => loadConfig("/srv/forgedeck", { FORGEDECK_HOST: "127.example.test" }),
    /FORGEDECK_ALLOW_LAN=on/
  );
  assert.throws(
    () => loadConfig("/srv/forgedeck", { FORGEDECK_HOST: "0.0.0.0", FORGEDECK_ALLOW_LAN: "on" }),
    /FORGEDECK_PUBLIC_ORIGIN/
  );
  const lan = loadConfig("/srv/forgedeck", {
    FORGEDECK_HOST: "0.0.0.0",
    FORGEDECK_ALLOW_LAN: "on",
    FORGEDECK_PUBLIC_ORIGIN: "http://192.168.1.20:4173"
  });
  assert.equal(lan.host, "0.0.0.0");
  assert.equal(lan.allowLan, true);
  assert.equal(lan.publicOrigin, "http://192.168.1.20:4173");
});

test("loadConfig is side-effect free and returns runtime-immutable values", () => {
  const previousLevel = logger.level;
  const environment = {
    FORGEDECK_LOG_LEVEL: "debug",
    FORGEDECK_ROOTS: "/workspace/one:/workspace/two",
    FORGEDECK_TRUSTED_ORIGINS: "https://one.example.test"
  };
  const first = loadConfig("/srv/forgedeck", environment);
  const second = loadConfig("/srv/forgedeck", environment);

  assert.equal(logger.level, previousLevel);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.workspaceRoots), true);
  assert.equal(Object.isFrozen(first.overriddenSettings), true);
  assert.deepEqual([...first.trustedOrigins], [...second.trustedOrigins]);
  assert.equal((first.trustedOrigins as Set<string>).add, undefined);
  assert.throws(() => (first.trustedOrigins as Set<string>).add("https://two.example.test"), TypeError);
  assert.deepEqual(first.overriddenSettings, [
    "FORGEDECK_TRUSTED_ORIGINS",
    "FORGEDECK_ROOTS",
    "FORGEDECK_LOG_LEVEL"
  ]);
});
