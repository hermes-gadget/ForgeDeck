import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BlueprintManager } from "./blueprints.js";
import { EvalManager, evalOutput, scoreEval } from "./evals.js";
import { TransactionalStore } from "./store.js";

test("eval definitions and results are versioned in SQLite", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-evals-"));
  const store = await TransactionalStore.open(dataDir, 10_000);
  try {
    const blueprints = new BlueprintManager(store, () => 100);
    const blueprint = blueprints.create({
      id: "eval-blueprint",
      name: "Eval blueprint",
      definition: {
        promptTemplate: "Explain ${topic}",
        role: "reviewer",
        workspace: { selector: "current" },
        model: { backend: "codex", routing: "fixed", model: "model-a", effort: "medium" },
        tools: { enable: [], disable: [] },
        knowledge: [],
        completionGates: [],
        approvals: { mode: "on-request", requiredFor: [] },
        variables: [{ name: "topic", type: "string", required: true }]
      }
    });
    let now = 1_000;
    const evals = new EvalManager(store, blueprints, () => now++);
    const request = {
      name: "Explanation quality",
      blueprintId: blueprint.id,
      blueprintVersion: blueprint.version,
      variables: { topic: "SQLite" },
      workspace: "/tmp/workspace",
      models: [{ provider: "codex", model: "model-a", reasoningEffort: "medium" }],
      successCriteria: {
        requiredPhrases: ["transaction"],
        forbiddenPhrases: [],
        maxDurationMs: 10_000,
        maxTotalTokens: 2_000,
        requireBlueprintGates: true
      }
    } as const;

    const first = evals.create(request);
    assert.equal(first.version, 1);
    assert.equal(first.prompt, "Explain SQLite");
    evals.start(first.id, first.version);
    evals.updateResult(first.id, first.version, 0, {
      status: "passed",
      output: "A transaction keeps the update atomic.",
      score: { scorerVersion: 1, passed: true, criteria: [] }
    });
    assert.equal(evals.complete(first.id, first.version).passed, true);

    const second = evals.create({ ...request, evalId: first.id });
    assert.equal(second.version, 2);
    assert.deepEqual(evals.list().map((run) => run.version), [2, 1]);
    assert.equal(evals.get(first.id)?.version, 2);
    assert.equal(evals.get(first.id, 1)?.status, "completed");
  } finally {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("scorer combines completion, output, timing, tokens, and blueprint gates", () => {
  const score = scoreEval({
    requiredPhrases: ["tests pass"],
    forbiddenPhrases: ["cannot"],
    maxDurationMs: 5_000,
    maxTotalTokens: 1_000,
    requireBlueprintGates: true
  }, {
    turnStatus: "completed",
    output: "The tests pass.",
    durationMs: 4_000,
    totalTokens: 900,
    blueprintGates: { status: "passed", metGateCount: 1, requiredGateCount: 1 }
  });
  assert.equal(score.passed, true);
  assert.equal(score.scorerVersion, 1);
  assert.equal(score.criteria.length, 6);

  const failed = scoreEval({
    requiredPhrases: ["tests pass"],
    forbiddenPhrases: [],
    maxDurationMs: null,
    maxTotalTokens: 100,
    requireBlueprintGates: false
  }, {
    turnStatus: "failed",
    output: "No result",
    durationMs: 10,
    totalTokens: 200,
    blueprintGates: { status: "passed", metGateCount: 0, requiredGateCount: 0 }
  });
  assert.equal(failed.passed, false);
  assert.deepEqual(failed.criteria.map((criterion) => criterion.passed), [false, false, false]);
});

test("agent output is read from the latest turn", () => {
  assert.deepEqual(evalOutput({
    turns: [{
      status: "completed",
      items: [
        { type: "userMessage", text: "prompt" },
        { type: "agentMessage", text: "final answer" }
      ]
    }]
  }), { output: "final answer", turnStatus: "completed" });
});
