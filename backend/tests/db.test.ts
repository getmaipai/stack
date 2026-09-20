import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalDataDir = process.env.STACK_DATA_DIR;
const testDataDir = mkdtempSync(join(tmpdir(), "maipai-stack-db-"));
process.env.STACK_DATA_DIR = testDataDir;
const { db } = await import("@/db");
const { meta } = await import("@/db/schema");

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.STACK_DATA_DIR;
  else process.env.STACK_DATA_DIR = originalDataDir;
  rmSync(testDataDir, { recursive: true, force: true });
});

test("opens and migrates the three-table state database", () => {
  const { sqlite } = require("@/db") as { sqlite: import("bun:sqlite").Database };
  const tables = sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '__drizzle%' ORDER BY name").all() as Array<{ name: string }>;
  expect(tables.map((row) => row.name)).toEqual(["health", "meta", "models"]);
  expect(db.select().from(meta).all()).toEqual([]);
});
