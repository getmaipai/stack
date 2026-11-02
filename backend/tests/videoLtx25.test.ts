// LTX25-ENGINE-01: the LTX-2.5 video engine (distilled q8 with sound) beside Quick and Detailed: the router, the measured table
// (sizes and lengths outside it are refused), admission from the measured footprints, the pins, the status route, the privacy
// posture, driven by a scripted worker (no weights, no GPU, no network). The real worker on the real weights is exercised only where
// LTX25_GEN_PYTHON names a prepared environment (the checks that need no weights) and LTX25_REAL_MODEL names the pack.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, admit, getGovernorStatus } from "@/lib/governor";
import { __resetJobsForTests } from "@/lib/jobs";
import { ENGINE_BINARIES, MANAGED_RUNTIMES, ENGINE_ROLE } from "@/lib/engineCatalog";
import { LTX_LICENCE, LTX25_REQUIRED_FILES, STACK_MODELS, STACK_VIDEO_LTX25_MODEL, STACK_VIDEO_LTX25_MODEL_ID } from "@/lib/modelCatalog";
import { PRIVACY_ROWS } from "@/lib/privacy";
import { TIER_CANDIDATES } from "@/lib/tiers";
import { registerVideoJobs } from "@/video/jobs";
import { LTX25_MEASURED, LTX25_PEAK_BYTES, ltx25PeakBytes, ltx25Refusal, ltx25TrueSize, ltx25WorkerEnv, LTX25_GEN_VERSION } from "@/video/ltx25";
import { __resetProvenanceForTests } from "@/video/provenance";
import { memoryVerdict, qualityOfModelName, VIDEO_SPECS, videoGen, workerHandle, type VideoGenDeps, type WorkerHandle, type WorkerReply, type WorkerRequest } from "@/video/videoGen";
import { dataDir } from "@/lib/paths";
import { __resetMemoryStateForTests } from "@/lib/memoryState";
import { diskPlanForTier } from "@/lib/diskPlan";
import { componentDefs } from "@/lib/components";

const GB = 1_073_741_824;
const requests: WorkerRequest[] = [];
let killed = 0;
let spawnedQualities: string[] = [];
let ensured: Array<string | undefined> = [];
let installed: Record<string, boolean> = {};

const okReply = (request: WorkerRequest): WorkerReply => ({ id: request.id, ok: true, width: request.width, height: request.height, frames: request.num_frames, fps: 24, seed: request.seed, ms: 4321, peak_bytes: 25_000_000_000, audio: true });

function scripted(reply: (request: WorkerRequest) => WorkerReply = okReply): VideoGenDeps {
  return {
    supported: () => true,
    ensureEnvironment: async (_progress, _signal, quality) => { ensured.push(quality); },
    paths: (quality) => (installed[quality] ? (quality === "ltx25" ? { modelDir: "/models/ltx25", tokenizerDir: "/models/ltx25/text_encoder", textEncoderDir: "/models/ltx25/text_encoder" } : quality === "detailed" ? { modelDir: "/models/ltx", tokenizerDir: "/models/gemma", textEncoderDir: "/models/gemma" } : { modelDir: "/models/video", tokenizerDir: "/models/tok" }) : null),
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
          return reply(request);
        },
      };
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
  requests.length = 0; killed = 0; spawnedQualities = []; ensured = []; installed = { quick: true, detailed: true, ltx25: true };
  clean();
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 90 * GB, tier: "p128" });
  registerVideoJobs();
});
afterEach(() => clean());

const post = (body: Record<string, unknown>) => app.request("/v1/videos/generations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
type Entry = Record<string, unknown>;

test("the model names map to the LTX-2.5 quality, and Quick and Detailed keep theirs", () => {
  for (const name of ["ltx25-q8", "ltx25", STACK_VIDEO_LTX25_MODEL_ID]) expect(qualityOfModelName(name)).toBe("ltx25");
  expect(qualityOfModelName(undefined)).toBe("quick");
  expect(qualityOfModelName("wan2.2-ti2v-5b-fastwan-mlx")).toBe("quick");
  expect(qualityOfModelName("detailed")).toBe("detailed");
  expect(qualityOfModelName("ltx-3")).toBeNull();
});

test("the Standard clip (512x256, 10 s, 241 frames) runs on the LTX-2.5 worker, comes back with sound, and reports its engine and model", async () => {
  videoGen.useDeps(scripted());
  const response = await post({ prompt: "two cartoon bears say hello", model: "ltx25-q8", seconds: 10, seed: 7, timeout_ms: 5000 });
  expect(response.status).toBe(200);
  const body = await response.json() as { data: Entry[] };
  expect(body.data[0]).toMatchObject({ width: 512, height: 256, frames: 241, seconds: 10, quality: "ltx25", audio: true, model: STACK_VIDEO_LTX25_MODEL_ID, mode: "text-to-video" });
  expect(spawnedQualities).toEqual(["ltx25"]);
  expect(ensured).toEqual(["ltx25"]);
  expect(requests[0]).toMatchObject({ model_dir: "/models/ltx25", num_frames: 241, width: 512, height: 256, loras: [] });
  expect((requests[0]!.num_frames - 1) % 8).toBe(0);
});

test("a second clip reuses the same worker, and another model's worker leaves before the next one starts", async () => {
  videoGen.useDeps(scripted());
  expect((await post({ prompt: "a", model: "ltx25-q8", seconds: 5, timeout_ms: 5000 })).status).toBe(200);
  expect((await post({ prompt: "b", model: "ltx25-q8", seconds: 5, timeout_ms: 5000 })).status).toBe(200);
  expect(spawnedQualities).toEqual(["ltx25"]);
  expect((await post({ prompt: "c", timeout_ms: 5000 })).status).toBe(200);
  expect(spawnedQualities).toEqual(["ltx25", "quick"]);
  expect(killed).toBe(1);
});

test("the default is 512x256 for 5 seconds, and Boost sizes 640x320 and 768x448 run at 5 seconds", async () => {
  videoGen.useDeps(scripted());
  const plain = await post({ prompt: "x", model: "ltx25-q8", timeout_ms: 5000 });
  expect(((await plain.json()) as { data: Entry[] }).data[0]).toMatchObject({ width: 512, height: 256, frames: 121 });
  for (const size of ["640x320", "768x448"]) {
    const response = await post({ prompt: "x", model: "ltx25-q8", size, seconds: 5, timeout_ms: 5000 });
    expect(response.status).toBe(200);
  }
  expect(requests.map((request) => `${request.width}x${request.height}:${request.num_frames}`)).toEqual(["512x256:121", "640x320:121", "768x448:121"]);
});

test("the nominal sizes 512x288 and 640x352 are accepted, made at the true size, and reported at it; the one mapping rounds each side down to a multiple of 64", async () => {
  expect(ltx25TrueSize(512, 288)).toEqual({ width: 512, height: 256 });
  expect(ltx25TrueSize(640, 352)).toEqual({ width: 640, height: 320 });
  expect(ltx25TrueSize(768, 448)).toEqual({ width: 768, height: 448 });
  expect(ltx25TrueSize(1024, 576)).toEqual({ width: 1024, height: 576 });
  videoGen.useDeps(scripted());
  for (const [size, w, h] of [["512x288", 512, 256], ["640x352", 640, 320], ["544x288", 512, 256]] as const) {
    const response = await post({ prompt: "x", model: "ltx25-q8", size, seconds: 5, timeout_ms: 5000 });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: Entry[] }).data[0]).toMatchObject({ width: w, height: h });
  }
  expect(requests.map((request) => `${request.width}x${request.height}`)).toEqual(["512x256", "640x320", "512x256"]);
  // A size that rounds to something outside the table is refused, 1024x576 included.
  for (const size of ["1024x576", "512x320", "480x288"]) expect((await post({ prompt: "x", model: "ltx25-q8", size })).status).toBe(422);
});

test("a size or a length outside the measured table is refused with a plain sentence, and nothing starts", async () => {
  videoGen.useDeps(scripted());
  for (const size of ["1024x576", "832x480", "512x320", "288x512"]) {
    const response = await post({ prompt: "x", model: "ltx25-q8", size });
    expect(response.status).toBe(422);
    const body = await response.json() as { code: string; error: string };
    expect(body.code).toBe("bad_size");
    expect(body.error).toContain("512x256");
  }
  for (const size of ["640x320", "768x448"]) {
    const response = await post({ prompt: "x", model: "ltx25-q8", size, seconds: 10 });
    expect(response.status).toBe(422);
    const body = await response.json() as { code: string; error: string };
    expect(body.code).toBe("bad_seconds");
    expect(body.error).toContain("at most 5 seconds");
  }
  expect((await post({ prompt: "x", model: "ltx25-q8", seconds: 11 })).status).toBe(400);
  expect(spawnedQualities).toEqual([]);
  expect(requests).toEqual([]);
});

test("frames must be 8n+1: the table check refuses anything else, and every whole second is allowed", () => {
  expect(ltx25Refusal(512, 288, 241)).toBeNull();
  expect(ltx25Refusal(512, 288, 121)).toBeNull();
  expect(ltx25Refusal(512, 288, 9)).toBeNull();
  expect(ltx25Refusal(512, 288, 120)).toContain("one more than a multiple of 8");
  expect(ltx25Refusal(512, 288, 8)).toContain("one more than a multiple of 8");
  expect(ltx25Refusal(512, 288, 249)).toContain("at most 10 seconds");
  expect(ltx25Refusal(768, 448, 129)).toContain("at most 5 seconds");
  expect(ltx25Refusal(1024, 576, 121)).toContain("512x256, 640x320, 768x448");
  for (let seconds = 1; seconds <= 10; seconds++) expect((seconds * 24) % 8).toBe(0);
});

// A real 1x1 PNG header is enough for the route (it checks the magic bytes); the worker is scripted here.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake-png-body")]);
const PNG_B64 = PNG.toString("base64");
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString("base64");

test("VIDEO-INPUTS-01: a start picture reaches the worker as a file with the same bytes, and the end picture beside it", async () => {
  const seen: Array<{ image: string | null; endImage: string | null; bytes: Buffer | null; endBytes: Buffer | null }> = [];
  videoGen.useDeps(scripted((request) => {
    seen.push({ image: request.image, endImage: request.end_image ?? null, bytes: request.image ? readFileSync(request.image) : null, endBytes: request.end_image ? readFileSync(request.end_image) : null });
    return okReply(request);
  }));
  const start = await post({ prompt: "x", model: "ltx25-q8", image: PNG_B64, timeout_ms: 20_000 });
  expect(start.status).toBe(200);
  expect(((await start.json()) as { data: Array<{ mode: string; quality: string }> }).data[0]).toMatchObject({ mode: "image-to-video", quality: "ltx25" });
  const both = await post({ prompt: "x", model: "ltx25-q8", image: `data:image/png;base64,${PNG_B64}`, end_image: JPEG_B64, timeout_ms: 20_000 });
  expect(both.status).toBe(200);
  expect(seen[0]!.bytes!.equals(PNG)).toBe(true);
  expect(seen[0]!.endImage).toBeNull();
  expect(seen[1]!.bytes!.equals(PNG)).toBe(true);
  expect(seen[1]!.endBytes!.equals(Buffer.from(JPEG_B64, "base64"))).toBe(true);
  // A request without pictures carries none (the field is absent, not null).
  await post({ prompt: "x", model: "ltx25-q8", timeout_ms: 20_000 });
  expect(requests.at(-1)!.image).toBeNull();
  expect("end_image" in requests.at(-1)!).toBe(false);
});

test("VIDEO-INPUTS-01: bad picture bytes, a wrong size, a last picture without a first, and a style file are refused with what to do", async () => {
  videoGen.useDeps(scripted());
  const code = async (response: Response) => ((await response.json()) as { code: string }).code;
  const notBase64 = await post({ prompt: "x", model: "ltx25-q8", image: "%%%not base64%%%" });
  expect([notBase64.status, await code(notBase64)]).toEqual([422, "bad_image"]);
  const notAPicture = await post({ prompt: "x", model: "ltx25-q8", image: Buffer.from("this is text, not a picture").toString("base64") });
  expect([notAPicture.status, await code(notAPicture)]).toEqual([422, "bad_image"]);
  const badEnd = await post({ prompt: "x", model: "ltx25-q8", image: PNG_B64, end_image: Buffer.from("this is text, not a picture").toString("base64") });
  expect([badEnd.status, await code(badEnd)]).toEqual([422, "bad_image"]);
  expect(((await (await post({ prompt: "x", model: "ltx25-q8", image: PNG_B64, end_image: "%%%" })).json()) as { error: string }).error).toContain("last picture");
  const endOnly = await post({ prompt: "x", model: "ltx25-q8", end_image: PNG_B64 });
  expect([endOnly.status, await code(endOnly)]).toEqual([422, "bad_image"]);
  const wrongSize = await post({ prompt: "x", model: "ltx25-q8", image: PNG_B64, size: "1024x576" });
  expect([wrongSize.status, await code(wrongSize)]).toEqual([422, "bad_size"]);
  const tooLong = await post({ prompt: "x", model: "ltx25-q8", image: PNG_B64, size: "768x448", seconds: 10 });
  expect([tooLong.status, await code(tooLong)]).toEqual([422, "bad_seconds"]);
  const style = await post({ prompt: "x", model: "ltx25-q8", image: PNG_B64, loras: [{ id: "lora-0123456789abcdef" }] });
  expect([style.status, await code(style)]).toEqual([422, "lora_unsupported"]);
  const big = await post({ prompt: "x", model: "ltx25-q8", image: Buffer.concat([PNG, Buffer.alloc(21 * 1024 * 1024)]).toString("base64") });
  expect(big.status).toBe(413);
  expect(requests).toEqual([]);
});

test("VIDEO-INPUTS-01: Quick and Detailed take no last picture (reference_unsupported); Detailed and Quick still start from one", async () => {
  videoGen.useDeps(scripted());
  for (const model of ["quick", "detailed"]) {
    const response = await post({ prompt: "x", model, image: PNG_B64, end_image: PNG_B64 });
    expect([response.status, ((await response.json()) as { code: string }).code]).toEqual([422, "reference_unsupported"]);
  }
  expect(VIDEO_SPECS.quick.endImage).toBe(false);
  expect(VIDEO_SPECS.detailed.endImage).toBe(false);
  expect(VIDEO_SPECS.detailed.imageToVideo && VIDEO_SPECS.quick.imageToVideo).toBe(true);
  expect(VIDEO_SPECS.ltx25).toMatchObject({ imageToVideo: true, endImage: true });
  expect(VIDEO_SPECS.ltx25max).toMatchObject({ imageToVideo: true, endImage: true });
});

test("not installed answers 503 not_installed, and Quick still works", async () => {
  installed.ltx25 = false;
  videoGen.useDeps(scripted());
  const response = await post({ prompt: "x", model: "ltx25-q8" });
  expect(response.status).toBe(503);
  const body = await response.json() as { code: string; error: string };
  expect(body.code).toBe("not_installed");
  expect(body.error).toContain("LTX-2.5");
  expect((await post({ prompt: "x", timeout_ms: 5000 })).status).toBe(200);
});

test("admission uses the measured footprints: Standard 10 s 39.4 GB, 5 s 25.3 GB, 640x320 32.4 GB, Boost 768x448 45.8 GB", async () => {
  expect(ltx25PeakBytes(512, 288, 241)).toBe(39.4e9);
  expect(ltx25PeakBytes(512, 288, 121)).toBe(25.3e9);
  expect(ltx25PeakBytes(512, 288, 49)).toBe(25.3e9);
  expect(ltx25PeakBytes(640, 352, 121)).toBe(32.4e9);
  expect(ltx25PeakBytes(768, 448, 121)).toBe(45.8e9);
  expect(LTX25_PEAK_BYTES).toBe(45.8e9);
  expect(VIDEO_SPECS.ltx25.peakBytes).toBe(45.8e9);
  expect(LTX25_MEASURED.map((row) => row.size)).toEqual(["512x256", "640x320", "768x448"]);
  // The job's governor admission is the clip's own measured figure.
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  videoGen.useDeps({ ...scripted(), spawn: async (): Promise<WorkerHandle> => ({ exited: new Promise<number>(() => {}), kill: () => {}, send: async (request) => { await hold; writeFileSync(request.output, "MP4"); writeFileSync(request.poster, "JPG"); return okReply(request); } }) });
  const waiting = post({ prompt: "x", model: "ltx25-q8", seconds: 10, timeout_ms: 300 });
  expect((await waiting).status).toBe(202);
  const running = getGovernorStatus().loaded.map((item) => item.peakBytes);
  expect(running).toContain(39.4e9);
  release();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const small = post({ prompt: "x", model: "ltx25-q8", size: "768x448", seconds: 5, timeout_ms: 300 });
  expect((await small).status).toBe(200);
});

test("memory: beside 28 GB of chat a clip is judged by its own measured footprint, and one that cannot fit is refused with the same plain words", async () => {
  videoGen.useDeps(scripted());
  __setGovernorTuningForTestsOnly({ tier: "p128", totalMemoryBytes: 72 * GB, freeMemoryBytes: 70 * GB });
  await admit({ id: "chat", kind: "resident", requestedBytes: 28 * GB, pinned: true });
  const cap = getGovernorStatus().capBytes;
  expect(cap).toBeGreaterThan(28 * GB + 25.3e9);
  expect(cap).toBeLessThan(28 * GB + 45.8e9);
  expect(memoryVerdict("ltx25", 25.3e9).ok).toBe(true);
  expect(memoryVerdict("ltx25", 45.8e9).ok).toBe(false);
  const refused = await post({ prompt: "x", model: "ltx25-q8", size: "768x448", seconds: 5 });
  expect(refused.status).toBe(503);
  expect(await refused.json()).toMatchObject({ code: "no_memory" });
  const allowed = await post({ prompt: "x", model: "ltx25-q8", size: "512x256", seconds: 5, timeout_ms: 5000 });
  expect(allowed.status).toBe(200);
});

test("a failed run returns the worker's plain error and the next clip starts a fresh worker after a timeout", async () => {
  videoGen.useDeps(scripted((request) => ({ id: request.id, ok: false, code: "timeout", error: "The clip took too long and was stopped. Try a shorter clip." })));
  const response = await post({ prompt: "x", model: "ltx25-q8", timeout_ms: 5000 });
  expect(response.status).toBe(504);
  expect(killed).toBe(1);
});

test("the status route reports the LTX-2.5 engine: ready, its environment, the measured profiles, and the pack's pieces", async () => {
  videoGen.useDeps(scripted());
  const body = await (await app.request("/stack/v1/video")).json() as { video: { qualities: Record<string, { id: string; installed: boolean; audio: boolean; image_to_video: boolean; end_image: boolean; ready?: boolean; environment?: { engine: string; version: string; ready: boolean }; limits: Record<string, number | string>; install: { models: Array<{ id: string; approx_bytes: number }>; download_bytes: number }; licence: { id: string; name: string } | null; lora_base_model: string; profiles?: Array<Record<string, unknown>> }> } };
  const { quick, detailed, ltx25 } = body.video.qualities;
  expect(Object.keys(body.video.qualities)).toEqual(["quick", "detailed", "ltx25", "ltx25max"]);
  expect(quick!.id).not.toBe(ltx25!.id);
  expect(detailed!.audio).toBe(true);
  expect(ltx25).toMatchObject({ id: STACK_VIDEO_LTX25_MODEL_ID, audio: true, image_to_video: true, end_image: true, installed: false, ready: false, licence: { id: "ltx-2.x-community-2026-08-11", name: LTX_LICENCE } });
  expect(ltx25!.limits).toMatchObject({ max_seconds: 10, default_size: "512x256", size_step: 32, max_frames: 241 });
  expect(ltx25!.environment).toMatchObject({ engine: expect.stringContaining("ltx25-gen"), version: LTX25_GEN_VERSION, ready: false });
  expect(ltx25!.install.models.map((model) => model.id)).toEqual([STACK_VIDEO_LTX25_MODEL_ID]);
  expect(ltx25!.install.download_bytes).toBe(STACK_VIDEO_LTX25_MODEL.download!.approx_bytes);
  expect(ltx25!.profiles).toEqual([
    { name: "standard", size: "512x256", width: 512, height: 256, max_seconds: 10, max_frames: 241, peak_gb: 39.4, short_peak_gb: 25.3 },
    { name: "boost", size: "640x320", width: 640, height: 320, max_seconds: 5, max_frames: 121, peak_gb: 32.4, short_peak_gb: null },
    { name: "boost", size: "768x448", width: 768, height: 448, max_seconds: 5, max_frames: 121, peak_gb: 45.8, short_peak_gb: null },
  ]);
});

test("the LTX-2.5 pack is pinned: ungated repo, one revision, sha256 and size of every file, no dev transformer, never bundled", () => {
  const pin = STACK_VIDEO_LTX25_MODEL;
  expect(pin.download!.url).toMatch(/^https:\/\/huggingface\.co\/MrMofer\/ltx-2\.5-mlx-q8\/resolve\/[0-9a-f]{40}\//);
  expect(pin.revision).toMatch(/^[0-9a-f]{40}$/);
  expect(pin.engine).toBe("ltx25-gen");
  expect(pin.license).toBe(LTX_LICENCE);
  const files = pin.download!.files!;
  for (const file of files) { expect(file.sha256).toMatch(/^[0-9a-f]{64}$/); expect(file.bytes).toBeGreaterThan(0); }
  expect(pin.download!.approx_bytes).toBe(files.reduce((sum, file) => sum + file.bytes, 0));
  const paths = files.map((file) => file.path);
  for (const needed of LTX25_REQUIRED_FILES) expect(paths).toContain(needed);
  expect(paths).not.toContain("transformer-dev.safetensors");
  expect(paths.some((path) => path.includes("distilled-lora"))).toBe(false);
  expect(paths).toContain("LICENSE.md");
  expect(STACK_MODELS.some((model) => model.id === STACK_VIDEO_LTX25_MODEL_ID)).toBe(true);
  // The primary url is a top-level file of the pack; nothing is bundled with the Stack.
  expect(pin.download!.url.endsWith(`/${files.find((file) => file.sha256 === pin.download!.sha256)!.path}`)).toBe(true);
});

test("the runtime is pinned by commit and checksum, has its own managed environment, and is a video engine", () => {
  const engine = ENGINE_BINARIES.find((pin) => pin.name === "ltx25-gen")!;
  expect(engine).toMatchObject({ tag: "5795228", platform: "darwin", arch: "arm64", verified: true });
  expect(engine.archive.url).toBe("https://codeload.github.com/MrMoferFRAN/ltx-2-mlx/tar.gz/57952288076766abe27dda3a774b2c24f7346977");
  expect(engine.archive.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(MANAGED_RUNTIMES.find((runtime) => runtime.name === "ltx25-gen")!.version).toBe(engine.tag);
  expect(ENGINE_ROLE["ltx25-gen"]).toBe("video");
  const text = require("node:fs").readFileSync(join(import.meta.dir, "../src/video/ltx25-gen.darwin-arm64.requirements.txt"), "utf8") as string;
  const lines = text.split("\n").filter((line) => /^[A-Za-z0-9_.-]+==/.test(line));
  expect(lines.some((line) => line.startsWith("mlx==0.32.0"))).toBe(true);
  // Every requirement carries hashes (uv pip sync --require-hashes).
  for (const line of lines) expect(line.trimEnd().endsWith("\\"), line).toBe(true);
  expect(text.match(/--hash=sha256:[0-9a-f]{64}/g)!.length).toBeGreaterThan(lines.length);
});

test("the component and the disk plan offer it on a 128 GB computer only, optional, with the licence notice (LICENCE-ACK-01)", () => {
  const unit = componentDefs().find((item) => item.id === STACK_VIDEO_LTX25_MODEL_ID)!;
  expect(unit.licenceNotice?.id).toBe("ltx-2.x-community-2026-08-11");
  expect(unit.envs.map((env) => env.name)).toEqual(["ltx25-gen"]);
  expect(unit.tiers).toEqual(["p128"]);
  const p128 = diskPlanForTier("p128")!;
  const row = p128.rows.find((candidate) => candidate.id === "video-ltx25")!;
  expect(row.need).toBe("optional");
  expect(row.model_ids).toEqual([STACK_VIDEO_LTX25_MODEL_ID]);
  for (const tier of ["p16", "p32", "p64"] as const) expect(diskPlanForTier(tier)!.rows.some((candidate) => candidate.id === "video-ltx25")).toBe(false);
});

test("the tier table lists the measured rows and keeps them off every tier until Home's slot step (Wan and LTX-2.3 rows stay)", () => {
  const candidate = TIER_CANDIDATES.find((item) => item.id === STACK_VIDEO_LTX25_MODEL_ID)!;
  expect(candidate.tiers).toEqual([]);
  expect(candidate.vetting).toContain("VIDEO-TIERS-01");
  expect(candidate.peaks.map((peak) => peak.peakBytes)).toEqual([25_300_000_000, 39_400_000_000, 32_400_000_000, 45_800_000_000]);
  expect(candidate.peaks.every((peak) => peak.status === "measured")).toBe(true);
  expect(TIER_CANDIDATES.filter((item) => item.category === "video" && item.tiers.length > 0).map((item) => item.id)).toEqual(["fastwan2-2-ti2v-5b-mlx-bf16", "ltx-2-3-distilled-mlx"]);
});

// ---- privacy: generation makes no outbound connection ----

test("PRIVACY: the worker is started offline with no token and no Stack secret, and its source refuses any network connection before it serves", async () => {
  process.env.HF_TOKEN = "hf_test_not_real"; process.env.STACK_SECRETS_KEY = "secret-not-real";
  try {
    const env = ltx25WorkerEnv("/engines/ltx25-gen/x");
    expect(env.HF_HUB_OFFLINE).toBe("1");
    expect(env.TRANSFORMERS_OFFLINE).toBe("1");
    expect(env.HF_TOKEN).toBeUndefined();
    expect(env.HUGGING_FACE_HUB_TOKEN).toBeUndefined();
    expect(env.STACK_SECRETS_KEY).toBeUndefined();
    expect(env.PYTHONPATH).toBe("/engines/ltx25-gen/x/packages/ltx-core-mlx/src:/engines/ltx25-gen/x/packages/ltx-pipelines-mlx/src");
  } finally { delete process.env.HF_TOKEN; delete process.env.STACK_SECRETS_KEY; }
  const source = await Bun.file(join(import.meta.dir, "../src/video/ltx25_worker.py")).text();
  expect(source).toContain('os.environ.setdefault("HF_HUB_OFFLINE", "1")');
  expect(source.indexOf("forbid_network()\n    emit({\"ready\": True})")).toBeGreaterThan(0);
  expect(source).toContain("mx.set_cache_limit(");
  expect(source).toContain("mx.clear_cache()");
  expect(source).toContain("DistilledPipeline(model_dir=model_dir, low_memory=True)");
  expect(source).not.toMatch(/https?:\/\//);
  expect(source).not.toMatch(/snapshot_download|hf_hub_download|from_pretrained\("/);
});

test("PRIVACY: the only new host is the pinned source archive's, declared with the other environment builds", () => {
  const row = PRIVACY_ROWS.find((item) => item.id === "tts-environment")!;
  expect(row.hosts).toContain("codeload.github.com");
  expect(row.carries).toContain("LTX-2.5");
  // The pack comes from the host the other models use.
  expect(new URL(STACK_VIDEO_LTX25_MODEL.download!.url).host).toBe("huggingface.co");
});

// ---- VIDEO-INPUTS-01: the worker's picture path, run with a stubbed mlx and stubbed runtime packages (no weights, no GPU) ----

const STACK_FFMPEG = process.env.LTX25_FFMPEG ?? "/usr/local/maipai-home/stack/data/engines/ffmpeg/v8.1.3-1/ffmpeg";
function workerProbe(body: string[]): { out: string; err: string } {
  const lines = [
    "import sys, types, importlib.util, os, json, subprocess",
    "mx = types.ModuleType('mlx.core'); mx.set_cache_limit = lambda n: None; mx.reset_peak_memory = lambda: None; mx.clear_cache = lambda: None; mx.get_peak_memory = lambda: 123",
    "pkg = types.ModuleType('mlx'); pkg.core = mx; sys.modules['mlx'] = pkg; sys.modules['mlx.core'] = mx",
    "spec = importlib.util.spec_from_file_location('w', sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
    "ff = sys.argv[2]; tmp = sys.argv[3]",
    ...body,
  ];
  const dir = mkdtempSync(join(tmpdir(), "ltx25pic-"));
  try {
    const run = Bun.spawnSync(["python3", "-I", "-c", lines.join("\n"), worker, STACK_FFMPEG, dir]);
    // The worker's own progress events are JSON lines on stdout; the probe's prints are the other lines.
    return { out: String(run.stdout).split("\n").filter((line) => line && !line.startsWith('{"id"')).join("\n"), err: String(run.stderr) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const ffmpegPresent = existsSync(STACK_FFMPEG);

test("VIDEO-INPUTS-01 REGRESSION: the worker passes the pictures to the runtime and a runtime that cannot take them is refused, never silently run from words", () => {
  const source = readFileSync(worker, "utf8");
  expect(source).toContain('extra["images"] = conditioning_images(start, end, frames)');
  expect(source).toContain("**extra");
  expect(source).not.toContain("starts from words, not from a picture");
  const { out, err } = workerProbe([
    "class Takes:\n    def generate_and_save(self, prompt, output_path, images=None, **k): pass",
    "class Drops:\n    def generate_and_save(self, prompt, output_path, **k): pass",
    "m.require_images_support(Takes())",
    "try: m.require_images_support(Drops()); print('accepted')\nexcept ValueError as e: print('refused:', e)",
  ]);
  expect(err).toBe("");
  expect(out).toBe("refused: this video runtime cannot start from a picture");
});

test("VIDEO-INPUTS-01: conditioning_images builds frame 0 (replace) and the last frame (guide) for the 0.18.0 runtime and for the fork", () => {
  const { out, err } = workerProbe([
    // 0.18.0 shape: ltx_pipelines_mlx.utils.types.ImageConditioningInput with .at and .guide
    "root = types.ModuleType('ltx_pipelines_mlx'); utils = types.ModuleType('ltx_pipelines_mlx.utils')",
    "ty = types.ModuleType('ltx_pipelines_mlx.utils.types')",
    "class New:\n    def __init__(self, path, idx, strength, how): self.t = (how, path, idx, strength)\n    @classmethod\n    def at(cls, path, idx, s): return cls(path, idx, s, 'replace' if idx == 0 else 'guide')\n    @classmethod\n    def guide(cls, path, idx, s): return cls(path, idx, s, 'guide')",
    "ty.ImageConditioningInput = New; utils.types = ty; root.utils = utils",
    "sys.modules.update({'ltx_pipelines_mlx': root, 'ltx_pipelines_mlx.utils': utils, 'ltx_pipelines_mlx.utils.types': ty})",
    "print([i.t for i in m.conditioning_images('a.png', 'b.png', 121)])",
    "print([i.t for i in m.conditioning_images('a.png', None, 121)])",
    // fork shape: no utils/types.py, NamedTuple in utils/args.py
    "del sys.modules['ltx_pipelines_mlx.utils.types']; del utils.types",
    "import typing",
    "class Old(typing.NamedTuple):\n    path: str\n    frame_idx: int\n    strength: float\n    crf: int = 33",
    "args = types.ModuleType('ltx_pipelines_mlx.utils.args'); args.ImageConditioningInput = Old; sys.modules['ltx_pipelines_mlx.utils.args'] = args; utils.args = args",
    "print([tuple(i)[:3] for i in m.conditioning_images('a.png', 'b.png', 121)])",
  ]);
  expect(err).toBe("");
  const lines = out.split("\n");
  expect(lines[0]).toBe("[('replace', 'a.png', 0, 1.0), ('guide', 'b.png', 120, 1.0)]");
  expect(lines[1]).toBe("[('replace', 'a.png', 0, 1.0)]");
  expect(lines[2]).toBe("[('a.png', 0, 1.0), ('b.png', 120, 1.0)]");
});

test.skipIf(!ffmpegPresent)("VIDEO-INPUTS-01: a picture is fitted to the true clip size (fill, centre crop, no stretch) as a plain RGB PNG; an unreadable file is a bad_request", () => {
  const { out, err } = workerProbe([
    // a 640x480 card (red left half, blue right half): filling 512x256 scales then crops top and bottom
    "src = os.path.join(tmp, 'in.png')",
    "subprocess.run([ff, '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x480', '-f', 'lavfi', '-i', 'color=c=blue:s=320x480', '-filter_complex', 'hstack', '-frames:v', '1', src], capture_output=True)",
    "dst = os.path.join(tmp, 'out.png'); m.prepare_picture(ff, src, 512, 256, dst)",
    "info = subprocess.run([ff, '-hide_banner', '-i', dst], capture_output=True, text=True).stderr",
    "import re; print(re.search(r'Video: (\\w+).*?, (\\d+x\\d+)', info).groups())",
    "bad = os.path.join(tmp, 'bad.png'); open(bad, 'wb').write(b'not a picture')",
    "try: m.prepare_picture(ff, bad, 512, 256, os.path.join(tmp, 'bad-out.png')); print('accepted')\nexcept ValueError as e: print('refused:', e)",
  ]);
  expect(err).toBe("");
  const lines = out.split("\n");
  expect(lines[0]).toBe("('png', '512x256')");
  expect(lines[1]).toBe("refused: the picture could not be read");
});

test.skipIf(!ffmpegPresent)("VIDEO-INPUTS-01: generate() with a fake runtime hands DistilledPipeline.generate_and_save the start and end pictures at true size and no picture means no images", () => {
  const { out, err } = workerProbe([
    "ty = types.ModuleType('ltx_pipelines_mlx.utils.types'); root = types.ModuleType('ltx_pipelines_mlx'); utils = types.ModuleType('ltx_pipelines_mlx.utils')",
    "class New:\n    def __init__(self, path, idx, strength, how): self.path, self.idx, self.how = path, idx, how\n    @classmethod\n    def at(cls, path, idx, s): return cls(path, idx, s, 'replace')\n    @classmethod\n    def guide(cls, path, idx, s): return cls(path, idx, s, 'guide')",
    "ty.ImageConditioningInput = New; utils.types = ty; root.utils = utils",
    "sys.modules.update({'ltx_pipelines_mlx': root, 'ltx_pipelines_mlx.utils': utils, 'ltx_pipelines_mlx.utils.types': ty})",
    "calls = []",
    "class Pipe:\n    def generate_and_save(self, prompt, output_path, height, width, num_frames, frame_rate, seed, images=None):\n"
      + "        sizes = []\n"
      + "        for i in (images or []):\n"
      + "            info = subprocess.run([ff, '-hide_banner', '-i', i.path], capture_output=True, text=True).stderr\n"
      + "            sizes.append((i.how, i.idx, re.search(r', (\\d+x\\d+)', info).group(1)))\n"
      + "        calls.append(sizes)\n"
      + "        subprocess.run([ff, '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=64x64:d=1', '-f', 'lavfi', '-i', 'sine=d=1', '-shortest', output_path], capture_output=True)",
    "import re",
    "m._pipeline = lambda *a, **k: Pipe(); m._ffmpeg_on_path = lambda f: ff",
    "pack = os.path.join(tmp, 'pack'); os.makedirs(pack)",
    "for n in m.REQUIRED:\n    p = os.path.join(pack, n); os.makedirs(os.path.dirname(p), exist_ok=True); open(p, 'w').write('x')",
    "pics = []",
    "for n, c in (('s', 'red'), ('e', 'blue')):\n    p = os.path.join(tmp, n + '.png'); subprocess.run([ff, '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=%s:s=300x500' % c, '-frames:v', '1', p], capture_output=True); pics.append(p)",
    "def run(name, **extra):\n    r = dict(id=name, op='generate', model_dir=pack, ffmpeg=ff, prompt='p', width=512, height=288, num_frames=9, seed=1, loras=[], output=os.path.join(tmp, name + '.mp4'), poster=os.path.join(tmp, name + '.jpg')); r.update(extra); m._state['id'] = name; return m.generate(r)",
    "run('a'); run('b', image=pics[0]); run('c', image=pics[0], end_image=pics[1])",
    "print(calls)",
    "try: run('d', end_image=pics[1]); print('accepted')\nexcept ValueError as e: print('refused:', e)",
    "print(run('e', image=pics[0])['width'], os.path.exists(os.path.join(tmp, 'e.mp4.work')))",
  ]);
  expect(err).toBe("");
  const lines = out.split("\n");
  expect(lines[0]).toBe("[[], [('replace', 0, '512x256')], [('replace', 0, '512x256'), ('guide', 8, '512x256')]]");
  expect(lines[1]).toBe("refused: a last picture needs a first picture");
  expect(lines[2]).toMatch(/^\d+ False$/);
});

// ---- the real worker, only where a prepared environment is named ----

const python = process.env.LTX25_GEN_PYTHON;
const worker = join(import.meta.dir, "../src/video/ltx25_worker.py");
test.skipIf(!python)("REAL worker: refuses sizes and lengths outside the table, a picture and a style file, and a pack that is not installed, and stays up", async () => {
  const child = Bun.spawn([python!, "-s", worker], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, PYTHONPATH: process.env.LTX25_GEN_SRC ?? "", HF_HUB_OFFLINE: "1" } });
  const handle = workerHandle(child as never);
  const base = { op: "generate", model_dir: "/nonexistent", tokenizer_dir: "/nonexistent", prompt: "x", negative_prompt: null, image: null, seed: 1, loras: [], output: "/tmp/never.mp4", poster: "/tmp/never.jpg" };
  const send = (id: string, extra: Record<string, unknown>) => handle.send({ id, ...base, ...extra } as unknown as WorkerRequest, { deadlineMs: 60_000, onEvent: () => {} });
  expect(await send("1", { width: 1024, height: 576, num_frames: 121 })).toMatchObject({ ok: false, code: "bad_request" });
  expect(await send("2", { width: 512, height: 256, num_frames: 120 })).toMatchObject({ ok: false, code: "bad_request" });
  expect(await send("3", { width: 768, height: 448, num_frames: 241 })).toMatchObject({ ok: false, code: "bad_request" });
  expect(await send("4", { width: 512, height: 256, num_frames: 121, end_image: "/tmp/x.png" })).toMatchObject({ ok: false, code: "bad_request" });
  expect(await send("5", { width: 512, height: 256, num_frames: 121, loras: [["/tmp/a.safetensors", 1]] })).toMatchObject({ ok: false, code: "bad_request" });
  expect(await send("6", { width: 512, height: 256, num_frames: 241 })).toMatchObject({ ok: false, code: "model_missing" });
  handle.kill();
});

test.skipIf(!python)("REAL worker: a socket connection is refused inside the worker process", async () => {
  const probe = "import sys, socket, importlib.util\nspec = importlib.util.spec_from_file_location('w', sys.argv[1])\nm = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\nm.forbid_network()\ntry:\n    socket.create_connection(('192.0.2.1', 80), timeout=1)\n    print('connected')\nexcept OSError as e:\n    print('refused:', e)\n";
  const out = Bun.spawnSync([python!, "-s", "-c", probe, worker], { env: { ...process.env, PYTHONPATH: process.env.LTX25_GEN_SRC ?? "" } });
  expect(String(out.stdout)).toContain("refused: the video engine makes no network connection");
});

const realPack = process.env.LTX25_REAL_MODEL;
test.skipIf(!python || !realPack || !process.env.LTX25_FFMPEG)("REAL: a 1 second Standard clip through the real worker comes back as an mp4 with an AAC sound track", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ltx25-real-"));
  const child = Bun.spawn([python!, "-s", worker], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, PYTHONPATH: process.env.LTX25_GEN_SRC ?? "", HF_HUB_OFFLINE: "1", VIDEO_WORKER_DEBUG: "1" } });
  const handle = workerHandle(child as never);
  const events: string[] = [];
  const reply = await handle.send({ id: "real", op: "generate", model_dir: realPack!, tokenizer_dir: realPack!, ffmpeg: process.env.LTX25_FFMPEG!, prompt: "A friendly blue cartoon character waves and says hello.", negative_prompt: null, image: null, width: 512, height: 256, num_frames: 25, seed: 7, loras: [], output: join(dir, "video.mp4"), poster: join(dir, "poster.jpg") } as WorkerRequest, { deadlineMs: 600_000, onEvent: (event) => { events.push(event.event === "stage" ? event.stage : event.event); } });
  handle.kill();
  expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true, width: 512, frames: 25, audio: true });
  expect(events).toContain("motion");
  rmSync(dir, { recursive: true, force: true });
}, 700_000);
