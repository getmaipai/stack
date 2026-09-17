#!/usr/bin/env bun
import { chromium } from "playwright";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SCREEN_DIR = join(ROOT, "docs/assets/screens");

async function freePort(): Promise<number> { return new Promise((resolve, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); const port = typeof address === "object" && address ? address.port : 0; server.close((error) => error ? reject(error) : resolve(port)); }); }); }
async function waitForHealth(url: string): Promise<void> { const deadline = Date.now() + 15_000; while (Date.now() < deadline) { try { if ((await fetch(url + "/healthz")).ok) return; } catch { /* starting */ } await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("The Stack did not become healthy."); }
async function main(): Promise<void> {
  mkdirSync(SCREEN_DIR, { recursive: true });
  for (const name of ["welcome.png", "sizer.png", "board-light.png", "board-dark.png", "board-phone.png", "overview.png", "overview-dark.png", "overview-phone.png", "models.png", "monitoring.png", "alerts.png", "access.png", "palette.png", "palette-dark.png", "palette-phone.png"]) rmSync(join(SCREEN_DIR, name), { force: true });
  const port = await freePort(); const dataDir = mkdtempSync(join(tmpdir(), "maipai-stack-dashboard-")); const baseUrl = `http://127.0.0.1:${port}`;
  const server = Bun.spawn(["bun", "run", "src/index.ts"], { cwd: join(ROOT, "backend"), env: { ...process.env, PORT: String(port), STACK_DATA_DIR: dataDir, STACK_SCRIPTED_ENGINES: "1", NODE_ENV: "development" }, stdout: "ignore", stderr: "pipe" });
  try {
    await waitForHealth(baseUrl); const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ colorScheme: "light", viewport: { width: 1440, height: 1000 } }); const page = await context.newPage();
      for (const [path, name] of [["/", "overview"], ["/models", "models"], ["/monitoring", "monitoring"], ["/alerts", "alerts"], ["/access", "access"]] as const) { await page.goto(baseUrl + path, { waitUntil: "networkidle" }); await page.screenshot({ path: join(SCREEN_DIR, `${name}.png`), fullPage: true }); }
      await page.goto(baseUrl + "/", { waitUntil: "networkidle" }); await page.getByRole("button", { name: /Search Stack/ }).click(); await page.locator('[cmdk-item]').first().waitFor(); await page.screenshot({ path: join(SCREEN_DIR, "palette.png"), fullPage: true });
      await context.close();
      for (const [scheme, size, name] of [["dark", { width: 1440, height: 1000 }, "overview-dark"], ["light", { width: 400, height: 900 }, "overview-phone"]] as const) { const variant = await browser.newContext({ colorScheme: scheme, viewport: size }); const variantPage = await variant.newPage(); await variantPage.goto(baseUrl + "/", { waitUntil: "networkidle" }); await variantPage.screenshot({ path: join(SCREEN_DIR, `${name}.png`), fullPage: true }); await variant.close(); }
      for (const [scheme, size, name] of [["dark", { width: 1440, height: 1000 }, "palette-dark"], ["light", { width: 400, height: 900 }, "palette-phone"]] as const) { const variant = await browser.newContext({ colorScheme: scheme, viewport: size }); const variantPage = await variant.newPage(); await variantPage.goto(baseUrl + "/", { waitUntil: "networkidle" }); await variantPage.getByRole("button", { name: /Search Stack/ }).click(); await variantPage.locator('[cmdk-item]').first().waitFor(); await variantPage.screenshot({ path: join(SCREEN_DIR, `${name}.png`), fullPage: true }); await variant.close(); }
    } finally { await browser.close(); }
  } finally { server.kill(); await server.exited; rmSync(dataDir, { recursive: true, force: true }); }
}
await main();
