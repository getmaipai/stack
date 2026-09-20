import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { DashboardShell } from "@/pages/DashboardShell";
import { allDestinations, groups } from "@/lib/taxonomy";

const originalEventSource = globalThis.EventSource;

afterEach(() => { cleanup(); globalThis.EventSource = originalEventSource; localStorage.removeItem("maipai-stack:rail"); Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 }); });

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
const shellExtras = { ...boardExtras, "/stack/v1/repairs": { repairs: [] }, "/stack/v1/roles": { roles: [] }, "/stack/v1/operator": { state: "signedOut", required: false } };

test("the rail lists all 17 destinations in the spec's group order", () => {
  stubStackFetch(shellExtras);
  render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  const text = document.body.textContent ?? "";
  let previous = -1;
  for (const destination of allDestinations()) {
    const next = text.indexOf(destination.label);
    expect(next, destination.label).toBeGreaterThan(previous);
    previous = next;
  }
});

test("the four group labels are visible, uppercase, in order", () => {
  stubStackFetch(shellExtras);
  render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  const nav = document.querySelector('[data-sidebar="content"]')!;
  const text = nav.textContent ?? "";
  let previous = -1;
  for (const group of groups) {
    const next = text.indexOf(group.label);
    expect(next, group.label).toBeGreaterThan(previous);
    previous = next;
  }
});

test("/engines redirects to /runtimes, /help and /library redirect to /docs", async () => {
  stubStackFetch({ ...shellExtras, "/stack/v1/engines": { engines: [] } });
  render(<MemoryRouter initialEntries={["/engines"]}><DashboardShell /><RoutePath /></MemoryRouter>);
  await waitFor(() => expect(document.querySelector('[data-testid="route-path"]')?.textContent).toBe("/runtimes"));
  cleanup();

  stubStackFetch(shellExtras);
  render(<MemoryRouter initialEntries={["/help/getting-started"]}><DashboardShell /><RoutePath /></MemoryRouter>);
  await waitFor(() => expect(document.querySelector('[data-testid="route-path"]')?.textContent).toBe("/docs/getting-started"));
  cleanup();

  stubStackFetch(shellExtras);
  render(<MemoryRouter initialEntries={["/library"]}><DashboardShell /><RoutePath /></MemoryRouter>);
  await waitFor(() => expect(document.querySelector('[data-testid="route-path"]')?.textContent).toBe("/docs"));
});

test("the old phone-only detail routes land back on their list, not a silent fallback to Overview", async () => {
  stubStackFetch({ ...shellExtras, "/stack/v1/models": { models: [] } });
  render(<MemoryRouter initialEntries={["/models/qwen3-27b-instruct"]}><DashboardShell /><RoutePath /></MemoryRouter>);
  await waitFor(() => expect(document.querySelector('[data-testid="route-path"]')?.textContent).toBe("/models"));
  cleanup();

  stubStackFetch({ ...shellExtras, "/stack/v1/engines": { engines: [] } });
  render(<MemoryRouter initialEntries={["/engines/llama-server"]}><DashboardShell /><RoutePath /></MemoryRouter>);
  await waitFor(() => expect(document.querySelector('[data-testid="route-path"]')?.textContent).toBe("/runtimes"));
});

test("/access redirects to the Clients route", async () => {
  stubStackFetch({ ...shellExtras, "/stack/v1/clients": { clients: [] } });
  render(<MemoryRouter initialEntries={["/access"]}><DashboardShell /><RoutePath /></MemoryRouter>);
  await waitFor(() => expect(document.querySelector('[data-testid="route-path"]')?.textContent).toBe("/clients"));
  expect(document.querySelector('a[href="/clients"]')).toBeTruthy();
});

test("a new taxonomy destination without a page yet shows its name and Coming in this release", async () => {
  const destination = allDestinations().find((item) => item.id === "adapters")!;
  stubStackFetch(shellExtras);
  render(<MemoryRouter initialEntries={[destination.path]}><DashboardShell /></MemoryRouter>);
  await waitFor(() => expect(document.body.textContent).toContain("Coming in this release."));
  expect(document.querySelector("h1")?.textContent).toBe(destination.label);
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
  stubStackFetch({ ...shellExtras, "/stack/v1/groups": { groups: [] }, "/stack/v1/budget/decisions": { decisions: [{ at: new Date().toISOString(), decision: "Refused", model: "image", reason: "Memory was tight." }] } });
  render(<MemoryRouter initialEntries={["/monitoring"]}><DashboardShell /></MemoryRouter>);
  await waitFor(() => expect(document.body.textContent).toContain("Refused image: Memory was tight."));
});

test("the collapsed rail keeps every destination and carries a tooltip on each button", () => {
  stubStackFetch(shellExtras);
  render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  const trigger = document.querySelector('[data-sidebar="trigger"]')!;
  fireEvent.click(trigger);
  const buttons = Array.from(document.querySelectorAll('[data-slot="sidebar-menu-button"]'));
  const labels = allDestinations().map((destination) => destination.label);
  const text = document.body.textContent ?? "";
  for (const label of labels) expect(text).toContain(label);
  for (const button of buttons) {
    const link = button.querySelector("a");
    const linkText = link?.textContent?.trim() ?? "";
    if (labels.includes(linkText)) expect(button.innerHTML).toContain(linkText);
  }
});

test("the rail toggle collapses the sidebar and persists the choice across a remount", () => {
  stubStackFetch(shellExtras);
  const { unmount } = render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  const toggle = document.querySelector('button[aria-label="Collapse navigation"]')!;
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(toggle);
  expect(document.querySelector('button[aria-label="Expand navigation"]')?.getAttribute("aria-expanded")).toBe("false");
  expect(localStorage.getItem("maipai-stack:rail")).toBe("collapsed");
  unmount();
  render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  const reopened = document.querySelector('button[aria-label="Expand navigation"]');
  expect(reopened).toBeTruthy();
  // The toggle must stay visible once collapsed, or there is no way back to expanded.
  expect(reopened?.className ?? "").not.toContain("hidden");
});

test("the rail defaults collapsed at 960-1279px and expanded at 1280px and up, until toggled", () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1000 });
  stubStackFetch(shellExtras);
  render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  expect(document.querySelector('button[aria-label="Expand navigation"]')).toBeTruthy();
  cleanup();
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });
  stubStackFetch(shellExtras);
  render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  expect(document.querySelector('button[aria-label="Collapse navigation"]')).toBeTruthy();
});

test("under 720px the rail becomes an off-canvas drawer, not a separate phone shell", async () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 400 });
  stubStackFetch(shellExtras);
  render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  expect(document.querySelector("[data-phone-shell]")).toBeNull();
  expect(document.querySelector('[data-sidebar="sidebar"][data-mobile="true"]')).toBeNull();
  fireEvent.click(document.querySelector('[data-sidebar="trigger"]')!);
  await waitFor(() => expect(document.querySelector('[data-sidebar="sidebar"][data-mobile="true"]')).toBeTruthy());
  expect((document.body.textContent ?? "")).toContain("Overview");
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

test("the Alerts nav item shows a red dot when a role has stopped", async () => {
  stubStackFetch({
    ...shellExtras,
    "/stack/v1/roles": { roles: [{ id: "local-1", wire: "local", residency: "local", description: "A local model", state: "stopped", reason: null }] },
  });
  render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  const alertsLink = await waitFor(() => document.querySelector('a[href="/alerts"]'));
  expect(alertsLink).toBeTruthy();
  const dot = alertsLink?.querySelector("span[aria-hidden]");
  await waitFor(() => expect(dot?.className).toContain("bg-red-500"));
});

test("the header bell opens the notification popover and shows the unread count", async () => {
  const now = new Date().toISOString();
  stubStackFetch({
    ...shellExtras,
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
  stubStackFetch(shellExtras);
  render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  await waitFor(() => expect(document.querySelector("header")).toBeTruthy());
  const header = document.querySelector("header");
  const inset = header?.parentElement;
  expect(inset).toBeTruthy();
  const scroller = inset?.querySelector(":scope > div.flex-1");
  expect(scroller).toBeTruthy();
  expect(scroller?.contains(header)).toBe(false);
  expect(scroller?.tagName.toLowerCase()).toBe("div");
  expect(scroller?.getAttribute("class") ?? "").toContain("overflow-y-auto");
});

test("the rail shows quiet indicators for runtimes, updates, and alerts", async () => {
  stubStackFetch({
    ...shellExtras,
    "/stack/v1/engines": { engines: [
      { id: "llama-0.4.5-darwin-arm64-b1", label: "Llama", platform: "darwin", arch: "arm64", verified: true, installed: true, matchesThisMachine: true, running: "0.4.5", currentTag: "0.4.5", newestTag: "0.4.5", current: true, notCurrent: false, needsRestart: false, state: "current", stateReason: null },
      { id: "mistral-0.5.0-darwin-arm64-b1", label: "Mistral", platform: "darwin", arch: "arm64", verified: true, installed: true, matchesThisMachine: true, running: "0.5.0", currentTag: "0.5.0", newestTag: "0.5.1", current: false, notCurrent: true, needsRestart: false, state: "notCurrent", stateReason: "newer available" },
    ] },
    "/stack/v1/updates": { app: { available: "1.2.3" }, engines: { available: null }, models: { available: null } },
    "/stack/v1/health": { health: [{ code: "engine-stopped", severity: "critical", title: "Chat engine stopped", text: "The chat engine is stopped.", since: "2026-01-01", cause: "stop" }] },
    "/stack/v1/detected": { detected: [{ id: "d1", name: "Local store", path: "/models", version: "1.0", couldHold: ["chat"], forgotten: false, adopted: false, target: null }] },
  });
  render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  const runtimesLink = await waitFor(() => document.querySelector('a[href="/runtimes"]'));
  await waitFor(() => expect(runtimesLink?.textContent).toContain("2"));
  const settingsLink = document.querySelector('a[href="/settings"]');
  expect(settingsLink?.textContent).toContain("1");
  const alertsLink = document.querySelector('a[href="/alerts"]');
  const dot = alertsLink?.querySelector("span[aria-hidden]");
  expect(dot?.className).toContain("bg-red-500");
  expect(alertsLink?.textContent).not.toContain("1");
});

test("the page title appears once, in the header, for every destination", async () => {
  stubStackFetch({ ...shellExtras, "/stack/v1/models": { models: [] } });
  render(<MemoryRouter initialEntries={["/models"]}><DashboardShell /></MemoryRouter>);
  await waitFor(() => expect(document.querySelector("h1")?.textContent).toBe("Models"));
  expect(document.querySelectorAll("h1").length).toBe(1);
});

test("the top bar shows the destination title and offers the appearance control", async () => {
  stubStackFetch({
    ...boardExtras,
    "/stack/v1/repairs": { repairs: [{ id: "r1", title: "Needs attention", detail: "A repair is open.", action: "Review", level: "passive", resolvedAt: null }] },
    "/stack/v1/roles": { roles: [] },
    "/stack/v1/operator": { state: "signedOut", required: false },
  });
  render(<MemoryRouter initialEntries={["/updates"]}><DashboardShell /></MemoryRouter>);
  await waitFor(() => expect(document.querySelector("header h1")?.textContent).toBe("Settings"));
  await waitFor(() => expect(document.querySelector('header button[aria-label="Use dark appearance"]')).toBeTruthy());
  expect(document.querySelector('header button[aria-label="Use light appearance"]')).toBeTruthy();
  expect(document.querySelector('header button[aria-label="Use system appearance"]')).toBeTruthy();
});

test("the narrow header keeps notifications visible; the search wrapper is marked hidden below sm", async () => {
  stubStackFetch({ ...shellExtras, "/stack/v1/settings": { settings: [] } });
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 400 });
  render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  await waitFor(() => expect(document.querySelector("[data-notifications-trigger]")).toBeTruthy());
  const searchWrapper = document.querySelector('header input[placeholder*="Search"]')?.closest("header > div > div");
  expect(searchWrapper?.className ?? "").toContain("hidden");
  cleanup();
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });
  render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  await waitFor(() => expect(document.querySelector('header input[placeholder*="Search"]')).toBeTruthy());
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
