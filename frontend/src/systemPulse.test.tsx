import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SystemPulse } from "@/kit/blocks/dashboard/components/system-pulse";
import { SidebarProvider } from "@/kit/ui/sidebar";

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

function stub(responses: Record<string, unknown>): void {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://local").pathname;
    const known = Object.entries(responses).find(([key]) => path.endsWith(key));
    return new Response(JSON.stringify(known ? known[1] : {}), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const okResponses = {
  "/health": { health: [] },
  "/budget": { totalMemoryBytes: 32_000_000_000, capBytes: 16_000_000_000, freeMemoryBytes: 24_000_000_000, availablePercent: 75, pressure: "normal", loaded: [], queue: [] },
  "/storage": { totalBytes: 1_000_000_000_000, freeDiskBytes: 500_000_000_000 },
  "/live": { live: { gpus: [{ name: "Apple M4", utilization: 12 }] } },
  "/hardware": { hardware: { platform: "darwin", arch: "arm64", totalRamGb: 32, cpuCount: 8, isAppleSilicon: true, unifiedMemoryGb: 32, cudaDevices: [], freeDiskBytes: 1, osVersion: "15.0" }, proposed: null, tiers: [] },
  "/network": { interface: "en0", linkMbps: 1000, gatewayMs: 12, measuredAt: new Date().toISOString() },
};

test("all five signals render in order with an accessible name each", async () => {
  stub(okResponses);
  render(<MemoryRouter><SidebarProvider><SystemPulse /></SidebarProvider></MemoryRouter>);
  await waitFor(() => expect(screen.getAllByRole("link")).toHaveLength(5));
  const labels = screen.getAllByRole("link").map((link) => link.getAttribute("aria-label"));
  expect(labels).toEqual(["Stack health", "Memory", "Storage", "GPU", "Network"]);
});

test("a healthy Stack shows no badge and a green health dot", async () => {
  stub(okResponses);
  render(<MemoryRouter><SidebarProvider><SystemPulse /></SidebarProvider></MemoryRouter>);
  await waitFor(() => expect(screen.getByLabelText("Stack health").querySelector(".bg-\\[var\\(--hue-teal\\)\\]")).toBeTruthy());
  expect(screen.queryByText("2")).toBeNull();
});

test("two error-level health items turn the dot red and badge the count", async () => {
  stub({ ...okResponses, "/health": { health: [{ code: "a", severity: "error", title: "A", text: "a", since: "", cause: "" }, { code: "b", severity: "critical", title: "B", text: "b", since: "", cause: "" }] } });
  render(<MemoryRouter><SidebarProvider><SystemPulse /></SidebarProvider></MemoryRouter>);
  await waitFor(() => expect(screen.getByText("2")).toBeTruthy());
  expect(screen.getByLabelText("Stack health").querySelector(".bg-\\[var\\(--hue-red\\)\\]")).toBeTruthy();
});

test("memory pressure critical turns the memory dot red", async () => {
  stub({ ...okResponses, "/budget": { ...okResponses["/budget"], pressure: "critical" } });
  render(<MemoryRouter><SidebarProvider><SystemPulse /></SidebarProvider></MemoryRouter>);
  await waitFor(() => expect(screen.getByLabelText("Memory").querySelector(".bg-\\[var\\(--hue-red\\)\\]")).toBeTruthy());
});

test("storage under 5% free turns the storage dot red, under 15% amber", async () => {
  stub({ ...okResponses, "/storage": { totalBytes: 100, freeDiskBytes: 3 } });
  render(<MemoryRouter><SidebarProvider><SystemPulse /></SidebarProvider></MemoryRouter>);
  await waitFor(() => expect(screen.getByLabelText("Storage").querySelector(".bg-\\[var\\(--hue-red\\)\\]")).toBeTruthy());
  cleanup();
  stub({ ...okResponses, "/storage": { totalBytes: 100, freeDiskBytes: 10 } });
  render(<MemoryRouter><SidebarProvider><SystemPulse /></SidebarProvider></MemoryRouter>);
  await waitFor(() => expect(screen.getByLabelText("Storage").querySelector(".bg-\\[var\\(--hue-orange\\)\\]")).toBeTruthy());
});

test("zero GPUs and no Apple silicon leaves the GPU signal muted with no badge", async () => {
  stub({ ...okResponses, "/live": { live: { gpus: [] } }, "/hardware": { hardware: { platform: "linux", arch: "x86_64", totalRamGb: 32, cpuCount: 8, isAppleSilicon: false, unifiedMemoryGb: 0, cudaDevices: [], freeDiskBytes: 1, osVersion: "" }, proposed: null, tiers: [] } });
  render(<MemoryRouter><SidebarProvider><SystemPulse /></SidebarProvider></MemoryRouter>);
  await waitFor(() => expect(screen.getByLabelText("GPU").querySelector(".bg-muted-foreground\\/50")).toBeTruthy());
});

test("two detected GPUs badge the count in blue", async () => {
  stub({ ...okResponses, "/live": { live: { gpus: [{ name: "GPU 0", utilization: 10 }, { name: "GPU 1", utilization: 20 }] } } });
  render(<MemoryRouter><SidebarProvider><SystemPulse /></SidebarProvider></MemoryRouter>);
  await waitFor(() => expect(screen.getByLabelText("GPU").textContent).toContain("2"));
});

test("network with no default route is muted; a non-answering gateway is red; a slow one is amber", async () => {
  stub({ ...okResponses, "/network": { interface: null, linkMbps: null, gatewayMs: null, measuredAt: new Date().toISOString() } });
  render(<MemoryRouter><SidebarProvider><SystemPulse /></SidebarProvider></MemoryRouter>);
  await waitFor(() => expect(screen.getByLabelText("Network").querySelector(".bg-muted-foreground\\/50")).toBeTruthy());
  cleanup();
  stub({ ...okResponses, "/network": { interface: "en0", linkMbps: null, gatewayMs: null, measuredAt: new Date().toISOString() } });
  render(<MemoryRouter><SidebarProvider><SystemPulse /></SidebarProvider></MemoryRouter>);
  await waitFor(() => expect(screen.getByLabelText("Network").querySelector(".bg-\\[var\\(--hue-red\\)\\]")).toBeTruthy());
  cleanup();
  stub({ ...okResponses, "/network": { interface: "en0", linkMbps: 100, gatewayMs: 80, measuredAt: new Date().toISOString() } });
  render(<MemoryRouter><SidebarProvider><SystemPulse /></SidebarProvider></MemoryRouter>);
  await waitFor(() => expect(screen.getByLabelText("Network").querySelector(".bg-\\[var\\(--hue-orange\\)\\]")).toBeTruthy());
});

test("Apple Silicon with zero GPUs reported still shows one, not muted", async () => {
  stub({ ...okResponses, "/live": { live: { gpus: [] } } });
  render(<MemoryRouter><SidebarProvider><SystemPulse /></SidebarProvider></MemoryRouter>);
  await waitFor(() => expect(screen.getByLabelText("GPU").querySelector(".bg-\\[var\\(--hue-teal\\)\\]")).toBeTruthy());
  expect(screen.getByLabelText("GPU").textContent).toContain("1");
});

test("each signal links to its target", async () => {
  stub(okResponses);
  render(<MemoryRouter><SidebarProvider><SystemPulse /></SidebarProvider></MemoryRouter>);
  await waitFor(() => expect(screen.getByLabelText("Stack health").getAttribute("href")).toBe("/alerts?severity=error"));
  expect(screen.getByLabelText("Memory").getAttribute("href")).toBe("/monitoring");
  expect(screen.getByLabelText("Storage").getAttribute("href")).toBe("/monitoring");
  expect(screen.getByLabelText("GPU").getAttribute("href")).toBe("/monitoring");
  expect(screen.getByLabelText("Network").getAttribute("href")).toBe("/monitoring");
});
