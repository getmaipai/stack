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

test("missing assets answer 404, never the SPA shell", async () => {
  mkdirSync(distDir, { recursive: true });
  writeFileSync(indexPath, "<!doctype html><title>Stack test</title>");
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(assetsPath, "body { color: red; }");

  const missingPng = await app.request("/nope.png");
  expect(missingPng.status).toBe(404);
  const missingIco = await app.request("/favicon.ico");
  expect(missingIco.status).toBe(404);
  const missingJs = await app.request("/assets/nope.js");
  expect(missingJs.status).toBe(404);
});

test("assets are served with the right content type", async () => {
  mkdirSync(distDir, { recursive: true });
  writeFileSync(indexPath, "<!doctype html><title>Stack test</title>");
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(assetsPath, "body { color: red; }");
  const iconPath = join(distDir, "favicon.ico");
  writeFileSync(iconPath, "icon bytes");

  const asset = await app.request("/assets/style.css");
  expect(asset.status).toBe(200);
  expect(asset.headers.get("content-type")).toContain("text/css");
  expect(await asset.text()).toBe("body { color: red; }");

  const icon = await app.request("/favicon.ico");
  expect(icon.status).toBe(200);
  expect(icon.headers.get("content-type")).toContain("image/x-icon");
  expect(await icon.text()).toBe("icon bytes");
});

test("index is revalidated and assets are cached immutable", async () => {
  mkdirSync(distDir, { recursive: true });
  writeFileSync(indexPath, "<!doctype html><title>Stack test</title>");
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(assetsPath, "body { color: red; }");

  const root = await app.request("/");
  expect(root.status).toBe(200);
  expect(root.headers.get("cache-control")).toBe("no-cache");

  const index = await app.request("/index.html");
  expect(index.status).toBe(200);
  expect(index.headers.get("cache-control")).toBe("no-cache");

  const route = await app.request("/setup");
  expect(route.status).toBe(200);
  expect(route.headers.get("cache-control")).toBe("no-cache");

  const asset = await app.request("/assets/style.css");
  expect(asset.status).toBe(200);
  expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
});
