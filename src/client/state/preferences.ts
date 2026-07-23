import type { ModelPreset, NotificationPreferences, SessionSettings, ThreadTokenUsage } from "../types";

type LaunchProvider = "codex";

type RecentWorkspace = {
  path: string;
  lastUsedAt: number;
};

export type LastSessionSetup = {
  workspace: string;
  provider: LaunchProvider;
  model: string;
  effort: string;
  preset?: ModelPreset;
  name: string;
  category: string;
  tags: string[];
};

export type LaunchPreferences = {
  version: 1;
  lastWorkspace: string;
  model: string;
  effort: string;
  recentWorkspaces: RecentWorkspace[];
  lastSession: LastSessionSetup;
};

export type RememberedLaunch = Omit<LastSessionSetup, "name" | "category" | "tags"> & {
  name?: string;
  category?: string;
  tags?: string[];
};

export const LAUNCH_PREFERENCES_KEY = "forgedeck-launch-preferences";
const ONBOARDING_SEEN_KEY = "forgedeck-onboarding-seen";
const MAX_RECENT_WORKSPACES = 5;

const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  onCompletion: false,
  onFailure: false,
  onApprovalNeeded: false
};

export function readStoredJson(key: string): unknown {
  try { const raw = localStorage.getItem(key); return raw === null ? null : JSON.parse(raw) as unknown; } catch { return null; }
}

export function readStoredString(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function writeStoredString(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* Optional UI persistence may be unavailable. */ }
}

export function writeStoredJson(key: string, value: unknown): void {
  try { writeStoredString(key, JSON.stringify(value)); } catch { /* Ignore unserializable optional state. */ }
}

export function readStoredStringArray(key: string): string[] {
  const value = readStoredJson(key);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function readLaunchPreferences(): LaunchPreferences | null {
  const value = readStoredJson(LAUNCH_PREFERENCES_KEY);
  if (!isRecord(value) || value.version !== 1) return null;
  const lastSession = readLastSessionSetup(value.lastSession);
  if (!lastSession) return null;
  const recentWorkspaces = Array.isArray(value.recentWorkspaces)
    ? value.recentWorkspaces.flatMap((candidate) => {
      if (!isRecord(candidate) || typeof candidate.path !== "string" || !candidate.path.trim()) return [];
      return [{ path: candidate.path, lastUsedAt: typeof candidate.lastUsedAt === "number" ? candidate.lastUsedAt : 0 }];
    }).slice(0, MAX_RECENT_WORKSPACES)
    : [];
  return {
    version: 1,
    lastWorkspace: typeof value.lastWorkspace === "string" && value.lastWorkspace.trim() ? value.lastWorkspace : lastSession.workspace,
    model: typeof value.model === "string" && value.model ? value.model : lastSession.model,
    effort: typeof value.effort === "string" && value.effort ? value.effort : lastSession.effort,
    recentWorkspaces,
    lastSession
  };
}

export function rememberLaunch(input: RememberedLaunch, now = Date.now()): LaunchPreferences {
  const current = readLaunchPreferences();
  const workspace = input.workspace.trim();
  const recentWorkspaces = [
    { path: workspace, lastUsedAt: now },
    ...(current?.recentWorkspaces || []).filter((candidate) => candidate.path !== workspace)
  ].slice(0, MAX_RECENT_WORKSPACES);
  const preferences: LaunchPreferences = {
    version: 1,
    lastWorkspace: workspace,
    model: input.model,
    effort: input.effort,
    recentWorkspaces,
    lastSession: {
      workspace,
      provider: input.provider,
      model: input.model,
      effort: input.effort,
      ...(input.preset ? { preset: input.preset } : {}),
      name: input.name?.trim() || "",
      category: input.category?.trim() || "",
      tags: (input.tags || []).map((tag) => tag.trim()).filter(Boolean).slice(0, 10)
    }
  };
  writeStoredJson(LAUNCH_PREFERENCES_KEY, preferences);
  return preferences;
}

export function hasLaunchConfiguration(): boolean {
  return readLaunchPreferences() !== null || readStoredString(ONBOARDING_SEEN_KEY) !== null;
}

export function markOnboardingSeen(): void {
  writeStoredString(ONBOARDING_SEEN_KEY, "1");
}

export function readThreadSettings(): Record<string, SessionSettings> {
  const value = readStoredJson("forgedeck-settings");
  if (!isRecord(value)) return {};
  const settings: Record<string, SessionSettings> = {};
  for (const [threadId, candidate] of Object.entries(value)) {
    if (isRecord(candidate) && typeof candidate.model === "string" && typeof candidate.effort === "string") {
      settings[threadId] = {
        model: candidate.model,
        effort: candidate.effort,
        notifications: readNotificationPreferences(candidate.notifications)
      };
    }
  }
  return settings;
}

export function notificationPreferences(settings?: Pick<SessionSettings, "notifications"> | null): NotificationPreferences {
  return { ...DEFAULT_NOTIFICATION_PREFERENCES, ...settings?.notifications };
}

export function readTokenUsage(): Record<string, ThreadTokenUsage> {
  const value = readStoredJson("forgedeck-token-usage");
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, ThreadTokenUsage] => isRecord(entry[1]) && typeof entry[1].totalTokens === "number"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readLastSessionSetup(value: unknown): LastSessionSetup | null {
  if (!isRecord(value)
    || typeof value.workspace !== "string" || !value.workspace.trim()
    || value.provider !== "codex"
    || typeof value.model !== "string" || !value.model
    || typeof value.effort !== "string" || !value.effort) return null;
  return {
    workspace: value.workspace,
    provider: value.provider,
    model: value.model,
    effort: value.effort,
    ...(isModelPreset(value.preset) ? { preset: value.preset } : {}),
    name: typeof value.name === "string" ? value.name : "",
    category: typeof value.category === "string" ? value.category : "",
    tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 10) : []
  };
}

function isModelPreset(value: unknown): value is ModelPreset {
  return value === "quick" || value === "balanced" || value === "deep";
}

function readNotificationPreferences(value: unknown): NotificationPreferences {
  if (!isRecord(value)) return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  return {
    onCompletion: value.onCompletion === true,
    onFailure: value.onFailure === true,
    onApprovalNeeded: value.onApprovalNeeded === true
  };
}
