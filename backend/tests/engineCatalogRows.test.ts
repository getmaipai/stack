// The engine pin tables moved to src/rows/engineCatalog.json (the Stack runs
// alone, with features and parts as data). These checks pin the shape of the
// rows file and the typed views lib/engineCatalog.ts exposes over it.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ENGINE_BINARIES, MLX_SERVE_PIN, SPLASH_PIN, SPLASH_CHAT_PIN, MANAGED_RUNTIMES, BUNDLED_RUNTIMES } from "@/lib/engineCatalog";
import rows from "@/rows/engineCatalog.json";

test("the rows file has exactly the six table keys", () => {
  expect(Object.keys(rows).sort()).toEqual(["binaries", "bundledRuntimes", "managedRuntimes", "mlxServe", "splash", "splashChat"]);
});

test("ENGINE_BINARIES is a pinned list where every entry names its engine", () => {
  expect(ENGINE_BINARIES.length).toBeGreaterThanOrEqual(10);
  for (const pin of ENGINE_BINARIES) expect(typeof pin.name).toBe("string");
});

test("the single pins carry their engine names", () => {
  expect(typeof SPLASH_PIN.name).toBe("string");
  expect(typeof MLX_SERVE_PIN.name).toBe("string");
  expect(typeof SPLASH_CHAT_PIN.name).toBe("string");
});

test("the runtime tables are non-empty and each entry lists its roles", () => {
  expect(MANAGED_RUNTIMES.length).toBeGreaterThan(0);
  expect(BUNDLED_RUNTIMES.length).toBeGreaterThan(0);
  for (const runtime of [...MANAGED_RUNTIMES, ...BUNDLED_RUNTIMES]) expect(Array.isArray(runtime.roles)).toBe(true);
});

test("the catalog library stayed small after the tables left", () => {
  const text = readFileSync(new URL("../src/lib/engineCatalog.ts", import.meta.url), "utf8");
  expect(text.split("\n").length).toBeLessThan(300);
});
