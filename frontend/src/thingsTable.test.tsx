import { expect, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { ThingsTable, type ThingsTableGroup } from "@/kit/blocks/things-table/ThingsTable";

type Row = { id: string; name: string; status: "ready" | "attention" | "offline" | "detected" };
const rows: Row[] = [{ id: "ready", name: "Ready row", status: "ready" }, { id: "attention", name: "Attention row", status: "attention" }, { id: "offline", name: "Offline row", status: "offline" }, { id: "detected", name: "Detected row", status: "detected" }];
const columns = [{ key: "name", header: "Name", render: (row: Row) => row.name }, { key: "status", header: "State", render: (row: Row) => row.status }];

test("ThingsTable renders state tooltips, sorts, groups, selection, actions, and empty copy", () => {
  const group: ThingsTableGroup<Row> = { key: "group", ariaLabel: "Models", label: "Models", rows: [{ id: "child", name: "Child row", status: "ready" }] };
  const { rerender } = render(<ThingsTable columns={columns} rows={rows} getKey={(row) => row.id} getStatus={(row) => row.status} selectable groups={[group]} actions={[{ label: "Add a model", onClick: () => {} }]} empty="Nothing here yet." />);
  for (const label of ["Ready", "Needs attention", "Offline", "Detected"]) expect(document.querySelector(`[aria-label="${label}"]`)).toBeTruthy();
  fireEvent.click(document.querySelector('button[aria-label="Name"]')!);
  expect(document.body.textContent?.indexOf("Attention row")).toBeLessThan(document.body.textContent?.indexOf("Ready row") ?? 0);
  fireEvent.click(document.querySelector('button[aria-label="Expand Models"]')!);
  expect(document.body.textContent).toContain("Child row");
  fireEvent.click(document.querySelector('button[aria-label="Select all rows"]')!);
  expect(document.querySelectorAll('[role="checkbox"][data-state="checked"]')).toHaveLength(rows.length + 1);
  expect(document.body.textContent).toContain("Add a model");
  rerender(<ThingsTable columns={columns} rows={[]} getKey={(row) => row.id} empty="Nothing here yet." />);
  expect(document.body.textContent).toContain("Nothing here yet.");
});
