// The job runner behind POST /v1/videos/generations (VIDEO-GEN-02). The job
// record (which Home lists and the event feed carries) holds only the size,
// the seed and the LoRA ids; the prompt and the reference picture wait in
// memory under a token the route made, are taken by the runner once, and are
// never written to a record, a log or the results folder. The generator queue
// (lib/jobs.ts) gives the clip its place in line and the governor's admission
// of 44 GB before this runner is called. The kind is not a role id on
// purpose: `/v1/images/generations` with model "video" must never reach it.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerJobRunner } from "@/lib/jobs";
import { heavyGate } from "@/lib/heavyGate";

import { workDir, commitResult, type VideoResultMeta } from "./results";
import { recordGeneratedImage } from "./provenance";
import { GenTracker, historyKey, previewExists, previewFile, recordRun } from "@/lib/genProgress";
import { overallPercent, VideoError, videoGen, VIDEO_SPECS, type VideoQuality, type VideoRunInput } from "./videoGen";
import { ltx25MaxPeakBytes, ltx25PeakBytes, LTX25_ICLORA_PEAK_BYTES, LTX25_INGREDIENTS_PEAK_BYTES } from "./ltx25";
import { checkEdit, EditSourceError, editRuntime, extendLatentFrames, extendPixelFrames, fitArgs, ltx25EditAdmitBytes, planSource, probeSource, retakeStartLatent, type Ltx25EditKind } from "./ltx25Edit";
import { resolveReadable } from "@/media/paths";

export const VIDEO_JOB_KIND = "video_generation";
export function videoAdmission(input: { quality?: VideoQuality; size?: string; seconds?: number; mode?: string; edit?: Ltx25EditKind; lora_admit_bytes?: number }): { requestedBytes: number; measuredPeakBytes: number; engine: string } {
  const withPicture = input.mode === "image-to-video"; const quality = input.quality ?? "quick"; const size = /^(\d+)x(\d+)$/.exec(input.size ?? "");
  const peak = input.mode === "ic_lora" ? (input.size === "768x448" ? LTX25_INGREDIENTS_PEAK_BYTES : LTX25_ICLORA_PEAK_BYTES) : (input.lora_admit_bytes ?? 0) + (input.edit && quality === "ltx25max" ? ltx25EditAdmitBytes(input.edit, size ? `${size[1]}x${size[2]}` : null) : quality === "ltx25max" ? ltx25MaxPeakBytes(withPicture) : quality === "ltx25" && size && input.seconds ? ltx25PeakBytes(Number(size[1]), Number(size[2]), input.seconds * 24 + 1, withPicture) : VIDEO_SPECS[quality].peakBytes);
  return { requestedBytes: peak, measuredPeakBytes: peak, engine: "video-gen" };
}

export interface StashedClip {
  prompt: string;
  negativePrompt: string | null;
  image: Uint8Array | null;
  /** VIDEO-INPUTS-01: the picture the clip ends on (LTX-2.5 only; needs `image`). */
  endImage?: Uint8Array | null;
  width: number; height: number; frames: number; seed: number;
  loras: Array<[string, number]>;
  loraIds: string[];
  /** Which model makes the clip (default Quick). */
  quality?: VideoQuality;
  /** GENPREVIEW-01: draw the first-frame preview when the motion is done (default on). */
  preview?: boolean;
  /** LTX25-EDIT-01 (Max only): extend or retake the clip at `sourcePath` (already resolved inside a declared media folder). `seconds` is `extend_seconds` or `retake_from_seconds`. */
  edit?: { kind: Ltx25EditKind; sourcePath: string; seconds: number };
  icLora?: { sourcePath: string; sourceIsResult: boolean; loraPath: string; loraId: string; strength: number; conditioning: "source" | "edges"; audio: boolean };
  /** INGREDIENTS-01 (Max only): one or two reference sheet PNGs (768x448) and the installed Ingredients adapter. */
  ingredients?: { sheets: Uint8Array[]; loraPath: string; loraId: string };
}
const pending = new Map<string, StashedClip & { at: number }>();
const STASH_TTL_MS = 30 * 60_000;
/** A clip cancelled or refused before its runner started never takes its stash, so anything older than half an hour goes. */
export function stashClip(token: string, clip: StashedClip): void {
  const now = Date.now();
  for (const [key, value] of pending) if (now - value.at > STASH_TTL_MS) pending.delete(key);
  pending.set(token, { ...clip, at: now });
}
export function unstashClip(token: string): StashedClip | null {
  const clip = pending.get(token) ?? null;
  pending.delete(token);
  if (!clip) return null;
  const { at: _at, ...rest } = clip;
  return rest;
}

/** What a job is doing right now, for the status route (the job record carries the percent only). */
const progress = new Map<string, { phase: string; phasePercent: number }>();
const failures = new Map<string, { code: string; message: string; status: number }>();
export function videoProgress(job: string): { phase: string; phasePercent: number } | null { return progress.get(job) ?? null; }
export function videoFailure(job: string): { code: string; message: string; status: number } | null { return failures.get(job) ?? null; }
/** Stages and previews of the clips in flight, for the status route. */
const trackers = new Map<string, GenTracker>();
export function videoTracker(job: string): GenTracker | null { return trackers.get(job) ?? null; }
/** The first-frame preview of a running clip, or null (the work folder goes with the job). */
export function videoPreviewPath(job: string): string | null {
  return trackers.has(job) && previewExists(join(workDir(job), "out")) ? previewFile(join(workDir(job), "out")) : null;
}
function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.set(key, value);
  while (map.size > 200) map.delete(map.keys().next().value as string);
}

/** The job's copy of an edit's source, and what the worker is told about it. Throws a VideoError with a plain message for a source the table does not allow. */
async function prepareEditSource(edit: NonNullable<StashedClip["edit"]>, work: string, signal: AbortSignal, status: (text: string) => void): Promise<{ edit: NonNullable<VideoRunInput["edit"]>; width: number; height: number; frames: number }> {
  try {
    const source = resolveReadable(edit.sourcePath, "The source clip");
    const ffmpeg = await editRuntime.toolbox.path("ffmpeg", status, signal);
    const ffprobe = await editRuntime.toolbox.path("ffprobe", status, signal);
    const plan = planSource(await probeSource(ffprobe, source, editRuntime.run, signal));
    checkEdit(edit.kind, plan, edit.seconds);
    const sourcePath = join(work, "source.mp4");
    if (plan.fit) {
      const made = await editRuntime.run([ffmpeg, ...fitArgs(source, sourcePath, plan)], { signal });
      if (made.aborted) throw new VideoError("cancelled", "Cancelled.", 499);
      if (made.code !== 0) throw new EditSourceError("bad_source", "The source could not be fitted to the size the video model edits. Send an mp4 clip with a picture and sound.");
    } else copyFileSync(source, sourcePath);
    const extendFrames = edit.kind === "extend" ? extendLatentFrames(edit.seconds) : undefined;
    // The expected length of the result, for the progress estimate (the worker reports the real one): an extend adds 8 frames per latent frame.
    const frames = edit.kind === "extend" ? plan.frames + extendPixelFrames(edit.seconds) : plan.frames;
    return { edit: { kind: edit.kind, sourcePath, ffmpeg, ffprobe, ...(extendFrames !== undefined ? { extendFrames } : { retakeStartLatent: retakeStartLatent(edit.seconds) }) }, width: plan.width, height: plan.height, frames };
  } catch (error) {
    if (error instanceof EditSourceError) throw new VideoError(error.code, error.message, error.status);
    if (error instanceof VideoError) throw error;
    if (signal.aborted) throw new VideoError("cancelled", "Cancelled.", 499);
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === "string" && /^(path_|no_roots|root_|tool_)/.test(code)) throw new VideoError(code === "path_not_found" ? "source_not_found" : code, error instanceof Error ? error.message : "The source clip could not be read.", code.startsWith("tool_") ? 503 : 422);
    throw error;
  }
}

export interface VideoJobResult { job: string; model: string; width: number; height: number; frames: number; fps: number; seconds: number; seed: number; lora_ids: string[]; ms: number; }

export function registerVideoJobs(): void {
  registerJobRunner(VIDEO_JOB_KIND, async (job, signal, update): Promise<VideoJobResult> => {
    const token = String((job.input as { token?: string } | null)?.token ?? "");
    const clip = unstashClip(token);
    if (!clip) throw new VideoError("failed", "The request was not received. Send it again.", 400);
    const work = workDir(job.id);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true, mode: 0o700 });
    try {
      let imagePath: string | null = null;
      if (clip.image) { imagePath = join(work, "reference.bin"); writeFileSync(imagePath, clip.image, { mode: 0o600 }); }
      let endImagePath: string | null = null;
      if (clip.endImage) { endImagePath = join(work, "end-reference.bin"); writeFileSync(endImagePath, clip.endImage, { mode: 0o600 }); }
      const outputDir = join(work, "out");
      const started = Date.now();
      const quality = clip.quality ?? "quick";
      // LTX25-EDIT-01: the source is probed again (the authority), fitted to the runtime's table when needed and copied into the job's private folder.
      let editInput: VideoRunInput["edit"] | undefined;
      if (clip.edit) {
        const prepared = await prepareEditSource(clip.edit, work, signal, (status) => update({ status }));
        editInput = prepared.edit;
        clip.width = prepared.width; clip.height = prepared.height; clip.frames = prepared.frames;
      }
      let icLoraInput: VideoRunInput["icLora"] | undefined;
      if (clip.icLora) {
        const source = clip.icLora.sourceIsResult ? clip.icLora.sourcePath : resolveReadable(clip.icLora.sourcePath, "The source clip");
        const ffprobe = await editRuntime.toolbox.path("ffprobe", (status) => update({ status }), signal);
        const facts = await probeSource(ffprobe, source, editRuntime.run, signal);
        if (!facts.hasVideo || facts.frames <= 0) throw new VideoError("source_not_found", "The source clip is missing or unreadable. Choose a readable video clip.", 422);
        if (facts.frames / (facts.fps || 24) > 10.01 || facts.frames > 241) throw new VideoError("source_too_long", "The source is over 10 seconds (241 frames). Trim it to 10 seconds or less.", 422);
        clip.frames = 1 + Math.floor((Math.min(facts.frames, 241) - 1) / 8) * 8;
        const sourcePath = join(work, "source.mp4");
        copyFileSync(source, sourcePath);
        icLoraInput = { sourcePath, path: clip.icLora.loraPath, strength: clip.icLora.strength, conditioning: clip.icLora.conditioning };
      }
      if (clip.ingredients) {
        const sheets = clip.ingredients.sheets.map((bytes, i) => { const file = join(work, `sheet-${i + 1}.png`); writeFileSync(file, bytes, { mode: 0o600 }); return file; });
        icLoraInput = { sourcePath: "", path: clip.ingredients.loraPath, strength: 1, conditioning: "source", sheets };
      }
      const pacing = heavyGate.pacing(job.id);
      const tracker = clip.icLora || clip.ingredients
        ? new GenTracker("video_edit", historyKey("video_edit", clip.width, clip.height, `ic_lora-${clip.frames}`), pacing.now, Math.max(0.25, (clip.frames - 1) / 120), pacing.paused)
        : clip.edit
        ? new GenTracker("video_edit", historyKey("video_edit", clip.width, clip.height, `${clip.edit.kind}-${clip.frames}`), pacing.now, Math.max(0.25, ((clip.frames - 1) / 240) * (clip.edit.kind === "retake" ? 1.4 : 0.93)), pacing.paused)
        : quality === "quick"
        ? new GenTracker("video", historyKey("video", clip.width, clip.height, clip.frames), pacing.now, 1, pacing.paused)
        : quality === "ltx25" || quality === "ltx25max"
          ? new GenTracker("video", historyKey("video", clip.width, clip.height, `${quality}-${clip.frames}${clip.image ? "-picture" : ""}`), pacing.now, Math.max(0.25, (clip.frames - 1) / 120), pacing.paused)
          : new GenTracker("video", historyKey("video", clip.width, clip.height, clip.frames), pacing.now, Math.max(0.25, (clip.frames - 1) / 120), pacing.paused);
      remember(trackers, job.id, tracker);
      const result = await videoGen.run({ ...(clip.preview !== false ? { previewPath: previewFile(outputDir) } : {}), prompt: clip.prompt, negativePrompt: clip.negativePrompt, imagePath, endImagePath, width: clip.width, height: clip.height, frames: clip.frames, seed: clip.seed, loras: clip.loras, outputDir, quality, ...(editInput ? { edit: editInput } : {}), ...(icLoraInput ? { icLora: icLoraInput } : {}) }, {
        jobId: job.id, signal,
        onPhase: (phase, phasePercent) => { remember(progress, job.id, { phase, phasePercent }); update({ status: phase, percent: tracker.started ? Math.round(tracker.snapshot().fraction * 100) : overallPercent(phase, phasePercent) }); },
        onStage: (stage, n, of) => { tracker.enter(stage, n, of); update({ percent: Math.round(tracker.snapshot().fraction * 100) }); },
        onPreview: () => tracker.setPreview(null, null),
      });
      recordRun(tracker.key, tracker.finish());
      const video = join(outputDir, "video.mp4");
      const poster = join(outputDir, "poster.jpg");
      const meta: VideoResultMeta = {
        job: job.id, created: Math.floor(new Date(job.createdAt).getTime() / 1000), width: result.width, height: result.height, frames: result.frames, fps: result.fps, seconds: Math.round((result.frames - 1) / result.fps),
        seed: result.seed, model: VIDEO_SPECS[quality].modelId, quality, audio: result.audio, mode: clip.icLora || clip.ingredients ? "ic_lora" : clip.edit ? clip.edit.kind : clip.image ? "image-to-video" : "text-to-video", lora_ids: clip.loraIds, ...((job.input as { audience?: unknown } | null)?.audience === "adult" ? { audience: "adult" as const } : {}), ms: Date.now() - started,
        bytes: Bun.file(video).size, poster_bytes: Bun.file(poster).size, mlx_peak_gb: result.peakBytes === null ? null : Math.round(result.peakBytes / 1e8) / 10,
      };
      update({ status: "ready", percent: 100 });
      // The poster of a clip the Stack made counts as a picture made here, except one that looks like a person: starting from it again needs a fresh proof.
      recordGeneratedImage(new Uint8Array(readFileSync(poster)));
      commitResult(meta, outputDir);
      remember(progress, job.id, { phase: "ready", phasePercent: 100 });
      return { job: job.id, model: meta.model, width: meta.width, height: meta.height, frames: meta.frames, fps: meta.fps, seconds: meta.seconds, seed: meta.seed, lora_ids: meta.lora_ids, ms: meta.ms };
    } catch (error) {
      if (!signal.aborted && error instanceof VideoError) remember(failures, job.id, { code: error.code, message: error.message, status: error.status });
      else if (!signal.aborted) remember(failures, job.id, { code: "failed", message: error instanceof Error ? error.message : String(error), status: 500 });
      throw error;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, { generator: { role: "video", memory: (job) => videoAdmission((job.input ?? {}) as Parameters<typeof videoAdmission>[0]) } });
}
