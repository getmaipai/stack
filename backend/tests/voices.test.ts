// STACK-94d: the voice engine online only when needed. The engine's
// environment is offline always and never carries the token; a preset
// voice a request names is fetched once by the Stack into the hub cache
// and served offline after; a community voice is pinned to a commit and
// the hub's own digest; a voice that needs cloning is refused with the
// reason when the weights cannot be fetched (no token, cloning off);
// the gated weights are fetched once, with the token, only when cloning
// is on; nothing is asked of the hub on the engine's start. Nothing
// here runs Pocket TTS or reaches Hugging Face.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "@/app";
import type { downloadUrl } from "@/lib/download";
import { __resetHealthForTests } from "@/lib/health";
import { clearModelsForTests, listModels, upsertModel } from "@/lib/modelStore";
import { readHfFile } from "@/lib/store/hfCache";
import { hfRepoRoot } from "@/lib/store/layout";
import { getProcess, getRoleStatus, launchPlan, PROBE_SENTENCE, resetSupervisorForTests, runningEngine, scriptedProcess, setSupervisorFactoryForTests } from "@/lib/supervisor";
import { list as listHealth } from "@/lib/health";
import { POCKET_TTS_GATED_REPO, POCKET_TTS_UNGATED_REPO } from "@/speech/pocketTts";
import { __setVoiceOptionsForTests, cloningWeightsPresent, ensureCloningWeights, POCKET_TTS_CLONING_WEIGHTS, POCKET_TTS_PRESET_VOICES, POCKET_TTS_VOICES_REVISION, prepareVoice, voiceLicence, VoiceRefusedError, voiceNeedsCloning } from "@/speech/voices";
import { __resetSettingsForTests, applyPendingSettings, updateSettings } from "@/settings";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const ANNA = Buffer.from("anna-embedding");
const CLONING = Buffer.from("gated-weights");
const CASUAL = Buffer.from("a community wav");
const COMMIT = "1".repeat(40);

/** A downloader that writes scripted bytes for each URL and records
 * every call with its headers, so a test can say what was asked. */
function scriptedDownloads(): { download: typeof downloadUrl; calls: Array<{ url: string; headers?: Record<string, string> }> } {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  const download: typeof downloadUrl = async (url, destination, options) => {
    calls.push({ url, headers: options?.headers });
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(destination, url.includes("/embeddings/anna.") ? ANNA : url.includes("casual.wav") ? CASUAL : CLONING);
  };
  return { download, calls };
}

beforeEach(() => { __resetHealthForTests(); __resetSettingsForTests(); clearModelsForTests(); setSupervisorFactoryForTests(async (role) => scriptedProcess(role)); });
afterEach(async () => {
  __setVoiceOptionsForTests(null); setSupervisorFactoryForTests(null); resetSupervisorForTests(); clearModelsForTests(); __resetSettingsForTests();
  // What these tests placed (hub files, the scripted environment) leaves with them.
  const { pocketTtsRoot } = await import("@/speech/pocketTts");
  for (const repo of [POCKET_TTS_UNGATED_REPO, POCKET_TTS_GATED_REPO, "kyutai/tts-voices"]) rmSync(hfRepoRoot(repo), { recursive: true, force: true });
  rmSync(join(pocketTtsRoot(), ".."), { recursive: true, force: true });
});

const presets = { ...POCKET_TTS_PRESET_VOICES, anna: { bytes: ANNA.length, sha256: sha(ANNA) } };

test("the engine starts offline: its environment says so, carries no token, and the start asks the hub for nothing", async () => {
  updateSettings({ "stack.engines.tts.hf_token": "hf_examplesecret" });
  applyPendingSettings();
  const { download, calls } = scriptedDownloads();
  __setVoiceOptionsForTests({ download, presets });
  upsertModel({ id: "w", roles: ["tts"], source: "catalog", provenance: { repo: POCKET_TTS_UNGATED_REPO }, revision: "r", sha256: "a".repeat(64), licence: "CC-BY-4.0", verifiedAt: new Date().toISOString(), modelPath: "/tmp/never/w", engineRequirements: { engine: "pocket-tts" } });
  const { pocketTtsRoot, pocketTtsBinary } = await import("@/speech/pocketTts");
  const { ENV_READY_MARKER } = await import("@/lib/uvEnvironment");
  mkdirSync(join(pocketTtsRoot(), "venv", "bin"), { recursive: true });
  writeFileSync(pocketTtsBinary(), "");
  writeFileSync(join(pocketTtsRoot(), ENV_READY_MARKER), "now");
  const plan = launchPlan("tts", listModels()[0]!, 8798);
  expect(plan.env?.HF_HUB_OFFLINE).toBe("1");
  expect(plan.env?.HF_TOKEN).toBeUndefined();
  expect(plan.env?.HF_HUB_ETAG_TIMEOUT).toBeUndefined();
  // A start with cloning off fetches nothing, token or not.
  await getProcess("tts");
  expect(getRoleStatus("tts").state).toBe("ready");
  expect(calls).toEqual([]);
  expect(cloningWeightsPresent()).toBe(false);
});

test("a preset voice the computer does not hold is fetched once by the Stack, verified, placed in the hub cache, then served offline", async () => {
  const { download, calls } = scriptedDownloads();
  __setVoiceOptionsForTests({ download, presets });
  expect(await prepareVoice(undefined)).toBeUndefined();
  expect(await prepareVoice("anna")).toBe("anna");
  expect(calls.length).toBe(1);
  expect(calls[0]!.url).toBe(`https://huggingface.co/${POCKET_TTS_UNGATED_REPO}/resolve/${POCKET_TTS_VOICES_REVISION}/languages/english/embeddings/anna.safetensors`);
  expect(calls[0]!.headers).toBeUndefined();
  expect(readHfFile(POCKET_TTS_UNGATED_REPO, POCKET_TTS_VOICES_REVISION, "languages/english/embeddings/anna.safetensors")?.digest).toBe(sha(ANNA));
  // The engine's own hf:// spelling of the same preset is the same file, and the second ask fetches nothing.
  expect(await prepareVoice(`hf://${POCKET_TTS_UNGATED_REPO}/languages/english/embeddings/anna.safetensors@${POCKET_TTS_VOICES_REVISION}`)).toBe("anna");
  expect(await prepareVoice("anna")).toBe("anna");
  expect(calls.length).toBe(1);
  // The record is a voice component of tts, never a selectable model.
  expect(listModels().find((model) => model.id === "pocket-tts-voice-anna")?.engineRequirements.component).toBe("voice");
  // Through the route: the scripted engine is handed the preset name.
  const form = new FormData(); form.append("text", PROBE_SENTENCE); form.append("voice_url", "anna");
  const response = await app.request("/v1/audio/speech", { method: "POST", body: form });
  expect(response.status).toBe(200);
  expect(calls.length).toBe(1);
  // A name that is not a preset of this build is refused, not fetched.
  await expect(prepareVoice("nobody")).rejects.toBeInstanceOf(VoiceRefusedError);
  expect(calls.length).toBe(1);
});

test("a voice that needs cloning is refused with the reason while the weights cannot be fetched: cloning off, then no token; with both, the weights are fetched once with the token and the engine restarted onto them", async () => {
  const { download, calls } = scriptedDownloads();
  const resolve = async (repo: string) => ({ repo, name: repo, revision: COMMIT, licence: "cc-by-4.0", gated: false, role: "unknown" as const, files: [{ name: "alba-mackenna/casual.wav", sizeBytes: CASUAL.length, sha256: sha(CASUAL), url: `https://huggingface.co/${repo}/resolve/${COMMIT}/alba-mackenna/casual.wav` }] });
  __setVoiceOptionsForTests({ download, resolve, presets });
  const speak = async (voice: string) => { const form = new FormData(); form.append("text", "hello"); form.append("voice_url", voice); return app.request("/v1/audio/speech", { method: "POST", body: form }); };
  expect(voiceNeedsCloning("hf://kyutai/tts-voices/alba-mackenna/casual.wav")).toBe(true);
  expect(voiceNeedsCloning("anna")).toBe(false);
  // Cloning off: refused, nothing fetched.
  let refused = await speak("hf://kyutai/tts-voices/alba-mackenna/casual.wav");
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ reason: "voice-cloning-unavailable", error: expect.stringContaining("turned off") });
  // Cloning on, no token: refused with the token as the reason.
  updateSettings({ "stack.engines.tts.voice_cloning": true });
  applyPendingSettings();
  refused = await speak("hf://kyutai/tts-voices/alba-mackenna/casual.wav");
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ reason: "voice-cloning-unavailable", error: expect.stringContaining("token") });
  expect(calls).toEqual([]);
  expect(await ensureCloningWeights()).toBe(false);
  // Token set: the engine, running on the ungated twin, is restarted once the weights are placed; the voice is pinned to its commit.
  updateSettings({ "stack.engines.tts.hf_token": "hf_examplesecret" });
  applyPendingSettings();
  const weightsPin = { ...POCKET_TTS_CLONING_WEIGHTS, download: { ...POCKET_TTS_CLONING_WEIGHTS.download!, sha256: sha(CLONING) } };
  __setVoiceOptionsForTests({ download, resolve, presets, cloningWeights: weightsPin });
  setSupervisorFactoryForTests(async (role) => scriptedProcess(role, { identity: { host: "local", build: "pocket-tts-3.1.0", model: cloningWeightsPresent() ? POCKET_TTS_GATED_REPO : POCKET_TTS_UNGATED_REPO, healthy: true } }));
  await getProcess("tts");
  expect(getRoleStatus("tts").identity?.model).toBe(POCKET_TTS_UNGATED_REPO);
  const spoken = await speak("hf://kyutai/tts-voices/alba-mackenna/casual.wav");
  expect(spoken.status).toBe(200);
  expect(calls.map((call) => call.url.split("/").slice(-2).join("/"))).toEqual(["alba-mackenna/casual.wav", "english/model.safetensors"]);
  expect(calls[1]!.headers).toEqual({ Authorization: "Bearer hf_examplesecret" });
  expect(cloningWeightsPresent()).toBe(true);
  expect(readHfFile("kyutai/tts-voices", COMMIT, "alba-mackenna/casual.wav")?.digest).toBe(sha(CASUAL));
  expect(getRoleStatus("tts").identity?.model).toBe(POCKET_TTS_GATED_REPO);
  // A second ask for the same voice fetches nothing and restarts nothing.
  await speak("hf://kyutai/tts-voices/alba-mackenna/casual.wav");
  expect(calls.length).toBe(2);
  // The next start fetches nothing either: the weights are on disk.
  resetSupervisorForTests();
  setSupervisorFactoryForTests(async (role) => scriptedProcess(role));
  await getProcess("tts");
  expect(calls.length).toBe(2);
  expect(runningEngine("tts")).toBeNull();
});

test("a voice served on the household's own network passes to the engine; one on the public internet is refused; a file the hub publishes no digest for is refused", async () => {
  const { download } = scriptedDownloads();
  updateSettings({ "stack.engines.tts.voice_cloning": true, "stack.engines.tts.hf_token": "hf_examplesecret" });
  applyPendingSettings();
  const weightsPin = { ...POCKET_TTS_CLONING_WEIGHTS, download: { ...POCKET_TTS_CLONING_WEIGHTS.download!, sha256: sha(CLONING) } };
  const resolve = async (repo: string) => ({ repo, name: repo, revision: COMMIT, licence: "cc-by-4.0", gated: false, role: "unknown" as const, files: [{ name: "plain.wav", sizeBytes: 3, sha256: null, url: "https://example.com/plain.wav" }] });
  __setVoiceOptionsForTests({ download, resolve, presets, cloningWeights: weightsPin });
  expect(await prepareVoice("http://192.168.1.20:8080/voices/dad.wav")).toBe("http://192.168.1.20:8080/voices/dad.wav");
  expect(await prepareVoice("http://localhost:3000/v.wav")).toBe("http://localhost:3000/v.wav");
  await expect(prepareVoice("https://example.com/v.wav")).rejects.toMatchObject({ status: 400, reason: "voice-not-pinnable" });
  await expect(prepareVoice("hf://kyutai/tts-voices/plain.wav")).rejects.toThrow(/no digest/);
  await expect(prepareVoice("hf://kyutai/tts-voices/missing.wav")).rejects.toThrow(/has no file/);
  // The voices repository declares no licence as a whole; its README states each folder's, and a folder it does not state is refused.
  expect(voiceLicence("kyutai/tts-voices", "alba-mackenna/casual.wav", null)).toBe("CC-BY-4.0");
  expect(voiceLicence("kyutai/tts-voices", "expresso/x.wav", null)).toBe("CC-BY-NC-4.0");
  expect(voiceLicence("kyutai/tts-voices", "unmute-prod-website/x.wav", null)).toBeNull();
  expect(voiceLicence("someone/voices", "x.wav", "cc-by-4.0")).toBe("cc-by-4.0");
  const unlicensed = async (repo: string) => ({ repo, name: repo, revision: COMMIT, licence: null, gated: false, role: "unknown" as const, files: [{ name: "unmute-prod-website/x.wav", sizeBytes: 3, sha256: "a".repeat(64), url: "https://example.com/x.wav" }] });
  __setVoiceOptionsForTests({ download, resolve: unlicensed, presets, cloningWeights: weightsPin });
  await expect(prepareVoice("hf://kyutai/tts-voices/unmute-prod-website/x.wav")).rejects.toThrow(/declares no licence/);
  expect(listHealth().find((item) => item.code === "voice-cloning-weights.tts")).toBeUndefined();
});

test("the gated weights failing checksum verification is reported as a cloning problem (409), not an unpinnable voice (400)", async () => {
  updateSettings({ "stack.engines.tts.voice_cloning": true, "stack.engines.tts.hf_token": "hf_examplesecret" });
  applyPendingSettings();
  const resolve = async (repo: string) => ({ repo, name: repo, revision: COMMIT, licence: "cc-by-4.0", gated: false, role: "unknown" as const, files: [{ name: "alba-mackenna/casual.wav", sizeBytes: CASUAL.length, sha256: sha(CASUAL), url: `https://huggingface.co/${repo}/resolve/${COMMIT}/alba-mackenna/casual.wav` }] });
  const download: typeof downloadUrl = async (url, destination) => {
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(destination, url.includes("model.safetensors") ? Buffer.from("the wrong bytes") : CASUAL);
  };
  __setVoiceOptionsForTests({ download, resolve, presets });
  const form = new FormData(); form.append("text", "hello"); form.append("voice_url", "hf://kyutai/tts-voices/alba-mackenna/casual.wav");
  const response = await app.request("/v1/audio/speech", { method: "POST", body: form });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ reason: "voice-cloning-unavailable" });
});
