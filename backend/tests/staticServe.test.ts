import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "@/app";

const distDir = join(import.meta.dir, "../../frontend/dist");
const indexPath = join(distDir, "index.html");
const hadIndex = existsSync(indexPath);
const originalIndex = hadIndex ? readFileSync(indexPath, "utf8") : null;

afterEach(() => {
  if (originalIndex === null) {
    if (existsSync(indexPath)) unlinkSync(indexPath);
    if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });
  } else {
    mkdirSync(distDir, { recursive: true });
    writeFileSync(indexPath, originalIndex);
  }
});

test("GET / is a plain message before the frontend is built", async () => {
  if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });
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
