import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const BLOCKED_SEGMENTS = new Set([
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker",
  ".password-store", ".local/share/keyrings"
]);

export type DirectoryEntry = { name: string; path: string };

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
