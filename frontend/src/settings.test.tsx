import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DashboardShell } from "@/pages/DashboardShell";
import { STACK_SETTING_SECTIONS } from "../../backend/src/settings/sections";

const originalFetch = globalThis.fetch;

afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

test("Settings renders every section declared by the backend", async () => {
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith("/settings/index")) return Promise.resolve(Response.json({ sections: STACK_SETTING_SECTIONS, settings: [] }));
    if (path.endsWith("/settings")) return Promise.resolve(Response.json({ settings: [] }));
    if (path.endsWith("/hardware")) return Promise.resolve(Response.json({ hardware: { drives: [] } }));
    if (path.endsWith("/channels")) return Promise.resolve(Response.json({ channels: [] }));
    if (path.endsWith("/engines")) return Promise.resolve(Response.json({ engines: [] }));
    return Promise.resolve(Response.json({}));
  }) as unknown as typeof fetch;
  render(<MemoryRouter initialEntries={["/settings"]}><DashboardShell /></MemoryRouter>);
  await waitFor(() => expect(STACK_SETTING_SECTIONS.every((section) => document.querySelector(`[data-testid="settings-section-${section.id}"]`))).toBe(true));
});
