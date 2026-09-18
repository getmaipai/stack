import { afterEach, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { PropertyPanel } from "@/kit/blocks/property-panel/PropertyPanel";
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
  expect(calls).toEqual(["model:load", "model:unload", "model:pin", "model:update", "model:remove", "group:load", "group:unload", "group:pin", "group:update", "group:rename", "group:remove", "group:clear", "client:revoke", "channel:test", "channel:remove", "detected:adopt", "detected:forget"]);
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
