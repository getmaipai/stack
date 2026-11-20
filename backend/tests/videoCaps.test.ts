// VF-CAPS-01 slice 1: one contract (video/caps.ts) drives discovery, request validation and command construction for video operations.
// These tests walk every row the Stack publishes and hold the route, the builders, the pack JSON and the model listing to it, so a change to
// one of them without the rows fails here. Driven by a scripted worker and a scripted H3 runner: no weights, no GPU, no network.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackJobsCatalog } from "@maipai/spec/stack/ts/stack-jobs-catalog.js";
import { StackOperationRow } from "@maipai/spec/stack/ts/stack-model-pack.js";
import type { StackPartView } from "@maipai/spec/stack/ts/stack-part-view.js";
import { app } from "@/app";
import { PART_DEFS } from "@/lib/partDefs";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly } from "@/lib/governor";
import { __resetJobsForTests } from "@/lib/jobs";
import { __resetMemoryStateForTests } from "@/lib/memoryState";
import { dataDir } from "@/lib/paths";
import { catalogOperations, jobsCatalog } from "@/lib/jobsCatalog";
import { __setPartsHardwareForTests } from "@/lib/partsList";
import { __resetPartChoicesForTests } from "@/lib/partChoices";
import type { HardwareInfo } from "@/lib/hardware";
import { packs } from "@/packs/loader";
import { registerVideoJobs } from "@/video/jobs";
import { __resetProvenanceForTests } from "@/video/provenance";
import { h3VideoCommand } from "@/video/h3";
import { INGREDIENTS_ADAPTER_FILE } from "@/routes/videoGenerations";
import { LTX25_INGREDIENTS_MAX_SECONDS, LTX25_INGREDIENTS_MIN_SECONDS } from "@/video/ltx25";
import { LTX25_EDIT_EXTEND_MAX_SECONDS, LTX25_EDIT_RETAKE_MAX_SECONDS } from "@/video/ltx25Edit";
import { SWAP_MIN_SECONDS } from "@/lib/makeDispatchSwap";
import { buildWorkerRequest, VIDEO_SPECS, videoGen, type VideoGenDeps, type VideoQuality, type WorkerHandle, type WorkerReply, type WorkerRequest } from "@/video/videoGen";
import { checkVideoInputs, engineOfPart, SWAP_WINDOW_MIN_SECONDS, jobCapabilitiesFromRows, jobLimitsFromRows, partOfEngine, rowForRequest, rowsForJob, rowsOfEngine, videoOperationRows, VIDEO_ENGINES, type VideoEngine, type VideoInputs } from "@/video/caps";

const GB = 1_073_741_824;
const MODEL: Record<VideoEngine, string> = { ltx25: "ltx25-q8", ltx25max: "ltx25-max", h3: "minimax-h3" };
const QUALITY: Record<VideoEngine, VideoQuality> = { ltx25: "ltx25", ltx25max: "ltx25max", h3: "h3" };
const GENERATE = ["clip_text", "clip_start_picture", "clip_start_end_pictures"];
const PNG_B64 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake-png-body")]).toString("base64");

const workerRequests: WorkerRequest[] = [];
const h3Commands: string[][] = [];
let h3Root = "";

function scripted(): VideoGenDeps {
  return {
    supported: () => true,
    ensureEnvironment: async () => {},
    paths: (quality) => quality === "ltx25max" ? { modelDir: "/models/max", tokenizerDir: "/models/max/gemma", textEncoderDir: "/models/max/gemma" }
      : quality === "ltx25" ? { modelDir: "/models/ltx25", tokenizerDir: "/models/ltx25/text_encoder", textEncoderDir: "/models/ltx25/text_encoder" }
      : quality === "h3" ? { modelDir: join(h3Root, "models/minimax_h3"), tokenizerDir: "", h3Home: h3Root, h3Build: "boost-8bit" } : null,
    spawn: async (): Promise<WorkerHandle> => {
      let end!: (code: number) => void;
      const exited = new Promise<number>((done) => { end = done; });
      return { exited, kill: () => end(143), send: async (request): Promise<WorkerReply> => {
        workerRequests.push(request);
        writeFileSync(request.output, "MP4DATA-0123456789"); writeFileSync(request.poster, "JPEGDATA");
        return { id: request.id, ok: true, width: request.width, height: request.height, frames: request.num_frames, fps: 24, seed: request.seed, ms: 1, peak_bytes: 1, audio: true };
      } };
    },
    run: async (argv) => { if (!argv.includes("-frames:v")) h3Commands.push(argv); writeFileSync(argv.at(-1)!, "MP4"); return { code: 0, stdout: "", stderr: "", aborted: false }; },
    ffmpeg: () => "/fake/ffmpeg",
  };
}
function clean(): void {
  videoGen.useDeps(null);
  __resetJobsForTests(); __resetGovernorForTests(); __resetProvenanceForTests(); __resetMemoryStateForTests();
  rmSync(join(dataDir, "video"), { recursive: true, force: true });
  rmSync(join(dataDir, "tmp", "video"), { recursive: true, force: true });
}
beforeEach(() => {
  workerRequests.length = 0; h3Commands.length = 0;
  h3Root = mkdtempSync(join(tmpdir(), "caps-h3-"));
  mkdirSync(join(h3Root, "models/minimax_h3"), { recursive: true });
  clean();
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 90 * GB, tier: "p128" });
  registerVideoJobs();
  videoGen.useDeps(scripted());
});
afterEach(() => { clean(); rmSync(h3Root, { recursive: true, force: true }); });

const post = (body: Record<string, unknown>) => app.request("/v1/videos/generations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
type Err = { code: string; error: string };

const allRows = (): Array<{ engine: VideoEngine; row: StackOperationRow }> => VIDEO_ENGINES.flatMap((engine) => rowsOfEngine(engine).map((row) => ({ engine, row })));
const availableGenerate = () => allRows().filter(({ row }) => row.available && GENERATE.includes(row.operation));
/** The inputs a row takes, all given: the request that row exists for. */
const baseInputs = (row: StackOperationRow): VideoInputs => ({ start_picture: row.inputs.start_picture, end_picture: row.inputs.end_picture, references: row.inputs.references, sheets: row.inputs.sheets, source_clip: row.inputs.source_clip });
const size0 = (row: StackOperationRow) => ({ width: row.sizes[0]!.width, height: row.sizes[0]!.height });

// ---- the facts this slice settles ----

test("the settled facts: H3 takes first and last pictures at 4 to 5 s in both orientations, Max and LTX have tall sizes, nothing is wired that is not", () => {
  const find = (engine: VideoEngine, operation: string, level: string) => rowsOfEngine(engine).find((row) => row.operation === operation && row.level === level);
  expect(VIDEO_SPECS.h3.imageToVideo).toBe(true);
  expect(VIDEO_SPECS.h3.endImage).toBe(true);
  expect(VIDEO_SPECS.h3stream).toMatchObject({ imageToVideo: true, endImage: true });
  for (const operation of GENERATE) {
    const row = find("h3", operation, "standard")!;
    expect(row, operation).toBeDefined();
    expect(row.available, operation).toBe(true);
    expect(row.seconds).toEqual({ min: 4, max: 5 });
    expect(row.sizes.map((s) => `${s.width}x${s.height}:${s.orientation}`)).toEqual(["864x480:landscape", "480x864:portrait"]);
  }
  expect(find("h3", "clip_start_end_pictures", "standard")!.inputs).toMatchObject({ start_picture: true, end_picture: true });
  expect(find("ltx25max", "clip_text", "max")!.sizes).toContainEqual({ width: 576, height: 1024, orientation: "portrait" });
  expect(find("ltx25", "clip_text", "standard")!.sizes).toContainEqual({ width: 256, height: 512, orientation: "portrait" });
  expect(find("ltx25", "clip_text", "boost")!.sizes).toContainEqual({ width: 448, height: 768, orientation: "portrait" });
  expect(find("ltx25", "clip_text", "boost")!.seconds.max).toBe(5);
  expect(find("ltx25", "clip_text", "standard")!.seconds.max).toBe(10);
  // Only the Max pack extends and retakes; both keep the source's sound.
  for (const { engine, row } of allRows().filter(({ row }) => row.operation === "extend" || row.operation === "retake")) {
    expect(engine).toBe("ltx25max");
    expect(row).toMatchObject({ level: "max", available: true, inputs: { source_clip: true }, sound: { keeps_source_audio: true } });
  }
  expect(find("ltx25max", "extend", "max")!.seconds.max).toBe(LTX25_EDIT_EXTEND_MAX_SECONDS);
  expect(find("ltx25max", "retake", "max")!.seconds.max).toBe(LTX25_EDIT_RETAKE_MAX_SECONDS);
  // Not wired through the generic door, or nothing installed does it: present, but never available, with a plain reason.
  const sheet = find("ltx25max", "clip_sheet", "standard")!;
  expect(sheet).toMatchObject({ available: false, unavailable_reason: expect.stringContaining("Not served through the generic door yet; use the Ingredients route (POST /v1/videos/ingredients)"), inputs: { sheets: 2 }, seconds: { min: LTX25_INGREDIENTS_MIN_SECONDS, max: LTX25_INGREDIENTS_MAX_SECONDS }, sizes: [{ width: 768, height: 448, orientation: "landscape" }] });
  expect(sheet.requires.join(" ")).toContain(INGREDIENTS_ADAPTER_FILE);
  for (const { row } of allRows().filter(({ row }) => row.operation === "clip_references" || row.operation === "enhance")) {
    expect(row.available).toBe(false);
    expect(row.unavailable_reason).toBe(row.operation === "clip_references" ? "Nothing installed here makes reference-picture clips yet." : row.unavailable_reason!);
    expect(row.unavailable_reason!.length).toBeGreaterThan(10);
  }
});

test("every row is a valid spec row, unique per engine, operation and level; sound facts follow the model", () => {
  const rows = allRows();
  expect(videoOperationRows().length).toBe(rows.length);
  const seen = new Set<string>();
  for (const { engine, row } of rows) {
    expect(StackOperationRow.safeParse(row).success, `${engine} ${row.operation} ${row.level}`).toBe(true);
    const key = `${engine}/${row.operation}/${row.level}`;
    expect(seen.has(key), key).toBe(false);
    seen.add(key);
    expect(row.available, key).toBe(row.unavailable_reason === undefined);
    expect(row.sound.voice_reference, key).toBe(false);
    expect(row.sound.keeps_source_audio, key).toBe(["extend", "retake", "swap"].includes(row.operation));
    expect(row.seconds.min, key).toBeLessThanOrEqual(row.seconds.max);
    expect(row.sizes.length, key).toBeGreaterThan(0);
    for (const s of row.sizes) expect(s.orientation).toBe(s.width > s.height ? "landscape" : s.width < s.height ? "portrait" : "square");
  }
  for (const { engine, row } of rows.filter(({ row }) => GENERATE.includes(row.operation))) expect(row.sound.generated).toBe(VIDEO_SPECS[QUALITY[engine]].audio);
  expect(rows.some(({ row }) => row.operation === "swap")).toBe(true);
});

test("a row follows VIDEO_SPECS: turning the H3 picture flags off turns the rows off and the route refuses, with the rows and the route moving together", async () => {
  const spec = VIDEO_SPECS.h3;
  const before = { image: spec.imageToVideo, end: spec.endImage };
  try {
    spec.imageToVideo = false; spec.endImage = false;
    const start = rowsOfEngine("h3").find((row) => row.operation === "clip_start_picture")!;
    expect(start.available).toBe(false);
    expect(checkVideoInputs(start, { engine: "h3", ...baseInputs(start), size: size0(start), seconds: 5 })).toMatchObject({ code: "input_not_supported", line: start.unavailable_reason });
    const refused = await post({ prompt: "x", model: MODEL.h3, image: PNG_B64, seconds: 5 });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as Err).code).toBe("reference_unsupported");
    expect(h3Commands).toEqual([]);
  } finally { spec.imageToVideo = before.image; spec.endImage = before.end; }
});

// ---- every available row: the validator, the route and the builders agree ----

test("every available generating row is accepted by the validator and the route at its sizes and its shortest and longest length, and every accepted input reaches the builder", async () => {
  const walked: string[] = [];
  for (const { engine, row } of availableGenerate()) {
    for (const size of row.sizes) for (const seconds of [row.seconds.min, row.seconds.max]) {
      const label = `${engine} ${row.operation} ${row.level} ${size.width}x${size.height} ${seconds}s`;
      walked.push(label);
      // (a) the validator
      expect(checkVideoInputs(row, { engine, ...baseInputs(row), size, seconds }), label).toBeNull();
      // (b) the route, up to and through the scripted engine
      workerRequests.length = 0; h3Commands.length = 0;
      const response = await post({ prompt: "x", model: MODEL[engine], size: `${size.width}x${size.height}`, seconds, seed: 7, timeout_ms: 20_000, ...(row.inputs.start_picture ? { image: PNG_B64 } : {}), ...(row.inputs.end_picture ? { end_image: PNG_B64 } : {}) });
      expect(response.status, label).toBe(200);
      // (c) the engine's request carries every accepted input
      if (engine === "h3") {
        const argv = h3Commands.at(-1)!;
        expect(argv.includes("--first-image"), label).toBe(row.inputs.start_picture);
        expect(argv.includes("--last-image"), label).toBe(row.inputs.end_picture);
        expect(argv[argv.indexOf("--duration") + 1], label).toBe(String(seconds));
        expect([argv[argv.indexOf("--width") + 1], argv[argv.indexOf("--height") + 1]], label).toEqual([String(size.width), String(size.height)]);
      } else {
        const request = workerRequests.at(-1)!;
        expect(typeof request.image === "string", label).toBe(row.inputs.start_picture);
        expect(typeof request.end_image === "string", label).toBe(row.inputs.end_picture);
        expect([request.width, request.height, request.num_frames], label).toEqual([size.width, size.height, seconds * 24 + 1]);
      }
    }
  }
  expect(walked.length).toBeGreaterThan(30);
}, 120_000);

test("the builders themselves carry first and last pictures for every row that takes them (no route, no engine)", () => {
  for (const { engine, row } of availableGenerate()) {
    const size = size0(row);
    const label = `${engine} ${row.operation} ${row.level}`;
    if (engine === "h3") {
      const argv = h3VideoCommand("py", "gen.py", { prompt: "x", build: "boost-8bit", checkpoint: "c", transformer: "t", qwenDir: "q", output: "o.mp4", seconds: row.seconds.max, width: size.width, height: size.height, seed: 1, steps: 7, ...(row.inputs.start_picture ? { firstImage: "/first.png" } : {}), ...(row.inputs.end_picture ? { lastImage: "/last.png" } : {}) });
      expect(argv.includes("--first-image"), label).toBe(row.inputs.start_picture);
      expect(argv.includes("--last-image"), label).toBe(row.inputs.end_picture);
    } else {
      const request = buildWorkerRequest(QUALITY[engine], { modelDir: "/m", tokenizerDir: "/t", textEncoderDir: "/t" }, { prompt: "x", negativePrompt: null, imagePath: row.inputs.start_picture ? "/first.png" : null, ...(row.inputs.end_picture ? { endImagePath: "/last.png" } : {}), width: size.width, height: size.height, frames: row.seconds.max * 24 + 1, seed: 1, loras: [], outputDir: "/o", quality: QUALITY[engine] }, "job", "/o/video.mp4", "/o/poster.jpg");
      expect(request.image, label).toBe(row.inputs.start_picture ? "/first.png" : null);
      expect(request.end_image ?? null, label).toBe(row.inputs.end_picture ? "/last.png" : null);
    }
  }
});

test("for every row, each input the row does not take is refused with a typed refusal that names the control", () => {
  const controls: Array<[keyof VideoInputs, VideoInputs, string]> = [
    ["start_picture", { start_picture: true }, "start picture"], ["end_picture", { end_picture: true }, "end picture"],
    ["references", { references: 1 }, "reference pictures"], ["sheets", { sheets: 1 }, "sheet"], ["source_clip", { source_clip: true }, "clip"],
  ];
  let refusals = 0;
  for (const { engine, row } of allRows().filter(({ row }) => row.available)) {
    const accepts: Record<string, boolean> = { start_picture: row.inputs.start_picture, end_picture: row.inputs.end_picture, references: row.inputs.references > 0, sheets: row.inputs.sheets > 0, source_clip: row.inputs.source_clip };
    for (const [name, extra, words] of controls) {
      if (accepts[name]) continue;
      const refusal = checkVideoInputs(row, { engine, ...baseInputs(row), ...extra, size: size0(row), seconds: row.seconds.min });
      const label = `${engine} ${row.operation} ${row.level} +${name}`;
      expect(refusal, label).not.toBeNull();
      expect(refusal!.code, label).toBe("input_not_supported");
      expect(refusal!.line.toLowerCase(), label).toContain(words);
      refusals += 1;
    }
  }
  expect(refusals).toBeGreaterThan(40);
});

test("an input the model cannot take is refused in plain words that name the model and say what to do instead", () => {
  const text = rowsOfEngine("h3").find((row) => row.operation === "clip_text")!;
  expect(checkVideoInputs(text, { engine: "h3", references: 2, size: size0(text), seconds: 5 })).toEqual({ code: "input_not_supported", line: "MiniMax H3 cannot start a clip from reference pictures. Use a start picture, or pick a model that takes references." });
  const start = rowsOfEngine("h3").find((row) => row.operation === "clip_start_picture")!;
  expect(checkVideoInputs(start, { engine: "h3", start_picture: true, references: 1, size: size0(start), seconds: 5 })).toEqual({ code: "input_not_supported", line: "This model cannot use a start picture and reference pictures together yet. Send one or the other." });
});

test("an unavailable row refuses any request with its own reason, and an installed-check names what to install", () => {
  const unavailable = allRows().filter(({ row }) => !row.available);
  expect(unavailable.length).toBeGreaterThan(5);
  for (const { engine, row } of unavailable) {
    const refusal = checkVideoInputs(row, { engine, ...baseInputs(row), size: size0(row), seconds: row.seconds.min });
    expect(refusal, `${engine} ${row.operation}`).toEqual({ code: "input_not_supported", line: row.unavailable_reason! });
  }
  const max = rowsOfEngine("ltx25max").find((row) => row.operation === "clip_text")!;
  const gone = checkVideoInputs(max, { engine: "ltx25max", size: size0(max), seconds: 5, installed: () => false });
  expect(gone).toMatchObject({ code: "not_installed", missing: max.requires });
  expect(gone!.line).toContain(max.requires[0]!);
  expect(gone!.line).toContain("Settings");
  expect(checkVideoInputs(max, { engine: "ltx25max", size: size0(max), seconds: 5, installed: () => true })).toBeNull();
});

test("a size or a length outside a row is refused as bad_size or bad_seconds, over and under", async () => {
  for (const { engine, row } of availableGenerate()) {
    const label = `${engine} ${row.operation} ${row.level}`;
    expect(checkVideoInputs(row, { engine, ...baseInputs(row), size: { width: 100, height: 100 }, seconds: row.seconds.min })?.code, label).toBe("bad_size");
    const over = checkVideoInputs(row, { engine, ...baseInputs(row), size: size0(row), seconds: row.seconds.max + 1 });
    expect(over?.code, label).toBe("bad_seconds");
    expect(over!.line.length, label).toBeGreaterThan(20);
    if (row.seconds.min > 1) expect(checkVideoInputs(row, { engine, ...baseInputs(row), size: size0(row), seconds: row.seconds.min - 1 })?.code, label).toBe("bad_seconds");
  }
  // And the route says the same where the request schema lets the number through (up to 10 seconds).
  for (const { engine, row } of availableGenerate().filter(({ row }) => row.operation === "clip_text" && row.seconds.max < 10)) {
    const response = await post({ prompt: "x", model: MODEL[engine], size: `${row.sizes[0]!.width}x${row.sizes[0]!.height}`, seconds: row.seconds.max + 1 });
    expect([response.status, ((await response.json()) as Err).code], `${engine} ${row.level}`).toEqual([422, "bad_seconds"]);
  }
  expect(workerRequests).toEqual([]);
  expect(h3Commands).toEqual([]);
});

test("H3 refuses 3 s and 6 s with bad_seconds and a plain line, and never lifts or clamps them; 4 s and 5 s run", async () => {
  for (const seconds of [1, 3, 6, 10]) {
    const response = await post({ prompt: "x", model: MODEL.h3, seconds, timeout_ms: 5000 });
    const body = await response.json() as Err;
    expect([response.status, body.code], `${seconds}s`).toEqual([422, "bad_seconds"]);
    expect(body.error).toContain("4 to 5 seconds");
    expect(body.error).toContain("Choose");
  }
  expect(h3Commands).toEqual([]);
  for (const seconds of [4, 5]) {
    expect((await post({ prompt: "x", model: MODEL.h3, seconds, timeout_ms: 20_000 })).status, `${seconds}s`).toBe(200);
    expect(h3Commands.at(-1)![h3Commands.at(-1)!.indexOf("--duration") + 1]).toBe(String(seconds));
  }
  // No seconds at all means the default 5, not a clamp of something else.
  expect((await post({ prompt: "x", model: MODEL.h3, timeout_ms: 20_000 })).status).toBe(200);
  expect(h3Commands.at(-1)![h3Commands.at(-1)!.indexOf("--duration") + 1]).toBe("5");
});

test("H3 takes only its two sizes, and edits, extends and retakes are refused by name with 422 reference_unsupported", async () => {
  expect((await post({ prompt: "x", model: MODEL.h3, size: "480x864", timeout_ms: 20_000 })).status).toBe(200);
  expect(h3Commands.length).toBe(1);
  h3Commands.length = 0;
  const wrong = await post({ prompt: "x", model: MODEL.h3, size: "832x480" });
  expect([wrong.status, ((await wrong.json()) as Err).code]).toEqual([422, "bad_size"]);
  expect(((await (await post({ prompt: "x", model: MODEL.h3, size: "832x480" })).json()) as Err).error).toBe("MiniMax H3 makes 864x480 (wide) or 480x864 (tall) clips. Choose one of those.");
  for (const extra of [{ source_video: "/tmp/a.mp4", extend_seconds: 2 }, { source_video: "/tmp/a.mp4", retake_from_seconds: 2 }]) {
    const response = await post({ prompt: "x", model: MODEL.h3, ...extra });
    const body = await response.json() as Err;
    expect([response.status, body.code]).toEqual([422, "reference_unsupported"]);
    expect(body.error).toContain("MiniMax H3");
  }
  const end = await post({ prompt: "x", model: MODEL.h3, end_image: PNG_B64 });
  expect([end.status, ((await end.json()) as Err).code]).toEqual([422, "bad_image"]);
  expect(h3Commands).toEqual([]);
});

// ---- the pack JSON is the rows' derivation ----

test("every pack's clip jobs carry exactly the limits and capabilities derived from the rows", () => {
  let checked = 0;
  for (const loaded of packs()) {
    const engine = engineOfPart(loaded.pack.part);
    for (const job of loaded.pack.jobs.filter((j) => j.job === "clip" || j.job === "clip_from_sheet")) {
      const label = `${loaded.pack.part} ${job.job}`;
      expect(engine, label).not.toBeNull();
      const rows = rowsForJob(loaded.pack.part, job.job);
      expect(rows.length, label).toBeGreaterThan(0);
      const limits = jobLimitsFromRows(rows);
      expect(job.limits.max_seconds, label).toEqual(limits.max_seconds);
      expect(job.limits.shapes, label).toEqual(limits.shapes);
      const caps = jobCapabilitiesFromRows(rows);
      expect(job.capabilities.end_picture, label).toBe(caps.end_picture);
      expect(job.capabilities.sound, label).toBe(caps.sound);
      checked += 1;
    }
  }
  expect(checked).toBe(4);
  for (const engine of VIDEO_ENGINES) expect(packs().some((p) => p.pack.part === partOfEngine(engine)), engine).toBe(true);
});

test("the pack's swap limits are what the swap rows say, and the Ingredients and edit rows read the constants the routes enforce", () => {
  const pack = packs().find((p) => p.pack.part === partOfEngine("h3"))!.pack.jobs.find((j) => j.job === "swap")!;
  const rows = rowsForJob(partOfEngine("h3"), "swap");
  expect(rows.map((r) => r.level)).toEqual(["standard", "boost"]);
  expect(SWAP_WINDOW_MIN_SECONDS).toBe(SWAP_MIN_SECONDS);
  for (const row of rows) {
    expect(row.seconds.max).toBe(pack.limits.max_seconds![row.level as "standard" | "boost"]!);
    expect(row.inputs).toEqual({ start_picture: false, end_picture: false, references: pack.limits.max_references!, sheets: 0, source_clip: true });
    expect(row.sound.generated).toBe(pack.capabilities.sound);
    for (const s of row.sizes) expect((pack.limits.shapes![s.orientation as "landscape" | "portrait"] as Record<string, { width: number; height: number }>)[row.level]).toEqual({ width: s.width, height: s.height });
  }
});

// ---- discovery ----

const ready = (id: string, over: Partial<StackPartView> = {}): StackPartView => { const d = PART_DEFS.find((p) => p.id === id)!; return { id, kind: d.kind, category: d.category, priority: d.priority, label: d.label, description: "", enabled: true, state: "ready", size_bytes: 1, download_bytes: 1, percent: null, fits: { standard: true, boost: true, max: true, reason: null }, can_install: false, install_block: null, can_uninstall: true, uninstall_block: null, licence_needed: false, required_by: [], update: { available: false, version: null }, ...over } as StackPartView; };

test("catalog operations: available is the row AND a ready part AND the level fitting; a missing part says how to add it; a row that is off keeps its own reason", () => {
  const part = partOfEngine("ltx25");
  const rows = rowsForJob(part, "clip");
  const ok = catalogOperations(rows, ready(part), { editSupported: true, audience: "adult" });
  expect(ok.length).toBe(rows.length);
  for (const [i, row] of ok.entries()) {
    expect(row.available, row.operation).toBe(rows[i]!.available);
    if (!row.available) expect(row.unavailable_reason).toBe(rows[i]!.unavailable_reason);
  }
  const noBoost = catalogOperations(rows, ready(part, { fits: { standard: true, boost: false, max: false, reason: "tight" } }), { editSupported: true, audience: "adult" });
  expect(noBoost.find((r) => r.operation === "clip_text" && r.level === "standard")!.available).toBe(true);
  const boost = noBoost.find((r) => r.operation === "clip_text" && r.level === "boost")!;
  expect(boost.available).toBe(false);
  expect(boost.unavailable_reason!.length).toBeGreaterThan(20);
  for (const state of ["missing", "failed", "installing"] as const) {
    const gone = catalogOperations(rows, ready(part, { state }), { editSupported: true, audience: "adult" });
    expect(gone.find((r) => r.operation === "clip_text")).toMatchObject({ available: false, unavailable_reason: "Not installed. An admin can add it in Settings, AI and models." });
    expect(gone.find((r) => r.operation === "enhance")!.unavailable_reason).toBe(rows.find((r) => r.operation === "enhance" && r.level === "standard")!.unavailable_reason);
  }
  expect(catalogOperations(rows, null, { editSupported: true, audience: "adult" }).every((r) => !r.available && r.unavailable_reason!.length > 0)).toBe(true);
  // A minor's catalog carries no reason (rule C10).
  expect(catalogOperations(rows, null, { editSupported: true, audience: "minor" }).some((r) => "unavailable_reason" in r)).toBe(false);
  // Extend and retake also need the installed Max runtime to have the edit pipelines.
  const max = partOfEngine("ltx25max");
  const maxRows = rowsForJob(max, "clip");
  expect(catalogOperations(maxRows, ready(max), { editSupported: true, audience: "adult" }).find((r) => r.operation === "extend")!.available).toBe(true);
  const noEdit = catalogOperations(maxRows, ready(max), { editSupported: false, audience: "adult" }).find((r) => r.operation === "retake")!;
  expect(noEdit.available).toBe(false);
  expect(noEdit.unavailable_reason).toContain("cannot extend or retake");
  // The sheet job is never available through the generic door, even with the part ready.
  const sheet = catalogOperations(rowsForJob(max, "clip_from_sheet"), ready(max), { editSupported: true, audience: "adult" });
  expect(sheet.length).toBeGreaterThan(0);
  for (const row of sheet) expect(row).toMatchObject({ operation: "clip_sheet", available: false, unavailable_reason: expect.stringContaining("Ingredients route") });
});

test("the clip entry of the catalog carries operations that parse with the spec, and so do the sheet and swap entries", async () => {
  __resetPartChoicesForTests();
  const hw: HardwareInfo = { platform: "darwin", arch: "arm64", totalRamGb: 128, cpuCount: 16, isAppleSilicon: true, unifiedMemoryGb: 128, cudaDevices: [], freeDiskBytes: 1500 * GB, osVersion: "test" };
  __setPartsHardwareForTests(hw);
  try {
    const response = await app.request("/stack/v1/jobs/catalog?audience=adult");
    expect(response.status).toBe(200);
    const parsed = StackJobsCatalog.parse(await response.json());
    const catalog = await jobsCatalog("adult");
    expect(parsed.audience).toBe("adult");
    const entries = Object.fromEntries(catalog.jobs.map((j) => [j.job, j as unknown as { operations?: StackOperationRow[]; limits: Record<string, unknown>; capabilities: Record<string, unknown> }]));
    for (const job of ["clip", "clip_from_sheet", "swap"]) {
      expect(entries[job]!.operations?.length, job).toBeGreaterThan(0);
      for (const row of entries[job]!.operations!) expect(StackOperationRow.safeParse(row).success, `${job} ${row.operation}`).toBe(true);
    }
    // Nothing is installed in the test data: every row says so or says its own reason, and none is available.
    for (const row of entries.clip!.operations!) { expect(row.available).toBe(false); expect(row.unavailable_reason!.length).toBeGreaterThan(10); }
    expect(entries.clip!.operations!.map((r) => r.operation)).toEqual(expect.arrayContaining(["clip_text", "clip_start_picture", "clip_start_end_pictures", "clip_references", "enhance"]));
    expect(entries.picture!.operations).toBeUndefined();
    // The limits and capabilities shown are the derivation from the rows, whichever part is shown.
    const shown = entries.clip!;
    expect((shown.capabilities as { end_picture: boolean }).end_picture).toBe(true);
    const minor = await jobsCatalog("minor");
    expect(minor.jobs.some((j) => j.job === "clip")).toBe(false);
  } finally { __setPartsHardwareForTests(null); __resetPartChoicesForTests(); }
});

// ---- the model listing keeps its shape ----

test("the model listing keeps every field it had: qualities.h3 and qualities.ltx25max, keys and the numbers the rows now feed", async () => {
  const body = await (await app.request("/stack/v1/video")).json() as { video: { qualities: Record<string, Record<string, unknown> & { limits: Record<string, unknown> }> } };
  const q = body.video.qualities;
  expect(Object.keys(q.h3!).sort()).toEqual(["audio", "available", "end_image", "id", "image_to_video", "install", "installed", "licence", "limits", "lora_base_model", "loras", "memory", "ready", "reference_audio", "reference_pictures", "reference_videos", "video_to_video"]);
  expect(Object.keys(q.ltx25max!).sort()).toEqual(["audio", "available", "edit", "end_image", "environment", "extend", "id", "image_to_video", "install", "installed", "licence", "limits", "lora_base_model", "loras", "memory", "negative_prompt", "profiles", "ready", "retake"]);
  expect(Object.keys(q.ltx25!).sort()).toEqual(["audio", "available", "end_image", "environment", "id", "image_to_video", "install", "installed", "licence", "limits", "lora_base_model", "loras", "memory", "negative_prompt", "profiles", "ready"]);
  expect(q.h3).toMatchObject({ audio: true, image_to_video: true, end_image: true, limits: { max_seconds: 5, fps: 24, default_size: "864x480" } });
  expect(Object.keys(q.h3!.limits).sort()).toEqual(["default_size", "fps", "max_seconds"]);
  expect(q.ltx25max!.limits).toMatchObject({ max_seconds: 10, fps: 24, default_size: "1024x576", size_step: 64, max_frames: 241 });
  expect(q.ltx25!.limits).toMatchObject({ max_seconds: 10, fps: 24, default_size: "512x256", size_step: 32, max_frames: 241 });
  expect(Object.keys(q.ltx25max!.limits).sort()).toEqual(["default_size", "fps", "max_frames", "max_pixels", "max_seconds", "min_side", "size_step"]);
});
