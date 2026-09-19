import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { app } from "@/app";
import { engineDir } from "@/lib/engineInstall";
import { installedEnginePin } from "@/lib/engineCatalog";
import type { ModelRecord } from "@/lib/modelStore";
import { __resetHealthForTests, list as listHealth, raise } from "@/lib/health";
import { applySpeedRegression, llamaBenchArgs, parseLlamaBenchOutput, runSpeedTest } from "@/lib/speedTest";
import { __resetOperatorForTests } from "@/lib/operator";

afterEach(() => __resetHealthForTests());
afterEach(() => __resetOperatorForTests());

const originalShowroom = process.env.STACK_SHOWROOM;
const originalNodeEnv = process.env.NODE_ENV;
const originalDataDir = process.env.STACK_DATA_DIR;
const testDirs: string[] = [];
afterEach(() => {
  if (originalShowroom === undefined) delete process.env.STACK_SHOWROOM; else process.env.STACK_SHOWROOM = originalShowroom;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalNodeEnv;
  if (originalDataDir === undefined) delete process.env.STACK_DATA_DIR; else process.env.STACK_DATA_DIR = originalDataDir;
  for (const dir of testDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const benchModel: ModelRecord = {
  id: "bench-model",
  nickname: null,
  groupId: null,
  roles: ["chat"],
  source: "catalog",
  provenance: {},
  revision: "test",
  sha256: "test",
  sizeBytes: 1,
  licence: "test",
  engineRequirements: {},
  installedAt: new Date().toISOString(),
  verifiedAt: new Date().toISOString(),
  hostIdentity: null,
  firstBootAt: new Date().toISOString(),
  modelPath: "/models/bench.gguf",
  measuredFootprintBytes: null,
  measuredContextLength: 4096,
};

test("parses llama-bench JSON prompt and generation rows", () => {
  const result = parseLlamaBenchOutput(JSON.stringify([
    { n_prompt: 512, n_gen: 0, avg_ts: 612.4 },
    { n_prompt: 0, n_gen: 128, avg_ts: 44.2 },
  ]));
  expect(result).toEqual({ promptTps: 612.4, tokensPerSecond: 44.2 });
  expect(llamaBenchArgs("/models/chat.gguf")).toEqual(["-m", "/models/chat.gguf", "-p", "512", "-n", "128", "-r", "3", "-o", "json"]);
});

test("a speed drop past ten percent raises a rollback health item", () => {
  applySpeedRegression(
    { at: "2026-09-18T00:00:00.000Z", ability: "chat", modelId: "chat", engine: "b10797", firstTokenMs: 120, loadMs: 900, measuredFootprintBytes: 1_000, promptTps: 500, tokensPerSecond: 44, contextLength: 4096 },
    { at: "2026-09-18T01:00:00.000Z", ability: "chat", modelId: "chat", engine: "b11026", firstTokenMs: 140, loadMs: 1000, measuredFootprintBytes: 1_000, promptTps: 490, tokensPerSecond: 38, contextLength: 4096 },
  );
  expect(listHealth()[0]).toMatchObject({ severity: "warning", text: "Chat got slower after engine b11026: 38 tokens per second, was 44.", fix: { label: "Go back", action: "rollback_engine" } });
});

test("an equal speed result does not leave a regression item", () => {
  raise({ code: "speed-regression.chat.4096", severity: "warning", title: "Chat got slower", text: "old", cause: "old", fix: { label: "Go back", action: "rollback_engine" } });
  applySpeedRegression(
    { at: "2026-09-18T00:00:00.000Z", ability: "chat", modelId: "chat", engine: "b10797", firstTokenMs: 120, loadMs: 900, measuredFootprintBytes: 1_000, promptTps: 500, tokensPerSecond: 44, contextLength: 4096 },
    { at: "2026-09-18T01:00:00.000Z", ability: "chat", modelId: "chat", engine: "b11026", firstTokenMs: 120, loadMs: 900, measuredFootprintBytes: 1_000, promptTps: 500, tokensPerSecond: 44, contextLength: 4096 },
  );
  expect(listHealth()).toEqual([]);
});

test("the speed runner finds llama-bench in the pinned tag without a current link", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "maipai-speed-bench-"));
  testDirs.push(dataDir);
  process.env.STACK_DATA_DIR = dataDir;
  const pin = installedEnginePin();
  expect(pin).not.toBeNull();
  const directory = engineDir(pin!.id);
  mkdirSync(directory, { recursive: true });
  const executable = join(directory, pin!.platform === "win32" ? "llama-bench.exe" : "llama-bench");
  writeFileSync(executable, '#!/bin/sh\nprintf \'%s\\n\' \'[{"n_prompt":512,"n_gen":0,"avg_ts":612.4},{"n_prompt":0,"n_gen":128,"avg_ts":44.2}]\'');
  chmodSync(executable, 0o755);
  expect(existsSync(join(dataDir, "engines", "llama-server", "current"))).toBe(false);
  const result = await runSpeedTest(benchModel, { repetitions: 1 });
  expect(result.promptTps).toBe(612);
  expect(result.tokensPerSecond).toBe(44);
  expect(result.engine).toMatch(/^b\d+$/);
});

test("the operator speed-test route returns the showroom record", async () => {
  process.env.STACK_SHOWROOM = "1";
  process.env.NODE_ENV = "development";
  const setup = await app.request("/stack/v1/operator/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct horse battery staple" }) });
  const response = await app.request("/stack/v1/speed-test", { method: "POST", headers: { cookie: setup.headers.get("set-cookie")!.split(";", 1)[0]! } });
  const body = await response.json() as { result?: { promptTps?: number; tokensPerSecond?: number; measuredFootprintBytes?: number } };
  expect(response.status).toBe(200);
  expect(body.result?.promptTps).toBe(112);
  expect(body.result?.tokensPerSecond).toBe(52);
  expect(body.result?.measuredFootprintBytes).toBe(21_600_000_000);
});
