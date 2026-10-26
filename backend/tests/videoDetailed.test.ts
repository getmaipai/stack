// VIDEO-LTX-01: the Detailed video model (LTX-2.3) beside Quick: the router, the hard ceilings, the base-model check on LoRAs,
// the pins, the install and disk numbers, driven by a scripted worker (no model, no GPU). The real worker on the real weights was
// run on the Studio under the GPU lock (design note, "What was measured").
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, admit } from "@/lib/governor";
import { __resetJobsForTests } from "@/lib/jobs";
import { LTX_LICENCE, LTX_UPSCALER_FILE, STACK_MODELS, STACK_VIDEO_DETAILED_MODEL, STACK_VIDEO_DETAILED_MODEL_ID, STACK_VIDEO_MODEL, STACK_VIDEO_TEXT_ENCODER } from "@/lib/modelCatalog";
import { registerVideoJobs } from "@/video/jobs";
import { detectLoraBase, importLora, LoraError, readLoraHeader, resolveLoras } from "@/video/loras";
import { __resetProvenanceForTests, recordGeneratedImage } from "@/video/provenance";
import { defaultVideoGenDeps, qualityOfModelName, memoryVerdict, VIDEO_SPECS, videoGen, type VideoGenDeps, type WorkerHandle, type WorkerReply, type WorkerRequest } from "@/video/videoGen";
import { dataDir } from "@/lib/paths";
import { diskPlanForTier } from "@/lib/diskPlan";

const GB = 1_073_741_824;
const requests: WorkerRequest[] = [];
let killed = 0;
let spawnedQualities: string[] = [];
let installed: Record<string, boolean> = {};

const okReply = (request: WorkerRequest, audio: boolean): WorkerReply => ({ id: request.id, ok: true, width: request.width, height: request.height, frames: request.num_frames, fps: 24, seed: request.seed, ms: 4321, peak_bytes: 41_900_000_000, audio });

function scripted(): VideoGenDeps {
  return {
    supported: () => true,
    ensureEnvironment: async () => {},
    paths: (quality) => (installed[quality] ? (quality === "detailed" ? { modelDir: "/models/ltx", tokenizerDir: "/models/gemma", textEncoderDir: "/models/gemma" } : { modelDir: "/models/video", tokenizerDir: "/models/tok" }) : null),
    spawn: async (quality): Promise<WorkerHandle> => {
      spawnedQualities.push(quality);
      let end!: (code: number) => void;
      const exited = new Promise<number>((done) => { end = done; });
      return {
        exited,
        kill: () => { killed += 1; end(143); },
        send: async (request) => {
          requests.push(request);
          writeFileSync(request.output, "MP4DATA-0123456789"); writeFileSync(request.poster, "JPEGDATA");
          return okReply(request, quality === "detailed");
        },
      };
    },
  };
}

function clean(): void {
  videoGen.useDeps(null);
  __resetJobsForTests(); __resetGovernorForTests(); __resetProvenanceForTests();
  rmSync(join(dataDir, "video"), { recursive: true, force: true });
  rmSync(join(dataDir, "tmp", "video"), { recursive: true, force: true });
}
beforeEach(() => {
  requests.length = 0; killed = 0; spawnedQualities = []; installed = { quick: true, detailed: true };
  clean();
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 90 * GB, tier: "p128" });
  registerVideoJobs();
});
afterEach(() => clean());

const post = (body: Record<string, unknown>) => app.request("/v1/videos/generations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function loraFile(name: string, keyStyle: "wan" | "ltx" | "other", dim: number): string {
  const header: Record<string, unknown> = {};
  for (let i = 0; i < 3; i++) {
    const base = keyStyle === "ltx" ? `diffusion_model.transformer_blocks.${i}.attn1.to_q` : keyStyle === "wan" ? `diffusion_model.blocks.${i}.self_attn.q` : `unet.thing.${i}.proj`;
    header[`${base}.lora_A.weight`] = { dtype: "F16", shape: [16, dim], data_offsets: [0, 0] };
    header[`${base}.lora_B.weight`] = { dtype: "F16", shape: [dim, 16], data_offsets: [0, 0] };
  }
  const json = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(json.length));
  const path = join(mkdtempSync(join(tmpdir(), "lora-")), `${name}.safetensors`);
  writeFileSync(path, Buffer.concat([length, json, Buffer.from(name)]));
  return path;
}

test("a model name maps to a quality, and an unknown one is refused with what to use", async () => {
  expect(qualityOfModelName(undefined)).toBe("quick");
  expect(qualityOfModelName("video")).toBe("quick");
  expect(qualityOfModelName("quick")).toBe("quick");
  expect(qualityOfModelName(STACK_VIDEO_MODEL.id)).toBe("quick");
  expect(qualityOfModelName("wan2.2-ti2v-5b-fastwan-mlx")).toBe("quick");
  expect(qualityOfModelName("detailed")).toBe("detailed");
  expect(qualityOfModelName(STACK_VIDEO_DETAILED_MODEL_ID)).toBe("detailed");
  expect(qualityOfModelName("ltx")).toBeNull();
  videoGen.useDeps(scripted());
  const response = await post({ prompt: "x", model: "sora" });
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ code: "unknown_model" });
});

test("a Detailed clip runs on the LTX worker with the Gemma folder, comes back with sound, and is 10 seconds at most", async () => {
  videoGen.useDeps(scripted());
  const response = await post({ prompt: "a hero in a corridor says come with me", model: "detailed", seconds: 10, seed: 7, timeout_ms: 5000 });
  expect(response.status).toBe(200);
  const body = await response.json() as { data: Array<Record<string, unknown>> };
  expect(body.data[0]).toMatchObject({ width: 768, height: 448, frames: 241, seconds: 10, quality: "detailed", audio: true, model: STACK_VIDEO_DETAILED_MODEL_ID });
  expect(spawnedQualities).toEqual(["detailed"]);
  expect(requests[0]).toMatchObject({ model_dir: "/models/ltx", text_encoder_dir: "/models/gemma", num_frames: 241 });
  expect((await post({ prompt: "x", model: "detailed", seconds: 11 })).status).toBe(400);
});

test("a Quick clip is silent and unchanged, and the other model's worker leaves before the next one starts", async () => {
  videoGen.useDeps(scripted());
  const quick = await post({ prompt: "a paper boat", timeout_ms: 5000 });
  expect(quick.status).toBe(200);
  expect(((await quick.json()) as { data: Array<Record<string, unknown>> }).data[0]).toMatchObject({ width: 832, height: 480, frames: 121, quality: "quick", audio: false });
  expect(requests[0]!.text_encoder_dir).toBeUndefined();
  const detailed = await post({ prompt: "a talking hero", model: "detailed", timeout_ms: 5000 });
  expect(detailed.status).toBe(200);
  expect(spawnedQualities).toEqual(["quick", "detailed"]);
  expect(killed).toBe(1);
});

test("Detailed has its own hard ceilings: 5 seconds past Quick is fine, 64-pixel steps, area of 768 x 448", async () => {
  videoGen.useDeps(scripted());
  expect((await post({ prompt: "x", model: "quick", seconds: 6 })).status).toBe(422);
  for (const size of ["832x480", "800x448", "1024x576"]) {
    const response = await post({ prompt: "x", model: "detailed", size });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe("bad_size");
  }
  const portrait = await post({ prompt: "x", model: "detailed", size: "448x768", seconds: 2, timeout_ms: 5000 });
  expect(portrait.status).toBe(200);
  expect(requests[0]).toMatchObject({ width: 448, height: 768, num_frames: 49 });
});

test("a picture starts a Detailed clip too (VIDEO-LTX-02): the generated-picture rule is the same, the status says so, the worker gets the picture", async () => {
  videoGen.useDeps(scripted());
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
  const encoded = Buffer.from(png).toString("base64");
  // Not made by this Stack's image generator: refused for Detailed exactly as for Quick, before anything runs.
  const unknown = await post({ prompt: "x", model: "detailed", image: encoded, image_source: "generated" });
  expect(unknown.status).toBe(422);
  expect(((await unknown.json()) as { code: string }).code).toBe("reference_not_generated");
  expect(requests).toHaveLength(0);
  recordGeneratedImage(png);
  const accepted = await post({ prompt: "the hero says hello", model: "detailed", image: encoded, image_source: "generated", seconds: 5, timeout_ms: 5000 });
  expect(accepted.status).toBe(200);
  const body = await accepted.json() as { data: Array<{ quality: string; mode: string; audio: boolean }> };
  expect(body.data[0]).toMatchObject({ quality: "detailed", mode: "image-to-video", audio: true });
  expect(requests[0]?.image).toBeTruthy();
  expect(spawnedQualities).toEqual(["detailed"]);
  const status = await (await app.request("/stack/v1/video")).json() as { video: { qualities: { quick: { image_to_video: boolean }; detailed: { image_to_video: boolean } } } };
  expect(status.video.qualities.quick.image_to_video).toBe(true);
  expect(status.video.qualities.detailed.image_to_video).toBe(true);
});

test("the Detailed worker builds the picture encoder from the shape of the shipped weights, not the shipped config (the 1024 against 2048 channel mismatch)", async () => {
  const worker = await Bun.file(join(import.meta.dir, "../src/video/ltx_worker.py")).text();
  expect(worker).toContain("encoder_from_pretrained");
  expect(worker).toContain('"compress_all_res": 8');
  expect(worker).toContain('params["multiplier"] = max(1, round(shape[0] * ratio[name] / shape[-1]))');
  // The first-frame preview is drawn with the same call the tiles get (timestep included), and a failure says so on stderr.
  expect(worker).toContain('timestep=kwargs.get("timestep")');
  expect(worker).toContain("video worker: no preview");
});

test("Detailed that is not installed answers 503 not_installed with where to get it; Quick still works", async () => {
  installed = { quick: true, detailed: false };
  videoGen.useDeps(scripted());
  const response = await post({ prompt: "x", model: "detailed" });
  expect(response.status).toBe(503);
  const body = await response.json() as { code: string; error: string };
  expect(body.code).toBe("not_installed");
  expect(body.error).toContain("Settings, Models and storage");
  expect((await post({ prompt: "x", timeout_ms: 5000 })).status).toBe(200);
});

test("Detailed is refused for memory when chat leaves no room, with the same plain words", async () => {
  videoGen.useDeps(scripted());
  __setGovernorTuningForTestsOnly({ tier: "p128", totalMemoryBytes: 64 * GB, freeMemoryBytes: 60 * GB });
  await admit({ id: "chat", kind: "resident", requestedBytes: 28 * GB, pinned: true });
  expect(memoryVerdict("detailed").ok).toBe(false);
  const response = await post({ prompt: "x", model: "detailed" });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "no_memory" });
});

test("a LoRA is read as Quick's or Detailed's from its tensors, and a clip applies only its own model's", async () => {
  const wan = await importLora({ path: loraFile("wanstyle", "wan", 3072), name: "wanstyle", licence: "apache-2.0" });
  const ltx = await importLora({ path: loraFile("ltxstyle", "ltx", 4096), name: "ltxstyle", licence: "apache-2.0" });
  expect(wan.base_model).toBe("wan2.2-ti2v-5b");
  expect(ltx.base_model).toBe("ltx-2.3");
  expect(ltx.classification).toBe("adult-only");
  expect(detectLoraBase(readLoraHeader(loraFile("again", "ltx", 4096)))).toBe("ltx-2.3");
  await expect(importLora({ path: loraFile("other", "other", 4096), name: "other", licence: "apache-2.0" })).rejects.toBeInstanceOf(LoraError);
  await expect(importLora({ path: loraFile("wanbig", "wan", 5120), name: "wanbig", licence: "apache-2.0" })).rejects.toMatchObject({ code: "wrong_base_model" });
  expect((await resolveLoras([{ id: ltx.id }], "adult", "ltx-2.3"))[0]!.record.id).toBe(ltx.id);
  await expect(resolveLoras([{ id: ltx.id }], "adult", "wan2.2-ti2v-5b")).rejects.toMatchObject({ code: "wrong_base_model" });
  await expect(resolveLoras([{ id: wan.id }], "adult", "ltx-2.3")).rejects.toMatchObject({ code: "wrong_base_model" });
  videoGen.useDeps(scripted());
  const mismatched = await post({ prompt: "x", model: "quick", audience: "adult", loras: [{ id: ltx.id }] });
  expect(mismatched.status).toBe(422);
  expect(await mismatched.json()).toMatchObject({ code: "wrong_base_model" });
  const ok = await post({ prompt: "x", model: "detailed", audience: "adult", loras: [{ id: ltx.id, strength: 0.8 }], timeout_ms: 5000 });
  expect(ok.status).toBe(200);
  expect(requests[0]!.loras).toEqual([[expect.stringContaining(ltx.id), 0.8]]);
  const allAges = await post({ prompt: "x", model: "detailed", audience: "all-ages", loras: [{ id: ltx.id }] });
  expect(allAges.status).toBe(422);
  expect(await allAges.json()).toMatchObject({ code: "lora_not_allowed" });
});

test("the status route lists both qualities with their own limits, install pieces and the licence", async () => {
  videoGen.useDeps(scripted());
  const response = await app.request("/stack/v1/video");
  const body = await response.json() as { video: { qualities: Record<"quick" | "detailed", { id: string; audio: boolean; installed: boolean; limits: Record<string, number | string>; install: { models: Array<{ id: string }>; download_bytes: number }; licence: { name: string } | null; lora_base_model: string }> } };
  const { quick, detailed } = body.video.qualities;
  expect(quick).toMatchObject({ id: STACK_VIDEO_MODEL.id, audio: false, licence: null, lora_base_model: "wan2.2-ti2v-5b" });
  expect(quick.limits).toMatchObject({ max_seconds: 5, default_size: "832x480" });
  expect(detailed).toMatchObject({ id: STACK_VIDEO_DETAILED_MODEL_ID, audio: true, lora_base_model: "ltx-2.3", licence: { id: "ltx-2.x-community-2026-08-11", name: LTX_LICENCE } });
  expect(detailed.limits).toMatchObject({ max_seconds: 10, default_size: "768x448", size_step: 64, max_frames: 241 });
  expect(detailed.install.models.map((model) => model.id)).toEqual([STACK_VIDEO_DETAILED_MODEL_ID, STACK_VIDEO_TEXT_ENCODER.id]);
  expect(detailed.install.download_bytes).toBe(STACK_VIDEO_DETAILED_MODEL.download!.approx_bytes + STACK_VIDEO_TEXT_ENCODER.download!.approx_bytes);
});

test("the Detailed pins are ungated, pinned by revision and sha256, never bundled, and optional only", () => {
  for (const pin of [STACK_VIDEO_DETAILED_MODEL, STACK_VIDEO_TEXT_ENCODER]) {
    expect(pin.download!.url).toMatch(/^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\//);
    expect(pin.revision).toMatch(/^[0-9a-f]{40}$/);
    for (const file of pin.download!.files!) { expect(file.sha256).toMatch(/^[0-9a-f]{64}$/); expect(file.bytes).toBeGreaterThan(0); }
    expect(pin.download!.approx_bytes).toBe(pin.download!.files!.reduce((sum, file) => sum + file.bytes, 0));
    expect(STACK_MODELS).toContain(pin);
  }
  expect(STACK_VIDEO_DETAILED_MODEL.license).toBe(LTX_LICENCE);
  expect(STACK_VIDEO_TEXT_ENCODER.license).toBe("Gemma Terms of Use");
  expect(STACK_VIDEO_DETAILED_MODEL.download!.files!.map((file) => file.path)).toContain(LTX_UPSCALER_FILE);
  expect(VIDEO_SPECS.detailed.maxSeconds * 24 + 1).toBe(241);
  expect((VIDEO_SPECS.detailed.maxSeconds * 24) % 8).toBe(0);
});

test("the disk plan offers Detailed on a 128 GB computer only, optional (AIMODELS-DATA-01), with its plain size", () => {
  const p128 = diskPlanForTier("p128")!;
  const row = p128.rows.find((candidate) => candidate.id === "video-detailed")!;
  expect(row.need).toBe("optional");
  expect(row.download_bytes).toBeGreaterThan(70_000_000_000);
  expect(row.model_ids).toEqual([STACK_VIDEO_DETAILED_MODEL_ID, STACK_VIDEO_TEXT_ENCODER.id]);
  for (const tier of ["p16", "p32", "p64"] as const) expect(diskPlanForTier(tier)!.rows.some((candidate) => candidate.id === "video-detailed")).toBe(false);
  expect(p128.default_selected).not.toContain("video-detailed");
});

// The real Detailed worker on the real weights, through the job API, only where a prepared environment and the model folders are named
// (LTX_REAL_MODEL_DIR, LTX_REAL_TEXT_DIR, VIDEO_GEN_PYTHON, VIDEO_FFMPEG; the GPU lock must be held by the caller). It proves the whole chain:
// the request, the worker's patches, the stages, the preview, the finished file with a sound track, the messaging copy and the memory peak.
const realModel = process.env.LTX_REAL_MODEL_DIR;
const realText = process.env.LTX_REAL_TEXT_DIR;
test.skipIf(!realModel || !realText || !process.env.VIDEO_GEN_PYTHON || !process.env.VIDEO_FFMPEG)("REAL: a 5 second Detailed clip through the job API comes back as an mp4 with an AAC sound track, with stages and a first-frame preview", async () => {
  videoGen.useDeps({ ...defaultVideoGenDeps, supported: () => true, ensureEnvironment: async () => {}, paths: (quality) => (quality === "detailed" ? { modelDir: realModel!, tokenizerDir: realText!, textEncoderDir: realText! } : null) });
  const submitted = await (await post({ prompt: 'A hero in a dark corridor says: "Come with me if you want to live." Cinematic action scene, low light.', model: "detailed", seed: 7, timeout_ms: 1 })).json() as { job: string };
  const stages = new Set<string>();
  let previewSeen = false;
  const deadline = Date.now() + 600_000;
  let last: { state: string; stage: string | null; preview_url: string | null; data: Array<{ url: string; audio: boolean; quality: string; seconds: number }> } | null = null;
  while (Date.now() < deadline) {
    last = await (await app.request(`/v1/videos/generations/${submitted.job}`)).json() as typeof last;
    if (last!.stage) stages.add(last!.stage);
    if (last!.preview_url) previewSeen = true;
    if (last!.state === "done" || last!.state === "failed") break;
    await Bun.sleep(500);
  }
  expect(last!.state).toBe("done");
  expect(last!.data[0]).toMatchObject({ audio: true, quality: "detailed", seconds: 5 });
  for (const stage of ["plan", "load_model", "motion", "frames"]) expect(stages.has(stage), stage).toBe(true);
  expect(previewSeen).toBe(true);
  const file = Buffer.from(await (await app.request(last!.data[0]!.url)).arrayBuffer());
  const probe = Bun.spawnSync([process.env.VIDEO_FFMPEG!, "-hide_banner", "-i", "/dev/stdin"], { stdin: file, stderr: "pipe" });
  const text = probe.stderr.toString();
  expect(text).toMatch(/Video: h264/);
  expect(text).toMatch(/Audio: aac/);
  expect(text).toMatch(/768x448/);
  writeFileSync(process.env.LTX_REAL_OUT ?? "/tmp/ltx-real.mp4", file);
}, 700_000);
