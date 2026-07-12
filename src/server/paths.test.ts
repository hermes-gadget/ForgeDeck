import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PathError, WorkspacePaths } from "./paths.js";

test("WorkspacePaths lists directories and rejects credential paths and escapes", async () => {
  const previous = process.env.FORGEDECK_ROOTS;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-paths-"));
  const project = path.join(root, "project");
  const secret = path.join(root, ".ssh");
  await fs.mkdir(project);
  await fs.mkdir(secret);
  process.env.FORGEDECK_ROOTS = root;
  try {
    const workspaces = await WorkspacePaths.create();
    assert.equal(await workspaces.validate(project), project);
    const listing = await workspaces.list(root);
    assert.deepEqual(listing.entries.map((entry) => entry.name), ["project"]);
    await assert.rejects(() => workspaces.validate(secret), (error: unknown) => error instanceof PathError && error.status === 403);
    await assert.rejects(() => workspaces.validate(os.homedir()), (error: unknown) => error instanceof PathError && error.status === 403);
  } finally {
    if (previous === undefined) delete process.env.FORGEDECK_ROOTS;
    else process.env.FORGEDECK_ROOTS = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
