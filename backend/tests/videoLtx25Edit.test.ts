// LTX25-EDIT-01: extend and retake on the LTX-2.5 Max engine. Request validation, the second-to-latent mapping, the source plan and the 64-grid
// fit, the worker request, admission and the status fields run against a scripted worker and a scripted ffprobe/ffmpeg (no weights, no GPU, no
// network). The worker's own Python functions run with a stubbed mlx, as the Max tests do. The real run (a real 10 s clip, a real extend and a
// real retake) is recorded in the commit that added this file, not here.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly } from "@/lib/governor";
import { __resetJobsForTests } from "@/lib/jobs";
import { __resetMemoryStateForTests } from "@/lib/memoryState";
import { __resetRootsForTests, jobsDir, setRoots } from "@/media/paths";
import type { MediaToolbox } from "@/media/tools";
import type { Runner } from "@/media/run";
import { dataDir } from "@/lib/paths";
import { registerVideoJobs } from "@/video/jobs";
import { LTX25_MAX_GEMMA_FOLDER } from "@/lib/modelCatalog";
import { LTX25_CLIP_CAP_BYTES } from "@/video/ltx25";
import { __setEditRuntimeForTests, checkEdit, EditSourceError, extendLatentFrames, extendPixelFrames, fitArgs, ltx25EditAdmitBytes, ltx25MaxEditSupported, LTX25_EDIT_ROWS_PASS_CAP, LTX25_MAX_EDIT_MEASURED, planSource, retakeStartLatent, sourceFactsFromProbe, sourceLatentFrames, usableFrames, type SourceFacts } from "@/video/ltx25Edit";
import { __resetProvenanceForTests } from "@/video/provenance";
import { videoGen, type VideoGenDeps, type WorkerHandle, type WorkerReply, type WorkerRequest } from "@/video/videoGen";

const GB = 1_073_741_824;
const requests: WorkerRequest[] = [];
const seen: Array<{ exists: boolean; sourceSize: number }> = [];
let ffmpegCalls: string[][] = [];
let probeJson: unknown;
let root = "";
let source = "";

const facts = (over: Partial<SourceFacts> = {}): SourceFacts => ({ hasVideo: true, hasAudio: true, width: 768, height: 448, fps: 24, frames: 241, ...over });
const probeOf = (over: Partial<{ w: number; h: number; rate: string; frames: string; audio: boolean; video: boolean }> = {}) => {
  const { w = 768, h = 448, rate = "24/1", frames = "241", audio = true, video = true } = over;
  return { streams: [...(video ? [{ codec_type: "video", width: w, height: h, r_frame_rate: rate, nb_frames: frames, duration: String(Number(frames) / (Number(rate.split("/")[0]) / Number(rate.split("/")[1]))) }] : []), ...(audio ? [{ codec_type: "audio" }] : [])], format: { duration: "10.04" } };
};
const toolbox: MediaToolbox = { installed: () => true, path: async (tool) => `/fake/bin/${tool}` };
const run: Runner = async (argv) => {
  if (argv[0] === "/fake/bin/ffprobe") return { code: 0, stdout: JSON.stringify(probeJson), stderr: "", aborted: false };
  ffmpegCalls.push(argv);
  // The fit writes the file the job then hands to the worker.
  writeFileSync(argv[argv.length - 1]!, "FITTED-MP4");
  return { code: 0, stdout: "", stderr: "", aborted: false };
};

const okReply = (request: WorkerRequest): WorkerReply => ({ id: request.id, ok: true, width: request.width, height: request.height, frames: request.op === "extend" ? 337 : 241, fps: 24, seed: request.seed, ms: 1234, peak_bytes: 37_000_000_000, audio: true });
function scripted(): VideoGenDeps {
  return {
    supported: () => true,
    ensureEnvironment: async () => {},
    paths: (quality) => (quality === "ltx25max" ? { modelDir: "/models/max", tokenizerDir: `/models/max/${LTX25_MAX_GEMMA_FOLDER}`, textEncoderDir: `/models/max/${LTX25_MAX_GEMMA_FOLDER}` } : null),
    spawn: async (): Promise<WorkerHandle> => {
      let end!: (code: number) => void;
      const exited = new Promise<number>((done) => { end = done; });
      return { exited, kill: () => end(143), send: async (request, options) => {
        requests.push(request);
        // The source is the job's private copy, present while the worker runs.
        seen.push({ exists: !!request.source_video && existsSync(request.source_video), sourceSize: request.source_video && existsSync(request.source_video) ? Bun.file(request.source_video).size : -1 });
        options.onEvent({ id: request.id, event: "stage", stage: "source" });
        writeFileSync(request.output, "MP4DATA-0123456789"); writeFileSync(request.poster, "JPEGDATA");
        return okReply(request);
      } };
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
  requests.length = 0; seen.length = 0; ffmpegCalls = []; probeJson = probeOf();
  clean();
  __resetRootsForTests();
  root = mkdtempSync(join(tmpdir(), "ltx25-edit-"));
  source = join(root, "clip.mp4");
  writeFileSync(source, "SOURCE-MP4-BYTES");
  setRoots({ read: [root] });
  __setEditRuntimeForTests({ toolbox, run });
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 90 * GB, tier: "p128" });
  registerVideoJobs();
});
afterEach(() => { clean(); __setEditRuntimeForTests(null); __resetRootsForTests(); rmSync(root, { recursive: true, force: true }); rmSync(jobsDir(), { recursive: true, force: true }); });
const post = (body: Record<string, unknown>) => app.request("/v1/videos/generations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
type Entry = Record<string, unknown>;
const edit = (extra: Record<string, unknown>) => post({ prompt: "Marie says: eat your dinner.", model: "ltx25-max", source_video: source, seed: 7, timeout_ms: 5000, ...extra });
const refused = async (extra: Record<string, unknown>) => { const response = await edit(extra); return { status: response.status, body: await response.json() as { code: string; error: string } }; };

// ---- the mapping, the plan, the fit ----

test("seconds map to latent frames: extend is ceil(seconds x 24 / 8), retake starts at floor(seconds x 24 / 8), and a whole second is 3 latent frames", () => {
  expect([1, 2, 4, 6].map(extendLatentFrames)).toEqual([3, 6, 12, 18]);
  expect(extendLatentFrames(2.5)).toBe(8);
  expect(extendLatentFrames(1.01)).toBe(4);
  expect(extendPixelFrames(4)).toBe(96);
  expect([1, 5, 9].map(retakeStartLatent)).toEqual([3, 15, 27]);
  expect(retakeStartLatent(5.9)).toBe(17);
  // The runtime encodes 8k + 1 frames: a 241 frame clip has 31 latent frames, so a retake from 5 s is [15, 31).
  expect(usableFrames(241)).toBe(241);
  expect(usableFrames(248)).toBe(241);
  expect(usableFrames(250)).toBe(249);
  expect(sourceLatentFrames(241)).toBe(31);
  expect(sourceLatentFrames(25)).toBe(4);
});

test("the plan keeps a source that is already on the table and 24 a second, and fits every other one to the largest table size inside it", () => {
  expect(planSource(facts())).toMatchObject({ width: 768, height: 448, fit: false, frames: 241, latentFrames: 31 });
  expect(planSource(facts({ width: 1024, height: 576 }))).toMatchObject({ width: 1024, height: 576, fit: false, size: "1024x576" });
  // A frame rate other than 24 is re-made first, and so is a size off the table (1280x720 is not a row).
  expect(planSource(facts({ fps: 30, frames: 300 }))).toMatchObject({ fit: true, width: 768, height: 448, frames: 233, latentFrames: 30 });
  const fitted = planSource(facts({ width: 1280, height: 720 }));
  expect(fitted.fit).toBe(true);
  expect(fitted.width % 64).toBe(0);
  expect(fitted.height % 64).toBe(0);
  expect(planSource(facts({ width: 800, height: 600 }))).toMatchObject({ fit: true, size: "768x448" });
  // Sixty frames at 25 a second is 57.6 at 24: still above the 25 frame floor.
  expect(planSource(facts({ fps: 25, frames: 60 }))).toMatchObject({ fit: true, frames: 57 });
});

test("a source is refused with a plain code: unreadable, no sound, too short, too long, too small", () => {
  const code = (value: SourceFacts): string => { try { planSource(value); return "ok"; } catch (error) { return (error as EditSourceError).code; } };
  expect(code(facts({ hasVideo: false, width: 0, height: 0 }))).toBe("bad_source");
  expect(code(facts({ hasAudio: false }))).toBe("bad_source_audio");
  expect(code(facts({ frames: 24 }))).toBe("bad_source");
  expect(code(facts({ frames: 25 }))).toBe("ok");
  expect(code(facts({ frames: 242 }))).toBe("bad_source");
  expect(code(facts({ fps: 48, frames: 600 }))).toBe("bad_source");
  expect(code(facts({ width: 640, height: 360 }))).toBe("bad_source");
  expect(code(facts({ width: 768, height: 400 }))).toBe("bad_source");
  expect(() => planSource(facts({ frames: 20 }))).toThrow(/too short/);
  expect(() => planSource(facts({ frames: 300 }))).toThrow(/Trim it first/);
  expect(() => planSource(facts({ hasAudio: false }))).toThrow(/sound/);
});

test("a retake must start inside the clip: 1 second up to the last latent frame", () => {
  const plan = planSource(facts());
  expect(() => checkEdit("retake", plan, 5)).not.toThrow();
  expect(() => checkEdit("retake", plan, 9)).not.toThrow();
  expect(() => checkEdit("retake", plan, 10.5)).toThrow(/Pick a start inside/);
  expect(() => checkEdit("retake", planSource(facts({ frames: 49 })), 5)).toThrow(EditSourceError);
  expect(() => checkEdit("extend", plan, 6)).not.toThrow();
});

test("the fit command scales to fill, crops to the table size at 24 a second, keeps the sound and drops metadata", () => {
  const args = fitArgs("/in/a.mov", "/out/source.mp4", { width: 768, height: 448 });
  const filters = args[args.indexOf("-vf") + 1]!;
  expect(filters).toContain("fps=24");
  expect(filters).toContain("scale=768:448:force_original_aspect_ratio=increase");
  expect(filters).toContain("crop=768:448");
  expect(args).toContain("-map_metadata");
  expect(args.slice(args.indexOf("-map"), args.indexOf("-map") + 4)).toEqual(["-map", "0:v:0", "-map", "0:a:0"]);
  expect(args.at(-1)).toBe("/out/source.mp4");
});

test("ffprobe's JSON becomes the plan's facts (frames from nb_frames, else duration times rate)", () => {
  expect(sourceFactsFromProbe(probeOf())).toEqual(facts());
  const noCount = probeOf({ frames: "0" }) as { streams: Array<Record<string, unknown>>; format: Record<string, unknown> };
  delete noCount.streams[0]!.nb_frames; noCount.streams[0]!.duration = "10.04";
  expect(sourceFactsFromProbe(noCount).frames).toBe(241);
  expect(sourceFactsFromProbe(probeOf({ audio: false })).hasAudio).toBe(false);
  expect(sourceFactsFromProbe({}).hasVideo).toBe(false);
});

// ---- the request ----

test("an extend of 4 s runs on the Max worker as op extend with 12 latent frames, the fitted private source, and the Stack's own ffmpeg and ffprobe", async () => {
  videoGen.useDeps(scripted());
  const response = await edit({ extend_seconds: 4 });
  expect(response.status).toBe(200);
  const body = await response.json() as { data: Entry[] };
  expect(body.data[0]).toMatchObject({ width: 768, height: 448, frames: 337, seconds: 14, quality: "ltx25max", audio: true, mode: "extend" });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ op: "extend", profile: "max", extend_frames: 12, model_dir: "/models/max", text_encoder_dir: `/models/max/${LTX25_MAX_GEMMA_FOLDER}`, ffmpeg: "/fake/bin/ffmpeg", ffprobe: "/fake/bin/ffprobe", width: 768, height: 448 });
  expect(requests[0]!.retake_start_latent).toBeUndefined();
  expect(requests[0]!.source_video).not.toBe(source);
  expect(seen[0]).toEqual({ exists: true, sourceSize: "SOURCE-MP4-BYTES".length });
  expect(ffmpegCalls).toHaveLength(0);
  expect(existsSync(source)).toBe(true);
});

test("a retake from 5 s runs as op retake from latent frame 15 and reports mode retake", async () => {
  videoGen.useDeps(scripted());
  const response = await edit({ retake_from_seconds: 5 });
  expect(response.status).toBe(200);
  expect(((await response.json()) as { data: Entry[] }).data[0]).toMatchObject({ mode: "retake", frames: 241, seconds: 10, quality: "ltx25max" });
  expect(requests[0]).toMatchObject({ op: "retake", profile: "max", retake_start_latent: 15, text_encoder_dir: `/models/max/${LTX25_MAX_GEMMA_FOLDER}` });
  expect(requests[0]!.extend_frames).toBeUndefined();
});

test("a source off the table or off 24 a second is re-made by ffmpeg into the job's own copy before the worker sees it", async () => {
  videoGen.useDeps(scripted());
  probeJson = probeOf({ w: 1280, h: 720, rate: "30/1", frames: "300" });
  const response = await edit({ extend_seconds: 2 });
  expect(response.status).toBe(200);
  expect(ffmpegCalls).toHaveLength(1);
  expect(ffmpegCalls[0]![0]).toBe("/fake/bin/ffmpeg");
  expect(ffmpegCalls[0]!.join(" ")).toContain("fps=24");
  expect(ffmpegCalls[0]).toContain(realpathSync(source));
  expect(seen[0]).toEqual({ exists: true, sourceSize: "FITTED-MP4".length });
  expect(requests[0]).toMatchObject({ op: "extend", extend_frames: 6 });
  expect(requests[0]!.width % 64).toBe(0);
  expect(requests[0]!.height % 64).toBe(0);
});

test("every refusal is a plain 422 before anything is queued", async () => {
  videoGen.useDeps(scripted());
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["not Max", { model: "ltx25-q8", extend_seconds: 2 }, "edit_unsupported"],
    ["no model named", { model: undefined, extend_seconds: 2 }, "edit_unsupported"],
    ["both edits", { extend_seconds: 2, retake_from_seconds: 3 }, "bad_edit"],
    ["a source with no edit", {}, "bad_edit"],
    ["an edit with no source", { source_video: undefined, extend_seconds: 2 }, "bad_edit"],
    ["a picture with an edit", { extend_seconds: 2, image: "aGVsbG8=" }, "bad_edit"],
    ["a size with an edit", { extend_seconds: 2, size: "1024x576" }, "bad_edit"],
    ["styles", { extend_seconds: 2, loras: [{ id: "x" }] }, "lora_unsupported"],
    ["outside the media folders", { source_video: "/etc/hosts", extend_seconds: 2 }, "path_outside_roots"],
    ["a missing file", { source_video: join(root, "nope.mp4"), extend_seconds: 2 }, "source_not_found"],
    ["a relative path", { source_video: "clip.mp4", extend_seconds: 2 }, "path_invalid"],
  ];
  for (const [name, extra, code] of cases) {
    const result = await refused(extra);
    expect(result.status, name).toBe(422);
    expect(result.body.code, name).toBe(code);
    expect(result.body.error.length, name).toBeGreaterThan(20);
  }
  // A number outside the range is refused by the schema.
  expect((await edit({ extend_seconds: 7 })).status).toBeGreaterThanOrEqual(400);
  expect((await edit({ extend_seconds: 0.5 })).status).toBeGreaterThanOrEqual(400);
  expect((await edit({ retake_from_seconds: 10 })).status).toBeGreaterThanOrEqual(400);
  expect(requests).toHaveLength(0);
});

test("the source's own problems come back as 422 codes: too short, too long, no sound, not a video, retake past the end", async () => {
  videoGen.useDeps(scripted());
  probeJson = probeOf({ frames: "20" });
  expect(await refused({ extend_seconds: 2 })).toMatchObject({ status: 422, body: { code: "bad_source" } });
  probeJson = probeOf({ frames: "400" });
  expect(await refused({ extend_seconds: 2 })).toMatchObject({ status: 422, body: { code: "bad_source" } });
  probeJson = probeOf({ audio: false });
  expect(await refused({ extend_seconds: 2 })).toMatchObject({ status: 422, body: { code: "bad_source_audio" } });
  probeJson = probeOf({ video: false });
  expect(await refused({ extend_seconds: 2 })).toMatchObject({ status: 422, body: { code: "bad_source" } });
  probeJson = probeOf({ frames: "49" });
  expect(await refused({ retake_from_seconds: 5 })).toMatchObject({ status: 422, body: { code: "bad_retake" } });
  expect(requests).toHaveLength(0);
});

test("a source the route could not probe (no ffprobe yet) is probed by the job, and a refusal then is the job's code", async () => {
  videoGen.useDeps(scripted());
  __setEditRuntimeForTests({ toolbox: { installed: () => false, path: toolbox.path }, run });
  probeJson = probeOf({ audio: false });
  const response = await edit({ extend_seconds: 2 });
  expect(response.status).toBe(422);
  expect(((await response.json()) as { code: string }).code).toBe("bad_source_audio");
  expect(requests).toHaveLength(0);
});

test("admission reserves the measured footprint plus 5 percent, under the 64 GB per-clip cap, per size and kind", () => {
  expect(LTX25_EDIT_ROWS_PASS_CAP).toBe(true);
  expect(ltx25EditAdmitBytes("extend", "768x448")).toBe(Math.round(59.3e9 * 1.05));
  expect(ltx25EditAdmitBytes("retake", "768x448")).toBe(Math.round(59.1e9 * 1.05));
  expect(ltx25EditAdmitBytes("extend", "1024x576")).toBe(Math.round(48.8e9 * 1.05));
  expect(ltx25EditAdmitBytes("retake", "1024x576")).toBe(Math.round(56.5e9 * 1.05));
  for (const row of LTX25_MAX_EDIT_MEASURED) for (const kind of ["extend", "retake"] as const) expect(ltx25EditAdmitBytes(kind, row.size)).toBeLessThan(LTX25_CLIP_CAP_BYTES);
  // An unknown size asks for the largest row (never less than was measured).
  expect(ltx25EditAdmitBytes("extend", null)).toBe(Math.max(...LTX25_MAX_EDIT_MEASURED.map((row) => ltx25EditAdmitBytes("extend", row.size))));
});

test("the status route reports extend and retake true with their footprints, and false when the installed runtime lacks the classes", async () => {
  const body = await (await app.request("/stack/v1/video")).json() as { video: { qualities: { ltx25max: Record<string, unknown> & { profiles: Array<Record<string, unknown>>; edit: { profiles: Array<Record<string, unknown>>; source: Record<string, unknown> } } } } };
  const max = body.video.qualities.ltx25max;
  expect(max.extend).toBe(true);
  expect(max.retake).toBe(true);
  expect(max.edit.source).toMatchObject({ min_frames: 25, max_frames: 241, fps: 24 });
  const small = max.edit.profiles.find((row) => row.size === "768x448")!;
  expect(small).toMatchObject({ extend: { peak_gb: 59.3, admit_gb: 62.3 }, retake: { peak_gb: 59.1, admit_gb: 62.1 } });
  // The Max generate row carries the edit figures of its own size, or null where none was measured.
  expect(max.profiles[0]).toMatchObject({ extend: { peak_gb: 48.8, admit_gb: 51.2 }, retake: { peak_gb: 56.5, admit_gb: 59.3 } });
  // The status asks the installed runtime source: both files, or not offered.
  const dir = mkdtempSync(join(tmpdir(), "ltx25-runtime-"));
  try {
    const pipelines = join(dir, "packages", "ltx-pipelines-mlx", "src", "ltx_pipelines_mlx");
    mkdirSync(pipelines, { recursive: true });
    expect(ltx25MaxEditSupported(dir, "zzz")).toBe(false);
    writeFileSync(join(pipelines, "retake.py"), "");
    expect(ltx25MaxEditSupported(dir, "b82b97e")).toBe(false);
    writeFileSync(join(pipelines, "extend_distilled.py"), "");
    expect(ltx25MaxEditSupported(dir, "zzz")).toBe(true);
    // Before the runtime is installed, the pinned build decides: 0.18.0 ships both.
    expect(ltx25MaxEditSupported(join(dir, "none"), "b82b97e")).toBe(true);
    expect(ltx25MaxEditSupported(join(dir, "none"), "5795228")).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- the worker ----

const WORKER = join(import.meta.dir, "../src/video/ltx25_worker.py");
function python(lines: string[], ...args: string[]) {
  const probe = [
    "import sys, types, importlib.util, os, tempfile",
    "mx = types.ModuleType('mlx.core'); mx.set_cache_limit = lambda n: None; mx.clear_cache = lambda: None",
    "pkg = types.ModuleType('mlx'); pkg.core = mx; sys.modules['mlx'] = pkg; sys.modules['mlx.core'] = mx",
    "spec = importlib.util.spec_from_file_location('w', sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
    ...lines,
  ].join("\n");
  const out = Bun.spawnSync(["python3", "-I", "-c", probe, WORKER, ...args]);
  return { stdout: String(out.stdout).trim().split("\n"), stderr: String(out.stderr) };
}

test("the worker maps latent frames and refuses an edit outside what was measured, with the same table as the Stack", () => {
  const sizes = LTX25_MAX_EDIT_MEASURED.map((row) => `(${row.width}, ${row.height})`).sort().join(", ");
  const out = python([
    "print(sorted(m.MEASURED_EDIT) == sorted([" + sizes + "]))",
    "print(m.latent_frames(241), m.latent_frames(25), m.latent_frames(248), m.latent_frames(250))",
    "r = lambda *a: m.edit_refusal(*a)",
    "print(r('extend', 768, 448, 241, 12, None), r('retake', 768, 448, 241, None, 15))",
    "print(r('extend', 640, 360, 241, 12, None))",
    "print(r('extend', 768, 448, 24, 12, None))",
    "print(r('extend', 768, 448, 242, 12, None))",
    "print(r('extend', 768, 448, 241, 19, None))",
    "print(r('extend', 768, 448, 241, 0, None))",
    "print(r('retake', 768, 448, 241, None, 31))",
    "print(r('retake', 768, 448, 241, None, 0))",
  ]);
  expect(out.stderr).toBe("");
  expect(out.stdout[0]).toBe("True");
  expect(out.stdout[1]).toBe("31 4 31 32");
  expect(out.stdout[2]).toBe("None None");
  expect(out.stdout[3]).toStartWith("the source must be one of");
  expect(out.stdout[4]).toContain("at least 25 frames");
  expect(out.stdout[5]).toContain("at most 241 frames");
  expect(out.stdout[6]).toContain("1 to 18");
  expect(out.stdout[7]).toContain("1 to 18");
  expect(out.stdout[8]).toContain("inside the clip");
  expect(out.stdout[9]).toContain("inside the clip");
});

test("REGRESSION: an edit takes the pack's Gemma folder like every Max run: the worker refuses a request without it, and checks the built pipeline took it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ltx25edit-worker-"));
  try {
    const out = python([
      "pack, src = sys.argv[2], sys.argv[3]",
      "g = os.path.join(pack, 'gemma4-12b-ltx-v1'); os.makedirs(g)",
      "for n in m.MAX_REQUIRED:\n    p = os.path.join(pack, n); os.makedirs(os.path.dirname(p), exist_ok=True); open(p, 'w').write('x')",
      "open(src, 'w').write('x')",
      "def attempt(**extra):",
      "    request = dict(op='extend', profile='max', source_video=src, model_dir=pack, prompt='p', seed=1, output=os.path.join(pack, 'o.mp4'), poster=os.path.join(pack, 'p.jpg'), extend_frames=12, text_encoder_dir=g, **extra)",
      "    try: m.edit(request)\n    except ValueError as e: return 'ValueError ' + str(e)\n    except Exception as e: return type(e).__name__ + ' ' + str(e)\n    return 'ran'",
      "print(attempt(text_encoder_dir=None) if False else 'skip')",
      "def bare(**over):",
      "    request = dict(op='extend', profile='max', source_video=src, model_dir=pack, prompt='p', seed=1, output=os.path.join(pack, 'o.mp4'), poster=os.path.join(pack, 'p.jpg'), extend_frames=12)",
      "    request.update(over)",
      "    try: m.edit(request)\n    except ValueError as e: return 'ValueError ' + str(e)\n    except Exception as e: return type(e).__name__ + ' ' + str(e)\n    return 'ran'",
      "print(bare())",
      "print(bare(text_encoder_dir=os.path.join(pack, 'other')))",
      "print(bare(profile=None, text_encoder_dir=g))",
      "print(bare(image='x', text_encoder_dir=g))",
      "print(bare(loras=[['a', 1]], text_encoder_dir=g))",
      "print(bare(source_video=os.path.join(pack, 'missing.mp4'), text_encoder_dir=g))",
    ], join(dir, "pack"), join(dir, "source.mp4"));
    expect(out.stderr).toBe("");
    expect(out.stdout[1]).toBe("ValueError the Max video model must be run with its own text encoder folder");
    expect(out.stdout[2]).toBe("ValueError the Max video model must be run with its own text encoder folder");
    expect(out.stdout[3]).toBe("ValueError extend and retake run on the Max video model only");
    expect(out.stdout[4]).toBe("ValueError an extend or a retake takes no picture");
    expect(out.stdout[5]).toBe("ValueError this video model takes no style files yet");
    expect(out.stdout[6]).toBe("ValueError the source clip is missing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // The pipeline is built with the Gemma folder and the check that it took it, for each mode.
  const source = require("node:fs").readFileSync(WORKER, "utf8") as string;
  expect(source).toContain("ExtendDistilledPipeline(model_dir=model_dir, gemma_model_id=gemma_dir, low_memory=True)");
  expect(source).toContain("RetakePipeline(model_dir=model_dir, gemma_model_id=gemma_dir, low_memory=True, distilled=True)");
  expect(source).toContain("did not take the text encoder folder");
  expect(source).toContain("gemma_dir = max_gemma_dir(model_dir, request.get(\"text_encoder_dir\"))");
});

test("the worker builds the pipeline class of each mode with the Gemma folder, checks it took it, and gives the old pipeline back on a mode change", () => {
  const out = python([
    "def stub(name, cls):",
    "    mod = types.ModuleType(name); setattr(mod, cls.__name__, cls); sys.modules[name] = mod",
    "built = []",
    "class Enc:\n    def __init__(self, g): self.gemma_model_id = g",
    "class Base:\n    def __init__(self, model_dir=None, gemma_model_id=None, low_memory=False, **kw):\n        self.prompt_encoder = Enc(gemma_model_id); self.kw = kw; built.append((type(self).__name__, model_dir, gemma_model_id, low_memory, kw))",
    "class ExtendDistilledPipeline(Base): pass",
    "class RetakePipeline(Base): pass",
    "class DistilledPipeline(Base): pass",
    "class BadEncoder(Base):\n    def __init__(self, **k):\n        super().__init__(**k); self.prompt_encoder = Enc('somewhere-else')",
    "for pkgname in ('ltx_pipelines_mlx', 'ltx_core_mlx'): sys.modules[pkgname] = types.ModuleType(pkgname)",
    "stub('ltx_pipelines_mlx.extend_distilled', ExtendDistilledPipeline); stub('ltx_pipelines_mlx.retake', RetakePipeline); stub('ltx_pipelines_mlx.distilled', DistilledPipeline)",
    "m._install_patches = lambda pipe: None",
    "e = m._pipeline('/m', '/m/g', 'extend'); print(type(e).__name__, built[-1][1:4], built[-1][4])",
    "print(m._pipeline('/m', '/m/g', 'extend') is e)",
    "r = m._pipeline('/m', '/m/g', 'retake'); print(type(r).__name__, built[-1][4], r is e)",
    "g = m._pipeline('/m', '/m/g'); print(type(g).__name__, m._state['model_dir'])",
    "stub('ltx_pipelines_mlx.extend_distilled', type('ExtendDistilledPipeline', (BadEncoder,), {}))",
    "try: m._pipeline('/x', '/x/g', 'extend')\nexcept ValueError as err: print('refused', err)",
  ]);
  expect(out.stderr).toBe("");
  expect(out.stdout[0]).toBe("ExtendDistilledPipeline ('/m', '/m/g', True) {}");
  expect(out.stdout[1]).toBe("True");
  expect(out.stdout[2]).toBe("RetakePipeline {'distilled': True} False");
  expect(out.stdout[3]).toBe("DistilledPipeline ('generate', '/m', '/m/g')");
  expect(out.stdout[4]).toBe("refused the Max video runtime did not take the text encoder folder");
});

test("the worker puts the Stack's ffmpeg and ffprobe first on PATH under their own names (the runtime probes with `ffprobe` on PATH)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ltx25edit-tools-"));
  try {
    writeFileSync(join(dir, "ffmpeg-darwin"), "#!/bin/sh\n"); writeFileSync(join(dir, "probe-bin"), "#!/bin/sh\n");
    chmodSync(join(dir, "ffmpeg-darwin"), 0o755); chmodSync(join(dir, "probe-bin"), 0o755);
    const out = python([
      "d = sys.argv[2]",
      "found = m.tools_on_path(os.path.join(d, 'ffmpeg-darwin'), os.path.join(d, 'probe-bin'), os.path.join(d, 'work'))",
      "print(os.path.basename(os.path.realpath(os.path.join(d, 'work', 'bin', 'ffmpeg'))), os.path.basename(os.path.realpath(os.path.join(d, 'work', 'bin', 'ffprobe'))))",
      "print(os.environ['PATH'].split(os.pathsep)[0] == os.path.join(d, 'work', 'bin'), found == os.path.join(d, 'work', 'bin', 'ffmpeg'))",
      "try: m.tools_on_path(os.path.join(d, 'ffmpeg-darwin'), None, os.path.join(d, 'work2'))\nexcept FileNotFoundError as err: print('missing', err)",
    ], dir);
    expect(out.stderr).toBe("");
    expect(out.stdout[0]).toBe("ffmpeg-darwin probe-bin");
    expect(out.stdout[1]).toBe("True True");
    expect(out.stdout[2]).toBe("missing the video tools are not installed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
