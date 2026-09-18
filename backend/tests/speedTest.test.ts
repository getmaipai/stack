import { afterEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetHealthForTests, list as listHealth, raise } from "@/lib/health";
import { applySpeedRegression, llamaBenchArgs, parseLlamaBenchOutput } from "@/lib/speedTest";

afterEach(() => __resetHealthForTests());

const originalShowroom = process.env.STACK_SHOWROOM;
const originalNodeEnv = process.env.NODE_ENV;
afterEach(() => {
  if (originalShowroom === undefined) delete process.env.STACK_SHOWROOM; else process.env.STACK_SHOWROOM = originalShowroom;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalNodeEnv;
});

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

test("the operator speed-test route returns the showroom record", async () => {
  process.env.STACK_SHOWROOM = "1";
  process.env.NODE_ENV = "development";
  const response = await app.request("/stack/v1/speed-test", { method: "POST" });
  const body = await response.json() as { result?: { promptTps?: number; tokensPerSecond?: number; measuredFootprintBytes?: number } };
  expect(response.status).toBe(200);
  expect(body.result?.promptTps).toBe(112);
  expect(body.result?.tokensPerSecond).toBe(52);
  expect(body.result?.measuredFootprintBytes).toBe(21_600_000_000);
});
