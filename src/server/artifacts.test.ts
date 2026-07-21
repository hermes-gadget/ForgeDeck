import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "./session-manager.js";

test("typed artifacts are versioned, durable, validated, and satisfy objective gates", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-artifacts-"));
  const workspace = path.join(directory, "workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "result.json"), JSON.stringify({ ok: true }), "utf8");
  let now = Date.UTC(2026, 6, 16);
  let manager = await SessionManager.create(directory, () => now++);
  try {
    const blueprint = manager.blueprints.create({
      name: "Artifact agent",
      definition: {
        promptTemplate: "Produce validated outputs",
        role: "builder",
        workspace: { selector: "fixed", value: workspace },
        model: { backend: "codex", routing: "fixed", model: "gpt-5.3-codex", effort: "high" },
        tools: { enable: [], disable: [] },
        knowledge: [],
        completionGates: [
          { name: "tests", description: "Tests pass", required: true, artifactType: "TestResultArtifact", mustPass: true },
          { name: "result", description: "Named result exists", required: true, artifactType: "FileArtifact", path: "result.json" }
        ],
        approvals: { mode: "on-request", requiredFor: [] },
        variables: []
      }
    });
    await manager.setMetadata("thread-artifacts", {
      cwd: workspace,
      blueprintId: blueprint.id,
      blueprintVersion: blueprint.version
    });

    const failed = await manager.createArtifact("thread-artifacts", {
      type: "TestResultArtifact",
      name: "test-suite",
      content: { command: "npm test", status: "failed", exitCode: 1, failed: 1, output: "# fail 1" }
    }, { actor: "user", source: "http", cwd: workspace });
    assert.equal(failed.version, 1);
    assert.equal(manager.artifactStatus("thread-artifacts").status, "pending");

    const passed = await manager.createArtifact("thread-artifacts", {
      type: "TestResultArtifact",
      name: "test-suite",
      content: { command: "npm test", status: "passed", exitCode: 0, passed: 8, output: "# pass 8" }
    }, { actor: "runtime", source: "runtime", cwd: workspace });
    assert.equal(passed.version, 2);

    const file = await manager.createArtifact("thread-artifacts", {
      type: "FileArtifact",
      name: "result.json",
      content: { path: "result.json" }
    }, { actor: "runtime", source: "runtime", cwd: workspace });
    assert.equal(file.content?.path, "result.json");
    assert.equal(file.reference?.kind, "workspace-file");
    assert.equal(manager.artifactStatus("thread-artifacts").status, "passed");

    manager.close();
    manager = await SessionManager.create(directory, () => now++);
    assert.equal(manager.listArtifacts("thread-artifacts").length, 3);
    assert.equal(manager.artifactById(passed.id)?.contentHash, passed.contentHash);
    assert.equal(manager.artifactStatus("thread-artifacts").status, "passed");
  } finally {
    manager.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("runtime items emit command, test, patch, and named-file artifacts", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-runtime-artifacts-"));
  const workspace = path.join(directory, "workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "app.ts"), "export const answer = 42;\n", "utf8");
  const manager = await SessionManager.create(directory);
  try {
    await manager.setMetadata("thread-runtime", { cwd: workspace });
    const commands = await manager.captureArtifactItem("thread-runtime", {
      id: "command-1",
      type: "commandExecution",
      command: "npm test",
      status: "completed",
      exitCode: 0,
      aggregatedOutput: "# pass 4\n# fail 0"
    });
    assert.deepEqual(commands.map((artifact) => artifact.type), ["CommandArtifact", "TestResultArtifact"]);

    const changes = await manager.captureArtifactItem("thread-runtime", {
      id: "change-1",
      type: "fileChange",
      changes: [{ path: "app.ts", diff: "@@ -1 +1 @@\n-export const answer = 41;\n+export const answer = 42;" }]
    });
    assert.deepEqual(changes.map((artifact) => artifact.type), ["PatchArtifact", "FileArtifact"]);
    assert.equal(changes[0]?.validation.status, "valid");

    const duplicate = await manager.captureArtifactItem("thread-runtime", {
      id: "change-1",
      type: "fileChange",
      changes: [{ path: "app.ts", diff: "@@ -1 +1 @@\n-export const answer = 41;\n+export const answer = 42;" }]
    });
    assert.equal(duplicate[0]?.id, changes[0]?.id);
    assert.equal(manager.listArtifacts("thread-runtime").length, 4);
  } finally {
    manager.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("large or sensitive artifact content is stored by content-addressed reference", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-referenced-artifacts-"));
  const manager = await SessionManager.create(directory);
  try {
    const artifact = await manager.createArtifact("thread-reference", {
      type: "CommandArtifact",
      name: "large-output",
      retention: { policy: "reference-only", sensitive: true },
      content: {
        command: "generate-report",
        cwd: directory,
        status: "passed",
        exitCode: 0,
        output: "x".repeat(300_000)
      }
    }, { actor: "user", source: "http", cwd: directory });
    assert.equal(artifact.content?.status, "passed");
    assert.equal(artifact.content?.output, undefined);
    assert.equal(artifact.reference?.kind, "content-addressed");
    assert.equal(artifact.reference?.sensitive, true);
    assert.match(artifact.reference?.uri || "", /^artifact:\/\/sha256\/[a-f0-9]{64}$/);
  } finally {
    manager.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
