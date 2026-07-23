import fs from "node:fs";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { parseCostCatalog, type CostCatalog } from "./admission-control.js";
import type { LogLevel } from "./logger.js";

export type CookieSecureMode = "auto" | "on" | "off";

export const DEFAULT_SESSION_TTL_HOURS = 24;
export const DEFAULT_SESSION_TTL_MS = DEFAULT_SESSION_TTL_HOURS * 3_600_000;

export type ForgeDeckConfig = Readonly<{
  host: string;
  port: number;
  allowLan: boolean;
  publicOrigin: string;
  dataDir: string;
  distDir: string;
  trustProxy: boolean;
  cookieSecure: CookieSecureMode;
  trustedOrigins: ReadonlySet<string>;
  authEnabled: boolean;
  password: string | undefined;
  webhookSecret: string | undefined;
  authSessionTtlMs: number;
  authMaxSessions: number;
  loginMaxAttempts: number;
  loginWindowMs: number;
  loginAttemptStateMax: number;
  loginGlobalMaxAttempts: number;
  workspaceRoots: readonly string[];
  workspaceSearchMaxEntries: number;
  workspaceSearchMaxDepth: number;
  workspaceSearchResultLimit: number;
  allowHiddenSearch: boolean;
  apiRateLimit: number;
  apiRateWindowMs: number;
  sessionTtlMs: number;
  sparkTtlMs: number;
  standardMaxConcurrent: number;
  sparkMaxConcurrent: number;
  admissionHeadroomPercent: number;
  admissionResetProximityMs: number;
  admissionQuotaStaleMs: number;
  admissionDefaultPolicy: "wait" | "pause";
  costCatalog: CostCatalog | null;
  operationReadConcurrency: number;
  operationMutationConcurrency: number;
  maintenanceChunkSize: number;
  codexBin: string;
  codexAppServerUrl: string | undefined;
  codexHome: string;
  queueMaxMessages: number;
  modelCacheTtlMs: number;
  slowRequestMs: number;
  shutdownTimeoutMs: number;
  liveOutputBudgetBytes: number;
  sseEventMaxBytes: number;
  externalMonitorEnabled: boolean;
  externalMonitorPollMs: number;
  externalMonitorLivenessMs: number;
  externalMonitorThreadLimit: number;
  externalMonitorMaxReadBytes: number;
  metadataRetentionMs: number;
  auditRetentionMs: number;
  auditMaxBytes: number;
  mcpActorLifetimeMs: number;
  mcpActorInactivityTtlMs: number;
  mcpBaseUrl: string;
  mcpTokenFile: string;
  mcpClientId: string;
  logLevel: LogLevel;
  requestLogSampleRate: number;
  nodeEnvironment: string;
  executableSearchPath: string;
  overriddenSettings: readonly string[];
}>;

/** Canonical defaults used by parsing, runtime construction, and generated docs. */
const CONFIG_DEFAULTS = Object.freeze({
  host: "127.0.0.1",
  port: 4173,
  allowLan: false,
  dataDir: ".data",
  distDir: "dist",
  trustProxy: false,
  cookieSecure: "auto" as CookieSecureMode,
  authEnabled: true,
  authSessionTtlHours: 24,
  authMaxSessions: 32,
  loginMaxAttempts: 5,
  loginWindowMs: 15 * 60_000,
  loginAttemptStateMax: 1_000,
  loginGlobalMaxAttempts: 200,
  workspaceSearchMaxEntries: 4_000,
  workspaceSearchMaxDepth: 6,
  workspaceSearchResultLimit: 30,
  allowHiddenSearch: false,
  apiRateLimit: 300,
  apiRateWindowMs: 60_000,
  sessionTtlHours: DEFAULT_SESSION_TTL_HOURS,
  sparkTtlHours: 1,
  standardMaxConcurrent: 6,
  sparkMaxConcurrent: 16,
  admissionHeadroomPercent: 10,
  admissionResetProximityMs: 5 * 60_000,
  admissionQuotaStaleMs: 5 * 60_000,
  admissionDefaultPolicy: "wait" as const,
  operationReadConcurrency: 16,
  operationMutationConcurrency: 5,
  maintenanceChunkSize: 25,
  codexBin: "codex",
  codexHome: ".codex",
  queueMaxMessages: 100,
  modelCacheTtlMs: 30_000,
  slowRequestMs: 750,
  shutdownTimeoutMs: 10_000,
  liveOutputBudgetBytes: 384 * 1024,
  sseEventMaxBytes: 1_000_000,
  externalMonitorEnabled: true,
  externalMonitorPollMs: 1_000,
  externalMonitorLivenessMs: 2_500,
  externalMonitorThreadLimit: 32,
  externalMonitorMaxReadBytes: 512 * 1024,
  metadataRetentionHours: 30 * 24,
  auditRetentionHours: 30 * 24,
  auditMaxBytes: 10 * 1024 * 1024,
  mcpActorLifetimeHours: 7 * 24,
  mcpActorInactivityTtlHours: 24,
  mcpClientId: "forgedeck-stdio",
  logLevel: "info" as LogLevel,
  requestLogSampleRate: 1,
  nodeEnvironment: "production",
  executableSearchPath: "/usr/local/bin:/usr/bin:/bin"
});

type ConfigDefinition = Readonly<{
  names: readonly string[];
  defaultValue: string;
  description: string;
  warnOnOverride?: boolean;
}>;

const definition = (
  names: string | readonly string[],
  defaultValue: string | number | boolean,
  description: string,
  warnOnOverride = true
): ConfigDefinition => Object.freeze({
  names: Object.freeze(typeof names === "string" ? [names] : [...names]),
  defaultValue: String(defaultValue),
  description,
  warnOnOverride
});

/** Shared operator setting catalog used to generate docs and startup diagnostics. */
const CONFIG_DEFINITIONS: readonly ConfigDefinition[] = Object.freeze([
  definition("FORGEDECK_HOST", CONFIG_DEFAULTS.host, "Server listen host."),
  definition("FORGEDECK_PORT", CONFIG_DEFAULTS.port, "Server listen port."),
  definition("FORGEDECK_ALLOW_LAN", "off", "Required acknowledgement for a non-loopback listen host."),
  definition("FORGEDECK_PUBLIC_ORIGIN", "derived from host and port", "Canonical browser HTTP(S) origin; required for wildcard binds."),
  definition("FORGEDECK_DATA_DIR", CONFIG_DEFAULTS.dataDir, "Runtime database, queue, and credential directory."),
  definition("FORGEDECK_DIST_DIR", CONFIG_DEFAULTS.distDir, "Built client asset directory."),
  definition("FORGEDECK_TRUST_PROXY", "off", "Trust one reverse-proxy hop for protocol and client address."),
  definition("FORGEDECK_COOKIE_SECURE", CONFIG_DEFAULTS.cookieSecure, "Secure-cookie mode: auto, on, or off."),
  definition(["FORGEDECK_TRUSTED_ORIGINS", "FORGEDECK_ALLOWED_ORIGINS", "FORGEDECK_CORS_ORIGINS"], "none", "Comma-separated exact credentialed CORS origins; later names are compatibility aliases."),
  definition("FORGEDECK_AUTH", "on", "Enable dashboard authentication."),
  definition("FORGEDECK_PASSWORD", "generated token", "Dashboard password; values must contain at least 12 characters."),
  definition("FORGEDECK_WEBHOOK_SECRET", "disabled", "Shared secret for HMAC-SHA256 webhook trigger signatures; the trigger endpoint is disabled when unset."),
  definition("FORGEDECK_AUTH_SESSION_TTL_HOURS", CONFIG_DEFAULTS.authSessionTtlHours, "Absolute browser-session lifetime in hours."),
  definition("FORGEDECK_AUTH_MAX_SESSIONS", CONFIG_DEFAULTS.authMaxSessions, "Maximum concurrent authenticated browser sessions."),
  definition("FORGEDECK_LOGIN_MAX_ATTEMPTS", CONFIG_DEFAULTS.loginMaxAttempts, "Failed login attempts allowed per client and window."),
  definition("FORGEDECK_LOGIN_WINDOW_MS", CONFIG_DEFAULTS.loginWindowMs, "Login throttling window in milliseconds."),
  definition("FORGEDECK_LOGIN_ATTEMPT_STATE_MAX", CONFIG_DEFAULTS.loginAttemptStateMax, "Maximum distinct client login-attempt records."),
  definition("FORGEDECK_LOGIN_GLOBAL_MAX_ATTEMPTS", CONFIG_DEFAULTS.loginGlobalMaxAttempts, "Maximum failed login attempts globally per window."),
  definition("FORGEDECK_ROOTS", "current home directory", "Path-delimited selectable workspace roots."),
  definition("FORGEDECK_WORKSPACE_SEARCH_MAX_ENTRIES", CONFIG_DEFAULTS.workspaceSearchMaxEntries, "Maximum entries inspected by one workspace search."),
  definition("FORGEDECK_WORKSPACE_SEARCH_MAX_DEPTH", CONFIG_DEFAULTS.workspaceSearchMaxDepth, "Maximum workspace search traversal depth."),
  definition("FORGEDECK_WORKSPACE_SEARCH_RESULT_LIMIT", CONFIG_DEFAULTS.workspaceSearchResultLimit, "Maximum file suggestions returned."),
  definition("FORGEDECK_ALLOW_HIDDEN_SEARCH", "off", "Allow hidden files in search while retaining sensitive-path blocks."),
  definition("FORGEDECK_RATE_LIMIT", CONFIG_DEFAULTS.apiRateLimit, "Maximum API requests per client and rate window."),
  definition("FORGEDECK_RATE_WINDOW_MS", CONFIG_DEFAULTS.apiRateWindowMs, "API rate-limit window in milliseconds."),
  definition("FORGEDECK_SESSION_TTL_HOURS", CONFIG_DEFAULTS.sessionTtlHours, "Idle standard-session archival age in hours; 0 disables it."),
  definition("FORGEDECK_SPARK_TTL_HOURS", CONFIG_DEFAULTS.sparkTtlHours, "Idle Spark-session archival age in hours; 0 disables it."),
  definition("FORGEDECK_STANDARD_MAX_CONCURRENT", CONFIG_DEFAULTS.standardMaxConcurrent, "Maximum concurrent standard Codex turns."),
  definition("FORGEDECK_SPARK_MAX_CONCURRENT", CONFIG_DEFAULTS.sparkMaxConcurrent, "Maximum concurrent Spark turns."),
  definition("FORGEDECK_QUOTA_HEADROOM_PERCENT", CONFIG_DEFAULTS.admissionHeadroomPercent, "Provider quota percentage reserved before admission."),
  definition("FORGEDECK_QUOTA_RESET_PROXIMITY_MS", CONFIG_DEFAULTS.admissionResetProximityMs, "Nearby quota-reset window in milliseconds."),
  definition("FORGEDECK_QUOTA_STALE_MS", CONFIG_DEFAULTS.admissionQuotaStaleMs, "Maximum quota-observation age in milliseconds."),
  definition("FORGEDECK_ADMISSION_POLICY", CONFIG_DEFAULTS.admissionDefaultPolicy, "Default exhausted-quota behavior: wait or pause."),
  definition("FORGEDECK_COST_CATALOG_JSON", "none", "Versioned JSON model-rate catalog for optional cost estimates."),
  definition("FORGEDECK_READ_MAX_CONCURRENT", CONFIG_DEFAULTS.operationReadConcurrency, "Maximum shared read and health operations."),
  definition("FORGEDECK_MUTATION_MAX_CONCURRENT", CONFIG_DEFAULTS.operationMutationConcurrency, "Maximum shared mutation and archive operations."),
  definition("FORGEDECK_MAINTENANCE_CHUNK_SIZE", CONFIG_DEFAULTS.maintenanceChunkSize, "Maximum records processed per maintenance chunk."),
  definition("CODEX_BIN", CONFIG_DEFAULTS.codexBin, "Codex executable path or command name."),
  definition("CODEX_APP_SERVER_URL", "none", "Existing Codex app-server WebSocket URL."),
  definition("CODEX_HOME", "~/.codex", "Codex state directory used by the external monitor."),
  definition("FORGEDECK_QUEUE_MAX_MESSAGES", CONFIG_DEFAULTS.queueMaxMessages, "Maximum persisted queued messages per session."),
  definition("FORGEDECK_MODEL_CACHE_TTL_MS", CONFIG_DEFAULTS.modelCacheTtlMs, "Account model-list cache duration in milliseconds."),
  definition("FORGEDECK_SLOW_REQUEST_MS", CONFIG_DEFAULTS.slowRequestMs, "API latency warning threshold; 0 disables warnings."),
  definition("FORGEDECK_SHUTDOWN_TIMEOUT_MS", CONFIG_DEFAULTS.shutdownTimeoutMs, "Graceful shutdown deadline in milliseconds."),
  definition("FORGEDECK_LIVE_OUTPUT_BUDGET_BYTES", CONFIG_DEFAULTS.liveOutputBudgetBytes, "Per-thread live recovery byte budget."),
  definition("FORGEDECK_SSE_EVENT_MAX_BYTES", CONFIG_DEFAULTS.sseEventMaxBytes, "Maximum serialized server-sent event size."),
  definition("FORGEDECK_EXTERNAL_MONITOR", "on", "Enable read-only monitoring of other local Codex sessions."),
  definition("FORGEDECK_EXTERNAL_MONITOR_POLL_MS", CONFIG_DEFAULTS.externalMonitorPollMs, "External monitor polling interval in milliseconds."),
  definition("FORGEDECK_EXTERNAL_MONITOR_LIVENESS_MS", CONFIG_DEFAULTS.externalMonitorLivenessMs, "External process liveness refresh interval in milliseconds."),
  definition("FORGEDECK_EXTERNAL_MONITOR_THREAD_LIMIT", CONFIG_DEFAULTS.externalMonitorThreadLimit, "Maximum external threads tracked."),
  definition("FORGEDECK_EXTERNAL_MONITOR_MAX_READ_BYTES", CONFIG_DEFAULTS.externalMonitorMaxReadBytes, "Maximum rollout bytes read per monitor pass."),
  definition("FORGEDECK_METADATA_RETENTION_HOURS", CONFIG_DEFAULTS.metadataRetentionHours, "Unpinned archived-session metadata retention in hours; 0 disables pruning."),
  definition("FORGEDECK_AUDIT_RETENTION_HOURS", CONFIG_DEFAULTS.auditRetentionHours, "Audit-event retention in hours; 0 disables age pruning."),
  definition("FORGEDECK_AUDIT_MAX_BYTES", CONFIG_DEFAULTS.auditMaxBytes, "Maximum retained audit data size in bytes."),
  definition("FORGEDECK_MCP_ACTOR_LIFETIME_HOURS", CONFIG_DEFAULTS.mcpActorLifetimeHours, "MCP credential lifetime in hours; refresh preserves the actor identity."),
  definition("FORGEDECK_MCP_ACTOR_INACTIVITY_TTL_HOURS", CONFIG_DEFAULTS.mcpActorInactivityTtlHours, "Inactive MCP credential expiry in hours; recovery preserves the actor identity."),
  definition("FORGEDECK_URL", "http://127.0.0.1:4173", "Dashboard API URL used by the stdio MCP server."),
  definition("FORGEDECK_MCP_TOKEN_FILE", "${FORGEDECK_DATA_DIR}/mcp-token", "MCP bootstrap-token path."),
  definition("FORGEDECK_MCP_CLIENT_ID", CONFIG_DEFAULTS.mcpClientId, "Stable MCP client scope used to persist and recover one actor identity."),
  definition("FORGEDECK_LOG_LEVEL", CONFIG_DEFAULTS.logLevel, "Structured log threshold: debug, info, warn, or error."),
  definition("FORGEDECK_REQUEST_LOG_SAMPLE_RATE", CONFIG_DEFAULTS.requestLogSampleRate, "Successful request-log sample rate from 0 to 1."),
  definition("NODE_ENV", CONFIG_DEFAULTS.nodeEnvironment, "Runtime mode; non-production modes include error stacks."),
  definition("PATH", `${CONFIG_DEFAULTS.executableSearchPath}${path.delimiter}${"$"}{HOME}/.local/bin`, "Executable search path inherited by adapters.", false)
]);

/** Renders the checked-in operator reference without maintaining a second defaults list. */
export function renderConfigReferenceMarkdown(): string {
  const rows = CONFIG_DEFINITIONS.map((entry) => {
    const names = entry.names.map((name) => `\`${name}\``).join("<br>");
    return `| ${names} | \`${markdownCell(entry.defaultValue)}\` | ${markdownCell(entry.description)} |`;
  });
  return [
    "<!-- Generated by `npm run docs:config`; edit src/server/config.ts, not this file. -->",
    "# ForgeDeck configuration",
    "",
    "ForgeDeck reads its environment once at process construction. Explicit overrides are validated before stateful services are created and are reported as startup warnings by name; secret values are never logged.",
    "",
    "| Setting | Default | Description |",
    "| --- | --- | --- |",
    ...rows,
    ""
  ].join("\n");
}

export type RuntimePreflight = {
  ok: boolean;
  errors: readonly string[];
  warnings: readonly string[];
  dependencies: Readonly<Record<"codex" | "flock", string | null>>;
};

/** Captures the process environment once at an executable composition boundary. */
export function readProcessEnvironment(): Readonly<NodeJS.ProcessEnv> {
  return Object.freeze({ ...process.env });
}

/** Purely parses and validates operator-facing settings without I/O or global mutation. */
export function loadConfig(projectRoot: string, env: Readonly<NodeJS.ProcessEnv>): ForgeDeckConfig {
  const host = hostSetting(env.FORGEDECK_HOST);
  const port = integerSetting(env, "FORGEDECK_PORT", CONFIG_DEFAULTS.port, 1, 65_535);
  const dataDir = resolveSetting(projectRoot, env.FORGEDECK_DATA_DIR, CONFIG_DEFAULTS.dataDir);
  const config = {
    host,
    port,
    allowLan: booleanSetting(env, "FORGEDECK_ALLOW_LAN", CONFIG_DEFAULTS.allowLan),
    publicOrigin: publicOriginSetting(env.FORGEDECK_PUBLIC_ORIGIN, host, port),
    dataDir,
    distDir: resolveSetting(projectRoot, env.FORGEDECK_DIST_DIR, CONFIG_DEFAULTS.distDir),
    trustProxy: booleanSetting(env, "FORGEDECK_TRUST_PROXY", CONFIG_DEFAULTS.trustProxy),
    cookieSecure: enumSetting(env, "FORGEDECK_COOKIE_SECURE", ["auto", "on", "off"] as const, CONFIG_DEFAULTS.cookieSecure),
    trustedOrigins: immutableSet(listSetting([
      env.FORGEDECK_TRUSTED_ORIGINS,
      env.FORGEDECK_ALLOWED_ORIGINS,
      env.FORGEDECK_CORS_ORIGINS
    ].filter(Boolean).join(","))),
    authEnabled: authSetting(env.FORGEDECK_AUTH),
    password: secretSetting(env.FORGEDECK_PASSWORD),
    webhookSecret: secretSetting(env.FORGEDECK_WEBHOOK_SECRET),
    authSessionTtlMs: hoursSetting(env, "FORGEDECK_AUTH_SESSION_TTL_HOURS", CONFIG_DEFAULTS.authSessionTtlHours, 1 / 60, 24 * 30) * 3_600_000,
    authMaxSessions: integerSetting(env, "FORGEDECK_AUTH_MAX_SESSIONS", CONFIG_DEFAULTS.authMaxSessions, 1, 1_000),
    loginMaxAttempts: integerSetting(env, "FORGEDECK_LOGIN_MAX_ATTEMPTS", CONFIG_DEFAULTS.loginMaxAttempts, 1, 100),
    loginWindowMs: integerSetting(env, "FORGEDECK_LOGIN_WINDOW_MS", CONFIG_DEFAULTS.loginWindowMs, 1_000, 24 * 60 * 60_000),
    loginAttemptStateMax: integerSetting(env, "FORGEDECK_LOGIN_ATTEMPT_STATE_MAX", CONFIG_DEFAULTS.loginAttemptStateMax, 10, 100_000),
    loginGlobalMaxAttempts: integerSetting(env, "FORGEDECK_LOGIN_GLOBAL_MAX_ATTEMPTS", CONFIG_DEFAULTS.loginGlobalMaxAttempts, 1, 100_000),
    workspaceRoots: Object.freeze(workspaceRootsSetting(env.FORGEDECK_ROOTS)),
    workspaceSearchMaxEntries: integerSetting(env, "FORGEDECK_WORKSPACE_SEARCH_MAX_ENTRIES", CONFIG_DEFAULTS.workspaceSearchMaxEntries, 1, 100_000),
    workspaceSearchMaxDepth: integerSetting(env, "FORGEDECK_WORKSPACE_SEARCH_MAX_DEPTH", CONFIG_DEFAULTS.workspaceSearchMaxDepth, 0, 32),
    workspaceSearchResultLimit: integerSetting(env, "FORGEDECK_WORKSPACE_SEARCH_RESULT_LIMIT", CONFIG_DEFAULTS.workspaceSearchResultLimit, 1, 200),
    allowHiddenSearch: booleanSetting(env, "FORGEDECK_ALLOW_HIDDEN_SEARCH", CONFIG_DEFAULTS.allowHiddenSearch),
    apiRateLimit: integerSetting(env, "FORGEDECK_RATE_LIMIT", CONFIG_DEFAULTS.apiRateLimit, 1, 100_000),
    apiRateWindowMs: integerSetting(env, "FORGEDECK_RATE_WINDOW_MS", CONFIG_DEFAULTS.apiRateWindowMs, 1_000, 3_600_000),
    sessionTtlMs: hoursSetting(env, "FORGEDECK_SESSION_TTL_HOURS", CONFIG_DEFAULTS.sessionTtlHours, 0, 24 * 365) * 3_600_000,
    sparkTtlMs: hoursSetting(env, "FORGEDECK_SPARK_TTL_HOURS", CONFIG_DEFAULTS.sparkTtlHours, 0, 24 * 365) * 3_600_000,
    standardMaxConcurrent: integerSetting(env, "FORGEDECK_STANDARD_MAX_CONCURRENT", CONFIG_DEFAULTS.standardMaxConcurrent, 1, 50),
    sparkMaxConcurrent: integerSetting(env, "FORGEDECK_SPARK_MAX_CONCURRENT", CONFIG_DEFAULTS.sparkMaxConcurrent, 1, 50),
    admissionHeadroomPercent: decimalSetting(env, "FORGEDECK_QUOTA_HEADROOM_PERCENT", CONFIG_DEFAULTS.admissionHeadroomPercent, 0, 100),
    admissionResetProximityMs: integerSetting(env, "FORGEDECK_QUOTA_RESET_PROXIMITY_MS", CONFIG_DEFAULTS.admissionResetProximityMs, 0, 24 * 60 * 60_000),
    admissionQuotaStaleMs: integerSetting(env, "FORGEDECK_QUOTA_STALE_MS", CONFIG_DEFAULTS.admissionQuotaStaleMs, 1_000, 24 * 60 * 60_000),
    admissionDefaultPolicy: enumSetting(env, "FORGEDECK_ADMISSION_POLICY", ["wait", "pause"] as const, CONFIG_DEFAULTS.admissionDefaultPolicy),
    costCatalog: parseCostCatalog(env.FORGEDECK_COST_CATALOG_JSON),
    operationReadConcurrency: integerSetting(env, "FORGEDECK_READ_MAX_CONCURRENT", CONFIG_DEFAULTS.operationReadConcurrency, 1, 100),
    operationMutationConcurrency: integerSetting(env, "FORGEDECK_MUTATION_MAX_CONCURRENT", CONFIG_DEFAULTS.operationMutationConcurrency, 1, 50),
    maintenanceChunkSize: integerSetting(env, "FORGEDECK_MAINTENANCE_CHUNK_SIZE", CONFIG_DEFAULTS.maintenanceChunkSize, 1, 500),
    codexBin: nonEmptySetting(env.CODEX_BIN, CONFIG_DEFAULTS.codexBin, "CODEX_BIN"),
    codexAppServerUrl: optionalUrlSetting(env.CODEX_APP_SERVER_URL, "CODEX_APP_SERVER_URL", ["ws:", "wss:"]),
    codexHome: resolveSetting(projectRoot, env.CODEX_HOME, path.join(os.homedir(), CONFIG_DEFAULTS.codexHome)),
    queueMaxMessages: integerSetting(env, "FORGEDECK_QUEUE_MAX_MESSAGES", CONFIG_DEFAULTS.queueMaxMessages, 1, 10_000),
    modelCacheTtlMs: integerSetting(env, "FORGEDECK_MODEL_CACHE_TTL_MS", CONFIG_DEFAULTS.modelCacheTtlMs, 0, 3_600_000),
    slowRequestMs: integerSetting(env, "FORGEDECK_SLOW_REQUEST_MS", CONFIG_DEFAULTS.slowRequestMs, 0, 60_000),
    shutdownTimeoutMs: integerSetting(env, "FORGEDECK_SHUTDOWN_TIMEOUT_MS", CONFIG_DEFAULTS.shutdownTimeoutMs, 1_000, 120_000),
    liveOutputBudgetBytes: integerSetting(env, "FORGEDECK_LIVE_OUTPUT_BUDGET_BYTES", CONFIG_DEFAULTS.liveOutputBudgetBytes, 256 * 1024, 512 * 1024),
    sseEventMaxBytes: integerSetting(env, "FORGEDECK_SSE_EVENT_MAX_BYTES", CONFIG_DEFAULTS.sseEventMaxBytes, 64_000, 10_000_000),
    externalMonitorEnabled: booleanSetting(env, "FORGEDECK_EXTERNAL_MONITOR", CONFIG_DEFAULTS.externalMonitorEnabled),
    externalMonitorPollMs: integerSetting(env, "FORGEDECK_EXTERNAL_MONITOR_POLL_MS", CONFIG_DEFAULTS.externalMonitorPollMs, 250, 60_000),
    externalMonitorLivenessMs: integerSetting(env, "FORGEDECK_EXTERNAL_MONITOR_LIVENESS_MS", CONFIG_DEFAULTS.externalMonitorLivenessMs, 500, 60_000),
    externalMonitorThreadLimit: integerSetting(env, "FORGEDECK_EXTERNAL_MONITOR_THREAD_LIMIT", CONFIG_DEFAULTS.externalMonitorThreadLimit, 1, 500),
    externalMonitorMaxReadBytes: integerSetting(env, "FORGEDECK_EXTERNAL_MONITOR_MAX_READ_BYTES", CONFIG_DEFAULTS.externalMonitorMaxReadBytes, 64 * 1024, 16 * 1024 * 1024),
    metadataRetentionMs: hoursSetting(env, "FORGEDECK_METADATA_RETENTION_HOURS", CONFIG_DEFAULTS.metadataRetentionHours, 0, 24 * 3650) * 3_600_000,
    auditRetentionMs: hoursSetting(env, "FORGEDECK_AUDIT_RETENTION_HOURS", CONFIG_DEFAULTS.auditRetentionHours, 0, 24 * 3650) * 3_600_000,
    auditMaxBytes: integerSetting(env, "FORGEDECK_AUDIT_MAX_BYTES", CONFIG_DEFAULTS.auditMaxBytes, 64 * 1024, 1024 * 1024 * 1024),
    mcpActorLifetimeMs: hoursSetting(env, "FORGEDECK_MCP_ACTOR_LIFETIME_HOURS", CONFIG_DEFAULTS.mcpActorLifetimeHours, 0.25, 24 * 365) * 3_600_000,
    mcpActorInactivityTtlMs: hoursSetting(env, "FORGEDECK_MCP_ACTOR_INACTIVITY_TTL_HOURS", CONFIG_DEFAULTS.mcpActorInactivityTtlHours, 0.25, 24 * 365) * 3_600_000,
    mcpBaseUrl: httpUrlSetting(env.FORGEDECK_URL, `http://127.0.0.1:${port}`, "FORGEDECK_URL"),
    mcpTokenFile: resolveSetting(projectRoot, env.FORGEDECK_MCP_TOKEN_FILE, path.join(dataDir, "mcp-token")),
    mcpClientId: mcpClientIdSetting(env.FORGEDECK_MCP_CLIENT_ID),
    logLevel: enumSetting(env, "FORGEDECK_LOG_LEVEL", ["debug", "info", "warn", "error"] as const, CONFIG_DEFAULTS.logLevel),
    requestLogSampleRate: decimalSetting(env, "FORGEDECK_REQUEST_LOG_SAMPLE_RATE", CONFIG_DEFAULTS.requestLogSampleRate, 0, 1),
    nodeEnvironment: optionalSetting(env.NODE_ENV) || CONFIG_DEFAULTS.nodeEnvironment,
    executableSearchPath: executablePathSetting(env.PATH)
  } satisfies Omit<ForgeDeckConfig, "overriddenSettings">;

  validateConfigRelationships(config);
  return Object.freeze({
    ...config,
    overriddenSettings: Object.freeze(configuredSettingNames(env))
  });
}

/** Verifies filesystem operability and external commands before startup mutates state. */
export function validateRuntime(config: ForgeDeckConfig): RuntimePreflight {
  const errors: string[] = [];
  const warnings: string[] = [];

  probeDataDirectory(config.dataDir, errors);
  probeClientBuild(config.distDir, errors);
  probeWorkspaceRoots(config.workspaceRoots, errors);

  const dependencies = {
    codex: config.codexAppServerUrl ? null : resolveExecutable(config.codexBin, config.executableSearchPath),
    flock: resolveExecutable("flock", config.executableSearchPath)
  };
  if (!config.codexAppServerUrl && !dependencies.codex) errors.push(`Codex executable is not available: ${config.codexBin}`);
  if (!dependencies.flock) errors.push("Required locking dependency is not available: flock");
  if (!config.authEnabled && !isLoopbackHost(config.host)) {
    warnings.push(`Authentication is disabled while listening on non-loopback host ${config.host}`);
  }
  if (!isLoopbackHost(config.host)) {
    warnings.push(`LAN exposure explicitly enabled on ${config.host}; ForgeDeck is a command-capable control plane and should not use plaintext HTTP on an untrusted network`);
  }
  if (config.trustProxy) {
    warnings.push("Trusted-proxy mode accepts forwarded protocol and client IP from one proxy hop; prevent direct client access to the ForgeDeck backend");
  }

  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
    dependencies: Object.freeze(dependencies)
  });
}

export function assertRuntimeReady(config: ForgeDeckConfig): RuntimePreflight {
  const result = validateRuntime(config);
  if (!result.ok) throw new Error(`ForgeDeck startup preflight failed:\n- ${result.errors.join("\n- ")}`);
  return result;
}

function validateConfigRelationships(config: Omit<ForgeDeckConfig, "overriddenSettings">): void {
  if (config.externalMonitorEnabled && config.externalMonitorLivenessMs < config.externalMonitorPollMs) {
    throw new Error("FORGEDECK_EXTERNAL_MONITOR_LIVENESS_MS must be greater than or equal to FORGEDECK_EXTERNAL_MONITOR_POLL_MS");
  }
  if (config.password !== undefined && config.password.length < 12) {
    throw new Error("FORGEDECK_PASSWORD must be at least 12 characters long");
  }
  if (!isLoopbackHost(config.host) && !config.allowLan) {
    throw new Error(`Refusing non-loopback FORGEDECK_HOST=${config.host}. Set FORGEDECK_ALLOW_LAN=on to acknowledge that ForgeDeck will be reachable from the network`);
  }
  if (new URL(config.publicOrigin).protocol === "https:" && config.cookieSecure === "auto" && !config.trustProxy) {
    throw new Error("An HTTPS FORGEDECK_PUBLIC_ORIGIN requires FORGEDECK_TRUST_PROXY=on or FORGEDECK_COOKIE_SECURE=on so browser session cookies remain Secure");
  }
}

function probeDataDirectory(directory: string, errors: string[]): void {
  let fileDescriptor: number | undefined;
  let probePath: string | undefined;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.statSync(directory);
    if (!stat.isDirectory()) throw new Error("path is not a directory");
    fs.chmodSync(directory, 0o700);
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    probePath = path.join(directory, `.forgedeck-preflight-${process.pid}-${Date.now()}`);
    fileDescriptor = fs.openSync(probePath, "wx", 0o600);
    fs.writeSync(fileDescriptor, "ok\n");
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = undefined;
    fs.unlinkSync(probePath);
    probePath = undefined;
    const directoryDescriptor = fs.openSync(directory, "r");
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  } catch (error) {
    errors.push(`Data directory is not securely writable (${directory}): ${errorMessage(error)}`);
  } finally {
    if (fileDescriptor !== undefined) {
      try { fs.closeSync(fileDescriptor); } catch { /* best-effort probe cleanup */ }
    }
    if (probePath) {
      try { fs.unlinkSync(probePath); } catch { /* best-effort probe cleanup */ }
    }
  }
}

function probeClientBuild(directory: string, errors: string[]): void {
  const indexFile = path.join(directory, "index.html");
  try {
    if (!fs.statSync(indexFile).isFile()) throw new Error("index.html is not a file");
    fs.accessSync(indexFile, fs.constants.R_OK);
  } catch (error) {
    errors.push(`Client build is unavailable (${indexFile}): ${errorMessage(error)}`);
  }
}

function probeWorkspaceRoots(roots: readonly string[], errors: string[]): void {
  for (const root of roots) {
    try {
      const resolved = fs.realpathSync(root);
      if (!fs.statSync(resolved).isDirectory()) throw new Error("path is not a directory");
      fs.accessSync(resolved, fs.constants.R_OK | fs.constants.X_OK);
    } catch (error) {
      errors.push(`Workspace root is not a readable directory (${root}): ${errorMessage(error)}`);
    }
  }
}

function resolveExecutable(command: string, searchPath: string): string | null {
  const candidates = path.isAbsolute(command) || command.includes(path.sep)
    ? [path.resolve(command)]
    : searchPath.split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, command));
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch { /* continue searching */ }
  }
  return null;
}

function resolveSetting(projectRoot: string, value: string | undefined, fallback: string): string {
  return path.resolve(projectRoot, value?.trim() || fallback);
}

function workspaceRootsSetting(value: string | undefined): string[] {
  const configured = value?.split(path.delimiter).map((part) => part.trim()).filter(Boolean) || [];
  return configured.length ? [...new Set(configured.map((root) => path.resolve(root)))] : [os.homedir()];
}

function integerSetting(env: Readonly<NodeJS.ProcessEnv>, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^-?\d+$/.test(raw)) throw new Error(`${name} must be a decimal integer between ${min} and ${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a decimal integer between ${min} and ${max}`);
  }
  return value;
}

function booleanSetting(env: Readonly<NodeJS.ProcessEnv>, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be on or off`);
}

function authSetting(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || ["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled", "none"].includes(normalized)) return false;
  throw new Error("FORGEDECK_AUTH must be on or off");
}

function enumSetting<T extends string>(env: Readonly<NodeJS.ProcessEnv>, name: string, values: readonly T[], fallback: T): T {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  const value = values.find((candidate) => candidate === raw);
  if (!value) throw new Error(`${name} must be one of: ${values.join(", ")}`);
  return value;
}

function listSetting(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return [...new Set(value.split(",").map((entry) => {
    const candidate = entry.trim();
    if (candidate === "*") throw new Error("ForgeDeck CORS origins must be explicit; wildcards are not supported");
    return normalizeHttpOrigin(candidate, "ForgeDeck CORS entries");
  }))];
}

function hoursSetting(env: Readonly<NodeJS.ProcessEnv>, name: string, fallback: number, min: number, max: number): number {
  return decimalSetting(env, name, fallback, min, max);
}

function decimalSetting(env: Readonly<NodeJS.ProcessEnv>, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw)) throw new Error(`${name} must be a decimal number between ${min} and ${max}`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}

function nonEmptySetting(value: string | undefined, fallback: string, name: string): string {
  const normalized = value?.trim() || fallback;
  if (!normalized) throw new Error(`${name} must not be empty`);
  return normalized;
}

function mcpClientIdSetting(value: string | undefined): string {
  const clientId = nonEmptySetting(value, CONFIG_DEFAULTS.mcpClientId, "FORGEDECK_MCP_CLIENT_ID");
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(clientId)) {
    throw new Error("FORGEDECK_MCP_CLIENT_ID must contain 1-128 letters, numbers, dots, colons, underscores, or hyphens");
  }
  return clientId;
}

function hostSetting(value: string | undefined): string {
  const host = nonEmptySetting(value, "127.0.0.1", "FORGEDECK_HOST");
  if (/\s/.test(host)) throw new Error("FORGEDECK_HOST must not contain whitespace");
  return host;
}

function publicOriginSetting(value: string | undefined, host: string, port: number): string {
  const configured = optionalSetting(value);
  if (configured) return normalizeHttpOrigin(configured, "FORGEDECK_PUBLIC_ORIGIN");
  if (isUnspecifiedHost(host)) {
    throw new Error("FORGEDECK_PUBLIC_ORIGIN is required when FORGEDECK_HOST uses a wildcard address");
  }
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
}

function normalizeHttpOrigin(value: string, label: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${label} must be a valid HTTP(S) origin`); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin === "null" || parsed.username || parsed.password) {
    throw new Error(`${label} must be a valid HTTP(S) origin`);
  }
  return parsed.origin;
}

function optionalSetting(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function secretSetting(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

function executablePathSetting(value: string | undefined): string {
  const entries = (optionalSetting(value) || CONFIG_DEFAULTS.executableSearchPath).split(path.delimiter).filter(Boolean);
  entries.push(path.join(os.homedir(), ".local", "bin"));
  return [...new Set(entries)].join(path.delimiter);
}

class ImmutableSet<T> implements ReadonlySet<T> {
  readonly #values: Set<T>;

  constructor(values: Iterable<T>) {
    this.#values = new Set(values);
    Object.freeze(this);
  }

  get size(): number { return this.#values.size; }
  has(value: T): boolean { return this.#values.has(value); }
  entries(): SetIterator<[T, T]> { return this.#values.entries(); }
  keys(): SetIterator<T> { return this.#values.keys(); }
  values(): SetIterator<T> { return this.#values.values(); }
  forEach(callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
    this.#values.forEach((value) => callbackfn.call(thisArg, value, value, this));
  }
  [Symbol.iterator](): SetIterator<T> { return this.#values[Symbol.iterator](); }
  get [Symbol.toStringTag](): string { return "ImmutableSet"; }
}

function immutableSet<T>(values: Iterable<T>): ReadonlySet<T> {
  return new ImmutableSet(values);
}

function configuredSettingNames(env: Readonly<NodeJS.ProcessEnv>): string[] {
  return CONFIG_DEFINITIONS
    .filter((entry) => entry.warnOnOverride !== false)
    .flatMap((entry) => entry.names)
    .filter((name) => env[name] !== undefined && env[name] !== "");
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

function optionalUrlSetting(value: string | undefined, name: string, protocols: readonly string[]): string | undefined {
  const normalized = optionalSetting(value);
  if (!normalized) return undefined;
  let parsed: URL;
  try { parsed = new URL(normalized); } catch { throw new Error(`${name} must be a valid URL`); }
  if (!protocols.includes(parsed.protocol)) throw new Error(`${name} must use ${protocols.join(" or ")}`);
  return parsed.toString();
}

function httpUrlSetting(value: string | undefined, fallback: string, name: string): string {
  return optionalUrlSetting(value || fallback, name, ["http:", "https:"])!;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1"
    || (isIP(normalized) === 4 && Number(normalized.split(".", 1)[0]) === 127);
}

function isUnspecifiedHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "0.0.0.0" || normalized === "::";
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 300);
}
