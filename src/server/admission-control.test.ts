import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AdmissionController,
  normalizeRateLimitSnapshots,
  parseCostCatalog,
  retryAfterSecondsFromError
} from "./admission-control.js";
import { TransactionalStore } from "./store.js";

test("normalized request and cumulative token events persist with separate versioned cost estimates", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-usage-ledger-"));
  let store = await TransactionalStore.open(dataDir, 10_000);
  const attribution = {
    provider: "codex" as const,
    model: "model-a",
    runId: "run-usage-1",
    workspaceId: "/workspace/a",
    blueprintId: "blueprint-a"
  };
  try {
    const controller = new AdmissionController(store, {
      costCatalog: {
        version: "catalog-v1",
        currency: "USD",
        models: { "model-a": { totalTokens: 2_000_000 } }
      }
    });
    controller.recordRequest(attribution, "request-1");
    controller.recordTokenSnapshot(attribution, tokens(100), "snapshot-1");
    assert.equal(controller.recordTokenSnapshot(attribution, tokens(100)), null);
    controller.recordTokenSnapshot(attribution, tokens(150), "snapshot-2");

    assert.deepEqual({ ...controller.usage("run", attribution.runId) }, {
      requestCount: 1,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 150,
      estimatedCostMicros: 300
    });
    assert.equal(controller.usage("workspace", attribution.workspaceId).totalTokens, 150);
    assert.equal(controller.usage("blueprint", attribution.blueprintId).requestCount, 1);
    assert.equal(controller.events(10, attribution.runId).length, 3);
    assert.deepEqual(controller.estimates(10, attribution.runId).map(({ catalogVersion, currency, estimatedMicros }) => ({
      catalogVersion, currency, estimatedMicros
    })), [
      { catalogVersion: "catalog-v1", currency: "USD", estimatedMicros: 100 },
      { catalogVersion: "catalog-v1", currency: "USD", estimatedMicros: 200 }
    ]);

    store.close();
    store = await TransactionalStore.open(dataDir, 10_000);
    const reopened = new AdmissionController(store);
    assert.equal(reopened.usage("run", attribution.runId).totalTokens, 150);
    assert.equal(reopened.events(10, attribution.runId).length, 3);
  } finally {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("quota headroom, reset proximity, and retry-after signals reject before capacity acquisition", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-quota-admission-"));
  const store = await TransactionalStore.open(dataDir, 10_000);
  let now = 1_000_000;
  try {
    const controller = new AdmissionController(store, {
      now: () => now,
      headroomPercent: 10,
      resetProximityMs: 60_000,
      quotaStaleMs: 120_000,
      defaultExhaustionPolicy: "wait"
    });
    controller.observeQuota({
      provider: "codex",
      limitId: "weekly:primary",
      observedAt: now,
      usedPercent: 95,
      remainingPercent: 5,
      resetAt: now + 30_000,
      raw: { usedPercent: 95 }
    });
    const quota = controller.evaluate(context());
    assert.equal(quota.admitted, false);
    assert.equal(quota.action, "wait");
    assert.equal(quota.retryAt, now + 30_000);
    assert.deepEqual(quota.alerts.map((alert) => alert.code), ["QUOTA_HEADROOM", "QUOTA_RESET_NEAR"]);

    controller.observeRetryAfter("codex", 45, { status: 429 });
    const retry = controller.evaluate(context());
    assert.equal(retry.retryAt, now + 45_000);
    assert.equal(retry.alerts.some((alert) => alert.code === "PROVIDER_RETRY_AFTER"), true);

    now += 130_000;
    assert.equal(controller.evaluate(context()).admitted, true);
  } finally {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("run, blueprint, and workspace budgets emit soft alerts and enforce hard policies", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-budget-admission-"));
  const store = await TransactionalStore.open(dataDir, 10_000);
  let now = 2_000_000;
  try {
    const controller = new AdmissionController(store, {
      now: () => now,
      costCatalog: { version: "budget-v1", currency: "USD", models: { "model-a": { totalTokens: 1 } } }
    });
    controller.setBudget({
      scopeType: "run",
      scopeId: "run-admit-1",
      softLimit: { requestCount: 1 },
      hardLimit: { requestCount: 2 },
      exhaustionPolicy: "pause"
    });
    controller.setBudget({
      scopeType: "workspace",
      scopeId: "/workspace/a",
      softLimit: null,
      hardLimit: { totalTokens: 500 },
      exhaustionPolicy: "wait"
    });
    controller.setBudget({
      scopeType: "blueprint",
      scopeId: "blueprint-a",
      softLimit: { estimatedCostMicros: 100 },
      hardLimit: null,
      exhaustionPolicy: "pause"
    });

    const first = controller.evaluate({ ...context(), projection: { estimatedCostMicros: 100 } });
    assert.equal(first.admitted, true);
    assert.equal(first.alerts.filter((alert) => alert.code === "BUDGET_SOFT").length, 2);
    controller.recordRequest(context(), "request-budget-1");
    now += 1;
    assert.equal(controller.evaluate(context()).admitted, true);
    controller.recordRequest(context(), "request-budget-2");
    const third = controller.evaluate(context());
    assert.equal(third.admitted, false);
    assert.equal(third.action, "pause");
    assert.equal(third.alerts.some((alert) => alert.scopeType === "run" && alert.code === "BUDGET_HARD"), true);

    controller.recordTokens(context(), tokens(500), "tokens-budget-1");
    const workspace = controller.evaluate({ ...context(), runId: "another-run" });
    assert.equal(workspace.admitted, false);
    assert.equal(workspace.action, "wait");
    assert.equal(workspace.retryAt, null);
  } finally {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("model and provider switches require a matching explicit approval", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-switch-admission-"));
  const store = await TransactionalStore.open(dataDir, 10_000);
  try {
    const controller = new AdmissionController(store, { now: () => 3_000_000 });
    controller.observeQuota({
      provider: "codex",
      limitId: "weekly:primary",
      observedAt: 3_000_000,
      usedPercent: 100,
      remainingPercent: 0,
      resetAt: 4_000_000,
      raw: {}
    });
    const downgrade = controller.evaluate({
      ...context(),
      policy: { action: "downgrade", approved: true, target: { provider: "codex", model: "model-b" } }
    });
    assert.equal(downgrade.admitted, true);
    assert.equal(downgrade.action, "downgrade");
    assert.deepEqual(downgrade.target, { provider: "codex", model: "model-b" });

    const fallback = controller.evaluate({
      ...context(),
      policy: { action: "fallback", approved: true, target: { provider: "spark", model: "gpt-5.3-codex-spark" } }
    });
    assert.equal(fallback.admitted, true);
    assert.equal(fallback.action, "fallback");

    const undeclared = controller.evaluate({
      ...context(),
      policy: { action: "fallback", approved: false }
    });
    assert.equal(undeclared.admitted, false);
    assert.equal(undeclared.action, "pause");
    assert.equal(undeclared.alerts.at(-1)?.code, "SWITCH_APPROVAL_REQUIRED");
  } finally {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("pending reservations make shared workspace budget admission atomic", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-reserved-admission-"));
  const store = await TransactionalStore.open(dataDir, 10_000);
  try {
    const controller = new AdmissionController(store, { now: () => 3_500_000 });
    controller.setBudget({
      scopeType: "workspace",
      scopeId: "/workspace/a",
      softLimit: null,
      hardLimit: { requestCount: 1 },
      exhaustionPolicy: "pause"
    });
    assert.equal(controller.reserve("reservation-1", { ...context(), runId: "parallel-run-1" }).admitted, true);
    assert.equal(controller.reserve("reservation-2", { ...context(), runId: "parallel-run-2" }).admitted, false);
    assert.equal(controller.settings.pendingReservations, 1);
    assert.equal(controller.releaseReservation("reservation-1"), true);
    assert.equal(controller.reserve("reservation-2", { ...context(), runId: "parallel-run-2" }).admitted, true);
  } finally {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("provider facts and operator cost catalogs normalize defensively", () => {
  const snapshots = normalizeRateLimitSnapshots("spark", {
    limitName: "Spark weekly",
    primary: { usedPercent: 25, resetsAt: 2_000_000_000 }
  }, 10);
  assert.deepEqual(snapshots.map(({ limitId, remainingPercent, resetAt }) => ({ limitId, remainingPercent, resetAt })), [
    { limitId: "Spark weekly:primary", remainingPercent: 75, resetAt: 2_000_000_000_000 }
  ]);
  assert.deepEqual(parseCostCatalog(JSON.stringify({
    version: "2026-07-16",
    currency: "usd",
    models: { "model-a": { inputTokens: 5_000_000, outputTokens: 10_000_000 } }
  })), {
    version: "2026-07-16",
    currency: "USD",
    models: { "model-a": { inputTokens: 5_000_000, outputTokens: 10_000_000 } }
  });
  assert.equal(retryAfterSecondsFromError({ data: { retry_after: 12 } }), 12);
  assert.equal(retryAfterSecondsFromError(new Error("rate limited; retry-after: 250ms")), 0.25);
});

function context() {
  return {
    provider: "codex" as const,
    model: "model-a",
    runId: "run-admit-1",
    workspaceId: "/workspace/a",
    blueprintId: "blueprint-a"
  };
}

function tokens(totalTokens: number) {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens };
}
