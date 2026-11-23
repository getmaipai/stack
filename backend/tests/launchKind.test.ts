// The launchKind row field replaces the id checks in choiceRuntime: the pictures row says "family", the video row says "quality",
// no other row carries either value, and jobInstalled/jobModelFor ask launchKind instead of def.id.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATEGORY_DEFS } from "@/lib/choiceCategories";

test("the pictures row launches as a family and the video row as a quality; no other row does", () => {
  const byLaunch = (kind: string) => CATEGORY_DEFS.filter((def) => def.launchKind === kind).map((def) => def.id);
  expect(byLaunch("family")).toEqual(["pictures"]);
  expect(byLaunch("quality")).toEqual(["video"]);
  expect(CATEGORY_DEFS.find((def) => def.id === "pictures")?.launchKind).toBe("family");
  expect(CATEGORY_DEFS.find((def) => def.id === "video")?.launchKind).toBe("quality");
  for (const def of CATEGORY_DEFS) {
    if (def.id !== "pictures" && def.id !== "video") expect(def.launchKind).toBeUndefined();
  }
});

/** The source of one top-level function, from its signature to the closing brace at column 0. */
function functionSource(text: string, name: string): string {
  const start = text.indexOf(`function ${name}(`);
  expect(start, `${name} is in choiceRuntime.ts`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

test("jobInstalled and jobModelFor decide by launchKind, not by def.id", () => {
  const text = readFileSync(join(import.meta.dir, "..", "src", "lib", "choiceRuntime.ts"), "utf8");
  for (const fn of ["jobInstalled", "jobModelFor"]) {
    const body = functionSource(text, fn);
    expect(body.includes("def.id ==="), `${fn} must not check def.id ===`).toBe(false);
  }
});
