// ENGINE-MLX-01: oMLX as the chat engine on Apple silicon (the measurements
// are in Home's docs/design/chat-engine-comparison-2026-10-17.md). The
// choice per tier and the fallback, the setting, the pins and the
// requirements file, the launch command, the client that adapts the
// engine's wire to the Stack's, and the start that falls back to
// llama-server after two failures. Nothing here runs uv or MLX; the real
// engine is exercised by omlxSmoke.test.ts (OMLX_SMOKE=1).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COUNT_TAG, OmlxEngineClient, timingsFromUsage, withTimingsStream } from "@/chat/omlxClient";
import { newLaunchKey, omlxCacheDir, omlxCommand, omlxEnv, omlxModelsDir, omlxRequirementsFileFor, omlxRoot, omlxSupportedHere, OMLX_NAME, OMLX_VERSION, prepareModelFolder, resetState } from "@/chat/omlx";
import { CHAT_ENGINES, MANAGED_RUNTIMES } from "@/lib/engineCatalog";
import { chatEngineFailure, clearChatEngineFailures, markChatEngineFailed, requestedChatEngine, resolveChatEngine, tierDefaultChatEngine } from "@/lib/chatEngines";
import { __resetHealthForTests, list as listHealth } from "@/lib/health";
import { clearModelsForTests, upsertModel } from "@/lib/modelStore";
import { STACK_CHAT_MUSE_30B_MLX_MODEL, STACK_CHAT_MUSE_30B_XL_MODEL, STACK_MODELS } from "@/lib/modelCatalog";
import { activeChatChoice, chatEngine, engineInstalledFor, launchPlan, resetSupervisorForTests, scriptedProcess, selectedModel, setMachineTier, setSupervisorFactoryForTests, startChatWithFallbackForTests, EngineUnavailableError } from "@/lib/supervisor";
import { ENV_READY_MARKER } from "@/lib/uvEnvironment";
import { __resetSettingsForTests, applyPendingSettings, readSettings, updateSettings } from "@/settings";

const APPLE_SILICON = process.platform === "darwin" && process.arch === "arm64";

beforeEach(() => { __resetHealthForTests(); __resetSettingsForTests(); clearModelsForTests(); clearChatEngineFailures(); setMachineTier(undefined); });
afterEach(() => { setSupervisorFactoryForTests(null); resetSupervisorForTests(); clearModelsForTests(); __resetSettingsForTests(); clearChatEngineFailures(); setMachineTier(undefined); rmSync(omlxRoot(), { recursive: true, force: true }); });

const verified = { source: "catalog" as const, provenance: { repo: "example/repo" }, revision: "r", sha256: "c".repeat(64), licence: "Apache-2.0", verifiedAt: new Date().toISOString() };
function fakeEnvironment(): void {
  mkdirSync(join(omlxRoot(), "venv", "bin"), { recursive: true });
  const binary = join(omlxRoot(), "venv", "bin", "omlx");
  writeFileSync(binary, "#!/bin/sh\nexit 0\n");
  chmodSync(binary, 0o755);
  writeFileSync(join(omlxRoot(), ENV_READY_MARKER), "ok");
}
function modelDir(): string {
  const dir = join(omlxRoot(), "..", "fixture-model", "Muse-Glimmer-30B-4bit");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ model_type: "muse_glimmer", text_config: { max_position_embeddings: 131072 } }));
  return dir;
}
function installRecords(): string {
  const dir = modelDir();
  upsertModel({ id: STACK_CHAT_MUSE_30B_MLX_MODEL.id, roles: ["chat"], ...verified, sizeBytes: 19_443_246_692, modelPath: dir, engineRequirements: { engine: "omlx", launch: STACK_CHAT_MUSE_30B_MLX_MODEL.launch, sampling: STACK_CHAT_MUSE_30B_MLX_MODEL.sampling } });
  upsertModel({ id: STACK_CHAT_MUSE_30B_XL_MODEL.id, roles: ["chat"], ...verified, sizeBytes: 19_653_960_832, modelPath: "/tmp/never/muse.gguf", engineRequirements: { engine: "llama-server" } });
  return dir;
}

// ---- the choice -----------------------------------------------------------

test("oMLX is the default chat engine on Apple silicon at p64 and p128 and nowhere else; a named engine is honoured", () => {
  expect(tierDefaultChatEngine("p64", "darwin", "arm64")).toBe("omlx");
  expect(tierDefaultChatEngine("p128", "darwin", "arm64")).toBe("omlx");
  for (const tier of ["p16", "p32", undefined, null] as const) expect(tierDefaultChatEngine(tier, "darwin", "arm64")).toBe("llama-server");
  expect(tierDefaultChatEngine("p128", "linux", "arm64")).toBe("llama-server");
  expect(tierDefaultChatEngine("p128", "darwin", "x64")).toBe("llama-server");
  expect(requestedChatEngine("auto", "p128", "darwin", "arm64")).toBe("omlx");
  expect(requestedChatEngine("llama-server", "p128", "darwin", "arm64")).toBe("llama-server");
  expect(requestedChatEngine("omlx", "p16", "darwin", "arm64")).toBe("omlx");
  expect(requestedChatEngine("mlx-serve", "p128", "darwin", "arm64")).toBe("mlx-serve");
  expect(requestedChatEngine("anything-else", "p128", "darwin", "arm64")).toBe("omlx");
});

test("resolving: oMLX needs its environment and model, falls back to llama-server with the reason, and stays there after two failed starts until a restart", () => {
  const ready = { setting: "auto", tier: "p128" as const, installed: () => true, platform: "darwin", arch: "arm64" };
  expect(resolveChatEngine(ready)).toEqual({ engine: "omlx", requested: "omlx", reason: null });
  const missing = resolveChatEngine({ ...ready, installed: () => false });
  expect(missing.engine).toBe("llama-server");
  expect(missing.reason).toMatch(/omlx is not installed on this computer yet.*chat stays on llama-server/i);
  const old = resolveChatEngine({ ...ready, unsupported: () => "oMLX needs macOS 15 or later (this Mac runs 14)." });
  expect(old).toMatchObject({ engine: "llama-server", requested: "omlx" });
  expect(old.reason).toBe("oMLX needs macOS 15 or later (this Mac runs 14). Chat stays on llama-server.");
  expect(markChatEngineFailed("omlx", "exited with code 1")).toBe(1);
  expect(resolveChatEngine(ready).engine).toBe("omlx");
  expect(markChatEngineFailed("omlx", "exited with code 1")).toBe(2);
  const failed = resolveChatEngine(ready);
  expect(failed.engine).toBe("llama-server");
  expect(failed.reason).toMatch(/did not start \(exited with code 1\).*Restart the chat engine to try again/);
  expect(chatEngineFailure("omlx")?.count).toBe(2);
  clearChatEngineFailures();
  expect(resolveChatEngine(ready).engine).toBe("omlx");
  // llama-server is never a failure to remember, and an explicit llama-server never changes.
  expect(markChatEngineFailed("llama-server", "x")).toBe(0);
  expect(resolveChatEngine({ ...ready, setting: "llama-server", installed: () => false }).engine).toBe("llama-server");
});

test.skipIf(!APPLE_SILICON)("the setting: auto is the default, omlx and auto are accepted, an unknown engine is refused, and the effect waits for the restart", () => {
  const row = () => readSettings().find((setting) => setting.key === "stack.engines.chat.engine")!;
  expect(row().default).toBe("auto");
  expect(row().in_effect).toBe("auto");
  expect(() => updateSettings({ "stack.engines.chat.engine": "vllm" })).toThrow();
  updateSettings({ "stack.engines.chat.engine": "omlx" });
  expect(row().pending).toBe("omlx");
  applyPendingSettings();
  expect(row().in_effect).toBe("omlx");
  updateSettings({ "stack.engines.chat.engine": "llama-server" });
  applyPendingSettings();
  expect(row().in_effect).toBe("llama-server");
});

test.skipIf(!APPLE_SILICON)("chat runs on oMLX only when the tier, the environment and the verified model are all there; otherwise llama-server and the model that serves it", () => {
  installRecords();
  setMachineTier("p128");
  // No environment yet: llama-server, and its GGUF is the selected model.
  expect(activeChatChoice().engine).toBe("llama-server");
  expect(chatEngine()).toBe("llama-server");
  expect(selectedModel("chat")?.id).toBe(STACK_CHAT_MUSE_30B_XL_MODEL.id);
  fakeEnvironment();
  expect(activeChatChoice()).toEqual({ engine: "omlx", requested: "omlx", reason: null });
  expect(selectedModel("chat")?.id).toBe(STACK_CHAT_MUSE_30B_MLX_MODEL.id);
  expect(engineInstalledFor("chat")).toBe(true);
  // The judge with its own bound model, embeddings and vision stay on llama-server.
  expect(engineInstalledFor("embed")).toBe(false);
  // A smaller tier never takes it by default; a person who names it still can.
  setMachineTier("p32");
  expect(chatEngine()).toBe("llama-server");
  updateSettings({ "stack.engines.chat.engine": "omlx" });
  applyPendingSettings();
  expect(chatEngine()).toBe("omlx");
  // The rollback is one setting.
  updateSettings({ "stack.engines.chat.engine": "llama-server" });
  applyPendingSettings();
  expect(chatEngine()).toBe("llama-server");
});

// ---- the pins -------------------------------------------------------------

test("the MLX record pins every file by size and sha256 at one revision, and carries the card's sampling and the pinned reasoning strength", () => {
  const pin = STACK_CHAT_MUSE_30B_MLX_MODEL;
  expect(pin).toMatchObject({ id: "muse-glimmer-30b-mlx-4bit", role: "chat", engine: "omlx", license: "Apache-2.0", repo: "mlx-community/Muse-Glimmer-30B-4bit" });
  expect(pin.revision).toMatch(/^[0-9a-f]{40}$/);
  const download = pin.download!;
  expect(download.directory).toBe("Muse-Glimmer-30B-4bit");
  const files = download.files!;
  expect(files.map((file) => file.path).sort()).toEqual(["chat_template.jinja", "config.json", "generation_config.json", "model-00001-of-00004.safetensors", "model-00002-of-00004.safetensors", "model-00003-of-00004.safetensors", "model-00004-of-00004.safetensors", "model.safetensors.index.json", "processor_config.json", "tokenizer.json", "tokenizer_config.json"]);
  for (const file of files) { expect(file.sha256).toMatch(/^[0-9a-f]{64}$/); expect(file.bytes).toBeGreaterThan(0); }
  expect(files.reduce((sum, file) => sum + file.bytes, 0)).toBe(download.approx_bytes);
  const first = files.find((file) => file.path === "model-00001-of-00004.safetensors")!;
  expect(download.sha256).toBe(first.sha256);
  expect(download.url).toBe(`https://huggingface.co/mlx-community/Muse-Glimmer-30B-4bit/resolve/${pin.revision}/model-00001-of-00004.safetensors`);
  expect(pin.launch).toEqual({ chatTemplateKwargs: { reasoning_strength: "low" }, readsPictures: true });
  expect(pin.sampling).toMatchObject({ temperature: 1.0, top_p: 0.95, top_k: 64 });
  expect(pin.measured?.footprintBytes).toBeGreaterThan(20_000_000_000);
  expect(STACK_MODELS).toContain(pin);
});

test("oMLX is a managed runtime with a hashed requirements file: every package pinned with hashes, the release wheel by checksum, no torch and no git dependency", () => {
  expect(MANAGED_RUNTIMES.find((runtime) => runtime.name === OMLX_NAME)).toMatchObject({ version: OMLX_VERSION, roles: ["chat"] });
  expect([...CHAT_ENGINES]).toContain("omlx");
  const file = omlxRequirementsFileFor("darwin", "arm64");
  expect(file).not.toBeNull();
  expect(omlxRequirementsFileFor("linux", "arm64")).toBeNull();
  expect(omlxRequirementsFileFor("darwin", "x64")).toBeNull();
  const text = readFileSync(file!, "utf8");
  const requirements = text.split("\n").filter((line) => /^[A-Za-z0-9_.-]+(\[[^\]]*\])?( @ |==)/.test(line));
  expect(requirements.length).toBeGreaterThan(80);
  // Each requirement line is followed by at least one hash.
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) if (/^[A-Za-z0-9_.-]+(\[[^\]]*\])?( @ |==)/.test(lines[index]!)) expect(lines[index]!.endsWith("\\") || lines[index + 1]?.includes("--hash=sha256:")).toBe(true);
  expect(text).toContain("omlx @ https://github.com/jundot/omlx/releases/download/v0.7.0/omlx-0.7.0-cp312-cp312-macosx_15_0_universal2.whl");
  expect(text).toContain("--hash=sha256:42ff3d25a40468781110933a64dc7037dcbe8590ab93851db82a12a5df81617b");
  expect(text).toMatch(/^mlx==0\.32\.4 /m);
  expect(text).toMatch(/^mlx-lm==0\.32\.2 /m);
  expect(text).not.toMatch(/^torch==/m);
  expect(text).not.toMatch(/git\+https/);
});

test("the engine needs Apple silicon and macOS 15; an older Mac is told why", () => {
  expect(omlxSupportedHere("darwin", "arm64", 15)).toEqual({ ok: true, reason: null });
  expect(omlxSupportedHere("darwin", "arm64", 27).ok).toBe(true);
  expect(omlxSupportedHere("darwin", "arm64", 14)).toEqual({ ok: false, reason: "oMLX needs macOS 15 or later (this Mac runs 14)." });
  expect(omlxSupportedHere("linux", "arm64", null).ok).toBe(false);
  expect(omlxSupportedHere("darwin", "x64", 15).reason).toBe("oMLX runs on Apple silicon Macs only.");
});

// ---- the launch -----------------------------------------------------------

test("the launch is oMLX on loopback behind a random key, offline, with its prompt cache emptied and capped, over a folder holding the one pinned model", async () => {
  const dir = installRecords();
  fakeEnvironment();
  // A cache left by an earlier run is gone at the next launch.
  mkdirSync(omlxCacheDir(), { recursive: true });
  writeFileSync(join(omlxCacheDir(), "block-1"), "old conversation state");
  setMachineTier("p128");
  const model = selectedModel("chat")!;
  expect(model.id).toBe(STACK_CHAT_MUSE_30B_MLX_MODEL.id);
  const plan = await launchPlan("chat", model, 8797);
  expect(plan.engine).toBe("omlx");
  expect(plan.build).toBe(`omlx-${OMLX_VERSION}`);
  expect(plan.kind).toBe("spawned");
  expect(plan.contextLength).toBe(131072);
  expect(plan.imageInput).toBe(true);
  expect(plan.command[0]).toBe(join(omlxRoot(), "venv", "bin", "omlx"));
  const args = plan.command.slice(1);
  expect(args.slice(0, 2)).toEqual(["serve", "--model-dir"]);
  const flag = (name: string) => args[args.indexOf(name) + 1];
  expect(flag("--host")).toBe("127.0.0.1");
  expect(flag("--port")).toBe("8797");
  expect(flag("--api-key")).toMatch(/^[A-Za-z0-9_-]{30,}$/);
  expect(args).toContain("--no-hf-cache");
  expect(flag("--paged-ssd-cache-dir")).toBe(omlxCacheDir());
  expect(flag("--paged-ssd-cache-max-size")).toBe("20GB");
  expect(Number(flag("--max-concurrent-requests"))).toBeGreaterThanOrEqual(4);
  expect(existsSync(join(omlxCacheDir(), "block-1"))).toBe(false);
  // The model folder holds exactly the pinned directory, linked under the name the engine reports.
  const folder = flag("--model-dir")!;
  expect(folder).toBe(omlxModelsDir());
  expect(lstatSync(join(folder, "Muse-Glimmer-30B-4bit")).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(folder, "Muse-Glimmer-30B-4bit", "config.json"), "utf8")).toContain("muse_glimmer");
  expect(dir).toContain("Muse-Glimmer-30B-4bit");
  // Offline, no token, no analytics; the daemon's secrets key never travels.
  expect(plan.env).toMatchObject({ HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", DO_NOT_TRACK: "1", HF_HUB_DISABLE_TELEMETRY: "1" });
  expect(plan.env?.HF_TOKEN).toBeUndefined();
  expect(plan.env?.STACK_SECRETS_KEY).toBeUndefined();
  expect(plan.env?.HOME).toContain("/home");
  expect(plan.identity).toEqual({ build: `omlx-${OMLX_VERSION}`, model: "Muse-Glimmer-30B-4bit" });
  expect(plan.client).toBeFunction();
  // Every launch has a key of its own.
  const again = await launchPlan("chat", model, 8798);
  expect(again.command[again.command.indexOf("--api-key") + 1]).not.toBe(flag("--api-key"));
});

test("the helpers: a key is random and long, the model folder is rebuilt, the state reset recreates the cache folder, the environment carries no token", () => {
  expect(newLaunchKey()).not.toBe(newLaunchKey());
  expect(newLaunchKey().length).toBeGreaterThanOrEqual(30);
  const a = prepareModelFolder("/tmp/never/Alpha-4bit");
  expect(a.modelId).toBe("Alpha-4bit");
  const b = prepareModelFolder("/tmp/never/Beta-4bit");
  expect(existsSync(join(b.folder, "Alpha-4bit"))).toBe(false);
  expect(lstatSync(join(b.folder, "Beta-4bit")).isSymbolicLink()).toBe(true);
  resetState();
  expect(existsSync(omlxCacheDir())).toBe(true);
  process.env.HF_TOKEN = "hf_never";
  try { expect(omlxEnv().HF_TOKEN).toBeUndefined(); } finally { delete process.env.HF_TOKEN; }
  expect(omlxCommand({ port: 1, modelFolder: "/m", apiKey: "k", concurrent: 1 })).toContain("--log-level");
});

// ---- the client -----------------------------------------------------------

function client(handler: (url: string, init: RequestInit) => Response | Promise<Response>, templateKwargs: Record<string, string> | null = { reasoning_strength: "low" }): { client: OmlxEngineClient; calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: typeof init.body === "string" ? JSON.parse(init.body) : {}, headers: (init.headers ?? {}) as Record<string, string> });
    return handler(String(url), init);
  }) as unknown as typeof fetch;
  return { client: new OmlxEngineClient({ baseUrl: "http://127.0.0.1:9/", apiKey: "secret-key", modelId: "Muse-Glimmer-30B-4bit", templateKwargs: templateKwargs ?? undefined, fetchImpl }), calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const USAGE = { prompt_tokens: 66, completion_tokens: 60, prompt_tokens_details: { cached_tokens: 57 }, prompt_eval_duration: 0.23, generation_duration: 1.88, prompt_tokens_per_second: 290.9, generation_tokens_per_second: 31.95 };

test("the client sends the model's folder name, the pinned template variables under the request's own, no llama-server-only fields, and the launch key", async () => {
  const { client: engine, calls } = client(() => json({ choices: [{ message: { content: "hi" } }], usage: USAGE }));
  await engine.request("/v1/chat/completions", { model: "chat", messages: [{ role: "user", content: "hi" }], cache_prompt: true, id_slot: 0, chat_template_kwargs: { enable_thinking: false, reasoning_strength: "high" }, temperature: 0.3 });
  expect(calls[0]!.url).toBe("http://127.0.0.1:9/v1/chat/completions");
  expect(calls[0]!.body).toEqual({ model: "Muse-Glimmer-30B-4bit", messages: [{ role: "user", content: "hi" }], temperature: 0.3, chat_template_kwargs: { reasoning_strength: "high", enable_thinking: false } });
  expect(calls[0]!.headers.authorization).toBe("Bearer secret-key");
  // With no kwargs on the request the pinned strength still goes.
  await engine.request("/v1/chat/completions", { model: "chat", messages: [] });
  expect(calls[1]!.body.chat_template_kwargs).toEqual({ reasoning_strength: "low" });
  // A record with nothing pinned adds nothing.
  const bare = client(() => json({}), null);
  await bare.client.request("/v1/chat/completions", { model: "chat", messages: [] });
  expect(bare.calls[0]!.body.chat_template_kwargs).toBeUndefined();
});

test("llama-server's timings object is built from the engine's usage: speed, cached tokens and the prompt share", async () => {
  expect(timingsFromUsage(USAGE)).toEqual({ cache_n: 57, prompt_n: 9, prompt_ms: 230, prompt_per_second: 290.9, predicted_n: 60, predicted_ms: 1880, predicted_per_second: 31.95 });
  expect(timingsFromUsage({ prompt_tokens: 5, completion_tokens: 2 })).toBeNull();
  expect(timingsFromUsage(null)).toBeNull();
  const { client: engine } = client(() => json({ choices: [], usage: USAGE }));
  const reply = await engine.request("/v1/chat/completions", { model: "chat", messages: [] });
  expect((reply.body as { timings: { predicted_per_second: number } }).timings.predicted_per_second).toBe(31.95);
  // An engine that already sends timings is not overwritten.
  const { client: own } = client(() => json({ usage: USAGE, timings: { predicted_per_second: 1 } }));
  expect(((await own.request("/v1/chat/completions", { model: "chat", messages: [] })).body as { timings: { predicted_per_second: number } }).timings.predicted_per_second).toBe(1);
});

test("a streamed reply passes every line through and adds timings to the usage chunk only, across any chunk boundary", async () => {
  const lines = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" } }] })}`, "",
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "think" } }] })}`, "",
    `data: ${JSON.stringify({ choices: [], usage: USAGE })}`, "",
    "data: [DONE]", "",
  ].join("\n");
  const bytes = new TextEncoder().encode(lines);
  const { client: engine, calls } = client(() => new Response(new ReadableStream({ start(controller) { for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7)); controller.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } }));
  const response = await engine.stream("/v1/chat/completions", { model: "chat", messages: [], cache_prompt: true });
  expect(calls[0]!.body).toMatchObject({ stream: true, stream_options: { include_usage: true }, model: "Muse-Glimmer-30B-4bit" });
  expect(calls[0]!.body.cache_prompt).toBeUndefined();
  const text = await response.text();
  const out = text.split("\n");
  expect(out[0]).toBe(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" } }] })}`);
  expect(out).toContain("data: [DONE]");
  const usageLine = out.find((line) => line.includes("\"usage\""))!;
  expect(JSON.parse(usageLine.slice(5))).toMatchObject({ usage: USAGE, timings: { predicted_per_second: 31.95, cache_n: 57 } });
  expect(out.filter((line) => line.includes("timings")).length).toBe(1);
  // The same function straight on a stream whose last line has no newline.
  const tail = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ usage: USAGE })}`)); controller.close(); } });
  expect(await new Response(withTimingsStream(tail)).text()).toContain("\"timings\"");
});

test("token counting asks the engine for one token and reads its own prompt size; the template is the engine's, tools and kwargs included", async () => {
  const { client: engine, calls } = client(() => json({ choices: [], usage: { prompt_tokens: 35, completion_tokens: 1 } }));
  const rendered = await engine.request("/apply-template", { model: "chat", messages: [{ role: "user", content: "hello" }], tools: [{ type: "function", function: { name: "math" } }], chat_template_kwargs: { reasoning_strength: "high" } });
  expect(rendered.status).toBe(200);
  const prompt = (rendered.body as { prompt: string }).prompt;
  expect(prompt.startsWith(COUNT_TAG)).toBe(true);
  expect(calls.length).toBe(0);
  const counted = await engine.request("/tokenize", { model: "chat", content: prompt, add_special: true });
  expect(counted.status).toBe(200);
  expect((counted.body as { tokens: number[] }).tokens.length).toBe(35);
  expect(calls[0]!.url).toBe("http://127.0.0.1:9/v1/chat/completions");
  expect(calls[0]!.body).toMatchObject({ model: "Muse-Glimmer-30B-4bit", max_tokens: 1, temperature: 0, stream: false, tools: [{ type: "function", function: { name: "math" } }], chat_template_kwargs: { reasoning_strength: "high" }, messages: [{ role: "user", content: "hello" }] });
  // Plain text is counted as a raw prompt.
  const raw = await engine.request("/tokenize", { model: "chat", content: "plain words", add_special: true });
  expect((raw.body as { tokens: unknown[] }).tokens.length).toBe(35);
  expect(calls[1]!.url).toBe("http://127.0.0.1:9/v1/completions");
  expect(calls[1]!.body).toMatchObject({ prompt: "plain words", max_tokens: 1 });
  // An engine error comes back with its status; a reply with no count is a 502.
  const failing = client(() => json({ error: "boom" }, 500));
  expect((await failing.client.request("/tokenize", { content: "x" })).status).toBe(500);
  const silent = client(() => json({ choices: [] }));
  expect((await silent.client.request("/tokenize", { content: "x" })).status).toBe(502);
  // A tagged prompt that is not the Stack's own is refused, not guessed at.
  expect((await engine.request("/tokenize", { content: `${COUNT_TAG}{not json` })).status).toBe(400);
});

test("health is the engine's /health with the key; a refused connection is not healthy and a request failure says so in the Stack's words", async () => {
  const seen: string[] = [];
  const up = client((url, init) => { seen.push(`${url} ${(init.headers as Record<string, string>).authorization}`); return json({ status: "healthy" }); });
  expect(await up.client.health()).toBe(true);
  expect(seen).toEqual(["http://127.0.0.1:9/health Bearer secret-key"]);
  const down = client(() => { throw new Error("connect ECONNREFUSED"); });
  expect(await down.client.health()).toBe(false);
  await expect(down.client.request("/v1/chat/completions", { model: "chat", messages: [] })).rejects.toThrow(/Engine request failed: connect ECONNREFUSED/);
  const unhealthy = client(() => json({}, 503));
  expect(await unhealthy.client.health()).toBe(false);
});

// ---- the fallback ---------------------------------------------------------

test.skipIf(!APPLE_SILICON)("a chat start that fails twice runs on llama-server for the run, raises one warning with the reason, and clears it when oMLX starts again after a restart", async () => {
  installRecords();
  fakeEnvironment();
  setMachineTier("p128");
  expect(chatEngine()).toBe("omlx");
  const attempts: string[] = [];
  const fails = async () => { attempts.push(chatEngine()); throw new EngineUnavailableError("Engine exited before becoming healthy (code 1): No module named 'mlx'"); };
  let calls = 0;
  const start = async (role: "chat") => {
    calls++;
    if (chatEngine() === "omlx") return fails();
    attempts.push(chatEngine());
    return scriptedProcess(role, { engine: "llama-server" });
  };
  const started = await startChatWithFallbackForTests(undefined, start as never);
  expect(started.engine).toBe("llama-server");
  expect(attempts).toEqual(["omlx", "omlx", "llama-server"]);
  expect(calls).toBe(3);
  const warning = listHealth().find((item) => item.code === "chat.engine-fallback")!;
  expect(warning.severity).toBe("warning");
  expect(warning.text).toMatch(/No module named 'mlx'/);
  expect(chatEngine()).toBe("llama-server");
  expect(activeChatChoice().reason).toMatch(/did not start/);
  // A restart of the chat engine tries oMLX again; when it starts, the warning clears.
  clearChatEngineFailures();
  expect(chatEngine()).toBe("omlx");
  const ok = await startChatWithFallbackForTests(undefined, (async (role: "chat") => scriptedProcess(role, { engine: "omlx" })) as never);
  expect(ok.engine).toBe("omlx");
  expect(listHealth().find((item) => item.code === "chat.engine-fallback")).toBeUndefined();
});

test.skipIf(!APPLE_SILICON)("one failure then success starts oMLX and does not fall back; llama-server as the choice never touches the fallback", async () => {
  installRecords();
  fakeEnvironment();
  setMachineTier("p128");
  let calls = 0;
  const flaky = async (role: "chat") => { calls++; if (calls === 1) throw new EngineUnavailableError("The post-load check timed out."); return scriptedProcess(role, { engine: "omlx" }); };
  expect((await startChatWithFallbackForTests(undefined, flaky as never)).engine).toBe("omlx");
  expect(calls).toBe(2);
  expect(listHealth().find((item) => item.code === "chat.engine-fallback")).toBeUndefined();
  clearChatEngineFailures();
  updateSettings({ "stack.engines.chat.engine": "llama-server" });
  applyPendingSettings();
  let direct = 0;
  await startChatWithFallbackForTests(undefined, (async (role: "chat") => { direct++; return scriptedProcess(role, { engine: "llama-server" }); }) as never);
  expect(direct).toBe(1);
});
