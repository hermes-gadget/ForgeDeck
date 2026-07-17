export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export type LogContext = Record<string, unknown>;
export type LoggerOptions = {
  level?: LogLevel;
  requestSampleRate?: number;
  includeErrorStacks?: boolean;
  service?: string;
  version?: string;
};

const MAX_CONTEXT_DEPTH = 4;
const MAX_COLLECTION_SIZE = 50;
const SENSITIVE_VALUES: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  [/\bBasic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]"],
  [/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[opsu]_[A-Za-z0-9_]{12,})\b/g, "[REDACTED_TOKEN]"],
  [/(\b(?:token|password|passphrase|secret|authorization|api[_-]?key)\b\s*[=:]\s*)[^\s,;]+(?:\s+\[REDACTED\])?/gi, "$1[REDACTED]"],
  [/(\b(?:cookie|set-cookie|proxy-authorization)\b\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]"],
  [/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@"]
];

export class Logger {
  private minimumPriority = LEVEL_PRIORITY.info;
  private requestSampleRate = 1;
  private includeErrorStacks = false;
  private service = "forgedeck";
  private version = "0.1.0";
  level: LogLevel = "info";

  constructor(options: LogLevel | LoggerOptions = "info") {
    this.configure(typeof options === "string" ? { level: options } : options);
  }

  configure(options: LoggerOptions): void {
    if (options.level !== undefined) {
      this.level = options.level;
      this.minimumPriority = LEVEL_PRIORITY[options.level];
    }
    if (options.requestSampleRate !== undefined) {
      if (!Number.isFinite(options.requestSampleRate) || options.requestSampleRate < 0 || options.requestSampleRate > 1) {
        throw new RangeError("Request log sample rate must be between 0 and 1");
      }
      this.requestSampleRate = options.requestSampleRate;
    }
    if (options.includeErrorStacks !== undefined) this.includeErrorStacks = options.includeErrorStacks;
    if (options.service?.trim()) this.service = options.service.trim();
    if (options.version?.trim()) this.version = options.version.trim();
  }

  debug(message: string, context?: LogContext): void {
    this.write("debug", message, context);
  }

  info(message: string, context?: LogContext): void {
    this.write("info", message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.write("warn", message, context);
  }

  error(message: string, context?: LogContext): void {
    this.write("error", message, context);
  }

  private write(level: LogLevel, message: string, context?: LogContext): void {
    if (LEVEL_PRIORITY[level] < this.minimumPriority || !this.shouldLogRequest(level, message, context)) return;
    const timestamp = new Date().toISOString();
    try {
      const sanitized = redactLogContext(context, this.includeErrorStacks);
      const requestId = typeof sanitized.requestId === "string" ? sanitized.requestId : undefined;
      if (requestId !== undefined) delete sanitized.requestId;
      const entry = JSON.stringify({
        timestamp,
        level,
        message: redactSensitive(message),
        service: this.service,
        version: this.version,
        pid: process.pid,
        ...(requestId ? { requestId } : {}),
        ...(Object.keys(sanitized).length ? { context: sanitized } : {})
      });
      this.output(level, entry);
    } catch {
      // Logging must never interfere with the request/error path it observes.
      const fallback = JSON.stringify({
        timestamp,
        level: "error",
        message: "Log entry serialization failed",
        service: this.service,
        version: this.version,
        pid: process.pid
      });
      try { console.error(fallback); } catch { /* stdout/stderr is unavailable */ }
    }
  }

  private shouldLogRequest(level: LogLevel, message: string, context: LogContext | undefined): boolean {
    if (level !== "info" || message !== "HTTP request completed") return true;
    const status = context?.status;
    if (typeof status !== "number" || status >= 400 || this.requestSampleRate >= 1) return true;
    if (this.requestSampleRate <= 0) return false;
    const requestId = context?.requestId;
    return typeof requestId === "string"
      ? stableSample(requestId) < this.requestSampleRate
      : Math.random() < this.requestSampleRate;
  }

  private output(level: LogLevel, entry: string): void {
    if (level === "error") console.error(entry);
    else if (level === "warn") console.warn(entry);
    else if (level === "debug") console.debug(entry);
    else console.log(entry);
  }
}

export const logger = new Logger();

/** Recursively bounds and redacts structured context before it reaches stdout. */
export function redactLogContext(context: LogContext | undefined, includeErrorStacks = false): LogContext {
  if (!context) return {};
  const normalized = normalizeValue(context, 0, new WeakSet<object>(), includeErrorStacks);
  return normalized && typeof normalized === "object" && !Array.isArray(normalized)
    ? normalized as LogContext
    : { value: normalized };
}

function normalizeValue(value: unknown, depth: number, ancestors: WeakSet<object>, includeErrorStacks: boolean): unknown {
  if (typeof value === "string") return redactSensitive(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  if (!value || typeof value !== "object") return value;
  if (ancestors.has(value)) return "[CIRCULAR]";
  if (depth >= MAX_CONTEXT_DEPTH) return "[TRUNCATED]";

  ancestors.add(value);
  try {
    if (value instanceof Error) {
      const metadata = value as Error & { code?: unknown; status?: unknown; cause?: unknown };
      return {
        name: value.name,
        message: redactSensitive(value.message),
        code: normalizeValue(metadata.code, depth + 1, ancestors, includeErrorStacks),
        status: normalizeValue(metadata.status, depth + 1, ancestors, includeErrorStacks),
        ...(metadata.cause !== undefined ? { cause: normalizeValue(metadata.cause, depth + 1, ancestors, includeErrorStacks) } : {}),
        ...(includeErrorStacks && value.stack ? { stack: redactSensitive(value.stack) } : {})
      };
    }
    if (Array.isArray(value)) {
      return value.slice(0, MAX_COLLECTION_SIZE).map((item) => normalizeValue(item, depth + 1, ancestors, includeErrorStacks));
    }
    return normalizeRecord(value as Record<string, unknown>, depth, ancestors, includeErrorStacks);
  } catch {
    return "[UNSERIALIZABLE]";
  } finally {
    ancestors.delete(value);
  }
}

function normalizeRecord(
  value: Record<string, unknown>,
  depth: number,
  ancestors: WeakSet<object>,
  includeErrorStacks: boolean
): LogContext {
  const result: LogContext = {};
  let entries: Array<[string, unknown]>;
  try { entries = Object.entries(value).slice(0, MAX_COLLECTION_SIZE); } catch { return { value: "[UNSERIALIZABLE]" }; }
  for (const [key, item] of entries) {
    result[key] = isSensitiveKey(key)
      ? "[REDACTED]"
      : normalizeValue(item, depth + 1, ancestors, includeErrorStacks);
  }
  return result;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "");
  return normalized === "authorization"
    || normalized === "proxyauthorization"
    || normalized === "cookie"
    || normalized === "setcookie"
    || normalized === "password"
    || normalized === "passphrase"
    || normalized === "secret"
    || normalized === "clientsecret"
    || normalized === "apikey"
    || normalized.endsWith("token")
    || normalized.endsWith("tokenhash");
}

function stableSample(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

/** Removes credential-shaped values from unstructured integration output. */
export function redactSensitive(value: string): string {
  return SENSITIVE_VALUES.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), value);
}
