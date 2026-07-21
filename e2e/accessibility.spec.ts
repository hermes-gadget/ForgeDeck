import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

const NOW = "2026-07-16T12:00:00.000Z";
const EMPTY_FACETS = {
  status: [], backend: [], model: [], workspace: [], labels: [], queueState: [], owner: [], source: [], archiveState: [], sessionClass: []
};
const MODEL = {
  id: "gpt-5.3-codex",
  model: "gpt-5.3-codex",
  displayName: "GPT-5.3 Codex",
  description: "Coding model",
  isDefault: true,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
  serviceTiers: []
};
const THREADS = [
  makeThread("thread_a11y_001", "Accessibility baseline", "/workspace/forge-deck", "active"),
  makeThread("thread_a11y_002", "Keyboard navigation", "/workspace/navigation", "idle"),
  makeThread("thread_a11y_003", "Phone layout", "/workspace/responsive", "idle")
];

test.beforeEach(async ({ page }) => {
  await installApiMocks(page);
});

for (const theme of ["dark", "light"] as const) {
  test(`${theme} theme passes axe contrast and accessibility checks`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem("forgedeck-theme", value), theme);
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: "Sessions" })).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations, formatViolations(results.violations)).toEqual([]);
  });
}

test("system theme follows the OS until manually overridden", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript(() => localStorage.setItem("forgedeck-theme", "system"));
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Sessions" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme-mode", "system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.getByLabel("Color theme").selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme-mode", "light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("forgedeck-theme"))).toBe("light");
});

test("workspace tabs and session sidebar use roving keyboard focus", async ({ page }) => {
  await page.goto("/");
  const sessionTab = page.getByRole("tab", { name: "Session workspace" });
  await sessionTab.focus();
  await sessionTab.press("ArrowRight");
  await expect(page.getByRole("tab", { name: /Control Center/ })).toBeFocused();
  await expect(page.getByRole("tab", { name: /Control Center/ })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: /Control Center/ }).press("ArrowLeft");
  await expect(sessionTab).toBeFocused();

  const sessionButtons = page.locator(".session-card-main");
  await sessionButtons.first().focus();
  await sessionButtons.first().press("ArrowDown");
  await expect(sessionButtons.nth(1)).toBeFocused();
  await expect(page.locator('.session-card-main[tabindex="0"]')).toHaveCount(1);
  const focusStyle = await sessionButtons.nth(1).evaluate((element) => getComputedStyle(element));
  expect(Number.parseFloat(focusStyle.outlineWidth)).toBeGreaterThanOrEqual(2);
  expect(focusStyle.outlineStyle).not.toBe("none");
});

for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 740 }]) {
  test(`readable text and touch targets at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Open sidebar" })).toBeVisible();
    await page.getByRole("button", { name: "Open sidebar" }).click();
    await expect(page.getByRole("navigation", { name: "Sessions" })).toBeVisible();
    const sidebarClose = page.getByRole("complementary", { name: "ForgeDeck sessions" }).getByRole("button", { name: "Close sidebar" });
    await expect(sidebarClose).toBeFocused();
    await sidebarClose.press("Escape");
    await expect(page.getByRole("button", { name: "Open sidebar" })).toBeFocused();
    await page.getByRole("button", { name: "Open sidebar" }).click();

    const audit = await page.evaluate(() => {
      const visible = (element: Element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      const smallText = [...document.body.querySelectorAll<HTMLElement>("*")]
        .filter((element) => visible(element) && element.textContent?.trim() && Number.parseFloat(getComputedStyle(element).fontSize) < 11)
        .filter((element) => !(element.tagName === "SELECT" && getComputedStyle(element).fontSize === "0px"))
        .map((element) => `${element.tagName.toLowerCase()}.${element.className}:${getComputedStyle(element).fontSize}`)
        .slice(0, 20);
      const smallTargets = [...document.querySelectorAll<HTMLElement>('button:not(.sidebar-scrim):not(.session-state):not(.provider-usage-meter):not(.search-box), input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), select:not([style*="display:none"]):not([style*="display: none"]), textarea, summary')]
        .filter(visible)
        .filter((element) => {
          const style = getComputedStyle(element);
          if (element.tagName === "SELECT" && style.fontSize === "0px") return false;
          const rect = element.getBoundingClientRect();
          return rect.width < 24 || rect.height < 24;
        })
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return `${element.tagName.toLowerCase()}.${element.className}:${Math.round(rect.width)}x${Math.round(rect.height)}`;
        });
      return {
        smallText,
        smallTargets,
        overflowers: [...document.body.querySelectorAll<HTMLElement>("*")]
          .filter((element) => visible(element) && element.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
          .map((element) => `${element.outerHTML.slice(0, 100)} in ${element.parentElement?.className || element.parentElement?.tagName}:${Math.round(element.getBoundingClientRect().right)}`)
          .slice(0, 20),
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth
      };
    });

    expect(audit.smallText).toEqual([]);
    expect(audit.smallTargets).toEqual([]);
    expect(audit.documentWidth, audit.overflowers.join(", ")).toBeLessThanOrEqual(audit.viewportWidth);
  });
}

test("layout reflows at a 200% zoom-equivalent viewport", async ({ page }) => {
  // 640 CSS pixels represents a 1280px desktop viewport at 200% browser zoom.
  await page.setViewportSize({ width: 640, height: 450 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Open sidebar" })).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    documentHeight: document.documentElement.scrollHeight,
    viewportHeight: document.documentElement.clientHeight
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
  expect(dimensions.documentHeight).toBeLessThanOrEqual(dimensions.viewportHeight);
});

test("mobile monitoring keeps fleet health visible and session cards touch-safe", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const fleet = page.getByRole("region", { name: "Mobile fleet summary" });
  await expect(fleet).toBeVisible();
  await expect(fleet.locator(".mobile-fleet-stat")).toHaveCount(4);

  await page.getByRole("button", { name: "Open sidebar" }).click();
  const sidebar = page.locator(".sidebar");
  await expect(sidebar).toBeVisible();
  const firstCard = sidebar.locator(".session-card").first();
  const cardHeight = await firstCard.evaluate((element) => element.getBoundingClientRect().height);
  expect(cardHeight).toBeLessThanOrEqual(96);
  await expect(firstCard.locator(".session-actions button").first()).toHaveCSS("opacity", "1");
  await expect(firstCard.locator(".session-hover-preview")).toHaveCSS("display", "none");

  await dispatchTouchSwipe(sidebar, { x: 320, y: 220 }, { x: 120, y: 225 });
  await expect(sidebar).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("button", { name: "Open sidebar" })).toBeFocused();
});

for (const width of [768, 1024]) {
  test(`tablet shell uses a collapsible sidebar at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const sidebar = page.getByRole("complementary", { name: "ForgeDeck sessions", includeHidden: true });
    await expect(sidebar).toHaveAttribute("aria-hidden", "true");
    await expect(page.getByRole("button", { name: "Open sidebar" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Mobile fleet summary" })).toHaveCount(0);
    const mainWidth = await page.locator(".main-panel").evaluate((element) => element.getBoundingClientRect().width);
    expect(mainWidth).toBe(width);
  });
}

async function dispatchTouchSwipe(locator: Locator, start: { x: number; y: number }, end: { x: number; y: number }) {
  await locator.evaluate((element, points) => {
    element.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, pointerId: 41, pointerType: "touch", isPrimary: true,
      clientX: points.start.x, clientY: points.start.y
    }));
    element.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, pointerId: 41, pointerType: "touch", isPrimary: true,
      clientX: points.end.x, clientY: points.end.y
    }));
  }, { start, end });
}

async function installApiMocks(page: Page) {
  await page.route((url) => url.pathname.startsWith("/api/") || url.pathname === "/events", async (route) => respond(route));
}

async function respond(route: Route) {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  const method = request.method();
  let body: unknown = { ok: true };

  if (path === "/api/auth") body = { authenticated: true };
  else if (path === "/api/bootstrap") body = {
    server: { id: "test-server", name: "ForgeDeck test" },
    version: "0.1.0",
    health: { status: "ok", runtime: { available: true }, storage: { status: "ok", writable: true } },
    models: { data: [MODEL] },
    roots: ["/workspace"],
    claudeModelOptions: []
  };
  else if (path === "/api/account/status") body = {
    account: { account: { type: "api", email: "dev@example.com", planType: "team" }, requiresOpenaiAuth: false },
    usage: null,
    backendStatus: {
      codex: { available: true, rateLimit: null, activeCount: 1 },
      spark: { available: true, rateLimit: null, activeCount: 0 },
      claude: { available: false, rateLimit: null, activeCount: 0 }
    },
    activeThreadIds: [THREADS[0].id],
    agentThreadIds: [], sparkAgentThreadIds: [], sparkActiveThreadIds: [], claudeAvailable: false
  };
  else if (path === "/api/approvals") body = { data: [] };
  else if (/^\/api\/events\/subscriptions\/[^/]+$/.test(path)) {
    const payload = request.postDataJSON() as { threadIds?: string[] } | null;
    body = { ok: true, connected: true, threadIds: payload?.threadIds || [] };
  }
  else if (path === "/api/events/revision") body = { revision: 1 };
  else if (path === "/api/threads" && method === "GET") body = { data: THREADS, nextCursor: null, total: THREADS.length, revision: 1, facets: EMPTY_FACETS };
  else if (/^\/api\/threads\/[^/]+\/recovery$/.test(path)) {
    const id = path.split("/")[3];
    body = { revision: 1, threadId: id, state: null, queue: [], active: id === THREADS[0].id };
  } else if (/^\/api\/threads\/[^/]+$/.test(path) && method === "GET") {
    body = { thread: THREADS.find((thread) => thread.id === path.split("/")[3]) || THREADS[0] };
  } else if (path === "/api/threads/batch") {
    const payload = request.postDataJSON() as { threadIds?: string[] } | null;
    body = {
      results: (payload?.threadIds || []).map((threadId) => ({
        threadId,
        ok: true,
        value: THREADS.find((thread) => thread.id === threadId) || THREADS[0]
      }))
    };
  }
  else if (path === "/api/health") body = {
    status: "ok", timestamp: NOW, uptimeSeconds: 60,
    subsystems: {
      codex: { available: true, state: "ready", lastHeartbeatAt: Date.parse(NOW) },
      storage: { engine: "sqlite", status: "ok", writable: true, revision: 1 },
      sessions: { active: 1, queuedMessages: 0 },
      events: { clients: 1 }
    }
  };
  else if (path === "/api/diagnostics/performance") body = {
    codex: { reconnectAttempts: 0, pendingRpcCalls: 0, lastHeartbeatAt: Date.parse(NOW) },
    capacity: {
      "codex/standard": { limit: 4, activeCount: 1, waitingCount: 0 },
      claude: { limit: 2, activeCount: 0, waitingCount: 0 },
      "codex/spark": { limit: 8, activeCount: 0, waitingCount: 0 }
    },
    operations: {
      reads: { activeCount: 0, waitingCount: 0, saturated: false },
      mutations: { activeCount: 0, waitingCount: 0, saturated: false }
    },
    sampledAt: Date.parse(NOW)
  };
  else if (path === "/events") {
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: ": connected\n\n" });
    return;
  }

  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body), headers: { etag: '"a11y-test"' } });
}

function makeThread(id: string, name: string, cwd: string, status: "active" | "idle") {
  return {
    id, name, preview: name, cwd, provider: "codex", backend: "codex", modelProvider: "codex",
    createdAt: "2026-07-16T10:00:00.000Z", updatedAt: NOW, recencyAt: NOW,
    status: { type: status },
    turns: status === "active" ? [{
      id: `${id}_turn`, status: "inProgress", startedAt: NOW, completedAt: null,
      items: [{ id: `${id}_user`, type: "userMessage", content: [{ type: "text", text: "Establish the accessibility baseline." }] }]
    }] : [],
    gitInfo: { branch: "main" }, policy: "workspace-write", tags: ["a11y"], category: "Quality",
    sessionClass: "standard", model: MODEL.model, reasoningEffort: "medium", effort: "medium",
    archiveState: "active", queueState: "empty", queueDepth: 0, source: "user"
  };
}

function formatViolations(violations: Array<{ id: string; help: string; nodes: Array<{ target: unknown; failureSummary?: string }> }>) {
  return violations.map((violation) => `${violation.id}: ${violation.help}\n${violation.nodes.map((node) => `  ${JSON.stringify(node.target)} ${node.failureSummary || ""}`).join("\n")}`).join("\n\n");
}
