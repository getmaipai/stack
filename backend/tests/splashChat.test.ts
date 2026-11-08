import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SPLASH_CHAT_PIN, SPLASH_PIN, CHAT_ENGINES, engineNameTag } from "@/lib/engineCatalog";
import { llamaServerArgs } from "@/lib/engineArgs";
import { CHAT_ENGINE_CHOICES, chatEngineFailure, clearChatEngineFailures, markChatEngineFailed, requestedChatEngine, resolveChatEngine } from "@/lib/chatEngines";
import { STACK_CHAT_QWEN38_UNCENSORED_MODEL, STACK_CODING_DRAFT_MODEL } from "@/lib/modelCatalog";
import { clearModelsForTests, getModel, upsertModel } from "@/lib/modelStore";
import { engineDir } from "@/lib/engineInstall";
import { applyPendingSettings, __resetSettingsForTests, updateSettings } from "@/settings";
import { SplashChatClient, chatEngine, mapsModelWeights, selectableModels, selectedModel, resetSupervisorForTests, setCodingMachineFacts, setMachineTier, splashLaunchPlan, type EngineClient } from "@/lib/supervisor";
import { splashHubDir, splashHomeDir, splashRoot, splashTmpDir } from "@/lib/splashStore";
import { __setAppleChipForTests } from "@/lib/hardware";
import { __resetHealthForTests, list as listHealth } from "@/lib/health";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, admit, refreshMeasuredPeak, startGovernor, type GovernorHandle } from "@/lib/governor";
import { initializeHomeMode } from "@/lib/homeMode";

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
  initializeHomeMode("normal");
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

test("the 1.6.0 chat pin is separate from the coding pin (same vendor archive) and version tags stage cleanly", () => {
  expect(SPLASH_CHAT_PIN).toMatchObject({ id: "splash-1.6.0-macos-arm64", name: "splash-chat", tag: "1.6.0", tool: "engine/splash", archive: { url: "https://github.com/incoai/splash/releases/download/1.6.0/splash-1.6.0-arm64-macos26.tar.gz", sha256: "da3aef0a581491b0eb4c1168bda07f520e5ca8368764abff426d95ac1c77e5c4", approxBytes: 79_846_781 } });
  expect(SPLASH_PIN.tag).toBe("1.6.0"); expect(engineNameTag("splash-chat-1.6.0")).toEqual({ name: "splash-chat", tag: "1.6.0" });
});

test("Splash chat launch uses pinned target and draft, offline args, the disk cache off and empties the cache", () => {
  const modelPath = installModel(STACK_CHAT_QWEN38_UNCENSORED_MODEL); installModel(STACK_CODING_DRAFT_MODEL); installChatEngine();
  const cache = splashTmpDir(); mkdirSync(cache, { recursive: true }); writeFileSync(join(cache, "old-prefix"), "cached");
  updateSettings({ "stack.engines.chat.thinking_budget_ceiling": 1500 }); applyPendingSettings();
  const model = getModel(STACK_CHAT_QWEN38_UNCENSORED_MODEL.id)!;
  const plan = splashLaunchPlan(model, 8812, 65_536, "splash-chat");
  expect(plan.engine).toBe("splash-chat"); expect(mapsModelWeights(plan.engine)).toBe(true); expect(plan.build).toBe("1.6.0"); expect(plan.identity?.build).toBe("splash-1.6.0"); expect(plan.identity?.model).toBe(modelPath.split("/").pop());
  expect(plan.command).toContain("--offline"); expect(plan.command).toContain("--max-context"); expect(plan.command).toContain("65536"); expect(plan.command).toContain("--thinking-token-budget"); expect(plan.command).toContain("1500"); expect(plan.command).toContain("--max-cache-disk"); expect(plan.command[plan.command.indexOf("--max-cache-disk") + 1]).toBe("0");
  expect(plan.env).toMatchObject({ HF_HUB_OFFLINE: "1", DO_NOT_TRACK: "1", HF_HUB_CACHE: splashHubDir(), HOME: splashHomeDir(), TMPDIR: splashTmpDir() });
  expect(existsSync(join(cache, "old-prefix"))).toBe(false);
  expect(plan.command).toContain("--language-only");
  // ISOLATION-04b: Splash is started with a key of its own (SPLASH_API_KEY at spawn), and the Stack's client for it sends it.
  expect(plan.apiKey?.length).toBeGreaterThanOrEqual(16);
  expect(plan.command.join(" ")).not.toContain(plan.apiKey!);
  expect((plan.client!("http://127.0.0.1:1") as unknown as { inner: { authHeaders(): Record<string, string> } }).inner.authHeaders()).toEqual({ authorization: `Bearer ${plan.apiKey}` });
});

test("Splash chat gets a full-context memory cap in normal mode with headroom and governor margin", () => {
  installModel(STACK_CHAT_QWEN38_UNCENSORED_MODEL); installModel(STACK_CODING_DRAFT_MODEL); installChatEngine();
  const model = getModel(STACK_CHAT_QWEN38_UNCENSORED_MODEL.id)!;
  for (const context of [40_960, 131_072, 262_144]) {
    const plan = splashLaunchPlan(model, 8812, context, "splash-chat");
    const args = plan.command;
    const cap = Number(args[args.indexOf("--max-memory") + 1]!.replace(/G$/, ""));
    expect(args).toContain("--max-memory");
    expect(cap).toBeGreaterThanOrEqual(Math.ceil((model.sizeBytes! + STACK_CODING_DRAFT_MODEL.download!.approx_bytes) / 1_073_741_824));
  }
});

test("coding mode keeps Splash chat's existing governor max-memory formula", async () => {
  installModel(STACK_CHAT_QWEN38_UNCENSORED_MODEL); installModel(STACK_CODING_DRAFT_MODEL); installChatEngine();
  const { getGovernorStatus } = await import("@/lib/governor");
  const { splashFootprintEstimateBytes } = await import("@/lib/splash");
  initializeHomeMode("coding");
  const model = getModel(STACK_CHAT_QWEN38_UNCENSORED_MODEL.id)!;
  const plan = splashLaunchPlan(model, 8812, 131_072, "splash-chat");
  const status = getGovernorStatus();
  const estimate = splashFootprintEstimateBytes({ weightsBytes: model.sizeBytes ?? 0, draftBytes: STACK_CODING_DRAFT_MODEL.download!.approx_bytes, contextTokens: 131_072 });
  const expected = Math.max(1, Math.floor(Math.min(status.capBytes, estimate + status.marginBytes) / 1_073_741_824));
  expect(plan.command[plan.command.indexOf("--max-memory") + 1]).toBe(`${expected}G`);
  initializeHomeMode("normal");
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


test("with the chat engine on Splash the household's Huihui record is still the selected chat model (not the starter)", () => {
  installModel(STACK_CHAT_QWEN38_UNCENSORED_MODEL); installModel(STACK_CODING_DRAFT_MODEL); installChatEngine();
  updateSettings({ "stack.engines.chat.engine": "splash", "stack.engines.chat.model": STACK_CHAT_QWEN38_UNCENSORED_MODEL.id }); applyPendingSettings();
  expect(chatEngine()).toBe("splash");
  expect(selectedModel("chat")?.id).toBe(STACK_CHAT_QWEN38_UNCENSORED_MODEL.id);
  expect(selectableModels("chat").map((model) => model.id)).toContain(STACK_CHAT_QWEN38_UNCENSORED_MODEL.id);
});

test("a chat model that declares picture input stays on Splash: pictures are read by the separate vision role, so chat keeps its speed", () => {
  const modelPath = installModel(STACK_CHAT_QWEN38_UNCENSORED_MODEL); installModel(STACK_CODING_DRAFT_MODEL); installChatEngine();
  updateSettings({ "stack.engines.chat.engine": "splash", "stack.engines.chat.model": STACK_CHAT_QWEN38_UNCENSORED_MODEL.id }); applyPendingSettings();
  const pin = STACK_CHAT_QWEN38_UNCENSORED_MODEL;
  upsertModel({ id: pin.id, roles: [pin.role], ...verified, revision: pin.revision!, sha256: pin.download!.sha256, sizeBytes: pin.download!.approx_bytes, modelPath, engineRequirements: { engine: pin.engine, launch: pin.launch, sampling: pin.sampling, imageInput: { projector: "chat-projector" } } });
  expect(chatEngine()).toBe("splash");
  expect(selectedModel("chat")?.id).toBe(pin.id);
});

test("a Splash process's post-load memory reading is not stored as a footprint or used as the runaway baseline (it maps the model and grows while serving)", () => {
  expect(mapsModelWeights("splash")).toBe(true);
  expect(mapsModelWeights("splash-chat")).toBe(true);
  expect(mapsModelWeights("llama-server")).toBe(false);
  expect(mapsModelWeights(null)).toBe(false);
});

// 2026-10-29: chat on Splash ("splash-chat") was restarted by the runaway
// watch every 1 to 10 minutes while idle (87 "governor-runaway" restarts):
// its ~1 GB post-load reading became the baseline, and the mapped 14 GB
// model paging in read as a runaway (1.3 x 1 GB + 0.5 GB for 3 polls).
test("an idle chat engine whose memory grows is never restarted by the runaway watch, Splash or llama-server alike", async () => {
  const GB = 1_073_741_824;
  const runLoop = async (engine: string): Promise<number> => {
    __resetGovernorForTests();
    __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 100 * GB, pollMs: 1, processSustainedPolls: 3 });
    const admission = await admit({ id: "chat", role: "chat", kind: "resident", requestedBytes: 15 * GB, dryRunPeakBytes: 20 * GB, engine, pid: 4242 }) as GovernorHandle;
    // What the supervisor's post-load check does with its ~1 GB reading.
    if (!mapsModelWeights(engine)) refreshMeasuredPeak(admission, GB);
    let rss = GB;
    let restarts = 0;
    const stop = startGovernor({ pid: 4242, freeMemory: () => 100 * GB, totalMemory: () => 128 * GB, processMemory: async () => { rss = Math.min(15 * GB, rss + 2 * GB); return rss; }, busy: () => false, restart: () => { restarts++; } });
    await Bun.sleep(40);
    stop();
    await Bun.sleep(5);
    __resetGovernorForTests();
    return restarts;
  };
  // RESOURCE-FIX-01: chat is a reserved role, so even the llama-server case is kept and reported, never restarted.
  expect(await runLoop("llama-server")).toBe(0);
  expect(await runLoop("splash-chat")).toBe(0);
  expect(await runLoop("splash")).toBe(0);
});

// SPLASH-THINK-DEFAULT-01: a plain request (no thinking signal) must not think, the way llama-server's `--reasoning off` launch does.
test("chat wire contract: every chat engine answers a plain request without thinking, and a caller that asks for thinking keeps it", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const inner: EngineClient = {
    baseUrl: "http://127.0.0.1:1",
    request: async (_path, body) => { seen.push(body); return { status: 200, body: { choices: [{ message: { content: "ok" } }] } }; },
    stream: async (_path, body) => { seen.push(body); return new Response("data: [DONE]\n\n"); },
    health: async () => true,
  };
  const client = new SplashChatClient(inner, "huihui", { temperature: 0.7, thinking_budget_ceiling: 2000, source: "catalog" });
  const kwargs = () => seen[seen.length - 1]!.chat_template_kwargs as Record<string, unknown> | undefined;
  const plain = { model: "chat", messages: [{ role: "user", content: "hi" }], max_tokens: 30 };
  const llamaArgs = llamaServerArgs({ modelPath: "/models/chat.gguf", port: 8771, config: { contextLength: 4096, slots: 1, threads: 0, cacheRamMb: 0, flashAttention: true }, contextLength: 4096, kvCacheType: "q8_0" });
  for (const choice of CHAT_ENGINE_CHOICES) {
    if (choice === "splash") {
      await client.request("/v1/chat/completions", plain); expect(kwargs()?.enable_thinking).toBe(false);
      await client.stream("/v1/chat/completions", plain); expect(kwargs()?.enable_thinking).toBe(false);
      await client.request("/v1/chat/completions", { ...plain, chat_template_kwargs: { preserve_thinking: true } }); expect(kwargs()).toEqual({ preserve_thinking: true, enable_thinking: false });
      await client.request("/v1/chat/completions", { ...plain, chat_template_kwargs: { enable_thinking: true } }); expect(kwargs()?.enable_thinking).toBe(true);
      await client.request("/v1/chat/completions", { ...plain, reasoning_effort: "medium" }); expect(kwargs()).toBeUndefined();
      await client.request("/v1/chat/completions", { ...plain, thinking: { type: "enabled", budget_tokens: 500 } }); expect(kwargs()).toBeUndefined();
      await client.request("/v1/chat/completions", { ...plain, thinking_budget_tokens: 500 }); expect(kwargs()).toBeUndefined();
      await client.request("/v1/chat/completions", { ...plain, thinking_budget_tokens: 0 }); expect(kwargs()?.enable_thinking).toBe(false);
    } else if (choice === "llama-server") {
      expect(llamaArgs.slice(llamaArgs.indexOf("--reasoning"), llamaArgs.indexOf("--reasoning") + 2)).toEqual(["--reasoning", "off"]);
    } else {
      // auto resolves to llama-server; mlx-serve and oMLX are not Splash and add no thinking control of their own.
      expect(["auto", "mlx-serve", "omlx"]).toContain(choice);
    }
  }
});
