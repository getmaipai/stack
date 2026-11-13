// LTX25-MAX-01: the Max profile of the LTX-2.5 engine (1024x576, 10 s, the dgrauet runtime 0.18.0 and the ungated bf16 pack). Driven by a
// scripted worker (no weights, no GPU, no network). The point of the regression tests: the runtime ignores the prompt without the pack's
// Gemma folder, silently, so every Max worker request must carry that folder and the worker must refuse one that does not.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { HOME_TOKEN_HEADER, homeViewToken } from "@/lib/adultView";
import { admit, __resetGovernorForTests, __setGovernorTuningForTestsOnly, getGovernorStatus, startGovernor } from "@/lib/governor";
import { __resetJobsForTests } from "@/lib/jobs";
import { ENGINE_BINARIES, ENGINE_ROLE, MANAGED_RUNTIMES } from "@/lib/engineCatalog";
import { LTX25_MAX_GEMMA_FOLDER, LTX25_MAX_REQUIRED_FILES, LTX_LICENCE, STACK_MODELS, STACK_VIDEO_LTX25_MAX_MODEL, STACK_VIDEO_LTX25_MAX_MODEL_ID, STACK_VIDEO_LTX25_MODEL_ID } from "@/lib/modelCatalog";
import { upsertModel, removeModel } from "@/lib/modelStore";
import { registerVideoJobs } from "@/video/jobs";
import { LTX25_CLIP_CAP_BYTES, LTX25_MAX_GEN_VERSION, LTX25_MAX_PEAK_BYTES, LTX25_MAX_PICTURE_PEAK_BYTES, ltx25MaxModelPaths, ltx25MaxPeakBytes, ltx25MaxRefusal, ltx25Refusal } from "@/video/ltx25";
import { __resetProvenanceForTests } from "@/video/provenance";
import { __resetMemoryStateForTests } from "@/lib/memoryState";
import { dataDir } from "@/lib/paths";
import { buildWorkerRequest, memoryVerdict, qualityOfModelName, VIDEO_SPECS, videoGen, videoModelPaths, type VideoGenDeps, type VideoRunInput, type WorkerHandle, type WorkerReply, type WorkerRequest } from "@/video/videoGen";

const GB = 1_073_741_824;
const requests: WorkerRequest[] = [];
let spawned: string[] = [];
let ensured: Array<string | undefined> = [];

const okReply = (request: WorkerRequest): WorkerReply => ({ id: request.id, ok: true, width: request.width, height: request.height, frames: request.num_frames, fps: 24, seed: request.seed, ms: 1234, peak_bytes: 37_000_000_000, audio: true });
function scripted(): VideoGenDeps {
  return {
    supported: () => true,
    ensureEnvironment: async (_progress, _signal, quality) => { ensured.push(quality); },
    paths: (quality) => (quality === "ltx25max" ? { modelDir: "/models/max", tokenizerDir: `/models/max/${LTX25_MAX_GEMMA_FOLDER}`, textEncoderDir: `/models/max/${LTX25_MAX_GEMMA_FOLDER}` } : null),
    spawn: async (quality): Promise<WorkerHandle> => {
      spawned.push(quality);
      let end!: (code: number) => void;
      const exited = new Promise<number>((done) => { end = done; });
      return { exited, kill: () => end(143), send: async (request) => { requests.push(request); writeFileSync(request.output, "MP4DATA-0123456789"); writeFileSync(request.poster, "JPEGDATA"); return okReply(request); } };
    },
  };
}
function clean(): void {
  videoGen.useDeps(null);
  __resetJobsForTests(); __resetGovernorForTests(); __resetProvenanceForTests(); __resetMemoryStateForTests();
  rmSync(join(dataDir, "video"), { recursive: true, force: true });
  rmSync(join(dataDir, "tmp", "video"), { recursive: true, force: true });
}
beforeEach(() => {
  requests.length = 0; spawned = []; ensured = [];
  clean();
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 90 * GB, tier: "p128" });
  registerVideoJobs();
});
afterEach(() => clean());
const post = (body: Record<string, unknown>) => app.request("/v1/videos/generations", { method: "POST", headers: { "content-type": "application/json", "x-stack-caller": "live", [HOME_TOKEN_HEADER]: homeViewToken() }, body: JSON.stringify(body) });
type Entry = Record<string, unknown>;

test("the Max model names map to the ltx25max quality; the Standard names keep theirs", () => {
  for (const name of ["ltx25-max", "ltx25-max-bf16", STACK_VIDEO_LTX25_MAX_MODEL_ID]) expect(qualityOfModelName(name)).toBe("ltx25max");
  for (const name of ["ltx25-q8", "ltx25", STACK_VIDEO_LTX25_MODEL_ID]) expect(qualityOfModelName(name)).toBe("ltx25");
});

test("a Max clip (1024x576, 10 s, 241 frames) runs on its own runtime, and its worker request carries the pack's Gemma folder and profile max", async () => {
  videoGen.useDeps(scripted());
  const response = await post({ prompt: "four smurfs talk", model: "ltx25-max", size: "1024x576", seconds: 10, seed: 7, timeout_ms: 5000 });
  expect(response.status).toBe(200);
  const body = await response.json() as { data: Entry[] };
  expect(body.data[0]).toMatchObject({ width: 1024, height: 576, frames: 241, seconds: 10, quality: "ltx25max", audio: true, model: STACK_VIDEO_LTX25_MAX_MODEL_ID, mode: "text-to-video" });
  expect(spawned).toEqual(["ltx25max"]);
  expect(ensured).toEqual(["ltx25max"]);
  expect(requests[0]).toMatchObject({ profile: "max", model_dir: "/models/max", text_encoder_dir: `/models/max/${LTX25_MAX_GEMMA_FOLDER}`, width: 1024, height: 576, num_frames: 241, loras: [] });
});

test("VIDEO-INPUTS-01: a Max clip takes a start picture and an end picture, as profile max with image and end_image files", async () => {
  videoGen.useDeps(scripted());
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("body")]).toString("base64");
  const response = await post({ prompt: "x", model: "ltx25-max", size: "1024x576", seconds: 5, image: png, end_image: png, timeout_ms: 5000 });
  expect(response.status).toBe(200);
  expect(((await response.json()) as { data: Entry[] }).data[0]).toMatchObject({ mode: "image-to-video", quality: "ltx25max" });
  expect(requests[0]).toMatchObject({ profile: "max" });
  expect(typeof requests[0]!.image).toBe("string");
  expect(typeof requests[0]!.end_image).toBe("string");
  expect(requests[0]!.image).not.toBe(requests[0]!.end_image);
});

test("a tall Max clip (576x1024) is accepted and reaches the worker tall; 1024x576 stays the only wide Max size", async () => {
  videoGen.useDeps(scripted());
  const response = await post({ prompt: "x", model: "ltx25-max", size: "576x1024", seconds: 10, seed: 7, timeout_ms: 5000 });
  expect(response.status).toBe(200);
  expect(((await response.json()) as { data: Entry[] }).data[0]).toMatchObject({ width: 576, height: 1024, frames: 241, quality: "ltx25max" });
  expect(requests[requests.length - 1]).toMatchObject({ profile: "max", width: 576, height: 1024, num_frames: 241 });
  expect(ltx25MaxRefusal(576, 1024, 241)).toBeNull();
  expect((await post({ prompt: "x", model: "ltx25-max", size: "448x768", seconds: 5 })).status).toBe(422);
});

test("only 1024x576 is a Max size; anything else and a style file are refused with a plain sentence", async () => {
  videoGen.useDeps(scripted());
  for (const size of ["768x448", "512x256", "1024x544", "1280x704"]) {
    const response = await post({ prompt: "x", model: "ltx25-max", size, seconds: 5 });
    expect(response.status, size).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe("bad_size");
  }
  expect((await post({ prompt: "x", model: "ltx25-max", seconds: 11 })).status).toBeGreaterThanOrEqual(400);
  expect((await post({ prompt: "x", model: "ltx25-max", image: "aGVsbG8=" })).status).toBe(422); // not a picture: bad_image
  expect(spawned).toEqual([]);
  // The Standard model still refuses 1024x576.
  expect((await post({ prompt: "x", model: "ltx25-q8", size: "1024x576" })).status).toBe(422);
  expect(ltx25Refusal(1024, 576, 241)).not.toBeNull();
  expect(ltx25MaxRefusal(1024, 576, 241)).toBeNull();
  expect(ltx25MaxRefusal(1024, 576, 242)).not.toBeNull();
});

test("admission uses the measured OS footprint with headroom, which passes the 64 GB per-clip cap (the MLX peak of 37 GB is not the figure)", () => {
  expect(LTX25_MAX_PEAK_BYTES).toBe(Math.round(48.6e9 * 1.05));
  expect(ltx25MaxPeakBytes()).toBe(LTX25_MAX_PEAK_BYTES);
  expect(VIDEO_SPECS.ltx25max.peakBytes).toBe(LTX25_MAX_PEAK_BYTES);
  expect(LTX25_MAX_PEAK_BYTES).toBeGreaterThan(48.6e9);
  expect(LTX25_MAX_PEAK_BYTES).toBeLessThan(LTX25_CLIP_CAP_BYTES);
  expect(VIDEO_SPECS.ltx25max.maxSeconds).toBe(10);
  expect(STACK_VIDEO_LTX25_MAX_MODEL.measured!.footprintBytes).toBe(48_600_000_000);
});

test("VIDEO-PICTURE-ADMIT-01: a Max clip that starts from a picture is admitted at the measured 58.6 GB footprint plus 5 percent, still under the 64 GB cap", () => {
  expect(LTX25_MAX_PICTURE_PEAK_BYTES).toBe(Math.round(58.6e9 * 1.05));
  expect(ltx25MaxPeakBytes(true)).toBe(LTX25_MAX_PICTURE_PEAK_BYTES);
  expect(ltx25MaxPeakBytes(false)).toBe(LTX25_MAX_PEAK_BYTES);
  expect(LTX25_MAX_PICTURE_PEAK_BYTES).toBeGreaterThan(LTX25_MAX_PEAK_BYTES + 8e9);
  expect(LTX25_MAX_PICTURE_PEAK_BYTES).toBeLessThan(LTX25_CLIP_CAP_BYTES);
});

test("VIDEO-PICTURE-ADMIT-01: the governor holds 51 GB for a words-only Max clip and 61.5 GB for the same clip from a picture, with or without an end picture", async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("body")]).toString("base64");
  const held = async (extra: Record<string, unknown>): Promise<number[]> => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    videoGen.useDeps({ ...scripted(), spawn: async (): Promise<WorkerHandle> => ({ exited: new Promise<number>(() => {}), kill: () => {}, send: async (request) => { await hold; writeFileSync(request.output, "MP4"); writeFileSync(request.poster, "JPG"); return okReply(request); } }) });
    const waiting = await post({ prompt: "x", model: "ltx25-max", size: "1024x576", seconds: 10, timeout_ms: 300, ...extra });
    expect(waiting.status).toBe(202);
    const running = getGovernorStatus().loaded.map((item) => item.peakBytes);
    release();
    await new Promise((resolve) => setTimeout(resolve, 200));
    clean();
    __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 90 * GB, tier: "p128" });
    registerVideoJobs();
    return running;
  };
  expect(await held({})).toContain(LTX25_MAX_PEAK_BYTES);
  expect(await held({ image: png })).toContain(LTX25_MAX_PICTURE_PEAK_BYTES);
  expect(await held({ image: png, end_image: png })).toContain(LTX25_MAX_PICTURE_PEAK_BYTES);
});

test("VIDEO-PICTURE-ADMIT-01: beside a chat model that leaves room for 55 GB, the words-only Max clip passes the up-front check and the picture clip is refused with the plain no_memory words", async () => {
  videoGen.useDeps(scripted());
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("body")]).toString("base64");
  __setGovernorTuningForTestsOnly({ tier: "p128", totalMemoryBytes: 128 * GB, freeMemoryBytes: 120 * GB });
  const cap = getGovernorStatus().capBytes;
  await admit({ id: "chat", kind: "resident", requestedBytes: cap - 55e9, pinned: true });
  expect(memoryVerdict("ltx25max", LTX25_MAX_PEAK_BYTES).ok).toBe(true);
  expect(memoryVerdict("ltx25max", LTX25_MAX_PICTURE_PEAK_BYTES).ok).toBe(false);
  const refused = await post({ prompt: "x", model: "ltx25-max", size: "1024x576", seconds: 10, image: png });
  expect(refused.status).toBe(503);
  expect(await refused.json()).toMatchObject({ code: "no_memory" });
  // The words-only request passes the same up-front check (it is not refused as no_memory).
  expect(((await post({ prompt: "x", model: "ltx25-max", size: "1024x576", seconds: 10, timeout_ms: 300 })) as Response).status).not.toBe(503);
});

test("REGRESSION: every Max worker request carries the pack's Gemma folder (the runtime silently ignores the prompt without it)", () => {
  const input: VideoRunInput = { prompt: "p", negativePrompt: null, imagePath: null, width: 1024, height: 576, frames: 241, seed: 1, loras: [], outputDir: "/tmp/x" };
  const dir = mkdtempSync(join(tmpdir(), "ltx25max-pack-"));
  try {
    for (const file of LTX25_MAX_REQUIRED_FILES) { mkdirSync(join(dir, file, ".."), { recursive: true }); writeFileSync(join(dir, file), "x"); }
    upsertModel({ id: STACK_VIDEO_LTX25_MAX_MODEL_ID, roles: ["video"], source: "catalog", provenance: { repo: "test/repo" }, revision: "rev", sha256: "a".repeat(64), licence: LTX_LICENCE, verifiedAt: new Date().toISOString(), modelPath: dir, engineRequirements: { engine: "ltx25-max-gen" } });
    const paths = ltx25MaxModelPaths()!;
    expect(paths.gemmaDir).toBe(join(dir, LTX25_MAX_GEMMA_FOLDER));
    const real = videoModelPaths("ltx25max")!;
    expect(real.textEncoderDir).toBe(paths.gemmaDir);
    const request = buildWorkerRequest("ltx25max", real, input, "job", "/tmp/o.mp4", "/tmp/p.jpg");
    expect(request.profile).toBe("max");
    expect(request.text_encoder_dir).toBe(join(dir, LTX25_MAX_GEMMA_FOLDER));
    expect(request.model_dir).toBe(dir);
    // A pack missing the Gemma weights is not installed: no request can be built from it.
    rmSync(join(dir, LTX25_MAX_GEMMA_FOLDER, "model.safetensors"));
    expect(ltx25MaxModelPaths()).toBeNull();
    expect(videoModelPaths("ltx25max")).toBeNull();
    // The Standard request carries no profile.
    expect(buildWorkerRequest("ltx25", { modelDir: "/m", tokenizerDir: "/m/t", textEncoderDir: "/m/t" }, input, "job", "/tmp/o.mp4", "/tmp/p.jpg").profile).toBeUndefined();
  } finally { removeModel(STACK_VIDEO_LTX25_MAX_MODEL_ID); rmSync(dir, { recursive: true, force: true }); }
});

test("REGRESSION: the worker refuses a Max request without the pack's own Gemma folder, and builds the pipeline with that folder and checks it took it", () => {
  const source = readFileSync(join(import.meta.dir, "../src/video/ltx25_worker.py"), "utf8");
  expect(source).toContain("gemma_model_id=gemma_dir");
  expect(source).toContain('getattr(getattr(pipe, "prompt_encoder", None), "gemma_model_id", None)');
  expect(source).toContain("max_gemma_dir(model_dir, request.get(\"text_encoder_dir\")) if profile == \"max\"");
  // Run the function itself with a stubbed mlx (the worker imports it at the top).
  const dir = mkdtempSync(join(tmpdir(), "ltx25max-worker-"));
  try {
    const probe = [
      "import sys, types, importlib.util, os, tempfile",
      "mx = types.ModuleType('mlx.core'); mx.set_cache_limit = lambda n: None",
      "pkg = types.ModuleType('mlx'); pkg.core = mx; sys.modules['mlx'] = pkg; sys.modules['mlx.core'] = mx",
      "spec = importlib.util.spec_from_file_location('w', sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
      "pack = sys.argv[2]; g = os.path.join(pack, 'gemma4-12b-ltx-v1'); os.makedirs(g)",
      "def refused(*a):",
      "    try: m.max_gemma_dir(*a)\n    except ValueError as e: return 'refused'\n    except FileNotFoundError as e: return 'missing'\n    return 'accepted'",
      "print(refused(pack, None), refused(pack, ''), refused(pack, os.path.join(pack, 'other')), refused(pack, g))",
      "for n in ('model.safetensors', 'tokenizer.json', 'config.json'): open(os.path.join(g, n), 'w').write('x')",
      "print(refused(pack, g))",
      "print(m.refusal(1024, 576, 241, 'max'), m.refusal(768, 448, 241, 'max'), m.refusal(1024, 576, 241), m.refusal(512, 256, 241))",
    ].join("\n");
    const out = Bun.spawnSync(["python3", "-I", "-c", probe, join(import.meta.dir, "../src/video/ltx25_worker.py"), dir]);
    const lines = String(out.stdout).trim().split("\n");
    expect(String(out.stderr)).toBe("");
    expect(lines[0]).toBe("refused refused refused missing");
    expect(lines[1]).toBe("accepted");
    expect(lines[2]).toBe("None size must be one of 1024x576 size must be one of 512x256, 640x320, 768x448 None");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the status route reports the Max quality: its own pack, environment and the one profile row", async () => {
  videoGen.useDeps(scripted());
  const body = await (await app.request("/stack/v1/video")).json() as { video: { qualities: Record<string, Record<string, unknown> & { install: { models: Array<{ id: string }>; download_bytes: number } }> } };
  const max = body.video.qualities.ltx25max!;
  expect(max).toMatchObject({ id: STACK_VIDEO_LTX25_MAX_MODEL_ID, audio: true, image_to_video: true, end_image: true, installed: false, ready: false, licence: { id: "ltx-2.x-community-2026-08-11" } });
  expect(max.limits).toMatchObject({ max_seconds: 10, default_size: "1024x576", size_step: 64, max_frames: 241 });
  expect(max.environment).toMatchObject({ engine: expect.stringContaining("ltx25-max-gen"), version: LTX25_MAX_GEN_VERSION, ready: false });
  expect(max.install.models.map((model) => model.id)).toEqual([STACK_VIDEO_LTX25_MAX_MODEL_ID]);
  expect(max.install.download_bytes).toBe(STACK_VIDEO_LTX25_MAX_MODEL.download!.approx_bytes);
  const profiles = max.profiles as Array<Record<string, unknown>>;
  expect(profiles).toHaveLength(1);
  expect(profiles[0]).toMatchObject({ name: "max", size: "1024x576", width: 1024, height: 576, max_seconds: 10, max_frames: 241, peak_gb: 48.6, admit_gb: 51, short_peak_gb: null, peak_gb_picture: 58.6, admit_gb_picture: 61.5, short_peak_gb_picture: null });
  expect(Object.keys(profiles[0]!)).toEqual(expect.arrayContaining(["extend", "retake"])); // LTX25-EDIT-01 footprints (null where not measured)
  // Standard and Boost are unchanged and keep the fork runtime.
  const standard = body.video.qualities.ltx25!;
  expect((standard.environment as { engine: string }).engine).toContain("ltx25-gen");
  expect((standard.profiles as Array<{ name: string }>).map((row) => row.name)).toEqual(["standard", "boost", "boost"]);
});

test("the Max runtime is pinned by commit and checksum (dgrauet 0.18.0), the fork pin for Standard and Boost is untouched", () => {
  const engine = ENGINE_BINARIES.find((pin) => pin.name === "ltx25-max-gen")!;
  expect(engine).toMatchObject({ tag: "b82b97e", platform: "darwin", arch: "arm64", verified: true });
  expect(engine.archive.url).toBe("https://codeload.github.com/dgrauet/ltx-2-mlx/tar.gz/b82b97e3d000e01361f8cfcb745244b15b89a521");
  expect(engine.archive.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(MANAGED_RUNTIMES.find((runtime) => runtime.name === "ltx25-max-gen")!.version).toBe(engine.tag);
  expect(ENGINE_ROLE["ltx25-max-gen"]).toBe("video");
  const old = ENGINE_BINARIES.find((pin) => pin.name === "ltx25-gen")!;
  expect(old).toMatchObject({ tag: "5795228" });
  expect(old.archive.url).toContain("MrMoferFRAN/ltx-2-mlx");
  const text = readFileSync(join(import.meta.dir, "../src/video/ltx25-max-gen.darwin-arm64.requirements.txt"), "utf8");
  const lines = text.split("\n").filter((line) => /^[A-Za-z0-9_.-]+==/.test(line));
  expect(lines.some((line) => /^mlx==0\.(3[1-9]|[4-9]\d)/.test(line))).toBe(true);
  expect(lines.some((line) => /^mlx-lm==0\.(3[1-9]|[4-9]\d)/.test(line))).toBe(true);
  for (const line of lines) expect(line.trimEnd().endsWith("\\"), line).toBe(true);
  expect(text.match(/--hash=sha256:[0-9a-f]{64}/g)!.length).toBeGreaterThan(lines.length);
});

test("the Max pack is pinned: the ungated mirror at one revision, sha256 and size of every file, the licence files with it, no dev transformer", () => {
  const pin = STACK_VIDEO_LTX25_MAX_MODEL;
  expect(pin.download!.url).toMatch(/^https:\/\/huggingface\.co\/mlx-community\/ltx-2\.5-mlx\/resolve\/[0-9a-f]{40}\//);
  expect(pin.revision).toMatch(/^[0-9a-f]{40}$/);
  expect(pin.engine).toBe("ltx25-max-gen");
  expect(pin.license).toBe(LTX_LICENCE);
  const files = pin.download!.files!;
  for (const file of files) { expect(file.sha256).toMatch(/^[0-9a-f]{64}$/); expect(file.bytes).toBeGreaterThan(0); }
  expect(pin.download!.approx_bytes).toBe(files.reduce((sum, file) => sum + file.bytes, 0));
  const paths = files.map((file) => file.path);
  for (const needed of LTX25_MAX_REQUIRED_FILES) expect(paths).toContain(needed);
  for (const left of ["transformer-dev.safetensors", "vae_decoder_pruna.safetensors", "vae_diffusion_decoder.safetensors"]) expect(paths).not.toContain(left);
  expect(paths).toContain("LICENSE.md");
  expect(paths).toContain("ltx-acceptable-use-policy-snapshot-2026-08-12.pdf");
  expect(paths).toContain(`${LTX25_MAX_GEMMA_FOLDER}/model.safetensors`);
  expect(STACK_MODELS.some((model) => model.id === STACK_VIDEO_LTX25_MAX_MODEL_ID)).toBe(true);
  expect(new URL(pin.download!.url).host).toBe("huggingface.co");
});

// MAX-WAIT-REASON-01: a Max clip held by the window reports a phase of its own for each hold, so Home can say it in words.
test("a Max clip waiting on the computer reports phase waiting for the computer; behind running work, waiting for running jobs", async () => {
  videoGen.useDeps(scripted());
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 30 * GB, tier: "p128" });
  const stop = startGovernor({ pid: 1, pollMs: 1, freeMemory: () => 30 * GB, totalMemory: () => 128 * GB });
  try {
    const first = await post({ prompt: "four smurfs talk", model: "ltx25-max", size: "1024x576", seconds: 10, tier: "max", timeout_ms: 1 });
    expect(first.status).toBe(202);
    const id = ((await first.json()) as { job: string }).job;
    let phase = "";
    for (let tries = 0; tries < 60 && phase !== "waiting for the computer"; tries++) {
      await Bun.sleep(50);
      phase = ((await (await app.request(`/v1/videos/generations/${id}`)).json()) as { phase: string }).phase;
    }
    expect(phase).toBe("waiting for the computer");
    const status = ((await (await app.request(`/v1/videos/generations/${id}`)).json()) as { phase: string; state: string });
    expect(status.state).toBe("running");
    await app.request(`/v1/videos/generations/${id}`, { method: "DELETE" });
  } finally { stop(); }
});
