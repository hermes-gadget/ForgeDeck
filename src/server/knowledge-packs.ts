import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { TransactionalStore, type KnowledgePackStoreRow } from "./store.js";
import type { KnowledgePackSource } from "../shared/contracts.js";

const MAX_PACK_BYTES = 512 * 1024;
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_PATH_FILES = 200;
const URL_TIMEOUT_MS = 10_000;
const IGNORED_DIRECTORIES = new Set([".git", ".hg", ".svn", "node_modules"]);

type FilesystemState = {
  type: "filesystem";
  path: string;
  exists: boolean;
  directory: boolean;
  mtimeMs: number;
  size: number;
};

export type KnowledgePackScope = "global" | "workspace";

export type KnowledgePack = {
  id: string;
  name: string;
  scope: KnowledgePackScope;
  workspace: string | null;
  sources: KnowledgePackSource[];
  content: string;
  contentHash: string | null;
  status: "ready" | "partial" | "error";
  errors: string[];
  charCount: number;
  createdAt: number;
  updatedAt: number;
  refreshedAt: number | null;
};

export type CreateKnowledgePackInput = {
  name: string;
  scope: KnowledgePackScope;
  workspace: string | null;
  sources: KnowledgePackSource[];
};

export class KnowledgePackConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgePackConflictError";
  }
}

/**
 * Renders source-backed context into a durable SQLite cache. Filesystem cache
 * entries are revalidated by metadata before every read; URL entries remain
 * cached until an explicit refresh.
 */
export class KnowledgePackManager {
  private readonly refreshes = new Map<string, Promise<KnowledgePack | null>>();

  constructor(
    private readonly store: TransactionalStore,
    private readonly now: () => number = Date.now
  ) {}

  async create(input: CreateKnowledgePackInput): Promise<KnowledgePack> {
    const normalized = normalizeInput(input);
    const duplicate = this.store.listKnowledgePacks().find((row) => (
      row.scope === normalized.scope
      && row.workspace === normalized.workspace
      && row.name.localeCompare(normalized.name, undefined, { sensitivity: "accent" }) === 0
    ));
    if (duplicate) throw new KnowledgePackConflictError("A knowledge pack with this name already exists in the selected scope");
    const timestamp = this.timestamp();
    const row: KnowledgePackStoreRow = {
      id: randomUUID(),
      name: normalized.name,
      scope: normalized.scope,
      workspace: normalized.workspace,
      sourcesJson: JSON.stringify(normalized.sources),
      cachedContent: null,
      contentHash: null,
      sourceStateJson: "[]",
      refreshError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      refreshedAt: null
    };
    try {
      this.store.insertKnowledgePack(row);
    } catch (error) {
      if (/unique constraint/i.test(String((error as Error)?.message || error))) {
        throw new KnowledgePackConflictError("A knowledge pack with this name already exists in the selected scope");
      }
      throw error;
    }
    const pack = await this.refresh(row.id);
    if (!pack) throw new Error("Knowledge pack was removed while its sources were being refreshed");
    return pack;
  }

  async list(options: { workspace?: string; scope?: KnowledgePackScope } = {}): Promise<KnowledgePack[]> {
    const rows = this.store.listKnowledgePacks().filter((row) => {
      if (options.scope && row.scope !== options.scope) return false;
      if (options.workspace !== undefined && row.scope === "workspace" && row.workspace !== options.workspace) return false;
      return true;
    });
    const packs = await Promise.all(rows.map((row) => this.ensureFresh(row.id)));
    return packs.filter((pack): pack is KnowledgePack => pack !== null);
  }

  async get(id: string): Promise<KnowledgePack | null> {
    return this.ensureFresh(id);
  }

  packIdsForWorkspace(workspace: string): string[] {
    return this.store.listKnowledgePacks()
      .filter((row) => row.scope === "global" || row.workspace === workspace)
      .map((row) => row.id);
  }

  async contextForIds(ids: readonly string[]): Promise<string> {
    const uniqueIds = [...new Set(ids)];
    const packs = (await Promise.all(uniqueIds.map((id) => this.ensureFresh(id))))
      .filter((pack): pack is KnowledgePack => Boolean(pack?.content));
    if (!packs.length) return "";
    return [
      "<knowledge-pack-context>",
      "The following source-backed context was attached by ForgeDeck for this workspace.",
      ...packs.map((pack) => [
        `<knowledge-pack name=${JSON.stringify(pack.name)} scope=${JSON.stringify(pack.scope)}${pack.workspace ? ` workspace=${JSON.stringify(pack.workspace)}` : ""}>`,
        pack.content,
        "</knowledge-pack>"
      ].join("\n")),
      "</knowledge-pack-context>"
    ].join("\n\n");
  }

  async refresh(id: string): Promise<KnowledgePack | null> {
    const active = this.refreshes.get(id);
    if (active) return active;
    const refresh = this.performRefresh(id).finally(() => this.refreshes.delete(id));
    this.refreshes.set(id, refresh);
    return refresh;
  }

  remove(id: string): boolean {
    return this.store.removeKnowledgePack(id);
  }

  private async ensureFresh(id: string): Promise<KnowledgePack | null> {
    const row = this.store.getKnowledgePack(id);
    if (!row) return null;
    if (row.cachedContent === null || !await filesystemCacheIsFresh(row.sourceStateJson)) {
      return this.refresh(id);
    }
    return decodeRow(row);
  }

  private async performRefresh(id: string): Promise<KnowledgePack | null> {
    const existing = this.store.getKnowledgePack(id);
    if (!existing) return null;
    const invalidatedAt = this.timestamp();
    this.store.invalidateKnowledgePack(id, invalidatedAt);
    const sources = decodeSources(existing.sourcesJson);
    const states: FilesystemState[] = [];
    const blocks: string[] = [];
    const errors: string[] = [];
    let byteCount = 0;

    for (const source of sources) {
      try {
        const rendered = source.type === "url"
          ? await readUrlSource(source.reference)
          : await readFilesystemSource(existing.scope, existing.workspace, source);
        states.push(...rendered.states);
        for (const block of rendered.blocks) {
          const bytes = Buffer.byteLength(block);
          if (byteCount + bytes > MAX_PACK_BYTES) {
            errors.push(`Pack content was truncated at ${MAX_PACK_BYTES} bytes`);
            break;
          }
          blocks.push(block);
          byteCount += bytes;
        }
        errors.push(...rendered.errors);
      } catch (error) {
        if (source.type !== "url") {
          try {
            states.push({
              type: "filesystem",
              path: resolveSourcePath(existing.scope, existing.workspace, source.reference),
              exists: false,
              directory: false,
              mtimeMs: 0,
              size: 0
            });
          } catch { /* the validation error below is the useful source error */ }
        }
        errors.push(`${source.reference}: ${safeMessage(error)}`);
      }
      if (byteCount >= MAX_PACK_BYTES) break;
    }

    const content = blocks.join("\n\n");
    const refreshedAt = this.timestamp();
    const updated = this.store.updateKnowledgePackCache(id, {
      cachedContent: content,
      contentHash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      sourceStateJson: JSON.stringify(states),
      refreshError: errors.length ? JSON.stringify(errors) : null,
      updatedAt: refreshedAt,
      refreshedAt
    });
    const row = updated ? this.store.getKnowledgePack(id) : null;
    return row ? decodeRow(row) : null;
  }

  private timestamp(): number {
    const value = this.now();
    if (!Number.isFinite(value) || value < 0) throw new RangeError("Knowledge pack clock must return a non-negative finite timestamp");
    return Math.round(value);
  }
}

function normalizeInput(input: CreateKnowledgePackInput): CreateKnowledgePackInput {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (!name || name.length > 100) throw new Error("Knowledge pack name must contain between 1 and 100 characters");
  if (input.scope !== "global" && input.scope !== "workspace") throw new Error("Knowledge pack scope is invalid");
  const workspace = input.scope === "workspace" ? input.workspace : null;
  if (input.scope === "workspace" && (!workspace || !path.isAbsolute(workspace))) {
    throw new Error("Workspace-scoped knowledge packs require an absolute workspace path");
  }
  if (!Array.isArray(input.sources) || input.sources.length === 0 || input.sources.length > 50) {
    throw new Error("Knowledge packs require between 1 and 50 sources");
  }
  const sources = input.sources.map((source) => {
    const reference = source.reference.trim();
    if (!reference) throw new Error("Knowledge pack source references must not be empty");
    if (source.type === "url" && !/^https?:\/\//i.test(reference)) throw new Error(`Knowledge pack URL must use HTTP or HTTPS: ${reference}`);
    if (source.type !== "url" && source.type !== "file" && source.type !== "path") throw new Error("Knowledge pack source type is invalid");
    return { type: source.type, reference };
  });
  return { name, scope: input.scope, workspace, sources };
}

function decodeRow(row: KnowledgePackStoreRow): KnowledgePack {
  const errors = decodeErrors(row.refreshError);
  const content = row.cachedContent || "";
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    workspace: row.workspace,
    sources: decodeSources(row.sourcesJson),
    content,
    contentHash: row.contentHash,
    status: errors.length ? content ? "partial" : "error" : "ready",
    errors,
    charCount: content.length,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    refreshedAt: row.refreshedAt
  };
}

function decodeSources(value: string): KnowledgePackSource[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Stored knowledge pack sources are invalid");
  return parsed.map((source) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Stored knowledge pack source is invalid");
    const candidate = source as Partial<KnowledgePackSource>;
    if (!(candidate.type === "file" || candidate.type === "path" || candidate.type === "url") || typeof candidate.reference !== "string") {
      throw new Error("Stored knowledge pack source is invalid");
    }
    return { type: candidate.type, reference: candidate.reference };
  });
}

function decodeErrors(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [value];
  } catch {
    return [value];
  }
}

async function filesystemCacheIsFresh(sourceStateJson: string): Promise<boolean> {
  let states: FilesystemState[];
  try {
    const parsed = JSON.parse(sourceStateJson) as unknown;
    if (!Array.isArray(parsed)) return false;
    states = parsed.filter((state): state is FilesystemState => Boolean(
      state && typeof state === "object" && !Array.isArray(state)
      && (state as FilesystemState).type === "filesystem"
      && typeof (state as FilesystemState).path === "string"
    ));
  } catch {
    return false;
  }
  for (const state of states) {
    try {
      const current = await fs.lstat(state.path);
      if (state.exists === false) return false;
      if (current.isDirectory() !== state.directory || current.mtimeMs !== state.mtimeMs || current.size !== state.size) return false;
    } catch (error) {
      if (state.exists === false && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return false;
    }
  }
  return true;
}

async function readFilesystemSource(
  scope: KnowledgePackScope,
  workspace: string | null,
  source: KnowledgePackSource
): Promise<{ blocks: string[]; states: FilesystemState[]; errors: string[] }> {
  const resolved = resolveSourcePath(scope, workspace, source.reference);
  const stats = await fs.lstat(resolved);
  if (stats.isSymbolicLink()) throw new Error("symbolic links are not supported");
  if (source.type === "file" && !stats.isFile()) throw new Error("file sources must reference a regular file");
  const states: FilesystemState[] = [filesystemState(resolved, stats)];
  if (stats.isFile()) {
    try {
      const read = await readTextFile(resolved, stats.size);
      return { blocks: [sourceBlock(`file:${resolved}`, read.content)], states, errors: read.truncated ? [`${resolved}: content was truncated`] : [] };
    } catch (error) {
      return { blocks: [], states, errors: [`${resolved}: ${safeMessage(error)}`] };
    }
  }
  if (!stats.isDirectory()) throw new Error("path sources must reference a regular file or directory");
  const files: Array<{ file: string; size: number }> = [];
  try {
    await collectDirectoryFiles(resolved, files, states);
  } catch (error) {
    return { blocks: [], states, errors: [`${resolved}: ${safeMessage(error)}`] };
  }
  const blocks: string[] = [];
  const errors: string[] = [];
  for (const entry of files) {
    try {
      const read = await readTextFile(entry.file, entry.size);
      blocks.push(sourceBlock(`file:${entry.file}`, read.content));
      if (read.truncated) errors.push(`${entry.file}: content was truncated`);
    } catch (error) {
      errors.push(`${entry.file}: ${safeMessage(error)}`);
    }
  }
  if (files.length >= MAX_PATH_FILES) errors.push(`${resolved}: only the first ${MAX_PATH_FILES} files were included`);
  return { blocks, states, errors };
}

function resolveSourcePath(scope: KnowledgePackScope, workspace: string | null, reference: string): string {
  if (scope === "global") {
    if (!path.isAbsolute(reference)) throw new Error("global file and path sources must be absolute");
    return path.resolve(reference);
  }
  if (!workspace) throw new Error("workspace path is missing");
  const resolved = path.resolve(workspace, reference);
  const relative = path.relative(workspace, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("workspace sources must stay within the workspace");
  return resolved;
}

async function collectDirectoryFiles(
  directory: string,
  files: Array<{ file: string; size: number }>,
  states: FilesystemState[]
): Promise<void> {
  if (files.length >= MAX_PATH_FILES) return;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (files.length >= MAX_PATH_FILES) return;
    if (entry.isSymbolicLink() || (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name))) continue;
    const candidate = path.join(directory, entry.name);
    const stats = await fs.lstat(candidate);
    states.push(filesystemState(candidate, stats));
    if (stats.isDirectory()) await collectDirectoryFiles(candidate, files, states);
    else if (stats.isFile()) files.push({ file: candidate, size: stats.size });
  }
}

function filesystemState(file: string, stats: Awaited<ReturnType<typeof fs.lstat>>): FilesystemState {
  return { type: "filesystem", path: file, exists: true, directory: stats.isDirectory(), mtimeMs: Number(stats.mtimeMs), size: Number(stats.size) };
}

async function readTextFile(file: string, size: number): Promise<{ content: string; truncated: boolean }> {
  const truncated = size > MAX_SOURCE_BYTES;
  const length = Math.min(size, MAX_SOURCE_BYTES);
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    const content = buffer.subarray(0, bytesRead);
    if (content.includes(0)) throw new Error("binary files are not supported");
    return { content: content.toString("utf8"), truncated };
  } finally {
    await handle.close();
  }
}

async function readUrlSource(reference: string): Promise<{ blocks: string[]; states: FilesystemState[]; errors: string[] }> {
  const response = await fetch(reference, {
    headers: { Accept: "text/plain, text/markdown, application/json;q=0.9, */*;q=0.1" },
    signal: AbortSignal.timeout(URL_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("URL returned no content");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    const remaining = MAX_SOURCE_BYTES - bytes;
    if (result.value.byteLength > remaining) {
      if (remaining > 0) chunks.push(result.value.subarray(0, remaining));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(result.value);
    bytes += result.value.byteLength;
  }
  const content = Buffer.concat(chunks).toString("utf8");
  return {
    blocks: [sourceBlock(`url:${reference}`, content)],
    states: [],
    errors: truncated ? [`${reference}: content was truncated`] : []
  };
}

function sourceBlock(reference: string, content: string): string {
  return [`--- SOURCE ${reference} ---`, content, `--- END SOURCE ${reference} ---`].join("\n");
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
