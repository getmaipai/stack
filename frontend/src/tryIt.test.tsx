import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TryItPage } from "@/pages/TryItPage";

afterEach(() => cleanup());

// The real /stack/v1/roles shape (STACK-87): `state` is the stamped
// { state, since, checkedAt?, reason? } record, not a bare string. A
// fixture using the old flat shape would let `roleReady()` silently
// return false for every role and none of these tests would notice,
// since the negative ("Not ready") path looks the same either way.
function stubRoles(roles: Array<{ id: string; state: string; reason: string | null }>): void {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://local").pathname;
    if (path.endsWith("/roles")) return new Response(JSON.stringify({ roles: roles.map((role) => ({ id: role.id, wire: role.id, residency: "resident", endpoints: [], quality: ["fast", "everyday", "best"], description: "", state: { state: role.state, since: new Date().toISOString(), checkedAt: role.state === "ready" ? new Date().toISOString() : undefined }, reason: role.reason })) }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ acknowledged: false }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

test("Try it shows an underline tab per role in page order", async () => {
  stubRoles([
    { id: "chat", state: "ready", reason: null },
    { id: "tts", state: "offline", reason: null },
    { id: "stt", state: "offline", reason: null },
    { id: "image", state: "notInstalled", reason: null },
    { id: "video", state: "notInstalled", reason: null },
    { id: "music", state: "notInstalled", reason: null },
  ]);
  render(<MemoryRouter><TryItPage /></MemoryRouter>);
  await waitFor(() => expect(document.querySelector('[data-slot="tabs"]')).not.toBeNull());
  const triggers = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-slot="tabs-trigger"]'));
  expect(triggers.map((trigger) => trigger.textContent)).toEqual(["Chat", "Voice out", "Voice in", "Images", "Video", "Music"]);
});

test("an uninstalled generator role shows its tab and the offline reason", async () => {
  stubRoles([
    { id: "chat", state: "ready", reason: null },
    { id: "image", state: "notInstalled", reason: "The Image engine is waiting for its first install." },
  ]);
  render(<MemoryRouter><TryItPage initialRole="image" /></MemoryRouter>);
  await waitFor(() => expect(document.body.textContent).toContain("Not ready"));
  expect(document.body.textContent).toContain("The Image engine is waiting for its first install.");
});

test("a ready chat role renders its composer, not the offline state", async () => {
  // Regression for STACK-87: reading `role.state` directly against a
  // string literal instead of through `roleState()` made every role
  // register as not-ready, including a genuinely ready one.
  stubRoles([{ id: "chat", state: "ready", reason: null }]);
  render(<MemoryRouter><TryItPage initialRole="chat" /></MemoryRouter>);
  await waitFor(() => expect(document.querySelector("#try-chat-composer")).not.toBeNull());
  expect(document.body.textContent).not.toContain("Not ready");
});

test("an offline chat tab shows its empty state with the reason and no composer", async () => {
  stubRoles([
    { id: "chat", state: "offline", reason: "The chat engine is waiting for its first install." },
  ]);
  render(<MemoryRouter><TryItPage initialRole="chat" /></MemoryRouter>);
  await waitFor(() => expect(document.body.textContent).toContain("Not ready"));
  expect(document.body.textContent).toContain("Chat is not ready yet.");
  expect(document.body.textContent).toContain("The chat engine is waiting for its first install.");
  expect(document.querySelector("#try-chat-composer")).toBeNull();
});
