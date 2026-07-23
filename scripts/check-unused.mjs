#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const baseline = {
  "src/client/api/client.ts": { exports: ["ApiError"] },
  "src/client/state/preferences.ts": { exports: ["readStoredJson", "readTokenUsage"] },
  "src/client/state/thread-store.ts": { exports: ["useThreadSummary"] },
  "src/client/types.ts": { types: ["ReasoningOption", "Turn", "ThreadGoal", "RateWindow", "RateSnapshot"] },
  "src/server/capacity.ts": { exports: ["CapacityCancelledError", "CapacityUnavailableError"] },
  "src/server/codex-bridge.ts": {
    exports: ["CodexRpcError", "CodexUnavailableError"],
    types: ["RpcErrorPayload", "BridgeOfflineEvent", "BridgeReadyEvent"]
  },
  "src/server/config.ts": {
    exports: ["DEFAULT_SESSION_TTL_HOURS", "validateRuntime", "assertRuntimeReady"],
    types: ["RuntimePreflight"]
  },
  "src/server/logger.ts": { exports: ["Logger"], types: ["LoggerOptions"] },
  "src/server/session-manager.ts": { exports: ["normalizeCategory"], types: ["SessionBackend"] },
  "src/server/store.ts": {
    exports: ["QueueDrainScheduler"],
    types: ["QueueDeliveryState", "QueueDrainOutcome", "QueueDrainSchedulerOptions"]
  }
};

const result = spawnSync("knip", ["--include", "exports,types", "--reporter", "json"], {
  encoding: "utf8"
});

if (result.error || (result.status !== 0 && !result.stdout.trim())) {
  if (result.stderr) process.stderr.write(result.stderr);
  throw result.error || new Error(`Knip failed with exit code ${result.status}`);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch (error) {
  if (result.stderr) process.stderr.write(result.stderr);
  throw new Error("Could not parse Knip's JSON report", { cause: error });
}

const unexpected = [];
let knownCount = 0;
for (const issue of report.issues || []) {
  for (const kind of ["exports", "types"]) {
    const allowed = new Set(baseline[issue.file]?.[kind] || []);
    for (const item of issue[kind] || []) {
      if (allowed.has(item.name)) knownCount += 1;
      else unexpected.push({ file: issue.file, kind, ...item });
    }
  }
}

if (unexpected.length) {
  console.error("Unused exports/types not present in the checked-in baseline:");
  for (const item of unexpected) {
    console.error(`- ${item.file}:${item.line} ${item.kind}: ${item.name}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Unused-export check passed (${knownCount} pre-existing baseline items).`);
}
