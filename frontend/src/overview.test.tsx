import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DashboardShell } from "@/pages/DashboardShell";

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

test("Overview requests the selected series range and renders scripted widgets", async () => {
  const calls: string[] = [];
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const path = String(input); calls.push(path);
    if (path.endsWith("/roles")) return Promise.resolve(Response.json({ roles: [{ id: "chat", state: "ready", description: "Chat", model: null }] }));
    if (path.endsWith("/budget")) return Promise.resolve(Response.json({ capBytes: 128 * 1_073_741_824, freeMemoryBytes: 74 * 1_073_741_824, availablePercent: 58, pressure: "normal", loaded: [], queue: [] }));
    if (path.endsWith("/health")) return Promise.resolve(Response.json({ health: [] }));
    if (path.endsWith("/notifications")) return Promise.resolve(Response.json({ notifications: [] }));
    if (path.includes("/series")) return Promise.resolve(Response.json({ range: path.includes("range=week") ? "week" : "day", usage: [{ at: new Date().toISOString(), requests: 4, tokensIn: 3, tokensOut: 5 }], memory: [{ at: new Date().toISOString(), freeBytes: 74 * 1_073_741_824 }], speed: [{ at: new Date().toISOString(), tokensPerSecond: 42 }] }));
    return Promise.resolve(Response.json({}));
  }) as unknown as typeof fetch;
  render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  await waitFor(() => { expect(document.body.textContent).toContain("Usage"); expect(calls.some((call) => call.includes("/series?range=day"))).toBe(true); });
  expect(document.body.textContent).toContain("This computer");
  fireEvent.click(document.querySelector('button[aria-label="Time range"]')!);
  fireEvent.click(Array.from(document.querySelectorAll("[role=option]")).find((option) => option.textContent === "Last week")!);
  await waitFor(() => expect(calls.some((call) => call.includes("/series?range=week"))).toBe(true));
});
