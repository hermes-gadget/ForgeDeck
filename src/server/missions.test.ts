import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BlueprintManager } from "./blueprints.js";
import {
  MissionConflictError,
  MissionManager,
  MissionRunner,
  MissionValidationError,
  type MissionNodeInspection
} from "./missions.js";
import { TransactionalStore } from "./store.js";

test("missions persist immutable DAG versions and reject invalid graphs", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-missions-"));
  let now = 1_000;
  let store = await TransactionalStore.open(directory, 10_000);
  try {
    const blueprints = new BlueprintManager(store, () => now);
    const firstBlueprint = blueprints.create({ id: "mission-first", name: "First", definition: definition("TARGET") });
    const secondBlueprint = blueprints.create({ id: "mission-second", name: "Second", definition: definition("SUMMARY") });
    let missions = new MissionManager(store, blueprints, () => now);
    const first = missions.create({
      id: "release-mission",
      name: "Release mission",
      nodes: [
        {
          id: "analyze",
          name: "Analyze",
          blueprintId: firstBlueprint.id,
          inputMapping: { TARGET: { source: "mission", key: "target" } },
          outputMapping: { summary: "text" },
          dependsOn: []
        },
        {
          id: "review",
          name: "Review",
          blueprintId: secondBlueprint.id,
          inputMapping: { SUMMARY: { source: "node", nodeId: "analyze", key: "summary" } },
          outputMapping: { verdict: "text" },
          dependsOn: ["analyze"]
        }
      ]
    });
    assert.equal(first.version, 1);
    assert.equal(first.nodes[0]?.blueprintVersion, 1);

    now += 1;
    const second = missions.create({
      id: first.id,
      name: "Release mission",
      description: "Second immutable version",
      nodes: first.nodes.map(({ blueprintVersion: _version, ...node }) => node)
    });
    assert.equal(second.version, 2);
    assert.equal(missions.get(first.id)?.description, "Second immutable version");

    assert.throws(() => missions.create({
      name: "Cyclic",
      nodes: [
        { id: "a", blueprintId: firstBlueprint.id, dependsOn: ["b"], inputMapping: { TARGET: { source: "literal", value: "a" } }, outputMapping: {} },
        { id: "b", blueprintId: firstBlueprint.id, dependsOn: ["a"], inputMapping: { TARGET: { source: "literal", value: "b" } }, outputMapping: {} }
      ]
    }), MissionValidationError);

    store.close();
    store = await TransactionalStore.open(directory, 10_000);
    missions = new MissionManager(store, new BlueprintManager(store, () => now), () => now);
    assert.equal(missions.list()[0]?.version, 2);
  } finally {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("mission runner executes one dependency-ready node at a time and maps outputs", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-mission-runner-"));
  let now = 2_000;
  const store = await TransactionalStore.open(directory, 10_000);
  try {
    const blueprints = new BlueprintManager(store, () => now);
    blueprints.create({ id: "mission-analyze", name: "Analyze", definition: definition("TARGET") });
    blueprints.create({ id: "mission-review", name: "Review", definition: definition("SUMMARY") });
    const missions = new MissionManager(store, blueprints, () => ++now);
    const mission = missions.create({
      id: "sequential-mission",
      name: "Sequential mission",
      nodes: [
        {
          id: "analyze",
          blueprintId: "mission-analyze",
          dependsOn: [],
          inputMapping: { TARGET: { source: "mission", key: "target" } },
          outputMapping: { summary: "text" }
        },
        {
          id: "review",
          blueprintId: "mission-review",
          dependsOn: ["analyze"],
          inputMapping: { SUMMARY: { source: "node", nodeId: "analyze", key: "summary" } },
          outputMapping: { verdict: "text" }
        }
      ]
    });
    missions.start(mission.id, { inputs: { target: "checkout" }, workspace: "/workspace" });
    assert.throws(() => missions.start(mission.id, { inputs: { target: "again" } }), MissionConflictError);

    const inspections = new Map<string, MissionNodeInspection>();
    const executions: Array<{ nodeId: string; inputs: Record<string, string | number | boolean> }> = [];
    const runner = new MissionRunner(
      missions,
      async ({ node, inputs }) => {
        executions.push({ nodeId: node.id, inputs });
        const operationId = `operation-${node.id}`;
        inspections.set(operationId, { state: "running" });
        return { operationId };
      },
      async (_run, node) => inspections.get(node.operationId!)!,
      1_000
    );

    await runner.tick();
    assert.deepEqual(executions, [{ nodeId: "analyze", inputs: { TARGET: "checkout" } }]);
    await runner.tick();
    assert.equal(executions.length, 1, "a dependent node must not start while its dependency is running");

    inspections.set("operation-analyze", {
      state: "completed",
      threadId: "thread-analyze",
      output: { text: "checkout is ready", threadId: "thread-analyze", artifacts: [] }
    });
    await runner.tick();
    assert.equal(executions.length, 1);
    await runner.tick();
    assert.deepEqual(executions[1], { nodeId: "review", inputs: { SUMMARY: "checkout is ready" } });

    inspections.set("operation-review", {
      state: "completed",
      threadId: "thread-review",
      output: { text: "approved", threadId: "thread-review", artifacts: [] }
    });
    await runner.tick();
    await runner.tick();

    const completed = missions.get(mission.id)!;
    assert.equal(completed.state, "completed");
    assert.deepEqual(completed.latestRun?.outputs, {
      analyze: { summary: "checkout is ready" },
      review: { verdict: "approved" }
    });
    assert.equal(missions.delete(mission.id), true);
    assert.equal(missions.get(mission.id), null);
  } finally {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function definition(variable: string) {
  return {
    promptTemplate: `Process \${${variable}}.`,
    role: "Mission worker",
    workspace: { selector: "current" as const },
    model: { backend: "codex" as const, routing: "fixed" as const, model: "gpt-5.6-sol", effort: "medium" },
    tools: { enable: ["shell"], disable: [] },
    knowledge: [],
    completionGates: [],
    approvals: { mode: "on-request" as const, requiredFor: [] },
    variables: [{ name: variable, type: "string" as const, required: true }]
  };
}
