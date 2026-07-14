import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";

test("server config parses bounded settings and trusted origins", () => {
  const config = loadConfig("/srv/forgedeck", {
    FORGEDECK_PORT: "9000",
    FORGEDECK_DATA_DIR: "runtime-data",
    FORGEDECK_TRUST_PROXY: "on",
    FORGEDECK_COOKIE_SECURE: "on",
    FORGEDECK_TRUSTED_ORIGINS: "https://deck.example.test, http://localhost:9000/path",
    FORGEDECK_ALLOWED_ORIGINS: "https://legacy.example.test",
    FORGEDECK_RATE_LIMIT: "120",
    FORGEDECK_SESSION_TTL_HOURS: "1.5",
    FORGEDECK_SPARK_TTL_HOURS: "0.5",
    FORGEDECK_STANDARD_MAX_CONCURRENT: "7",
    FORGEDECK_SPARK_MAX_CONCURRENT: "20",
    FORGEDECK_CLAUDE_MAX_CONCURRENT: "5",
    FORGEDECK_CLAUDE_BIN: "/opt/claude/bin/claude",
    FORGEDECK_EXTERNAL_MONITOR_POLL_MS: "1500"
  });

  assert.equal(config.port, 9000);
  assert.equal(config.dataDir, "/srv/forgedeck/runtime-data");
  assert.equal(config.trustProxy, true);
  assert.equal(config.cookieSecure, "on");
  assert.deepEqual([...config.trustedOrigins], ["https://deck.example.test", "http://localhost:9000", "https://legacy.example.test"]);
  assert.equal(config.apiRateLimit, 120);
  assert.equal(config.sessionTtlMs, 90 * 60_000);
  assert.equal(config.sparkTtlMs, 30 * 60_000);
  assert.equal(config.standardMaxConcurrent, 7);
  assert.equal(config.sparkMaxConcurrent, 20);
  assert.equal(config.claudeMaxConcurrent, 5);
  assert.equal(config.claudeBin, "/opt/claude/bin/claude");
  assert.equal(config.externalMonitorPollMs, 1500);
});

test("server config rejects invalid numeric and boolean values", () => {
  assert.throws(() => loadConfig("/srv/forgedeck", { FORGEDECK_PORT: "70000" }), /FORGEDECK_PORT/);
  assert.throws(() => loadConfig("/srv/forgedeck", { FORGEDECK_TRUST_PROXY: "sometimes" }), /FORGEDECK_TRUST_PROXY/);
  assert.throws(() => loadConfig("/srv/forgedeck", { FORGEDECK_TRUSTED_ORIGINS: "*" }), /wildcards/);
  assert.throws(() => loadConfig("/srv/forgedeck", { FORGEDECK_SPARK_MAX_CONCURRENT: "0" }), /FORGEDECK_SPARK_MAX_CONCURRENT/);
});

test("server config applies ForgeDeck concurrency and TTL defaults", () => {
  const config = loadConfig("/srv/forgedeck", {});
  assert.equal(config.sessionTtlMs, 2 * 60 * 60_000);
  assert.equal(config.sparkTtlMs, 60 * 60_000);
  assert.equal(config.standardMaxConcurrent, 6);
  assert.equal(config.sparkMaxConcurrent, 16);
  assert.equal(config.claudeMaxConcurrent, 4);
  assert.equal(config.claudeBin, "claude");
});
