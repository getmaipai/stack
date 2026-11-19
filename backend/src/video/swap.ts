// H3-SWAP-STACK-01: private, segmented head replacement through the patched
// mere.run H3 guide-video interface. Nothing is downloaded here.
import { existsSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";
import { registerJobRunner, type Job } from "@/lib/jobs";
import { heavyGate, PausableProcess } from "@/lib/heavyGate";
import { defaultToolbox, type MediaToolbox } from "@/media/tools";
import { spawnRunner, type Runner } from "@/media/run";
import { workDir, commitResult } from "./results";
import { VideoError } from "./videoGen";

export const H3_SWAP_JOB_KIND = "h3-swap";
export const H3_SWAP_MAX_SECONDS = 10;
export const H3_SWAP_SEGMENT_FRAMES = 56;
const MODEL_ID = "video-minimax-h3-ref2va-mlx";
// Each model call handles 56 frames at 24 fps (about 2.333 seconds).
// A ten second window therefore needs at most ceil(10 / 2.333) = 5 segments.
const FPS = 24;
const GB = 1024 ** 3;
const PEAK = { "640x480": 112 * GB, "512x384": 85 * GB } as const;
const PROMPT = `head_swap:\n\nsubject_definitions:\n\n<Subject 1> is the reference head identity from <Picture 1>, <Picture 2> and <Picture 3>, including the complete head, facial identity, facial structure, head shape, hairstyle, hairline, skin appearance, proportions, and all distinctive visual features.\n\nFacial details of <Subject 1>:\n{description}\n\n<Subject 2> is the original person in <Video 1>, whose body, neck, clothing, pose, physical proportions below the head, actions, motion, timing, and interaction with the environment must remain unchanged.\n\n<Video 1> is the source video for the target video edit, providing the original body performance, motion, camera movement, framing, timing, lighting, environment, scene composition, and temporal structure.\n\nsummary:\n\n[video editing + reference generation]\n\nThe target video is an edited version of <Video 1>. Replace only the entire head of <Subject 2> with the reference head identity defined by <Subject 1> from <Picture 1>. Preserve the source video's body, clothing, performance, motion, camera behavior, environment, lighting, timing, and composition.\n\nretention_analysis:\n\n<Subject 1> (appears throughout the target video): attribute_transfer - the complete head identity from <Picture 1>, including facial identity, facial structure, hairstyle, head shape, proportions, skin appearance, and distinctive features, is transferred consistently onto the body of <Subject 2>.\n\n<Subject 2> (appears throughout the target video): partially_preserved - the original body, neck position, clothing, pose, motion, gestures, actions, and physical performance are preserved, while only the original head is replaced.\n\n<Video 1> (entire target timeline): partially_preserved - the original video timing, body motion, camera movement, framing, lighting, background, environment, scene composition, and temporal structure are preserved; only the subject's head appearance is modified.\n\ndetailed_description:\n\nPreserve <Video 1> as the complete temporal and compositional foundation of the target video. Replace only the entire original head of <Subject 2> with <Subject 1>. Maintain strong temporal consistency and do not alter the body, clothing, action, background, camera or composition.\n\noverall_soundscape:\n\nPreserve the original audiovisual timing.\n\nnon_diegetic_music:\nN/A`;

export interface SwapInput { source: string; references: Uint8Array[]; referenceTypes: string[]; description: string; size: "640x480" | "512x384"; start: number; seconds: number; }
export interface SwapDeps { run: Runner; toolbox: MediaToolbox; sleep: (ms: number, signal?: AbortSignal) => Promise<void>; }
const defaultSleep: SwapDeps["sleep"] = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new VideoError("cancelled", "Cancelled.", 499)); }, { once: true });
});
let deps: SwapDeps = { run: spawnRunner, toolbox: defaultToolbox, sleep: defaultSleep };
export function useH3SwapDepsForTests(value: SwapDeps | null): void { deps = value ?? { run: spawnRunner, toolbox: defaultToolbox, sleep: defaultSleep }; }
export function h3SwapPaths(): { binary: string; lora: string; models: string } {
  const home = process.env.MAIPAI_H3_VIDEO_HOME || "";
  return { binary: process.env.MAIPAI_H3_SWAP_BIN || join(home, "mere-run-src/src/.build/release/mere.run"), lora: process.env.MAIPAI_H3_SWAP_LORA || join(home, "models/minimax_h3/loras/bfs/minimax_h3_head_swap_v1.0_r32.safetensors"), models: process.env.MERERUN_MODELS_DIR || join(home, "mererun-models") };
}
export function h3SwapReady(): boolean { const paths = h3SwapPaths(); return !!paths.binary && !!paths.lora && !!paths.models && existsSync(paths.binary) && existsSync(paths.lora) && existsSync(paths.models); }
export function h3SwapPeakBytes(size: SwapInput["size"]): number { return PEAK[size]; }
/** Segments needed for a window. A window a hair over a whole number of segments (2.34 s against 2.333 s) uses the whole number: the leftover is under one frame and a segment of it cannot run. */
export function h3SwapSegmentCount(seconds: number): number { return Math.max(1, Math.ceil(seconds / (H3_SWAP_SEGMENT_FRAMES / FPS) - 0.05)); }

export function h3SwapMemory(input: Record<string, unknown>) { const size = input.size === "512x384" ? "512x384" : "640x480"; const peak = PEAK[size]; return { requestedBytes: peak, measuredPeakBytes: peak, engine: "minimax-h3-head-swap" }; }
function swapRoot(): string { return join(dataDir, "tmp", "video-swap"); }
function prompt(description: string, references: number): string {
  const pictures = Array.from({ length: references }, (_, i) => `<Picture ${i + 1}>`).join(", ");
  return PROMPT.replaceAll("<Picture 1>, <Picture 2> and <Picture 3>", pictures).replace("from <Picture 1>", `from ${pictures}`).replace("{description}", description);
}
export function h3SwapCommand(input: { binary: string; lora: string; models: string; width: number; height: number; frames: number; guide: string; output: string; references: string[]; description: string; /** The pack recipe, filled; the built-in text when absent. */ prompt?: string; seed?: number; adapterStrength?: number }): { argv: string[]; env: Record<string, string> } {
  return { argv: [input.binary, "video", "generate", input.prompt ?? prompt(input.description, input.references.length), "--model", MODEL_ID, "--width", String(input.width), "--height", String(input.height), "--num-frames", String(input.frames), "--seed", String(input.seed ?? 42), ...input.references.flatMap((path) => ["--reference", `image:${path}`]), "--h3-guide-video", input.guide, "--h3-lora", `${input.lora}:${input.adapterStrength === undefined ? "1.0" : Number.isInteger(input.adapterStrength) ? input.adapterStrength.toFixed(1) : input.adapterStrength}`, "--h3-weight-mode", "quantized", "--output", input.output], env: { MERERUN_MODELS_DIR: input.models } };
}
function cancelled(signal: AbortSignal): void { if (signal.aborted) throw new VideoError("cancelled", "Cancelled.", 499); }
async function run(args: string[], signal: AbortSignal, env?: Record<string, string>) {
  const result = await deps.run(args, { signal, collectStdout: true, ...(env ? { env } : {}) });
  if (result.aborted || signal.aborted) throw new VideoError("cancelled", "Cancelled.", 499);
  return result;
}

export function registerH3SwapJobs(): void {
  registerJobRunner(H3_SWAP_JOB_KIND, async (job: Job, signal, update) => {
    const input = job.input as { token: string; size: SwapInput["size"]; seconds: number; start: number; defaultWindow?: boolean };
    const staged = pending.get(input.token); pending.delete(input.token);
    if (!staged) throw new VideoError("failed", "The request was not received. Send it again.", 400);
    const root = join(swapRoot(), job.id); rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true, mode: 0o700 });
    const paths = h3SwapPaths(); const width = Number(input.size.split("x")[0]); const height = Number(input.size.split("x")[1]);
    const ffmpeg = await deps.toolbox.path("ffmpeg", (status) => update({ status }), signal);
    const ffprobe = await deps.toolbox.path("ffprobe", (status) => update({ status }), signal);
    const lease = heavyGate.attach({ role: "video", jobId: job.id, worker: new PausableProcess(null) });
    const started = Date.now();
    try {
      update({ status: "Checking the clip" });
      const probed = await run([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", staged.source], signal);
      const duration = Number(probed.stdout.trim());
      if (probed.code !== 0 || !Number.isFinite(duration)) throw new VideoError("bad_source", "Choose an MP4 clip with a readable picture and sound.", 422);
      if (duration < 3) throw new VideoError("source_too_short", "The clip must be at least 3 seconds.", 422);
      if (duration > 30) throw new VideoError("source_too_long", "The source clip is longer than 30 seconds.", 422);
      if (input.start >= duration) throw new VideoError("bad_window", "Choose a window that fits inside the source clip.", 422);
      if (input.defaultWindow) input.seconds = Math.min(input.seconds, duration - input.start);
      else if (input.start + input.seconds > duration + 0.05) throw new VideoError("bad_window", "Choose a window that fits inside the source clip.", 422);
      if (input.seconds < 2.3) throw new VideoError("source_too_short", "The clip must be at least 3 seconds.", 422);
      const count = h3SwapSegmentCount(input.seconds); const segmentPaths: string[] = [];
      const sourceAudio = join(root, "source-audio.m4a");
      const audio = await run([ffmpeg, "-y", "-ss", String(input.start), "-i", staged.source, "-t", String(input.seconds), "-vn", "-c:a", "aac", sourceAudio], signal);
      if (audio.code !== 0) throw new VideoError("bad_source", "The source clip's sound could not be read.", 422);
      for (let index = 0; index < count; index++) {
        cancelled(signal);
        // The last segment is anchored at end - 2.333s; it overlaps its
        // predecessor and the overlap is removed from its output at stitch time.
        const segmentSeconds = H3_SWAP_SEGMENT_FRAMES / FPS;
        const offset = index === count - 1 ? input.start + input.seconds - segmentSeconds : input.start + index * segmentSeconds;
        const end = Math.min(input.start + input.seconds, offset + segmentSeconds);
        const frames = Math.round((end - offset) * FPS);
        const guide = join(root, `guide-${index}.mp4`); const output = join(root, `swap-${index}.mp4`);
        update({ status: `Preparing segment ${index + 1} of ${count}`, percent: Math.floor(index / count * 90) });
        const crop = `[0:v]${"scale=" + width + ":" + height + ":force_original_aspect_ratio=increase,crop=" + width + ":" + height + ",fps=24"}[v]`;
        const cut = await run([ffmpeg, "-y", "-ss", String(offset), "-i", staged.source, "-t", String(frames / FPS), "-filter_complex", crop, "-map", "[v]", "-an", "-frames:v", String(frames), "-c:v", "libx264", "-crf", "14", guide], signal);
        if (cut.code !== 0) throw new VideoError("bad_source", "The source clip could not be prepared. Choose a clip where the person's head is clearly visible.", 422);
        const refs = staged.references.map((bytes, ref) => { const path = join(root, `reference-${ref + 1}.${staged.referenceTypes[ref]}`); writeFileSync(path, bytes, { mode: 0o600 }); return path; });
        const command = h3SwapCommand({ binary: paths.binary, lora: paths.lora, models: paths.models, width, height, frames, guide, output, references: refs, description: staged.description });
        let result: Awaited<ReturnType<typeof run>> | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          result = await run(command.argv, signal, command.env);
          if (result.code === 0 && existsSync(output)) break;
          if (result.code !== 133 || attempt === 2) throw new VideoError("failed", `The head swap could not finish segment ${index + 1}. The model stopped after ${attempt} retries. Try again with a shorter clip or smaller size.`, 500);
          update({ status: `Waiting to retry segment ${index + 1}` }); await deps.sleep(30_000, signal);
        }
        segmentPaths.push(output); update({ status: `Finished segment ${index + 1} of ${count}`, percent: Math.floor((index + 1) / count * 90) });
      }
      cancelled(signal);
      const concatFile = join(root, "segments.txt"); writeFileSync(concatFile, segmentPaths.map((path) => `file '${path.replaceAll("'", "'\\''")}'`).join("\n"));
      const stitched = join(root, "stitched.mp4");
      let step = await run([ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", concatFile, "-c", "copy", stitched], signal);
      if (step.code !== 0) throw new VideoError("failed", "The swapped segments could not be joined.", 500);
      const cropped = join(root, "window.mp4");
      const overlap = Math.max(0, count * (H3_SWAP_SEGMENT_FRAMES / FPS) - input.seconds);
      const trims = segmentPaths.map((_, index) => index === 0 ? "" : ` [${index}:v]trim=start=${Math.max(0, H3_SWAP_SEGMENT_FRAMES / FPS - (index === count - 1 ? overlap : 0))},setpts=PTS-STARTPTS[v${index}]`).filter(Boolean).join(";");
      const inputs = segmentPaths.flatMap((path) => ["-i", path]);
      step = await run([ffmpeg, "-y", ...inputs, "-filter_complex", `${trims}${trims ? ";" : ""}${segmentPaths.map((_, index) => `[${index === 0 ? "0:v" : `v${index}`}]`).join("")}concat=n=${count}:v=1:a=0,trim=duration=${input.seconds},setpts=PTS-STARTPTS[outv]`, "-map", "[outv]", "-an", "-c:v", "libx264", "-crf", "14", cropped], signal);
      if (step.code !== 0) throw new VideoError("failed", "The swapped segments could not be trimmed to the requested window.", 500);
      const laid = join(root, "audio-laid.mp4");
      step = await run([ffmpeg, "-y", "-i", cropped, "-i", sourceAudio, "-map", "0:v:0", "-map", "1:a?", "-t", String(input.seconds), "-c:v", "copy", "-c:a", "aac", "-shortest", laid], signal);
      if (step.code !== 0) throw new VideoError("failed", "The source sound could not be added to the swapped clip.", 500);
      const final = join(root, "video.mp4");
      step = await run([ffmpeg, "-y", "-i", laid, "-vf", "scale=iw*2:ih*2:flags=lanczos,unsharp=5:5:0.4", "-c:v", "libx264", "-crf", "14", "-c:a", "copy", final], signal);
      if (step.code !== 0 || !existsSync(final)) throw new VideoError("failed", "The finished clip could not be written.", 500);
      const poster = join(root, "poster.jpg"); step = await run([ffmpeg, "-y", "-i", final, "-frames:v", "1", "-q:v", "2", poster], signal);
      if (step.code !== 0 || !existsSync(poster)) throw new VideoError("failed", "The poster could not be made.", 500);
      commitResult({ job: job.id, created: Math.floor(Date.now() / 1000), width: width * 2, height: height * 2, frames: Math.ceil(input.seconds * FPS), fps: FPS, seconds: input.seconds, seed: 42, model: MODEL_ID, quality: "h3", audio: true, mode: "retake", lora_ids: [], ms: Date.now() - started, bytes: 0, poster_bytes: 0, mlx_peak_gb: PEAK[input.size] / GB }, root);
      update({ status: "done", percent: 100 }); return { job: job.id, segments: count, seconds: input.seconds, model: MODEL_ID };
    } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
    finally { lease.detach(); try { unlinkSync(staged.source); } catch { /* already removed */ } }
  }, { generator: { role: "video", memory: (job) => h3SwapMemory((job.input ?? {}) as Record<string, unknown>) } });
}

const pending = new Map<string, SwapInput>();
export function stashH3Swap(token: string, input: SwapInput): void { pending.set(token, input); }
export function unstashH3Swap(token: string): void { pending.delete(token); }

// SWAP-01: the donor step as an adapter a pack names (`adapter` on its swap job), so the generic make door never knows which model draws the donor.
// One call draws one segment guided by the original footage; the composite step (compositeSwap.ts) decides what of it reaches the final clip.
export const GUIDE_VIDEO_SWAP_ADAPTER = "guide-video-swap";
export interface DonorRequest { guide: string; output: string; references: string[]; prompt: string; seed: number; adapterStrength: number; width: number; height: number; frames: number; signal: AbortSignal; onStatus?: (status: string) => void }
export interface DonorAdapter { ready(): boolean; generate(request: DonorRequest): Promise<void> }
export const guideVideoSwapAdapter: DonorAdapter = {
  ready: () => h3SwapReady(),
  async generate(request) {
    const paths = h3SwapPaths();
    const command = h3SwapCommand({ ...paths, width: request.width, height: request.height, frames: request.frames, guide: request.guide, output: request.output, references: request.references, description: "", prompt: request.prompt, seed: request.seed, adapterStrength: request.adapterStrength });
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await run(command.argv, request.signal, command.env);
      if (result.code === 0 && existsSync(request.output)) return;
      if (result.code !== 133 || attempt === 2) throw new VideoError("failed", "The new head could not be drawn for one part of the clip. Try again with a shorter clip or a smaller size.", 500);
      request.onStatus?.("Waiting to retry one part of the clip"); await deps.sleep(30_000, request.signal);
    }
  },
};
export const DONOR_ADAPTERS: Readonly<Record<string, DonorAdapter>> = { [GUIDE_VIDEO_SWAP_ADAPTER]: guideVideoSwapAdapter };

/** Files a finished composite swap in the video result store, where the old swap route and the generic job routes serve it from. */
export function commitCompositeSwap(info: { job: string; width: number; height: number; fps: number; frames: number; seconds: number; seed: number; ms: number; peakBytes: number }, work: string): void {
  commitResult({ job: info.job, created: Math.floor(Date.now() / 1000), width: info.width, height: info.height, frames: info.frames, fps: info.fps, seconds: info.seconds, seed: info.seed, model: MODEL_ID, quality: "h3", audio: true, mode: "retake", lora_ids: [], ms: info.ms, bytes: 0, poster_bytes: 0, mlx_peak_gb: info.peakBytes / GB }, work);
}
