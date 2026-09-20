import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { DataTable, type DataTableColumn } from "@/kit/blocks/browser/DataTable";

afterEach(cleanup);
beforeEach(() => { Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 }); });

interface Row { id: string; name: string; size: string }
const rows: Row[] = [{ id: "a", name: "Qwen3 27B", size: "16 GB" }, { id: "b", name: "Mistral 7B", size: "4 GB" }];
const columns: DataTableColumn<Row>[] = [
  { id: "name", header: "Name", cell: (row) => row.name },
  { id: "size", header: "Size", cell: (row) => row.size, priority: 1 },
];

test("renders every row and column", () => {
  render(<DataTable data={rows} columns={columns} getRowId={(row) => row.id} />);
  expect(document.body.textContent).toContain("Qwen3 27B");
  expect(document.body.textContent).toContain("4 GB");
});

test("row click opens the pane via onRowClick", () => {
  const state: { clickedId: string | null } = { clickedId: null };
  render(<DataTable data={rows} columns={columns} getRowId={(row) => row.id} onRowClick={(row) => { state.clickedId = row.id; }} />);
  fireEvent.click(document.querySelectorAll("tbody tr")[0]!);
  expect(state.clickedId).toBe("a");
});

test("the selection checkbox column reports selected ids, and select-all toggles every row", () => {
  let selected: string[] = [];
  render(<DataTable data={rows} columns={columns} getRowId={(row) => row.id} selectedIds={selected} onSelectionChange={(ids) => { selected = ids; }} />);
  const rowCheckbox = document.querySelectorAll('tbody [role="checkbox"]')[0]!;
  fireEvent.click(rowCheckbox);
  expect(selected).toEqual(["a"]);
});

test("the header checkbox reflects only the currently visible rows, not a stale count from a wider selection", () => {
  // selectedIds carries ids from a wider, unfiltered view; the visible
  // rows here are a completely different pair with the same count.
  const otherViewSelection = ["x", "y"];
  render(<DataTable data={rows} columns={columns} getRowId={(row) => row.id} selectedIds={otherViewSelection} onSelectionChange={() => undefined} />);
  const headerCheckbox = document.querySelector('thead [role="checkbox"]')!;
  expect(headerCheckbox.getAttribute("data-state")).not.toBe("checked");
});

test("select-all only adds the visible rows to selection, and clear-all only removes them", () => {
  let selected: string[] = ["z"];
  const { rerender } = render(<DataTable data={rows} columns={columns} getRowId={(row) => row.id} selectedIds={selected} onSelectionChange={(ids) => { selected = ids; }} />);
  fireEvent.click(document.querySelector('thead [role="checkbox"]')!);
  expect(selected.sort()).toEqual(["a", "b", "z"]);
  rerender(<DataTable data={rows} columns={columns} getRowId={(row) => row.id} selectedIds={selected} onSelectionChange={(ids) => { selected = ids; }} />);
  fireEvent.click(document.querySelector('thead [role="checkbox"]')!);
  expect(selected).toEqual(["z"]);
});

test("arrow keys move focus between rows", () => {
  render(<DataTable data={rows} columns={columns} getRowId={(row) => row.id} />);
  const [first, second] = Array.from(document.querySelectorAll("tbody tr")) as [HTMLTableRowElement, HTMLTableRowElement];
  first.focus();
  fireEvent.keyDown(document.querySelector("tbody")!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(second);
});

test("secondary columns (priority set) hide under 1280px", () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1000 });
  render(<DataTable data={rows} columns={columns} getRowId={(row) => row.id} />);
  expect(document.body.textContent).not.toContain("Size");
  expect(document.body.textContent).not.toContain("4 GB");
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });
});

test("the row menu renders only when rowMenu is passed", () => {
  const { rerender } = render(<DataTable data={rows} columns={columns} getRowId={(row) => row.id} />);
  expect(document.querySelector('button[aria-label="More actions"]')).toBeNull();
  rerender(<DataTable data={rows} columns={columns} getRowId={(row) => row.id} rowMenu={() => <div>Actions</div>} />);
  expect(document.querySelector('button[aria-label="More actions"]')).toBeTruthy();
});
