export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export type LogContext = Record<string, unknown>;

const SENSITIVE_KEY = /^(?:authorization|cookie|password|secret|token|api[_-]?key)$/i;
const SENSITIVE_VALUES: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  [/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[opsu]_[A-Za-z0-9_]{12,})\b/g, "[REDACTED_TOKEN]"],
  [/(\b(?:token|password|secret|authorization|api[_-]?key)\b\s*[=:]\s*)[^\s,;]+(?:\s+\[REDACTED\])?/gi, "$1[REDACTED]"]
];

export class Logger {
  private readonly minimumPriority: number;

  constructor(readonly level = parseLogLevel(process.env.FORGEDECK_LOG_LEVEL)) {
    this.minimumPriority = LEVEL_PRIORITY[level];
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
    if (LEVEL_PRIORITY[level] < this.minimumPriority) return;
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...redactLogContext(context)
    });
    if (level === "error") console.error(entry);
    else if (level === "warn") console.warn(entry);
    else if (level === "debug") console.debug(entry);
    else console.log(entry);
  }
}

export const logger = new Logger();

function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = value?.trim().toLowerCase();
  return normalized === "debug" || normalized === "warn" || normalized === "error" ? normalized : "info";
}

/** Recursively bounds and redacts structured context before it reaches stdout. */
export function redactLogContext(context: LogContext | undefined): LogContext {
  if (!context) return {};
  return Object.fromEntries(Object.entries(context).map(([key, value]) => [
    key,
    SENSITIVE_KEY.test(key) ? "[REDACTED]" : normalizeValue(value)
  ]));
}

function normalizeValue(value: unknown, depth = 0): unknown {
  if (value instanceof Error) {
    const metadata = value as Error & { code?: unknown; status?: unknown };
    return {
      name: value.name,
      message: redactSensitive(value.message),
      code: metadata.code,
      status: metadata.status,
      ...(process.env.NODE_ENV !== "production" && value.stack ? { stack: redactSensitive(value.stack) } : {})
    };
  }
  if (typeof value === "string") return redactSensitive(value);
  if (typeof value === "bigint") return String(value);
  if (!value || typeof value !== "object" || depth >= 4) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => normalizeValue(item, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 50).map(([key, item]) => [
    key,
    SENSITIVE_KEY.test(key) ? "[REDACTED]" : normalizeValue(item, depth + 1)
  ]));
}

/** Removes credential-shaped values from unstructured integration output. */
export function redactSensitive(value: string): string {
  return SENSITIVE_VALUES.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), value);
}
