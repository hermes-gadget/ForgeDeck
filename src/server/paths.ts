import fs from "node:fs/promises";
import path from "node:path";

const BLOCKED_SEGMENTS = new Set([
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker",
  ".password-store", ".local/share/keyrings", ".config/gcloud", ".config/gh"
]);
const BLOCKED_FILES = new Set([".netrc", ".npmrc", ".pypirc"]);
const DEFAULT_SEARCH_OPTIONS: WorkspaceSearchLimits = {
  maxEntries: 4_000,
  maxDepth: 6,
  resultLimit: 30,
  allowHidden: false
};

export type DirectoryEntry = { name: string; path: string };
export type FileSuggestion = { name: string; path: string; relativePath: string; type: "file" | "directory" };
export type WorkspaceSearchLimits = {
  maxEntries: number;
  maxDepth: number;
  resultLimit: number;
  allowHidden: boolean;
};
export type FileSearchOptions = Partial<Pick<WorkspaceSearchLimits, "maxEntries" | "maxDepth">> & {
  limit?: number;
  signal?: AbortSignal;
};

export class WorkspacePaths {
  readonly roots: readonly string[];

  private constructor(roots: readonly string[], private readonly searchOptions: Readonly<WorkspaceSearchLimits>) {
    this.roots = Object.freeze([...roots]);
  }

  static async create(
    candidates: readonly string[],
    options: WorkspaceSearchLimits = DEFAULT_SEARCH_OPTIONS
  ): Promise<WorkspacePaths> {
    const roots = await Promise.all(candidates.map(async (candidate) => {
      const resolved = await fs.realpath(path.resolve(candidate));
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) throw new Error(`Workspace root is not a directory: ${candidate}`);
      return resolved;
    }));
    return new WorkspacePaths([...new Set(roots)], Object.freeze(normalizeSearchLimits(options)));
  }

  async validate(candidate: string): Promise<string> {
    if (!candidate || !path.isAbsolute(candidate)) {
      throw new PathError("Choose an absolute directory path", 400);
    }
    let resolved: string;
    try {
      resolved = await fs.realpath(candidate);
    } catch {
      throw new PathError("That directory does not exist", 404);
    }
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) throw new PathError("That path is not a directory", 400);
    if (!this.roots.some((root) => isWithin(root, resolved))) {
      throw new PathError("That directory is outside the configured workspace roots", 403);
    }
    if (this.isSensitive(resolved)) {
      throw new PathError("Credential and key directories cannot be selected as workspaces", 403);
    }
    return resolved;
  }

  async list(candidate?: string): Promise<{ path: string | null; parent: string | null; entries: DirectoryEntry[] }> {
    if (!candidate) {
      return {
        path: null,
        parent: null,
        entries: this.roots.map((root) => ({ name: root, path: root }))
      };
    }
    const resolved = await this.validate(candidate);
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const visible = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !this.isSensitive(path.join(resolved, entry.name)))
      .map((entry) => ({ name: entry.name, path: path.join(resolved, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

    const containingRoot = this.roots.find((root) => isWithin(root, resolved));
    const parent = containingRoot && resolved !== containingRoot ? path.dirname(resolved) : null;
    return { path: resolved, parent, entries: visible };
  }

  async searchFiles(cwd: string, query: string, limitOrOptions: number | FileSearchOptions = {}): Promise<FileSuggestion[]> {
    const requested = typeof limitOrOptions === "number" ? { limit: limitOrOptions } : limitOrOptions;
    const limit = boundedInteger(requested.limit, this.searchOptions.resultLimit, 0, this.searchOptions.resultLimit);
    if (limit === 0) return [];
    const maxEntries = boundedInteger(requested.maxEntries, this.searchOptions.maxEntries, 1, this.searchOptions.maxEntries);
    const maxDepth = boundedInteger(requested.maxDepth, this.searchOptions.maxDepth, 0, this.searchOptions.maxDepth);
    throwIfAborted(requested.signal);
    const root = await this.validate(cwd);
    throwIfAborted(requested.signal);
    const needle = query.trim().replace(/^\.\//, "").normalize("NFKC").toLocaleLowerCase("en-US");
    const results: FileSuggestion[] = [];
    const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
    const visited = new Set<string>();
    let scanned = 0;
    for (let head = 0; head < queue.length && scanned < maxEntries; head += 1) {
      throwIfAborted(requested.signal);
      const current = queue[head];
      if (!current) break;
      let directory: string;
      try {
        const pathStat = await fs.lstat(current.directory);
        if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) continue;
        directory = await fs.realpath(current.directory);
      } catch {
        throwIfAborted(requested.signal);
        continue;
      }
      if (visited.has(directory) || !isWithin(root, directory) || this.isSensitive(directory)) continue;
      visited.add(directory);
      try {
        const entries = await fs.opendir(directory);
        for await (const entry of entries) {
          throwIfAborted(requested.signal);
          if (scanned >= maxEntries) break;
          scanned += 1;
          const absolute = path.join(directory, entry.name);
          if (isIgnoredEntry(entry.name, this.searchOptions.allowHidden) || this.isSensitive(absolute)) continue;
          if (!entry.isFile() && !entry.isDirectory()) continue;
          const relativePath = path.relative(root, absolute);
          if (entry.isDirectory() && current.depth < maxDepth) queue.push({ directory: absolute, depth: current.depth + 1 });
          const normalizedName = entry.name.normalize("NFKC").toLocaleLowerCase("en-US");
          const normalizedRelative = relativePath.normalize("NFKC").toLocaleLowerCase("en-US");
          if (!needle || normalizedRelative.includes(needle) || normalizedName.includes(needle)) {
            insertTopResult(results, {
              name: entry.name,
              path: absolute,
              relativePath,
              type: entry.isDirectory() ? "directory" : "file"
            }, needle, limit);
          }
        }
      } catch {
        throwIfAborted(requested.signal);
      }
    }
    return results;
  }

  private isSensitive(candidate: string): boolean {
    for (const root of this.roots) {
      if (!isWithin(root, candidate)) continue;
      const relative = path.relative(root, candidate);
      const segments = relative.split(path.sep).map(normalizeSensitiveSegment);
      return segments.some((segment, index) =>
        BLOCKED_SEGMENTS.has(segment)
        || BLOCKED_FILES.has(segment)
        || BLOCKED_SEGMENTS.has(segments.slice(index, index + 2).join("/"))
        || BLOCKED_SEGMENTS.has(segments.slice(index, index + 3).join("/"))
      );
    }
    return true;
  }
}

function normalizeSensitiveSegment(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function normalizeSearchLimits(options: WorkspaceSearchLimits): WorkspaceSearchLimits {
  return {
    maxEntries: boundedInteger(options.maxEntries, DEFAULT_SEARCH_OPTIONS.maxEntries, 1, 100_000),
    maxDepth: boundedInteger(options.maxDepth, DEFAULT_SEARCH_OPTIONS.maxDepth, 0, 32),
    resultLimit: boundedInteger(options.resultLimit, DEFAULT_SEARCH_OPTIONS.resultLimit, 1, 200),
    allowHidden: options.allowHidden === true
  };
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function isIgnoredEntry(
  name: string,
  allowHidden: boolean
): boolean {
  const normalized = normalizeSensitiveSegment(name);
  return normalized === "node_modules"
    || normalized === ".git"
    || (!allowHidden && name.startsWith("."));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("Workspace search aborted", "AbortError");
}

function insertTopResult(results: FileSuggestion[], candidate: FileSuggestion, needle: string, limit: number): void {
  let low = 0;
  let high = results.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const current = results[middle];
    if (!current || compareSuggestions(candidate, current, needle) < 0) high = middle;
    else low = middle + 1;
  }
  if (low >= limit) return;
  results.splice(low, 0, candidate);
  if (results.length > limit) results.pop();
}

function compareSuggestions(a: FileSuggestion, b: FileSuggestion, needle: string): number {
  return scoreFile(a, needle) - scoreFile(b, needle)
    || a.relativePath.localeCompare(b.relativePath, undefined, { sensitivity: "base" })
    || a.relativePath.localeCompare(b.relativePath);
}

export class PathError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function scoreFile(entry: FileSuggestion, needle: string): number {
  const name = entry.name.normalize("NFKC").toLocaleLowerCase("en-US");
  const relative = entry.relativePath.normalize("NFKC").toLocaleLowerCase("en-US");
  if (name === needle) return 0;
  if (name.startsWith(needle)) return 1;
  if (relative.startsWith(needle)) return 2;
  return entry.type === "file" ? 3 : 4;
}
