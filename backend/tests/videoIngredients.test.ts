// POST /v1/videos/ingredients: reference sheets plus the installed Ingredients IC-LoRA (Max only). A fake worker, no model.
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
import { memoryVerdict, videoGen, type VideoGenDeps, type WorkerHandle, type WorkerRequest, type WorkerReply } from "@/video/videoGen";
import { importLora } from "@/video/loras";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaToolbox } from "@/media/tools";
import type { Runner } from "@/media/run";
import { LTX25_ICLORA_PEAK_BYTES, LTX25_INGREDIENTS_PEAK_BYTES, ltx25IngredientsFrames } from "@/video/ltx25";

const GB = 1_073_741_824;
let root = ""; let loraId = "";
const requests: WorkerRequest[] = []; const sheetFiles: string[][] = [];
const toolbox: MediaToolbox = { installed: () => true, path: async (tool) => `/fake/${tool}` };
const runner: Runner = async () => ({ code: 0, stdout: "", stderr: "", aborted: false });
function stubWorker(): VideoGenDeps { return { supported: () => true, ensureEnvironment: async () => {}, paths: () => ({ modelDir: "/models/max", tokenizerDir: "/models/gemma", textEncoderDir: "/models/gemma" }), spawn: async (): Promise<WorkerHandle> => { let done!: (n: number) => void; const exited = new Promise<number>((r) => done = r); return { exited, kill: () => done(143), send: async (request, opts) => { requests.push(request); sheetFiles.push((request.reference_sheets ?? []).map((file) => existsSync(file) ? "present" : "missing")); writeFileSync(request.output, "video-bytes"); writeFileSync(request.poster, "poster-bytes"); opts.onEvent({ id: request.id, event: "phase", phase: "loading", percent: 0 }); return { id: request.id, ok: true, width: 768, height: 448, frames: request.num_frames, fps: 24, seed: request.seed, ms: 50, peak_bytes: 81_400_000_000, audio: true } satisfies WorkerReply; } }; } }; }
/** A PNG header with the given size (the route reads the signature and the size only). */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33); bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer); view.setUint32(16, width); view.setUint32(20, height); return bytes;
}
function post(fields: Record<string, string | undefined> = {}, sheets: Uint8Array[] = [png(768, 448)]) {
  const form = new FormData();
  for (const sheet of sheets) form.append("sheet", new File([sheet], "sheet.png", { type: "image/png" }));
  const all: Record<string, string | undefined> = { prompt: "Reference sheet: a fox. Generated video: the fox runs.", timeout_ms: "5000", ...fields };
  for (const [key, value] of Object.entries(all)) if (value !== undefined) form.append(key, value);
  return app.request("/v1/videos/ingredients", { method: "POST", body: form });
}
async function install(name: string): Promise<string> {
  const safetensors = join(root, `${name}.safetensors`); const header = Buffer.from(JSON.stringify({ __metadata__: { format: "pt" }, "transformer_blocks.0.attn1.to_k.lora_A.weight": { dtype: "F32", shape: [1, 4096], data_offsets: [0, 4] }, "transformer_blocks.0.attn1.to_k.lora_B.weight": { dtype: "F32", shape: [4096, 1], data_offsets: [4, 8] } }));
  const prefix = Buffer.alloc(8); prefix.writeBigUInt64LE(BigInt(header.length)); writeFileSync(safetensors, Buffer.concat([prefix, header, Buffer.alloc(8)]));
  return (await importLora({ name, path: safetensors, sourceUrl: `https://example.test/${name}.safetensors`, licence: "MIT", declaredBase: "ltx-2.5", classification: "all-ages" })).id;
}
beforeEach(() => {
  requests.length = 0; sheetFiles.length = 0; videoGen.useDeps(stubWorker()); __resetJobsForTests(); __resetGovernorForTests(); __resetProvenanceForTests();
  rmSync(join(dataDir, "video"), { recursive: true, force: true }); rmSync(join(dataDir, "tmp", "video"), { recursive: true, force: true }); __resetRootsForTests();
  root = mkdtempSync(join(tmpdir(), "ingredients-")); setRoots({ read: [root] });
  __setEditRuntimeForTests({ toolbox, run: runner }); __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 100 * GB, tier: "p128" }); registerVideoJobs();
});
afterEach(() => { rmSync(join(dataDir, "video"), { recursive: true, force: true }); videoGen.useDeps(null); __resetJobsForTests(); __resetGovernorForTests(); __resetProvenanceForTests(); __setEditRuntimeForTests(null); __resetRootsForTests(); rmSync(root, { recursive: true, force: true }); rmSync(jobsDir(), { recursive: true, force: true }); });

test("ingredients frames are 1 + 24 seconds, capped at 193", () => {
  expect(ltx25IngredientsFrames(4)).toBe(97); expect(ltx25IngredientsFrames(5)).toBe(121); expect(ltx25IngredientsFrames(8)).toBe(193); expect(ltx25IngredientsFrames(9)).toBe(193);
});

test("ingredients without the adapter installed answers 409 ic_lora_missing naming the file", async () => {
  await install("some-other-style");
  const response = await post();
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "ic_lora_missing", error: expect.stringContaining("ltx-2.5-22b-ic-lora-ingredients-0.9.safetensors") });
  expect(requests).toHaveLength(0);
});

test("ingredients refuses bad sheets, prompt, seconds, seed and timeout with plain 400s", async () => {
  loraId = await install("ltx-2.5-22b-ic-lora-ingredients-0.9");
  const wrongSize = await post({}, [png(1024, 576)]);
  expect(wrongSize.status).toBe(400); expect(await wrongSize.json()).toMatchObject({ code: "bad_sheets", error: expect.stringContaining("768x448") });
  expect((await post({}, [])).status).toBe(400);
  expect((await post({}, [png(768, 448), png(768, 448), png(768, 448)])).status).toBe(400);
  expect((await post({}, [new Uint8Array(40)])).status).toBe(400);
  expect((await post({ prompt: "   " })).status).toBe(400);
  expect((await post({ prompt: "x".repeat(2001) })).status).toBe(400);
  expect((await post({ seconds: "3" })).status).toBe(400);
  expect((await post({ seconds: "9" })).status).toBe(400);
  expect((await post({ seconds: "5.5" })).status).toBe(400);
  expect((await post({ seed: "-1" })).status).toBe(400);
  expect((await post({ timeout_ms: "0" })).status).toBe(400);
  expect(requests).toHaveLength(0);
});

test("ingredients with two sheets submits the IC worker request and returns the standard clip shape", async () => {
  loraId = await install("ltx-2.5-22b-ic-lora-ingredients-0.9");
  const response = await post({ seconds: "6", seed: "42" }, [png(768, 448), png(768, 448)]);
  expect(response.status).toBe(200);
  const body = await response.json() as { data: Array<Record<string, unknown>> };
  expect(body.data[0]).toMatchObject({ width: 768, height: 448, frames: 145, seconds: 6, seed: 42, audio: true, mode: "ic_lora", quality: "ltx25max", lora_ids: [loraId], url: expect.stringContaining("video.mp4"), poster_url: expect.stringContaining("poster.jpg") });
  expect(requests[0]).toMatchObject({ op: "ic_lora", profile: "max", ic_lora_strength: 1, width: 768, height: 448, num_frames: 145, seed: 42, ic_lora_path: expect.any(String) });
  expect(requests[0]!.reference_sheets).toHaveLength(2);
  expect(requests[0]!.source_video).toBeUndefined();
  expect(sheetFiles[0]).toEqual(["present", "present"]);
});

test("ingredients defaults to 8 seconds (193 frames) and one sheet", async () => {
  loraId = await install("ltx-2.5-22b-ic-lora-ingredients-0.9");
  const response = await post();
  expect(response.status).toBe(200);
  expect(requests[0]).toMatchObject({ num_frames: 193 });
  expect(requests[0]!.reference_sheets).toHaveLength(1);
});

test("ingredients answers 202 with the job when it outlasts the wait", async () => {
  loraId = await install("ltx-2.5-22b-ic-lora-ingredients-0.9");
  videoGen.useDeps({ ...stubWorker(), spawn: async (): Promise<WorkerHandle> => { let done!: (n: number) => void; const exited = new Promise<number>((r) => done = r); return { exited, kill: () => done(143), send: () => new Promise<WorkerReply>(() => {}) }; } });
  const response = await post({ timeout_ms: "50" });
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ job: expect.any(String), data: [] });
});

test("ingredients admission reserves its own measured footprint, not the colorizer's", () => {
  expect(LTX25_INGREDIENTS_PEAK_BYTES).toBeLessThan(LTX25_ICLORA_PEAK_BYTES);
  expect(LTX25_INGREDIENTS_PEAK_BYTES).toBeGreaterThanOrEqual(32_300_000_000);
  expect(videoAdmission({ quality: "ltx25max", mode: "ic_lora", size: "768x448", seconds: 8 })).toEqual({ requestedBytes: LTX25_INGREDIENTS_PEAK_BYTES, measuredPeakBytes: LTX25_INGREDIENTS_PEAK_BYTES, engine: "video-gen" });
});

test("on a computer with room for the measured Ingredients peak but not the colorizer's, an Ingredients clip is accepted", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 72 * GB, freeMemoryBytes: 72 * GB, tier: "p128" });
  expect(memoryVerdict("ltx25max", LTX25_ICLORA_PEAK_BYTES).ok).toBe(false);
  expect(memoryVerdict("ltx25max", LTX25_INGREDIENTS_PEAK_BYTES).ok).toBe(true);
  await install("ltx-2.5-22b-ic-lora-ingredients-0.9");
  const response = await post({ timeout_ms: "50" });
  expect(response.status).not.toBe(503); // 200 (finished in the fake worker) or 202; never no_memory
  expect([200, 202]).toContain(response.status);
});
