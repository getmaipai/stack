import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DashboardShell } from "@/pages/DashboardShell";
import { formatSpeedSentence } from "@/pages/OverviewPage";

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; localStorage.removeItem("maipai-overview-range"); });

test("Overview requests the selected series range and renders scripted widgets", async () => {
  const calls: string[] = [];
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const path = String(input); calls.push(path);
    if (path.endsWith("/roles")) return Promise.resolve(Response.json({ roles: [{ id: "chat", state: "ready", description: "Chat", model: null }] }));
    if (path.endsWith("/budget")) return Promise.resolve(Response.json({ capBytes: 128 * 1_073_741_824, freeMemoryBytes: 74 * 1_073_741_824, availablePercent: 58, pressure: "normal", loaded: [], queue: [] }));
    if (path.endsWith("/hardware")) return Promise.resolve(Response.json({ hardware: { platform: "darwin", arch: "arm64", totalRamGb: 128, cpuCount: 16, isAppleSilicon: true, unifiedMemoryGb: 128, cudaDevices: [], freeDiskBytes: 2_400_000_000_000, osVersion: "15.6" }, proposed: null, tiers: [] }));
    if (path.endsWith("/healthz")) return Promise.resolve(Response.json({ ok: true, version: "0.1.0", uptimeSeconds: 90061 }));
    if (path.endsWith("/engines")) return Promise.resolve(Response.json({ engines: [{ id: "engine" }] }));
    if (path.endsWith("/models")) return Promise.resolve(Response.json({ models: [{ id: "model" }] }));
    if (path.endsWith("/clients")) return Promise.resolve(Response.json({ clients: [{ id: "client" }] }));
    if (path.endsWith("/updates")) return Promise.resolve(Response.json({ app: { installed: "0.1.0", available: null }, engines: { installed: "b1", available: null }, models: { installed: "m1", available: null } }));
    if (path.endsWith("/storage")) return Promise.resolve(Response.json({ freeDiskBytes: 2_400_000_000_000, byCategory: { models: 10, engines: 5, logs: 1, backups: 0 } }));
    if (path.endsWith("/check/latest")) return Promise.resolve(Response.json(null));
    if (path.endsWith("/check")) return Promise.resolve(Response.json({ at: new Date().toISOString(), ok: true, results: [{ role: "chat", ok: true, ms: 42, reason: null }], fitTogether: { ok: true, reason: null } }));
    if (path.endsWith("/health")) return Promise.resolve(Response.json({ health: [] }));
    if (path.endsWith("/notifications")) return Promise.resolve(Response.json({ notifications: [] }));
    if (path.endsWith("/speed-test")) return Promise.resolve(Response.json({ result: { at: new Date().toISOString(), ability: "chat", modelId: "qwen3-1.7b", engine: "b10797", firstTokenMs: 180, loadMs: 1420, measuredFootprintBytes: 1_800_000_000, promptTps: 112, tokensPerSecond: 42, contextLength: 4096 } }));
    if (path.includes("/series")) return Promise.resolve(Response.json({ range: path.includes("range=week") ? "week" : "day", usage: [{ at: new Date().toISOString(), requests: 4, tokensIn: 3, tokensOut: 5 }], memory: [{ at: new Date().toISOString(), freeBytes: 74 * 1_073_741_824 }], speed: [{ at: new Date().toISOString(), tokensPerSecond: 42 }] }));
    return Promise.resolve(Response.json({}));
  }) as unknown as typeof fetch;
  render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  await waitFor(() => { expect(document.body.textContent).toContain("Usage"); expect(calls.some((call) => call.includes("/series?range=day"))).toBe(true); });
  expect(document.body.textContent).toContain("This computer");
  expect(document.body.textContent).toContain("macOS 15");
  expect(document.body.textContent).toContain("1d 1h");
  expect(document.body.textContent).toContain("Show more");
  fireEvent.click(document.querySelector('button[aria-label="1W"]')!);
  await waitFor(() => expect(calls.some((call) => call.includes("/series?range=week") && call.includes("window=week"))).toBe(true));
  fireEvent.click(Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Speed test")!);
  await waitFor(() => expect(calls.some((call) => call.endsWith("/speed-test"))).toBe(true));
  fireEvent.click(Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Check my Stack")!);
  await waitFor(() => { expect(calls.some((call) => call.endsWith("/check"))).toBe(true); expect(document.body.textContent).toContain("all good"); });
});

test("Overview changes its grid layout at desktop, tablet, and phone widths", async () => {
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith("/roles")) return Promise.resolve(Response.json({ roles: [{ id: "chat", state: "ready", description: "Chat", model: null }] }));
    if (path.includes("/series")) return Promise.resolve(Response.json({ range: "day", usage: [], memory: [], speed: [] }));
    if (path.endsWith("/budget")) return Promise.resolve(Response.json({ capBytes: 1, freeMemoryBytes: 1, availablePercent: 100, pressure: "normal", loaded: [], queue: [] }));
    if (path.endsWith("/hardware")) return Promise.resolve(Response.json({ hardware: { freeDiskBytes: 1, osVersion: "15.0" } }));
    if (path.endsWith("/healthz")) return Promise.resolve(Response.json({ version: "0.1.0", uptimeSeconds: 0 }));
    if (path.endsWith("/updates")) return Promise.resolve(Response.json({ app: { installed: "0.1.0", available: null } }));
    if (path.endsWith("/storage")) return Promise.resolve(Response.json({ freeDiskBytes: 1, byCategory: { models: 10, engines: 5, logs: 1, backups: 1 } }));
    return Promise.resolve(Response.json({}));
  }) as unknown as typeof fetch;
  for (const [width, expected, column] of [[1440, "desktop", "lg:grid-cols-12"], [1024, "tablet", "sm:grid-cols-1"], [400, "phone", "grid-cols-1"]] as const) {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
    render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
    await waitFor(() => expect(document.querySelector(`[data-layout="${expected}"]`)).toBeTruthy());
    expect(document.querySelector(`[data-layout="${expected}"]`)?.className).toContain(column);
    for (const category of ["models", "engines", "logs", "backups"]) expect(document.body.textContent).toContain(category);
    cleanup();
  }
});

test("speed sentence names the engine build for one and two results", () => {
  const latest = { at: "2026-09-18T00:00:00.000Z", ability: "chat", modelId: "qwen3-1.7b", engine: "b10797", firstTokenMs: null, loadMs: null, measuredFootprintBytes: null, promptTps: 2199, tokensPerSecond: 113, contextLength: 4096 };
  const previous = { ...latest, engine: "b10600", tokensPerSecond: 41 };
  expect(formatSpeedSentence(latest, undefined)).toBe("Your Mac: 113 tokens per second on qwen3-1.7b (b10797).");
  expect(formatSpeedSentence(latest, previous)).toBe("Your Mac: 113 tokens per second on qwen3-1.7b (b10797), was 41 before b10797.");
});
