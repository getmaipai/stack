import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admit, release, withdraw, type GovernorHandle } from "@/lib/governor";
import { imageTools } from "@/imagetools/imageTools";
import { maskConfigPath, maskEnvironmentReady, maskModelPath, maskPython, maskWorkerEnv, maskWorkerScript } from "@/video/mask";
import { log } from "@/lib/log";
import type { JobProgress } from "@/lib/jobs";
import type { ProbeResult } from "./probe";
import type { Runner } from "./run";

export const CUTOUT_LIMIT_SECONDS = 60;
export const CUTOUT_MAX_WIDTH = 1920;
export const CUTOUT_NO_SUBJECT = "I couldn't find a clear subject to cut out. Say what to keep, or pick a clip where it is easier to see.";
export const CUTOUT_MODEL_MISSING = "The subject model is not installed yet. An admin can add it in Settings, Models and storage.";
export const CUTOUT_NO_MEMORY = "Home is busy with something larger. Try again in a minute.";
export const CUTOUT_FAILED = "Cutting out the subject stopped unexpectedly. Try again, or try a shorter clip.";
const GB = 1_000_000_000;
type Cutout = { background: string; feather_px: number; subject?: { frame?: number; box?: [number, number, number, number]; point?: { x: number; y: number } } };
function boxValid(box: number[], width: number, height: number): boolean { return box.length === 4 && box[0]! >= 0 && box[1]! >= 0 && box[2]! <= width && box[3]! <= height && box[2]! > box[0]! && box[3]! > box[1]!; }
export function cutoutSubjectProblem(subject: Cutout["subject"], width: number, height: number, frameCount: number): string | null {
  if (subject?.frame !== undefined && (!Number.isInteger(subject.frame) || subject.frame < 0 || subject.frame >= frameCount)) return "The subject frame must be inside the clip.";
  if (subject?.box && !boxValid(subject.box, width, height)) return "The subject box must fit inside the clip frame.";
  if (subject?.point && (subject.point.x < 0 || subject.point.y < 0 || subject.point.x >= width || subject.point.y >= height)) return "The subject point must be inside the clip frame.";
  return null;
}
export function chooseCutoutSubject<T extends { x: number; y: number; w: number; h: number; area: number; kind?: string }>(subjects: T[]): T | null {
  const preferred = subjects.filter((s) => s.kind === "person" || s.kind === "animal");
  return [...(preferred.length ? preferred : subjects)].sort((a, b) => b.area - a.area)[0] ?? null;
}
async function runChecked(run: Runner, argv: string[], signal: AbortSignal): Promise<void> { const result = await run(argv, { signal }); if (result.aborted || signal.aborted) throw new Error("Cancelled."); if (result.code !== 0) throw new Error(result.stderr || `tool exited ${result.code}`); }

export function cutoutCompositeArgs(args: { ffmpeg: string; input: string; output: string; masksDir: string; probe: ProbeResult; background: string; featherPx: number }): string[] {
  const { ffmpeg, input, output, masksDir, probe, background, featherPx } = args;
  const width = probe.width ?? 0, height = probe.height ?? 0;
  const frameRate = probe.streams.find((s) => s.type === "video" && !s.cover_art)?.fps ?? 30;
  const feather = featherPx ? `,gblur=sigma=${Math.max(0.1, featherPx / 2)}` : "";
  if (background === "transparent") return [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-i", input, "-framerate", String(frameRate), "-i", join(masksDir, "%05d.png"), "-filter_complex", `[0:v]format=rgba[fg];[1:v]format=gray${feather}[m];[fg][m]alphamerge[out]`, "-map", "[out]", "-map", "0:a?", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-c:a", ["opus", "vorbis"].includes(probe.audio_codec ?? "") ? "copy" : "libopus", "-shortest", output];
  const back = background === "blur" ? "[0:v]split[orig][b0];[b0]gblur=sigma=24[bg];[orig]format=rgba[fg];" : `color=c=${background === "green" ? "0x00ff00" : background === "black" ? "black" : background === "white" ? "white" : background.startsWith("#") ? `0x${background.slice(1)}` : background}:s=${width}x${height}:r=${frameRate}[bg];[0:v]format=rgba[fg];`;
  const graph = `${back}[1:v]format=gray${feather}[m];[fg][m]alphamerge[cut];[bg][cut]overlay=shortest=1,format=yuv420p[out]`;
  const codec = probe.video_codec === "hevc" ? "libx265" : probe.video_codec === "mpeg4" ? "mpeg4" : "libx264";
  return [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-i", input, "-framerate", String(frameRate), "-i", join(masksDir, "%05d.png"), "-filter_complex", graph, "-map", "[out]", "-map", "0:a?", "-c:v", codec, "-c:a", "copy", "-shortest", output];
}

async function track(options: { python: string; script: string; env: Record<string, string>; framesDir: string; outDir: string; model: string; config: string; prompt: Record<string, unknown>; total: number; progress: JobProgress; signal: AbortSignal }): Promise<void> {
  const child = Bun.spawn([options.python, options.script], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: options.env });
  let stderr = ""; void new Response(child.stderr).text().then((text) => { stderr = text; });
  const kill = () => { try { child.kill("SIGTERM"); } catch { /* already exited */ } };
  if (options.signal.aborted) kill(); else options.signal.addEventListener("abort", kill, { once: true });
  child.stdin.write(JSON.stringify({ id: randomUUID(), op: "track", frames_dir: options.framesDir, prompt: options.prompt, out_dir: options.outDir, model: options.model, config: options.config }) + "\n"); child.stdin.end();
  let buffer = "", ok = false;
  try {
    for await (const chunk of child.stdout) {
      buffer += new TextDecoder().decode(chunk);
      let split: number;
      while ((split = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, split); buffer = buffer.slice(split + 1);
        try { const msg = JSON.parse(line) as { progress?: number; total?: number; ok?: boolean; error?: string };
          if (typeof msg.progress === "number") options.progress({ percent: Math.min(95, Math.round(msg.progress / options.total * 95)), status: "tracking the subject" });
          if (msg.ok === true) ok = true;
          if (msg.error) throw new Error(msg.error);
        } catch (error) { if (error instanceof SyntaxError) continue; throw error; }
      }
    }
    const code = await child.exited;
    if (options.signal.aborted) throw new Error("Cancelled.");
    if (!ok || code !== 0) throw new Error(stderr || "SAM worker stopped without a result");
  } finally { options.signal.removeEventListener("abort", kill); }
}

export async function cutoutClip(args: { run: Runner; ffmpeg: string; input: string; output: string; work: string; probe: ProbeResult; op: Cutout; signal: AbortSignal; progress: JobProgress }): Promise<void> {
  const { run, ffmpeg, input, output, work, probe, op, signal, progress } = args;
  const width = probe.width ?? 0, height = probe.height ?? 0, duration = probe.duration_s ?? 0;
  if (duration > CUTOUT_LIMIT_SECONDS || width > CUTOUT_MAX_WIDTH) throw new Error("Cutouts are limited to clips of 60 seconds or less and 1920 pixels wide. Trim or resize the clip first.");
  if (!probe.has_video || width < 1 || height < 1) throw new Error("This clip needs a readable picture to cut out a subject.");
  if (op.subject?.box && !boxValid(op.subject.box, width, height)) throw new Error("The subject box must fit inside the clip frame.");
  if (op.subject?.point && (op.subject.point.x < 0 || op.subject.point.y < 0 || op.subject.point.x >= width || op.subject.point.y >= height)) throw new Error("The subject point must be inside the clip frame.");
  const model = maskModelPath();
  if (!model || !maskEnvironmentReady()) throw new Error(CUTOUT_MODEL_MISSING);
  const framesDir = join(work, "cutout-frames"), masksDir = join(work, "cutout-masks");
  mkdirSync(framesDir, { recursive: true }); mkdirSync(masksDir, { recursive: true });
  let lease: GovernorHandle | null = null;
  let queuedCancel: (() => void) | null = null;
  try {
    progress({ status: "preparing clip frames", percent: 0 });
    await runChecked(run, [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-i", input, "-map", "0:v:0", "-an", "-vf", "format=yuvj420p", "-q:v", "3", "-vsync", "0", join(framesDir, "%05d.jpg")], signal);
    const names = readdirSync(framesDir).filter((name) => name.endsWith(".jpg")).sort();
    if (!names.length) throw new Error("No video frames were decoded.");
    let prompt: Record<string, unknown>;
    if (op.subject?.box) {
      prompt = { frame: op.subject.frame ?? 0, box: op.subject.box };
    } else if (op.subject?.point) {
      const { x, y } = op.subject.point;
      prompt = { frame: op.subject.frame ?? 0, points: [{ x, y, label: 1 }] };
    } else {
      const frame = op.subject?.frame ?? 0;
      if (frame >= names.length) throw new Error("The subject frame must be inside the clip.");
      const detection = await imageTools.run({ operation: "find_subjects", image: new Uint8Array(await Bun.file(join(framesDir, names[frame]!)).arrayBuffer()) }, { signal, onStatus: (status) => progress({ status }) });
      const winner = chooseCutoutSubject(detection.subjects ?? []);
      if (!winner) throw new Error(CUTOUT_NO_SUBJECT);
      const box = [winner.x * width, winner.y * height, (winner.x + winner.w) * width, (winner.y + winner.h) * height];
      prompt = { frame, box };
    }
    const governorId = `mask-${randomUUID()}`;
    queuedCancel = () => withdraw(governorId);
    signal.addEventListener("abort", queuedCancel, { once: true });
    if (signal.aborted) queuedCancel();
    const request = await admit({ id: governorId, role: "video", kind: "generator", class: "burst", requestedBytes: 6 * GB, measuredPeakBytes: 6 * GB });
    if ("refused" in request) throw new Error(CUTOUT_NO_MEMORY);
    if ("queued" in request) {
      progress({ status: "waiting for room to track the subject" });
      const admitted = await request.admitted;
      if (signal.aborted) throw new Error("Cancelled.");
      if ("refused" in admitted) throw new Error(CUTOUT_NO_MEMORY);
      lease = admitted;
    } else lease = request;
    signal.removeEventListener("abort", queuedCancel);
    queuedCancel = null;
    await track({ python: maskPython(), script: maskWorkerScript, env: maskWorkerEnv(), framesDir, outDir: masksDir, model, config: maskConfigPath(), prompt, total: names.length, progress, signal });
    const masks = readdirSync(masksDir).filter((name) => name.endsWith(".png"));
    if (masks.length !== names.length) throw new Error("SAM produced an incomplete set of masks.");
    const argv = cutoutCompositeArgs({ ffmpeg, input, output, masksDir, probe, background: op.background, featherPx: op.feather_px });
    progress({ status: "compositing the clip", percent: 96 });
    await runChecked(run, argv, signal);
    if (!existsSync(output)) throw new Error("Compositing did not create a result.");
    progress({ status: "cutout ready", percent: 100 });
  } finally { if (queuedCancel) signal.removeEventListener("abort", queuedCancel); if (lease) release(lease); rmSync(framesDir, { recursive: true, force: true }); rmSync(masksDir, { recursive: true, force: true }); }
}
