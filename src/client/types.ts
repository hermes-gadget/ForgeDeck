export type ReasoningOption = { reasoningEffort: string; description: string };

export type CodexModel = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: ReasoningOption[];
  serviceTiers: Array<{ id: string; name: string; description: string }>;
};

export type ClaudeModelOption = {
  id: string;
  model: string;
  displayName: string;
  description: string;
};

export type ThreadStatus = { type: "notLoaded" | "idle" | "systemError" | "active"; activeFlags?: string[] };

export type ThreadItem = {
  id?: string;
  type: string;
  text?: string;
  content?: Array<{ type: string; text?: string; path?: string }>;
  summary?: string[];
  command?: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  changes?: Array<{ path?: string; kind?: string; [key: string]: unknown }>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  [key: string]: unknown;
};

export type Turn = {
  id: string;
  items: ThreadItem[];
  status: "inProgress" | "completed" | "failed" | "interrupted";
  error?: { message?: string } | null;
  startedAt?: number | null;
  completedAt?: number | null;
};

export type Thread = {
  id: string;
  name: string | null;
  preview: string;
  cwd: string;
  modelProvider: string;
  createdAt: number;
  updatedAt: number;
  recencyAt: number | null;
  status: ThreadStatus;
  turns: Turn[];
  gitInfo?: { branch?: string; repositoryUrl?: string } | null;
  goal?: ThreadGoal | null;
  policy?: "workspace-write" | "yolo";
  tags?: string[];
  category?: string | null;
  backend?: "codex" | "claude";
  sessionClass?: "standard" | "spark";
  claudeModel?: string;
  claudeEffort?: string;
  claudePermissionMode?: string;
};

export type ThreadGoal = {
  threadId: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
};

export type RateWindow = { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null };
export type RateSnapshot = {
  limitId: string | null;
  limitName: string | null;
  primary: RateWindow | null;
  secondary: RateWindow | null;
  planType: string | null;
};
export type Usage = {
  rateLimits: RateSnapshot;
  rateLimitsByLimitId: Record<string, RateSnapshot> | null;
};

export type PendingRequest = {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
  receivedAt: number;
};

export type QueueEntry = { id: string; text: string; model: string; effort: string | null; createdAt: number };
export type LiveThreadState = {
  items: Record<string, ThreadItem>;
  agentText: Record<string, string>;
  toolOutput: Record<string, string>;
  active: boolean;
  completedAt: number | null;
  updatedAt: number;
};

export type Bootstrap = {
  models: { data: CodexModel[] };
  account: { account: { type: string; email?: string | null; planType?: string } | null; requiresOpenaiAuth: boolean };
  usage: Usage | null;
  backendStatus?: {
    codex: { available: boolean; rateLimit?: { primary?: { usedPercent: number } } | null; activeCount: number };
    spark: { available: boolean; rateLimit?: { primary?: { usedPercent: number } } | null; activeCount: number };
    claude: { available: boolean; rateLimit?: { primary?: { usedPercent: number } } | null; activeCount: number };
  };
  roots: string[];
  pendingRequests: PendingRequest[];
  liveState?: Record<string, LiveThreadState>;
  queues?: Record<string, QueueEntry[]>;
  activeThreadIds?: string[];
  agentThreadIds?: string[];
  sparkAgentThreadIds?: string[];
  claudeAvailable?: boolean;
  claudeModelOptions?: ClaudeModelOption[];
};
