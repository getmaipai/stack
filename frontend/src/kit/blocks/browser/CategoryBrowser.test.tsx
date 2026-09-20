import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";
import { CategoryBrowser } from "@/kit/blocks/browser/CategoryBrowser";
import { useFacetSort } from "@/kit/hooks/useFacetSort";

afterEach(cleanup);

function Demo() {
  const [state, actions] = useFacetSort();
  return (
    <CategoryBrowser
      facets={[{ id: "all", label: "All", count: 12 }, { id: "llm", label: "LLM", count: 8 }]}
      sorts={[{ id: "name", label: "Name" }, { id: "size", label: "Size" }]}
      primaryAction={{ label: "Install Model", onClick: () => undefined }}
      state={state}
      actions={actions}
    >
      <p>row for {state.mode}/{state.facet}</p>
    </CategoryBrowser>
  );
}

test("renders the mode tabs, facets with counts, and the primary action", () => {
  render(<MemoryRouter><Demo /></MemoryRouter>);
  expect(document.body.textContent).toContain("Installed");
  expect(document.body.textContent).toContain("Browse");
  expect(document.body.textContent).toContain("All (12)");
  expect(document.body.textContent).toContain("LLM (8)");
  expect(document.querySelector("button")?.textContent).toBeTruthy();
  expect(document.body.textContent).toContain("Install Model");
});

test("clicking a mode tab switches the active mode", () => {
  render(<MemoryRouter><Demo /></MemoryRouter>);
  const browseTab = Array.from(document.querySelectorAll('[role="tab"]')).find((tab) => tab.textContent === "Browse")!;
  fireEvent.click(browseTab);
  expect(document.body.textContent).toContain("row for browse/all");
});

test("clicking a facet chip switches the active facet", () => {
  render(<MemoryRouter><Demo /></MemoryRouter>);
  const llmFacet = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "LLM (8)")!;
  fireEvent.click(llmFacet);
  expect(document.body.textContent).toContain("row for installed/llm");
});

test("/ focuses the filter field, but Cmd+K does not (that shortcut belongs to the shell's global search)", () => {
  render(<MemoryRouter><Demo /></MemoryRouter>);
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  expect(document.activeElement).not.toBe(document.querySelector('input[aria-label="Filter"]'));
  fireEvent.keyDown(window, { key: "/" });
  expect(document.activeElement).toBe(document.querySelector('input[aria-label="Filter"]'));
});

test("the view toggle switches between list and grid", () => {
  render(<MemoryRouter><Demo /></MemoryRouter>);
  const gridButton = document.querySelector('button[aria-label="Grid view"]') as HTMLButtonElement;
  gridButton.focus();
  fireEvent.click(gridButton);
  expect(gridButton.getAttribute("data-state")).toBe("on");
});
