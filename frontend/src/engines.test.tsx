import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DashboardShell } from "@/pages/DashboardShell";

const originalFetch = globalThis.fetch;
const engines = [{ id: "llama-server-b10797-macos-arm64", label: "llama-server", platform: "darwin", arch: "arm64", verified: true, installed: true, matchesThisMachine: true, running: "b10790", currentTag: "b10790", newestTag: "b10797", current: false, notCurrent: true, needsRestart: true, state: "notCurrent" as const, stateReason: "newer installed" as const }];
const settings = [{ key: "contextLength", type: "number" as const, default: 4096, label: "Context length", help: "Conversation size.", disclosure: "advanced" as const, needsRestart: true, inEffect: 4096, pending: 8192 }, { key: "flashAttention", type: "boolean" as const, default: true, label: "Flash attention", help: "Faster attention.", disclosure: "advanced" as const, needsRestart: true, inEffect: true, pending: null }];

afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

test("the engines table renders version state and its reason", async () => {
  globalThis.fetch = mock((input: RequestInfo | URL) => Promise.resolve(String(input).endsWith("/engines") ? Response.json({ engines }) : Response.json({ settings }))) as unknown as typeof fetch;
  render(<MemoryRouter initialEntries={["/engines"]}><DashboardShell /></MemoryRouter>);
  await waitFor(() => { expect(document.body.textContent).toContain("Not current"); expect(document.body.textContent).toContain("newer installed"); expect(document.body.textContent).toContain("Needs restart"); });
});

test("the configure sheet renders declared controls and stop uses an inline confirmation", async () => {
  const calls: string[] = [];
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => { calls.push(`${String(input)} ${init?.method ?? "GET"}`); if (String(input).includes("/config") && init?.method === "PUT") return Promise.resolve(Response.json({ settings })); if (String(input).includes("/config")) return Promise.resolve(Response.json({ settings })); if (init?.method === "POST") return Promise.resolve(Response.json({ ok: true })); return Promise.resolve(Response.json({ engines })); }) as unknown as typeof fetch;
  render(<MemoryRouter initialEntries={["/engines"]}><DashboardShell /></MemoryRouter>);
  await waitFor(() => expect(document.body.textContent).toContain("Configure"));
  fireEvent.click(Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Configure")!);
  await waitFor(() => expect(document.body.textContent).toContain("Advanced settings"));
  fireEvent.click(Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Advanced settings")!);
  await waitFor(() => { expect(document.body.textContent).toContain("Context length"); expect(document.querySelector('input[type="number"]')).toBeTruthy(); expect(document.querySelector('[data-testid="generic-engine-form"]')).toBeTruthy(); });
  fireEvent.click(Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Stop")!);
  expect(document.body.textContent).toContain("Stop this engine?");
  expect(calls.some((call) => call.endsWith("/config GET"))).toBe(true);
});
