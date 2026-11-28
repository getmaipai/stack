import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STACK_MODELS } from "@/lib/modelCatalog";
import { speechWorkerCommand } from "@/lib/supervisor";
import { PROFILE_MODEL_BINDINGS } from "@/profiles";
import { soundTaggingFilesFor, tagSounds } from "@/speech/soundTagging";
import { parseWorkerArgs } from "@/speech/worker";


const MODEL_ID = "zipformer-small-audio-tagging-2024-04-15";
const URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/audio-tagging-models/sherpa-onnx-zipformer-small-audio-tagging-2024-04-15.tar.bz2";
const SHA = "07e2fafcdcbc461f2816188d9b0bbafced12584030cf67d5652e549ef256a2c6";
const dir = join(tmpdir(), `sound-tags-${process.pid}`);
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.MAIPAI_SOUND_TAGGING_DIR; });

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

