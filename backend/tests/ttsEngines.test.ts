// VOICE-STUDIO-01: the second tts engine (Chatterbox Turbo on MLX). The
// registry and its tags, the default per tier, the one setting, the
// fallback to Pocket TTS when the chosen engine is missing or will not
// start, the pins, the install plan, and the capability flag Home reads
// (`tts.tags`) on the role and on each voice. Nothing here runs uv,
// MLX or Hugging Face; the start-failure test spawns two stub servers.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "@/app";
import { MANAGED_RUNTIMES } from "@/lib/engineCatalog";
import { list as listHealth, __resetHealthForTests } from "@/lib/health";
import { buildInstallPlan } from "@/lib/installPlan";
import { clearModelsForTests, upsertModel } from "@/lib/modelStore";
import { STACK_MODELS, STACK_TTS_CHATTERBOX_MODEL, STACK_TTS_CHATTERBOX_PARTS } from "@/lib/modelCatalog";
import { activeTtsChoice, resetSupervisorForTests, scriptedProcess, selectedModel, setMachineTier, setSupervisorFactoryForTests, speakRole, speechForm, ttsEngineInEffect, ttsEngineInstalled } from "@/lib/supervisor";
import { ENV_READY_MARKER } from "@/lib/uvEnvironment";
import { engineTagRoot } from "@/lib/store/layout";
import { mlxAudioCommand, mlxAudioEnv, mlxAudioProof, mlxAudioRoot, mlxRequirementsFileFor, MLX_AUDIO_NAME, MLX_AUDIO_VERSION } from "@/speech/mlxAudio";
import { POCKET_TTS_NAME, POCKET_TTS_VERSION, pocketTtsBinary, pocketTtsRoot } from "@/speech/pocketTts";
import { clearTtsEngineFailures, markTtsEngineFailed, resolveTtsEngine, TTS_DEFAULT_BY_TIER, TTS_ENGINES, TTS_ENGINE_CHOICES, tierDefaultTtsEngine } from "@/speech/ttsEngines";
import { CHATTERBOX_DEFAULT_VOICE_ID, listVoices } from "@/speech/voiceList";
import { __resetSettingsForTests, applyPendingSettings, readSettings, updateSettings } from "@/settings";
import { readFileSync } from "node:fs";

beforeEach(() => { __resetHealthForTests(); __resetSettingsForTests(); clearModelsForTests(); clearTtsEngineFailures(); setMachineTier(undefined); setSupervisorFactoryForTests(async (role) => scriptedProcess(role)); });
afterEach(() => { setSupervisorFactoryForTests(null); resetSupervisorForTests(); clearModelsForTests(); __resetSettingsForTests(); clearTtsEngineFailures(); setMachineTier(undefined); rmSync(mlxAudioRoot(), { recursive: true, force: true }); rmSync(pocketTtsRoot(), { recursive: true, force: true }); });

const verified = { source: "catalog" as const, provenance: { repo: "example/repo" }, revision: "r", sha256: "c".repeat(64), licence: "MIT", verifiedAt: new Date().toISOString(), modelPath: "/tmp/never/x" };
function installChatterboxRecords(): void {
  upsertModel({ id: STACK_TTS_CHATTERBOX_MODEL.id, roles: ["tts"], ...verified, sizeBytes: 2_985_990_960, engineRequirements: { engine: "chatterbox-turbo" } });
  for (const part of STACK_TTS_CHATTERBOX_PARTS) upsertModel({ id: part.id, roles: ["tts"], ...verified, engineRequirements: { engine: "chatterbox-turbo", component: part.component } });
}
function installPocketRecords(): void {
  upsertModel({ id: "pocket-tts-english", roles: ["tts"], ...verified, sizeBytes: 219_029_196, engineRequirements: { engine: "pocket-tts" } });
  upsertModel({ id: "tok", roles: ["tts"], ...verified, engineRequirements: { engine: "pocket-tts", component: "tokenizer" } });
  upsertModel({ id: "voice", roles: ["tts"], ...verified, engineRequirements: { engine: "pocket-tts", component: "voice" } });
}
function fakeEnvironment(root: string, files: Record<string, string>): void {
  mkdirSync(join(root, "venv", "bin"), { recursive: true });
  for (const [name, body] of Object.entries(files)) { const path = join(root, "venv", "bin", name); writeFileSync(path, body); chmodSync(path, 0o755); }
  writeFileSync(join(root, ENV_READY_MARKER), "ok");
}
function choose(engine: string): void { updateSettings({ "stack.voice.engine": engine }); applyPendingSettings(); }

test("the registry holds three engines, two built; Chatterbox Turbo declares the six measured tags, Pocket none, Orpheus is a slot", () => {
  expect(TTS_ENGINE_CHOICES.sort()).toEqual(["chatterbox-turbo", "pocket"]);
  expect(TTS_ENGINES.orpheus.built).toBe(false);
  expect(TTS_ENGINES["chatterbox-turbo"].tags).toEqual(["[laugh]", "[chuckle]", "[cough]", "[sigh]", "[clear throat]", "[gasp]"]);
  expect(TTS_ENGINES.pocket.tags).toEqual([]);
  expect(TTS_ENGINES["chatterbox-turbo"].catalogEngine).toBe("chatterbox-turbo");
});

test("the default engine per tier: Chatterbox Turbo where it fits (p64, p128), Pocket TTS below and with no tier", () => {
  expect(TTS_DEFAULT_BY_TIER).toEqual({ p16: "pocket", p32: "pocket", p64: "chatterbox-turbo", p128: "chatterbox-turbo" });
  expect(tierDefaultTtsEngine(undefined)).toBe("pocket");
  expect(tierDefaultTtsEngine("p128")).toBe("chatterbox-turbo");
});

test("resolving the engine: auto follows the tier; a missing, failed or unbuilt engine falls back to Pocket with the reason; Pocket is never a fallback of itself", () => {
  const installed = () => true;
  expect(resolveTtsEngine({ setting: "auto", tier: "p128", installed })).toEqual({ engine: "chatterbox-turbo", requested: "chatterbox-turbo", reason: null });
  expect(resolveTtsEngine({ setting: "auto", tier: "p16", installed })).toEqual({ engine: "pocket", requested: "pocket", reason: null });
  expect(resolveTtsEngine({ setting: "chatterbox-turbo", tier: "p16", installed }).engine).toBe("chatterbox-turbo");
  expect(resolveTtsEngine({ setting: "pocket", tier: "p128", installed }).engine).toBe("pocket");
  expect(resolveTtsEngine({ setting: "nonsense", tier: "p64", installed }).requested).toBe("chatterbox-turbo");
  const missing = resolveTtsEngine({ setting: "auto", tier: "p128", installed: (id) => id === "pocket" });
  expect(missing).toMatchObject({ engine: "pocket", requested: "chatterbox-turbo" });
  expect(missing.reason).toMatch(/not installed/);
  const orpheus = resolveTtsEngine({ setting: "orpheus", tier: "p128", installed });
  expect(orpheus).toMatchObject({ engine: "pocket", requested: "orpheus" });
  expect(orpheus.reason).toMatch(/not available/);
  markTtsEngineFailed("chatterbox-turbo", "exited with code 3");
  const failed = resolveTtsEngine({ setting: "auto", tier: "p128", installed });
  expect(failed.engine).toBe("pocket");
  expect(failed.reason).toMatch(/exited with code 3/);
  markTtsEngineFailed("pocket", "never recorded");
  clearTtsEngineFailures();
  expect(resolveTtsEngine({ setting: "auto", tier: "p128", installed }).engine).toBe("chatterbox-turbo");
});

test("stack.voice.engine is one declared select that defaults to auto and applies at the engine's restart", () => {
  const row = readSettings().find((setting) => setting.key === "stack.voice.engine")!;
  expect(row).toMatchObject({ selector: "select", default: "auto", in_effect: "auto", needs_restart: true });
  expect((row.range as { options: Array<{ value: string }> }).options.map((option) => option.value)).toEqual(["auto", "chatterbox-turbo", "pocket"]);
  updateSettings({ "stack.voice.engine": "pocket" });
  expect(readSettings().find((setting) => setting.key === "stack.voice.engine")).toMatchObject({ in_effect: "auto", pending: "pocket" });
  expect(() => updateSettings({ "stack.voice.engine": "banana" })).toThrow();
});

test("the Chatterbox pins are complete records: one commit, a sha256 and size each, a licence, the engine, a hub file; the weights file is the model, the rest are components", () => {
  const all = [STACK_TTS_CHATTERBOX_MODEL, ...STACK_TTS_CHATTERBOX_PARTS];
  for (const pin of all) {
    expect(pin.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(pin.download!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pin.download!.approx_bytes).toBeGreaterThan(0);
    expect(pin.license).toBe("Apache-2.0");
    expect(pin.engine).toBe("chatterbox-turbo");
    expect(pin.repo).toBe("mlx-community/chatterbox-turbo-fp16");
    expect(pin.download!.url).toContain(`/resolve/${pin.revision}/${pin.download!.hub_file}`);
    expect(STACK_MODELS).toContain(pin);
  }
  expect(new Set(all.map((pin) => pin.id)).size).toBe(all.length);
  expect(STACK_TTS_CHATTERBOX_MODEL.component).toBeUndefined();
  expect(STACK_TTS_CHATTERBOX_PARTS.every((pin) => !!pin.component)).toBe(true);
  expect(STACK_TTS_CHATTERBOX_PARTS.map((pin) => pin.download!.hub_file).sort()).toEqual(["added_tokens.json", "conds.safetensors", "config.json", "merges.txt", "special_tokens_map.json", "tokenizer_config.json", "vocab.json"]);
});

test("the install plan brings Chatterbox Turbo beside Pocket TTS on p64 and p128, and only there", () => {
  const ids = (gb: number) => buildInstallPlan({ unifiedMemoryGb: gb, totalRamGb: gb, platform: "darwin", arch: "arm64", cudaDevices: [], freeDiskBytes: null } as never).models.map((model) => model.id);
  for (const gb of [64, 128]) {
    expect(ids(gb)).toContain("chatterbox-turbo-fp16");
    expect(ids(gb)).toContain("chatterbox-turbo-fp16-conds");
    expect(ids(gb)).toContain("pocket-tts-english");
  }
  for (const gb of [16, 24, 32]) { expect(ids(gb).some((id) => id.startsWith("chatterbox"))).toBe(false); expect(ids(gb)).toContain("pocket-tts-english"); }
});

test("the MLX runtime is a managed runtime for tts with a hashed requirements file that needs no torch, and starts the engine offline with no token", () => {
  expect(MANAGED_RUNTIMES.find((runtime) => runtime.name === MLX_AUDIO_NAME)).toMatchObject({ version: MLX_AUDIO_VERSION, roles: ["tts"] });
  const file = mlxRequirementsFileFor("darwin", "arm64")!;
  const text = readFileSync(file, "utf8");
  expect(text).toContain("mlx-audio==0.5.9");
  expect(text).toContain("--hash=sha256:");
  expect(text).not.toMatch(/^torch==/m);
  expect(mlxRequirementsFileFor("linux", "arm64")).toBeNull();
  process.env.HF_TOKEN = "hf_never";
  try { const env = mlxAudioEnv(); expect(env.HF_TOKEN).toBeUndefined(); expect(env.HF_HUB_OFFLINE).toBe("1"); } finally { delete process.env.HF_TOKEN; }
  expect(mlxAudioCommand("/s.py", 8800, "chatterbox-turbo", "r/x").slice(1)).toEqual(["/s.py", "--host", "127.0.0.1", "--port", "8800", "--engine", "chatterbox-turbo", "--repo", "r/x"]);
});

test("the voice role and each voice carry the tts capability flag; Chatterbox lists its one voice with the tags, Pocket's presets list none", async () => {
  const roles = await (await app.request("/stack/v1/roles")).json() as { roles: Array<{ id: string; tts?: { engine: string; requested: string; tags: string[]; fallback_reason: string | null } }> };
  expect(roles.roles.find((role) => role.id === "tts")?.tts).toEqual({ engine: "pocket-tts", requested: "pocket-tts", tags: [], fallback_reason: null });
  expect(roles.roles.find((role) => role.id === "chat")?.tts).toBeUndefined();
  const pocketVoices = (await (await app.request("/stack/v1/voices")).json() as { voices: Array<{ tts?: { tags: string[] }; engine?: string }> }).voices;
  expect(pocketVoices.length).toBeGreaterThan(1);
  expect(pocketVoices.every((voice) => voice.tts?.tags.length === 0 && voice.engine === "pocket-tts")).toBe(true);
  const mlx = listVoices("chatterbox-turbo");
  expect(mlx).toHaveLength(1);
  expect(mlx[0]).toMatchObject({ id: CHATTERBOX_DEFAULT_VOICE_ID, engine: "chatterbox-turbo", licence: "Apache-2.0", tts: { engine: "chatterbox-turbo", tags: TTS_ENGINES["chatterbox-turbo"].tags } });
});

test("with Chatterbox installed and chosen the engine in effect, the selected model and the voice list are Chatterbox's; a voice name Home saved from Pocket's list is not refused", async () => {
  setMachineTier("p128");
  installPocketRecords();
  installChatterboxRecords();
  fakeEnvironment(pocketTtsRoot(), { "pocket-tts": "#!/bin/sh\n" });
  fakeEnvironment(mlxAudioRoot(), { "mlx_audio.tts.generate": "#!/bin/sh\n", python: "#!/bin/sh\n" });
  expect(ttsEngineInstalled("chatterbox-turbo")).toBe(true);
  expect(activeTtsChoice()).toMatchObject({ engine: "chatterbox-turbo", reason: null });
  expect(ttsEngineInEffect()).toBe("chatterbox-turbo");
  expect(selectedModel("tts")?.id).toBe("chatterbox-turbo-fp16");
  expect(listVoices().map((voice) => voice.id)).toEqual([CHATTERBOX_DEFAULT_VOICE_ID]);
  const form = new FormData(); form.append("text", "Oh, that is hilarious [laugh]."); form.append("voice_url", "alba");
  const response = await app.request("/v1/audio/speech", { method: "POST", body: form });
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  choose("pocket");
  expect(ttsEngineInEffect()).toBe("pocket");
  expect(selectedModel("tts")?.id).toBe("pocket-tts-english");
  const refused = new FormData(); refused.append("text", "hi"); refused.append("voice_url", "nobody");
  expect((await app.request("/v1/audio/speech", { method: "POST", body: refused })).status).toBe(400);
});

test("a chosen engine that is not installed leaves the voice on Pocket TTS and the role says why", async () => {
  setMachineTier("p128");
  installPocketRecords();
  fakeEnvironment(pocketTtsRoot(), { "pocket-tts": "#!/bin/sh\n" });
  expect(activeTtsChoice()).toMatchObject({ engine: "pocket", requested: "chatterbox-turbo" });
  const roles = await (await app.request("/stack/v1/roles")).json() as { roles: Array<{ id: string; tts?: { engine: string; requested: string; fallback_reason: string | null } }> };
  const view = roles.roles.find((role) => role.id === "tts")!.tts!;
  expect(view).toMatchObject({ engine: "pocket-tts", requested: "chatterbox-turbo" });
  expect(view.fallback_reason).toMatch(/not installed/);
});

test("a Chatterbox engine that exits before it is healthy never fails the voice: it is marked failed, a warning explains, and Pocket TTS answers", async () => {
  setSupervisorFactoryForTests(null);
  setMachineTier("p128");
  installPocketRecords();
  installChatterboxRecords();
  // The MLX environment is a Python that dies on start; Pocket's is a tiny Bun server on the same wire.
  fakeEnvironment(mlxAudioRoot(), { "mlx_audio.tts.generate": "#!/bin/sh\n", python: "#!/bin/sh\necho 'ModuleNotFoundError: No module named mlx' >&2\nexit 3\n" });
  const stub = "#!" + process.execPath + `
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const header = new Uint8Array(44); new TextEncoder().encodeInto("RIFF", header);
Bun.serve({ port, hostname: "127.0.0.1", async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/health") return Response.json({ status: "healthy" });
  if (path === "/tts") return new Response(new Uint8Array([...header, ...new Uint8Array(4800)]), { headers: { "content-type": "audio/wav" } });
  return new Response("no", { status: 404 });
} });
`;
  fakeEnvironment(pocketTtsRoot(), { "pocket-tts": stub });
  expect(activeTtsChoice().engine).toBe("chatterbox-turbo");
  const spoken = await speakRole("tts", speechForm("Clover, the kitchen light is on."));
  expect(spoken.status).toBe(200);
  const bytes = new Uint8Array(await new Response(spoken.body).arrayBuffer());
  expect(bytes.byteLength).toBeGreaterThan(44);
  expect(activeTtsChoice()).toMatchObject({ engine: "pocket", requested: "chatterbox-turbo" });
  expect(activeTtsChoice().reason).toMatch(/No module named mlx/);
  expect(listHealth().find((item) => item.code === "tts.engine-fallback")).toMatchObject({ severity: "warning" });
  expect(ttsEngineInEffect()).toBe("pocket");
}, 60_000);
