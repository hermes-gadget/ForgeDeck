import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express, { type ErrorRequestHandler } from "express";
import { PathError, WorkspacePaths } from "./paths.js";
import { createWorkspaceRouter } from "./workspace-routes.js";

test("application workspace routes browse roots, search files, and validate input", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-routes-"));
  const project = path.join(root, "project");
  await fs.mkdir(path.join(project, "src"), { recursive: true });
  await fs.writeFile(path.join(project, "src", "main.ts"), "export {};\n");
  const workspaces = await WorkspacePaths.create([root]);
  const leaseReader = {
    workspaceLeaseStatus(workspace: string) {
      const leased = path.resolve(workspace) === path.resolve(project);
      return {
        root: path.resolve(workspace),
        state: leased ? "exclusive" as const : "available" as const,
        leases: leased ? [{ sessionId: "session-lease-123", root: path.resolve(workspace), mode: "exclusive" as const, acquiredAt: 1_000 }] : []
      };
    }
  };
  const app = express();
  app.use(createWorkspaceRouter(workspaces, leaseReader));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = error instanceof PathError ? error.status : Number(error?.status) || 500;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
  };
  app.use(errors);
  const server = http.createServer(app);

  try {
    const baseUrl = await listen(server);
    const roots = await jsonRequest<{ path: null; entries: Array<{ path: string }> }>(`${baseUrl}/api/directories`);
    assert.equal(roots.status, 200);
    assert.deepEqual(roots.body.entries.map((entry) => entry.path), [root]);

    const listing = await jsonRequest<{ entries: Array<{ name: string; leaseStatus: { state: string } }> }>(`${baseUrl}/api/directories?path=${encodeURIComponent(root)}`);
    assert.equal(listing.status, 200);
    assert.deepEqual(listing.body.entries.map((entry) => entry.name), ["project"]);
    assert.equal(listing.body.entries[0].leaseStatus.state, "exclusive");

    const leases = await jsonRequest<{ root: string; state: string; leases: Array<{ sessionId: string }> }>(
      `${baseUrl}/api/workspaces/${encodeURIComponent(project)}/leases`
    );
    assert.equal(leases.status, 200);
    assert.equal(leases.body.root, project);
    assert.equal(leases.body.state, "exclusive");
    assert.deepEqual(leases.body.leases.map((lease) => lease.sessionId), ["session-lease-123"]);

    const search = await jsonRequest<{ data: Array<{ relativePath: string }> }>(`${baseUrl}/api/files?cwd=${encodeURIComponent(project)}&q=main`);
    assert.equal(search.status, 200);
    assert.deepEqual(search.body.data.map((entry) => entry.relativePath), [path.join("src", "main.ts")]);

    const invalid = await jsonRequest<{ error: string }>(`${baseUrl}/api/files?q=main`);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, "Directory is required");
  } finally {
    await close(server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not expose an IP port");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function jsonRequest<T>(url: string): Promise<{ status: number; body: T }> {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() as T };
}
