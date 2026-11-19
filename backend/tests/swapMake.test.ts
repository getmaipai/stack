// SWAP-01: the generic `swap` job. No model weights, no real people: the donor adapter, the composite worker, the reference-crop step and ffmpeg are fakes
// that record what they were asked and write empty files. The checks that need pixels (outside-the-head diff, caption residue) are proved on a synthetic
// clip in tests/composite_swap/test_composite.py, which compositeSwap.test.ts runs when the composite environment exists.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StackPartView } from "@maipai/spec/stack/ts/stack-part-view.js";
import type { StackMakeRequest } from "@maipai/spec/stack/ts/stack-make.js";
import { packFor } from "@/packs/loader";
import { PART_DEFS } from "@/lib/partDefs";
import { planMake } from "@/lib/makePlan";
import { WIRED_JOBS } from "@/lib/makeDispatch";
import { __resetJobsForTests, getJob, JobFailure, registerJobRunner, type Job } from "@/lib/jobs";
import { discardStagedSwap, dispatchSwap, parseProbe, swapRunnerForTests, swapStagingRoot, SWAP_NOT_INSTALLED_LINE, SWAP_WINDOW_LINE, SWAP_CLIP_UNREADABLE_LINE, useSwapDepsForTests, SWAP_MAKE_JOB_KIND } from "@/lib/makeDispatchSwap";
import {
  CAPTION_RESIDUE_LIMIT, clipHasTooManyPeople, donorCopiedGuide, donorCopiedLine, donorCropFilter, guideFilter, guideLayout, MANY_PEOPLE_IN_CLIP_LINE, MEMORY_SHORT_LINE,
  parsePsnr, parseSceneCuts, pickSwapShape, planSegments, referenceNames, segmentFailures, swapTuning,
} from "@/lib/swapChecks";
import { readResult } from "@/video/results";
import type { CompositeSwapReport } from "@/video/compositeSwap";
import type { Runner } from "@/media/run";

const GIB = 1024 ** 3;
const PART = "minimax-h3";
const swapRecipe = () => { const pack = packFor(PART)!; return pack.recipes[pack.pack.jobs.find((j) => j.job === "swap")!.recipe]!; };
const ready = (fits: Partial<StackPartView["fits"]> = {}): StackPartView => { const d = PART_DEFS.find((p) => p.id === PART)!; return { id: PART, kind: d.kind, category: d.category, priority: d.priority, label: d.label, description: "", enabled: true, state: "ready", size_bytes: 1, download_bytes: 1, percent: null, fits: { standard: true, boost: true, max: true, reason: null, ...fits }, can_install: false, install_block: null, can_uninstall: true, uninstall_block: null, licence_needed: false, required_by: [], update: { available: false, version: null } } as StackPartView; };
const request = (over: Partial<Extract<StackMakeRequest, { job: "swap" }>> = {}): Extract<StackMakeRequest, { job: "swap" }> => ({ job: "swap", audience: "adult", clip: "data:video/mp4;base64,AAAA", references: ["data:image/png;base64,AAAA"], seconds: 6, level: "boost", ...over });
const plan = (req = request(), fits: Partial<StackPartView["fits"]> = {}) => { const p = planMake(req, [ready(fits)]); if (!p.ok) throw new Error("not planned"); return p; };
const report = (over: Partial<CompositeSwapReport> = {}): CompositeSwapReport => ({ frames: 45, size: [1080, 1920], mouth_flicker_original: 2, mouth_flicker_raw: 3, mouth_flicker_filtered: 2.2, flicker_ratio: 1.1, flicker_ok: true, residual_original_head_frames: [], outside_mask_pixels_changed: 0, recoloured_leftover_skin_pixels: 0, caption_box: null, caption_residue: null, encoded_outside_changed_share: 0.0002, encoded_outside_bad_frames: [], ...over });
const noWords = (line: string) => { expect(line).not.toContain("\u2014"); expect(line.toLowerCase()).not.toMatch(/\b(memory|ram|gb|db|psnr|seed)\b/); expect(line.length).toBeGreaterThan(20); };

describe("the numbers a pack hands over", () => {
  test("the pack's swap recipe carries the numbers and its measured note is never sent", () => {
    expect(swapTuning(swapRecipe())).toEqual({ segmentFrames: 56, fps: 24, adapterStrength: 1, retakeSeeds: [42, 43, 44], canvasMargin: 0.1 });
  });
  test("the pack serves swap to adults only, with the measured shapes and peaks", () => {
    const job = packFor(PART)!.pack.jobs.find((j) => j.job === "swap")!;
    expect(job.audiences).toEqual(["adult"]); expect(job.limits.max_references).toBe(9); expect(job.adapter).toBe("guide-video-swap");
    expect(job.limits.shapes!.landscape).toEqual({ standard: { width: 384, height: 288 }, boost: { width: 512, height: 384 } });
    expect(job.peaks.find((p) => p.shape === "landscape" && p.level === "standard")).toMatchObject({ bytes: 66e9, status: "measured" });
    expect(job.peaks.find((p) => p.shape === "landscape" && p.level === "boost")).toMatchObject({ bytes: 90e9, status: "measured" });
  });
  test("a recipe that lacks a number, or has a bad one, says which and what to do", () => {
    expect(() => swapTuning("{description}")).toThrow(/lacks segment_frames, fps, adapter_strength, retake_seeds, canvas_margin/);
    expect(() => swapTuning("x\n---measured---\nsegment_frames: 56\nfps: fast\nadapter_strength: 1\nretake_seeds: 1\ncanvas_margin: 0.1")).toThrow(/"fps" is not a number/);
    expect(() => swapTuning("x\n---measured---\nsegment_frames: 56\nfps: 24\nadapter_strength: 1\nretake_seeds: 1, x\ncanvas_margin: 0.1")).toThrow(/retake_seeds/);
  });
  test("the references blank names the model's own pictures", () => { expect(referenceNames(3)).toBe("<Picture 1>, <Picture 2>, <Picture 3>"); });
  test("swap is wired through the generic door", () => { expect(WIRED_JOBS.has("swap")).toBe(true); });
});

describe("cutting the clip into segments", () => {
  test("a scene shorter than one model call is one segment played forward and back; a cut starts a new one", () => {
    const segments = planSegments(90, [45], 30, 56 / 24);
    expect(segments.map((s) => [s.startFrame, s.frames, s.pingPong])).toEqual([[0, 45, true], [45, 45, true]]);
    expect(segments[1]!.start).toBeCloseTo(1.5);
  });
  test("a long scene splits into near-equal pieces, none longer than the call, and the pieces cover the window exactly", () => {
    const segments = planSegments(300, [], 24, 56 / 24);
    expect(segments.every((s) => s.frames <= 56)).toBe(true);
    expect(segments.reduce((sum, s) => sum + s.frames, 0)).toBe(300);
    expect(segments.map((s) => s.startFrame)).toEqual(segments.map((_, i) => segments.slice(0, i).reduce((sum, s) => sum + s.frames, 0)));
    expect(segments.map((s) => s.frames)).toEqual([50, 50, 50, 50, 50, 50]);   // 300 frames over ceil(300 / 56) = 6 calls, each shorter than one call and so played forward and back
    expect(segments.every((s) => s.pingPong)).toBe(true);
  });
  test("a piece that is exactly one call is not padded", () => { expect(planSegments(56, [], 24, 56 / 24)).toEqual([{ index: 0, start: 0, seconds: 56 / 24, startFrame: 0, frames: 56, pingPong: false }]); });
  test("cuts at the ends or out of range are ignored, and repeated cuts count once", () => {
    expect(planSegments(100, [0, 100, 150, 40, 40], 24, 100)).toHaveLength(2);
  });
  test("scene cuts are read from showinfo lines and a cut at either end is dropped", () => {
    const text = "[Parsed_showinfo_1 @ 0x1] n:   0 pts:  1 pts_time:0.04 pos:1\n[Parsed_showinfo_1 @ 0x1] n:   1 pts: 2 pts_time:2.5 pos:2\n[Parsed_showinfo_1 @ 0x1] n: 2 pts: 3 pts_time:5.98 pos:3\nnoise";
    expect(parseSceneCuts(text, 24, 144)).toEqual([60]);
  });
});

describe("the guide on the model's canvas", () => {
  test("a portrait source fits a portrait canvas by height and is centered; the donor is cut back to the same rectangle", () => {
    const layout = guideLayout({ width: 1080, height: 1920 }, { width: 384, height: 512 }, 0);
    expect(layout).toEqual({ content: { x: 48, y: 0, width: 288, height: 512 }, padded: false });
    expect(donorCropFilter(layout)).toBe("crop=288:512:48:0");
  });
  test("canvas around the picture, for a head that leaves the frame, shrinks the picture and keeps every number even", () => {
    const layout = guideLayout({ width: 1080, height: 1920 }, { width: 384, height: 512 }, 0.1);
    expect(layout.padded).toBe(true);
    for (const n of [layout.content.x, layout.content.y, layout.content.width, layout.content.height]) expect(n % 2).toBe(0);
    expect(layout.content.width).toBeLessThan(288); expect(layout.content.y).toBeGreaterThan(0);
  });
  test("the guide filter erases the caption first, then resamples, fits and pads", () => {
    const layout = guideLayout({ width: 1080, height: 1920 }, { width: 384, height: 512 }, 0);
    expect(guideFilter(layout, { width: 384, height: 512 }, 24, [170, 1540, 740, 135])).toBe("delogo=x=170:y=1540:w=740:h=135,fps=24,scale=288:512:flags=lanczos,pad=384:512:48:0:black,setsar=1");
    expect(guideFilter(layout, { width: 384, height: 512 }, 24, null).startsWith("fps=24,")).toBe(true);
  });
});

describe("admission picks the largest shape that fits", () => {
  const job = packFor(PART)!.pack.jobs.find((j) => j.job === "swap")!;
  const pick = (over: Partial<Parameters<typeof pickSwapShape>[0]> = {}) => pickSwapShape({ source: { width: 1920, height: 1080 }, asked: "boost", shapes: job.limits.shapes as never, peaks: job.peaks, fits: { standard: true, boost: true, max: false }, budgetBytes: 128 * GIB, ...over });
  test("boost when it fits", () => { expect(pick()).toEqual({ ok: true, lowered: false, offer: { shape: "landscape", level: "boost", width: 512, height: 384, peakBytes: 90e9 } }); });
  test("the level asked is the ceiling: standard stays standard even when boost would fit", () => { expect(pick({ asked: "standard" })).toMatchObject({ ok: true, lowered: false, offer: { level: "standard", width: 384, height: 288 } }); });
  test("when the larger shape does not fit, the next one down runs and the answer says it was lowered", () => {
    expect(pick({ fits: { standard: true, boost: false, max: false } })).toMatchObject({ ok: true, lowered: true, offer: { level: "standard", peakBytes: 66e9 } });
    expect(pick({ budgetBytes: 80e9 })).toMatchObject({ ok: true, lowered: true, offer: { level: "standard" } });
  });
  test("a source taller than wide gets the portrait shapes", () => { expect(pick({ source: { width: 1080, height: 1920 } })).toMatchObject({ ok: true, offer: { shape: "portrait", width: 384, height: 512 } }); });
  test("when nothing fits the line says what to do and uses no memory words or figures", () => {
    const none = pick({ budgetBytes: 40e9 }); expect(none).toEqual({ ok: false, line: MEMORY_SHORT_LINE });
    expect(pick({ fits: { standard: false, boost: false, max: false } })).toEqual({ ok: false, line: MEMORY_SHORT_LINE });
    noWords(MEMORY_SHORT_LINE); expect(MEMORY_SHORT_LINE).toContain("try again");
  });
});

describe("the checks that fail a job, each with one plain line", () => {
  test("ffmpeg's picture quality reading", () => {
    expect(parsePsnr("[Parsed_psnr_0 @ 0x1] PSNR y:30.1 u:40 v:40 average:31.25 min:20 max:60")).toBe(31.25);
    expect(parsePsnr("PSNR y:inf u:inf v:inf average:inf min:inf max:inf")).toBe(Infinity);
    expect(parsePsnr("nothing here")).toBeNull();
  });
  test("a donor within about 30 dB of its guide copied the original; a lower reading, or none, passes", () => {
    expect(donorCopiedGuide(30.5)).toBe(true); expect(donorCopiedGuide(Infinity)).toBe(true); expect(donorCopiedGuide(24)).toBe(false); expect(donorCopiedGuide(null)).toBe(false);
    noWords(donorCopiedLine(65, 3)); expect(donorCopiedLine(65, 3)).toContain("1:05"); expect(donorCopiedLine(5, 1)).toContain("1 try.");
  });
  test("a clean report has no failures", () => { expect(segmentFailures(report(), 0)).toEqual([]); });
  test("pixels changed outside the head fail, before the encode and after it", () => {
    for (const bad of [report({ outside_mask_pixels_changed: 500_000 }), report({ encoded_outside_bad_frames: [3, 4] })]) {
      const lines = segmentFailures(bad, 12); expect(lines).toHaveLength(1); expect(lines[0]).toContain("outside the head"); expect(lines[0]).toContain("0:12"); noWords(lines[0]!);
    }
  });
  test("a handful of changed pixels (rounding, under 0.01 percent) is tolerated", () => { expect(segmentFailures(report({ outside_mask_pixels_changed: 100 }), 0)).toEqual([]); });
  test("the original head still showing in more than a tenth of the frames fails", () => {
    expect(segmentFailures(report({ residual_original_head_frames: [[1, 0.3], [2, 0.3]] }), 0)).toEqual([]);
    const lines = segmentFailures(report({ residual_original_head_frames: Array.from({ length: 6 }, (_, i) => [i, 0.4] as [number, number]) }), 7);
    expect(lines).toHaveLength(1); expect(lines[0]).toContain("original person's head still shows in 6 frames"); noWords(lines[0]!);
  });
  test("caption text still visible after the erase fails", () => {
    expect(segmentFailures(report({ caption_residue: CAPTION_RESIDUE_LIMIT }), 0)).toEqual([]);
    const lines = segmentFailures(report({ caption_residue: 0.9 }), 3); expect(lines).toHaveLength(1); expect(lines[0]).toContain("Burned-in text"); noWords(lines[0]!);
  });
  test("a mouth that flickers more than the original's fails", () => {
    const lines = segmentFailures(report({ flicker_ok: false, flicker_ratio: 1.9 }), 3); expect(lines).toHaveLength(1); expect(lines[0]).toContain("mouth flickers"); noWords(lines[0]!);
  });
  test("several failures are listed, the outside-the-head one first", () => {
    const lines = segmentFailures(report({ outside_mask_pixels_changed: 1e6, flicker_ok: false }), 0); expect(lines).toHaveLength(2); expect(lines[0]).toContain("outside the head");
  });
  test("too many people in the clip is a vote over frames, never one frame", () => {
    expect(clipHasTooManyPeople({ people_max: 2, many_people_share: 0.6 })).toBe(true);
    expect(clipHasTooManyPeople({ people_max: 2, many_people_share: 0.2 })).toBe(false);
    expect(clipHasTooManyPeople({ people_max: 1, many_people_share: 0 })).toBe(false);
    noWords(MANY_PEOPLE_IN_CLIP_LINE);
  });
});

// ---- the door and the runner, with fakes ----------------------------------------------------------------------------------------------------
interface Harness {
  calls: string[][]; seeds: number[]; composites: Array<{ start: number; seconds: number; captionBox?: unknown; fps?: number; donor: string }>;
  psnr: number[]; reports: CompositeSwapReport[]; cuts: number[]; probe: string; budget: number; crops: { ok: true; crops: string[] } | { ok: false; line: string; code?: string };
  analysis: { caption_box: [number, number, number, number] | null; people_max: number; many_people_share: number; edge: boolean[] }; adapterReady: boolean;
}
const probeJson = (w = 1080, h = 1920, fps = "30/1", duration = "8.0") => JSON.stringify({ streams: [{ width: w, height: h, avg_frame_rate: fps }], format: { duration } });
let h: Harness;
const install = () => {
  useSwapDepsForTests(null);
  h = { calls: [], seeds: [], composites: [], psnr: [], reports: [], cuts: [3.0], probe: probeJson(), budget: 128 * GIB, crops: { ok: true, crops: ["/crop-1.png"] }, analysis: { caption_box: [170, 1540, 740, 135], people_max: 1, many_people_share: 0, edge: [] }, adapterReady: true };
  const run: Runner = async (argv) => {
    h.calls.push(argv); const joined = argv.join(" ");
    if (argv[0] === "/fake/ffprobe") return { code: 0, stdout: h.probe, stderr: "", aborted: false };
    if (joined.includes("showinfo")) return { code: 0, stdout: "", stderr: h.cuts.map((t, i) => `[Parsed_showinfo_1 @ 0x1] n: ${i} pts: 1 pts_time:${t} pos: 1`).join("\n"), aborted: false };
    if (joined.includes("-lavfi psnr")) return { code: 0, stdout: "", stderr: `[Parsed_psnr_0 @ 0x1] PSNR y:1 u:1 v:1 average:${h.psnr.shift() ?? 20} min:1 max:2`, aborted: false };
    const last = argv[argv.length - 1]!; if (last !== "-" && /\.(mp4|jpg)$/.test(last)) writeFileSync(last, "x");
    return { code: 0, stdout: "", stderr: "", aborted: false };
  };
  useSwapDepsForTests({
    run, toolbox: { installed: () => true, path: async (tool) => `/fake/${tool}` },
    environment: { ready: () => true, ensure: async () => {} },
    adapters: { "guide-video-swap": { ready: () => h.adapterReady, generate: async (r) => { h.seeds.push(r.seed); writeFileSync(r.output, "x"); } } },
    budgetBytes: async () => h.budget,
    crops: async () => h.crops,
    analyze: async (input) => ({ ok: true, analysis: { caption_box: h.analysis.caption_box, size: [1080, 1920], people_max: h.analysis.people_max, many_people_share: h.analysis.many_people_share, segments: input.segments.map((_, i) => ({ edge_contact: h.analysis.edge[i] ?? false })) } }),
    composite: async (input) => { h.composites.push({ start: input.start ?? 0, seconds: input.seconds ?? 0, captionBox: input.captionBox, ...(input.fps !== undefined ? { fps: input.fps } : {}), donor: input.donor }); writeFileSync(input.out, "x"); return { ok: true, report: h.reports.shift() ?? report() }; },
  });
};
const read = async (reference: string) => (reference.startsWith("data:") ? { bytes: new Uint8Array([1, 2, 3]), type: reference.includes("image") ? "image/png" : "video/mp4" } : null);
const stagedDirs = () => (existsSync(swapStagingRoot()) ? readdirSync(swapStagingRoot()) : []);
/** The door with the queue replaced by one that never runs the job, so the runner can be driven by hand. */
const door = async (req = request(), fits: Partial<StackPartView["fits"]> = {}) => {
  registerJobRunner(SWAP_MAKE_JOB_KIND, async () => ({}));
  return dispatchSwap(req, plan(req, fits), read);
};
const runStaged = async (req = request()) => {
  const sent = await door(req); expect(sent.status).toBe(202);
  const id = (sent.body as { id: string }).id; const job = getJob(id)!;
  const updates: Array<{ status?: string; percent?: number }> = [];
  const runId = `job-${crypto.randomUUID()}`;
  return { id, job, updates, runId, run: () => swapRunnerForTests({ ...job, id: runId } as Job, new AbortController().signal, (u) => updates.push(u)) };
};

beforeEach(() => { __resetJobsForTests(); install(); });
afterEach(() => { useSwapDepsForTests(null); __resetJobsForTests(); for (const token of stagedDirs()) discardStagedSwap(token); });

describe("the door", () => {
  test("a good request is queued with 202, the job to poll, the shape that runs and a plain note", async () => {
    const sent = await door(request({ start_seconds: 1, seconds: 6 }));
    expect(sent.status).toBe(202);
    const body = sent.body as { id: string; job: string; state: string; files: string[]; made_with: { shape: string; seconds: number; notes: string[]; part: string } };
    expect(body).toMatchObject({ job: "swap", files: [], made_with: { part: PART, shape: "portrait", seconds: 6 } });
    expect(body.made_with.notes.join(" ")).toContain("original footage"); expect(getJob(body.id)?.kind).toBe(SWAP_MAKE_JOB_KIND);
    expect(stagedDirs()).toHaveLength(1);
  });
  test("the job declares the peak of the shape that fits, and a lowered shape is said so", async () => {
    const sent = await door(request(), { boost: false });
    const body = sent.body as { id: string; made_with: { notes: string[] } };
    expect((getJob(body.id)!.input as { peakBytes: number; level: string })).toMatchObject({ peakBytes: 66e9, level: "standard" });
    expect(body.made_with.notes[0]).toContain("288x384"); noWords(body.made_with.notes[0]!);
  });
  test("no room for any shape: one plain line, nothing staged", async () => {
    h.budget = 30 * GIB;
    expect(await door()).toEqual({ status: 409, body: { code: "not_available", line: MEMORY_SHORT_LINE } });
    expect(stagedDirs()).toEqual([]);
  });
  test("a model that is not installed says so and what to do", async () => {
    h.adapterReady = false; const sent = await door();
    expect(sent).toEqual({ status: 409, body: { code: "not_available", line: SWAP_NOT_INSTALLED_LINE } }); noWords(SWAP_NOT_INSTALLED_LINE);
  });
  test("a clip or a picture the Stack cannot find is refused with a line", async () => {
    expect(await door(request({ clip: "/nope" }))).toEqual({ status: 409, body: { code: "not_available", line: SWAP_CLIP_UNREADABLE_LINE } });
    expect((await door(request({ references: ["/nope"] }))).status).toBe(409);
    expect(stagedDirs()).toEqual([]);
  });
  test("a window that runs past the end of the clip, or a clip with no picture, is refused and nothing is left behind", async () => {
    expect(await door(request({ start_seconds: 5, seconds: 6 }))).toEqual({ status: 409, body: { code: "not_available", line: SWAP_WINDOW_LINE } });
    h.probe = "not json"; expect((await door()).status).toBe(409);
    expect(stagedDirs()).toEqual([]);
  });
  test("probe reading: a frame rate and a duration are required", () => {
    expect(parseProbe(probeJson(640, 360, "30000/1001", "2.5"))).toEqual({ width: 640, height: 360, fps: 29.97, duration: 2.5 });
    expect(parseProbe(probeJson(640, 360, "0/0"))).toBeNull(); expect(parseProbe(JSON.stringify({ streams: [] }))).toBeNull();
  });
  test("the planner refuses more than nine references and a minor, before anything runs", () => {
    const refs = Array.from({ length: 10 }, () => "data:image/png;base64,AAAA");
    expect(planMake(request({ references: refs }), [ready()])).toMatchObject({ ok: false, refusal: { code: "too_many_references", limit: 9 } });
    expect(planMake(request({ audience: "minor" }), [ready()])).toMatchObject({ ok: false });
    expect(planMake(request({ seconds: 31 }), [ready()])).toMatchObject({ ok: false, refusal: { code: "too_long", limit: 30 } });
  });
  test("a cancelled, never-run swap is discarded with its files", async () => {
    const sent = await door(); const token = (getJob((sent.body as { id: string }).id)!.input as { token: string }).token;
    expect(stagedDirs()).toEqual([token]); discardStagedSwap(token); expect(stagedDirs()).toEqual([]);
  });
});

describe("the runner", () => {
  test("a clip with one cut becomes four composites at the source frame rate, filed as one clip with the original sound", async () => {
    const staged = await runStaged(request({ seconds: 6 }));
    h.analysis.edge = [true, false, false, false];
    const result = await staged.run() as { segments: number; checks: unknown[]; caption_erased: boolean; files: string[] };
    expect(result.segments).toBe(4); expect(result.checks).toHaveLength(4); expect(result.caption_erased).toBe(true);
    expect(h.composites.map((c) => [c.start, c.seconds, c.fps])).toEqual([[0, 1.5, 30], [1.5, 1.5, 30], [3, 1.5, 30], [4.5, 1.5, 30]]);
    expect(h.composites.every((c) => c.captionBox !== undefined)).toBe(true);
    expect(h.seeds).toEqual([42, 42, 42, 42]);
    const flat = h.calls.map((c) => c.join(" "));
    expect(flat.filter((c) => c.includes("delogo=x=170:y=1540:w=740:h=135"))).toHaveLength(4);                  // the caption is erased before any donor is drawn
    expect(flat.find((c) => c.includes("pad=384:512:76:50:black"))).toBeDefined();                              // the first segment's head leaves the frame: canvas around it
    expect(flat.find((c) => c.includes("pad=384:512:48:0:black"))).toBeDefined();
    expect(flat.filter((c) => c.includes("crop=")).length).toBe(4);                                              // the donor is cut back to the clip's frame
    expect(flat.filter((c) => c.includes("-vf reverse"))).toHaveLength(4);                                       // each 45-frame piece is played forward and back to fill one call
    expect(flat.some((c) => c.includes("-f concat") && c.includes("-c copy"))).toBe(true);
    expect(flat.some((c) => c.includes("-map 1:a:0?") && c.includes("-c:v copy"))).toBe(true);                   // original sound, picture not re-encoded
    expect(flat.filter((c) => c.includes("joined.mp4") || c.includes("video.mp4")).some((c) => c.includes("-vf") || c.includes("scale"))).toBe(false);   // nothing filters or scales the finished clip: the original size stays
    expect(readResult(staged.runId)).toMatchObject({ width: 1080, height: 1920, fps: 30, seconds: 6 });
    expect(staged.updates.at(-1)).toEqual({ status: "done", percent: 100 });
    expect(stagedDirs()).toEqual([]);                                                                            // the work folder moved into the result store
  });
  test("a donor that copied its guide is retaken with the next seed the pack lists", async () => {
    h.cuts = []; h.psnr = [35, 28];
    const staged = await runStaged(request({ seconds: 2 }));
    const result = await staged.run() as { checks: Array<{ tries: number; donor_psnr_db: number }> };
    expect(h.seeds).toEqual([42, 43]); expect(result.checks[0]).toMatchObject({ tries: 2, donor_psnr_db: 28 });
  });
  test("when every seed copied the guide the job fails with one plain line and nothing is filed", async () => {
    h.cuts = []; h.psnr = [35, 36, 40];
    const staged = await runStaged(request({ seconds: 2 }));
    const failure = await staged.run().catch((e) => e) as JobFailure;
    expect(failure).toBeInstanceOf(JobFailure); expect(failure.message).toBe(donorCopiedLine(0, 3)); expect(h.seeds).toEqual([42, 43, 44]); expect(h.composites).toHaveLength(0);
    expect(stagedDirs()).toEqual([]);
  });
  test("pixels changed outside the head fail the job at the first segment, before more model time is spent", async () => {
    h.cuts = [3];
    h.reports = [report({ outside_mask_pixels_changed: 250_000 })];
    const staged = await runStaged(request({ seconds: 6 }));
    const failure = await staged.run().catch((e) => e) as JobFailure;
    expect(failure.message).toContain("outside the head"); expect(h.composites).toHaveLength(1); expect(h.seeds).toHaveLength(1);
  });
  test("caption residue, a residual original head and mouth flicker each fail the job with their own line", async () => {
    for (const [bad, text] of [[report({ caption_residue: 0.8 }), "Burned-in text"], [report({ residual_original_head_frames: Array.from({ length: 20 }, (_, i) => [i, 0.5] as [number, number]) }), "original person's head"], [report({ flicker_ok: false }), "mouth flickers"]] as const) {
      h.reports = [bad]; h.cuts = [];
      const failure = await (await runStaged(request({ seconds: 2 }))).run().catch((e) => e) as JobFailure;
      expect(failure.message).toContain(text); noWords(failure.message);
    }
  });
  test("more than one person in view, and a reference with no face, stop the job before any model runs", async () => {
    h.analysis.people_max = 3; h.analysis.many_people_share = 0.8;
    expect((await (await runStaged()).run().catch((e) => e) as JobFailure).message).toBe(MANY_PEOPLE_IN_CLIP_LINE);
    h.analysis.people_max = 1; h.analysis.many_people_share = 0;
    h.crops = { ok: false, line: "No face was found in reference picture 2. Use a clear picture of one person looking toward the camera.", code: "no_face" };
    const failure = await (await runStaged()).run().catch((e) => e) as JobFailure;
    expect(failure.message).toContain("reference picture 2"); expect(h.seeds).toEqual([]);
  });
  test("the reference pictures are cropped to one face each and the recipe is filled with the model's own picture names", async () => {
    h.cuts = []; h.crops = { ok: true, crops: ["/c1.png", "/c2.png"] };
    const captured: string[] = [];
    useSwapDepsForTests({ adapters: { "guide-video-swap": { ready: () => true, generate: async (r) => { captured.push(r.prompt, r.references.join(","), String(r.adapterStrength), `${r.width}x${r.height}x${r.frames}`); writeFileSync(r.output, "x"); } } } });
    await (await runStaged(request({ seconds: 2, description: "grey hair" }))).run();
    expect(captured[0]).toContain("<Picture 1>, <Picture 2>"); expect(captured[0]).toContain("grey hair"); expect(captured[0]).not.toContain("{references}"); expect(captured[0]).not.toContain("segment_frames");
    expect(captured.slice(1)).toEqual(["/c1.png,/c2.png", "1", "384x512x56"]);
  });
  test("a job whose request was lost says so plainly", async () => {
    const failure = await swapRunnerForTests({ id: `job-${crypto.randomUUID()}`, kind: SWAP_MAKE_JOB_KIND, input: { token: "gone" } } as unknown as Job, new AbortController().signal, () => {}).catch((e) => e) as JobFailure;
    expect(failure.message).toBe("The request was not received. Send it again.");
  });
  test("a cancelled swap stops between steps and leaves no work folder", async () => {
    const staged = await runStaged(); const controller = new AbortController(); controller.abort();
    await expect(swapRunnerForTests({ ...staged.job, id: `job-${crypto.randomUUID()}` } as Job, controller.signal, () => {})).rejects.toThrow("Cancelled.");
    expect(stagedDirs()).toEqual([]);
  });
});
