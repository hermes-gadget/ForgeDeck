import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import {
  LAUNCH_PREFERENCES_KEY, hasLaunchConfiguration, markOnboardingSeen, notificationPreferences,
  readLaunchPreferences, readThreadSettings, rememberLaunch
} from "./preferences.js";

test("stored session settings migrate notification preferences as opt-in flags", () => {
  const dom = new JSDOM("", { url: "http://forgedeck.test/" });
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  try {
    localStorage.setItem("forgedeck-settings", JSON.stringify({
      legacy: { model: "gpt-test", effort: "high" },
      optedIn: {
        model: "gpt-test",
        effort: "medium",
        notifications: { onCompletion: true, onFailure: false, onApprovalNeeded: true }
      }
    }));
    const settings = readThreadSettings();
    assert.deepEqual(notificationPreferences(settings.legacy), {
      onCompletion: false,
      onFailure: false,
      onApprovalNeeded: false
    });
    assert.deepEqual(notificationPreferences(settings.optedIn), {
      onCompletion: true,
      onFailure: false,
      onApprovalNeeded: true
    });
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
    dom.window.close();
  }
});

test("launch preferences remember safe defaults and keep recent workspaces unique", () => {
  const dom = new JSDOM("", { url: "http://forgedeck.test/" });
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  try {
    rememberLaunch({ workspace: "/work/alpha", provider: "codex", model: "gpt-a", effort: "medium", name: "Alpha", tags: ["one"] }, 10);
    rememberLaunch({ workspace: "/work/beta", provider: "claude", model: "claude-b", effort: "high", category: "Product" }, 20);
    rememberLaunch({ workspace: "/work/alpha", provider: "codex", model: "gpt-c", effort: "high" }, 30);

    assert.deepEqual(readLaunchPreferences(), {
      version: 1,
      lastWorkspace: "/work/alpha",
      model: "gpt-c",
      effort: "high",
      recentWorkspaces: [
        { path: "/work/alpha", lastUsedAt: 30 },
        { path: "/work/beta", lastUsedAt: 20 }
      ],
      lastSession: {
        workspace: "/work/alpha",
        provider: "codex",
        model: "gpt-c",
        effort: "high",
        name: "",
        category: "",
        tags: []
      }
    });
    assert.equal(hasLaunchConfiguration(), true);
    const raw = localStorage.getItem(LAUNCH_PREFERENCES_KEY) || "";
    assert.equal(raw.includes("prompt"), false);
    assert.equal(raw.includes("yolo"), false);
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
    dom.window.close();
  }
});

test("dismissing onboarding counts as local launch configuration", () => {
  const dom = new JSDOM("", { url: "http://forgedeck.test/" });
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  try {
    assert.equal(hasLaunchConfiguration(), false);
    markOnboardingSeen();
    assert.equal(hasLaunchConfiguration(), true);
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
    dom.window.close();
  }
});
