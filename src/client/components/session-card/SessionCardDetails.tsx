import { AlertTriangle, CheckCircle2, Circle, Clock3, ListPlus, LoaderCircle } from "lucide-react";
import { timestampToEpochMs } from "../../../shared/contracts";
import type { Thread, ThreadItem } from "../../types";
import type { ErrorEntry } from "../error-center/ErrorCenter";

export type SessionCardState = "idle" | "running" | "queued" | "waiting" | "error" | "done";

export type SessionCardDetails = {
  state: SessionCardState;
  task: string;
  goal: string | null;
  outcome: string | null;
  errorCount: number;
  lastError: string | null;
  model: string;
  effort: string;
  artifactCount: number;
  unmetGateCount: number;
  artifactStatus: "not-configured" | "pending" | "passed";
  queueDepth: number;
  lastActivityAt: number;
};

export function buildSessionCardDetails(thread: Thread, options: {
  completed?: boolean;
  completedAt?: number | null;
  queueDepth?: number;
  waiting?: boolean;
  errors?: readonly ErrorEntry[];
} = {}): SessionCardDetails {
  const turns = thread.turns || [];
  const lastTurn = turns.at(-1);
  const scopedErrors = (options.errors || []).filter((entry) => entry.sessionId === thread.id);
  const failedTurns = turns.filter((turn) => turn.status === "failed");
  const reportedErrorCount = scopedErrors.reduce((total, entry) => total + entry.count, 0);
  const errorCount = Math.max(reportedErrorCount, failedTurns.length);
  const latestReportedError = scopedErrors.reduce<ErrorEntry | null>((latest, entry) =>
    !latest || entry.lastOccurredAt > latest.lastOccurredAt ? entry : latest, null);
  const lastTurnError = [...turns].reverse().find((turn) => turn.error?.message)?.error?.message || null;
  const lastError = cleanText(latestReportedError?.message || lastTurnError ||
    (thread.status.type === "systemError" ? "The session runtime reported an error." : "")) || null;
  const queueDepth = Math.max(0, options.queueDepth ?? thread.queueDepth ?? 0);
  const running = thread.status.type === "active" || turns.some((turn) => turn.status === "inProgress");
  const guardianWaiting = Boolean(thread.guardian && ["stalled", "retrying", "escalating", "paused"].includes(thread.guardian.phase));
  const goalWaiting = Boolean(thread.goal && ["paused", "blocked", "usageLimited", "budgetLimited"].includes(thread.goal.status));
  const completionWaiting = thread.artifactStatus?.status === "pending";
  const failed = thread.status.type === "systemError" || thread.guardian?.phase === "failed" || lastTurn?.status === "failed" || reportedErrorCount > 0;
  const done = options.completed || thread.goal?.status === "complete" || lastTurn?.status === "completed";
  const state: SessionCardState = failed ? "error"
    : options.waiting || guardianWaiting || goalWaiting || completionWaiting ? "waiting"
      : running ? "running"
        : queueDepth > 0 ? "queued"
          : done ? "done" : "idle";
  const task = lastItemText(turns, (item) => item.type === "userMessage" || item.type === "user_message")
    || cleanText(thread.preview)
    || "No task has been sent yet.";
  const outcome = lastError || lastItemText(turns, (item) => item.type === "agentMessage" || item.type === "assistant_message")
    || (state === "done" ? "The latest task completed." : null);
  const lastActivityAt = latestTimestamp([
    thread.updatedAt,
    thread.recencyAt,
    thread.goal?.updatedAt,
    thread.guardian?.lastActivityAt,
    lastTurn?.completedAt,
    lastTurn?.startedAt,
    options.completedAt
  ]);

  return {
    state,
    task,
    goal: cleanText(thread.goal?.objective || "") || null,
    outcome,
    errorCount,
    lastError,
    model: thread.model || thread.claudeModel || (thread.backend === "claude" ? "Claude" : thread.sessionClass === "spark" ? "Spark" : "Codex"),
    effort: thread.reasoningEffort || thread.effort || thread.claudeEffort || "default",
    artifactCount: thread.artifactStatus?.artifactCount || 0,
    unmetGateCount: thread.artifactStatus?.unmetGates.length || 0,
    artifactStatus: thread.artifactStatus?.status || "not-configured",
    queueDepth,
    lastActivityAt
  };
}

export function SessionStateBadge({ state }: { state: SessionCardState }) {
  const label = state === "running" ? "Run"
    : state === "queued" ? "Queue"
      : state === "waiting" ? "Wait"
        : state === "error" ? "Error"
          : state === "done" ? "Done" : "Idle";
  return <em className={`session-state ${state}`} title={state}>
    {state === "running" ? <LoaderCircle className="spin" size={9} />
      : state === "queued" ? <ListPlus size={9} />
        : state === "waiting" ? <Clock3 size={9} />
          : state === "error" ? <AlertTriangle size={9} />
            : state === "done" ? <CheckCircle2 size={9} /> : <Circle size={8} />}
    {label}
  </em>;
}

export function relativeActivity(timestamp: number): string {
  const seconds = Math.max(0, (Date.now() - timestamp) / 1_000);
  return seconds < 60 ? "now" : seconds < 3_600 ? `${Math.floor(seconds / 60)}m ago`
    : seconds < 86_400 ? `${Math.floor(seconds / 3_600)}h ago` : `${Math.floor(seconds / 86_400)}d ago`;
}

export function activityTitle(timestamp: number): string {
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toLocaleString() : "Activity time unavailable";
}

function lastItemText(turns: Thread["turns"], predicate: (item: ThreadItem) => boolean): string | null {
  for (const turn of [...turns].reverse()) {
    for (const item of [...turn.items].reverse()) {
      if (!predicate(item)) continue;
      const value = item.text || item.content?.map((part) => part.text || "").join(" ") || "";
      const cleaned = cleanText(value);
      if (cleaned) return cleaned;
    }
  }
  return null;
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function latestTimestamp(values: Array<string | number | null | undefined>): number {
  return values.reduce<number>((latest, value) => {
    if (value === null || value === undefined) return latest;
    const timestamp = typeof value === "number" ? value : timestampToEpochMs(value);
    return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
  }, 0);
}
