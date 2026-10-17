// The job runner behind POST /v1/videos/generations (VIDEO-GEN-02). The job
// record (which Home lists and the event feed carries) holds only the size,
// the seed and the LoRA ids; the prompt and the reference picture wait in
// memory under a token the route made, are taken by the runner once, and are
// never written to a record, a log or the results folder. The generator queue
// (lib/jobs.ts) gives the clip its place in line and the governor's admission
// of 44 GB before this runner is called. The kind is not a role id on
// purpose: `/v1/images/generations` with model "video" must never reach it.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerJobRunner } from "@/lib/jobs";
import { STACK_VIDEO_MODEL_ID } from "@/lib/modelCatalog";
import { workDir, commitResult, type VideoResultMeta } from "./results";
import { recordGeneratedImage } from "./provenance";
import { overallPercent, VideoError, videoGen, VIDEO_PEAK_BYTES } from "./videoGen";

export const VIDEO_JOB_KIND = "video_generation";

export interface StashedClip {
  prompt: string;
  negativePrompt: string | null;
  image: Uint8Array | null;
  width: number; height: number; frames: number; seed: number;
  loras: Array<[string, number]>;
  loraIds: string[];
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
function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.set(key, value);
  while (map.size > 200) map.delete(map.keys().next().value as string);
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
      const outputDir = join(work, "out");
      const started = Date.now();
      const result = await videoGen.run({ prompt: clip.prompt, negativePrompt: clip.negativePrompt, imagePath, width: clip.width, height: clip.height, frames: clip.frames, seed: clip.seed, loras: clip.loras, outputDir }, {
        jobId: job.id, signal,
        onPhase: (phase, phasePercent) => { remember(progress, job.id, { phase, phasePercent }); update({ status: phase, percent: overallPercent(phase, phasePercent) }); },
      });
      const video = join(outputDir, "video.mp4");
      const poster = join(outputDir, "poster.jpg");
      const meta: VideoResultMeta = {
        job: job.id, created: Math.floor(new Date(job.createdAt).getTime() / 1000), width: result.width, height: result.height, frames: result.frames, fps: result.fps, seconds: Math.round((result.frames - 1) / result.fps),
        seed: result.seed, model: STACK_VIDEO_MODEL_ID, mode: clip.image ? "image-to-video" : "text-to-video", lora_ids: clip.loraIds, ms: Date.now() - started,
        bytes: Bun.file(video).size, poster_bytes: Bun.file(poster).size, mlx_peak_gb: result.peakBytes === null ? null : Math.round(result.peakBytes / 1e8) / 10,
      };
      update({ status: "ready", percent: 100 });
      // The poster of a clip the Stack made counts as a picture made here.
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
  }, { generator: { role: "video", memory: () => ({ requestedBytes: VIDEO_PEAK_BYTES, measuredPeakBytes: VIDEO_PEAK_BYTES, engine: "video-gen" }) } });
}
