import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalDataDir = process.env.STACK_DATA_DIR;
const testDataDir = mkdtempSync(join(tmpdir(), "maipai-stack-paths-"));
process.env.STACK_DATA_DIR = testDataDir;
// bun test runs every test file in one process and shares one module cache, so
// an earlier file (via the app) has already imported paths.ts and fixed its
// dataDir. Import a fresh copy (a distinct cache key) that re-runs the module
// with the env we just set.
const { dataDir, stackDbPath } = await import(
  `@/lib/paths?test=${Date.now()}`,
);

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.STACK_DATA_DIR;
  else process.env.STACK_DATA_DIR = originalDataDir;
  rmSync(testDataDir, { recursive: true, force: true });
});

test("the suite runs against a temp data dir", () => {
  const dataDir = process.env.STACK_DATA_DIR;
  expect(dataDir).toBeDefined();
  expect(realpathSync(dataDir as string).startsWith(realpathSync(tmpdir()))).toBe(true);
});

test("dataDir is the STACK_DATA_DIR dir and is private", () => {
  expect(dataDir).toBe(testDataDir);
  expect(existsSync(dataDir)).toBe(true);
  expect(statSync(dataDir).mode & 0o777).toBe(0o700);
});

test("stackDbPath is stack.db under the data dir", () => {
  expect(stackDbPath.startsWith(`${dataDir}/`)).toBe(true);
  expect(stackDbPath.endsWith("stack.db")).toBe(true);
});
