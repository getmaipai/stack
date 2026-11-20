// SWAP-01: the generic door's `swap` job. A swap is a COMPOSITE of the original footage, never a regeneration: the serving video pack's adapter draws only a
// donor clip for each segment, guided by the original, and the composite step (video/compositeSwap.ts) keeps every original pixel outside a tracked head mask.
// This file stages a request, picks the shape admission can run, and runs the job: erase captions, crop one face per reference, cut the clip at real scene
// changes, draw and check a donor per segment, composite, check the result, join the segments and lay the original sound back under them.
// It names no model: the pack's `adapter`, recipe, limits and peaks supply everything. The pure decisions are in swapChecks.ts.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StackMakeRequest, StackMakeResult } from "@maipai/spec/stack/ts/stack-make.js";
import type { MakePlan } from "@/lib/makePlan";
import type { PictureBytes } from "@/lib/makeDispatch";
import { fillRecipe } from "@/lib/recipe";
import { dataDir } from "@/lib/paths";
import { detectHardware, primaryBudgetBytes } from "@/lib/hardware";
import { heavyGate, PausableProcess } from "@/lib/heavyGate";
import { JobFailure, registerJobRunner, submitJob, type Job } from "@/lib/jobs";
import { admissionCaller } from "@/lib/admissionCaller";
import { defaultToolbox, type MediaToolbox } from "@/media/tools";
import { spawnRunner, type Runner } from "@/media/run";
import { analyzeClip, compositeSwap, compositeSwapEnvironmentReady, ensureCompositeSwapEnvironment, referenceCrops, type CompositeSwapReport } from "@/video/compositeSwap";
import { commitCompositeSwap, DONOR_ADAPTERS, type DonorAdapter } from "@/video/swap";
import { sha256File } from "@/video/receipt";
import {
  clipHasTooManyPeople, donorCopiedGuide, donorCopiedLine, donorCropFilter, guideFilter, guideLayout, MANY_PEOPLE_IN_CLIP_LINE, parsePsnr, parseSceneCuts,
  pickSwapShape, planSegments, referenceNames, segmentFailures, swapTuning, type GuideLayout, type Segment, type SwapShapeOffer, type SwapTuning,
} from "@/lib/swapChecks";

type Planned = Extract<MakePlan, { ok: true }>;
type SwapRequest = Extract<StackMakeRequest, { job: "swap" }>;
type Context = Parameters<typeof admissionCaller>[0];

export const SWAP_MAKE_JOB_KIND = "swap-make";
export const SWAP_CLIP_UNREADABLE_LINE = "That clip could not be found. Send a clip a job just made here, or a data: URL of it.";
export const SWAP_PICTURE_UNREADABLE_LINE = "A reference picture could not be found. Send pictures a job just made here, or data: URLs of them.";
export const SWAP_NOT_INSTALLED_LINE = "The swap model is not installed on this computer. Install it from the AI and models page, then try again.";
export const SWAP_CLIP_NOT_VIDEO_LINE = "The clip could not be read. Send an MP4 clip with a readable picture.";
export const SWAP_WINDOW_LINE = "The part of the clip you asked for does not fit inside the clip. Choose a start and a length that end before the clip does.";
export const SWAP_DEFAULT_DESCRIPTION = "A person matching the reference photos, with natural hair, facial hair and skin appearance";
export const SWAP_MIN_SECONDS = 1;

const SCENE_THRESHOLD = 0.4;
const UNEXPECTED_LINE = "The swap stopped unexpectedly. Try again with a shorter clip.";

export interface SwapDeps {
  run: Runner; toolbox: MediaToolbox;
  analyze: typeof analyzeClip; crops: typeof referenceCrops; composite: typeof compositeSwap;
  environment: { ready: () => boolean; ensure: (onPhase: (phase: string) => void, signal?: AbortSignal) => Promise<void> };
  adapters: Readonly<Record<string, DonorAdapter>>;
  budgetBytes: () => Promise<number>;
}
const defaults = (): SwapDeps => ({
  run: spawnRunner, toolbox: defaultToolbox, analyze: analyzeClip, crops: referenceCrops, composite: compositeSwap,
  environment: { ready: () => !!process.env.COMPOSITE_SWAP_PYTHON || compositeSwapEnvironmentReady(), ensure: (onPhase, signal) => ensureCompositeSwapEnvironment(onPhase, signal) },
  adapters: DONOR_ADAPTERS, budgetBytes: async () => primaryBudgetBytes(await detectHardware()),
});
let deps: SwapDeps = defaults();
/** Replaces some of the tools with fakes (merged over what is set now); null puts every real one back. */
export function useSwapDepsForTests(value: Partial<SwapDeps> | null): void { deps = value ? { ...deps, ...value } : defaults(); }

interface Staged {
  dir: string; source: string; references: string[]; description: string; recipe: string; tuning: SwapTuning; adapter: string;
  start: number; seconds: number; offer: SwapShapeOffer; sourceSize: { width: number; height: number }; fps: number;
}
const pending = new Map<string, Staged>();
export function swapStagingRoot(): string { return join(dataDir, "tmp", "video", "swap-make"); }

export interface Probe { width: number; height: number; fps: number; duration: number }
/** ffprobe's JSON for the first video stream and the container. Null when there is no readable picture. */
export function parseProbe(stdout: string): Probe | null {
  let data: { streams?: Array<{ width?: number; height?: number; avg_frame_rate?: string }>; format?: { duration?: string } };
  try { data = JSON.parse(stdout); } catch { return null; }
  const stream = data.streams?.[0];
  if (!stream?.width || !stream.height) return null;
  const [num, den] = (stream.avg_frame_rate ?? "0/1").split("/").map(Number);
  const fps = den ? (num ?? 0) / den : 0;
  const duration = Number(data.format?.duration);
  if (!Number.isFinite(fps) || fps < 1 || fps > 120 || !Number.isFinite(duration) || duration <= 0) return null;
  return { width: stream.width, height: stream.height, fps: Math.round(fps * 1000) / 1000, duration };
}

const extension = (type: string): string => (type === "image/jpeg" ? "jpg" : type === "image/webp" ? "webp" : "png");
const refuse = (line: string) => ({ status: 409, body: { code: "not_available" as const, line } });

/** Drops a staged swap that never ran (cancelled while queued): its files and its place in the table. */
export function discardStagedSwap(token: string): void {
  const staged = pending.get(token);
  pending.delete(token);
  if (staged) rmSync(staged.dir, { recursive: true, force: true });
}

/** The generic door. Stages the clip and pictures on disk, picks the largest shape that fits, and queues the job: the answer is 202 with the job to poll (`GET /stack/v1/jobs/{id}`). */
export async function dispatchSwap(request: SwapRequest, plan: Planned, read: PictureBytes, context?: Context): Promise<{ status: number; body: unknown }> {
  const { job, pack, part } = plan.serving;
  let tuning: SwapTuning;
  const recipe = pack.recipes[job.recipe] ?? "";
  try { tuning = swapTuning(recipe); } catch { return refuse("The swap recipe in this model's pack is incomplete, so the swap cannot start. Update the Stack."); }
  const adapter = job.adapter ? deps.adapters[job.adapter] : undefined;
  if (!adapter || !adapter.ready()) return refuse(SWAP_NOT_INSTALLED_LINE);

  const clip = await read(request.clip);
  if (!clip) return refuse(SWAP_CLIP_UNREADABLE_LINE);
  const pictures: Array<{ bytes: Uint8Array; type: string }> = [];
  for (const reference of request.references) {
    const got = await read(reference);
    if (!got) return refuse(SWAP_PICTURE_UNREADABLE_LINE);
    pictures.push(got);
  }

  const token = crypto.randomUUID();
  const dir = join(swapStagingRoot(), token);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fail = (line: string) => { rmSync(dir, { recursive: true, force: true }); return refuse(line); };
  try {
    const source = join(dir, "source.mp4");
    writeFileSync(source, clip.bytes, { mode: 0o600 });
    const references = pictures.map((picture, i) => { const path = join(dir, `reference-${i + 1}.${extension(picture.type)}`); writeFileSync(path, picture.bytes, { mode: 0o600 }); return path; });

    const ffprobe = await deps.toolbox.path("ffprobe", () => {});
    const probed = await deps.run([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,avg_frame_rate:format=duration", "-of", "json", source], { collectStdout: true });
    const probe = probed.code === 0 ? parseProbe(probed.stdout) : null;
    if (!probe) return fail(SWAP_CLIP_NOT_VIDEO_LINE);
    const heard = await deps.run([ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", source], { collectStdout: true });
    const hasSound = heard.code === 0 && heard.stdout.trim().length > 0;
    const start = request.start_seconds ?? 0;
    if (start + request.seconds > probe.duration + 0.05) return fail(SWAP_WINDOW_LINE);
    if (request.seconds < SWAP_MIN_SECONDS) return fail(`A swap needs at least ${SWAP_MIN_SECONDS} second of clip. Choose a longer part.`);

    const shapes = job.limits.shapes as Record<string, Record<string, { width: number; height: number } | undefined> | undefined> | undefined;
    const picked = pickSwapShape({ source: probe, asked: plan.level, shapes, peaks: job.peaks, fits: part.fits, budgetBytes: await deps.budgetBytes() });
    if (!picked.ok) return fail(picked.line);

    const staged: Staged = { dir, source, references, description: (request.description ?? "").trim() || SWAP_DEFAULT_DESCRIPTION, recipe, tuning, adapter: job.adapter!, start, seconds: Math.min(request.seconds, probe.duration - start), offer: picked.offer, sourceSize: { width: probe.width, height: probe.height }, fps: probe.fps };
    pending.set(token, staged);
    const submitted = submitJob({ caller: context ? admissionCaller(context) : "household", kind: SWAP_MAKE_JOB_KIND, role: "video", input: { token, audience: "adult", level: picked.offer.level, shape: picked.offer.shape, peakBytes: picked.offer.peakBytes } });
    if ("refused" in submitted) { pending.delete(token); return fail(submitted.reason); }

    const notes = [
      ...(picked.lowered ? [`Made at ${picked.offer.width}x${picked.offer.height} because the larger size did not fit on this computer right now.`] : []),
      "Everything outside the new head is the original footage at its own size; the original sound is kept.",
    ];
    const result: StackMakeResult = {
      id: submitted.job.id, job: "swap", state: submitted.job.state, percent: 0, status: "Getting ready", files: [], poster: null,
      made_with: { part: part.id, label: part.label, pack_version: pack.pack.version, shape: picked.offer.shape, seconds: staged.seconds, sound: hasSound, notes, receipt: submitted.job.id },
    };
    return { status: 202, body: result };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    pending.delete(token);
    return refuse(error instanceof Error && error.message ? error.message : UNEXPECTED_LINE);
  }
}

// ---- the runner -----------------------------------------------------------------------------------------------------------------------------
const cancelled = (signal: AbortSignal): void => { if (signal.aborted) throw new Error("Cancelled."); };
const VIDEO = ["-an", "-c:v", "libx264", "-pix_fmt", "yuv420p"] as const;

export interface SwapCheckSummary { segment: number; at: number; donor_psnr_db: number | null; tries: number; mouth_flicker_ratio: number | null; caption_residue: number | null; preservation_verdict: "pass" | "fail"; changed_pixels: number; persistent_blob_px: number; changed_map_path: string | null; residual_head_frames: number }

export function registerSwapMakeJobs(): void {
  registerJobRunner(SWAP_MAKE_JOB_KIND, runSwap, { generator: { role: "video", memory: (job) => { const peak = Number((job.input as { peakBytes?: number } | null)?.peakBytes ?? 0); return { requestedBytes: peak, measuredPeakBytes: peak, engine: "swap" }; } } });
}

/** The job runner, exported so a test can drive one swap with fake tools. */
export const swapRunnerForTests = (job: Job, signal: AbortSignal, update: (patch: { status?: string; percent?: number }) => void): Promise<unknown> => runSwap(job, signal, update);

async function runSwap(job: Job, signal: AbortSignal, update: (patch: { status?: string; percent?: number }) => void): Promise<unknown> {
  const token = String((job.input as { token?: string } | null)?.token ?? "");
  const staged = pending.get(token); pending.delete(token);
  if (!staged) throw new JobFailure("The request was not received. Send it again.");
  const lease = heavyGate.attach({ role: "video", jobId: job.id, worker: new PausableProcess(null) });
  const started = Date.now();
  try { return await swapSteps(job, staged, signal, update, started); }
  catch (error) {
    rmSync(staged.dir, { recursive: true, force: true });
    if (error instanceof JobFailure || signal.aborted) throw error;
    throw new JobFailure(error instanceof Error && error.message && !/\n/.test(error.message) && error.message.length < 300 ? error.message : UNEXPECTED_LINE);
  } finally { lease.detach(); }
}

async function swapSteps(job: Job, staged: Staged, signal: AbortSignal, update: (patch: { status?: string; percent?: number }) => void, started: number): Promise<unknown> {
  const { tuning, offer } = staged;
  const ffmpeg = await deps.toolbox.path("ffmpeg", (status) => update({ status }), signal);
  const ffprobe = await deps.toolbox.path("ffprobe", (status) => update({ status }), signal);
  const tools = { ffmpeg, ffprobe };
  const media = async (args: string[], what: string): Promise<string> => {
    const result = await deps.run([ffmpeg, ...args], { signal });
    cancelled(signal);
    if (result.code !== 0) throw new JobFailure(`${what} failed. Try again with a different clip.`);
    return result.stderr;
  };

  if (!deps.environment.ready()) {
    update({ status: "Setting up the swap tools (first time only)" });
    try { await deps.environment.ensure((phase) => update({ status: `Setting up the swap tools: ${phase}` }), signal); }
    catch (error) { if (signal.aborted) throw error; throw new JobFailure(`The swap tools could not be set up: ${error instanceof Error ? error.message.split("\n")[0] : "unknown error"}. Check this computer's internet connection and try again.`); }
  }
  const adapter = deps.adapters[staged.adapter];
  if (!adapter) throw new JobFailure("The swap model is not installed on this computer. Install it from the AI and models page, then try again.");

  // 1. One face per reference picture: no face, several people and too many pictures each stop here with the picture's number.
  update({ status: "Looking at the reference pictures", percent: 1 });
  const crops = await deps.crops({ references: staged.references, outDir: join(staged.dir, "crops"), ...tools, signal });
  if (!crops.ok) throw new JobFailure(crops.line);

  // 2. Cut the window at real scene changes.
  update({ status: "Looking for scene changes", percent: 3 });
  const totalFrames = Math.max(1, Math.round(staged.seconds * staged.fps));
  const showinfo = await media(["-hide_banner", "-nostats", "-ss", String(staged.start), "-t", String(staged.seconds), "-i", staged.source, "-vf", `select='gt(scene,${SCENE_THRESHOLD})',showinfo`, "-an", "-f", "null", "-"], "Looking for scene changes");
  const segments = planSegments(totalFrames, parseSceneCuts(showinfo, staged.fps, totalFrames), staged.fps, tuning.segmentFrames / tuning.fps);

  // 3. Captions, people and framing, before any model runs.
  update({ status: "Checking the clip", percent: 5 });
  const analysed = await deps.analyze({ source: staged.source, start: staged.start, seconds: staged.seconds, segments: segments.map((s): [number, number] => [staged.start + s.start, s.seconds]), ...tools, signal });
  if (!analysed.ok) throw new JobFailure(analysed.line);
  if (clipHasTooManyPeople(analysed.analysis)) throw new JobFailure(MANY_PEOPLE_IN_CLIP_LINE);
  const captionBox = analysed.analysis.caption_box;

  const prompt = fillRecipe(staged.recipe, { description: staged.description, references: referenceNames(crops.crops.length) });
  const canvas = { width: offer.width, height: offer.height };
  const outputs: string[] = []; const checks: SwapCheckSummary[] = [];
  for (const segment of segments) {
    cancelled(signal);
    const base = 5 + Math.floor((segment.index / segments.length) * 88);
    const at = staged.start + segment.start;
    const layout = guideLayout(staged.sourceSize, canvas, analysed.analysis.segments[segment.index]?.edge_contact ? tuning.canvasMargin : 0);
    const dir = join(staged.dir, `segment-${segment.index}`); mkdirSync(dir, { recursive: true });

    update({ status: `Preparing part ${segment.index + 1} of ${segments.length}`, percent: base });
    const guide = await makeGuide(media, staged, segment, layout, canvas, tuning, captionBox, dir);

    const donor = await makeDonor({ adapter, media, guide, layout, crops: crops.crops, prompt, tuning, offer, segment, at, dir, signal, update, label: `${segment.index + 1} of ${segments.length}`, base });

    update({ status: `Putting the new head into part ${segment.index + 1} of ${segments.length}`, percent: base + Math.floor(70 / segments.length) });
    const out = join(dir, "composite.mp4");
    const composite = await deps.composite({ source: staged.source, donor: donor.path, out, start: at, seconds: segment.seconds, fps: staged.fps, ...(captionBox ? { captionBox } : {}), ...tools, signal });
    cancelled(signal);
    if (!composite.ok) throw new JobFailure(composite.line);
    const failures = segmentFailures(composite.report, at);
    if (failures.length) throw new JobFailure(failures[0]!);
    outputs.push(out); checks.push(summary(segment, at, donor, composite.report));
    rmSync(join(dir, "donor-raw.mp4"), { force: true });
  }

  // 4. Join the segments (one encode, copied), lay the original sound back, make the poster, file the result.
  update({ status: "Joining the parts", percent: 94 });
  const listing = join(staged.dir, "segments.txt");
  writeFileSync(listing, outputs.map((path) => `file '${path.replaceAll("'", "'\\''")}'`).join("\n"));
  const joined = join(staged.dir, "joined.mp4");
  await media(["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listing, "-c", "copy", joined], "Joining the parts");
  const video = join(staged.dir, "video.mp4");
  await media(["-v", "error", "-y", "-i", joined, "-ss", String(staged.start), "-t", String(staged.seconds), "-i", staged.source, "-map", "0:v:0", "-map", "1:a:0?", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", video], "Putting the original sound back");
  const poster = join(staged.dir, "poster.jpg");
  await media(["-v", "error", "-y", "-i", video, "-frames:v", "1", "-q:v", "2", poster], "Making the poster");
  if (!existsSync(video) || !existsSync(poster)) throw new JobFailure("The finished clip could not be written. Try again.");
  await commitCompositeSwap({ job: job.id, width: staged.sourceSize.width, height: staged.sourceSize.height, fps: staged.fps, frames: totalFrames, seconds: staged.seconds, seed: tuning.retakeSeeds[0]!, ms: Date.now() - started, peakBytes: offer.peakBytes, description: staged.description, inputs: swapReceiptInputs(staged) }, staged.dir);
  update({ status: "done", percent: 100 });
  return { job: job.id, segments: segments.length, seconds: staged.seconds, shape: `${offer.width}x${offer.height}`, level: offer.level, caption_erased: captionBox !== null, files: [`/v1/videos/swap/${job.id}/video.mp4`], poster: `/v1/videos/swap/${job.id}/poster.jpg`, checks };
}

type Media = (args: string[], what: string) => Promise<string>;

/** VF-RECEIPT-01: the swap's inputs by role and hash: the source clip, and each reference picture as the identity. */
function swapReceiptInputs(staged: Staged): Array<{ role: "source_clip" | "identity"; sha256: string; bytes: number }> {
  const out: Array<{ role: "source_clip" | "identity"; sha256: string; bytes: number }> = [];
  try { out.push({ role: "source_clip", ...sha256File(staged.source) }); for (const reference of staged.references) out.push({ role: "identity", ...sha256File(reference) }); } catch { /* a missing input is left out of the receipt */ }
  return out;
}

/** The guide for one segment: the original footage with captions erased, fitted to the model's canvas (with room around it when the head leaves the frame), at the model's frame rate. A short piece is played forward and back until it fills one model call. */
async function makeGuide(media: Media, staged: Staged, segment: Segment, layout: GuideLayout, canvas: { width: number; height: number }, tuning: SwapTuning, captionBox: readonly number[] | null, dir: string): Promise<string> {
  const at = staged.start + segment.start;
  const modelFrames = Math.min(tuning.segmentFrames, Math.max(1, Math.round(segment.seconds * tuning.fps)));
  const piece = join(dir, segment.pingPong ? "piece.mp4" : "guide.mp4");
  await media(["-v", "error", "-y", "-ss", String(at), "-t", String(segment.seconds), "-i", staged.source, "-vf", guideFilter(layout, canvas, tuning.fps, captionBox), "-frames:v", String(modelFrames), ...VIDEO, "-crf", "14", piece], "Preparing the guide clip");
  if (!segment.pingPong) return piece;
  const reversed = join(dir, "piece-reversed.mp4");
  await media(["-v", "error", "-y", "-i", piece, "-vf", "reverse", ...VIDEO, "-crf", "14", reversed], "Preparing the guide clip");
  const repeats = Math.ceil(tuning.segmentFrames / modelFrames) + 1;
  const listing = join(dir, "pingpong.txt");
  writeFileSync(listing, Array.from({ length: repeats }, (_, i) => `file '${(i % 2 === 0 ? piece : reversed).replaceAll("'", "'\\''")}'`).join("\n"));
  const guide = join(dir, "guide.mp4");
  await media(["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listing, "-frames:v", String(tuning.segmentFrames), ...VIDEO, "-crf", "14", guide], "Preparing the guide clip");
  return guide;
}

interface Donor { path: string; psnr: number | null; tries: number }
/** Draws the donor for one segment. A donor that is within about 30 dB of its guide copied the original head, so the segment is retaken with the next seed the pack lists; when every seed copied, the job fails. */
async function makeDonor(input: { adapter: DonorAdapter; media: Media; guide: string; layout: GuideLayout; crops: string[]; prompt: string; tuning: SwapTuning; offer: SwapShapeOffer; segment: Segment; at: number; dir: string; signal: AbortSignal; update: (patch: { status?: string; percent?: number }) => void; label: string; base: number }): Promise<Donor> {
  const { tuning, dir } = input;
  const raw = join(dir, "donor-raw.mp4");
  let tries = 0; let psnr: number | null = null;
  for (const seed of tuning.retakeSeeds) {
    cancelled(input.signal);
    tries += 1;
    input.update({ status: tries === 1 ? `Drawing the new head for part ${input.label}` : `Drawing part ${input.label} again (try ${tries})`, percent: input.base + 2 });
    rmSync(raw, { force: true });
    await input.adapter.generate({ guide: input.guide, output: raw, references: input.crops, prompt: input.prompt, seed, adapterStrength: tuning.adapterStrength, width: input.offer.width, height: input.offer.height, frames: tuning.segmentFrames, signal: input.signal, onStatus: (status) => input.update({ status }) });
    cancelled(input.signal);
    psnr = parsePsnr(await input.media(["-hide_banner", "-nostats", "-i", raw, "-i", input.guide, "-lavfi", "psnr", "-f", "null", "-"], "Checking the new head"));
    if (!donorCopiedGuide(psnr)) {
      const donor = join(dir, "donor.mp4");
      const full = input.layout.content.width === input.offer.width && input.layout.content.height === input.offer.height;
      if (full) return { path: raw, psnr, tries };
      await input.media(["-v", "error", "-y", "-i", raw, "-vf", donorCropFilter(input.layout), ...VIDEO, "-crf", "10", donor], "Cutting the new head back to the clip's frame");
      return { path: donor, psnr, tries };
    }
  }
  throw new JobFailure(donorCopiedLine(input.at, tries));
}

function summary(segment: Segment, at: number, donor: Donor, report: CompositeSwapReport): SwapCheckSummary {
  return { segment: segment.index, at, donor_psnr_db: donor.psnr === null || !Number.isFinite(donor.psnr) ? null : Math.round(donor.psnr * 10) / 10, tries: donor.tries, mouth_flicker_ratio: report.flicker_ratio === null ? null : Math.round(report.flicker_ratio * 100) / 100, caption_residue: report.caption_residue ?? null, preservation_verdict: report.preservation.verdict, changed_pixels: report.preservation.changed_pixels, persistent_blob_px: report.preservation.encoded?.largest_blob_px ?? 0, changed_map_path: report.preservation.map_path, residual_head_frames: report.residual_original_head_frames.length };
}

