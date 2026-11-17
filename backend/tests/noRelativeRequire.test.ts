// The compiled Stack binary resolves no relative require (createRequire + "../../package.json" stopped a ship on 2026-11-17):
// package.json is read through a static import, as app.ts and diagnostics.ts do.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => { const path = join(dir, name); return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : []; });
}

test("no source file reads package.json through createRequire", () => {
  const offenders = sources(join(import.meta.dir, "../src")).filter((path) => { const text = readFileSync(path, "utf8"); return text.includes("createRequire(") && /require\((["'])\.\.?\/[^"']*package\.json\1\)/.test(text); });
  expect(offenders).toEqual([]);
});
