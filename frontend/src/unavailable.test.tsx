import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { PropertyPanel } from "@/kit/blocks/property-panel/PropertyPanel";
import { unavailableControls, sentenceFor } from "@/lib/unavailable";

afterEach(() => cleanup());

test("every inventory control is disabled with its exact sentence", () => {
  for (const control of unavailableControls) {
    const actions = [{ label: control.label, icon: "Play" as const, onClick: () => {}, disabled: true, sentence: control.sentence }];
    render(<PropertyPanel kind="Engine" item={{ name: "test" }} status="Ready" actions={actions} tabs={{ overview: <p>Overview</p> }} open onClose={() => {}} />);
    const button = document.querySelector(`button[aria-label="${control.label}"]`) as HTMLButtonElement;
    expect(button).toBeTruthy();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.disabled).toBe(true);
    expect(document.body.textContent).toContain(control.sentence);
    cleanup();
  }
});

test("sentenceFor returns the exact sentence for every inventory id", () => {
  for (const control of unavailableControls) {
    expect(sentenceFor(control.id)).toBe(control.sentence);
  }
  expect(sentenceFor("not-an-id")).toBeUndefined();
});
