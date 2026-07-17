import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PathError, WorkspacePaths } from "./paths.js";

test("WorkspacePaths lists directories and rejects credential paths and escapes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-paths-"));
  const project = path.join(root, "project");
  const secret = path.join(root, ".ssh");
  await fs.mkdir(project);
  await fs.mkdir(secret);
  try {
    const workspaces = await WorkspacePaths.create([root]);
    assert.equal(await workspaces.validate(project), project);
    const listing = await workspaces.list(root);
    assert.deepEqual(listing.entries.map((entry) => entry.name), ["project"]);
    await assert.rejects(() => workspaces.validate(secret), (error: unknown) => error instanceof PathError && error.status === 403);
    await assert.rejects(() => workspaces.validate(os.homedir()), (error: unknown) => error instanceof PathError && error.status === 403);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("WorkspacePaths file search does not follow directory symlinks outside a root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-search-root-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-search-outside-"));
  const project = path.join(root, "project");
  await fs.mkdir(project);
  await fs.writeFile(path.join(outside, "private-name.txt"), "not exposed");
  await fs.symlink(outside, path.join(project, "escape"), "dir");
  try {
    const workspaces = await WorkspacePaths.create([root]);
    assert.deepEqual(await workspaces.searchFiles(project, "private-name"), []);
  } finally {
    await Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(outside, { recursive: true, force: true })]);
  }
});
