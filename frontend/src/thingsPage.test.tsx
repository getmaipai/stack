import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { ThingsPage } from "@/kit/blocks/things-page/ThingsPage";
import { PropertyPanel } from "@/kit/blocks/property-panel/PropertyPanel";

const originalWidth = window.innerWidth;
afterEach(() => { cleanup(); Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth }); });

const filter = { search: { value: "", onChange: () => {} }, groups: [], onClear: () => {} };

test("ThingsPage shows the filter column on wide screens", () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  render(<ThingsPage filter={filter} table={<div>Rows</div>} />);
  expect(document.querySelector('[data-testid="filter-column"]')).toBeTruthy();
  expect(document.querySelector('button[aria-label="Show filters"]')).toBeNull();
});

test("ThingsPage moves filters behind the Filter button below tablet width", () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
  render(<ThingsPage filter={filter} table={<div>Rows</div>} />);
  expect(document.querySelector('[data-testid="filter-column"]')).toBeNull();
  expect(document.querySelector('button[type="button"]')?.textContent).toContain("Filter");
});

test("a 1440px panel keeps the full table region and does not add a layout push", () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  render(<ThingsPage filter={filter} table={<table><tbody><tr><td className="min-w-0">A long name that remains in the table beneath the panel</td><td>Ready</td></tr></tbody></table>} panel={<PropertyPanel kind="Engine" item={{ name: "Engine" }} status="Ready" actions={[]} tabs={{ overview: <p>Value</p> }} open onClose={() => {}} />} />);
  const page = document.querySelector('[data-testid="things-page"]') as HTMLElement;
  const tableRegion = document.querySelector('[data-testid="things-table-region"]') as HTMLElement;
  expect(page.className).not.toContain("pr-[29rem]");
  expect(tableRegion.className).toContain("flex-1");
  expect(tableRegion.textContent).toContain("A long name that remains in the table");
  expect(document.querySelector('[data-testid="property-panel-overlay"]')).toBeTruthy();
});
