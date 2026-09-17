#!/usr/bin/env bun
import { chromium } from "playwright";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SCREEN_DIR = join(ROOT, "docs/assets/screens");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(url + "/healthz")).ok) return; } catch { /* The daemon may still be starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The Stack did not become healthy.");
}

async function main(): Promise<void> {
  mkdirSync(SCREEN_DIR, { recursive: true });
  for (const name of ["setup-1.png", "setup-2.png", "setup-3.png", "setup-4.png"]) rmSync(join(SCREEN_DIR, name), { force: true });
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), "maipai-stack-screenshot-"));
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = Bun.spawn(["bun", "run", "src/index.ts"], { cwd: join(ROOT, "backend"), env: { ...process.env, PORT: String(port), STACK_DATA_DIR: dataDir, STACK_SCRIPTED_ENGINES: "1", NODE_ENV: "development" }, stdout: "ignore", stderr: "pipe" });
  try {
    await waitForHealth(baseUrl);
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ colorScheme: "light", viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      await page.goto(baseUrl + "/", { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "Your local AI board" }).waitFor();
      await page.getByText("The Stack measures this machine before it chooses a plan.").waitFor();
      await page.getByRole("heading", { name: "Add abilities" }).waitFor();
      await page.screenshot({ path: join(SCREEN_DIR, "welcome.png"), fullPage: true });
      await page.screenshot({ path: join(SCREEN_DIR, "sizer.png"), fullPage: true });

      await page.getByRole("button", { name: "Install" }).click();
      await page.getByRole("heading", { name: "Downloads" }).waitFor();
      await page.getByText("This is your internet speed.").waitFor();
      await page.screenshot({ path: join(SCREEN_DIR, "board-light.png"), fullPage: true });
      await page.getByRole("button", { name: "Try it" }).waitFor({ timeout: 30_000 });

      const storageState = await context.storageState();
      await context.close();
      const dark = await browser.newContext({ colorScheme: "dark", storageState, viewport: { width: 1440, height: 1000 } });
      const darkPage = await dark.newPage();
      await darkPage.goto(baseUrl + "/", { waitUntil: "domcontentloaded" });
      await darkPage.getByRole("heading", { name: "Your local AI board" }).waitFor();
      await darkPage.screenshot({ path: join(SCREEN_DIR, "board-dark.png"), fullPage: true });
      await dark.close();
      const phone = await browser.newContext({ colorScheme: "light", storageState, viewport: { width: 400, height: 900 } });
      const phonePage = await phone.newPage();
      await phonePage.goto(baseUrl + "/", { waitUntil: "domcontentloaded" });
      await phonePage.getByRole("heading", { name: "Your local AI board" }).waitFor();
      await phonePage.screenshot({ path: join(SCREEN_DIR, "board-phone.png"), fullPage: true });
      await phone.close();
    } finally { await browser.close(); }
  } finally { server.kill(); await server.exited; rmSync(dataDir, { recursive: true, force: true }); }
}

await main();
