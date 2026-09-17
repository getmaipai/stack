import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalDistDir = process.env.STACK_DIST_DIR;
const distDir = mkdtempSync(join(tmpdir(), "maipai-stack-dist-"));
process.env.STACK_DIST_DIR = distDir;
const indexPath = join(distDir, "index.html");
const assetsDir = join(distDir, "assets");
const assetsPath = join(assetsDir, "style.css");

beforeEach(() => {
  rmSync(distDir, { recursive: true, force: true });
});

afterAll(() => {
  if (originalDistDir === undefined) delete process.env.STACK_DIST_DIR;
  else process.env.STACK_DIST_DIR = originalDistDir;
  rmSync(distDir, { recursive: true, force: true });
});

const { app } = await import("@/app");

test("GET / is a plain message before the frontend is built", async () => {
  const response = await app.request("/");
  expect(response.status).toBe(503);
  expect(await response.text()).toBe("UI not built");
});

test("GET / serves the built index and client routes fall back to it", async () => {
  mkdirSync(distDir, { recursive: true });
  writeFileSync(indexPath, "<!doctype html><title>Stack test</title>");

  const root = await app.request("/");
  expect(root.status).toBe(200);
  expect(await root.text()).toContain("Stack test");

  const route = await app.request("/setup");
  expect(route.status).toBe(200);
  expect(await route.text()).toContain("Stack test");
});

test("assets are served with the right content type", async () => {
  mkdirSync(distDir, { recursive: true });
  writeFileSync(indexPath, "<!doctype html><title>Stack test</title>");
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(assetsPath, "body { color: red; }");

  const asset = await app.request("/assets/style.css");
  expect(asset.status).toBe(200);
  expect(asset.headers.get("content-type")).toContain("text/css");
  expect(await asset.text()).toBe("body { color: red; }");
});
