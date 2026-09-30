import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { ENGINE_BINARIES, ENGINE_READY_MARKER } from "@/lib/engineCatalog";
import { engineDir } from "@/lib/engineInstall";
import { __resetHealthForTests, raise } from "@/lib/health";

let tempRoot = "";
let originalDataDir: string | undefined;
let originalFetch: typeof fetch;
let originalArchive: (typeof ENGINE_BINARIES)[number]["archive"];
const bytes = Buffer.from("test binary");
const digest = createHash("sha256").update(bytes).digest("hex");
const target = ENGINE_BINARIES.find((pin) => pin.name === "gguf-parser" && pin.platform === process.platform && pin.arch === process.arch && !pin.requiresNvidia)!;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "stack-health-fix-"));
  originalDataDir = process.env.STACK_DATA_DIR;
  process.env.STACK_DATA_DIR = tempRoot;
  originalFetch = globalThis.fetch;
  originalArchive = target.archive;
  target.archive = { label: "test binary", url: "https://fake.invalid/gguf-parser", sha256: digest, approxBytes: bytes.length, rawFileName: "gguf-parser" };
  __resetHealthForTests();
});
afterEach(() => {
  target.archive = originalArchive;
  globalThis.fetch = originalFetch;
  if (originalDataDir === undefined) delete process.env.STACK_DATA_DIR;
  else process.env.STACK_DATA_DIR = originalDataDir;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("the reinstall fix installs the selected pin, marks it ready, and resolves the item", async () => {
  globalThis.fetch = Object.assign(async () => new Response(bytes), { preconnect: originalFetch.preconnect });
  raise({ code: "engine-missing.gguf-parser", severity: "warning", title: "Missing", text: "Missing", cause: "Not installed", fix: { label: "Install", action: "reinstall_engine" } });
  const response = await app.request("/stack/v1/health/engine-missing.gguf-parser/fix", { method: "POST" });
  expect(await response.json()).toMatchObject({ ok: true, result: "The model size checker was installed." });
  expect(existsSync(join(engineDir(target), ENGINE_READY_MARKER))).toBe(true);
  const active = await (await app.request("/stack/v1/health")).json() as { health: Array<{ code: string }> };
  expect(active.health.some((item) => item.code === "engine-missing.gguf-parser")).toBe(false);
});

test("an unknown engine name returns the fix failure shape", async () => {
  raise({ code: "engine-missing.nope", severity: "warning", title: "Missing", text: "Missing", cause: "Not installed", fix: { label: "Install", action: "reinstall_engine" } });
  const response = await app.request("/stack/v1/health/engine-missing.nope/fix", { method: "POST" });
  expect(await response.json()).toMatchObject({ ok: false, result: expect.any(String) });
});

test("a failed download returns its error", async () => {
  globalThis.fetch = Object.assign(async () => { throw new Error("GET https://fake.invalid/gguf-parser returned 404"); }, { preconnect: originalFetch.preconnect });
  raise({ code: "engine-missing.gguf-parser", severity: "warning", title: "Missing", text: "Missing", cause: "Not installed", fix: { label: "Install", action: "reinstall_engine" } });
  const response = await app.request("/stack/v1/health/engine-missing.gguf-parser/fix", { method: "POST" });
  expect(await response.json()).toMatchObject({ ok: false, result: "GET https://fake.invalid/gguf-parser returned 404" });
});
