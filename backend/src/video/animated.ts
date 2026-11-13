import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { ffmpegPath } from "@/video/messages";

export type AnimatedFormat = "gif" | "webp";
export interface AnimatedOptions { width?: number; fps?: number; seconds?: number }
export const ANIMATED_MAX_BYTES = 25 * 1024 * 1024;
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
export function animatedArgs(format: AnimatedFormat, opts: AnimatedOptions = {}): string[] {
  const width = clamp(Math.round(opts.width ?? 480), 160, 720), fps = clamp(Math.round(opts.fps ?? 12), 5, 20);
  const scale = `fps=${fps},scale=${width}:-1:flags=lanczos`;
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", "INPUT"];
  if (format === "gif") return [...args, "-filter_complex", `[0:v]${scale},split[a][b];[a]palettegen[p];[b][p]paletteuse`, "-loop", "0", "OUTPUT"];
  return [...args, "-vf", scale, "-c:v", "libwebp_anim", "-loop", "0", "-q:v", "60", "OUTPUT"];
}
export class AnimatedError extends Error { constructor(readonly code: string, message: string) { super(message); } }
const encoders = new Map<string, Promise<boolean>>();
async function hasWebpEncoder(ffmpeg: string): Promise<boolean> {
  let check = encoders.get(ffmpeg);
  if (!check) {
    check = (async () => {
      const proc = Bun.spawn([ffmpeg, "-hide_banner", "-encoders"], { stdout: "pipe", stderr: "pipe" });
      const output = `${await new Response(proc.stdout).text()}\n${await new Response(proc.stderr).text()}`;
      await proc.exited;
      return /\blibwebp_anim\b/.test(output);
    })();
    encoders.set(ffmpeg, check);
  }
  return check;
}
/** Writes a bounded, looped GIF or animated WebP. All working files live under `root`. */
export async function makeAnimated(input: string, output: string, format: AnimatedFormat, opts: AnimatedOptions = {}, root: string): Promise<number> {
  const ffmpeg = ffmpegPath(root);
  if (!ffmpeg) throw new AnimatedError("no_ffmpeg", "Video tools are not installed on this computer. Install video from Home's Engines page, then try again.");
  if (format === "webp" && !(await hasWebpEncoder(ffmpeg))) throw new AnimatedError("format_unavailable", "This computer's video tools can't make WebP files. Save as GIF or MP4 instead.");
  mkdirSync(join(root, "tmp"), { recursive: true });
  const temp = `${output}.part.${format}`;
  const configured = animatedArgs(format, opts);
  configured[configured.indexOf("INPUT")] = input;
  configured[configured.indexOf("OUTPUT")] = temp;
  if (opts.seconds !== undefined && opts.seconds > 0) configured.splice(configured.indexOf("-i"), 0, "-t", String(Math.min(10, opts.seconds)));
  const proc = Bun.spawn([ffmpeg, ...configured], { stdout: "ignore", stderr: "pipe" });
  const err = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0 || !existsSync(temp)) {
    rmSync(temp, { force: true });
    throw new AnimatedError("failed", `The ${format.toUpperCase()} could not be made. ${err.trim().split("\n").pop() || "Check that the mp4 is readable, then try again."}`);
  }
  const bytes = statSync(temp).size;
  if (bytes > ANIMATED_MAX_BYTES) { rmSync(temp, { force: true }); throw new AnimatedError("too_large", "The animated file is over 25 MB. Lower the size or length, then try again."); }
  renameSync(temp, output);
  return bytes;
}
