import { afterEach, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { PropertyPanel } from "@/kit/blocks/property-panel/PropertyPanel";
import { KeyValueList } from "@/kit/blocks/property-panel/KeyValueList";
import { channelPanel } from "@/panels/channel";
import { clientPanel } from "@/panels/client";
import { detectedPanel } from "@/panels/detected";
import { groupPanel } from "@/panels/group";
import { modelPanel } from "@/panels/model";

afterEach(() => cleanup());

function renderAdapter(kind: string, name: string, adapter: { actions: Array<{ label: string; onClick: () => void }>; overview: ReactNode; insights?: ReactNode }) {
  render(<PropertyPanel kind={kind} item={{ name }} status="Ready" actions={adapter.actions} tabs={{ overview: adapter.overview, insights: adapter.insights }} open onClose={() => {}} />);
}

test("every property-panel adapter exposes actions that call its route handler", () => {
  const calls: string[] = [];
  const cases = [
    ["Model", modelPanel({ id: "llama", nickname: "Family chat" }, (action) => calls.push(`model:${action}`)), "model"],
    ["Group", groupPanel("Family", (action) => calls.push(`group:${action}`)), "group"],
    ["Client", clientPanel("Kitchen display", ["chat"], () => calls.push("client:revoke")), "client"],
    ["Channel", channelPanel("Matter", "today", (action) => calls.push(`channel:${action}`)), "channel"],
    ["Detected", detectedPanel("Ollama", (action) => calls.push(`detected:${action}`)), "detected"],
  ] as const;
  for (const [kind, adapter, prefix] of cases) {
    renderAdapter(kind, prefix, adapter);
    for (const action of adapter.actions) {
      fireEvent.click(document.querySelector(`button[aria-label="${action.label}"]`)!);
      if (action.destructive) fireEvent.click(Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Confirm")!);
    }
    cleanup();
  }
  expect(calls).toEqual(["model:load", "model:unload", "model:pin", "model:update", "model:remove", "group:load", "group:unload", "group:pin", "group:unpin", "group:checkUpdates", "group:move", "group:remove", "client:revoke", "channel:test", "channel:edit", "detected:adopt", "detected:forget"]);
});

test("the refined panel exposes icon tabs, quick facts, primary actions, and copyable metadata", async () => {
  const copied: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied.push(value); } } });
  render(<PropertyPanel kind="Model" item={{ name: "Family chat" }} status="Ready" actions={[{ label: "Load", icon: "Download", onClick: () => {} }]} facts={[{ label: "State", value: "Ready" }]} primaryActions={[{ label: "Load", onClick: () => {} }, { label: "Pin", onClick: () => {} }]} tabs={{ overview: <KeyValueList items={[{ label: "Path", value: "/models/qwen", copy: true }]} />, insights: <p>Usage insight</p>, settings: <p>Settings content</p> }} open onClose={() => {}} />);
  expect(document.querySelector('button[aria-label="Load"]')).toBeTruthy();
  expect(document.body.textContent).toContain("Ready");
  expect(document.body.textContent).toContain("Pin");
  fireEvent.click(document.querySelector('button[aria-label="Copy Path"]')!);
  await waitFor(() => expect(copied).toEqual(["/models/qwen"]));
  const insightsTab = document.querySelector('[role="tab"][aria-label="Insights"]')!;
  fireEvent.mouseDown(insightsTab);
  fireEvent.mouseUp(insightsTab);
  fireEvent.pointerDown(insightsTab);
  fireEvent.click(insightsTab);
  await waitFor(() => expect(document.body.textContent).toContain("Usage insight"));
});

test("property panel becomes a full-height phone sheet", async () => {
  const originalWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 });
  render(<PropertyPanel kind="Engine" item={{ name: "llama-server" }} status="Ready" actions={[]} tabs={{ overview: <p>Overview</p> }} open onClose={() => {}} />);
  fireEvent(window, new Event("resize"));
  await waitFor(() => expect(document.querySelector('[data-slot="sheet-content"]')).toBeTruthy());
  expect(document.querySelector('[data-slot="sheet-content"]')?.getAttribute("style")).toContain("width");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
});

test("desktop panel floats over its page without moving the table", () => {
  const originalWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  let closed = 0;
  render(<PropertyPanel kind="Engine" item={{ name: "A deliberately long engine name that may wrap in the panel header" }} status="Ready" actions={[]} tabs={{ overview: <p>Configuration value</p> }} open onClose={() => { closed += 1; }} />);
  const overlay = document.querySelector('[data-testid="property-panel-overlay"]') as HTMLElement;
  const panel = document.querySelector('[data-testid="property-panel"]') as HTMLElement;
  expect(overlay.className).toContain("fixed");
  expect(overlay.querySelector("aside")?.className).toContain("w-[420px]");
  expect(panel.textContent).toContain("Configuration");
  expect(panel.querySelector("h2")?.className).toContain("line-clamp-2");
  fireEvent.click(overlay.querySelector('button[aria-label="Close panel by clicking outside"]')!);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(closed).toBe(2);
  Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
});
