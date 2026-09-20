import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { DetailsPane } from "@/kit/blocks/pane/DetailsPane";

afterEach(cleanup);

// A Radix Sheet/Dialog portal outlives testing-library's own container,
// and this environment's waitFor (MutationObserver-based) stops
// noticing DOM changes once a few Sheets have mounted and unmounted in
// the same file. A short real delay settles Radix's own effects just
// as reliably and doesn't depend on that observer.
function settle(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("renders the header (icon tile, name, identifier, status pill) and focuses the heading on open", async () => {
  render(<DetailsPane open onClose={() => undefined} icon="Box" hue="--cat-models" name="Qwen3 27B Instruct" identifier="qwen3-27b-instruct" status="running" />);
  await settle();
  expect(document.body.textContent).toContain("Qwen3 27B Instruct");
  expect(document.body.textContent).toContain("qwen3-27b-instruct");
  expect(document.body.textContent).toContain("Running");
  expect(document.activeElement?.tagName).toBe("H2");
});

test("shows no tab list when no tabs are passed", async () => {
  render(<DetailsPane open onClose={() => undefined} icon="Box" hue="--cat-models" name="Qwen3" identifier="qwen3" status="running" />);
  await settle();
  expect(document.body.textContent).toContain("Qwen3");
  expect(Array.from(document.querySelectorAll("button")).some((button) => button.textContent === "Overview")).toBe(false);
});

test("renders tabs only when content is passed for them, and switches between them", async () => {
  render(<DetailsPane open onClose={() => undefined} icon="Box" hue="--cat-models" name="Qwen3" identifier="qwen3" status="running" tabs={[{ id: "overview", label: "Overview", content: <p>Overview body</p> }, { id: "logs", label: "Logs", content: <p>Logs body</p> }]} />);
  await settle();
  expect(document.body.textContent).toContain("Overview body");
  const logsTab = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Logs") as HTMLButtonElement;
  expect(logsTab).toBeTruthy();
  // Radix Tabs switches on focus (its "automatic" activation mode); a
  // real click moves focus natively, but happy-dom's synthetic click
  // does not, so the test drives focus explicitly.
  logsTab.focus();
  fireEvent.click(logsTab);
  await settle();
  expect(document.body.textContent).toContain("Logs body");
});

test("a destructive action is visually separated and still fires onClick", async () => {
  let removed = false;
  render(<DetailsPane open onClose={() => undefined} icon="Box" hue="--cat-models" name="Qwen3" identifier="qwen3" status="running" actions={[{ label: "Restart", onClick: () => undefined }, { label: "Remove", destructive: true, onClick: () => { removed = true; } }]} />);
  await settle();
  expect(document.body.textContent).toContain("Restart");
  const removeButton = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Remove")!;
  expect(removeButton.getAttribute("data-variant")).toBe("destructive");
  fireEvent.click(removeButton);
  expect(removed).toBe(true);
});

test("a disabled action carries its reason and cannot be clicked", async () => {
  let clicked = false;
  render(<DetailsPane open onClose={() => undefined} icon="Box" hue="--cat-models" name="Qwen3" identifier="qwen3" status="running" actions={[{ label: "Chat", onClick: () => { clicked = true; }, disabledReason: "Load the model first." }]} />);
  await settle();
  const button = document.querySelector("button[title='Load the model first.']") as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(clicked).toBe(false);
});

test("the close control fires onClose", async () => {
  let closed = false;
  render(<DetailsPane open onClose={() => { closed = true; }} icon="Box" hue="--cat-models" name="Qwen3" identifier="qwen3" status="running" />);
  await settle();
  const closeButton = document.querySelector('button[aria-label="Close"]')!;
  fireEvent.click(closeButton);
  expect(closed).toBe(true);
});
