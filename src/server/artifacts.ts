import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import * as z from "zod/v4";
import {
  artifactSchema,
  artifactSubmissionSchema,
  type Artifact,
  type ArtifactStatus,
  type ArtifactSubmission,
  type ArtifactType,
  type CompletionGate
} from "../shared/contracts.js";
import { TransactionalStore, type ArtifactStoreRow } from "./store.js";

const ARTIFACT_SCHEMA_VERSION = 1 as const;
const INLINE_CONTENT_LIMIT_BYTES = 256 * 1024;

export type ArtifactCreateContext = {
  actor: string;
  source: "runtime" | "http" | "mcp" | "user" | "system";
  cwd: string | null;
};

export class ArtifactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactValidationError";
  }
}

export class ArtifactManager {
  private readonly contentDirectory: string;

  constructor(
    private readonly store: TransactionalStore,
    dataDirectory: string,
    private readonly now: () => number = Date.now
  ) {
    this.contentDirectory = path.join(dataDirectory, "artifacts", "sha256");
  }

  list(sessionId: string): Artifact[] {
    return this.store.listArtifacts(sessionId).map(decodeArtifact);
  }

  get(id: string): Artifact | null {
    const row = this.store.getArtifact(id);
    return row ? decodeArtifact(row) : null;
  }

  async create(sessionId: string, input: unknown, context: ArtifactCreateContext): Promise<Artifact> {
    const submission = artifactSubmissionSchema.parse(input);
    const prepared = await this.prepareContent(submission, context.cwd);
    const schema = submission.schema || {
      id: `forgedeck.artifact.${artifactSlug(submission.type)}`,
      version: ARTIFACT_SCHEMA_VERSION
    };
    const validationErrors = [...prepared.errors, ...validateJsonSchema(schema.definition, prepared.content)];
    const contentJson = canonicalJson(prepared.content);
    const contentHash = prepared.contentHash || sha256(contentJson);
    const existing = this.list(sessionId).find((artifact) =>
      artifact.type === submission.type
      && artifact.name === submission.name
      && artifact.producer.itemId === (submission.itemId || null)
      && artifact.contentHash === contentHash
    );
    if (existing) return existing;

    const retentionPolicy = submission.retention?.policy || "session";
    const sensitive = submission.retention?.sensitive === true || retentionPolicy === "reference-only" || prepared.reference?.sensitive === true;
    const storeByReference = submission.type !== "FileArtifact"
      && (sensitive || Buffer.byteLength(contentJson) > INLINE_CONTENT_LIMIT_BYTES);
    const reference = prepared.reference || (storeByReference
      ? await this.storeContentReference(contentHash, contentJson, sensitive)
      : null);
    const timestamp = safeTimestamp(this.now());
    const version = this.store.nextArtifactVersion(sessionId, submission.type, submission.name);
    const artifact = artifactSchema.parse({
      id: randomUUID(),
      sessionId,
      name: submission.name,
      type: submission.type,
      version,
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      schema,
      producer: {
        sessionId,
        turnId: submission.turnId || null,
        itemId: submission.itemId || null,
        actor: context.actor
      },
      provenance: {
        source: context.source,
        trust: submission.provenance?.trust || defaultTrust(submission.type, context.source),
        command: submission.provenance?.command ?? commandFromContent(prepared.content),
        cwd: submission.provenance?.cwd ?? context.cwd,
        tool: submission.provenance?.tool ?? null,
        ...(submission.provenance?.details ? { details: submission.provenance.details } : {})
      },
      contentHash,
      retention: {
        policy: retentionPolicy,
        expiresAt: submission.retention?.expiresAt ?? null,
        sensitive
      },
      content: storeByReference ? referencedContentSummary(submission.type, prepared.content) : prepared.content,
      reference,
      validation: {
        status: validationErrors.length ? "invalid" : "valid",
        validatedAt: timestamp,
        validator: "forgedeck/artifact-validator@1",
        errors: validationErrors
      },
      createdAt: timestamp,
      updatedAt: timestamp
    });
    this.store.insertArtifact(encodeArtifact(artifact));
    return artifact;
  }

  async captureRuntimeItem(sessionId: string, item: Record<string, unknown>, cwd: string | null): Promise<Artifact[]> {
    const itemId = typeof item.id === "string" ? item.id : null;
    if (!itemId) return [];
    const turnId = typeof item.turnId === "string" ? item.turnId : null;
    const created: Artifact[] = [];
    if (item.type === "commandExecution" && typeof item.command === "string" && item.command.trim()) {
      const command = item.command.trim();
      const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
      const exitCode = Number.isInteger(item.exitCode) ? item.exitCode as number : null;
      const passed = exitCode === 0 || (exitCode === null && item.status === "completed");
      const common = {
        turnId,
        itemId,
        retention: { policy: "session" as const, sensitive: false },
        provenance: { trust: "deterministic" as const, command, cwd, tool: "commandExecution" }
      };
      created.push(await this.create(sessionId, {
        ...common,
        type: "CommandArtifact",
        name: `command:${itemId}`,
        content: { command, cwd, status: passed ? "passed" : "failed", exitCode, output }
      }, { actor: "runtime", source: "runtime", cwd }));
      if (isTestCommand(command)) {
        created.push(await this.create(sessionId, {
          ...common,
          type: "TestResultArtifact",
          name: `tests:${itemId}`,
          content: {
            command,
            status: passed ? "passed" : "failed",
            exitCode,
            ...testCounts(output),
            output
          }
        }, { actor: "runtime", source: "runtime", cwd }));
      }
    }
    if (item.type === "fileChange" && Array.isArray(item.changes)) {
      const changes = item.changes.filter(isRecord);
      const patches = changes.flatMap((change) => typeof change.diff === "string" && typeof change.path === "string"
        ? [{ path: change.path, diff: normalizeUnifiedDiff(change.path, change.diff) }]
        : []);
      if (patches.length) {
        created.push(await this.create(sessionId, {
          type: "PatchArtifact",
          name: `patch:${itemId}`,
          turnId,
          itemId,
          content: { format: "unified-diff", patch: patches.map(({ diff }) => diff).join("\n"), files: patches.map(({ path: file }) => file) },
          retention: { policy: "session", sensitive: false },
          provenance: { trust: "deterministic", cwd, tool: "fileChange" }
        }, { actor: "runtime", source: "runtime", cwd }));
      }
      for (const change of changes) {
        if (typeof change.path !== "string") continue;
        try {
          created.push(await this.create(sessionId, {
            type: "FileArtifact",
            name: change.path,
            turnId,
            itemId,
            content: { path: change.path },
            retention: { policy: "session", sensitive: sensitivePath(change.path) },
            provenance: { trust: "deterministic", cwd, tool: "fileChange" }
          }, { actor: "runtime", source: "runtime", cwd }));
        } catch (error) {
          if (!(error instanceof ArtifactValidationError)) throw error;
        }
      }
    }
    return created;
  }

  completionStatus(sessionId: string, gates: readonly CompletionGate[]): ArtifactStatus {
    return evaluateCompletionGates(this.list(sessionId), gates);
  }

  private async prepareContent(submission: ArtifactSubmission, cwd: string | null): Promise<{
    content: Record<string, unknown>;
    contentHash?: string;
    reference?: Artifact["reference"];
    errors: string[];
  }> {
    if (submission.type === "FileArtifact") {
      if (!cwd) throw new ArtifactValidationError("A workspace is required to validate a file artifact");
      const absolute = safeWorkspacePath(cwd, submission.content.path);
      let stat;
      try {
        stat = await fs.stat(absolute);
      } catch {
        throw new ArtifactValidationError(`Artifact file does not exist: ${submission.content.path}`);
      }
      if (!stat.isFile()) throw new ArtifactValidationError(`Artifact path is not a file: ${submission.content.path}`);
      const fileHash = await sha256File(absolute);
      return {
        content: {
          path: workspaceRelativePath(cwd, absolute),
          mediaType: mediaTypeForPath(absolute),
          byteSize: stat.size,
          fileHash,
          exists: true
        },
        contentHash: fileHash,
        reference: {
          kind: "workspace-file",
          uri: `workspace://${encodeURIComponent(workspaceRelativePath(cwd, absolute))}`,
          mediaType: mediaTypeForPath(absolute),
          byteSize: stat.size,
          sensitive: submission.retention?.sensitive === true || sensitivePath(absolute)
        },
        errors: []
      };
    }
    const content = structuredClone(submission.content) as Record<string, unknown>;
    const errors: string[] = [];
    if (submission.type === "PatchArtifact") {
      const patch = String(content.patch || "");
      content.files = Array.isArray(content.files) && content.files.length ? content.files : patchFiles(patch);
      content.appliesCleanly ??= null;
      if (!validUnifiedDiff(patch)) errors.push("Patch is not a valid unified diff");
    }
    if (submission.type === "TestResultArtifact" || submission.type === "CommandArtifact") {
      const passed = content.status === "passed";
      if (typeof content.exitCode === "number" && (content.exitCode === 0) !== passed) {
        errors.push("Artifact status conflicts with its exit code");
      }
    }
    if (submission.type === "ReviewVerdictArtifact" && content.verdict === "approved"
      && Array.isArray(content.findings) && content.findings.some((finding) => isRecord(finding) && finding.severity === "error")) {
      errors.push("An approved review cannot contain error findings");
    }
    return { content, errors };
  }

  private async storeContentReference(contentHash: string, content: string, sensitive: boolean): Promise<Artifact["reference"]> {
    const digest = contentHash.slice("sha256:".length);
    const directory = path.join(this.contentDirectory, digest.slice(0, 2));
    const target = path.join(directory, digest.slice(2));
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(target, content, { encoding: "utf8", mode: 0o600, flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    return {
      kind: "content-addressed",
      uri: `artifact://sha256/${digest}`,
      mediaType: "application/json",
      byteSize: Buffer.byteLength(content),
      sensitive
    };
  }
}

function evaluateCompletionGates(artifacts: readonly Artifact[], gates: readonly CompletionGate[]): ArtifactStatus {
  const validArtifacts = artifacts.filter((artifact) => artifact.validation.status === "valid");
  const required = gates.filter((gate) => gate.required);
  const unmetGates = required.flatMap((gate) => {
    const expectedType = gate.artifactType || inferArtifactType(gate);
    const expectedTrust = gate.trust || defaultGateTrust(expectedType);
    const candidates = validArtifacts.filter((artifact) => {
      if (expectedType && artifact.type !== expectedType) return false;
      if (gate.artifactName && artifact.name.toLocaleLowerCase("en-US") !== gate.artifactName.toLocaleLowerCase("en-US")) return false;
      if (gate.path && (artifact.type !== "FileArtifact" || artifact.content?.path !== gate.path)) return false;
      if (expectedTrust !== "advisory" && artifact.provenance.trust !== expectedTrust) return false;
      if ((gate.mustPass ?? passRequired(artifact.type)) && !artifactPassed(artifact)) return false;
      if (gate.schema) {
        if (artifact.content && validateJsonSchema(gate.schema, artifact.content).length === 0) {
          // The inline or projected content satisfies the gate directly.
        } else if (canonicalJson(gate.schema) !== canonicalJson(artifact.schema.definition)) {
          return false;
        }
      }
      return true;
    });
    const minimum = gate.minimumCount || 1;
    if (candidates.length >= minimum) return [];
    return [{
      name: gate.name,
      description: gate.description,
      required: true,
      artifactType: expectedType || null,
      reason: candidates.length
        ? `Requires ${minimum} matching artifacts; ${candidates.length} validated`
        : expectedType ? `No valid ${expectedType} satisfies this gate` : "No valid artifact satisfies this gate",
      trust: expectedTrust
    }];
  });
  return {
    status: gates.length === 0 ? "not-configured" : unmetGates.length ? "pending" : "passed",
    artifactCount: artifacts.length,
    validArtifactCount: validArtifacts.length,
    requiredGateCount: required.length,
    metGateCount: required.length - unmetGates.length,
    unmetGates
  };
}

function encodeArtifact(artifact: Artifact): ArtifactStoreRow {
  return {
    id: artifact.id,
    sessionId: artifact.sessionId,
    name: artifact.name,
    type: artifact.type,
    schemaJson: JSON.stringify(artifact.schema),
    version: artifact.version,
    producerSession: artifact.producer.sessionId,
    producerJson: JSON.stringify(artifact.producer),
    provenanceJson: JSON.stringify(artifact.provenance),
    contentHash: artifact.contentHash,
    retentionJson: JSON.stringify(artifact.retention),
    contentJson: artifact.content === null ? null : JSON.stringify(artifact.content),
    referenceJson: artifact.reference === null ? null : JSON.stringify(artifact.reference),
    validationJson: JSON.stringify(artifact.validation),
    createdAt: Date.parse(artifact.createdAt),
    updatedAt: Date.parse(artifact.updatedAt)
  };
}

function decodeArtifact(row: ArtifactStoreRow): Artifact {
  return artifactSchema.parse({
    id: row.id,
    sessionId: row.sessionId,
    name: row.name,
    type: row.type,
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    schema: JSON.parse(row.schemaJson),
    version: row.version,
    producer: JSON.parse(row.producerJson),
    provenance: JSON.parse(row.provenanceJson),
    contentHash: row.contentHash,
    retention: JSON.parse(row.retentionJson),
    content: row.contentJson === null ? null : JSON.parse(row.contentJson),
    reference: row.referenceJson === null ? null : JSON.parse(row.referenceJson),
    validation: JSON.parse(row.validationJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  });
}

function inferArtifactType(gate: CompletionGate): ArtifactType | null {
  if (gate.path) return "FileArtifact";
  const text = `${gate.name} ${gate.description}`.toLocaleLowerCase("en-US");
  if (/\b(test|tests|spec|suite)\b/.test(text)) return "TestResultArtifact";
  if (/\b(patch|diff)\b/.test(text)) return "PatchArtifact";
  if (/\b(review|verdict|approval)\b/.test(text)) return "ReviewVerdictArtifact";
  if (/\b(file|report|output)\b/.test(text)) return "FileArtifact";
  if (/\b(command|build|lint|typecheck|check)\b/.test(text)) return "CommandArtifact";
  return null;
}

function artifactPassed(artifact: Artifact): boolean {
  if (artifact.type === "TestResultArtifact" || artifact.type === "CommandArtifact") return artifact.content?.status === "passed";
  if (artifact.type === "ReviewVerdictArtifact") return artifact.content?.verdict === "approved";
  return true;
}

function passRequired(type: ArtifactType): boolean {
  return type === "TestResultArtifact" || type === "CommandArtifact" || type === "ReviewVerdictArtifact";
}

function defaultGateTrust(type: ArtifactType | null): "deterministic" | "human" | "advisory" {
  return type === "ReviewVerdictArtifact" ? "advisory" : "deterministic";
}

function defaultTrust(type: ArtifactType, source: ArtifactCreateContext["source"]): "deterministic" | "human" | "advisory" {
  if (source === "user") return "human";
  return type === "ReviewVerdictArtifact" ? "advisory" : "deterministic";
}

function validateJsonSchema(schema: Record<string, unknown> | undefined, value: unknown): string[] {
  if (!schema) return [];
  try {
    const result = z.fromJSONSchema(schema as never).safeParse(value);
    return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".") || "content"}: ${issue.message}`);
  } catch (error) {
    return [`Artifact JSON schema is invalid: ${error instanceof Error ? error.message : String(error)}`];
  }
}

function validUnifiedDiff(value: string): boolean {
  if (!value || value.includes("\0")) return false;
  const hasFiles = /^diff --git /m.test(value) || (/^---\s+\S+/m.test(value) && /^\+\+\+\s+\S+/m.test(value));
  return hasFiles && /^@@\s/m.test(value);
}

function normalizeUnifiedDiff(file: string, diff: string): string {
  if (/^diff --git /m.test(diff) || (/^---\s/m.test(diff) && /^\+\+\+\s/m.test(diff))) return diff;
  return `--- a/${file}\n+++ b/${file}\n${diff}`;
}

function patchFiles(value: string): string[] {
  const files = [...value.matchAll(/^\+\+\+\s+(?:b\/)?(.+)$/gm)].map((match) => match[1]!.trim()).filter((file) => file !== "/dev/null");
  return [...new Set(files)];
}

function isTestCommand(command: string): boolean {
  return /(^|\s)(npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|node\s+.*--test|pytest|vitest|jest|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+test|gradle\s+test)(\s|$)/i.test(command);
}

function testCounts(output: string): { passed?: number; failed?: number; skipped?: number } {
  const read = (label: string) => {
    const match = new RegExp(`(?:#\\s*)?${label}\\s*[:=]?\\s*(\\d+)`, "i").exec(output);
    return match ? Number(match[1]) : undefined;
  };
  const passed = read("pass(?:ed)?");
  const failed = read("fail(?:ed)?");
  const skipped = read("skip(?:ped)?");
  return { ...(passed === undefined ? {} : { passed }), ...(failed === undefined ? {} : { failed }), ...(skipped === undefined ? {} : { skipped }) };
}

function safeWorkspacePath(cwd: string, requested: string): string {
  const workspace = path.resolve(cwd);
  const resolved = path.resolve(workspace, requested);
  if (resolved !== workspace && !resolved.startsWith(`${workspace}${path.sep}`)) {
    throw new ArtifactValidationError("Artifact file must remain inside the session workspace");
  }
  return resolved;
}

function workspaceRelativePath(cwd: string, absolute: string): string {
  return path.relative(path.resolve(cwd), absolute).split(path.sep).join("/") || path.basename(absolute);
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return `sha256:${hash.digest("hex")}`;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sortJson(child)]));
}

function safeTimestamp(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new RangeError("Artifact timestamp must be non-negative");
  return new Date(value).toISOString();
}

function commandFromContent(content: Record<string, unknown>): string | null {
  return typeof content.command === "string" ? content.command : null;
}

function mediaTypeForPath(file: string): string {
  const extension = path.extname(file).toLocaleLowerCase("en-US");
  if ([".json", ".map"].includes(extension)) return "application/json";
  if ([".md", ".txt", ".log", ".csv", ".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".py", ".rs", ".go"].includes(extension)) return "text/plain";
  if (extension === ".pdf") return "application/pdf";
  return "application/octet-stream";
}

function sensitivePath(file: string): boolean {
  return /(^|\/)(\.env(?:\.|$)|.*(?:secret|credential|token|private[-_.]?key).*)/i.test(file);
}

function artifactSlug(type: ArtifactType): string {
  return type.replace(/Artifact$/, "").replace(/([a-z])([A-Z])/g, "$1-$2").toLocaleLowerCase("en-US");
}

function referencedContentSummary(type: ArtifactType, content: Record<string, unknown>): Record<string, unknown> {
  if (type === "PatchArtifact") return { ...content, patch: undefined };
  if (type === "TestResultArtifact" || type === "CommandArtifact") return { ...content, output: undefined, structuredOutput: undefined };
  if (type === "ReviewVerdictArtifact") {
    return { ...content, summary: "Content stored by reference", findings: [], details: undefined };
  }
  return content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
