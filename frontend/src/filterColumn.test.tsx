import { afterEach, expect, test } from "bun:test";
import { useState } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { applyFilters, countFilterOptions, FilterColumn, type FilterGroup } from "@/kit/blocks/filter-column/FilterColumn";

type Row = { name: string; status: string; role: string };
const rows: Row[] = [{ name: "Alpha", status: "Ready", role: "chat" }, { name: "Beta", status: "Ready", role: "embed" }, { name: "Gamma", status: "Offline", role: "chat" }];
const accessors = { status: (row: Row) => row.status, role: (row: Row) => row.role, search: (row: Row) => row.name };

afterEach(() => cleanup());

function Harness() {
  const [search, setSearch] = useState("");
  const [selections, setSelections] = useState<Record<string, ReadonlySet<string>>>({});
  const group = (id: "status" | "role", title: string): FilterGroup => ({ id, title, options: countFilterOptions(rows, accessors[id]), selected: selections[id] ?? new Set<string>(), onChange: (selected) => setSelections((current) => ({ ...current, [id]: selected })) });
  const filtered = applyFilters(rows, search, selections, accessors);
  return <><FilterColumn search={{ value: search, onChange: setSearch }} groups={[group("status", "Status"), group("role", "Role")]} onClear={() => { setSearch(""); setSelections({}); }} /><ul>{filtered.map((row) => <li key={row.name}>{row.name}</li>)}</ul></>;
}

test("FilterColumn combines two groups with search, shows counts, and clears", () => {
  render(<Harness />);
  expect(document.body.textContent).toContain("Alpha");
  expect(document.body.textContent).toContain("2");
  fireEvent.click(document.querySelector('button[aria-label="Ready"]')!);
  fireEvent.click(document.querySelector('button[aria-label="chat"]')!);
  fireEvent.change(document.querySelector('input[aria-label="Search filters"]')!, { target: { value: "alpha" } });
  expect(document.body.textContent).toContain("Alpha");
  expect(document.body.textContent).not.toContain("Beta");
  expect(document.body.textContent).not.toContain("Gamma");
  fireEvent.click(document.querySelector('button[type="button"]:not([aria-label])')!);
  expect(document.body.textContent).toContain("Beta");
  expect(document.querySelector('button[aria-label="Ready"]')?.getAttribute("data-state")).toBe("unchecked");
});
