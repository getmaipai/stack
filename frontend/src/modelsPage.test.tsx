import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DashboardShell } from "@/pages/DashboardShell";

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
beforeEach(() => { Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 }); });
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; globalThis.EventSource = originalEventSource; });

const group = { id: "group-family", name: "Family chat" };
const model = { id: "qwen3-27b-instruct", nickname: null, groupId: "group-family", roles: ["chat"], state: "installed", runtimeState: "ready", sizeBytes: 16_000_000_000, fileMissing: false, measuredFootprintBytes: 15_500_000_000, estimated: false, source: "catalog", licenceSentence: "Apache-2.0 licensed.", licenceFlag: "clear", licenceUrl: null, provenance: {}, modelPath: "/data/models/qwen3-27b.gguf", usage: { modelId: "qwen3-27b-instruct", requests: 42, tokensIn: 1000, tokensOut: 2000, secondsLoaded: 3600, peakMemoryBytes: 15_600_000_000, lastUsedAt: new Date().toISOString() } };
const detectedStore = { id: "detected-ollama", kind: "folder", name: "Ollama", version: "0.34", where: "/usr/local/ollama", couldHold: ["chat"], firstSeen: "2026-01-01", lastSeen: "2026-01-01", forgotten: false, adopted: false, target: null, state: "ready" };
const role = { id: "chat", label: "Chat", wire: "chat", residency: "resident", endpoints: ["/v1/chat/completions"], quality: ["fast", "everyday", "best"], description: "General chat", state: { state: "ready" as const, since: new Date().toISOString(), checkedAt: new Date().toISOString() }, reason: null };
const hubEntry = { id: "qwen/qwen3-4b-instruct", name: "Qwen3 4B Instruct", kind: "model" as const, roles: ["unknown"], licence: null, licenceSentence: "Licence not recorded.", licenceFlag: "unknown", licenceUrl: null, sizeBytes: null, source: "Hugging Face", revision: null, url: null, sha256: null, repo: "qwen/qwen3-4b-instruct", files: [] };
const resolvedHubEntry = { ...hubEntry, roles: ["chat"], licence: "Apache-2.0", licenceFlag: "clear", sizeBytes: 4_000_000_000, revision: "main", url: "https://hf.example/model.gguf", sha256: "b".repeat(64), files: [{ name: "model.gguf", sizeBytes: 4_000_000_000, sha256: "b".repeat(64), url: "https://hf.example/model.gguf" }] };

function openMenu(trigger: Element): void {
  fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 });
  fireEvent.pointerUp(trigger, { button: 0, pointerId: 1 });
  fireEvent.click(trigger);
}

function mockFetch(calls: Array<{ path: string; method: string; body?: unknown }>) {
  globalThis.EventSource = undefined as unknown as typeof EventSource;
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path.endsWith("/groups")) return Promise.resolve(Response.json({ groups: [group] }));
    if (path.endsWith("/roles")) return Promise.resolve(Response.json({ roles: [role] }));
    if (path.endsWith("/models")) return Promise.resolve(Response.json({ models: [model] }));
    if (path.endsWith("/detected")) return Promise.resolve(Response.json({ detected: [detectedStore] }));
    if (path.startsWith("/stack/v1/catalog/search?kind=model")) return Promise.resolve(Response.json({ results: [] }));
    if (path.startsWith("/stack/v1/catalog/search?kind=huggingface")) return Promise.resolve(Response.json({ enabled: true, results: [hubEntry] }));
    if (path.includes("/catalog/huggingface/resolve")) return Promise.resolve(Response.json({ result: resolvedHubEntry }));
    if (path.endsWith("/updates")) return Promise.resolve(Response.json({ app: { installed: "0.1.0", available: null }, engines: { installed: "0.1.0", available: null }, models: { installed: "1", available: "2" }, recommendations: [{ id: "phi-4-mini", role: "chat", profile: "p32", quality: 0.8, revision: "main", download: { url: "https://example.com/phi.gguf", sha256: "c".repeat(64) }, sentence: "A small, capable chat model." }] }));
    if (path.endsWith("/speed-test")) return Promise.resolve(Response.json({ result: { tokensPerSecond: 28 } }));
    return Promise.resolve(Response.json({ ok: true }));
  }) as unknown as typeof fetch;
}

test("Installed models list a real model and a detected store, opens the pane, loads the model, and adopts detection", async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  mockFetch(calls);
  render(<MemoryRouter initialEntries={["/models"]}><DashboardShell /></MemoryRouter>);

  await waitFor(() => expect(document.body.textContent).toContain("Qwen3 27B Instruct"));
  expect(document.body.textContent).toContain("Family chat");
  expect(document.body.textContent).toContain("Ollama");
  expect(document.body.textContent).toContain("Not reported");
  expect([...document.querySelectorAll("button")].some((button) => button.textContent === "LLM (1)")).toBe(true);

  const filterInput = document.querySelector<HTMLInputElement>('input[aria-label="Filter"]')!;
  fireEvent.change(filterInput, { target: { value: "no such model" } });
  await waitFor(() => expect(document.body.textContent).toContain("No models match this filter."));
  fireEvent.change(filterInput, { target: { value: "" } });
  await waitFor(() => expect(document.body.textContent).toContain("Qwen3 27B Instruct"));

  fireEvent.click([...document.querySelectorAll("p")].find((node) => node.textContent === "Qwen3 27B Instruct")!.closest("tr")!);
  await waitFor(() => expect(document.querySelector('button[aria-label="Close"]')).toBeTruthy());
  expect(document.body.textContent).toContain("Apache-2.0 licensed.");
  for (const tab of ["Settings", "Usage", "Files", "Logs"]) expect([...document.querySelectorAll('[role="tab"]')].some((node) => node.textContent === tab)).toBe(true);

  fireEvent.click([...document.querySelectorAll("button")].find((button) => button.textContent === "Load")!);
  await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.path.includes("/models/qwen3-27b-instruct/actions") && (call.body as { action: string })?.action === "load")).toBe(true));

  fireEvent.click([...document.querySelectorAll("button")].find((button) => button.textContent === "Test")!);
  await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.path.endsWith("/speed-test"))).toBe(true));

  openMenu(document.querySelector('button[aria-label="More actions"]')!);
  const adoptButton = await waitFor(() => { const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === "Adopt"); expect(button).toBeTruthy(); return button!; });
  fireEvent.click(adoptButton);
  await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.path.includes("/detected/detected-ollama/adopt") && (call.body as { roles: string[] })?.roles?.[0] === "chat")).toBe(true));
});

test("Browse resolves an unresolved Hugging Face entry before it can be installed", async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  mockFetch(calls);
  render(<MemoryRouter initialEntries={["/models?mode=browse&q=qwen"]}><DashboardShell /></MemoryRouter>);
  await waitFor(() => expect(document.body.textContent).toContain("Qwen3 4B Instruct"));

  fireEvent.click([...document.querySelectorAll("button")].find((button) => button.textContent === "Review")!);
  await waitFor(() => expect(calls.some((call) => call.path.includes("/catalog/huggingface/resolve"))).toBe(true));
  await waitFor(() => expect(document.body.textContent).toContain("proposed role chat"));

  fireEvent.click([...document.querySelectorAll("button")].find((button) => button.textContent === "Install")!);
  await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.path.endsWith("/models") && (call.body as { id: string })?.id === "qwen/qwen3-4b-instruct")).toBe(true));
});

test("Updates and Recommended modes render real data with an install action", async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  mockFetch(calls);
  render(<MemoryRouter initialEntries={["/models"]}><DashboardShell /></MemoryRouter>);
  await waitFor(() => expect(document.body.textContent).toContain("Qwen3 27B Instruct"));

  fireEvent.click([...document.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "Updates")!);
  await waitFor(() => expect(document.body.textContent).toContain("v2"));

  fireEvent.click([...document.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "Recommended")!);
  await waitFor(() => expect(document.body.textContent).toContain("Phi 4 Mini"));
  fireEvent.click([...document.querySelectorAll("button")].find((button) => button.textContent === "Install")!);
  await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.path.endsWith("/models") && (call.body as { id: string })?.id === "phi-4-mini")).toBe(true));
});
