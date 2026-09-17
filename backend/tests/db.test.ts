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

test("opens, migrates, and stamps the database", () => {
  const rows = db.select().from(meta).all();
  expect(rows).toContainEqual({ key: "schema_version", value: "1" });
});
