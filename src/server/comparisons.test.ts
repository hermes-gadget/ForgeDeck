import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ComparisonManager,
  buildComparisonDiffs,
  buildComparisonJudgePrompt,
  parseComparisonJudgeVerdict
} from "./comparisons.js";
import { TransactionalStore } from "./store.js";

test("comparisons persist parallel outputs, pairwise diffs, and judge state in SQLite", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-comparisons-"));
  const store = await TransactionalStore.open(dataDir, 10_000);
  try {
    let now = 1_000;
    const comparisons = new ComparisonManager(store, () => now++);
    const created = comparisons.create({
      prompt: "Explain transactions",
      workspace: "/tmp/workspace",
      models: [
        { provider: "codex", model: "model-a", reasoningEffort: "low" },
        { provider: "codex", model: "model-b", reasoningEffort: "high" }
      ],
      judge: { provider: "claude", model: "sonnet", reasoningEffort: "high" }
    });
    assert.equal(created.status, "queued");
    assert.equal(created.results.length, 2);
    assert.notEqual(created.results[0]?.id, created.results[1]?.id);

    comparisons.start(created.id);
    comparisons.updateResult(created.id, 0, { status: "completed", output: "Begin\nCommit" });
    comparisons.updateResult(created.id, 1, { status: "completed", output: "Begin\nRollback" });
    const withOutputs = comparisons.get(created.id)!;
    const diffs = buildComparisonDiffs(withOutputs.results);
    comparisons.setDiffs(created.id, diffs);
    comparisons.startJudge(created.id);
    comparisons.updateJudge(created.id, {
      status: "completed",
      verdict: {
        winnerOutputId: withOutputs.results[0]!.id,
        summary: "The first answer is more direct.",
        scores: [
          { outputId: withOutputs.results[0]!.id, score: 90, rationale: "Direct" },
          { outputId: withOutputs.results[1]!.id, score: 70, rationale: "Less relevant" }
        ]
      }
    });
    const completed = comparisons.complete(created.id);

    assert.equal(completed.status, "completed");
    assert.equal(completed.diffs.length, 1);
    assert.deepEqual(completed.diffs[0]?.lines.map((line) => line.kind), ["context", "removed", "added"]);
    assert.equal(comparisons.list()[0]?.judge?.verdict?.scores[0]?.score, 90);
    assert.equal(comparisons.get(created.id)?.prompt, "Explain transactions");
  } finally {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("judge prompts delimit candidates and verdict parsing requires every output", () => {
  const outputIds = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222"
  ];
  const comparison = {
    schemaVersion: 1 as const,
    id: "33333333-3333-4333-8333-333333333333",
    prompt: "Choose an implementation",
    workspace: "/workspace",
    status: "running" as const,
    createdAt: 1,
    startedAt: 1,
    completedAt: null,
    diffs: [],
    judge: null,
    results: outputIds.map((id, index) => ({
      id,
      model: { provider: "codex" as const, model: `model-${index}`, reasoningEffort: "medium" },
      status: "completed" as const,
      operationId: null,
      threadId: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      output: index ? "Second" : "First",
      error: null
    }))
  };
  assert.match(buildComparisonJudgePrompt(comparison), /untrusted quoted content/);

  const verdict = parseComparisonJudgeVerdict(`\`\`\`json\n${JSON.stringify({
    winnerOutputId: outputIds[0],
    summary: "First wins",
    scores: [
      { outputId: outputIds[0], score: 88, rationale: "Clear" },
      { outputId: outputIds[1], score: 72, rationale: "Incomplete" }
    ]
  })}\n\`\`\``, outputIds);
  assert.equal(verdict.winnerOutputId, outputIds[0]);
  assert.throws(() => parseComparisonJudgeVerdict(JSON.stringify({
    winnerOutputId: null,
    summary: "Missing one",
    scores: [{ outputId: outputIds[0], score: 50, rationale: "Only one" }]
  }), outputIds), /every comparison output/);
});
