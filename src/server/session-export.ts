import path from "node:path";
import { redactSensitive } from "./logger.js";
import type { SessionExport } from "../shared/contracts.js";

type JsonObject = Record<string, unknown>;

type SessionExportOptions = {
  exportedAt?: number | string | Date;
  metadata?: JsonObject;
  artifacts?: JsonObject[];
};

/** Builds the deliberately small, privacy-safe representation used by every export format. */
export function createSessionExport(thread: JsonObject, options: SessionExportOptions = {}): SessionExport {
  const metadata = options.metadata || {};
  const workspace = firstString(thread.cwd, metadata.cwd);
  const exportedAt = isoTimestamp(options.exportedAt ?? Date.now()) || new Date().toISOString();
  const createdAt = isoTimestamp(thread.createdAt) || isoTimestamp(metadata.createdAt) || exportedAt;
  const updatedAt = isoTimestamp(thread.updatedAt) || isoTimestamp(metadata.updatedAt) || createdAt;
  const turns = Array.isArray(thread.turns) ? thread.turns.map(asObject) : [];
  const keyOutputs: SessionExport["keyOutputs"] = [];
  const runtimeArtifactSummaries: SessionExport["artifactSummaries"] = [];
  const runRecords: SessionExport["runs"] = [];

  for (const [turnIndex, turn] of turns.entries()) {
    const turnId = stringValue(turn.id) || `turn-${turnIndex + 1}`;
    const items = Array.isArray(turn.items) ? turn.items.map(asObject) : [];
    const prompts = items.flatMap(promptText);
    const agentMessages = items.filter((item) => isAgentMessage(item.type)).map((item) => stringValue(item.text)).filter(Boolean);
    const lastAgentMessage = agentMessages.at(-1);
    if (lastAgentMessage) {
      keyOutputs.push({ turnId, text: safeText(lastAgentMessage, workspace) });
    }

    let artifactCount = 0;
    for (const item of items) {
      if (!isFileChange(item.type)) continue;
      const changes = Array.isArray(item.changes) ? item.changes.map(asObject) : [];
      const files = uniqueFiles(changes.map((change) => ({
        path: safeArtifactPath(stringValue(change.path) || stringValue(change.file) || stringValue(change.filePath), workspace),
        operation: safeNullableText(firstString(change.kind, change.type, change.action), workspace)
      })).filter((file) => file.path));
      runtimeArtifactSummaries.push({
        id: safeNullableText(firstString(item.id), workspace),
        turnId,
        type: "fileChanges",
        name: null,
        version: null,
        status: safeNullableText(firstString(item.status, turn.status), workspace),
        createdAt: null,
        fileCount: files.length,
        files
      });
      artifactCount += 1;
    }

    const startedAt = isoTimestamp(turn.startedAt);
    const completedAt = isoTimestamp(turn.completedAt);
    runRecords.push({
      id: turnId,
      status: safeText(stringValue(turn.status) || "unknown", workspace),
      startedAt,
      completedAt,
      durationMs: elapsedMilliseconds(startedAt, completedAt),
      prompt: prompts.length ? safeText(prompts.join("\n\n"), workspace) : null,
      keyOutputCount: lastAgentMessage ? 1 : 0,
      artifactCount,
      error: safeNullableText(errorMessage(turn.error), workspace)
    });
  }

  const firstPrompt = runRecords.find((run) => run.prompt)?.prompt
    || safeNullableText(firstString(metadata.lastPrompt), workspace);
  const provider = firstString(thread.provider, thread.backend, metadata.backend) === "claude" ? "claude" : "codex";
  const model = safeNullableText(firstString(thread.model, thread.claudeModel, metadata.model), workspace);
  const effort = safeNullableText(firstString(thread.reasoningEffort, thread.effort, thread.claudeEffort, metadata.effort), workspace);
  const blueprintId = safeNullableText(firstString(thread.blueprintId, metadata.blueprintId), workspace);
  const blueprintVersion = positiveInteger(thread.blueprintVersion) || positiveInteger(metadata.blueprintVersion);
  const persistedArtifactSummaries = (options.artifacts || []).map((artifact) => summarizeArtifact(artifact, workspace));
  const artifactSummaries = persistedArtifactSummaries.length ? persistedArtifactSummaries : runtimeArtifactSummaries;
  if (persistedArtifactSummaries.length) {
    for (const run of runRecords) run.artifactCount = persistedArtifactSummaries.filter((artifact) => artifact.turnId === run.id).length;
  }

  return {
    schemaVersion: 1,
    provenance: {
      sessionId: stringValue(thread.id),
      exportedAt,
      createdAt,
      updatedAt,
      blueprintId,
      blueprintVersion
    },
    session: {
      name: safeNullableText(firstString(thread.name, metadata.name), workspace),
      preview: safeNullableText(firstString(thread.preview), workspace),
      status: sessionStatus(thread, turns),
      provider,
      model,
      reasoningEffort: effort,
      sessionClass: firstString(thread.sessionClass, metadata.sessionClass) === "spark" ? "spark" : "standard",
      workspace: safeWorkspaceName(workspace),
      category: safeNullableText(firstString(thread.category, metadata.category), workspace),
      tags: Array.isArray(thread.tags)
        ? thread.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => safeText(tag, workspace))
        : Array.isArray(metadata.tags)
          ? metadata.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => safeText(tag, workspace))
          : [],
      durationMs: elapsedMilliseconds(createdAt, updatedAt),
      turnCount: turns.length
    },
    prompt: firstPrompt,
    runs: runRecords,
    artifactSummaries,
    keyOutputs,
    privacy: {
      secretsRedacted: true,
      rawToolOutputIncluded: false,
      absoluteWorkspacePathsIncluded: false
    }
  };
}

export function sessionExportToMarkdown(record: SessionExport): string {
  const title = record.session.name || record.session.preview || "Untitled session";
  const lines = [
    `# ForgeDeck session export: ${inlineMarkdown(title)}`,
    "",
    "## Provenance",
    "",
    `- Session ID: \`${inlineCode(record.provenance.sessionId)}\``,
    `- Exported: ${record.provenance.exportedAt}`,
    `- Created: ${record.provenance.createdAt}`,
    `- Updated: ${record.provenance.updatedAt}`,
    `- Blueprint: ${record.provenance.blueprintId ? `\`${inlineCode(record.provenance.blueprintId)}\` version ${record.provenance.blueprintVersion ?? "unknown"}` : "Not applicable"}`,
    "",
    "## Session metadata",
    "",
    `- Status: ${inlineMarkdown(record.session.status)}`,
    `- Provider: ${record.session.provider}`,
    `- Model: ${inlineMarkdown(record.session.model || "Unknown")}`,
    `- Reasoning effort: ${inlineMarkdown(record.session.reasoningEffort || "Not recorded")}`,
    `- Session class: ${record.session.sessionClass}`,
    `- Duration: ${formatDuration(record.session.durationMs)}`,
    `- Workspace: ${inlineMarkdown(record.session.workspace || "Not recorded")}`,
    `- Category: ${inlineMarkdown(record.session.category || "None")}`,
    `- Tags: ${record.session.tags.length ? record.session.tags.map(inlineMarkdown).join(", ") : "None"}`,
    "",
    "## Prompt",
    "",
    record.prompt ? quoteMarkdown(record.prompt) : "_No prompt was recorded._",
    "",
    "## Run records",
    ""
  ];

  if (!record.runs.length) lines.push("_No runs were recorded._", "");
  for (const [index, run] of record.runs.entries()) {
    lines.push(
      `### Run ${index + 1}: \`${inlineCode(run.id)}\``,
      "",
      `- Status: ${inlineMarkdown(run.status)}`,
      `- Started: ${run.startedAt || "Not recorded"}`,
      `- Completed: ${run.completedAt || "Not recorded"}`,
      `- Duration: ${formatDuration(run.durationMs)}`,
      `- Key outputs: ${run.keyOutputCount}`,
      `- Artifact groups: ${run.artifactCount}`
    );
    if (run.error) lines.push(`- Error: ${inlineMarkdown(run.error)}`);
    if (run.prompt) lines.push("", "Prompt:", "", quoteMarkdown(run.prompt));
    lines.push("");
  }

  lines.push("## Artifact summaries", "");
  if (!record.artifactSummaries.length) lines.push("_No file-change artifacts were recorded._", "");
  for (const artifact of record.artifactSummaries) {
    const label = artifact.name || artifact.type;
    const turn = artifact.turnId ? ` in \`${inlineCode(artifact.turnId)}\`` : "";
    const version = artifact.version ? ` version ${artifact.version}` : "";
    lines.push(`- **${inlineMarkdown(label)}** (${inlineMarkdown(artifact.type)}${version})${turn}${artifact.status ? ` — ${inlineMarkdown(artifact.status)}` : ""}`);
    if (artifact.createdAt) lines.push(`  - Created: ${artifact.createdAt}`);
    if (artifact.fileCount) lines.push(`  - Files: ${artifact.fileCount}`);
    for (const file of artifact.files) {
      lines.push(`  - \`${inlineCode(file.path)}\`${file.operation ? ` — ${inlineMarkdown(file.operation)}` : ""}`);
    }
  }
  lines.push("", "## Key outputs", "");
  if (!record.keyOutputs.length) lines.push("_No assistant output was recorded._", "");
  for (const [index, output] of record.keyOutputs.entries()) {
    lines.push(`### Output ${index + 1} · \`${inlineCode(output.turnId)}\``, "", quoteMarkdown(output.text), "");
  }
  lines.push(
    "## Privacy",
    "",
    "Secrets and credentials were redacted. Raw command/tool output and absolute workspace paths are excluded by default.",
    ""
  );
  return `${lines.join("\n").trimEnd()}\n`;
}

function promptText(item: JsonObject): string[] {
  if (!isUserMessage(item.type)) return [];
  const values: string[] = [];
  if (typeof item.text === "string") values.push(item.text);
  if (Array.isArray(item.content)) {
    for (const content of item.content) {
      const text = stringValue(asObject(content).text);
      if (text) values.push(text);
    }
  }
  return values;
}

function summarizeArtifact(artifact: JsonObject, workspace: string | null): SessionExport["artifactSummaries"][number] {
  const content = asObject(artifact.content);
  const producer = asObject(artifact.producer);
  const validation = asObject(artifact.validation);
  const type = safeText(stringValue(artifact.type) || "Artifact", workspace);
  const rawPaths = type === "FileArtifact"
    ? [stringValue(content.path)]
    : type === "PatchArtifact" && Array.isArray(content.files)
      ? content.files.filter((value): value is string => typeof value === "string")
      : [];
  const files = uniqueFiles(rawPaths.filter(Boolean).map((file) => ({
    path: safeArtifactPath(file, workspace),
    operation: null
  })));
  return {
    id: safeNullableText(firstString(artifact.id), workspace),
    turnId: safeNullableText(firstString(producer.turnId), workspace),
    type,
    name: safeNullableText(firstString(artifact.name), workspace),
    version: positiveInteger(artifact.version),
    status: safeNullableText(firstString(validation.status), workspace),
    createdAt: isoTimestamp(artifact.createdAt),
    fileCount: files.length,
    files
  };
}

function safeText(value: string, workspace: string | null): string {
  let result = redactSensitive(value);
  if (workspace) result = result.split(workspace).join("[WORKSPACE]");
  return result;
}

function safeNullableText(value: string | null, workspace: string | null): string | null {
  return value ? safeText(value, workspace) : null;
}

function safeWorkspaceName(workspace: string | null): string | null {
  if (!workspace) return null;
  const normalized = workspace.replace(/[\\/]+$/, "");
  return safeText(path.basename(normalized) || "[WORKSPACE]", workspace);
}

function safeArtifactPath(value: string, workspace: string | null): string {
  if (!value) return "";
  const normalized = value.replaceAll("\\", "/");
  const normalizedWorkspace = workspace?.replaceAll("\\", "/").replace(/\/+$/, "") || null;
  if (normalizedWorkspace && (normalized === normalizedWorkspace || normalized.startsWith(`${normalizedWorkspace}/`))) {
    return safeText(normalized.slice(normalizedWorkspace.length).replace(/^\/+/, "") || path.posix.basename(normalized), workspace);
  }
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) {
    return safeText(path.posix.basename(normalized), workspace);
  }
  return safeText(normalized.replace(/^\.\//, ""), workspace);
}

function uniqueFiles(files: SessionExport["artifactSummaries"][number]["files"]): SessionExport["artifactSummaries"][number]["files"] {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = `${file.path}\0${file.operation || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sessionStatus(thread: JsonObject, turns: JsonObject[]): string {
  const status = stringValue(asObject(thread.status).type);
  if (status === "active") return "active";
  if (status === "systemError") return "failed";
  return stringValue(turns.at(-1)?.status) || status || "unknown";
}

function errorMessage(value: unknown): string | null {
  if (typeof value === "string") return value;
  const error = asObject(value);
  return firstString(error.message, error.error);
}

function isoTimestamp(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const milliseconds = value < 100_000_000_000 ? value * 1_000 : value;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function elapsedMilliseconds(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  return Math.max(0, Date.parse(end) - Date.parse(start));
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function isUserMessage(value: unknown): boolean {
  return value === "userMessage" || value === "user_message";
}

function isAgentMessage(value: unknown): boolean {
  return value === "agentMessage" || value === "assistantMessage" || value === "assistant_message";
}

function isFileChange(value: unknown): boolean {
  return value === "fileChange" || value === "file_change";
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return null;
}

function inlineMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]()<>#+.!|-])/g, "\\$1").replace(/\r?\n/g, " ");
}

function inlineCode(value: string): string {
  return value.replaceAll("`", "ˋ").replace(/\r?\n/g, " ");
}

function quoteMarkdown(value: string): string {
  return value.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
}

function formatDuration(value: number | null): string {
  if (value === null) return "Not recorded";
  if (value < 1_000) return `${value} ms`;
  const seconds = Math.floor(value / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", `${remainder}s`].filter(Boolean).join(" ");
}
