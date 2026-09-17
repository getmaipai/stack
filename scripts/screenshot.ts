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
    try {
      if ((await fetch(url + "/healthz")).ok) return;
    } catch {
      // The daemon may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The Stack did not become healthy.");
}

async function main(): Promise<void> {
  mkdirSync(SCREEN_DIR, { recursive: true });
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), "maipai-stack-screenshot-"));
  const baseUrl = "http://127.0.0.1:" + port;
  const server = Bun.spawn(["bun", "run", "src/index.ts"], {
    cwd: join(ROOT, "backend"),
    env: { ...process.env, PORT: String(port), STACK_DATA_DIR: dataDir, STACK_SCRIPTED_ENGINES: "1", NODE_ENV: "development" },
    stdout: "ignore",
    stderr: "pipe",
  });

  try {
    await waitForHealth(baseUrl);
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ colorScheme: "light", viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      await page.goto(baseUrl + "/", { waitUntil: "domcontentloaded" });
      await page.getByText("Welcome to MaiPai Stack").waitFor();
      await page.screenshot({ path: join(SCREEN_DIR, "setup-1.png"), fullPage: true });

      await page.getByRole("button", { name: "Continue" }).click();
      await page.locator("section").getByText("Your login").waitFor();
      await page.screenshot({ path: join(SCREEN_DIR, "setup-2.png"), fullPage: true });

      await page.getByLabel("Operator password").fill("correct horse battery staple");
      await page.getByRole("button", { name: "Continue" }).click();
      await page.locator("section").getByText("This computer", { exact: true }).waitFor();
      await page.getByText("Proposed profile").waitFor();
      await page.screenshot({ path: join(SCREEN_DIR, "setup-3.png"), fullPage: true });

      await page.getByRole("button", { name: "Continue" }).click();
      await page.locator("section").getByText("Ready", { exact: true }).waitFor();
      await page.screenshot({ path: join(SCREEN_DIR, "setup-4.png"), fullPage: true });

      await page.getByRole("button", { name: "Open the board" }).click();
      await page.getByRole("heading", { name: "Your local AI board" }).waitFor();
      await page.getByText("Ready, 62 GB loaded").first().waitFor();
      await page.screenshot({ path: join(SCREEN_DIR, "board-light.png"), fullPage: true });

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
    } finally {
      await browser.close();
    }
  } finally {
    server.kill();
    await server.exited;
    rmSync(dataDir, { recursive: true, force: true });
  }
}

await main();
