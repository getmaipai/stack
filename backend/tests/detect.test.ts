import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { clearDetectedForTests, detectAll, DETECTION_ADDRESSES, forgetDetected, listDetected, adoptDetected } from "@/lib/detect";
import { __resetHealthForTests, list as listHealth } from "@/lib/health";
import { clearModelsForTests, listModels } from "@/lib/modelStore";
import { resetSupervisorForTests, stopChatEngine } from "@/lib/supervisor";

const originalFetch = globalThis.fetch;
const originalScripted = process.env.STACK_SCRIPTED_ENGINES;

function scriptedFetch(version: string, completion = false): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith("/api/version")) return Response.json({ version });
    if (url.endsWith("/health")) return Response.json({ status: "ok" });
    if (url.endsWith("/props")) return Response.json({ build_info: "ollama-test", model_path: "/models/ollama.gguf" });
    if (completion && url.endsWith("/v1/chat/completions")) return Response.json({ choices: [{ message: { content: "hello" } }], usage: { prompt_tokens: 2, completion_tokens: 3 } });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

beforeEach(() => { clearDetectedForTests(); clearModelsForTests(); __resetHealthForTests(); resetSupervisorForTests(); });
afterEach(async () => { try { await stopChatEngine(); } catch { /* no running engine */ } globalThis.fetch = originalFetch; clearDetectedForTests(); clearModelsForTests(); __resetHealthForTests(); resetSupervisorForTests(); if (originalScripted === undefined) delete process.env.STACK_SCRIPTED_ENGINES; else process.env.STACK_SCRIPTED_ENGINES = originalScripted; });

test("the localhost sweep detects Ollama, adoption binds it, and chat carries its identity", async () => {
  const scripted = scriptedFetch("0.6.0", true); await detectAll(scripted);
  const row = listDetected().find((item) => item.kind === "ollama"); expect(row?.where).toContain("127.0.0.1:11434");
  globalThis.fetch = scripted; await adoptDetected(row!.id, ["chat"]);
  process.env.STACK_SCRIPTED_ENGINES = "0";
  const response = await app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "chat", messages: [{ role: "user", content: "hi" }] }) });
  expect(response.status).toBe(200); expect(response.headers.get("x-maipai-engine")).toBe("local"); expect(response.headers.get("x-maipai-model")).toBe("ollama.gguf");
});

test("a below-floor host raises health, forget hides it, and a changed version returns it", async () => {
  await detectAll(scriptedFetch("0.1.0")); const row = listDetected().find((item) => item.kind === "ollama")!;
  globalThis.fetch = scriptedFetch("0.1.0"); await adoptDetected(row.id, ["chat"]); expect(listHealth().some((item) => item.code === "host.belowTestedVersion")).toBe(true);
  expect(forgetDetected(row.id)).toBe(true); expect(listDetected().some((item) => item.id === row.id)).toBe(false);
  await detectAll(scriptedFetch("0.1.0")); expect(listDetected().some((item) => item.id === row.id)).toBe(false);
  await detectAll(scriptedFetch("0.2.0")); expect(listDetected().some((item) => item.id === row.id)).toBe(true);
});

test("the route exposes a scan and the address list is loopback only", async () => {
  expect(DETECTION_ADDRESSES).toEqual(["127.0.0.1", "::1"]);
  process.env.STACK_SHOWROOM = "1"; process.env.NODE_ENV = "development";
  const response = await app.request("/stack/v1/detected/scan", { method: "POST" }); expect(response.status).toBe(200);
  const body = await response.json() as { detected: unknown[]; found: { tools: number; modelFiles: number }; scannedAt: string | null };
  expect(body.detected.length).toBeGreaterThan(0); expect(body.found).toEqual({ tools: 1, modelFiles: 3 }); expect(body.scannedAt).toBeString();
  delete process.env.STACK_SHOWROOM;
});

test("a detected model folder adopts by link through the import scanner", async () => {
  const home = mkdtempSync(join(tmpdir(), "maipai-detect-home-"));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = home;
    const folder = join(home, ".ollama", "models");
    mkdirSync(folder, { recursive: true });
    const modelPath = join(folder, "model.gguf");
    writeFileSync(modelPath, "detected-model");
    await detectAll(async () => new Response("not found", { status: 404 }));
    const row = listDetected().find((item) => item.kind === "folder");
    expect(row?.where).toBe(folder);
    await adoptDetected(row!.id, ["chat"]);
    const imported = listModels().find((model) => model.id.startsWith("imported-folder-"));
    expect(imported?.roles).toEqual(["chat"]);
    expect(imported?.modelPath).toBeTruthy();
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
