import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STACK_MODELS } from "@/lib/modelCatalog";
import { speechWorkerCommand } from "@/lib/supervisor";
import { PROFILE_MODEL_BINDINGS } from "@/profiles";
import { soundTaggingFilesFor, tagSounds } from "@/speech/soundTagging";
import { mapTagsToEvents, SOUND_EVENT_CLASSES } from "@/speech/soundEvents";
import { app } from "@/app";
import { EngineUnavailableError, resetSupervisorForTests, scriptedProcess, setSupervisorFactoryForTests } from "@/lib/supervisor";
import { parseWorkerArgs } from "@/speech/worker";


const MODEL_ID = "zipformer-small-audio-tagging-2024-04-15";
const URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/audio-tagging-models/sherpa-onnx-zipformer-small-audio-tagging-2024-04-15.tar.bz2";
const SHA = "07e2fafcdcbc461f2816188d9b0bbafced12584030cf67d5652e549ef256a2c6";
const dir = join(tmpdir(), `sound-tags-${process.pid}`);

test("sound event mapping reports only closed classes above their threshold", () => {
  expect(SOUND_EVENT_CLASSES).toHaveLength(12);
  expect(mapTagsToEvents([
    { label: "Smoke detector, smoke alarm", score: 0.72 },
    { label: "Fire alarm", score: 0.81 },
    { label: "unmapped private label", score: 0.99 },
    { label: "Siren", score: 0.2 },
  ])).toEqual([{ class: "smoke_alarm", score: 0.81 }]);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.MAIPAI_SOUND_TAGGING_DIR; });

test("public sound events route validates, maps busy and missing worker, succeeds, and never logs events", async () => {
  const original = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  const audio = new Uint8Array(320);
  const headers = { "content-type": "audio/pcm;format=s16le;channels=1" };
  try {
    const malformed = await app.request("/v1/audio/events?sampleRate=16000", { method: "POST", headers: { "content-type": "audio/pcm;format=float32;channels=2" }, body: audio });
    expect(malformed.status).toBe(400);
    const long = await app.request("/v1/audio/events?sampleRate=16000", { method: "POST", headers, body: new Uint8Array(16_000 * 2 * 5) });
    expect(long.status).toBe(413);
    setSupervisorFactoryForTests(async (role) => scriptedProcess(role, { client: { baseUrl: "test", request: async () => ({ status: 200, body: { events: [{ class: "smoke_alarm", score: 0.91 }] }, headers: {} }), health: async () => true } as never }));
    const success = await app.request("/v1/audio/events?sampleRate=16000", { method: "POST", headers, body: audio });
    expect(success.status).toBe(200);
    expect(await success.json()).toEqual({ events: [{ class: "smoke_alarm", score: 0.91 }] });
    setSupervisorFactoryForTests(async (role) => scriptedProcess(role, { client: { baseUrl: "test", request: async () => ({ status: 503, body: { error: "busy" }, headers: {} }), health: async () => false } as never }));
    const unavailable = await app.request("/v1/audio/events?sampleRate=16000", { method: "POST", headers, body: audio });
    expect(unavailable.status).toBe(503);
    expect(logs.join("\n")).not.toMatch(/smoke_alarm|0\.91/);
  } finally {
    console.log = original;
    setSupervisorFactoryForTests(null);
    resetSupervisorForTests();
  }
});

test("sound tagging pin is exact, optional, and absent from defaults", () => {
  const model = STACK_MODELS.find((item) => item.id === MODEL_ID);
  expect(model).toMatchObject({ role: "stt", component: "sound-tagging", license: "Apache-2.0", repo: "k2-fsa/sherpa-onnx-zipformer-small-audio-tagging-2024-04-15", revision: "c24f9d0fdf7d0b8c0c4f9733aa0cac51fda10c95", download: { url: URL, sha256: SHA, approx_bytes: 111034072, archive: true } });
  expect(JSON.stringify(model)).not.toContain("measured");
  expect(JSON.stringify(PROFILE_MODEL_BINDINGS)).not.toContain(MODEL_ID);
});

test("tagSounds resamples, filters, sorts and caps at five", () => {
  let receivedRate = 0;
  let receivedLength = 0;
  const tags = tagSounds(new Float32Array(48_000).fill(0.2), 48_000, { sampleRate: 16_000, compute(samples, rate) { receivedRate = rate; receivedLength = samples.length; return ["a", "b", "c", "d", "e", "f", "quiet"].map((label, i) => ({ label, score: [0.4, 0.8, 0.6, 0.5, 0.3, 0.2, 0.09][i]! })); } });
  expect(receivedRate).toBe(16_000);
  expect(receivedLength).toBe(16_000);
  expect(tags).toEqual([{ label: "b", score: 0.8 }, { label: "c", score: 0.6 }, { label: "d", score: 0.5 }, { label: "a", score: 0.4 }, { label: "e", score: 0.3 }]);
  expect(tagSounds(new Float32Array(), 48_000, { sampleRate: 16_000, compute: () => [] })).toEqual([]);
  expect(tagSounds(new Float32Array(100), 16_000, { sampleRate: 16_000, compute: () => [{ label: "silence", score: 1 }] })).toEqual([]);
});

test("installed component and override resolve to tagger files and worker args only include installed files", () => {
  mkdirSync(dir, { recursive: true });
  const model = join(dir, "model.int8.onnx"), labels = join(dir, "class_labels_indices.csv");
  writeFileSync(model, "model"); writeFileSync(labels, "labels");
  const records = [{ modelPath: dir, engineRequirements: { component: "sound-tagging" } }];
  expect(soundTaggingFilesFor(records)).toEqual({ model, labels });
  const command = speechWorkerCommand({ role: "stt", port: 9000, modelPath: "/m/stt", vadPath: "/m/vad", threads: 2, soundTagging: soundTaggingFilesFor(records)! }, { execPath: "/usr/bin/bun", main: "/app/index.ts", isCompiled: false });
  expect(parseWorkerArgs(command.slice(command.indexOf("speech-worker"))).soundTagging).toEqual({ model, labels });
  const plain = speechWorkerCommand({ role: "stt", port: 9000, modelPath: "/m/stt", vadPath: "/m/vad", threads: 2 }, { execPath: "/usr/bin/bun", main: "/app/index.ts", isCompiled: false });
  expect(parseWorkerArgs(plain.slice(plain.indexOf("speech-worker"))).soundTagging).toBeUndefined();
  process.env.MAIPAI_SOUND_TAGGING_DIR = dir;
  expect(soundTaggingFilesFor([])).toEqual({ model, labels });
});

