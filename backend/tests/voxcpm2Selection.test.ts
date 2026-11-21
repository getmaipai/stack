// VOICE-VOXCPM2-01 step 2: VoxCPM2 is chosen only by name (`stack.voice.engine` = voxcpm2 or voxcpm2-reduced), runs in its own
// environment with the size's files and the clip speech-to-text installed, takes the clip's words through the speech route, and
// never fetches the Chatterbox clip tokenizer. An install that never changes the setting is unchanged.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "@/app";
import { __resetHealthForTests } from "@/lib/health";
import { buildDiskPlan } from "@/lib/diskPlan";
import { buildInstallPlan } from "@/lib/installPlan";
import { clearModelsForTests, upsertModel } from "@/lib/modelStore";
import { STACK_MODELS, STACK_TTS_CHATTERBOX_MODEL, STACK_TTS_CHATTERBOX_PARTS, VOXCPM2_ENGINE, VOXCPM2_REDUCED_ENGINE, voxcpm2PackFor } from "@/lib/modelCatalog";
import { activeTtsChoice, launchPlan, resetSupervisorForTests, scriptedProcess, scriptedSpeechLog, selectedModel, setMachineTier, setSupervisorFactoryForTests, speechForm, ttsEngineInstalled } from "@/lib/supervisor";
import { PROFILE_TIERS } from "@/profiles";
import { ENV_READY_MARKER } from "@/lib/uvEnvironment";
import { mlxAudioRoot } from "@/speech/mlxAudio";
import { __resetClonerCheckForTests, __setClonerForTests } from "@/speech/chatterboxClones";
import { clearTtsEngineFailures } from "@/speech/ttsEngines";
import { voxcpm2Proof, voxcpm2Root, voxcpm2Python } from "@/speech/voxcpm2";
import { __resetSettingsForTests, applyPendingSettings, updateSettings } from "@/settings";

const verified = { source: "catalog" as const, provenance: { repo: "example/repo" }, revision: "r", sha256: "c".repeat(64), licence: "MIT", verifiedAt: new Date().toISOString(), modelPath: "/tmp/never/x" };
let clonerFetches = 0;
beforeEach(() => {
  __resetHealthForTests(); __resetSettingsForTests(); clearModelsForTests(); clearTtsEngineFailures(); setMachineTier("p128");
  setSupervisorFactoryForTests(async (role) => scriptedProcess(role)); scriptedSpeechLog.length = 0; clonerFetches = 0;
  __resetClonerCheckForTests(); __setClonerForTests(async () => { clonerFetches += 1; });
});
afterEach(() => {
  __setClonerForTests(null); setSupervisorFactoryForTests(null); resetSupervisorForTests(); clearModelsForTests(); __resetSettingsForTests(); clearTtsEngineFailures(); setMachineTier(undefined);
  rmSync(voxcpm2Root(), { recursive: true, force: true }); rmSync(mlxAudioRoot(), { recursive: true, force: true });
});

function fakeVoxcpm2Environment(): void {
  const root = voxcpm2Root();
  mkdirSync(join(root, "venv", "bin"), { recursive: true });
  const python = voxcpm2Python(); writeFileSync(python, "#!/bin/sh\n"); chmodSync(python, 0o755);
  mkdirSync(join(voxcpm2Proof(), ".."), { recursive: true }); writeFileSync(voxcpm2Proof(), "# proof\n");
  writeFileSync(join(root, ENV_READY_MARKER), "ok");
}
function installPack(engine: string, withStt = true): void {
  const pack = voxcpm2PackFor(engine).filter((pin) => withStt || pin.engine !== "voxcpm2-stt");
  for (const pin of pack) upsertModel({ id: pin.id, roles: ["tts"], ...verified, ...(pin.component ? {} : { sizeBytes: pin.download!.approx_bytes }), engineRequirements: { engine: pin.engine, ...(pin.component ? { component: pin.component } : {}) } });
}
function choose(engine: string): void { updateSettings({ "stack.voice.engine": engine }); applyPendingSettings(); }
async function speak(fields: Record<string, string>): Promise<Response> {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  const response = await app.request("/v1/audio/speech", { method: "POST", body: form });
  if (response.status === 200) await response.arrayBuffer();
  return response;
}
const CLIP = "http://127.0.0.1:8787/api/voice/cloned/voice-abc123def456/file";

test("with the setting untouched nothing about VoxCPM2 is chosen, installed or in the first-run plan", () => {
  for (const tier of ["p16", "p32", "p64", "p128"] as const) {
    setMachineTier(tier);
    expect(activeTtsChoice().requested).toBe(tier === "p64" || tier === "p128" ? "chatterbox-turbo" : "pocket");
  }
  const ids = new Set(voxcpm2PackFor(VOXCPM2_ENGINE).concat(voxcpm2PackFor(VOXCPM2_REDUCED_ENGINE)).map((pin) => pin.id));
  for (const gb of [16, 32, 64, 128]) {
    const plan = buildInstallPlan({ platform: "darwin", arch: "arm64", totalRamGb: gb, cpuCount: 8, isAppleSilicon: true, unifiedMemoryGb: gb, cudaDevices: [], freeDiskBytes: 500e9, osVersion: "test" });
    for (const model of plan.models) expect(ids.has(model.id)).toBe(false);
  }
  for (const tier of PROFILE_TIERS) for (const row of buildDiskPlan(tier).rows) if (row.id.startsWith("voice-voxcpm2")) expect(row.need).toBe("optional");
});

test("the disk plan offers each size as an optional row (bf16 from 64 GB, 4-bit from 32 GB) with the clip speech-to-text counted in it", () => {
  const rowsOf = (id: string) => buildDiskPlan(PROFILE_TIERS.find((tier) => tier.id === id)!).rows.filter((row) => row.id.startsWith("voice-voxcpm2")).map((row) => row.id);
  expect(rowsOf("p16")).toEqual([]);
  expect(rowsOf("p32")).toEqual(["voice-voxcpm2-reduced"]);
  expect(rowsOf("p128")).toEqual(["voice-voxcpm2", "voice-voxcpm2-reduced"]);
  const row = buildDiskPlan(PROFILE_TIERS.find((tier) => tier.id === "p128")!).rows.find((item) => item.id === "voice-voxcpm2")!;
  expect(row.model_ids).toContain("voxcpm2-clip-stt-model");
  expect(row.model_ids).toContain("voxcpm2-bf16");
  expect(row.engines).toEqual(["engine:voice-voxcpm2", "engine:python"]);
});

test("a size is installed only when its environment, its files and the clip speech-to-text are all there", () => {
  choose("voxcpm2");
  expect(ttsEngineInstalled("voxcpm2")).toBe(false);
  fakeVoxcpm2Environment();
  expect(ttsEngineInstalled("voxcpm2")).toBe(false);
  installPack(VOXCPM2_ENGINE, false);
  expect(ttsEngineInstalled("voxcpm2")).toBe(false); // no listening helper yet
  installPack(VOXCPM2_ENGINE);
  expect(ttsEngineInstalled("voxcpm2")).toBe(true);
  expect(ttsEngineInstalled("voxcpm2-reduced")).toBe(false); // the other size is not
});

test("the launch plan runs the size's repository through the server script in the VoxCPM2 environment, offline, with a launch key", async () => {
  fakeVoxcpm2Environment(); installPack(VOXCPM2_ENGINE); installPack(VOXCPM2_REDUCED_ENGINE);
  choose("voxcpm2");
  expect(activeTtsChoice()).toMatchObject({ engine: "voxcpm2", reason: null });
  const standard = await launchPlan("tts", selectedModel("tts")!, 8123);
  expect(standard.engine).toBe(VOXCPM2_ENGINE);
  expect(standard.command[0]).toBe(voxcpm2Python());
  expect(standard.command.slice(2)).toEqual(["--host", "127.0.0.1", "--port", "8123", "--engine", "voxcpm2", "--repo", "mlx-community/VoxCPM2-bf16"]);
  expect(standard.env?.HF_HUB_OFFLINE).toBe("1");
  expect(standard.env?.HF_TOKEN).toBeUndefined();
  expect(standard.apiKey).toBeTruthy();
  choose("voxcpm2-reduced");
  expect(selectedModel("tts")!.id).toBe("voxcpm2-4bit");
  const reduced = await launchPlan("tts", selectedModel("tts")!, 8124);
  expect(reduced.engine).toBe(VOXCPM2_REDUCED_ENGINE);
  expect(reduced.command.slice(-2)).toEqual(["--repo", "mlx-community/VoxCPM2-4bit"]);
});

test("a chosen size that is not installed falls back to Pocket with the reason, and nothing is launched for it", () => {
  choose("voxcpm2");
  const choice = activeTtsChoice();
  expect(choice.engine).toBe("pocket");
  expect(choice.requested).toBe("voxcpm2");
  expect(choice.reason).toContain("not installed");
});

test("speechForm carries the clip's words only when there are some", () => {
  expect(speechForm("hi", CLIP, { voice_text: "hello there" }).get("voice_text")).toBe("hello there");
  expect(speechForm("hi", CLIP, { voice_text: "   " }).get("voice_text")).toBeNull();
  expect(speechForm("hi", CLIP).get("voice_text")).toBeNull();
});

test("on VoxCPM2 the clip address and its words reach the engine and the Chatterbox tokenizer is never fetched", async () => {
  fakeVoxcpm2Environment(); installPack(VOXCPM2_ENGINE); choose("voxcpm2");
  const response = await speak({ text: "Hello there.", voice_url: CLIP, voice_text: "The words in the recording.", temperature: "1.05" });
  expect(response.status).toBe(200);
  expect(scriptedSpeechLog.at(-1)).toMatchObject({ text: "Hello there.", voice_url: CLIP, voice_text: "The words in the recording.", temperature: "1.05" });
  expect(clonerFetches).toBe(0);
});

test("on VoxCPM2 a clip with no words is sent without them (the engine reads them itself), and an address off the household's network is still refused", async () => {
  fakeVoxcpm2Environment(); installPack(VOXCPM2_ENGINE); choose("voxcpm2");
  expect((await speak({ text: "Hello.", voice_url: CLIP })).status).toBe(200);
  expect(scriptedSpeechLog.at(-1)!.voice_text).toBeUndefined();
  scriptedSpeechLog.length = 0;
  const refused = await speak({ text: "Hello.", voice_url: "http://example.com/clip.wav", voice_text: "x" });
  expect(refused.status).toBe(400);
  expect(scriptedSpeechLog).toHaveLength(0);
});

test("on Chatterbox the clip's words are not sent and the tokenizer is still fetched (unchanged)", async () => {
  for (const pin of [STACK_TTS_CHATTERBOX_MODEL, ...STACK_TTS_CHATTERBOX_PARTS]) upsertModel({ id: pin.id, roles: ["tts"], ...verified, engineRequirements: { engine: "chatterbox-turbo", ...(pin.component ? { component: pin.component } : {}) } });
  const root = mlxAudioRoot(); mkdirSync(join(root, "venv", "bin"), { recursive: true });
  for (const name of ["mlx_audio.tts.generate", "python"]) { const path = join(root, "venv", "bin", name); writeFileSync(path, "#!/bin/sh\n"); chmodSync(path, 0o755); }
  writeFileSync(join(root, ENV_READY_MARKER), "ok");
  const response = await speak({ text: "Hello.", voice_url: CLIP, voice_text: "ignored words" });
  expect(response.status).toBe(200);
  expect(scriptedSpeechLog.at(-1)!.voice_text).toBeUndefined();
  expect(clonerFetches).toBe(1);
});

test("every VoxCPM2 pin is in the catalog list the components and disk plan read, and none is a first-run install", () => {
  const ids = new Set(STACK_MODELS.map((pin) => pin.id));
  for (const pin of voxcpm2PackFor(VOXCPM2_ENGINE).concat(voxcpm2PackFor(VOXCPM2_REDUCED_ENGINE))) expect(ids.has(pin.id)).toBe(true);
});
