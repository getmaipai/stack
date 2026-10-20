// VOICES-02: a voice made from a clip on the Chatterbox engine. The request carries the clip address, the voice's own
// sampling temperature and pitch offset; ranges are refused with a plain message; only an address on the household's own
// network is taken; a zero offset is no shift; the Pocket engine ignores all of it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "@/app";
import { __resetHealthForTests } from "@/lib/health";
import { clearModelsForTests, upsertModel } from "@/lib/modelStore";
import { STACK_TTS_CHATTERBOX_MODEL, STACK_TTS_CHATTERBOX_PARTS, STACK_TTS_CHATTERBOX_CLONER } from "@/lib/modelCatalog";
import { resetSupervisorForTests, scriptedProcess, scriptedSpeechLog, setMachineTier, setSupervisorFactoryForTests, speechForm } from "@/lib/supervisor";
import { ENV_READY_MARKER } from "@/lib/uvEnvironment";
import { mlxAudioRoot } from "@/speech/mlxAudio";
import { pocketTtsRoot } from "@/speech/pocketTts";
import { __setClonerForTests, PITCH_MESSAGE, TEMPERATURE_MESSAGE, voiceSettingsRefusal } from "@/speech/chatterboxClones";
import { clearTtsEngineFailures } from "@/speech/ttsEngines";
import { __resetSettingsForTests, applyPendingSettings, updateSettings } from "@/settings";

const verified = { source: "catalog" as const, provenance: { repo: "example/repo" }, revision: "r", sha256: "c".repeat(64), licence: "MIT", verifiedAt: new Date().toISOString(), modelPath: "/tmp/never/x" };
let clonerFetches = 0;
beforeEach(() => {
  __resetHealthForTests(); __resetSettingsForTests(); clearModelsForTests(); clearTtsEngineFailures(); setMachineTier("p128");
  setSupervisorFactoryForTests(async (role) => scriptedProcess(role));
  scriptedSpeechLog.length = 0; clonerFetches = 0;
  __setClonerForTests(async () => { clonerFetches += 1; });
});
afterEach(() => {
  __setClonerForTests(null); setSupervisorFactoryForTests(null); resetSupervisorForTests(); clearModelsForTests(); __resetSettingsForTests(); clearTtsEngineFailures(); setMachineTier(undefined);
  rmSync(mlxAudioRoot(), { recursive: true, force: true }); rmSync(pocketTtsRoot(), { recursive: true, force: true });
});

function chatterboxInstalled(): void {
  upsertModel({ id: STACK_TTS_CHATTERBOX_MODEL.id, roles: ["tts"], ...verified, sizeBytes: 2_985_990_960, engineRequirements: { engine: "chatterbox-turbo" } });
  for (const part of STACK_TTS_CHATTERBOX_PARTS) upsertModel({ id: part.id, roles: ["tts"], ...verified, engineRequirements: { engine: "chatterbox-turbo", component: part.component } });
  upsertModel({ id: "pocket-tts-english", roles: ["tts"], ...verified, sizeBytes: 219_029_196, engineRequirements: { engine: "pocket-tts" } });
  upsertModel({ id: "tok", roles: ["tts"], ...verified, engineRequirements: { engine: "pocket-tts", component: "tokenizer" } });
  upsertModel({ id: "voice", roles: ["tts"], ...verified, engineRequirements: { engine: "pocket-tts", component: "voice" } });
  for (const [root, files] of [[pocketTtsRoot(), { "pocket-tts": "#!/bin/sh\n" }], [mlxAudioRoot(), { "mlx_audio.tts.generate": "#!/bin/sh\n", python: "#!/bin/sh\n" }]] as const) {
    mkdirSync(join(root, "venv", "bin"), { recursive: true });
    for (const [name, body] of Object.entries(files)) { const path = join(root, "venv", "bin", name); writeFileSync(path, body); chmodSync(path, 0o755); }
    writeFileSync(join(root, ENV_READY_MARKER), "ok");
  }
}
async function speak(fields: Record<string, string>): Promise<Response> {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  const response = await app.request("/v1/audio/speech", { method: "POST", body: form });
  if (response.status === 200) await response.arrayBuffer();
  return response;
}
const CLIP = "http://127.0.0.1:8787/api/voice/cloned/voice-abc123def456/file";

test("the cloner pin is a complete record: one commit, a digest, a size, a licence, a hub file, and not part of the first-run set", () => {
  expect(STACK_TTS_CHATTERBOX_CLONER.revision).toMatch(/^[0-9a-f]{40}$/);
  expect(STACK_TTS_CHATTERBOX_CLONER.download!.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(STACK_TTS_CHATTERBOX_CLONER.download!.approx_bytes).toBeGreaterThan(400_000_000);
  expect(STACK_TTS_CHATTERBOX_CLONER.license).toBe("Apache-2.0");
  expect(STACK_TTS_CHATTERBOX_CLONER.download!.url).toContain(`/resolve/${STACK_TTS_CHATTERBOX_CLONER.revision}/model.safetensors`);
  expect(STACK_TTS_CHATTERBOX_PARTS).not.toContain(STACK_TTS_CHATTERBOX_CLONER);
});

test("the ranges: 0.1 to 2.0 for the temperature and -12 to 12 for the pitch, the ends included, each refusal in plain words", () => {
  expect(voiceSettingsRefusal(undefined, undefined)).toBeNull();
  for (const [t, p] of [[0.1, -12], [2.0, 12], [1.05, -1]] as const) expect(voiceSettingsRefusal(t, p)).toBeNull();
  for (const t of [0.09, 2.01, Number.NaN, -1]) expect(voiceSettingsRefusal(t, undefined)).toBe(TEMPERATURE_MESSAGE);
  for (const p of [-12.5, 13, Number.NaN]) expect(voiceSettingsRefusal(undefined, p)).toBe(PITCH_MESSAGE);
});

test("speechForm sends a temperature and a non-zero pitch, and leaves a zero offset and absent values out", () => {
  const full = speechForm("hi", CLIP, { temperature: 1.05, pitch_semitones: -1 });
  expect([full.get("temperature"), full.get("pitch_semitones")]).toEqual(["1.05", "-1"]);
  const flat = speechForm("hi", CLIP, { pitch_semitones: 0 });
  expect([flat.get("temperature"), flat.get("pitch_semitones")]).toEqual([null, null]);
  expect(speechForm("hi").get("voice_url")).toBeNull();
});

test("on Chatterbox a clip address reaches the engine with its temperature and pitch, and the tokenizer is fetched once per request", async () => {
  chatterboxInstalled();
  const response = await speak({ text: "Soooo, hello!", voice_url: CLIP, temperature: "1.05", pitch_semitones: "-1" });
  expect(response.status).toBe(200);
  expect(scriptedSpeechLog.at(-1)).toMatchObject({ text: "Soooo, hello!", voice_url: CLIP, temperature: "1.05", pitch_semitones: "-1" });
  expect(clonerFetches).toBe(1);
});

test("a voice without a temperature or a pitch sends neither, so the engine default and no shift apply", async () => {
  chatterboxInstalled();
  expect((await speak({ text: "hello", voice_url: CLIP })).status).toBe(200);
  const sent = scriptedSpeechLog.at(-1)!;
  expect(sent.voice_url).toBe(CLIP);
  expect(sent.temperature).toBeUndefined();
  expect(sent.pitch_semitones).toBeUndefined();
});

test.each([["temperature", "0.05", TEMPERATURE_MESSAGE], ["temperature", "2.5", TEMPERATURE_MESSAGE], ["pitch_semitones", "13", PITCH_MESSAGE], ["pitch_semitones", "-12.5", PITCH_MESSAGE]])("%s %s is refused with a plain message before the engine hears it", async (field, value, message) => {
  chatterboxInstalled();
  const response = await speak({ text: "hello", voice_url: CLIP, [field]: value });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: message });
  expect(scriptedSpeechLog).toHaveLength(0);
});

test("an address outside the household's own network is refused, and no tokenizer is fetched for it", async () => {
  chatterboxInstalled();
  const response = await speak({ text: "hello", voice_url: "https://example.com/clip.wav" });
  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: string }).error).toContain("example.com");
  expect(clonerFetches).toBe(0);
});

test("a preset name still means the engine's own default voice on Chatterbox", async () => {
  chatterboxInstalled();
  expect((await speak({ text: "hello", voice_url: "alba", temperature: "1.05" })).status).toBe(200);
  expect(scriptedSpeechLog.at(-1)!.voice_url).toBeUndefined();
  expect(scriptedSpeechLog.at(-1)!.temperature).toBeUndefined();
});

test("a failed tokenizer fetch says what to do, and the voice is not spoken", async () => {
  chatterboxInstalled();
  __setClonerForTests(async () => { throw new Error("offline"); });
  const response = await speak({ text: "hello", voice_url: CLIP });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ reason: "voice-cloning-unavailable" });
  expect(scriptedSpeechLog).toHaveLength(0);
});

test("the Pocket engine ignores a temperature and a pitch", async () => {
  chatterboxInstalled();
  updateSettings({ "stack.voice.engine": "pocket" }); applyPendingSettings();
  expect((await speak({ text: "hello", voice_url: "alba", temperature: "1.05", pitch_semitones: "-1" })).status).toBe(200);
  const sent = scriptedSpeechLog.at(-1)!;
  expect(sent.temperature).toBeUndefined();
  expect(sent.pitch_semitones).toBeUndefined();
});
