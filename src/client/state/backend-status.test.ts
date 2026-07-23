import assert from "node:assert/strict";
import test from "node:test";
import { mergeBackendStatus, reconcileBackendStatusResponse } from "./backend-status.js";
import type { AccountStatus } from "../types.js";

test("backend status events update usage without removing provider metadata", () => {
  const status: AccountStatus = {
    account: { account: null, requiresOpenaiAuth: false },
    usage: null,
    backendStatus: {
      codex: { available: true, activeCount: 0, rateLimit: null },
      spark: { available: true, activeCount: 0, rateLimit: null }
    }
  };

  const updated = mergeBackendStatus(status, {
    codex: {
      activeCount: 1,
      maxConcurrent: 1,
      rateLimit: { primary: { usedPercent: 100 } }
    }
  });

  assert.equal(updated.backendStatus?.codex.available, true);
  assert.equal(updated.backendStatus?.codex.activeCount, 1);
  assert.equal(updated.backendStatus?.codex.rateLimit?.primary?.usedPercent, 100);
  assert.strictEqual(updated.backendStatus?.spark, status.backendStatus?.spark);
});

test("a status response cannot overwrite usage received while it was in flight", () => {
  const stale: AccountStatus = {
    account: { account: null, requiresOpenaiAuth: false },
    usage: null,
    backendStatus: {
      codex: { available: true, activeCount: 0, maxConcurrent: 1, rateLimit: { primary: { usedPercent: 0 } } },
      spark: { available: true, activeCount: 0 }
    }
  };

  const reconciled = reconcileBackendStatusResponse(stale, 3, {
    generation: 4,
    value: { codex: { activeCount: 1, maxConcurrent: 1, rateLimit: { primary: { usedPercent: 100 } } } }
  });

  assert.equal(reconciled.backendStatus?.codex.activeCount, 1);
  assert.equal(reconciled.backendStatus?.codex.rateLimit?.primary?.usedPercent, 100);
});
