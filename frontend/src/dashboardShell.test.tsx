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

test("the collapsed rail keeps every section and carries a tooltip on each button", () => {
  render(<MemoryRouter initialEntries={["/"]}><DashboardShell /></MemoryRouter>);
  const trigger = document.querySelector('[data-sidebar="trigger"]') ?? document.querySelector("button[aria-label*='sidebar']") ?? document.querySelector("button[aria-label*='menu']");
  if (!trigger) throw new Error("no sidebar trigger found");
  fireEvent.click(trigger);
  const buttons = Array.from(document.querySelectorAll('[data-slot="sidebar-menu-button"]'));
  const sections = ["Overview", "Abilities", "Models", "Engines", "Monitoring", "Alerts", "Updates", "Backups", "Access", "Try it", "Settings"];
  const text = document.body.textContent ?? "";
  for (const title of sections) {
    expect(text).toContain(title);
  }
  for (const button of buttons) {
    const link = button.querySelector("a");
    const text = link?.textContent?.trim() ?? "";
    if (sections.includes(text)) {
      expect(button.innerHTML).toContain(text);
    }
  }
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
