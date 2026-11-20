// SWAP-01: the pure parts of the swap job. A swap is a composite of the original footage and never a regeneration: the model draws only a donor clip,
// and the composite step puts donor pixels inside a tracked head mask. This file holds what can be decided without a model or a file: the numbers a
// pack hands over, how a clip is cut into segments, how a guide is laid out on the model's canvas, which shape admission picks, and the checks that
// fail a job, each with one plain line saying what to do. It knows no model: a pack's recipe and limits supply every number.
import type { CompositeSwapReport } from "@/video/compositeSwap";
import { parseRecipe } from "@/lib/recipe";

// ---- the numbers a pack declares ------------------------------------------------------------------------------------------------------------
/** What the swap reads from the pack's recipe, in "name: value" lines after the `---measured---` marker. */
export interface SwapTuning { segmentFrames: number; fps: number; adapterStrength: number; retakeSeeds: number[]; canvasMargin: number }

const TUNING_KEYS = ["segment_frames", "fps", "adapter_strength", "retake_seeds", "canvas_margin"] as const;

export function swapTuning(recipe: string): SwapTuning {
  const { measured } = parseRecipe(recipe);
  const found = new Map<string, string>();
  for (const line of (measured ?? "").split("\n")) {
    const match = /^([a-z_]+):\s*(.+)$/.exec(line.trim());
    if (match && (TUNING_KEYS as readonly string[]).includes(match[1]!)) found.set(match[1]!, match[2]!.trim());
  }
  const missing = TUNING_KEYS.filter((key) => !found.has(key));
  if (missing.length) throw new Error(`The swap recipe in the model's pack lacks ${missing.join(", ")}. Add each as a "name: value" line after the measured marker in recipes/swap.md.`);
  const number = (key: string): number => { const value = Number(found.get(key)); if (!Number.isFinite(value)) throw new Error(`The swap recipe line "${key}" is not a number. Fix recipes/swap.md.`); return value; };
  const seeds = found.get("retake_seeds")!.split(",").map((part) => Number(part.trim()));
  if (!seeds.length || seeds.some((seed) => !Number.isInteger(seed) || seed < 0)) throw new Error('The swap recipe line "retake_seeds" must list whole numbers separated by commas. Fix recipes/swap.md.');
  const tuning: SwapTuning = { segmentFrames: number("segment_frames"), fps: number("fps"), adapterStrength: number("adapter_strength"), retakeSeeds: seeds, canvasMargin: number("canvas_margin") };
  if (!Number.isInteger(tuning.segmentFrames) || tuning.segmentFrames < 8 || tuning.fps <= 0 || tuning.adapterStrength <= 0 || tuning.canvasMargin < 0 || tuning.canvasMargin >= 0.4) throw new Error("The swap recipe numbers are out of range. Fix recipes/swap.md.");
  return tuning;
}

/** The recipe's `{references}` blank: the model's own names for the pictures it is shown. */
export function referenceNames(count: number): string { return Array.from({ length: count }, (_, i) => `<Picture ${i + 1}>`).join(", "); }

// ---- cutting the clip -----------------------------------------------------------------------------------------------------------------------
export interface Segment {
  index: number;
  /** Seconds from the start of the window, and how long; frames at the source's own frame rate. */
  start: number; seconds: number; startFrame: number; frames: number;
  /** The model always draws a whole call; a shorter piece is padded by playing it forward and back. */
  pingPong: boolean;
}

/** Cuts a window into segments. A scene is never split across a cut; a scene longer than one model call is split into near-equal pieces, none longer than the call. */
export function planSegments(totalFrames: number, cutFrames: readonly number[], fps: number, callSeconds: number): Segment[] {
  const callFrames = Math.max(1, Math.round(callSeconds * fps));
  const edges = [...new Set(cutFrames.map((frame) => Math.round(frame)).filter((frame) => frame > 0 && frame < totalFrames))].sort((a, b) => a - b);
  const bounds = [0, ...edges, totalFrames];
  const segments: Segment[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const from = bounds[i]!, length = bounds[i + 1]! - from;
    const pieces = Math.max(1, Math.ceil(length / callFrames));
    const base = Math.floor(length / pieces), extra = length - base * pieces;
    let at = from;
    for (let piece = 0; piece < pieces; piece++) {
      const frames = base + (piece < extra ? 1 : 0);
      segments.push({ index: segments.length, start: at / fps, seconds: frames / fps, startFrame: at, frames, pingPong: frames < callFrames });
      at += frames;
    }
  }
  return segments;
}

/** Scene-change times from ffmpeg's `select` and `showinfo` filters, as frame numbers in the window. A cut within `guardFrames` of an end is ignored: it would leave a piece too short to be a scene. */
export function parseSceneCuts(ffmpegStderr: string, fps: number, totalFrames: number, guardFrames = 3): number[] {
  const frames: number[] = [];
  for (const match of ffmpegStderr.matchAll(/pts_time:\s*([0-9.]+)/g)) {
    const frame = Math.round(Number(match[1]) * fps);
    if (Number.isFinite(frame) && frame > guardFrames && frame < totalFrames - guardFrames) frames.push(frame);
  }
  return [...new Set(frames)].sort((a, b) => a - b);
}

// ---- the guide on the model's canvas --------------------------------------------------------------------------------------------------------
export interface GuideLayout {
  /** Where the source picture sits on the model's canvas; the donor is cut back to this rectangle. Even numbers, so the video codec accepts it. */
  content: { x: number; y: number; width: number; height: number };
  /** True when canvas was added around the picture on purpose, for a head that leaves the frame. */
  padded: boolean;
}
const evenDown = (value: number): number => Math.floor(Math.round(value) / 2) * 2;   // rounded first: 511.99999 from a float scale is 512, not 510
const even = (value: number): number => Math.max(2, evenDown(value));

/** Fits the source inside the model's canvas without changing its shape. `margin` (a share of each side, 0 for none) leaves room around the picture for a head that leaves the frame. */
export function guideLayout(source: { width: number; height: number }, canvas: { width: number; height: number }, margin: number): GuideLayout {
  const room = 1 - 2 * margin;
  const scale = Math.min((canvas.width * room) / source.width, (canvas.height * room) / source.height);
  const width = Math.min(canvas.width, even(source.width * scale)), height = Math.min(canvas.height, even(source.height * scale));
  return { content: { x: evenDown((canvas.width - width) / 2), y: evenDown((canvas.height - height) / 2), width, height }, padded: margin > 0 };
}

/** The ffmpeg filter that makes the guide: erase the caption, resample to the model's rate, fit to the canvas, pad the rest with black. */
export function guideFilter(layout: GuideLayout, canvas: { width: number; height: number }, fps: number, captionBox: readonly number[] | null): string {
  const erase = captionBox ? `delogo=x=${captionBox[0]}:y=${captionBox[1]}:w=${captionBox[2]}:h=${captionBox[3]},` : "";
  const { content } = layout;
  return `${erase}fps=${fps},scale=${content.width}:${content.height}:flags=lanczos,pad=${canvas.width}:${canvas.height}:${content.x}:${content.y}:black,setsar=1`;
}
/** The ffmpeg filter that cuts the donor back to where the source sat on the canvas. */
export function donorCropFilter(layout: GuideLayout): string { const { content } = layout; return `crop=${content.width}:${content.height}:${content.x}:${content.y}`; }

// ---- which shape runs -----------------------------------------------------------------------------------------------------------------------
type Level = "standard" | "boost" | "max";
const LEVELS: readonly Level[] = ["standard", "boost", "max"];
export interface SwapShapeOffer { shape: "landscape" | "portrait"; level: Level; width: number; height: number; peakBytes: number }
export type SwapShapePick = { ok: true; offer: SwapShapeOffer; lowered: boolean } | { ok: false; line: string };

export const MEMORY_SHORT_LINE = "This computer is too busy to swap a face right now. Close big apps or wait for other work to finish, then try again.";

/** Picks the largest shape that fits, no larger than the level asked for. A source taller than wide gets the portrait shapes, anything else the landscape ones. */
export function pickSwapShape(input: {
  source: { width: number; height: number }; asked: Level;
  shapes: Record<string, Record<string, { width: number; height: number } | undefined> | undefined> | undefined;
  peaks: ReadonlyArray<{ shape?: string | undefined; level?: string | undefined; bytes: number }>;
  fits: Record<Level, boolean>; budgetBytes: number;
}): SwapShapePick {
  const shape = input.source.height > input.source.width * 1.15 ? "portrait" : "landscape";
  const allowed = LEVELS.slice(0, LEVELS.indexOf(input.asked) + 1).reverse();
  for (const level of allowed) {
    const pixels = input.shapes?.[shape]?.[level];
    const peak = input.peaks.find((p) => p.shape === shape && p.level === level)?.bytes;
    if (!pixels || peak === undefined) continue;
    if (!input.fits[level] || (input.budgetBytes > 0 && peak > input.budgetBytes)) continue;
    return { ok: true, offer: { shape, level, width: pixels.width, height: pixels.height, peakBytes: peak }, lowered: level !== input.asked };
  }
  return { ok: false, line: MEMORY_SHORT_LINE };
}

// ---- the checks -----------------------------------------------------------------------------------------------------------------------------
/** A donor whose picture is this close to its guide did not change the head: the model copied the original. Above it, the segment is retaken with another seed. */
export const DONOR_COPY_PSNR_DB = 30;
/** Share of far-from-head pixels allowed to differ before the encode (a handful of rounding cases; a real edit is far above it). */
/** Share of a segment's frames that may still show the original head before the job fails (the detector reads skin and is an upper bound on dark footage). */
export const RESIDUAL_FRAME_SHARE_TOLERANCE = 0.1;
/** Caption edges that survive the erase, as a share of the edges that were there. */
export const CAPTION_RESIDUE_LIMIT = 0.5;

export const clock = (seconds: number): string => { const whole = Math.max(0, Math.floor(seconds)); return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`; };

/** The picture quality of `a` against `b` from ffmpeg's psnr filter (its "average:" figure), or null when the filter printed none. Identical pictures print "inf". */
export function parsePsnr(ffmpegStderr: string): number | null {
  const all = [...ffmpegStderr.matchAll(/average:\s*([0-9.]+|inf)/g)];
  const last = all[all.length - 1]?.[1];
  if (last === undefined) return null;
  return last === "inf" ? Number.POSITIVE_INFINITY : Number(last);
}

export function donorCopiedGuide(psnr: number | null): boolean { return psnr !== null && psnr > DONOR_COPY_PSNR_DB; }

export function donorCopiedLine(at: number, tries: number): string {
  return `The new head at ${clock(at)} came out almost the same as the original, even after ${tries} ${tries === 1 ? "try" : "tries"}. Try again with clearer reference pictures that face the camera.`;
}

/** The checks on one segment's composite report. Each failing check is one plain line; an empty list means the segment passed. */
export function segmentFailures(report: CompositeSwapReport, at: number): string[] {
  const lines: string[] = [];
  if (report.preservation?.verdict === "inconclusive") {   // an unproven swap is never delivered; this is not the same fact as a changed picture
    lines.push(`The swap at ${clock(at)} could not be checked, because it was made by another tool and no part of the clip is free of the person to measure it against, so the clip was thrown away. Try again with a clip where the person leaves the picture for a moment, or send this clip in to be looked at.`);
  } else if (!report.preservation || report.preservation.verdict !== "pass") {
    lines.push(`The swap changed parts of the picture outside the head at ${clock(at)}, which it must never do, so the clip was thrown away. Try again, and if it happens again send this clip in to be looked at.`);
  }
  const residual = report.residual_original_head_frames.length;
  if (report.frames > 0 && residual / report.frames > RESIDUAL_FRAME_SHARE_TOLERANCE) {
    lines.push(`The original person's head still shows in ${residual} frames from ${clock(at)}. Try again with clearer reference pictures of the new person facing the camera.`);
  }
  if (report.caption_residue !== null && report.caption_residue !== undefined && report.caption_residue > CAPTION_RESIDUE_LIMIT) {
    lines.push(`Burned-in text near ${clock(at)} was still visible after it was erased. Try again with a clip that has no captions, or crop the captions out first.`);
  }
  if (!report.flicker_ok) {
    lines.push(`The new head's mouth flickers more than the original person's does at ${clock(at)}. Try again; a clearer reference picture of the new person's face often fixes it.`);
  }
  return lines;
}

export const MANY_PEOPLE_IN_CLIP_LINE = "More than one person is in view in most of this clip. A swap changes one person's head, so use a clip with one person in view.";
/** The clip check is a vote over sampled frames, because a face finder misses faces and sometimes sees ones that are not there. */
export function clipHasTooManyPeople(analysis: { people_max: number; many_people_share: number }): boolean { return analysis.people_max > 1 && analysis.many_people_share >= 0.5; }

