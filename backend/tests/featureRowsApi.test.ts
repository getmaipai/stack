// Every feature row carries an icon and a one-line description, and the choices API schema serves both, so the Stack can render its own
// admin page and the shared models page without a map in the UI kit.
import { expect, test } from "bun:test";
import rows from "../src/rows/featureRows.json";
import { CategorySchema } from "@/lib/choicesSchema";

test("every row has a non-empty icon and description", () => {
  for (const row of rows) {
    expect(row.icon.length, `icon for ${row.id}`).toBeGreaterThan(0);
    expect(row.description.length, `description for ${row.id}`).toBeGreaterThan(0);
  }
});

test("the coding row uses the code icon", () => {
  const coding = rows.find((row) => row.id === "coding");
  expect(coding?.icon).toBe("code");
});

test("every description ends with a period", () => {
  for (const row of rows) expect(row.description.endsWith(".")).toBe(true);
});

test("CategorySchema serves icon and description", () => {
  expect(Object.keys(CategorySchema.shape)).toContain("icon");
  expect(Object.keys(CategorySchema.shape)).toContain("description");
});
