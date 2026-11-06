import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ImageToolError, imageTools } from "@/imagetools/imageTools";
import type { JobProgress } from "@/lib/jobs";
import type { ProbeResult } from "./probe";
import type { Runner } from "./run";

export const UPSCALE_MAX_SECONDS = 60;
export const UPSCALE_DEADLINE_MS = 20 * 60_000;
export const UPSCALE_ESTIMATE_SECONDS_PER_FRAME = 1.2;
export const UPSCALE_MAX_INPUT_PIXELS = 6_000_000;

export interface UpscaleDeps {
  runImage: typeof imageTools.run;
}
const deps: UpscaleDeps = { runImage: imageTools.run.bind(imageTools) };
export class UpscaleFailure extends Error { constructor(readonly code: string, message: string) { super(message); } }
export function setUpscaleDepsForTests(overrides: Partial<UpscaleDeps>): void { Object.assign(deps, overrides); }
export function resetUpscaleDepsForTests(): void { deps.runImage = imageTools.run.bind(imageTools); }

const failMessage = (error: unknown): never => {
  if (error instanceof ImageToolError && error.code === "model_missing" || error instanceof Error && "code" in error && error.code === "model_missing") throw new UpscaleFailure("model_missing", "The sharpening model is not installed yet. An admin can add it in Settings, Models and storage.");
  if (error instanceof ImageToolError && error.code === "no_memory" || error instanceof Error && "code" in error && error.code === "no_memory") throw new UpscaleFailure("no_memory", "Home is busy with something larger. Try again in a minute.");
  throw error;
};

export function upscaleProblem(probe: ProbeResult): string | null {
  const width = probe.width ?? 0, height = probe.height ?? 0;
  if (width * height > UPSCALE_MAX_INPUT_PIXELS) return `This clip is ${width} by ${height} pixels per frame, over the 6 megapixel sharpening limit. Resize it first.`;
  if ((probe.duration_s ?? 0) > UPSCALE_MAX_SECONDS) return `This clip is longer than 60 seconds, the sharpening limit. Trim it to 60 seconds or less first.`;
  const fps = probe.streams.find((stream) => stream.type === "video" && !stream.cover_art)?.fps ?? 24;
  const frames = Math.ceil((probe.duration_s ?? 0) * fps);
  if (frames * UPSCALE_ESTIMATE_SECONDS_PER_FRAME > UPSCALE_DEADLINE_MS / 1000) return `This clip needs about ${Math.ceil(frames * UPSCALE_ESTIMATE_SECONDS_PER_FRAME / 60)} minutes to sharpen, over the 20 minute limit. Trim it first.`;
  return null;
}

/** Processes a bounded batch of PNG frames at once, preserving the source streams and audio. */
export async function upscaleClip(options: {
  ffmpeg: string; run: Runner; input: string; target: string; work: string; probe: ProbeResult;
  signal: AbortSignal; progress: JobProgress; basePercent: number; percentSpan: number;
  frameOffset?: number;
}): Promise<void> {
  const { ffmpeg, run, input, target, work, probe, signal, progress } = options;
  const width = probe.width ?? 0, height = probe.height ?? 0;
  const outWidth = Math.max(2, Math.round(width * 2 / 2) * 2), outHeight = Math.max(2, Math.round(height * 2 / 2) * 2);
  const fps = probe.streams.find((stream) => stream.type === "video" && !stream.cover_art)?.fps ?? 24;
  const count = Math.max(1, Math.round((probe.duration_s ?? 0) * fps));
  const dir = join(work, `upscale-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const checkAbort = () => { if (signal.aborted) throw new Error("Cancelled."); };
  const ff = async (argv: string[]) => {
    checkAbort();
    const result = await run(argv, { signal });
    if (result.aborted || signal.aborted) throw new Error("Cancelled.");
    if (result.code !== 0) throw new Error(`The clip could not be sharpened. ${result.stderr.trim().slice(-400)}`);
  };
  const ffBase = [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y"];
  try {
    let done = 0;
    while (done < count) {
      checkAbort();
      const batch = Math.min(8, count - done);
      const frameDir = join(dir, `batch-${Math.floor(done / 8)}`);
      mkdirSync(frameDir, { recursive: true, mode: 0o700 });
      const first = done;
      const pattern = join(frameDir, "%04d.png");
      await ff([...ffBase, "-i", input, "-vf", `select='between(n,${first},${first + batch - 1})'`, "-vsync", "0", "-frames:v", String(batch), pattern]);
      for (let i = 0; i < batch; i++) {
        checkAbort();
        const frame = join(frameDir, `${String(i + 1).padStart(4, "0")}.png`);
        // Ask the worker for the requested 2x result. `scale: 4` can exceed
        // its 36 MP output ceiling even when the input is within our 6 MP
        // per-frame limit, and would also leave the clip dependent on an
        // unnecessary four-times intermediate.
        const result = await deps.runImage({ operation: "upscale", image: new Uint8Array(await Bun.file(frame).arrayBuffer()), params: { scale: 2 } }, { signal });
        const fourX = join(frameDir, `up-${String(i + 1).padStart(4, "0")}.png`);
        await Bun.write(fourX, result.png);
        await ff([...ffBase, "-i", fourX, "-vf", `scale=${outWidth}:${outHeight}:flags=lanczos`, "-frames:v", "1", join(frameDir, `scaled-${String(i + 1).padStart(4, "0")}.png`)]);
        rmSync(frame, { force: true }); rmSync(fourX, { force: true });
        done++;
        progress({ status: `sharpening frame ${done} of ${count}`, percent: Math.min(99, options.basePercent + Math.round(done / count * options.percentSpan)) });
      }
      const segment = join(dir, `batch-${Math.floor(first / 8)}.mkv`);
      await ff([...ffBase, "-framerate", String(fps), "-start_number", "1", "-i", join(frameDir, "scaled-%04d.png"), "-frames:v", String(batch), "-c:v", "ffv1", "-f", "matroska", segment]);
      const list = join(dir, "segments.txt");
      const previous = await Bun.file(list).exists() ? await Bun.file(list).text() : "";
      await Bun.write(list, `${previous}file '${segment.replace(/'/g, "'\\''")}'\n`);
      rmSync(frameDir, { recursive: true, force: true });
    }
    checkAbort();
    const list = join(dir, "segments.txt");
    const encoded = await run([...ffBase, "-f", "concat", "-safe", "0", "-i", list, "-i", input, "-map", "0:v:0", "-map", "1:a:0?", "-c:v", probe.video_codec === "hevc" ? "libx265" : "libx264", ...(probe.video_codec === "hevc" ? ["-tag:v", "hvc1"] : []), "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(fps), "-c:a", "copy", "-shortest", "-movflags", "+faststart", target], { signal });
    if (encoded.aborted || signal.aborted) throw new Error("Cancelled.");
    if (encoded.code !== 0) throw new Error(`The clip could not be sharpened. ${encoded.stderr.trim().slice(-400)}`);
  } catch (error) { failMessage(error); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
