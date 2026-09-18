import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "@/App";
import { BoardPage } from "@/pages/BoardPage";

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const hardware = { platform: "darwin", arch: "arm64", totalRamGb: 24, cpuCount: 10, isAppleSilicon: true, unifiedMemoryGb: 24, cudaDevices: [], freeDiskBytes: 153 * 1_073_741_824, osVersion: "24.6.0" };
const tier = { id: "p16" as const, label: "This computer can run chat and voice.", minUnifiedGb: 16, minVramGb: 8, resident: ["chat", "stt", "tts"], onDemand: [], installedOnly: [], notAvailable: ["image", "video", "music"] };
const roles = [{ id: "chat", wire: "chat", residency: "resident", description: "Talk locally.", state: "ready", reason: null }, { id: "stt", wire: "transcription", residency: "resident", description: "Listen locally.", state: "ready", reason: null }, { id: "tts", wire: "speech", residency: "resident", description: "Speak locally.", state: "ready", reason: null }, { id: "image", wire: "job", residency: "jit", description: "Make pictures.", state: "notInstalled", reason: null }];

function responseFor(input: RequestInfo | URL): Response {
  const path = String(input);
  if (path.endsWith("/operator")) return Response.json({ state: "setupRequired", required: false });
  if (path.endsWith("/hardware")) return Response.json({ hardware, proposed: tier, tiers: [tier] });
  if (path.endsWith("/roles")) return Response.json({ roles });
  if (path.endsWith("/budget")) return Response.json({ capBytes: 24 * 1_073_741_824, freeMemoryBytes: 12 * 1_073_741_824, pressure: false, loaded: [], queue: [] });
  if (path.endsWith("/notifications")) return Response.json({ notifications: [] });
  if (path.endsWith("/repairs")) return Response.json({ repairs: [] });
  if (path.endsWith("/health")) return Response.json({ health: [] });
  if (path.endsWith("/setup/plan")) return Response.json({ plan: null, downloads: [], health: null });
  throw new Error("unstubbed fetch: " + path);
}

afterEach(() => { cleanup(); globalThis.fetch = originalFetch; globalThis.EventSource = originalEventSource; localStorage.clear(); });

test("a fresh install opens on the board with plain hardware and Add abilities", async () => {
  globalThis.EventSource = undefined as unknown as typeof EventSource;
  globalThis.fetch = mock((input: RequestInfo | URL) => Promise.resolve(responseFor(input))) as unknown as typeof fetch;
  render(<MemoryRouter><BoardPage /></MemoryRouter>);
  await waitFor(() => { expect(document.body.textContent).toContain("Apple silicon Mac, 24 GB of memory, 153 GB free"); expect(document.body.textContent).toContain("Add abilities"); expect(document.body.textContent).toContain("Start small"); });
});

test("the gate keeps a fresh install on the board without a login", async () => {
  globalThis.EventSource = undefined as unknown as typeof EventSource;
  globalThis.fetch = mock((input: RequestInfo | URL) => Promise.resolve(responseFor(input))) as unknown as typeof fetch;
  render(<MemoryRouter initialEntries={["/"]}><App /></MemoryRouter>);
  await waitFor(() => expect(document.body.textContent).toContain("Your local AI board"));
  expect(document.body.textContent).not.toContain("Welcome back");
});

test("the sizer's Install button calls the setup plan route", async () => {
  globalThis.EventSource = undefined as unknown as typeof EventSource;
  const calls: string[] = [];
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => { calls.push(String(input) + " " + (init?.method ?? "GET")); if (init?.method === "POST") return Promise.resolve(Response.json({ queued: true, plan: { tier: "p16", mode: "small", createdAt: new Date().toISOString(), health: null }, downloads: [], health: null }, { status: 202 })); return Promise.resolve(responseFor(input)); }) as unknown as typeof fetch;
  render(<MemoryRouter><BoardPage /></MemoryRouter>);
  await waitFor(() => expect(document.body.textContent).toContain("Install"));
  const install = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Install");
  expect(install).toBeDefined();
  fireEvent.click(install!);
  await waitFor(() => expect(calls.some((call) => call.includes("/stack/v1/setup/plan POST"))).toBe(true));
});

test("the board renders health items with one action each", async () => {
  globalThis.EventSource = undefined as unknown as typeof EventSource;
  globalThis.fetch = mock((input: RequestInfo | URL) => String(input).endsWith("/health")
    ? Promise.resolve(Response.json({ health: [
      { code: "engine.crashed", severity: "error", title: "Engine crashed", text: "The engine stopped.", since: new Date().toISOString(), cause: "exit", fix: { label: "Restart engine", action: "restart_engine" } },
      { code: "disk-under-reserve", severity: "warning", title: "Disk space is low", text: "Free space is below the reserve.", since: new Date().toISOString(), cause: "disk", learnMore: "https://example.test/storage" },
    ] }))
    : Promise.resolve(responseFor(input))) as unknown as typeof fetch;
  render(<MemoryRouter><BoardPage /></MemoryRouter>);
  await waitFor(() => { expect(document.body.textContent).toContain("Engine crashed"); expect(document.body.textContent).toContain("Disk space is low"); expect(document.body.textContent).toContain("Restart engine"); expect(document.body.textContent).toContain("Learn more"); });
});
