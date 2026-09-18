import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DashboardShell } from "@/pages/DashboardShell";

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

test("Models renders group rollups, routes group actions, renames, and adopts detected stores", async () => {
  const calls: Array<{ path: string; method: string }> = [];
  const groups = [{ id: "group-family", name: "Family chat", parentId: null, modelCount: 1, bytesOnDisk: 1000, memoryBytes: 2000, usage: { requests: 12, tokens: 80 }, status: { loaded: 1, ready: 1, onDemand: 0, failed: 0 }, worstHealth: null }];
  const detected = [{ id: "detected-ollama", kind: "folder", name: "Ollama", version: "0.34", path: "/models", candidateModels: 2, roles: ["chat"] }];
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input); calls.push({ path, method: init?.method ?? "GET" });
    if (path.endsWith("/groups")) return Promise.resolve(Response.json({ groups }));
    if (path.endsWith("/models")) return Promise.resolve(Response.json({ models: [{ id: "qwen", nickname: "Family chat", groupId: "group-family", roles: ["chat"], state: "installed", sizeBytes: 1000, measuredFootprintBytes: 2000, estimated: false, source: "catalog", provenance: { licence: "Apache-2.0" } }] }));
    if (path.endsWith("/detected")) return Promise.resolve(Response.json({ detected }));
    return Promise.resolve(Response.json({ ok: true }));
  }) as unknown as typeof fetch;
  render(<MemoryRouter initialEntries={["/models"]}><DashboardShell /></MemoryRouter>);
  await waitFor(() => expect(document.body.textContent).toContain("12 requests"));
  expect(document.body.textContent).toContain("Scan this computer");
  fireEvent.click([...document.querySelectorAll("p")].find((node) => node.textContent === "Family chat")!.closest("tr")!);
  fireEvent.click(document.querySelector('button[aria-label="Expand Family chat"]')!);
  await waitFor(() => expect(document.querySelector('button[aria-label="Load all"]')).toBeTruthy());
  fireEvent.click(document.querySelector('button[aria-label="Load all"]')!);
  await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.path.includes("/groups/group-family/actions"))).toBe(true));
  const input = document.querySelector('input[aria-label="Nickname qwen"]')!;
  fireEvent.change(input, { target: { value: "Household" } }); fireEvent.blur(input);
  expect(document.querySelector('button[aria-label="More actions"]')).toBeTruthy();
  await waitFor(() => expect(calls.some((call) => call.method === "PATCH" && call.path.includes("/models/qwen"))).toBe(true));
  fireEvent.click(document.querySelector('tr.bg-muted\\/30')!);
  fireEvent.click(document.querySelector('button[aria-label="Adopt"]')!);
  await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.path.includes("/detected/detected-ollama/adopt"))).toBe(true));
});
