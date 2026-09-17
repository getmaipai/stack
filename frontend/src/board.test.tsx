import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "@/App";
import { BoardPage } from "@/pages/BoardPage";
import { SetupPage } from "@/pages/SetupPage";

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
});

function boardFetch(input: RequestInfo | URL): Response {
  const path = String(input);
  if (path.endsWith("/roles")) {
    return Response.json({
      roles: [
        { id: "chat", wire: "chat", residency: "resident", description: "Talk with your local AI.", state: "ready", reason: null },
        { id: "coding", wire: "chat", residency: "resident", description: "Build and understand things with local AI.", state: "ready", reason: null },
      ],
    });
  }
  if (path.endsWith("/budget")) return Response.json({ capBytes: 128 * 1_073_741_824, freeMemoryBytes: 30 * 1_073_741_824, pressure: false, loaded: [], queue: [] });
  if (path.endsWith("/notifications")) return Response.json({ notifications: [] });
  if (path.endsWith("/repairs")) return Response.json({ repairs: [] });
  throw new Error("unstubbed fetch: " + path);
}

test("the board renders a tile per declared role with its state text", async () => {
  globalThis.EventSource = undefined as unknown as typeof EventSource;
  globalThis.fetch = mock((input: RequestInfo | URL) => Promise.resolve(boardFetch(input))) as unknown as typeof fetch;
  render(<MemoryRouter><BoardPage /></MemoryRouter>);

  await waitFor(() => {
    expect(document.body.textContent).toContain("Ready, 62 GB loaded");
    expect(document.body.textContent).toContain("Chat");
    expect(document.body.textContent).toContain("Coding");
  });
});

test("the operator gate redirects setupRequired to setup", async () => {
  globalThis.fetch = mock(() => Promise.resolve(Response.json({ state: "setupRequired" }))) as unknown as typeof fetch;
  render(<MemoryRouter initialEntries={["/"]}><App /></MemoryRouter>);
  await waitFor(() => expect(document.body.textContent).toContain("Welcome to MaiPai Stack"));
});

test("the ready step keeps the family hand-off wording exact", () => {
  render(<MemoryRouter><SetupPage initialStep={4} /></MemoryRouter>);
  expect(document.body.textContent).toContain("The Stack is yours alone. MaiPai Home adds people, kid-safe profiles, memory, and companions on top of it, on this same computer.");
});
