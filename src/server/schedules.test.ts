import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BlueprintManager } from "./blueprints.js";
import {
  ScheduleManager,
  ScheduleRunner,
  ScheduleValidationError,
  nextCronOccurrence,
  type ScheduledOperation
} from "./schedules.js";
import { TransactionalStore } from "./store.js";

test("schedules persist blueprint inputs, claim due intervals, and retain run history", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-schedules-"));
  let now = Date.UTC(2035, 0, 1, 9, 0, 0);
  let store = await TransactionalStore.open(directory, 10_000);
  try {
    const blueprints = new BlueprintManager(store, () => now);
    const blueprint = blueprints.create({
      id: "scheduled-review",
      name: "Scheduled review",
      definition: definition()
    });
    let schedules = new ScheduleManager(store, blueprints, () => now);
    const schedule = schedules.create({
      name: "Hourly review",
      blueprintId: blueprint.id,
      blueprintVersion: blueprint.version,
      variables: { TARGET: "payments" },
      timing: { type: "interval", intervalMs: 60_000 }
    });
    assert.equal(schedule.nextRunAt, now + 60_000);
    assert.deepEqual(schedule.variables, { TARGET: "payments" });

    store.close();
    store = await TransactionalStore.open(directory, 10_000);
    schedules = new ScheduleManager(store, new BlueprintManager(store, () => now), () => now);
    assert.equal(schedules.list()[0]?.id, schedule.id);

    now += 60_000;
    const operations = new Map<string, ScheduledOperation>();
    let fired = 0;
    const runner = new ScheduleRunner(schedules, async (_scheduled, run) => {
      fired += 1;
      const operationId = `operation-${run.id}`;
      operations.set(operationId, { id: operationId, status: "running", remoteThreadId: null, error: null });
      return { operationId };
    }, (operationId) => operations.get(operationId) || null, 60_000);

    await runner.tick();
    assert.equal(fired, 1);
    let persisted = schedules.get(schedule.id)!;
    assert.equal(persisted.recentRuns[0]?.status, "running");
    assert.equal(persisted.lastRunAt, now);
    assert.equal(persisted.nextRunAt, now + 60_000);

    const run = persisted.recentRuns[0]!;
    operations.set(run.operationId!, {
      id: run.operationId!,
      status: "succeeded",
      remoteThreadId: "thread-scheduled-review",
      error: null
    });
    await runner.tick();
    persisted = schedules.get(schedule.id)!;
    assert.equal(persisted.recentRuns[0]?.status, "succeeded");
    assert.equal(persisted.recentRuns[0]?.threadId, "thread-scheduled-review");
    assert.equal(persisted.recentRuns[0]?.completedAt, now);
  } finally {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("one-shot and cron schedules validate timing and workspace requirements", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "forgedeck-schedule-validation-"));
  const now = Date.UTC(2035, 0, 1, 9, 0, 0);
  const store = await TransactionalStore.open(directory, 10_000);
  const blueprints = new BlueprintManager(store, () => now);
  try {
    blueprints.create({ id: "current-workspace", name: "Current workspace", definition: definition({ selector: "current" }) });
    const schedules = new ScheduleManager(store, blueprints, () => now);
    assert.throws(() => schedules.create({
      blueprintId: "current-workspace",
      variables: { TARGET: "payments" },
      timing: { type: "once", runAt: now + 60_000 }
    }), ScheduleValidationError);

    const oneShot = schedules.create({
      blueprintId: "current-workspace",
      workspace: "/workspace",
      variables: { TARGET: "payments" },
      timing: { type: "once", runAt: new Date(now + 60_000).toISOString() }
    });
    assert.equal(oneShot.nextRunAt, now + 60_000);

    const nextWeekdayMorning = nextCronOccurrence("30 9 * * 1-5", Date.UTC(2035, 0, 1, 9, 29));
    const next = new Date(nextWeekdayMorning);
    assert.equal(next.getMinutes(), 30);
    assert.equal(next.getHours(), 9);
    assert.ok(next.getDay() >= 1 && next.getDay() <= 5);
    assert.throws(() => nextCronOccurrence("not a cron", now), /five fields/);
  } finally {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function definition(workspace: { selector: "current" } | { selector: "fixed"; value: string } = { selector: "fixed", value: "/workspace" }) {
  return {
    promptTemplate: "Review ${TARGET}.",
    role: "Reviewer",
    workspace,
    model: { backend: "codex" as const, routing: "fixed" as const, model: "gpt-5.3-codex", effort: "high" },
    tools: { enable: ["shell"], disable: [] },
    knowledge: [],
    completionGates: [],
    approvals: { mode: "on-request" as const, requiredFor: [] },
    variables: [{ name: "TARGET", type: "string" as const, required: true }]
  };
}
