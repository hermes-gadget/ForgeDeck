import type { SsePayload } from "../../shared/contracts";
import type { AccountStatus } from "../types";

export type BackendStatusPatch = SsePayload<"backend-status">;
export type VersionedBackendStatusPatch = { generation: number; value: BackendStatusPatch };

/** Merge a partial live provider update without discarding the other providers. */
export function mergeBackendStatus(status: AccountStatus, patch: BackendStatusPatch): AccountStatus {
  if (!status.backendStatus) return status;
  return {
    ...status,
    backendStatus: {
      codex: patch.codex ? { ...status.backendStatus.codex, ...patch.codex } : status.backendStatus.codex,
      spark: patch.spark ? { ...status.backendStatus.spark, ...patch.spark } : status.backendStatus.spark
    }
  };
}

/** Preserve an SSE patch that arrived after an account-status request began. */
export function reconcileBackendStatusResponse(
  status: AccountStatus,
  requestGeneration: number,
  livePatch: VersionedBackendStatusPatch
): AccountStatus {
  return livePatch.generation > requestGeneration
    ? mergeBackendStatus(status, livePatch.value)
    : status;
}
