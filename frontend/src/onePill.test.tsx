import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DashboardShell } from "@/pages/DashboardShell";

afterEach(() => { cleanup(); document.documentElement.className = ""; localStorage.removeItem("maipai-stack-theme"); });

const roles = [{ id: "chat", wire: "chat", residency: "resident", description: "Chat", state: "ready", reason: null, model: null }];
const hardware = { hardware: { platform: "darwin", arch: "arm64", totalRamGb: 32, cpuCount: 8, isAppleSilicon: true, unifiedMemoryGb: 32, cudaDevices: [], freeDiskBytes: 500_000_000_000, osVersion: "15.0" }, proposed: null, tiers: [] };

function stubShowroom(): void {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://local").pathname;
    const body = path.endsWith("/roles") ? { roles } : path.endsWith("/hardware") ? hardware : path.endsWith("/budget") ? { capBytes: 16_000_000_000, freeMemoryBytes: 8_000_000_000, pressure: "normal", loaded: [], queue: [] } : path.endsWith("/healthz") ? { version: "0.1.0", uptimeSeconds: 60 } : path.endsWith("/repairs") ? { repairs: [] } : path.endsWith("/health") ? { health: [] } : path.endsWith("/notifications") ? { notifications: [] } : path.endsWith("/engines") ? { engines: [] } : path.endsWith("/models") ? { models: [] } : path.endsWith("/clients") ? { clients: [] } : path.endsWith("/detected") ? { detected: [] } : path.endsWith("/updates") ? { app: { installed: "0.1.0", available: null }, engines: { installed: "b1", available: null }, models: { installed: "m1", available: null } } : path.endsWith("/storage") ? { freeDiskBytes: 1, byCategory: { models: 10, engines: 5, logs: 1, backups: 1 } } : path.endsWith("/settings") ? { settings: [] } : path.endsWith("/operator") ? { state: "signedOut", required: false } : path.includes("/series") ? { range: "day", usage: [], memory: [], speed: [] } : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  globalThis.EventSource = undefined as unknown as typeof EventSource;
}

test("every routed showroom screen has at most one visible filled button", async () => {
  for (const path of ["/", "/abilities", "/models", "/engines", "/monitoring", "/alerts", "/updates", "/backups", "/access", "/try", "/settings"]) {
    stubShowroom();
    render(<MemoryRouter initialEntries={[path]}><DashboardShell /></MemoryRouter>);
    const defaults = Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-variant="default"]')).filter((button) => !button.closest('[role="dialog"], [data-testid="property-panel"], [data-slot="sheet-content"]'));
    expect(defaults.length, path).toBeLessThanOrEqual(1);
    cleanup();
  }
});
