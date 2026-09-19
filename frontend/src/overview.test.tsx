import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DashboardShell } from "@/pages/DashboardShell";
import { formatSpeedSentence } from "@/pages/OverviewPage";

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; globalThis.EventSource = originalEventSource; localStorage.removeItem("maipai-overview-range"); });

test("Overview requests the selected series range and renders scripted widgets", async () => {
  const calls: string[] = [];
  let checkDone = false;
  const startedAt = new Date().toISOString();
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const path = String(input); calls.push(path);
    if (path.endsWith("/setup/plan")) return Promise.resolve(Response.json({ plan: { tier: "p16", mode: "small", createdAt: "2026-09-18T00:00:00.000Z", health: null }, downloads: [], health: null }));
    if (path.endsWith("/roles")) return Promise.resolve(Response.json({ roles: [{ id: "chat", state: "ready", description: "Chat", model: null }] }));
    if (path.endsWith("/budget")) return Promise.resolve(Response.json({ capBytes: 128 * 1_073_741_824, freeMemoryBytes: 74 * 1_073_741_824, availablePercent: 58, pressure: "normal", loaded: [], queue: [] }));
    if (path.endsWith("/hardware")) return Promise.resolve(Response.json({ hardware: { platform: "darwin", arch: "arm64", totalRamGb: 128, cpuCount: 16, isAppleSilicon: true, unifiedMemoryGb: 128, cudaDevices: [], freeDiskBytes: 2_400_000_000_000, osVersion: "15.6" }, proposed: null, tiers: [] }));
    if (path.endsWith("/healthz")) return Promise.resolve(Response.json({ ok: true, version: "0.1.0", uptimeSeconds: 90061 }));
    if (path.endsWith("/engines")) return Promise.resolve(Response.json({ engines: [{ id: "engine" }] }));
    if (path.endsWith("/models")) return Promise.resolve(Response.json({ models: [{ id: "model" }] }));
    if (path.endsWith("/clients")) return Promise.resolve(Response.json({ clients: [{ id: "client" }] }));
    if (path.endsWith("/updates")) return Promise.resolve(Response.json({ app: { installed: "0.1.0", available: null }, engines: { installed: "b1", available: null }, models: { installed: "m1", available: null } }));
    if (path.endsWith("/storage")) return Promise.resolve(Response.json({ freeDiskBytes: 2_400_000_000_000, byCategory: { models: 10, engines: 5, logs: 1, backups: 0 } }));
    if (path.endsWith("/check/latest")) return Promise.resolve(checkDone ? Response.json({ at: startedAt, ok: true, results: [{ role: "chat", ok: true, ms: 42, reason: null }], fitTogether: { ok: true, reason: null } }) : Response.json({ state: "running", startedAt }));
    if (path.endsWith("/check")) { checkDone = true; return Promise.resolve(Response.json({ runId: "run-1", state: "running" }, { status: 202 })); }
    if (path.endsWith("/health")) return Promise.resolve(Response.json({ health: [] }));
    if (path.includes("/notifications")) return Promise.resolve(Response.json({ notifications: [{ id: "n1", title: "Model installed", level: "passive", at: "2026-09-18T00:00:00.000Z", data: "{}", readAt: null, dismissedAt: null }] }));
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
  expect(document.querySelector('time[dateTime="2026-09-18T00:00:00.000Z"]')).toBeTruthy();
  fireEvent.click(document.querySelector('button[aria-label="1W"]')!);
  await waitFor(() => expect(calls.some((call) => call.includes("/series?range=week") && call.includes("window=week"))).toBe(true));
  fireEvent.click(Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Speed test")!);
  await waitFor(() => expect(calls.some((call) => call.endsWith("/speed-test"))).toBe(true));
  fireEvent.click(Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Check my Stack")!);
  await waitFor(() => { expect(calls.some((call) => call.endsWith("/check"))).toBe(true); expect(document.body.textContent).toContain("Checking your Stack..."); });
  await waitFor(() => expect(document.body.textContent).toContain("all good"));
});

test("Overview changes its grid layout at desktop, tablet, and phone widths", async () => {
  const originalWidth = window.innerWidth;
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith("/setup/plan")) return Promise.resolve(Response.json({ plan: { tier: "p16", mode: "small", createdAt: "2026-09-18T00:00:00.000Z", health: null }, downloads: [], health: null }));
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
    if (expected !== "phone") for (const category of ["models", "engines", "logs", "backups"]) expect(document.body.textContent).toContain(category);
    cleanup();
  }
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: originalWidth });
});

test("speed sentence names the engine build for one and two results", () => {
  const latest = { at: "2026-09-18T00:00:00.000Z", ability: "chat", modelId: "qwen3-1.7b", engine: "b10797", firstTokenMs: null, loadMs: null, measuredFootprintBytes: null, promptTps: 2199, tokensPerSecond: 113, contextLength: 4096 };
  const previous = { ...latest, engine: "b10600", tokensPerSecond: 41 };
  expect(formatSpeedSentence(latest, undefined)).toBe("Your Mac: 113 tokens per second on qwen3-1.7b (b10797).");
  expect(formatSpeedSentence(latest, previous)).toBe("Your Mac: 113 tokens per second on qwen3-1.7b (b10797), was 41 before b10797.");
});

test("Live renders every GPU, preserves unknown measurements, and lists connected clients", async () => {
  const originalWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });
  class LiveEventSource { static instances: LiveEventSource[] = []; onmessage: ((event: MessageEvent) => void) | null = null; constructor(_url: string) { LiveEventSource.instances.push(this); } close() {} }
  globalThis.EventSource = LiveEventSource as unknown as typeof EventSource;
  let liveRequests = 0;
  const drives = [{ name: "Macintosh HD", mount: "/", totalBytes: 1_000_000_000_000, usedBytes: 600_000_000_000, mounted: true }, { name: "Models", mount: "/Volumes/Models", totalBytes: 2_000_000_000_000, usedBytes: 400_000_000_000, mounted: true }, { name: "Archive", mount: "/Volumes/Archive", totalBytes: 3_000_000_000_000, usedBytes: 0, mounted: false }];
  const live = { sampledAt: new Date().toISOString(), engines: [{ id: "llama", engine: "llama-server", build: "b11026", model: "qwen3-27b", port: 8080, footprintBytes: 21_600_000_000, cpuPercent: 42, startedAt: new Date(Date.now() - 3_600_000).toISOString() }], gpus: [{ name: "NVIDIA RTX 5090", memoryUsedBytes: 12_000_000_000, memoryTotalBytes: 32_000_000_000, utilizationPercent: 73 }, { name: "NVIDIA RTX 4000", memoryUsedBytes: null, memoryTotalBytes: null, utilizationPercent: null }], drives, computer: { cpuPercent: 31, diskUsedBytes: 600_000_000_000, diskTotalBytes: 1_000_000_000_000 }, clients: [{ id: "cli", name: "atlas", roles: ["chat", "coding"], requests: 12, lastRequestAt: new Date(Date.now() - 120_000).toISOString(), inFlight: 1 }] };
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith("/setup/plan")) return Promise.resolve(Response.json({ plan: { tier: "p16", mode: "small", createdAt: "2026-09-18T00:00:00.000Z", health: null }, downloads: [], health: null }));
    if (path.endsWith("/live")) { liveRequests += 1; return Promise.resolve(Response.json(live)); }
    if (path.endsWith("/roles")) return Promise.resolve(Response.json({ roles: [] }));
    if (path.endsWith("/budget")) return Promise.resolve(Response.json({ capBytes: 1, freeMemoryBytes: 1, availablePercent: 100, pressure: "normal", loaded: [], queue: [] }));
    if (path.endsWith("/hardware")) return Promise.resolve(Response.json({ hardware: { freeDiskBytes: 1, osVersion: "15.0", drives } }));
    if (path.endsWith("/healthz")) return Promise.resolve(Response.json({ version: "0.1.0", uptimeSeconds: 0 }));
    if (path.endsWith("/updates")) return Promise.resolve(Response.json({ app: { installed: "0.1.0", available: null } }));
    if (path.endsWith("/storage")) return Promise.resolve(Response.json({ freeDiskBytes: 1, byCategory: {} }));
    if (path.includes("/series")) return Promise.resolve(Response.json({ range: "day", usage: [], memory: [], speed: [] }));
    return Promise.resolve(Response.json({ notifications: [], health: [], engines: [], models: [], clients: [] }));
  }) as unknown as typeof fetch;
  render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  await waitFor(() => expect(document.body.textContent).toContain("NVIDIA RTX 5090"));
  expect(document.body.textContent).toContain("NVIDIA RTX 4000");
  expect(document.body.textContent).toContain("not measured");
  expect(document.body.textContent).toContain("atlas");
  expect(document.body.textContent).toContain("12 requests");
  expect(document.body.textContent).toContain("Macintosh HD");
  expect(document.body.textContent).toContain("Models");
  expect(document.body.textContent).toContain("Archive");
  expect(document.body.textContent).toContain("not mounted");
  expect(liveRequests).toBe(1);
  await act(async () => { LiveEventSource.instances.at(-1)?.onmessage?.({ data: JSON.stringify({ id: "live", data: { ...live, engines: [] } }) } as MessageEvent); });
  await waitFor(() => expect(document.body.textContent).toContain("No engine is running"));
  expect(liveRequests).toBe(1);
  cleanup();
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 400 });
  render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  await waitFor(() => expect(document.querySelector("[data-phone-shell] [data-live-section]")).toBeTruthy());
  expect(document.body.textContent).toContain("NVIDIA RTX 5090");
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: originalWidth });
});
