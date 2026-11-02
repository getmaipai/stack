// LTX25-EDIT-01: extend a clip and retake a clip on the LTX-2.5 Max engine (dgrauet/ltx-2-mlx 0.18.0, `ltx25-max-gen`). Two new request shapes on
// POST /v1/videos/generations (video/jobs.ts and routes/videoGenerations.ts carry them): `source_video` plus `extend_seconds` appends 1 to 6 s
// after the source (`ExtendDistilledPipeline`), `source_video` plus `retake_from_seconds` regenerates the clip from that second to its end
// (`RetakePipeline(distilled=True)`). Both keep the source in latent form and decode the whole clip again, so the cost follows the whole
// source length, and both need the pack's Gemma folder like every Max run (the worker guards it).
//
// What the Stack allows is what was measured (M5 Max, 128 GB, OS footprint, runtime 0.18.0, bf16 pack, seed 7, 10 s source = 241 frames, new
// 12 latent frames or the second half retaken), never an extrapolation: a source is refused with a plain 422 outside the table. This file
// holds the pure rules (the table, the second-to-latent mapping, the source plan, the fit command) so a test reads them without a binary.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnRunner, type Runner } from "@/media/run";
import { defaultToolbox, type MediaToolbox } from "@/media/tools";
import { LTX25_CLIP_CAP_BYTES, LTX25_FPS, LTX25_MAX_ADMIT_HEADROOM, LTX25_MAX_GEN_VERSION, ltx25MaxGenRoot, ltx25SourcePaths } from "./ltx25";

const GB = 1_000_000_000;
/** One latent frame is 8 pixel frames (the VAE's time step); a clip of 8k + 1 pixel frames holds k + 1 latent frames. */
export const LTX25_LATENT_PIXEL_FRAMES = 8;
export const LTX25_EDIT_EXTEND_MIN_SECONDS = 1;
export const LTX25_EDIT_EXTEND_MAX_SECONDS = 6;
/** The runtime carries the last 25 pixel frames of the source into the new part, so a source needs at least that many. */
export const LTX25_EDIT_MIN_SOURCE_FRAMES = 25;
/** The longest source measured: 10 s at 24 a second. A longer one is refused (the cost follows the whole clip length and was not measured past it). */
export const LTX25_EDIT_MAX_SOURCE_FRAMES = 10 * LTX25_FPS + 1;
/** The shortest piece of the clip a retake keeps untouched and regenerates: the first latent frame (frame 0) is never regenerated. */
export const LTX25_EDIT_RETAKE_MIN_SECONDS = 1;
export const LTX25_EDIT_RETAKE_MAX_SECONDS = 9;

export interface Ltx25MaxEditRow {
  size: string; width: number; height: number;
  /** The measured OS footprint of an extend and of a retake of a 10 s source at this size. */
  extendPeakBytes: number; retakePeakBytes: number;
}
/**
 * Measured sizes (OS footprint, 10 s source, runtime 0.18.0, bf16 pack, seed 7, M5 Max 128 GB, 2026-11-02).
 * 768x448: the runtime's own command line (no MLX cache limit): extend by 12 latent frames 137 s and 59.3 GB, retake from latent 15 to the end 202 s and 59.1 GB.
 * 1024x576: through the Stack's worker (MLX cache limit 4.4 GB, `proc_pid_rusage` lifetime maximum of the worker): extend by 4 s 156 s and 48.8 GB (14 s clip),
 * retake from 5 s 422 s (the computer was busy, load average 17) and 56.5 GB. Both pass the 64 GB per-clip cap with the 5 percent margin. A source that is not
 * on a listed size is fitted to the largest listed size that fits inside it.
 */
export const LTX25_MAX_EDIT_MEASURED: readonly Ltx25MaxEditRow[] = [
  { size: "768x448", width: 768, height: 448, extendPeakBytes: 59.3 * GB, retakePeakBytes: 59.1 * GB },
  { size: "1024x576", width: 1024, height: 576, extendPeakBytes: 48.8 * GB, retakePeakBytes: 56.5 * GB },
];
export type Ltx25EditKind = "extend" | "retake";
export const ltx25EditPeakBytes = (row: Ltx25MaxEditRow, kind: Ltx25EditKind): number => (kind === "extend" ? row.extendPeakBytes : row.retakePeakBytes);
/** What admission reserves for an edit at a size: the measured footprint plus the Max margin (5 percent), under the 64 GB cap. */
export function ltx25EditAdmitBytes(kind: Ltx25EditKind, size?: string | null): number {
  const rows = size ? LTX25_MAX_EDIT_MEASURED.filter((row) => row.size === size) : LTX25_MAX_EDIT_MEASURED;
  const peak = Math.max(...(rows.length ? rows : LTX25_MAX_EDIT_MEASURED).map((row) => ltx25EditPeakBytes(row, kind)));
  return Math.round(peak * LTX25_MAX_ADMIT_HEADROOM);
}
export function ltx25EditRow(width: number, height: number): Ltx25MaxEditRow | null {
  return LTX25_MAX_EDIT_MEASURED.find((row) => row.width === width && row.height === height) ?? null;
}
// The cap is a design constant, not a request check: every row must stay under it with the margin.
export const LTX25_EDIT_ROWS_PASS_CAP = LTX25_MAX_EDIT_MEASURED.every((row) => Math.max(row.extendPeakBytes, row.retakePeakBytes) * LTX25_MAX_ADMIT_HEADROOM < LTX25_CLIP_CAP_BYTES);

// ---- the mapping from seconds to latent frames (one definition; the worker takes the latent numbers) ----

/** `extend_seconds` to latent frames to append: ceil(seconds * 24 / 8). 1 s is 3 latent frames (24 pixel frames), 6 s is 18 (144). */
export function extendLatentFrames(seconds: number): number { return Math.ceil((seconds * LTX25_FPS) / LTX25_LATENT_PIXEL_FRAMES); }
/** The pixel frames the runtime really adds: 8 per latent frame. A whole number of seconds adds exactly that many seconds. */
export function extendPixelFrames(seconds: number): number { return extendLatentFrames(seconds) * LTX25_LATENT_PIXEL_FRAMES; }
/** The runtime encodes 8k + 1 frames of the source (it drops the tail past that): the usable frame count of a source. */
export function usableFrames(frames: number): number { return 1 + LTX25_LATENT_PIXEL_FRAMES * Math.max(1, Math.floor((frames - 1) / LTX25_LATENT_PIXEL_FRAMES)); }
/** Latent frames of a source: k + 1 for 8k + 1 usable frames (241 frames is 31). */
export function sourceLatentFrames(frames: number): number { return (usableFrames(frames) - 1) / LTX25_LATENT_PIXEL_FRAMES + 1; }
/** `retake_from_seconds` to the first latent frame regenerated: floor(seconds * 24 / 8). The end is always the clip end (the latent frame count, exclusive). */
export function retakeStartLatent(seconds: number): number { return Math.floor((seconds * LTX25_FPS) / LTX25_LATENT_PIXEL_FRAMES); }

/** The tools an edit calls (the media service's pinned ffmpeg and ffprobe, and how they run). A test swaps them for scripted ones. */
export const editRuntime: { toolbox: MediaToolbox; run: Runner } = { toolbox: defaultToolbox, run: spawnRunner };
export function __setEditRuntimeForTests(next: { toolbox?: MediaToolbox; run?: Runner } | null): void {
  editRuntime.toolbox = next?.toolbox ?? defaultToolbox;
  editRuntime.run = next?.run ?? spawnRunner;
}

// ---- the source clip ----

export class EditSourceError extends Error {
  constructor(readonly code: string, message: string, readonly status = 422) { super(message); }
}

export interface SourceFacts { hasVideo: boolean; hasAudio: boolean; width: number; height: number; fps: number; frames: number; }
export interface SourcePlan {
  /** The size the runtime gets (the fitted one when the source was not on the table). */
  width: number; height: number; size: string;
  /** The Stack's ffmpeg has to re-make the source (another size or frame rate) before the runtime reads it. */
  fit: boolean;
  /** Frames of the source as the runtime sees it (after a fit, at 24 a second). */
  frames: number; latentFrames: number;
}

const isTwentyFour = (fps: number): boolean => Math.abs(fps - LTX25_FPS) < 0.05;

/** Parses ffprobe's JSON into the few facts the plan needs, or throws the plain refusal. Pure. */
export function sourceFactsFromProbe(raw: unknown): SourceFacts {
  const data = (raw ?? {}) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video" && !(stream.disposition as { attached_pic?: number } | undefined)?.attached_pic);
  const audio = streams.find((stream) => stream.codec_type === "audio");
  if (!video) return { hasVideo: false, hasAudio: !!audio, width: 0, height: 0, fps: 0, frames: 0 };
  const num = (value: unknown): number => { const parsed = typeof value === "number" ? value : Number(value); return Number.isFinite(parsed) ? parsed : 0; };
  const rate = (text: unknown): number => { const [top, bottom] = String(text ?? "").split("/").map(Number); return top && bottom ? top / bottom : 0; };
  const fps = rate(video.r_frame_rate) || rate(video.avg_frame_rate);
  const duration = num(video.duration) || num(data.format?.duration);
  const frames = num(video.nb_frames) || (duration > 0 && fps > 0 ? Math.round(duration * fps) : 0);
  return { hasVideo: true, hasAudio: !!audio, width: num(video.width), height: num(video.height), fps, frames };
}

/** The plain refusal or the plan for a source. Pure: the same rules the route (when ffprobe is on this computer) and the job apply. */
export function planSource(facts: SourceFacts): SourcePlan {
  if (!facts.hasVideo || facts.width <= 0 || facts.height <= 0) throw new EditSourceError("bad_source", "The source could not be read as a video. Send an mp4 clip with a picture.");
  if (!facts.hasAudio) throw new EditSourceError("bad_source_audio", "The source has no sound track. Extend and retake continue the speech, so the clip needs the one a Max clip is made with; send a clip that has sound.");
  const seconds24 = facts.fps > 0 ? (facts.frames / facts.fps) * LTX25_FPS : facts.frames;
  const frames24 = Math.round(seconds24);
  if (frames24 < LTX25_EDIT_MIN_SOURCE_FRAMES) throw new EditSourceError("bad_source", `The source is too short: it has ${frames24} frames at 24 a second and the runtime needs at least ${LTX25_EDIT_MIN_SOURCE_FRAMES} (a little over 1 second).`);
  if (frames24 > LTX25_EDIT_MAX_SOURCE_FRAMES) throw new EditSourceError("bad_source", `The source is too long: it is ${Math.round(frames24 / LTX25_FPS * 10) / 10} seconds and the Stack edits clips of at most ${LTX25_EDIT_MAX_SOURCE_FRAMES - 1} frames (${(LTX25_EDIT_MAX_SOURCE_FRAMES - 1) / LTX25_FPS} seconds). Trim it first.`);
  const exact = ltx25EditRow(facts.width, facts.height);
  const fits = [...LTX25_MAX_EDIT_MEASURED].filter((row) => row.width <= facts.width && row.height <= facts.height).sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!exact && !fits) throw new EditSourceError("bad_source", `The source is ${facts.width}x${facts.height}, smaller than the smallest size the Stack edits (${LTX25_MAX_EDIT_MEASURED.map((row) => row.size).join(" or ")}). Send a larger clip.`);
  const target = exact ?? fits!;
  const fit = !exact || !isTwentyFour(facts.fps);
  const frames = usableFrames(fit ? frames24 : facts.frames);
  return { width: target.width, height: target.height, size: target.size, fit, frames, latentFrames: sourceLatentFrames(frames) };
}

/** Checks the edit's own number against the plan: how far an extend or a retake may go for this source. Throws the plain 422. */
export function checkEdit(kind: Ltx25EditKind, plan: SourcePlan, seconds: number): void {
  if (kind === "retake") {
    const start = retakeStartLatent(seconds);
    if (start < 1 || start >= plan.latentFrames) {
      const length = Math.round(((plan.frames - 1) / LTX25_FPS) * 10) / 10;
      throw new EditSourceError("bad_retake", `A retake starts between 1 second and the end of the clip, and this clip is ${length} seconds. Pick a start inside it.`);
    }
  }
}

/** The ffprobe call the plan reads, through the injected runner. */
export async function probeSource(ffprobe: string, path: string, run: Runner, signal?: AbortSignal): Promise<SourceFacts> {
  const done = await run([ffprobe, "-v", "error", "-show_entries", "stream=codec_type,width,height,r_frame_rate,avg_frame_rate,nb_frames,duration,disposition:format=duration", "-of", "json", path], { collectStdout: true, ...(signal ? { signal } : {}) });
  if (done.aborted) throw new EditSourceError("cancelled", "Cancelled.", 499);
  if (done.code !== 0) throw new EditSourceError("bad_source", "The source could not be read as a video. Send an mp4 clip with a picture and sound.");
  try { return sourceFactsFromProbe(JSON.parse(done.stdout)); } catch { throw new EditSourceError("bad_source", "The source could not be read as a video. Send an mp4 clip with a picture and sound."); }
}

/**
 * The ffmpeg arguments that make the runtime's copy of a source that is not on the table: scale to fill and centre-crop to the target size (aspect
 * fit, never stretched), 24 frames a second, H.264 at a high quality (the runtime re-encodes the whole clip anyway), the sound as AAC, no metadata.
 */
export function fitArgs(input: string, output: string, plan: Pick<SourcePlan, "width" | "height">): string[] {
  const { width, height } = plan;
  const filters = `fps=${LTX25_FPS},scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height},setsar=1,format=yuv420p`;
  return ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-map", "0:v:0", "-map", "0:a:0", "-vf", filters, "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-map_metadata", "-1", "-movflags", "+faststart", "-f", "mp4", output];
}

/** Runtime builds known to ship both edit pipelines: dgrauet/ltx-2-mlx 0.18.0 (the pinned `ltx25-max-gen` tag). */
export const LTX25_MAX_EDIT_RUNTIME_TAGS: readonly string[] = ["b82b97e"];
/**
 * Whether this computer's Max runtime has both edit pipelines. The status reports `extend` and `retake` true only then, so a Home that is
 * newer than the runtime never offers what cannot run. Once the runtime source is installed the answer is what is on disk
 * (`extend_distilled.py` and `retake.py`); before the first Max clip builds it, it is whether the pinned build is one known to ship them.
 */
export function ltx25MaxEditSupported(root = ltx25MaxGenRoot(), pinnedTag: string = LTX25_MAX_GEN_VERSION): boolean {
  const pipelines = ltx25SourcePaths(root)[1]!;
  if (existsSync(pipelines)) return existsSync(join(pipelines, "ltx_pipelines_mlx", "extend_distilled.py")) && existsSync(join(pipelines, "ltx_pipelines_mlx", "retake.py"));
  return LTX25_MAX_EDIT_RUNTIME_TAGS.includes(pinnedTag);
}
