import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { JSDOM, type DOMWindow } from "jsdom";

test("browser lifecycle authenticates, loads application state, opens events, and cleans up", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://forgedeck.test/" });
  const restore = installBrowserGlobals(dom.window);
  const requests: string[] = [];
  const eventSources: FakeEventSource[] = [];
  const originalFetch = globalThis.fetch;
  const originalEventSource = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  globalThis.fetch = async (input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, dom.window.location.href);
    requests.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/api/auth") return jsonResponse({ authenticated: true });
    if (url.pathname === "/api/bootstrap") return jsonResponse({
      server: { id: "forgedeck-test", name: "ForgeDeck" },
      version: "0.1.0",
      health: { status: "ok", runtime: {}, storage: { status: "ok", writable: true } },
      models: { data: [] },
      roots: ["/workspace"],
      claudeModelOptions: []
    });
    if (url.pathname === "/api/account/status") return jsonResponse({
      account: { account: null, requiresOpenaiAuth: false },
      usage: null,
      activeThreadIds: [],
      agentThreadIds: [],
      sparkAgentThreadIds: [],
      claudeAvailable: false
    });
    if (url.pathname === "/api/approvals") return jsonResponse({ data: [] });
    if (url.pathname === "/api/events/revision") return jsonResponse({ revision: 4 });
    if (url.pathname.startsWith("/api/events/subscriptions/")) return jsonResponse({ ok: true, connected: true, threadIds: [] });
    if (url.pathname === "/api/threads") return jsonResponse({ data: [], nextCursor: null, total: 0 });
    if (url.pathname === "/api/blueprints") return jsonResponse({ data: [] });
    throw new Error(`Unexpected browser request ${url.pathname}`);
  };
  Object.defineProperty(globalThis, "EventSource", {
    configurable: true,
    value: class extends FakeEventSource {
      constructor(url: string | URL) {
        super(url);
        eventSources.push(this);
      }
    }
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const { createRoot } = await import("react-dom/client");
  const { default: App } = await import("./App.js");
  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);

  try {
    await act(async () => root.render(createElement(App)));
    await waitUntil(() => container.textContent?.includes("No session selected") === true);

    assert.equal(requests.includes("/api/auth"), true);
    assert.equal(requests.includes("/api/bootstrap"), true);
    assert.equal(requests.includes("/api/account/status"), true);
    assert.equal(requests.includes("/api/approvals"), true);
    assert.equal(requests.filter((request) => request.startsWith("/api/threads?limit=100&")).length, 1);
    assert.equal(requests.some((request) => request.startsWith("/api/blueprints?")), true);
    assert.equal(container.textContent?.includes("Get a session running"), true);
    assert.equal(eventSources.length, 1);
    const eventUrl = new URL(eventSources[0].url, dom.window.location.href);
    assert.equal(eventUrl.pathname, "/events");
    assert.match(eventUrl.searchParams.get("clientId") || "", /^[A-Za-z0-9._-]{1,128}$/);
    assert.deepEqual(eventUrl.searchParams.getAll("threadId"), []);

    await act(async () => eventSources[0].emit("connected", { at: Date.now() }, 4));
    await waitUntil(() => container.textContent?.includes("LiveLast synced") === true);
    const recoveryCount = requests.filter((request) => request === "/api/events/revision").length;
    await act(async () => eventSources[0].fail());
    await waitUntil(() => container.textContent?.includes("Polling every 10s") === true);
    assert.ok(requests.filter((request) => request === "/api/events/revision").length > recoveryCount);
    assert.equal(container.textContent?.includes("Last synced 0 seconds ago"), true);

    const reconnect = container.querySelector<HTMLButtonElement>("button[aria-label='Reconnect live stream now']");
    assert.ok(reconnect);
    await act(async () => reconnect.click());
    await waitUntil(() => eventSources.length === 2);
    assert.equal(eventSources[0].closed, true);

    await act(async () => root.unmount());
    assert.equal(eventSources[1].closed, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEventSource) Object.defineProperty(globalThis, "EventSource", originalEventSource);
    else delete (globalThis as { EventSource?: unknown }).EventSource;
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    restore();
    dom.window.close();
  }
});

class FakeEventSource {
  readonly url: string;
  closed = false;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, Array<EventListenerOrEventListenerObject>>();

  constructor(url: string | URL) {
    this.url = String(url);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, payload: unknown, eventId: number): void {
    const event = new MessageEvent(type, {
      data: JSON.stringify({ eventId, schemaVersion: 1, threadId: null, payload }),
      lastEventId: String(eventId)
    });
    for (const listener of this.listeners.get(type) || []) {
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    }
  }

  fail(): void {
    this.onerror?.(new Event("error"));
  }

  close(): void {
    this.closed = true;
  }
}

function installBrowserGlobals(window: DOMWindow): () => void {
  const names = ["window", "document", "navigator", "localStorage", "HTMLElement", "Event", "MessageEvent"] as const;
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const name of names) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value: window[name] });
  }
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, media: "", onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })
  });
  return () => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  throw new Error("Timed out waiting for the browser application to load");
}
