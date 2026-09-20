import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { DashboardShell } from "@/pages/DashboardShell";

const originalEventSource = globalThis.EventSource;

afterEach(() => { cleanup(); globalThis.EventSource = originalEventSource; });

const hardwareResponse = { hardware: { platform: "darwin", arch: "arm64", totalRamGb: 32, cpuCount: 8, isAppleSilicon: true, unifiedMemoryGb: 32, cudaDevices: [], freeDiskBytes: 500_000_000_000, totalDiskBytes: 1_000_000_000_000, osVersion: "15.0" }, proposed: null, tiers: [] };
const budgetResponse = { totalMemoryBytes: 24_000_000_000, capBytes: 16_000_000_000, freeMemoryBytes: 15_700_000_000, pressure: false, loaded: [], queue: [] };
const storageResponse = { freeDiskBytes: 500_000_000_000, byCategory: { models: 120_000_000_000, engines: 40_000_000_000, logs: 1_000_000_000, backups: 5_000_000_000 } };

function RoutePath() { return <output data-testid="route-path">{useLocation().pathname}</output>; }

function stubStackFetch(responses: Record<string, unknown>): void {
  globalThis.EventSource = undefined as unknown as typeof EventSource;
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = new URL(url, "http://local").pathname;
    const known = Object.entries(responses).find(([key, value]) => value !== undefined && path.endsWith(key));
    const body = known ? known[1] : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const boardExtras = { "/stack/v1/hardware": hardwareResponse, "/stack/v1/budget": budgetResponse, "/stack/v1/storage": storageResponse, "/stack/v1/notifications": { notifications: [] }, "/stack/v1/setup/plan": { plan: null, downloads: [], health: null } };

test("the Stack shell lists every section in order", () => {
  stubStackFetch({ ...boardExtras, "/stack/v1/repairs": { repairs: [] }, "/stack/v1/roles": { roles: [] }, "/stack/v1/operator": { state: "signedOut", required: false } });
  render(<MemoryRouter initialEntries={["/updates"]}><DashboardShell /></MemoryRouter>);
  const text = document.body.textContent ?? "";
  let previous = -1;
  for (const section of ["Overview", "Engines", "Models", "Clients", "Tester", "Monitoring", "Settings", "Logs", "Alerts"]) {
    const next = text.indexOf(section);
    expect(next).toBeGreaterThan(previous);
    previous = next;
  }
  expect(text).toContain("Settings");
});

test("/access redirects to the Clients route", async () => {
  stubStackFetch({ ...boardExtras, "/stack/v1/repairs": { repairs: [] }, "/stack/v1/roles": { roles: [] }, "/stack/v1/operator": { state: "signedOut", required: false }, "/stack/v1/clients": { clients: [] } });
  render(<MemoryRouter initialEntries={["/access"]}><DashboardShell /><RoutePath /></MemoryRouter>);
  await waitFor(() => expect(document.querySelector('[data-testid="route-path"]')?.textContent).toBe("/clients"));
  expect(document.querySelector('a[href="/clients"]')).toBeTruthy();
});

test("the root waits for its plan before choosing the overview instead of mounting the board", async () => {
  globalThis.EventSource = undefined as unknown as typeof EventSource;
  let resolvePlan: ((response: Response) => void) | undefined;
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const path = new URL(typeof input === "string" ? input : input.toString(), "http://local").pathname;
    if (path.endsWith("/setup/plan")) return new Promise<Response>((resolve) => { resolvePlan = resolve; });
    if (path.endsWith("/hardware")) return Promise.resolve(Response.json(hardwareResponse));
    if (path.endsWith("/budget")) return Promise.resolve(Response.json(budgetResponse));
    if (path.endsWith("/storage")) return Promise.resolve(Response.json(storageResponse));
    if (path.endsWith("/roles")) return Promise.resolve(Response.json({ roles: [] }));
    if (path.endsWith("/health")) return Promise.resolve(Response.json({ health: [] }));
    if (path.endsWith("/engines")) return Promise.resolve(Response.json({ engines: [] }));
    if (path.endsWith("/models")) return Promise.resolve(Response.json({ models: [] }));
    if (path.endsWith("/clients")) return Promise.resolve(Response.json({ clients: [] }));
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }));
  }) as unknown as typeof fetch;

  render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  expect(document.querySelector('[data-slot="skeleton"]')).toBeTruthy();
  expect(document.body.textContent).not.toContain("Add abilities");
  expect(document.body.textContent).not.toContain("Start small");
  expect(document.body.textContent).not.toContain("Full plan");

  await waitFor(() => expect(resolvePlan).toBeDefined());
  resolvePlan?.(Response.json({ plan: { tier: "p16", mode: "small", createdAt: "2026-09-18T00:00:00.000Z", health: null }, downloads: [], health: null }));
  await waitFor(() => expect(document.querySelector('[data-widget]')).toBeTruthy());
  expect(document.body.textContent).not.toContain("Add abilities");
});

test("Monitoring renders governor decision sentences", async () => {
  stubStackFetch({ ...boardExtras, "/stack/v1/groups": { groups: [] }, "/stack/v1/budget/decisions": { decisions: [{ at: new Date().toISOString(), decision: "Refused", model: "image", reason: "Memory was tight." }] } });
  render(<MemoryRouter initialEntries={["/monitoring"]}><DashboardShell /></MemoryRouter>);
  await waitFor(() => expect(document.body.textContent).toContain("Refused image: Memory was tight."));
});

test("the collapsed rail keeps every section and carries a tooltip on each button", () => {
  stubStackFetch({ ...boardExtras, "/stack/v1/repairs": { repairs: [] }, "/stack/v1/roles": { roles: [] }, "/stack/v1/operator": { state: "signedOut", required: false } });
  render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  const trigger = document.querySelector('[data-sidebar="trigger"]') ?? document.querySelector("button[aria-label*='sidebar']") ?? document.querySelector("button[aria-label*='menu']");
  if (!trigger) throw new Error("no sidebar trigger found");
  fireEvent.click(trigger);
  const buttons = Array.from(document.querySelectorAll('[data-slot="sidebar-menu-button"]'));
  const sections = ["Overview", "Engines", "Models", "Clients", "Tester", "Monitoring", "Settings", "Logs", "Alerts"];
  const text = document.body.textContent ?? "";
  for (const title of sections) {
    expect(text).toContain(title);
  }
  for (const button of buttons) {
    const link = button.querySelector("a");
    const text = link?.textContent?.trim() ?? "";
    if (sections.includes(text)) {
      expect(button.innerHTML).toContain(text);
    }
  }
});

test("⌘K and / focus the header search, and a result navigates", async () => {
  stubStackFetch({ ...boardExtras, "/stack/v1/repairs": { repairs: [] }, "/stack/v1/roles": { roles: [] }, "/stack/v1/operator": { state: "signedOut", required: false } });
  render(<MemoryRouter initialEntries={["/updates"]}><DashboardShell /></MemoryRouter>);
  const input = await waitFor(() => document.querySelector('header input[placeholder*="Search"]') as HTMLInputElement);
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  expect(document.activeElement).toBe(input);
  input.blur();
  fireEvent.keyDown(window, { key: "/" });
  expect(document.activeElement).toBe(input);
  fireEvent.focus(input);
  fireEvent.click(await waitFor(() => Array.from(document.querySelectorAll('[role="listbox"] button')).find((item) => item.textContent?.trim() === "Models")!));
  await waitFor(() => expect(document.body.textContent).toContain("No models are installed yet"));
});

test("the sidebar footer shows the Stack health and links to alerts", async () => {
  stubStackFetch({ ...boardExtras, "/stack/v1/repairs": { repairs: [] }, "/stack/v1/roles": { roles: [] }, "/stack/v1/operator": { state: "signedOut", required: false } });
  render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  await waitFor(() => expect(document.body.textContent).toContain("All good"));
  const healthLink = document.querySelector('a[href="/alerts"]');
  expect(healthLink).toBeTruthy();
});

test("an open repair turns the sidebar health line amber and counts it", async () => {
  stubStackFetch({
    ...boardExtras,
    "/stack/v1/repairs": { repairs: [{ id: "r1", title: "Rebuild the model index", detail: "The index went stale.", action: "Rebuild", level: "passive", resolvedAt: null }] },
    "/stack/v1/roles": { roles: [] },
    "/stack/v1/operator": { state: "signedOut", required: false },
  });
  render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  await waitFor(() => expect(document.body.textContent).toContain("1 thing needs attention"));
});

test("a stopped engine turns the sidebar health dot red", async () => {
  stubStackFetch({
    ...boardExtras,
    "/stack/v1/repairs": { repairs: [] },
    "/stack/v1/roles": { roles: [{ id: "local-1", wire: "local", residency: "local", description: "A local model", state: "stopped", reason: null }] },
    "/stack/v1/operator": { state: "signedOut", required: false },
  });
  render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  await waitFor(() => expect(document.body.textContent).toContain("All good"));
  const dot = Array.from(document.querySelectorAll('a[href="/alerts"] span[aria-hidden]')).at(-1);
  expect(dot?.className).toContain("bg-red-500");
});

test("the header bell opens the notification popover and shows the unread count", async () => {
  const now = new Date().toISOString();
  stubStackFetch({
    ...boardExtras,
    "/stack/v1/repairs": { repairs: [] },
    "/stack/v1/roles": { roles: [] },
    "/stack/v1/operator": { state: "signedOut", required: false },
    "/stack/v1/notifications": { notifications: [{ id: "n1", title: "The chat engine is stopped.", level: "time_sensitive", at: now, data: "{}", readAt: null, dismissedAt: null }] },
  });
  render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  const trigger = document.querySelector("[data-notifications-trigger]");
  expect(trigger).toBeTruthy();
  await waitFor(() => expect(document.body.textContent).toContain("1"));
  fireEvent.pointerDown(trigger as HTMLElement);
  await waitFor(() => expect(document.body.textContent).toContain("The chat engine is stopped."));
});

test("the header stays fixed while the routed page scrolls", async () => {
  stubStackFetch({ ...boardExtras, "/stack/v1/repairs": { repairs: [] }, "/stack/v1/roles": { roles: [] }, "/stack/v1/operator": { state: "signedOut", required: false } });
  render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  await waitFor(() => expect(document.body.textContent).toContain("All good"));
  const header = document.querySelector("header");
  expect(header).toBeTruthy();
  const inset = header?.parentElement;
  expect(inset).toBeTruthy();
  const scroller = inset?.querySelector(":scope > div.flex-1");
  expect(scroller).toBeTruthy();
  expect(scroller?.contains(header)).toBe(false);
  expect(scroller?.tagName.toLowerCase()).toBe("div");
  expect(scroller?.getAttribute("class") ?? "").toContain("overflow-y-auto");
});

test("the sidebar shows quiet indicators for engines, updates, alerts, and detected models", async () => {
  stubStackFetch({
    ...boardExtras,
    "/stack/v1/repairs": { repairs: [] },
    "/stack/v1/roles": { roles: [] },
    "/stack/v1/operator": { state: "signedOut", required: false },
    "/stack/v1/engines": { engines: [
      { id: "llama-0.4.5-darwin-arm64-b1", label: "Llama", platform: "darwin", arch: "arm64", verified: true, installed: true, matchesThisMachine: true, running: "0.4.5", currentTag: "0.4.5", newestTag: "0.4.5", current: true, notCurrent: false, needsRestart: false, state: "current", stateReason: null },
      { id: "mistral-0.5.0-darwin-arm64-b1", label: "Mistral", platform: "darwin", arch: "arm64", verified: true, installed: true, matchesThisMachine: true, running: "0.5.0", currentTag: "0.5.0", newestTag: "0.5.1", current: false, notCurrent: true, needsRestart: false, state: "notCurrent", stateReason: "newer available" },
    ] },
    "/stack/v1/updates": { app: { available: "1.2.3" }, engines: { available: null }, models: { available: null } },
    "/stack/v1/health": { health: [{ code: "engine-stopped", severity: "critical", title: "Chat engine stopped", text: "The chat engine is stopped.", since: "2026-01-01", cause: "stop" }] },
    "/stack/v1/detected": { detected: [{ id: "d1", name: "Local store", path: "/models", version: "1.0", couldHold: ["chat"], forgotten: false, adopted: false, target: null }] },
  });
  render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  await waitFor(() => expect(document.body.textContent).toContain("1 thing needs attention"));
  const sidebar = document.querySelector('[data-sidebar="content"]');
  expect(sidebar).toBeTruthy();
  // Engines: one not-current + one unadopted detected = 2, badge shows the number
  const enginesLink = document.querySelector('a[href="/engines"]');
  expect(enginesLink?.textContent).toContain("2");
  // Updates badge
  const updatesLink = document.querySelector('a[href="/settings"]');
  expect(updatesLink?.textContent).toContain("1");
  // Alerts: severity dot, no count badge
  const alertsLink = document.querySelector('a[href="/alerts"]');
  expect(alertsLink).toBeTruthy();
  const dot = alertsLink?.querySelector("span[aria-hidden]");
  expect(dot?.className).toContain("bg-red-500");
  expect(alertsLink?.textContent).not.toContain("1");
});

test("the page title appears once, in the header", async () => {
  stubStackFetch({ ...boardExtras, "/stack/v1/repairs": { repairs: [] }, "/stack/v1/roles": { roles: [] }, "/stack/v1/operator": { state: "signedOut", required: false }, "/stack/v1/models": { models: [] } });
  render(<MemoryRouter initialEntries={["/models"]}><DashboardShell /></MemoryRouter>);
  await waitFor(() => expect(document.querySelector("h1")?.textContent).toBe("Models"));
  expect(document.querySelectorAll("h1").length).toBe(1);
  for (const heading of document.querySelectorAll("h2")) expect(heading.textContent).not.toContain("Models");
});

test("the top bar names this computer and offers the appearance control", async () => {
  stubStackFetch({
    ...boardExtras,
    "/stack/v1/repairs": { repairs: [{ id: "r1", title: "Needs attention", detail: "A repair is open.", action: "Review", level: "passive", resolvedAt: null }] },
    "/stack/v1/roles": { roles: [] },
    "/stack/v1/operator": { state: "signedOut", required: false },
  });
  render(<MemoryRouter initialEntries={["/updates"]}><DashboardShell /></MemoryRouter>);
  await waitFor(() => expect(document.querySelector('[data-sidebar="header"] p[title]')?.getAttribute("title")).toBe("1 thing needs attention"));
  expect(document.body.textContent).toContain("This computer");
  await waitFor(() => expect(document.querySelector('header button[aria-label="Use dark appearance"]')).toBeTruthy());
  expect(document.querySelector('header button[aria-label="Use light appearance"]')).toBeTruthy();
  expect(document.querySelector('header button[aria-label="Use system appearance"]')).toBeTruthy();
});

test("the responsive header keeps three phone actions and no text input", async () => {
  stubStackFetch({ ...boardExtras, "/stack/v1/settings": { settings: [] }, "/stack/v1/repairs": { repairs: [] }, "/stack/v1/roles": { roles: [] }, "/stack/v1/operator": { state: "signedOut", required: false } });
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 400 });
  render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  await waitFor(() => expect(document.querySelector('button[aria-label="Ask"]')).toBeTruthy());
  expect(document.querySelector("header input")).toBeNull();
  expect(document.querySelector("[data-notifications-trigger]")).toBeTruthy();
  expect(document.querySelector("[data-profile-trigger]")).toBeTruthy();
  cleanup();
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });
  render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  await waitFor(() => expect(document.querySelector('header input[placeholder*="Search"]')).toBeTruthy());
});

test("the shell pins admin below the common group and exposes resources", async () => {
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 1000 });
  stubStackFetch({ ...boardExtras, "/stack/v1/settings": { settings: [] }, "/stack/v1/repairs": { repairs: [] }, "/stack/v1/roles": { roles: [] }, "/stack/v1/operator": { state: "signedOut", required: false } });
  render(<MemoryRouter initialEntries={["/settings"]}><DashboardShell /></MemoryRouter>);
  await waitFor(() => expect(document.querySelector('[data-nav-mode="pinned"]')).toBeTruthy());
  expect(document.body.textContent).toContain("Memory");
  expect(document.body.textContent).toContain("8.3 GB used of 24 GB · 16 GB budget for models");
  expect(document.body.textContent).toContain("465.7 GB free");
  const nav = document.querySelector('[data-sidebar="content"]')!;
  expect(nav.textContent?.indexOf("Overview")).toBeLessThan(nav.textContent?.indexOf("Settings") ?? 0);
  expect(document.body.textContent).toContain("Updates");
  expect(document.body.textContent).toContain("Backups");
  expect(document.body.textContent).not.toContain("Try it");
  expect(document.body.textContent).not.toContain("Access");
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 560 });
  cleanup();
  render(<MemoryRouter initialEntries={["/settings"]}><DashboardShell /></MemoryRouter>);
  await waitFor(() => expect(document.querySelector('[data-nav-mode="categorized"]')).toBeTruthy());
  expect(document.querySelector('[data-sidebar="content"]')?.textContent).toContain("Manage");
});

test("the search's Pause everything command requires a second click to confirm before posting", async () => {
  let state: "running" | "paused" = "running";
  const calls: string[] = [];
  globalThis.EventSource = undefined as unknown as typeof EventSource;
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://local");
    calls.push(`${url.pathname} ${init?.method ?? "GET"}`);
    if (url.pathname.endsWith("/run-state") && init?.method === "POST") { state = JSON.parse(String(init.body)).state; return Response.json({ state }); }
    if (url.pathname.endsWith("/run-state")) return Response.json({ state });
    const path = url.pathname;
    const body = path.endsWith("/roles") ? { roles: [{ id: "chat", wire: "chat", residency: "resident", description: "Chat", state: "ready", reason: null }] } : path.endsWith("/hardware") ? hardwareResponse : path.endsWith("/budget") ? budgetResponse : path.endsWith("/repairs") ? { repairs: [] } : path.endsWith("/health") ? { health: [] } : path.endsWith("/engines") ? { engines: [] } : path.endsWith("/updates") ? { app: { available: null }, engines: { available: null }, models: { available: null } } : {};
    return Response.json(body);
  }) as unknown as typeof fetch;
  render(<MemoryRouter initialEntries={["/models"]}><DashboardShell /></MemoryRouter>);
  const input = await waitFor(() => document.querySelector('header input[placeholder*="Search"]') as HTMLInputElement);
  fireEvent.focus(input);
  fireEvent.click(await waitFor(() => Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Pause everything")!));
  expect(calls).not.toContain("/stack/v1/run-state POST");
  fireEvent.click(await waitFor(() => Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Click again to confirm pausing everything")!));
  await waitFor(() => expect(calls).toContain("/stack/v1/run-state POST"));
});
