import os from "node:os";
import path from "node:path";
import type { AdmissionControlOptions } from "./admission-control.js";
import type { AuthManagerOptions } from "./auth.js";
import type { ClaudeAvailabilityOptions, ClaudeBridgeOptions } from "./claude-bridge.js";
import type { CodexRuntimeOptions } from "./codex-bridge.js";
import type { ForgeDeckConfig } from "./config.js";
import type { ExternalCodexMonitorOptions } from "./external-monitor.js";
import type { LoggerOptions } from "./logger.js";
import type { McpAccessOptions } from "./mcp-access.js";
import type { WorkspaceSearchLimits } from "./paths.js";

type SessionRuntimeOptions = Readonly<{
  metadataRetentionMs: number;
  auditRetentionMs: number;
  auditMaxBytes: number;
  maintenanceChunkSize: number;
}>;

type OperationPoolRuntimeOptions = Readonly<{
  maxConcurrency: number;
  minConcurrency: number;
}>;

type ExternalMonitorRuntimeOptions = Readonly<{
  enabled: boolean;
  codexHome: string;
  monitor: Required<ExternalCodexMonitorOptions>;
}>;

export type ServerRuntimeOptions = Readonly<{
  logging: Required<Pick<LoggerOptions, "level" | "requestSampleRate" | "includeErrorStacks">>;
  auth: Required<Omit<AuthManagerOptions, "password">> & Pick<AuthManagerOptions, "password">;
  mcpAccess: Required<Pick<McpAccessOptions, "actorLifetimeMs" | "actorInactivityTtlMs">>;
  sessions: SessionRuntimeOptions;
  workspaces: Readonly<{ roots: readonly string[]; search: Readonly<WorkspaceSearchLimits> }>;
  readOperations: OperationPoolRuntimeOptions;
  mutationOperations: OperationPoolRuntimeOptions;
  codex: CodexRuntimeOptions;
  claude: Pick<ClaudeBridgeOptions, "claudeBin" | "environment">;
  claudeAvailability: ClaudeAvailabilityOptions;
  capacity: Readonly<{ "codex/standard": number; "codex/spark": number; claude: number }>;
  admission: Readonly<Required<Omit<AdmissionControlOptions, "now">>>;
  caches: Readonly<{ modelTtlMs: number; claudeAvailabilityTtlMs: number }>;
  profiler: Readonly<{ slowRequestMs: number }>;
  liveRecovery: Readonly<{ maxBytes: number }>;
  externalMonitor: ExternalMonitorRuntimeOptions;
  rateLimit: Readonly<{ windowMs: number; max: number }>;
}>;

/** Maps every dependency-facing setting exactly once at the production construction boundary. */
export function createServerRuntimeOptions(
  config: ForgeDeckConfig,
  environment: Readonly<NodeJS.ProcessEnv>
): ServerRuntimeOptions {
  const executableSearchPath = [...new Set([
    ...config.executableSearchPath.split(path.delimiter).filter(Boolean),
    path.join(os.homedir(), ".local", "bin")
  ])].join(path.delimiter);
  const commandEnvironment = Object.freeze({ ...environment, PATH: executableSearchPath });
  const claude = Object.freeze({ claudeBin: config.claudeBin, environment: commandEnvironment });
  return Object.freeze({
    logging: Object.freeze({
      level: config.logLevel,
      requestSampleRate: config.requestLogSampleRate,
      includeErrorStacks: config.nodeEnvironment !== "production"
    }),
    auth: Object.freeze({
      enabled: config.authEnabled,
      password: config.password,
      cookieSecure: config.cookieSecure,
      sessionTtlMs: config.authSessionTtlMs,
      maxSessions: config.authMaxSessions,
      loginMaxAttempts: config.loginMaxAttempts,
      loginWindowMs: config.loginWindowMs,
      loginAttemptStateMax: config.loginAttemptStateMax,
      loginGlobalMaxAttempts: config.loginGlobalMaxAttempts
    }),
    mcpAccess: Object.freeze({
      actorLifetimeMs: config.mcpActorLifetimeMs,
      actorInactivityTtlMs: config.mcpActorInactivityTtlMs
    }),
    sessions: Object.freeze({
      metadataRetentionMs: config.metadataRetentionMs,
      auditRetentionMs: config.auditRetentionMs,
      auditMaxBytes: config.auditMaxBytes,
      maintenanceChunkSize: config.maintenanceChunkSize
    }),
    workspaces: Object.freeze({
      roots: config.workspaceRoots,
      search: Object.freeze({
        maxEntries: config.workspaceSearchMaxEntries,
        maxDepth: config.workspaceSearchMaxDepth,
        resultLimit: config.workspaceSearchResultLimit,
        allowHidden: config.allowHiddenSearch
      })
    }),
    readOperations: Object.freeze({
      maxConcurrency: config.operationReadConcurrency,
      minConcurrency: Math.min(4, config.operationReadConcurrency)
    }),
    mutationOperations: Object.freeze({
      maxConcurrency: config.operationMutationConcurrency,
      minConcurrency: 1
    }),
    codex: Object.freeze({
      bin: config.codexBin,
      appServerUrl: config.codexAppServerUrl,
      environment: commandEnvironment
    }),
    claude,
    claudeAvailability: claude,
    capacity: Object.freeze({
      "codex/standard": config.standardMaxConcurrent,
      "codex/spark": config.sparkMaxConcurrent,
      claude: config.claudeMaxConcurrent
    }),
    admission: Object.freeze({
      headroomPercent: config.admissionHeadroomPercent,
      resetProximityMs: config.admissionResetProximityMs,
      quotaStaleMs: config.admissionQuotaStaleMs,
      defaultExhaustionPolicy: config.admissionDefaultPolicy,
      costCatalog: config.costCatalog
    }),
    caches: Object.freeze({
      modelTtlMs: config.modelCacheTtlMs,
      claudeAvailabilityTtlMs: config.claudeAvailabilityCacheTtlMs
    }),
    profiler: Object.freeze({ slowRequestMs: config.slowRequestMs }),
    liveRecovery: Object.freeze({ maxBytes: config.liveOutputBudgetBytes }),
    externalMonitor: Object.freeze({
      enabled: config.externalMonitorEnabled,
      codexHome: config.codexHome,
      monitor: Object.freeze({
        pollMs: config.externalMonitorPollMs,
        livenessMs: config.externalMonitorLivenessMs,
        threadLimit: config.externalMonitorThreadLimit,
        maxReadBytes: config.externalMonitorMaxReadBytes,
        maxOutputBytes: config.liveOutputBudgetBytes
      })
    }),
    rateLimit: Object.freeze({ windowMs: config.apiRateWindowMs, max: config.apiRateLimit })
  });
}
