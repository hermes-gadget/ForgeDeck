import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PolicyManager, evaluatePolicyRules, type PolicyEvaluationContext, type PolicyRecord } from "./policy-engine.js";
import { TransactionalStore } from "./store.js";

const context: PolicyEvaluationContext = {
  sessionClass: "standard",
  model: "gpt-test",
  reasoningEffort: "high",
  workspace: "/workspace/project",
  timeOfDay: "18:30",
  concurrency: 4,
  tokensUsed: 12_000
};

test("no policies allow every pre-flight request", () => {
  assert.deepEqual(evaluatePolicyRules([], context), {
    action: "allow",
    blocked: false,
    reason: null,
    warnings: [],
    matched: []
  });
});

test("matching warnings are retained and blocks take precedence", () => {
  const warning = rule("warn-high", "Warn on high effort", "reasoning_effort", "equals", "high", "warn");
  const block = rule("block-concurrency", "Concurrency ceiling", "max_concurrency", "greater_than_or_equal", 4, "block");
  const decision = evaluatePolicyRules([warning, block], context);
  assert.equal(decision.action, "block");
  assert.equal(decision.blocked, true);
  assert.match(decision.reason || "", /Concurrency ceiling/);
  assert.match(decision.warnings[0] || "", /Warn on high effort/);
  assert.deepEqual(decision.matched.map(({ id }) => id), [warning.id, block.id]);
});

test("time and token comparisons use the current pre-flight context", () => {
  const afterHours = rule("after-hours", "After hours", "time_of_day", "greater_than_or_equal", "18:00", "warn");
  const tokenCap = rule("token-cap", "Token cap", "max_tokens_per_session", "greater_than", 12_000, "block");
  const decision = evaluatePolicyRules([afterHours, tokenCap], context);
  assert.equal(decision.action, "warn");
  assert.equal(decision.blocked, false);
  assert.equal(decision.warnings.length, 1);
});

test("policy CRUD is durable in SQLite", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-policies-"));
  let store = await TransactionalStore.open(dataDir, 10_000);
  try {
    let manager = new PolicyManager(store, () => 100);
    const created = manager.save({
      name: "Workspace warning",
      condition: { field: "workspace", operator: "contains", value: "/workspace" },
      action: "warn"
    });
    store.close();
    store = await TransactionalStore.open(dataDir, 10_000);
    manager = new PolicyManager(store, () => 200);
    assert.equal(manager.list()[0]?.name, "Workspace warning");
    const updated = manager.save({ ...created, name: "Updated warning", action: "block" });
    assert.equal(updated.createdAt, 100);
    assert.equal(updated.updatedAt, 200);
    assert.equal(manager.remove(created.id), true);
    assert.deepEqual(manager.list(), []);
  } finally {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

function rule(
  idSuffix: string,
  name: string,
  field: PolicyRecord["condition"]["field"],
  operator: PolicyRecord["condition"]["operator"],
  value: string | number,
  action: PolicyRecord["action"]
): PolicyRecord {
  return {
    id: `${idSuffix.padEnd(8, "0")}-0000-4000-8000-000000000000`.slice(0, 36),
    name,
    condition: { field, operator, value },
    action,
    createdAt: 1,
    updatedAt: 1
  };
}
