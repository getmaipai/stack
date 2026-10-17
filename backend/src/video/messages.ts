// A clip any messaging app takes (VIDEOSHARE-01). The worker's mp4 is a plain H.264 file with no audio track; that
// plays everywhere, but a phone's share sheet and some chat apps treat a video with no sound track as a file to
// attach rather than a clip to play. This makes the same picture with a silent AAC track, H.264 yuv420p (copied
// when it already is, re-encoded within a 1280 pixel edge and the size cap when not), the moov box first and a
// title. Every new clip gets it as its stored file (video/videoGen.ts); the stateless route converts a clip
// made before this. One definition: both callers use makeMessagesCopy. ffmpeg is the one bundled with the video
// environment (imageio-ffmpeg) or the one VIDEO_FFMPEG names.
import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { uvVenvPath } from "@/lib/uvEnvironment";

/** Messages and most chat apps cap a video attachment at 100 MB or more; 20 MB keeps an email and a text both open. */
export const MESSAGES_MAX_BYTES = 20 * 1024 * 1024;
export const MESSAGES_MAX_EDGE = 1280;

export function ffmpegPath(root: string): string | null {
  const named = process.env.VIDEO_FFMPEG;
  if (named !== undefined) return named !== "" && existsSync(named) ? named : null;
  try {
    const dir = join(uvVenvPath(root), "lib", "python3.12", "site-packages", "imageio_ffmpeg", "binaries");
    const file = readdirSync(dir).find((name) => name.startsWith("ffmpeg"));
    return file ? join(dir, file) : null;
  } catch { return null; }
}

export interface ClipFacts { videoCodec: string | null; pixelFormat: string | null; width: number; height: number; hasAudio: boolean }

/** Reads the facts the plan needs from `ffmpeg -i` (it prints the streams on stderr and exits 1 for want of an output). */
export function parseProbe(text: string): ClipFacts {
  const video = /Stream #\S+: Video: (\w+)[^,\n]*(?:\([^)]*\))?[^,\n]*, (\w+)[^,\n]*, (\d{2,5})x(\d{2,5})/.exec(text);
  return { videoCodec: video?.[1] ?? null, pixelFormat: video?.[2] ?? null, width: Number(video?.[3] ?? 0), height: Number(video?.[4] ?? 0), hasAudio: /Stream #\S+: Audio:/.test(text) };
}

export async function probeClip(ffmpeg: string, file: string): Promise<ClipFacts> {
  const proc = Bun.spawn([ffmpeg, "-hide_banner", "-i", file], { stdout: "ignore", stderr: "pipe" });
  const text = await new Response(proc.stderr).text();
  await proc.exited;
  return parseProbe(text);
}

/** The ffmpeg arguments for a messaging copy of `facts`' clip; `reencode` is true when the picture cannot be copied. */
export function messagesArgs(input: string, output: string, facts: ClipFacts, title: string, forceReencode = false): string[] {
  const fits = facts.videoCodec === "h264" && facts.pixelFormat === "yuv420p" && Math.max(facts.width, facts.height) <= MESSAGES_MAX_EDGE && facts.width % 2 === 0 && facts.height % 2 === 0;
  const copy = fits && !forceReencode;
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", input];
  if (!facts.hasAudio) args.push("-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo");
  args.push("-map", "0:v:0", "-map", facts.hasAudio ? "0:a:0" : "1:a:0");
  if (copy) args.push("-c:v", "copy");
  else args.push("-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-crf", forceReencode ? "27" : "21", "-vf", `scale='min(${MESSAGES_MAX_EDGE},iw)':'min(${MESSAGES_MAX_EDGE},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`);
  args.push("-tag:v", "avc1", "-c:a", "aac", "-b:a", "96k", "-ar", "44100", "-shortest", "-movflags", "+faststart", "-map_metadata", "-1", "-metadata", `title=${title}`, "-f", "mp4", output);
  return args;
}

export class MessagesError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** Writes the messaging copy of `input` to `output` (they may be the same path). Throws MessagesError. */
export async function makeMessagesCopy(input: string, output: string, title: string, root: string): Promise<{ bytes: number; reencoded: boolean }> {
  const ffmpeg = ffmpegPath(root);
  if (!ffmpeg) throw new MessagesError("no_ffmpeg", "The video tools are not installed on this computer, so the clip cannot be prepared for messages. Install video from Home's Engines page.");
  const facts = await probeClip(ffmpeg, input);
  if (!facts.videoCodec) throw new MessagesError("bad_clip", "That file is not a video this computer can read.");
  const temp = `${output}.part.mp4`;
  const run = async (force: boolean): Promise<void> => {
    rmSync(temp, { force: true });
    const proc = Bun.spawn([ffmpeg, ...messagesArgs(input, temp, facts, title, force)], { stdout: "ignore", stderr: "pipe" });
    const err = await new Response(proc.stderr).text();
    if ((await proc.exited) !== 0 || !existsSync(temp)) { rmSync(temp, { force: true }); throw new MessagesError("failed", `The clip could not be prepared for messages. ${err.trim().split("\n").pop() ?? ""}`.trim()); }
  };
  let reencoded = false;
  await run(false);
  if (statSync(temp).size > MESSAGES_MAX_BYTES) { await run(true); reencoded = true; }
  if (statSync(temp).size > MESSAGES_MAX_BYTES) { rmSync(temp, { force: true }); throw new MessagesError("too_large", "The clip is still over 20 MB after shrinking it. Make a shorter clip."); }
  renameSync(temp, output);
  return { bytes: statSync(output).size, reencoded };
}
