import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DashboardShell } from "@/pages/DashboardShell";

afterEach(() => cleanup());

test("the Stack shell lists every section in order", () => {
  render(<MemoryRouter initialEntries={["/updates"]}><DashboardShell /></MemoryRouter>);
  const text = document.body.textContent ?? "";
  let previous = -1;
  for (const section of ["Overview", "Abilities", "Models", "Engines", "Monitoring", "Alerts", "Updates", "Backups", "Access", "Try it", "Settings"]) {
    const next = text.indexOf(section);
    expect(next).toBeGreaterThan(previous);
    previous = next;
  }
  expect(text).toContain("Updates are checked on request");
});

test("command palette opens from both shortcuts and jumps to Models", async () => {
  render(<MemoryRouter initialEntries={["/updates"]}><DashboardShell /></MemoryRouter>);
  globalThis.fetch = mock(() => Promise.resolve(Response.json({ roles: [] }))) as unknown as typeof fetch;
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  expect(document.querySelector('input[placeholder="Search sections and actions..."]')).toBeTruthy();
  fireEvent.click(Array.from(document.querySelectorAll('[cmdk-item]')).find((item) => item.textContent?.trim() === "Models")!);
  await waitFor(() => expect(document.body.textContent).toContain("No models are installed yet"));
  fireEvent.keyDown(window, { key: "/" });
  expect(document.querySelector('input[placeholder="Search sections and actions..."]')).toBeTruthy();
});
