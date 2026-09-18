import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { GenericForm } from "@/kit/settings/GenericForm";
import type { EngineSetting } from "@/lib/api";

afterEach(cleanup);

const settings: EngineSetting[] = [
  { key: "mode", type: "enum", options: [{ value: "fast", label: "Fast" }, { value: "balanced", label: "Balanced" }, { value: "quality", label: "Quality" }], default: "balanced", group: "Performance", label: "Mode", help: "Choose how the engine spends its time.", disclosure: "basic", needsRestart: true, inEffect: "balanced", pending: null },
  { key: "enabled", type: "boolean", default: true, group: "Performance", label: "Enabled", help: "Keep this feature available.", disclosure: "basic", needsRestart: false, inEffect: true, pending: null },
  { key: "name", type: "text", default: "local", group: "Host", label: "Name", help: "The local display name.", disclosure: "basic", needsRestart: false, inEffect: "local", pending: null },
];

test("GenericForm renders grouped rows, enum radios, help popovers, booleans, and pending state", () => {
  const onChange = mock(() => {});
  render(<GenericForm settings={settings} values={{ mode: "fast", enabled: true, name: "local" }} onChange={onChange} />);
  const body = document.body.textContent ?? "";
  expect(body.indexOf("Performance")).toBeLessThan(body.indexOf("Host"));
  expect(document.querySelectorAll('[role="radio"]')).toHaveLength(3);
  expect(document.querySelector('[data-slot="checkbox"]')).toBeTruthy();
  expect(body).toContain("pending");
  expect(body).toContain("Restart to apply pending settings.");
  fireEvent.click(document.querySelector('[role="radio"][aria-label="Balanced"]')!);
  expect(onChange).toHaveBeenCalled();
  fireEvent.click(document.querySelector('button[aria-label="Explain Mode"]')!);
  expect(document.body.textContent).toContain("Choose how the engine spends its time.");
});
