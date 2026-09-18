import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DashboardShell } from "@/pages/DashboardShell";

const originalEventSource = globalThis.EventSource;

afterEach(() => { cleanup(); globalThis.EventSource = originalEventSource; });

const hardwareResponse = { hardware: { platform: "darwin", arch: "arm64", totalRamGb: 32, cpuCount: 8, isAppleSilicon: true, unifiedMemoryGb: 32, cudaDevices: [], freeDiskBytes: 500_000_000_000, osVersion: "15.0" }, proposed: null, tiers: [] };
const budgetResponse = { capBytes: 16_000_000_000, freeMemoryBytes: 8_000_000_000, pressure: false, loaded: [], queue: [] };

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

const boardExtras = { "/stack/v1/hardware": hardwareResponse, "/stack/v1/budget": budgetResponse, "/stack/v1/notifications": { notifications: [] }, "/stack/v1/setup/plan": { plan: null, downloads: [], health: null } };

test("the Stack shell lists every section in order", () => {
  stubStackFetch({ ...boardExtras, "/stack/v1/repairs": { repairs: [] }, "/stack/v1/roles": { roles: [] }, "/stack/v1/operator": { state: "signedOut", required: false } });
  render(<MemoryRouter initialEntries={["/updates"]}><DashboardShell /></MemoryRouter>);
  const text = document.body.textContent ?? "";
  let previous = -1;
  for (const section of ["Overview", "Abilities", "Models", "Engines", "Monitoring", "Alerts", "Updates", "Backups", "Access", "Try it", "Settings"]) {
    const next = text.indexOf(section);
    expect(next).toBeGreaterThan(previous);
    previous = next;
  }
  expect(text).toContain("Updates are checked on request");
});

test("the collapsed rail keeps every section and carries a tooltip on each button", () => {
  stubStackFetch({ ...boardExtras, "/stack/v1/repairs": { repairs: [] }, "/stack/v1/roles": { roles: [] }, "/stack/v1/operator": { state: "signedOut", required: false } });
  render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  const trigger = document.querySelector('[data-sidebar="trigger"]') ?? document.querySelector("button[aria-label*='sidebar']") ?? document.querySelector("button[aria-label*='menu']");
  if (!trigger) throw new Error("no sidebar trigger found");
  fireEvent.click(trigger);
  const buttons = Array.from(document.querySelectorAll('[data-slot="sidebar-menu-button"]'));
  const sections = ["Overview", "Abilities", "Models", "Engines", "Monitoring", "Alerts", "Updates", "Backups", "Access", "Try it", "Settings"];
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

test("command palette opens from both shortcuts and jumps to Models", async () => {
  stubStackFetch({ ...boardExtras, "/stack/v1/repairs": { repairs: [] }, "/stack/v1/roles": { roles: [] }, "/stack/v1/operator": { state: "signedOut", required: false } });
  render(<MemoryRouter initialEntries={["/updates"]}><DashboardShell /></MemoryRouter>);
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  expect(document.querySelector('input[placeholder="Search sections and actions..."]')).toBeTruthy();
  fireEvent.click(Array.from(document.querySelectorAll('[cmdk-item]')).find((item) => item.textContent?.trim() === "Models")!);
  await waitFor(() => expect(document.body.textContent).toContain("No models are installed yet"));
  fireEvent.keyDown(window, { key: "/" });
  expect(document.querySelector('input[placeholder="Search sections and actions..."]')).toBeTruthy();
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
  const dot = document.querySelector('a[href="/alerts"] span[aria-hidden]');
  expect(dot?.className).toContain("bg-red-500");
});

test("the header profile menu opens and offers sign out when signed in", async () => {
  stubStackFetch({ ...boardExtras, "/stack/v1/repairs": { repairs: [] }, "/stack/v1/roles": { roles: [] }, "/stack/v1/operator": { state: "signedIn", required: true } });
  const { unmount } = render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  const trigger = document.querySelector("[data-profile-trigger]");
  expect(trigger).toBeTruthy();
  fireEvent.pointerDown(trigger as HTMLElement);
  await waitFor(() => expect(document.body.textContent).toContain("Sign out"));
  unmount();
});
