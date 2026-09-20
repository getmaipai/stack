import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { MachineSelector } from "@/kit/blocks/dashboard/components/machine-selector";

const originalFetch = globalThis.fetch;
const originalLocation = window.location;
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  globalThis.fetch = originalFetch;
  Object.defineProperty(window, "location", { value: originalLocation, writable: true });
});

function stub(responses: Record<string, unknown>): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://local").pathname;
    calls.push(`${path} ${init?.method ?? "GET"}`);
    const known = Object.entries(responses).find(([key]) => path.endsWith(key));
    return new Response(JSON.stringify(known ? known[1] : {}), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls };
}

const okResponses = {
  "/hardware": { hardware: { platform: "darwin", arch: "arm64", totalRamGb: 32, cpuCount: 8, isAppleSilicon: true, unifiedMemoryGb: 32, cudaDevices: [], freeDiskBytes: 1, osVersion: "15.0", computerName: "Jesses-MBP" }, proposed: null, tiers: [] },
  "/health": { health: [] },
};

test("the menu items appear in order: current stack, Lock MaiPai, Settings, Help", async () => {
  stub(okResponses);
  render(<MemoryRouter><MachineSelector /></MemoryRouter>);
  fireEvent.pointerDown(await waitFor(() => screen.getByRole("button", { name: /Jesses-MBP/ })));
  await waitFor(() => expect(screen.getByText("Current stack")).toBeTruthy());
  const menu = screen.getByRole("menu");
  const text = menu.textContent ?? "";
  const order = ["Current stack", "Jesses-MBP", "Lock MaiPai", "Settings", "Help"];
  let previous = -1;
  for (const label of order) {
    const index = text.indexOf(label);
    expect(index, label).toBeGreaterThan(previous);
    previous = index;
  }
  expect(screen.queryByText("Switch stack")).toBeNull();
});

test("no sign-out, avatar, or profile control appears in the menu", async () => {
  stub(okResponses);
  render(<MemoryRouter><MachineSelector /></MemoryRouter>);
  fireEvent.pointerDown(await waitFor(() => screen.getByRole("button", { name: /Jesses-MBP/ })));
  await waitFor(() => expect(screen.getByText("Current stack")).toBeTruthy());
  const menu = screen.getByRole("menu");
  expect(menu.textContent).not.toContain("Sign out");
  expect(menu.textContent).not.toContain("Profile");
});

test("Lock MaiPai posts logout, marks the session locked, and reloads", async () => {
  const { calls } = stub(okResponses);
  const assigned: string[] = [];
  Object.defineProperty(window, "location", { value: { ...originalLocation, assign: (url: string) => assigned.push(url) }, writable: true });
  render(<MemoryRouter><MachineSelector /></MemoryRouter>);
  fireEvent.pointerDown(await waitFor(() => screen.getByRole("button", { name: /Jesses-MBP/ })));
  fireEvent.click(await waitFor(() => screen.getByText("Lock MaiPai")));
  await waitFor(() => expect(calls).toContain("/stack/v1/operator/logout POST"));
  expect(sessionStorage.getItem("maipai-stack:locked")).toBe("1");
  expect(assigned).toContain("/");
});

test("a failed logout still reloads but does not leave a locked marker behind", async () => {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://local").pathname;
    if (path.endsWith("/logout")) return new Response(JSON.stringify({ error: "not signed in" }), { status: 401 });
    const known = Object.entries(okResponses).find(([key]) => path.endsWith(key));
    return new Response(JSON.stringify(known ? known[1] : {}), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const assigned: string[] = [];
  Object.defineProperty(window, "location", { value: { ...originalLocation, assign: (url: string) => assigned.push(url) }, writable: true });
  render(<MemoryRouter><MachineSelector /></MemoryRouter>);
  fireEvent.pointerDown(await waitFor(() => screen.getByRole("button", { name: /Jesses-MBP/ })));
  fireEvent.click(await waitFor(() => screen.getByText("Lock MaiPai")));
  await waitFor(() => expect(assigned).toContain("/"));
  expect(sessionStorage.getItem("maipai-stack:locked")).toBeNull();
});
