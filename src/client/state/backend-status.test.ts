import assert from "node:assert/strict";
import test from "node:test";
import { mergeBackendStatus, reconcileBackendStatusResponse } from "./backend-status.js";
import type { AccountStatus } from "../types.js";

test("Claude backend status events update usage without removing provider metadata", () => {
  const status: AccountStatus = {
    account: { account: null, requiresOpenaiAuth: false },
    usage: null,
    backendStatus: {
      codex: { available: true, activeCount: 0, rateLimit: null },
      spark: { available: true, activeCount: 0, rateLimit: null },
      claude: {
        available: true,
        activeCount: 0,
        maxConcurrent: 1,
        rateLimit: { primary: { usedPercent: 0 } }
      }
    }
  };

  const updated = mergeBackendStatus(status, {
    claude: {
      activeCount: 1,
      maxConcurrent: 1,
      rateLimit: { primary: { usedPercent: 100 } }
    }
  });

  assert.equal(updated.backendStatus?.claude.available, true);
  assert.equal(updated.backendStatus?.claude.activeCount, 1);
  assert.equal(updated.backendStatus?.claude.rateLimit?.primary?.usedPercent, 100);
  assert.strictEqual(updated.backendStatus?.codex, status.backendStatus?.codex);
});

test("a status response cannot overwrite Claude usage received while it was in flight", () => {
  const stale: AccountStatus = {
    account: { account: null, requiresOpenaiAuth: false },
    usage: null,
    backendStatus: {
      codex: { available: true, activeCount: 0 },
      spark: { available: true, activeCount: 0 },
      claude: { available: true, activeCount: 0, maxConcurrent: 1, rateLimit: { primary: { usedPercent: 0 } } }
    }
  };

  const reconciled = reconcileBackendStatusResponse(stale, 3, {
    generation: 4,
    value: { claude: { activeCount: 1, maxConcurrent: 1, rateLimit: { primary: { usedPercent: 100 } } } }
  });

  assert.equal(reconciled.backendStatus?.claude.activeCount, 1);
  assert.equal(reconciled.backendStatus?.claude.rateLimit?.primary?.usedPercent, 100);
});
