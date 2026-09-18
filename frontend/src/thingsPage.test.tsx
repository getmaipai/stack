import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { ThingsPage } from "@/kit/blocks/things-page/ThingsPage";

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
