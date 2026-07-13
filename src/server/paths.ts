import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";

const BLOCKED_SEGMENTS = new Set([
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker",
  ".password-store", ".local/share/keyrings"
]);

export type DirectoryEntry = { name: string; path: string };
export type FileSuggestion = { name: string; path: string; relativePath: string; type: "file" | "directory" };

export class WorkspacePaths {
  readonly roots: string[];

  private constructor(roots: string[]) {
    this.roots = roots;
  }

  static async create(): Promise<WorkspacePaths> {
    const configured = process.env.FORGEDECK_ROOTS
      ?.split(path.delimiter)
      .map((part) => part.trim())
      .filter(Boolean);
    const candidates = configured?.length ? configured : [os.homedir()];
    const roots = await Promise.all(candidates.map(async (candidate) => {
      const resolved = await fs.realpath(path.resolve(candidate));
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) throw new Error(`Workspace root is not a directory: ${candidate}`);
      return resolved;
    }));
    return new WorkspacePaths([...new Set(roots)]);
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
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !BLOCKED_SEGMENTS.has(entry.name))
      .map((entry) => ({ name: entry.name, path: path.join(resolved, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

    const containingRoot = this.roots.find((root) => isWithin(root, resolved));
    const parent = containingRoot && resolved !== containingRoot ? path.dirname(resolved) : null;
    return { path: resolved, parent, entries: visible };
  }

  async searchFiles(cwd: string, query: string, limit = 30): Promise<FileSuggestion[]> {
    const root = await this.validate(cwd);
    const needle = query.trim().replace(/^\.\//, "").toLowerCase();
    const results: FileSuggestion[] = [];
    const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
    let scanned = 0;
    while (queue.length && results.length < limit && scanned < 4_000) {
      const current = queue.shift()!;
      let entries: Dirent<string>[];
      try { entries = await fs.readdir(current.directory, { withFileTypes: true, encoding: "utf8" }); } catch { continue; }
      for (const entry of entries) {
        scanned += 1;
        if (entry.name === "node_modules" || entry.name === ".git" || BLOCKED_SEGMENTS.has(entry.name) || (entry.name.startsWith(".") && !needle.startsWith("."))) continue;
        const absolute = path.join(current.directory, entry.name);
        const relativePath = path.relative(root, absolute);
        if (entry.isDirectory() && current.depth < 6) queue.push({ directory: absolute, depth: current.depth + 1 });
        if (!entry.isFile() && !entry.isDirectory()) continue;
        if (!needle || relativePath.toLowerCase().includes(needle) || entry.name.toLowerCase().includes(needle)) {
          results.push({ name: entry.name, path: absolute, relativePath, type: entry.isDirectory() ? "directory" : "file" });
          if (results.length >= limit) break;
        }
      }
    }
    return results.sort((a, b) => scoreFile(a, needle) - scoreFile(b, needle) || a.relativePath.localeCompare(b.relativePath));
  }

  private isSensitive(candidate: string): boolean {
    for (const root of this.roots) {
      if (!isWithin(root, candidate)) continue;
      const relative = path.relative(root, candidate);
      const segments = relative.split(path.sep);
      return segments.some((segment, index) =>
        BLOCKED_SEGMENTS.has(segment) || BLOCKED_SEGMENTS.has(segments.slice(index, index + 3).join("/"))
      );
    }
    return true;
  }
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
  const name = entry.name.toLowerCase();
  const relative = entry.relativePath.toLowerCase();
  if (name === needle) return 0;
  if (name.startsWith(needle)) return 1;
  if (relative.startsWith(needle)) return 2;
  return entry.type === "file" ? 3 : 4;
}
