#!/usr/bin/env bun
import { chromium } from "playwright";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SCREEN_DIR = join(ROOT, "docs/assets/screens");
const showroom = process.argv.includes("--showroom");
async function freePort(): Promise<number> { return new Promise((resolve, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); const port = typeof address === "object" && address ? address.port : 0; server.close((error) => error ? reject(error) : resolve(port)); }); }); }
async function waitForHealth(url: string): Promise<void> { const deadline = Date.now() + 15_000; while (Date.now() < deadline) { try { if ((await fetch(url + "/healthz")).ok) return; } catch { /* starting */ } await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("The Stack did not become healthy."); }
async function captureTry(page: import("playwright").Page, url: string, path: string): Promise<void> { await page.goto(url, { waitUntil: "networkidle" }); await page.locator("h2").filter({ hasText: "Try it" }).waitFor(); await page.getByRole("tab", { name: "Chat" }).waitFor(); await page.getByRole("textbox", { name: "Message" }).fill("Say hello in one sentence"); await page.getByRole("button", { name: "Send" }).click(); await page.getByText("Scripted Stack").waitFor(); await page.screenshot({ path, fullPage: true }); }
async function captureShowroom(page: import("playwright").Page, url: string, route: string, heading: string, path: string): Promise<void> { await page.goto(`${url}${route}`, { waitUntil: "domcontentloaded" }); await page.getByText(heading, { exact: true }).first().waitFor(); await page.screenshot({ path, fullPage: true }); }
async function main(): Promise<void> {
  mkdirSync(SCREEN_DIR, { recursive: true });
  const port = await freePort(); const dataDir = mkdtempSync(join(tmpdir(), showroom ? "maipai-stack-showroom-" : "maipai-stack-try-")); const baseUrl = `http://127.0.0.1:${port}`;
  const server = Bun.spawn(["bun", "run", "src/index.ts"], { cwd: join(ROOT, "backend"), env: { ...process.env, PORT: String(port), STACK_DATA_DIR: dataDir, STACK_SCRIPTED_ENGINES: "1", ...(showroom ? { STACK_SHOWROOM: "1" } : {}), NODE_ENV: "development" }, stdout: "ignore", stderr: "pipe" });
  try { await waitForHealth(baseUrl); const browser = await chromium.launch({ headless: true }); try { if (showroom) { const context = await browser.newContext({ colorScheme: "light", viewport: { width: 1440, height: 1000 } }); const page = await context.newPage(); await captureShowroom(page, baseUrl, "/", "Your local AI board", join(SCREEN_DIR, "showroom-overview.png")); await captureShowroom(page, baseUrl, "/engines", "Engines", join(SCREEN_DIR, "showroom-engines.png")); await captureShowroom(page, baseUrl, "/models", "Models", join(SCREEN_DIR, "showroom-models.png")); await context.close(); } else { const light = await browser.newContext({ colorScheme: "light", viewport: { width: 1440, height: 1000 } }); const lightPage = await light.newPage(); await captureTry(lightPage, baseUrl + "/try", join(SCREEN_DIR, "try-chat-light.png")); await light.close(); const dark = await browser.newContext({ colorScheme: "dark", viewport: { width: 1440, height: 1000 } }); const darkPage = await dark.newPage(); await captureTry(darkPage, baseUrl + "/try", join(SCREEN_DIR, "try-chat-dark.png")); await dark.close(); const phone = await browser.newContext({ colorScheme: "light", viewport: { width: 400, height: 900 } }); const phonePage = await phone.newPage(); await captureTry(phonePage, baseUrl + "/try", join(SCREEN_DIR, "try-chat-phone.png")); await phone.close(); } } finally { await browser.close(); } } finally { server.kill(); await server.exited; rmSync(dataDir, { recursive: true, force: true }); }
}
await main();
