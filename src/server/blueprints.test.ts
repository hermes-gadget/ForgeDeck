import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BlueprintConflictError, BlueprintManager, BlueprintValidationError } from "./blueprints.js";
import { TransactionalStore } from "./store.js";

test("blueprints persist immutable versions, search locally, and resolve only non-secret inputs", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-blueprints-"));
  const store = await TransactionalStore.open(directory, 10_000);
  const manager = new BlueprintManager(store, () => 1_000);
  try {
    const first = manager.create({
      id: "release-agent",
      name: "Release agent",
      description: "Prepares a service release",
      definition: definition({
        promptTemplate: "Release ${SERVICE} using the credential reference ${API_KEY}.",
        guardian: { stallTimeoutMinutes: 7, escalationModel: "gpt-5.6-sol" },
        variables: [
          { name: "SERVICE", type: "string", required: true },
          { name: "API_KEY", type: "string", required: true, secret: true }
        ]
      })
    });
    assert.equal(first.version, 1);
    assert.deepEqual(first.definition.guardian, { stallTimeoutMinutes: 7, escalationModel: "gpt-5.6-sol" });
    assert.deepEqual(manager.search("service").map(({ id }) => id), ["release-agent"]);

    const resolved = manager.resolve(first.id, first.version, { SERVICE: "checkout" });
    assert.equal(resolved.prompt, "Release checkout using the credential reference ${API_KEY}.");
    assert.deepEqual(resolved.variables, { SERVICE: "checkout" });
    assert.throws(() => manager.resolve(first.id, first.version, { SERVICE: "checkout", API_KEY: "credential" }), BlueprintValidationError);

    const second = manager.createVersion(first.id, {
      name: "Release agent",
      description: "Prepares and verifies a service release",
      definition: definition({ promptTemplate: "Verify ${SERVICE} then release it.", variables: [{ name: "SERVICE", type: "string", required: true }] })
    });
    assert.equal(second.version, 2);
    assert.equal(manager.get(first.id, 1)?.description, "Prepares a service release");
    assert.equal(manager.get(first.id)?.version, 2);
    assert.deepEqual(manager.versions(first.id).map(({ version }) => version), [1, 2]);
    assert.equal(manager.getByName("release AGENT")?.version, 2);

    manager.create({ id: "other-release-agent", name: "Release agent", definition: definition({}) });
    assert.throws(() => manager.getByName("Release agent"), BlueprintConflictError);

    const preset = manager.create({
      id: "quick-agent",
      name: "Quick agent",
      definition: {
        ...definition({}),
        model: { backend: "codex", routing: "fixed", preset: "quick", model: "gpt-5.6-luna", effort: "low" }
      }
    });
    assert.equal(preset.definition.model.preset, "quick");
    assert.throws(() => manager.create({
      id: "misleading-preset",
      name: "Misleading preset",
      definition: {
        ...definition({}),
        model: { backend: "codex", routing: "fixed", preset: "quick", model: "gpt-5.6-sol", effort: "medium" }
      }
    }), /Quick preset must use gpt-5\.6-luna with low effort/);
  } finally {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("portable import preserves identity and validation rejects embedded secret values", async () => {
  const sourceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-blueprint-source-"));
  const targetDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-blueprint-target-"));
  const sourceStore = await TransactionalStore.open(sourceDirectory, 10_000);
  const targetStore = await TransactionalStore.open(targetDirectory, 10_000);
  const source = new BlueprintManager(sourceStore, () => 2_000);
  const target = new BlueprintManager(targetStore, () => 3_000);
  try {
    const exported = source.create({ id: "portable", name: "Portable", definition: definition({}) });
    assert.deepEqual(target.import(JSON.parse(JSON.stringify(exported))), exported);
    assert.throws(() => target.import(exported), BlueprintConflictError);
    assert.throws(() => source.create({
      name: "Unsafe default",
      definition: definition({
        promptTemplate: "Use ${API_KEY}",
        variables: [{ name: "API_KEY", type: "string", required: true, secret: true, default: "embedded" }]
      })
    }), /cannot contain a default/);
    assert.throws(() => source.create({
      name: "Unsafe URL",
      definition: definition({ knowledge: [{ type: "url", reference: "https://example.test/docs?api_key=embedded" }] })
    }), /query parameter/);
  } finally {
    sourceStore.close();
    targetStore.close();
    await Promise.all([
      fs.rm(sourceDirectory, { recursive: true, force: true }),
      fs.rm(targetDirectory, { recursive: true, force: true })
    ]);
  }
});

function definition(overrides: Partial<Parameters<typeof identityDefinition>[0]> = {}) {
  return identityDefinition(overrides);
}

function identityDefinition(overrides: Partial<{
  promptTemplate: string;
  variables: Array<{ name: string; type: "string" | "number" | "boolean"; required: boolean; secret?: boolean; default?: string | number | boolean }>;
  knowledge: Array<{ type: "file" | "url"; reference: string }>;
  guardian: { stallTimeoutMinutes: number; escalationModel?: string | null };
}>) {
  return {
    promptTemplate: overrides.promptTemplate ?? "Review this workspace.",
    role: "Release engineer",
    workspace: { selector: "current" as const },
    model: { backend: "codex" as const, routing: "fixed" as const, model: "gpt-5.3-codex", effort: "high" },
    tools: { enable: ["shell"], disable: [] },
    knowledge: overrides.knowledge ?? [],
    completionGates: [{ name: "tests", description: "Tests pass", required: true }],
    approvals: { mode: "on-request" as const, requiredFor: ["network"] },
    variables: overrides.variables ?? [],
    ...(overrides.guardian ? { guardian: overrides.guardian } : {})
  };
}
