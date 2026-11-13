// IC-LoRA lane contract tests. These are written before the implementation.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetJobsForTests } from "@/lib/jobs";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly } from "@/lib/governor";
import { __resetRootsForTests, jobsDir, setRoots } from "@/media/paths";
import { dataDir } from "@/lib/paths";
import { __resetProvenanceForTests } from "@/video/provenance";
import { registerVideoJobs } from "@/video/jobs";
import { videoAdmission } from "@/video/jobs";
import { __setEditRuntimeForTests } from "@/video/ltx25Edit";
import { videoGen, type VideoGenDeps, type WorkerHandle, type WorkerRequest, type WorkerReply } from "@/video/videoGen";
import { importLora, listLoras, removeLora } from "@/video/loras";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaToolbox } from "@/media/tools";
import type { Runner } from "@/media/run";
import { LTX25_ICLORA_PEAK_BYTES, ltx25IcLoraRefusal } from "@/video/ltx25";
import { memoryVerdict } from "@/video/videoGen";

test("IC-LoRA is restricted to the measured Max size and 10 second limit", () => {
  expect(ltx25IcLoraRefusal("ltx25", 1024, 576, 121)).toMatch(/Max/);
  expect(ltx25IcLoraRefusal("ltx25max", 1024, 576, 249)).toMatch(/10 seconds/);
  expect(ltx25IcLoraRefusal("ltx25max", 1024, 576, 121)).toBeNull();
});

test("IC-LoRA admission uses the measured OS footprint plus governor headroom", () => {
  expect(LTX25_ICLORA_PEAK_BYTES).toBeGreaterThanOrEqual(81_000_000_000);
  expect(memoryVerdict("ltx25max", LTX25_ICLORA_PEAK_BYTES)).toHaveProperty("ok");
});

const GB = 1_073_741_824;
let root = ""; let source = ""; let loraId = ""; let probe: unknown;
const requests: WorkerRequest[] = [];
const toolbox: MediaToolbox = { installed: () => true, path: async (tool) => `/fake/${tool}` };
const runner: Runner = async (argv) => argv[0] === "/fake/ffprobe" ? { code: 0, stdout: JSON.stringify(probe), stderr: "", aborted: false } : { code: 0, stdout: "", stderr: "", aborted: false };
function stubWorker(): VideoGenDeps { return { supported: () => true, ensureEnvironment: async () => {}, paths: () => ({ modelDir: "/models/max", tokenizerDir: "/models/gemma", textEncoderDir: "/models/gemma" }), spawn: async (): Promise<WorkerHandle> => { let done!: (n: number) => void; const exited = new Promise<number>((r) => done = r); return { exited, kill: () => done(143), send: async (request, opts) => { requests.push(request); if (request.source_video && !existsSync(request.source_video)) throw new Error("no copied source"); writeFileSync(request.output, "video-bytes"); writeFileSync(request.poster, "poster-bytes"); opts.onEvent({ id: request.id, event: "phase", phase: "loading", percent: 0 }); return { id: request.id, ok: true, width: 1024, height: 576, frames: 121, fps: 24, seed: request.seed, ms: 50, peak_bytes: 81_400_000_000, audio: true } satisfies WorkerReply; } }; } }; }
const request = (extra: Record<string, unknown> = {}) => app.request("/v1/videos/restyle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source, lora: loraId, prompt: "A painted paper world", timeout_ms: 5000, ...extra }) });
beforeEach(async () => {
  requests.length = 0; videoGen.useDeps(stubWorker()); __resetJobsForTests(); __resetGovernorForTests(); __resetProvenanceForTests();
  rmSync(join(dataDir, "video"), { recursive: true, force: true }); rmSync(join(dataDir, "tmp", "video"), { recursive: true, force: true }); __resetRootsForTests();
  root = mkdtempSync(join(tmpdir(), "ic-lora-")); source = join(root, "clip.mp4"); writeFileSync(source, "source-video"); setRoots({ read: [root] });
  probe = { streams: [{ codec_type: "video", width: 1024, height: 576, r_frame_rate: "24/1", nb_frames: "121", duration: "5.04" }, { codec_type: "audio" }], format: { duration: "5.04" } };
  __setEditRuntimeForTests({ toolbox, run: runner }); __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 100 * GB, tier: "p128" }); registerVideoJobs();
  // Installed store fixture: IC artifacts are classified as `other` by the library and selected by id.
  const safetensors = join(root, "ic.safetensors"); const header = Buffer.from(JSON.stringify({ __metadata__: { format: "pt" }, "transformer_blocks.0.attn1.to_k.lora_A.weight": { dtype: "F32", shape: [1, 4096], data_offsets: [0, 4] }, "transformer_blocks.0.attn1.to_k.lora_B.weight": { dtype: "F32", shape: [4096, 1], data_offsets: [4, 8] } }));
  const prefix = Buffer.alloc(8); prefix.writeBigUInt64LE(BigInt(header.length)); writeFileSync(safetensors, Buffer.concat([prefix, header, Buffer.alloc(8)]));
  const added = await importLora({ name: "IC style", path: safetensors, sourceUrl: "https://example.test/ic.safetensors", licence: "MIT", declaredBase: "ltx-2.5", classification: "all-ages" });
  loraId = added.id;
  chmodSync(source, 0o600);
});
// The imported style is removed again: a LoRA left in the library made videoLoraInstall.test.ts count two (2026-11-13).
afterEach(async () => { for (const lora of listLoras()) await removeLora(lora.id); videoGen.useDeps(null); __resetJobsForTests(); __resetGovernorForTests(); __resetProvenanceForTests(); __setEditRuntimeForTests(null); __resetRootsForTests(); rmSync(root, { recursive: true, force: true }); rmSync(jobsDir(), { recursive: true, force: true }); });

test("restyle refusal matrix gives plain corrective 422s", async () => {
  expect((await request({ model: "ltx25-q8" })).status).toBe(422);
  probe = { streams: [{ codec_type: "video", width: 1024, height: 576, r_frame_rate: "24/1", nb_frames: "249", duration: "10.375" }], format: { duration: "10.375" } };
  expect((await (async () => { const response = await request(); return { status: response.status, body: await response.json() }; })()).body).toMatchObject({ error: expect.stringMatching(/10 seconds|241 frames/) });
  probe = { streams: [{ codec_type: "video", width: 1024, height: 576, r_frame_rate: "24/1", nb_frames: "121", duration: "5.04" }] };
  expect((await request({ lora: "missing-id" })).status).toBe(422);
  expect((await request({ strength: 2.5 })).status).toBe(422);
  expect((await request({ prompt: "   " })).status).toBe(422);
});

test("restyle submits IC worker fields and returns the standard clip and poster result shape", async () => {
  const response = await request({ strength: 0.7, conditioning: "edges" });
  expect(response.status).toBe(200);
  const body = await response.json() as { data: Array<Record<string, unknown>> };
  expect(body.data[0]).toMatchObject({ width: 1024, height: 576, audio: true, mode: "ic_lora", lora_ids: [loraId], url: expect.stringContaining("video.mp4"), poster_url: expect.stringContaining("poster.jpg") });
  expect(requests[0]).toMatchObject({ op: "ic_lora", profile: "max", source_video: expect.any(String), ic_lora_path: expect.any(String), ic_lora_strength: 0.7, conditioning: "edges", preserve_source_audio: true, width: 1024, height: 576 });
  expect(requests[0]!.loras).toHaveLength(1);
});

test("restyle admission reserves exactly the IC-LoRA footprint", () => {
  expect(videoAdmission({ quality: "ltx25max", mode: "ic_lora" })).toEqual({ requestedBytes: LTX25_ICLORA_PEAK_BYTES, measuredPeakBytes: LTX25_ICLORA_PEAK_BYTES, engine: "video-gen" });
});
