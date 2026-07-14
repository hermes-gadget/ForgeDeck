import path from "node:path";

export type CookieSecureMode = "auto" | "on" | "off";

export type ForgeDeckConfig = {
  host: string;
  port: number;
  dataDir: string;
  distDir: string;
  trustProxy: boolean;
  cookieSecure: CookieSecureMode;
  trustedOrigins: ReadonlySet<string>;
  apiRateLimit: number;
  apiRateWindowMs: number;
  sessionTtlMs: number;
  sparkTtlMs: number;
  standardMaxConcurrent: number;
  sparkMaxConcurrent: number;
  claudeMaxConcurrent: number;
  claudeBin: string;
  queueMaxMessages: number;
  modelCacheTtlMs: number;
  slowRequestMs: number;
  shutdownTimeoutMs: number;
  liveOutputMaxChars: number;
  sseEventMaxBytes: number;
  externalMonitorEnabled: boolean;
  externalMonitorPollMs: number;
  externalMonitorLivenessMs: number;
  externalMonitorThreadLimit: number;
  externalMonitorMaxReadBytes: number;
};

/** Loads and validates all operator-facing server settings in one place. */
export function loadConfig(projectRoot: string, env: NodeJS.ProcessEnv = process.env): ForgeDeckConfig {
  return {
    host: env.FORGEDECK_HOST?.trim() || "0.0.0.0",
    port: integerSetting(env, "FORGEDECK_PORT", 4173, 1, 65_535),
    dataDir: resolveSetting(projectRoot, env.FORGEDECK_DATA_DIR, ".data"),
    distDir: resolveSetting(projectRoot, env.FORGEDECK_DIST_DIR, "dist"),
    trustProxy: booleanSetting(env, "FORGEDECK_TRUST_PROXY", false),
    cookieSecure: enumSetting(env, "FORGEDECK_COOKIE_SECURE", ["auto", "on", "off"] as const, "auto"),
    trustedOrigins: new Set(listSetting([
      env.FORGEDECK_TRUSTED_ORIGINS,
      env.FORGEDECK_ALLOWED_ORIGINS,
      env.FORGEDECK_CORS_ORIGINS
    ].filter(Boolean).join(","))),
    apiRateLimit: integerSetting(env, "FORGEDECK_RATE_LIMIT", 300, 1, 100_000),
    apiRateWindowMs: integerSetting(env, "FORGEDECK_RATE_WINDOW_MS", 60_000, 1_000, 3_600_000),
    sessionTtlMs: hoursSetting(env, "FORGEDECK_SESSION_TTL_HOURS", 2, 0, 24 * 365) * 3_600_000,
    sparkTtlMs: hoursSetting(env, "FORGEDECK_SPARK_TTL_HOURS", 1, 0, 24 * 365) * 3_600_000,
    standardMaxConcurrent: integerSetting(env, "FORGEDECK_STANDARD_MAX_CONCURRENT", 6, 1, 50),
    sparkMaxConcurrent: integerSetting(env, "FORGEDECK_SPARK_MAX_CONCURRENT", 16, 1, 50),
    claudeMaxConcurrent: integerSetting(env, "FORGEDECK_CLAUDE_MAX_CONCURRENT", 4, 1, 50),
    claudeBin: env.FORGEDECK_CLAUDE_BIN?.trim() || "claude",
    queueMaxMessages: integerSetting(env, "FORGEDECK_QUEUE_MAX_MESSAGES", 100, 1, 10_000),
    modelCacheTtlMs: integerSetting(env, "FORGEDECK_MODEL_CACHE_TTL_MS", 30_000, 0, 3_600_000),
    slowRequestMs: integerSetting(env, "FORGEDECK_SLOW_REQUEST_MS", 750, 0, 60_000),
    shutdownTimeoutMs: integerSetting(env, "FORGEDECK_SHUTDOWN_TIMEOUT_MS", 10_000, 1_000, 120_000),
    liveOutputMaxChars: integerSetting(env, "FORGEDECK_LIVE_OUTPUT_MAX_CHARS", 200_000, 10_000, 2_000_000),
    sseEventMaxBytes: integerSetting(env, "FORGEDECK_SSE_EVENT_MAX_BYTES", 1_000_000, 64_000, 10_000_000),
    externalMonitorEnabled: booleanSetting(env, "FORGEDECK_EXTERNAL_MONITOR", true),
    externalMonitorPollMs: integerSetting(env, "FORGEDECK_EXTERNAL_MONITOR_POLL_MS", 1_000, 250, 60_000),
    externalMonitorLivenessMs: integerSetting(env, "FORGEDECK_EXTERNAL_MONITOR_LIVENESS_MS", 2_500, 500, 60_000),
    externalMonitorThreadLimit: integerSetting(env, "FORGEDECK_EXTERNAL_MONITOR_THREAD_LIMIT", 32, 1, 500),
    externalMonitorMaxReadBytes: integerSetting(env, "FORGEDECK_EXTERNAL_MONITOR_MAX_READ_BYTES", 512 * 1024, 64 * 1024, 16 * 1024 * 1024)
  };
}

function resolveSetting(projectRoot: string, value: string | undefined, fallback: string): string {
  return path.resolve(projectRoot, value?.trim() || fallback);
}

function integerSetting(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function booleanSetting(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be on or off`);
}

function enumSetting<T extends string>(env: NodeJS.ProcessEnv, name: string, values: readonly T[], fallback: T): T {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  const value = values.find((candidate) => candidate === raw);
  if (!value) throw new Error(`${name} must be one of: ${values.join(", ")}`);
  return value;
}

function listSetting(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value.split(",").map((entry) => {
    const candidate = entry.trim();
    if (candidate === "*") throw new Error("ForgeDeck CORS origins must be explicit; wildcards are not supported");
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("ForgeDeck CORS entries must be HTTP(S) origins");
    const origin = parsed.origin;
    if (origin === "null") throw new Error("ForgeDeck CORS entries must be HTTP(S) origins");
    return origin;
  });
}

function hoursSetting(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}
