import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { LoginPage } from "@/pages/LoginPage";

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  delete (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__;
});

function setupPage() {
  globalThis.fetch = (async () => Response.json({ state: "signedOut", required: true, loopback: true })) as unknown as typeof fetch;
}

test("the setup card shows the password field in the desktop webview without loopback", async () => {
  setupPage();
  (globalThis as typeof globalThis & { __TAURI__?: unknown }).__TAURI__ = {} as unknown;
  render(
    <MemoryRouter initialEntries={["/setup"]}>
      <LoginPage state={{ state: "setupRequired", required: true, loopback: false }} />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByLabelText("Operator password")).toBeTruthy());
  expect(screen.queryByText("Set the operator password on the computer that runs the Stack first.")).toBeNull();
});

test("a remote browser without loopback sees the on-the-computer sentence instead of the field", async () => {
  setupPage();
  render(
    <MemoryRouter initialEntries={["/setup"]}>
      <LoginPage state={{ state: "setupRequired", required: true, loopback: false }} />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText("Set the operator password on the computer that runs the Stack first.")).toBeTruthy());
  expect(screen.queryByLabelText("Operator password")).toBeNull();
});
