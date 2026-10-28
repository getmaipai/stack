import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SPLASH_CHAT_PIN, SPLASH_PIN, CHAT_ENGINES, engineNameTag } from "@/lib/engineCatalog";
import { CHAT_ENGINE_CHOICES, chatEngineFailure, clearChatEngineFailures, markChatEngineFailed, requestedChatEngine, resolveChatEngine } from "@/lib/chatEngines";
import { STACK_CHAT_QWEN38_UNCENSORED_MODEL, STACK_CODING_DRAFT_MODEL } from "@/lib/modelCatalog";
import { clearModelsForTests, getModel, upsertModel } from "@/lib/modelStore";
import { engineDir } from "@/lib/engineInstall";
import { applyPendingSettings, __resetSettingsForTests, updateSettings } from "@/settings";
import { SplashChatClient, resetSupervisorForTests, setCodingMachineFacts, setMachineTier, splashLaunchPlan, type EngineClient } from "@/lib/supervisor";
import { splashHubDir, splashHomeDir, splashRoot, splashTmpDir } from "@/lib/splashStore";
import { __setAppleChipForTests } from "@/lib/hardware";
import { __resetHealthForTests, list as listHealth } from "@/lib/health";

const verified = { source: "catalog" as const, provenance: { repo: "huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF" }, revision: STACK_CHAT_QWEN38_UNCENSORED_MODEL.revision!, sha256: STACK_CHAT_QWEN38_UNCENSORED_MODEL.download!.sha256, licence: "Apache-2.0", verifiedAt: new Date().toISOString() };
function sparse(path: string, size: number) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, ""); truncateSync(path, size); }
function installModel(pin: typeof STACK_CHAT_QWEN38_UNCENSORED_MODEL | typeof STACK_CODING_DRAFT_MODEL) {
  const modelPath = join(splashRoot(), "fixture", pin.id);
  if (pin.download?.files) for (const file of pin.download.files) sparse(join(modelPath, file.path), file.bytes);
  else sparse(modelPath, pin.download!.approx_bytes);
  upsertModel({ id: pin.id, roles: [pin.role], ...verified, revision: pin.revision!, sha256: pin.download!.sha256, sizeBytes: pin.download!.approx_bytes, modelPath, engineRequirements: { engine: pin.engine, launch: pin.launch, sampling: pin.sampling } });
  return modelPath;
}
function installChatEngine() {
  const root = engineDir(SPLASH_CHAT_PIN);
  mkdirSync(join(root, "engine"), { recursive: true });
  writeFileSync(join(root, "engine", "splash"), "#!/bin/sh\nexit 0\n");
  mkdirSync(join(root, "python", "bin"), { recursive: true });
  writeFileSync(join(root, "python", "bin", "python3"), "#!/bin/sh\nexit 0\n");
  mkdirSync(join(root, "install"), { recursive: true });
  writeFileSync(join(root, "install", "launcher.py"), "");
  writeFileSync(join(root, ".engine-ready"), "ok");
}
beforeEach(() => {
  clearModelsForTests(); clearChatEngineFailures(); __resetSettingsForTests(); __resetHealthForTests(); resetSupervisorForTests();
  setMachineTier("p64"); setCodingMachineFacts({ platform: "darwin", arch: "arm64", chipGeneration: 3, chipName: "Apple M3", memoryGb: 64, osVersion: "26.4" }); __setAppleChipForTests({ generation: 3, name: "Apple M3" });
});
afterEach(() => { resetSupervisorForTests(); clearModelsForTests(); clearChatEngineFailures(); __resetSettingsForTests(); setMachineTier(null); setCodingMachineFacts(null); rmSync(splashRoot(), { recursive: true, force: true }); rmSync(join(engineDir(SPLASH_CHAT_PIN), ".."), { recursive: true, force: true }); });

test("chat engine selection accepts Splash, keeps auto on llama-server and falls back for unsupported, missing, or twice-failed engines", () => {
  expect(CHAT_ENGINE_CHOICES).toContain("splash"); expect(CHAT_ENGINES).toContain("splash");
  expect(requestedChatEngine("auto", "p128")).toBe("llama-server");
  const options = { setting: "splash", tier: "p64" as const, installed: () => true };
  expect(resolveChatEngine(options).engine).toBe("splash");
  expect(resolveChatEngine({ ...options, unsupported: () => "Splash chat needs an M3 chip or newer." })).toMatchObject({ engine: "llama-server", requested: "splash" });
  expect(resolveChatEngine({ ...options, installed: () => false }).engine).toBe("llama-server");
  expect(markChatEngineFailed("splash", "load failed")).toBe(1); expect(resolveChatEngine(options).engine).toBe("splash");
  expect(markChatEngineFailed("splash", "load failed")).toBe(2); expect(resolveChatEngine(options).engine).toBe("llama-server");
  expect(chatEngineFailure("splash")?.count).toBe(2);
});

test("the 1.4.1 chat pin is separate from the unchanged coding fork and version tags stage cleanly", () => {
  expect(SPLASH_CHAT_PIN).toMatchObject({ id: "splash-1.4.1-macos-arm64", name: "splash-chat", tag: "1.4.1", tool: "engine/splash", archive: { url: "https://github.com/incoai/splash/releases/download/1.4.1/splash-1.4.1-arm64-macos26.tar.gz", sha256: "5746068dc652a4998267d55b1c6d59b545f1bc1e018131c6d8025022f7000d5c", approxBytes: 78_669_011 } });
  expect(SPLASH_PIN.tag).toBe("1.3.2-ornith.1"); expect(engineNameTag("splash-chat-1.4.1")).toEqual({ name: "splash-chat", tag: "1.4.1" });
});

test("Splash chat launch uses pinned target and draft, offline args, bounded cache and empties the cache", () => {
  const modelPath = installModel(STACK_CHAT_QWEN38_UNCENSORED_MODEL); installModel(STACK_CODING_DRAFT_MODEL); installChatEngine();
  const cache = splashTmpDir(); mkdirSync(cache, { recursive: true }); writeFileSync(join(cache, "old-prefix"), "cached");
  updateSettings({ "stack.engines.chat.splash_cache_gb": 64, "stack.engines.chat.thinking_budget_ceiling": 1500 }); applyPendingSettings();
  const model = getModel(STACK_CHAT_QWEN38_UNCENSORED_MODEL.id)!;
  const plan = splashLaunchPlan(model, 8812, 65_536, "splash-chat");
  expect(plan.engine).toBe("splash-chat"); expect(plan.build).toBe("1.4.1"); expect(plan.identity?.build).toBe("splash-1.4.1"); expect(plan.identity?.model).toBe(modelPath.split("/").pop());
  expect(plan.command).toContain("--offline"); expect(plan.command).toContain("--max-context"); expect(plan.command).toContain("65536"); expect(plan.command).toContain("--thinking-token-budget"); expect(plan.command).toContain("1500"); expect(plan.command).toContain("--max-cache-disk"); expect(plan.command).toContain("64G");
  expect(plan.env).toMatchObject({ HF_HUB_OFFLINE: "1", DO_NOT_TRACK: "1", HF_HUB_CACHE: splashHubDir(), HOME: splashHomeDir(), TMPDIR: splashTmpDir() });
  expect(existsSync(join(cache, "old-prefix"))).toBe(false);
  expect(plan.command).toContain("--language-only");
});

test("Splash chat client preserves streaming/tool/usage fields, reasoning split and cancellation while forcing the pinned sampling and thinking ceiling inputs", async () => {
  const seen: Array<{ path: string; body: Record<string, unknown>; stream: boolean }> = [];
  const inner: EngineClient = {
    baseUrl: "http://127.0.0.1:8",
    request: async (path, body) => {
      seen.push({ path, body, stream: false });
      return { status: 200, body: { choices: [{ message: { content: "answer", reasoning_content: "thought", tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: "{}" } }] } }], usage: { prompt_tokens: 12, prompt_tokens_details: { cached_tokens: 8 } } } };
    },
    stream: async (path, body, signal) => {
      seen.push({ path, body, stream: true });
      if (signal?.aborted) throw new DOMException("cancelled", "AbortError");
      return new Response('data: {"choices":[{"delta":{"reasoning_content":"thought","content":"answer","tool_calls":[{"index":0,"function":{"name":"lookup","arguments":"{}"}}]}}]}\n\ndata: {"usage":{"prompt_tokens":12,"prompt_tokens_details":{"cached_tokens":8}}}\n\n', { headers: { "content-type": "text/event-stream" } });
    },
    health: async () => true,
  };
  const client = new SplashChatClient(inner, "huihui", { temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5, thinking_budget_ceiling: 2000, source: "catalog" });
  const body = { model: "chat", messages: [], temperature: 0.1, thinking_budget_tokens: 9999, max_tokens: 4000 };
  const result = await client.request("/v1/chat/completions", body);
  expect((result.body as { choices: Array<{ message: { reasoning_content: string; content: string; tool_calls: unknown[] } }>; usage: { prompt_tokens_details: { cached_tokens: number } } }).choices[0]!.message).toMatchObject({ reasoning_content: "thought", content: "answer", tool_calls: [{ id: "c1" }] });
  expect((result.body as { usage: { prompt_tokens_details: { cached_tokens: number } } }).usage.prompt_tokens_details.cached_tokens).toBe(8);
  expect(seen[0]!.body).toMatchObject({ temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5, model: "huihui", thinking_budget_tokens: 2000 });
  const minor = { model: "chat", messages: [], reasoning_effort: "none", thinking_budget_tokens: 9000 };
  await client.request("/v1/chat/completions", minor);
  expect(seen[1]!.body).toMatchObject({ reasoning_effort: "none", thinking_budget_tokens: 2000, chat_template_kwargs: { enable_thinking: false } });
  const streamed = await client.stream("/v1/chat/completions", body); expect(streamed.headers.get("content-type")).toContain("text/event-stream");
  const text = await streamed.text(); expect(text).toContain("reasoning_content"); expect(text).toContain("tool_calls"); expect(text).toContain("cached_tokens");
  const controller = new AbortController(); controller.abort(); await expect(client.stream("/v1/chat/completions", body, controller.signal)).rejects.toThrow();
});

