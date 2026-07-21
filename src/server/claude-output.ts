import type { ThreadItem } from "../shared/contracts.js";

type JsonObject = Record<string, unknown>;

export type ParsedClaudeOutput = {
  structured: boolean;
  items: ThreadItem[];
  displayText: string;
  sessionId: string | null;
  rateLimit: ClaudeRateLimitInfo | null;
};

export type ClaudeRateLimitInfo = {
  status: string;
  rateLimitType: string | null;
  resetsAt: number | null;
  overageStatus: string | null;
  overageDisabledReason: string | null;
  isUsingOverage: boolean | null;
};

/**
 * Converts Claude Code's JSON or stream-json stdout into ForgeDeck's canonical
 * thread items. tmux capture-pane -J restores each JSONL record to one logical
 * line, so invalid/partial lines can be ignored until a later capture completes
 * them.
 */
export function parseClaudeOutput(text: string, turnId: string): ParsedClaudeOutput {
  let streamRecords: JsonObject[] = [];
  let latestResult: JsonObject | null = null;
  let sawStream = false;

  for (const line of text.split(/\r?\n/)) {
    const record = parseJsonLine(line);
    if (!record) continue;
    if (record.type === "system" && record.subtype === "init") {
      sawStream = true;
      streamRecords = [record];
      continue;
    }
    if (sawStream) {
      streamRecords.push(record);
      continue;
    }
    if (record.type === "result") latestResult = record;
  }

  if (!sawStream && latestResult) {
    const result = stringValue(latestResult.result) || stringValue(latestResult.error) || "";
    return {
      structured: true,
      items: result ? [{ id: `${turnId}-result`, type: "agentMessage", text: result }] : [],
      displayText: result,
      sessionId: sessionIdFrom(latestResult),
      rateLimit: rejectedRateLimitFromResult(latestResult)
    };
  }
  if (!sawStream) return { structured: false, items: [], displayText: "", sessionId: null, rateLimit: null };

  const items: ThreadItem[] = [];
  const itemIndexes = new Map<string, number>();
  let sessionId: string | null = null;
  let finalResult = "";
  let rateLimit: ClaudeRateLimitInfo | null = null;
  const upsert = (item: ThreadItem) => {
    if (!item.id) {
      items.push(item);
      return;
    }
    const existing = itemIndexes.get(item.id);
    if (existing === undefined) {
      itemIndexes.set(item.id, items.length);
      items.push(item);
    } else {
      items[existing] = item;
    }
  };

  for (const [recordIndex, record] of streamRecords.entries()) {
    sessionId ||= sessionIdFrom(record);
    if (record.type === "rate_limit_event") {
      rateLimit = rateLimitFromEvent(record) || rateLimit;
      continue;
    }
    if (record.type === "result") {
      finalResult = stringValue(record.result) || stringValue(record.error) || finalResult;
      rateLimit ||= rejectedRateLimitFromResult(record);
      continue;
    }
    if (record.type === "assistant") {
      if (record.error === "rate_limit") rateLimit ||= rejectedRateLimitFromResult(record);
      const message = objectValue(record.message);
      const messageId = stringValue(message.id) || `${recordIndex}`;
      const content = contentBlocks(message.content);
      const textBlocks = content.filter((block) => block.type === "text").map((block) => stringValue(block.text)).filter(Boolean);
      if (textBlocks.length) {
        upsert({ id: `${turnId}-agent-${messageId}`, type: "agentMessage", text: textBlocks.join("\n") });
      }
      const thinkingBlocks = content.filter((block) => block.type === "thinking").map((block) => stringValue(block.thinking)).filter(Boolean);
      if (thinkingBlocks.length) {
        upsert({ id: `${turnId}-reasoning-${messageId}`, type: "reasoning", summary: thinkingBlocks });
      }
      for (const [blockIndex, block] of content.entries()) {
        if (block.type !== "tool_use") continue;
        const toolUseId = stringValue(block.id) || `${messageId}-${blockIndex}`;
        upsert(toolUseItem(turnId, toolUseId, stringValue(block.name) || "Tool", objectValue(block.input)));
      }
      continue;
    }
    if (record.type !== "user") continue;
    const message = objectValue(record.message);
    for (const block of contentBlocks(message.content)) {
      if (block.type !== "tool_result") continue;
      const toolUseId = stringValue(block.tool_use_id);
      if (!toolUseId) continue;
      const itemId = `${turnId}-tool-${toolUseId}`;
      const itemIndex = itemIndexes.get(itemId);
      if (itemIndex === undefined) continue;
      const current = items[itemIndex];
      const result = toolResultText(block.content);
      const failed = block.is_error === true;
      if (current.type === "commandExecution") {
        upsert({ ...current, status: failed ? "failed" : "completed", aggregatedOutput: result, exitCode: failed ? 1 : 0 });
      } else {
        upsert({ ...current, status: failed ? "failed" : "completed", ...(failed ? { error: result } : { result }) });
      }
    }
  }

  const hasAgentText = items.some((item) => item.type === "agentMessage" && typeof item.text === "string" && item.text);
  if (finalResult && !hasAgentText) {
    upsert({ id: `${turnId}-result`, type: "agentMessage", text: finalResult });
  }
  return {
    structured: true,
    items,
    displayText: displayText(items, finalResult),
    sessionId,
    rateLimit
  };
}

function rateLimitFromEvent(record: JsonObject): ClaudeRateLimitInfo | null {
  const info = objectValue(record.rate_limit_info);
  const status = stringValue(info.status);
  if (!status) return null;
  return {
    status,
    rateLimitType: nullableString(info.rateLimitType),
    resetsAt: nullableNumber(info.resetsAt),
    overageStatus: nullableString(info.overageStatus),
    overageDisabledReason: nullableString(info.overageDisabledReason),
    isUsingOverage: typeof info.isUsingOverage === "boolean" ? info.isUsingOverage : null
  };
}

function rejectedRateLimitFromResult(record: JsonObject): ClaudeRateLimitInfo | null {
  const status = nullableNumber(record.api_error_status);
  const message = [stringValue(record.result), stringValue(record.error)].join(" ");
  if (status !== 429 && record.error !== "rate_limit" && !/hit your (?:session|usage) limit/i.test(message)) return null;
  return {
    status: "rejected",
    rateLimitType: null,
    resetsAt: null,
    overageStatus: null,
    overageDisabledReason: null,
    isUsingOverage: null
  };
}

function toolUseItem(turnId: string, toolUseId: string, tool: string, input: JsonObject): ThreadItem {
  const id = `${turnId}-tool-${toolUseId}`;
  if (tool === "Bash") {
    return {
      id,
      type: "commandExecution",
      command: stringValue(input.command) || "",
      cwd: stringValue(input.cwd) || undefined,
      status: "inProgress",
      aggregatedOutput: null,
      exitCode: null
    };
  }
  if (["Edit", "Write", "NotebookEdit"].includes(tool)) {
    const file = stringValue(input.file_path) || stringValue(input.notebook_path) || "Unknown file";
    return {
      id,
      type: "fileChange",
      status: "inProgress",
      changes: [{ path: file, diff: editDiff(input) }],
      tool
    };
  }
  return { id, type: "toolCall", server: "Claude", tool, arguments: input, status: "inProgress" };
}

function editDiff(input: JsonObject): string {
  const before = stringValue(input.old_string);
  const after = stringValue(input.new_string);
  if (!before && !after) return "";
  const lines = [
    "@@ Claude edit @@",
    ...before.split("\n").map((line) => `-${line}`),
    ...after.split("\n").map((line) => `+${line}`)
  ];
  const diff = lines.join("\n");
  return diff.length <= 20_000 ? diff : `${diff.slice(0, 20_000)}\n…[edit preview truncated]`;
}

function displayText(items: ThreadItem[], finalResult: string): string {
  const agent = [...items].reverse().find((item) => item.type === "agentMessage" && typeof item.text === "string" && item.text);
  if (agent?.text) return agent.text;
  if (finalResult) return finalResult;
  const latest = items.at(-1);
  if (!latest) return "";
  if (latest.type === "commandExecution") return latest.command ? `Running: ${latest.command}` : "Running a command";
  if (latest.type === "fileChange") return `Editing ${String(latest.changes?.[0]?.path || "a file")}`;
  return latest.tool ? `Using ${latest.tool}` : "Claude is working";
}

function parseJsonLine(line: string): JsonObject | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    return objectValue(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function contentBlocks(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(objectValue).filter((block) => Object.keys(block).length > 0) : [];
}

function toolResultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (typeof entry === "string") return entry;
      const block = objectValue(entry);
      return stringValue(block.text) || stringValue(block.content) || JSON.stringify(block);
    }).filter(Boolean).join("\n");
  }
  if (value === undefined || value === null) return "";
  try { return JSON.stringify(value); } catch { return String(value); }
}

function sessionIdFrom(record: JsonObject): string | null {
  const value = stringValue(record.session_id);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : null;
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function nullableNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
}
