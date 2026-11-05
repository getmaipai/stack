// EDITOR-11: the input of `media.edit` and the exact ffmpeg command lines of its
// ops. Pure functions: a test reads the arguments without a binary. One job
// takes `inputs[]`, `ops[]` and `output`; the ops run in order on a working
// clip that starts as inputs[0]. No shell, no network: every argument is a
// separate argv entry and every input is a local file the path guards passed.
import { z } from "zod";
import type { ProbeResult } from "./probe";

export const EDIT_OPS = ["trim", "concat", "mute", "frame", "audio_overlay", "fade", "crossfade", "gain", "reframe", "grade", "speed", "captions"] as const;
export const MIN_CROSSFADE_S = 0.3;
export const MAX_CROSSFADE_S = 1.0;
export const MAX_CROSSFADE_CLIPS = 6;
export const MAX_EDIT_OPS = 12;
export const MAX_EDIT_INPUTS = 24;
export const MAX_EDIT_SECONDS = 600;

const Path = z.string().min(1).max(4096);
const Index = z.number().int().min(0).max(MAX_EDIT_INPUTS - 1);
const Seconds = z.number().min(0).max(MAX_EDIT_SECONDS);

const TrimOp = z.object({ op: z.literal("trim"), in_s: Seconds.default(0), out_s: z.number().gt(0).max(MAX_EDIT_SECONDS) }).strict()
  .refine((op) => op.out_s > op.in_s, { path: ["out_s"], message: "must be after in_s" });
const ConcatOp = z.object({ op: z.literal("concat"), with: z.array(Index).min(1).max(MAX_EDIT_INPUTS - 1).optional() }).strict();
const MuteOp = z.object({ op: z.literal("mute") }).strict();
const FrameOp = z.object({ op: z.literal("frame"), at_s: Seconds.default(0) }).strict();
const AudioOverlayOp = z.object({
  op: z.literal("audio_overlay"),
  /** Index into inputs[] of the voice or music file (wav, mp3, or any audio). */
  input: Index,
  gain_db: z.number().min(-60).max(24).default(0),
  clip_gain_db: z.number().min(-60).max(24).default(0),
  start_s: Seconds.default(0),
  /** Lower the clip's own sound while the overlay plays. */
  duck: z.boolean().default(false),
  /** Loudness-normalise the mix to this integrated loudness. */
  loudness_lufs: z.number().min(-40).max(-5).optional(),
  /** Fade the overlay alone in over this many seconds from where it starts (the clip's own sound is untouched). */
  fade_in_s: Seconds.default(0),
  /** Fade the overlay alone out over this many seconds, ending where it ends. */
  fade_out_s: Seconds.default(0),
  /** Where the overlay ends, in seconds on the clip's timeline (after start_s). Without it the overlay plays to its own end. */
  end_s: z.number().gt(0).max(MAX_EDIT_SECONDS).optional(),
}).strict();
/** Change the level of the working clip's own sound by db (negative is quieter); the picture is copied. */
const GainOp = z.object({ op: z.literal("gain"), db: z.number().min(-60, "must be from -60 to 24 dB").max(24, "must be from -60 to 24 dB") }).strict();
const FadeOp = z.object({ op: z.literal("fade"), in_s: Seconds.default(0), out_s: Seconds.default(0) }).strict()
  .refine((op) => op.in_s > 0 || op.out_s > 0, { path: ["in_s"], message: "needs in_s or out_s above 0" });
const ReframeOp = z.object({ op: z.literal("reframe"), aspect: z.enum(["9:16", "1:1", "16:9", "4:5"]), fill: z.enum(["crop", "blur"]) }).strict();
const GradeOp = z.object({ op: z.literal("grade"), brightness: z.number().min(-1).max(1).optional(), contrast: z.number().min(-1).max(1).optional(), saturation: z.number().min(-1).max(1).optional(), warmth: z.number().min(-1).max(1).optional(), grain: z.number().min(0).max(1).optional(), vignette: z.number().min(0).max(1).optional() }).strict()
  .refine((op) => Object.entries(op).some(([key, value]) => key !== "op" && value !== undefined && value !== 0), { path: ["brightness"], message: "needs at least one value above or below 0" });
const SpeedOp = z.object({ op: z.literal("speed"), factor: z.number().min(0.25).max(4) }).strict();
// Speed ramps (from_factor, to_factor, at_s, over_s) are out of scope for this slice.
const CaptionsOp = z.object({ op: z.literal("captions"), lines: z.array(z.object({ from_s: Seconds, to_s: z.number().gt(0).max(MAX_EDIT_SECONDS), text: z.string().min(1).max(120) }).strict()).min(1).max(40), position: z.enum(["bottom", "middle", "top"]) }).strict()
  .refine((op) => op.lines.every((line) => line.to_s > line.from_s), { path: ["lines"], message: "each to_s must be after from_s" });

/** Joins like concat, but each seam blends the last duration_s of one clip into the first duration_s of the next. */
const CrossfadeOp = z.object({
  op: z.literal("crossfade"),
  duration_s: z.number().min(MIN_CROSSFADE_S, `must be from ${MIN_CROSSFADE_S} to ${MAX_CROSSFADE_S} seconds`).max(MAX_CROSSFADE_S, `must be from ${MIN_CROSSFADE_S} to ${MAX_CROSSFADE_S} seconds`).default(0.5),
  with: z.array(Index).min(1).max(MAX_EDIT_INPUTS - 1).optional(),
}).strict();

export const EditOp = z.union([TrimOp, ConcatOp, MuteOp, FrameOp, AudioOverlayOp, FadeOp, CrossfadeOp, GainOp, ReframeOp, GradeOp, SpeedOp, CaptionsOp]);
export type EditOp = z.infer<typeof EditOp>;

export const EditInput = z.object({
  inputs: z.array(Path).min(1).max(MAX_EDIT_INPUTS),
  ops: z.array(EditOp).min(1).max(MAX_EDIT_OPS),
  output: z.object({
    dir: Path.optional(),
    /** File name with extension: .mp4 or .mov for a clip, .png for a frame. */
    name: z.string().min(1).max(200).regex(/\.(mp4|mov|png)$/i, "must end in .mp4, .mov or .png"),
  }).strict(),
}).strict();
export type EditInput = z.infer<typeof EditInput>;

/** The plain sentence for a bad media.edit input, or null when the shape is fine. Checks the limits first so the person reads them in words. */
export function editInputProblem(input: unknown): string | null {
  const raw = (input ?? {}) as { inputs?: unknown; ops?: unknown };
  if (Array.isArray(raw.inputs) && raw.inputs.length > MAX_EDIT_INPUTS) return `An edit takes at most ${MAX_EDIT_INPUTS} files and this one lists ${raw.inputs.length}. Split it into two edits.`;
  if (Array.isArray(raw.ops)) {
    if (raw.ops.length > MAX_EDIT_OPS) return `An edit takes at most ${MAX_EDIT_OPS} steps and this one lists ${raw.ops.length}. Split it into two edits.`;
    for (let i = 0; i < raw.ops.length; i++) {
      const name = (raw.ops[i] as { op?: unknown } | null)?.op;
      if (typeof name !== "string" || !(EDIT_OPS as readonly string[]).includes(name)) return `Step ${i + 1} asks for ${JSON.stringify(name ?? null)}, which the media service does not know. The steps it knows are ${EDIT_OPS.join(", ")}.`;
    }
  }
  const parsed = EditInput.safeParse(input);
  if (parsed.success) return planProblem(parsed.data);
  const issue = parsed.error.issues[0];
  if (!issue) return "The edit is not valid.";
  const where = issue.path.length ? issue.path.map((part) => typeof part === "number" ? part + 1 : part).join(" > ") : "the edit";
  if (issue.code === "unrecognized_keys") return `${where} has a field the media service does not know (${(issue as { keys?: string[] }).keys?.join(", ")}). Check docs/integrations.md for the fields of media.edit.`;
  return `${where}: ${issue.message}. Check docs/integrations.md for the fields of media.edit.`;
}

/** Cross-field rules that need no file: indices exist, a frame ends the edit and goes to a .png, a clip does not go to a .png. */
function planProblem(input: EditInput): string | null {
  const last = input.ops.length - 1;
  const png = /\.png$/i.test(input.output.name);
  for (let i = 0; i < input.ops.length; i++) {
    const op = input.ops[i]!;
    if (op.op === "audio_overlay" && op.input >= input.inputs.length) return `Step ${i + 1} (audio_overlay) uses file ${op.input + 1}, but the edit lists only ${input.inputs.length}.`;
    if (op.op === "audio_overlay" && op.input === 0) return `Step ${i + 1} (audio_overlay) uses the clip itself as the overlay. List the voice or music as another file.`;
    if (op.op === "audio_overlay" && op.end_s !== undefined) {
      if (op.end_s <= op.start_s) return `Step ${i + 1} (audio_overlay) ends at ${op.end_s} s but starts at ${op.start_s} s. end_s must be after start_s.`;
      if (op.fade_in_s + op.fade_out_s > op.end_s - op.start_s) return `Step ${i + 1} (audio_overlay) fades for ${num(op.fade_in_s + op.fade_out_s)} s in all, longer than the ${num(op.end_s - op.start_s)} s between start_s and end_s. Use shorter fades.`;
    }
    if (op.op === "concat" && op.with?.some((index) => index >= input.inputs.length || index === 0)) return `Step ${i + 1} (concat) names a file that is not in the list (files after the first are 2 to ${input.inputs.length}).`;
    if (op.op === "concat" && input.inputs.length < 2) return `Step ${i + 1} (concat) needs at least two files.`;
    if (op.op === "crossfade" && op.with?.some((index) => index >= input.inputs.length || index === 0)) return `Step ${i + 1} (crossfade) names a file that is not in the list (files after the first are 2 to ${input.inputs.length}).`;
    if (op.op === "crossfade") {
      const clips = 1 + concatMembers(input, op).length;
      if (clips < 2) return `Step ${i + 1} (crossfade) needs at least two files.`;
      if (clips > MAX_CROSSFADE_CLIPS) return `Step ${i + 1} (crossfade) blends ${clips} clips and the limit is ${MAX_CROSSFADE_CLIPS}. Split it into two edits.`;
    }
    if (op.op === "frame" && i !== last) return `Step ${i + 1} (frame) makes a picture, so it must be the last step.`;
  }
  const endsInFrame = input.ops[last]!.op === "frame";
  if (endsInFrame && !png) return "A frame is a picture: the output name must end in .png.";
  if (!endsInFrame && png) return "Only a frame step makes a .png. Name the output .mp4 or .mov.";
  return null;
}

/** Input files that concat joins when it names none: every file after the first that no audio_overlay uses. */
export function concatMembers(input: EditInput, op: Extract<EditOp, { op: "concat" | "crossfade" }>): number[] {
  if (op.with) return op.with;
  const overlays = new Set(input.ops.flatMap((step) => step.op === "audio_overlay" ? [step.input] : []));
  return input.inputs.map((_, index) => index).filter((index) => index > 0 && !overlays.has(index));
}

// ---- command lines ----
const BASE = (ffmpeg: string): string[] => [ffmpeg, "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-progress", "pipe:1", "-nostats"];
const ENCODE_V = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"];
const ENCODE_A = ["-c:a", "aac", "-b:a", "160k"];
const FASTSTART = ["-movflags", "+faststart"];
const num = (value: number): string => String(Math.round(value * 1000) / 1000);

export interface Clip { path: string; probe: ProbeResult; }
const videoOf = (probe: ProbeResult) => probe.streams.find((stream) => stream.type === "video" && !stream.cover_art);

/** Trim copies the streams when the cut starts on a keyframe (or at 0), else re-encodes so the start is exact. The runner re-runs a copy that came out more than 40 ms off (B-frame delay) as an encode. */
export function trimArgs(ffmpeg: string, src: string, out: string, op: Extract<EditOp, { op: "trim" }>, probe: ProbeResult, startsOnKeyframe: boolean, forceEncode = false): { args: string[]; action: "copy" | "encode" } {
  const length = op.out_s - op.in_s;
  const copy = !forceEncode && probe.has_video && (op.in_s === 0 || startsOnKeyframe);
  const args = [...BASE(ffmpeg), "-ss", num(op.in_s), "-i", src, "-t", num(length), "-map", "0:v:0?", "-map", "0:a:0?", "-sn", "-dn"];
  if (copy) args.push("-c", "copy", "-avoid_negative_ts", "disabled");
  else { if (probe.has_video) args.push(...ENCODE_V); if (probe.has_audio) args.push(...ENCODE_A); }
  args.push(...FASTSTART, out);
  return { args, action: copy ? "copy" : "encode" };
}

export function keyframeArgs(ffprobe: string, src: string, from: number): string[] {
  return [ffprobe, "-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey", "-show_entries", "frame=pts_time", "-of", "csv=p=0", "-read_intervals", `${num(Math.max(0, from - 5))}%${num(from + 5)}`, "-i", src];
}
/** True when one of the keyframe times ffprobe printed is within half a frame of the cut. */
export function hasKeyframeAt(stdout: string, at: number, fps: number | null): boolean {
  const tolerance = Math.min(0.02, (fps ? 0.5 / fps : 0.02));
  return stdout.split("\n").some((line) => { const time = Number(line.trim().split(",")[0]); return Number.isFinite(time) && Math.abs(time - at) <= tolerance; });
}

export function muteArgs(ffmpeg: string, src: string, out: string): string[] {
  return [...BASE(ffmpeg), "-i", src, "-map", "0:v:0", "-an", "-sn", "-dn", "-c:v", "copy", ...FASTSTART, out];
}

export function frameArgs(ffmpeg: string, src: string, out: string, at: number): string[] {
  return [...BASE(ffmpeg), "-ss", num(at), "-i", src, "-map", "0:v:0", "-frames:v", "1", "-an", "-sn", "-dn", out];
}

/** The quoted line the concat demuxer reads. */
export const concatListLine = (path: string): string => `file '${path.replace(/'/g, "'\\''")}'`;

/** Whether the clips already agree on codec, size, rate, pixel format and audio layout, so the demuxer can join them without a re-encode. */
export function concatCompatible(clips: Clip[]): boolean {
  const key = (probe: ProbeResult): string => {
    const video = videoOf(probe);
    const audio = probe.streams.find((stream) => stream.type === "audio");
    return JSON.stringify([video?.codec, video?.width, video?.height, video?.fps, video?.pix_fmt, audio?.codec ?? null, audio?.sample_rate ?? null, audio?.channels ?? null]);
  };
  const first = key(clips[0]!.probe);
  return clips.every((clip) => clip.probe.has_video && key(clip.probe) === first);
}

export function concatCopyArgs(ffmpeg: string, listFile: string, out: string): string[] {
  return [...BASE(ffmpeg), "-f", "concat", "-safe", "0", "-i", listFile, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", ...FASTSTART, out];
}

/** Re-encode every clip to the first clip's size and rate (letterboxed, never stretched) and a 48 kHz stereo layout; a clip with no sound gets silence. */
export function concatEncodeArgs(ffmpeg: string, clips: Clip[], out: string): string[] {
  const target = videoOf(clips[0]!.probe)!;
  const width = Math.max(2, Math.round((target.width ?? 1280) / 2) * 2); const height = Math.max(2, Math.round((target.height ?? 720) / 2) * 2);
  const rate = target.fps && target.fps > 0 ? num(target.fps) : "30";
  const anyAudio = clips.some((clip) => clip.probe.has_audio);
  const args = [...BASE(ffmpeg)];
  for (const clip of clips) args.push("-i", clip.path);
  const parts: string[] = [];
  const joined: string[] = [];
  clips.forEach((clip, index) => {
    parts.push(`[${index}:v:0]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${rate},format=yuv420p[v${index}]`);
    joined.push(`[v${index}]`);
    if (anyAudio) {
      parts.push(clip.probe.has_audio
        ? `[${index}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]`
        : `anullsrc=r=48000:cl=stereo,atrim=0:${num(clip.probe.duration_s ?? 0)},aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]`);
      joined.push(`[a${index}]`);
    }
  });
  parts.push(`${joined.join("")}concat=n=${clips.length}:v=1:a=${anyAudio ? 1 : 0}[v]${anyAudio ? "[a]" : ""}`);
  args.push("-filter_complex", parts.join(";"), "-map", "[v]");
  if (anyAudio) args.push("-map", "[a]");
  args.push("-sn", "-dn", ...ENCODE_V);
  if (anyAudio) args.push(...ENCODE_A);
  args.push(...FASTSTART, out);
  return args;
}

/** Smallest clip length a crossfade of d seconds accepts: every clip must be longer than twice the blend. */
export const crossfadeMinLength = (d: number): number => 2 * d;

/**
 * Blend each seam: video with xfade (fade, d seconds, offset = sum of the lengths so far minus k*d) and sound with acrossfade (d seconds).
 * Every clip is first fitted to the first clip's size and rate (letterboxed) and 48 kHz stereo; a clip with no sound gets silence when any clip has sound.
 */
export function crossfadeArgs(ffmpeg: string, clips: Clip[], d: number, out: string): string[] {
  const target = videoOf(clips[0]!.probe)!;
  const width = Math.max(2, Math.round((target.width ?? 1280) / 2) * 2); const height = Math.max(2, Math.round((target.height ?? 720) / 2) * 2);
  const rate = target.fps && target.fps > 0 ? num(target.fps) : "30";
  const anyAudio = clips.some((clip) => clip.probe.has_audio);
  const args = [...BASE(ffmpeg)];
  for (const clip of clips) args.push("-i", clip.path);
  const parts: string[] = [];
  clips.forEach((clip, index) => {
    parts.push(`[${index}:v:0]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${rate},format=yuv420p,setpts=PTS-STARTPTS[v${index}]`);
    if (anyAudio) parts.push(clip.probe.has_audio
      ? `[${index}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${index}]`
      : `anullsrc=r=48000:cl=stereo,atrim=0:${num(clip.probe.duration_s ?? 0)},aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${index}]`);
  });
  let sum = clips[0]!.probe.duration_s ?? 0;
  let video = "[v0]"; let audio = "[a0]";
  for (let k = 1; k < clips.length; k++) {
    const offset = sum - d; // sum of the previous lengths minus k*d, accumulated
    const last = k === clips.length - 1;
    parts.push(`${video}[v${k}]xfade=transition=fade:duration=${num(d)}:offset=${num(offset)}[${last ? "v" : `x${k}`}]`);
    video = `[x${k}]`;
    if (anyAudio) { parts.push(`${audio}[a${k}]acrossfade=d=${num(d)}[${last ? "a" : `y${k}`}]`); audio = `[y${k}]`; }
    sum = offset + (clips[k]!.probe.duration_s ?? 0);
  }
  args.push("-filter_complex", parts.join(";"), "-map", "[v]");
  if (anyAudio) args.push("-map", "[a]");
  args.push("-sn", "-dn", ...ENCODE_V);
  if (anyAudio) args.push(...ENCODE_A);
  args.push(...FASTSTART, out);
  return args;
}

/** Lay a second audio file over the clip's own sound; the picture is copied untouched. */
export function overlayArgs(ffmpeg: string, clip: Clip, overlayPath: string, out: string, op: Extract<EditOp, { op: "audio_overlay" }>, overlaySeconds: number | null = null): string[] {
  const length = clip.probe.duration_s ?? 0;
  const layout = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";
  const delay = Math.round(op.start_s * 1000);
  const filters: string[] = [];
  filters.push(clip.probe.has_audio ? `[0:a:0]volume=${num(op.clip_gain_db)}dB,${layout}[c]` : `anullsrc=r=48000:cl=stereo,atrim=0:${num(length)},${layout}[c]`);
  // The overlay's length on the timeline: its own length, cut at end_s when given. Fades are cut on the overlay alone, before it is delayed.
  const span = op.end_s !== undefined ? op.end_s - op.start_s : null;
  const own = span !== null && overlaySeconds !== null ? Math.min(span, overlaySeconds) : span ?? overlaySeconds;
  const shaping: string[] = [];
  if (span !== null) shaping.push(`atrim=0:${num(span)}`, "asetpts=PTS-STARTPTS");
  if (op.fade_in_s > 0) shaping.push(`afade=t=in:st=0:d=${num(op.fade_in_s)}`);
  if (op.fade_out_s > 0 && own !== null) shaping.push(`afade=t=out:st=${num(Math.max(0, own - op.fade_out_s))}:d=${num(op.fade_out_s)}`);
  filters.push(`[1:a:0]${shaping.map((step) => `${step},`).join("")}volume=${num(op.gain_db)}dB,${layout}${delay > 0 ? `,adelay=${delay}|${delay}` : ""}${op.duck ? ",asplit=2[o][k]" : "[o]"}`);
  let clipLabel = "[c]";
  if (op.duck) { filters.push("[c][k]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400:makeup=1[d]"); clipLabel = "[d]"; }
  const mixed = op.loudness_lufs === undefined ? "[m]" : "[x]";
  filters.push(`${clipLabel}[o]amix=inputs=2:duration=first:normalize=0${mixed}`);
  if (op.loudness_lufs !== undefined) filters.push(`[x]loudnorm=I=${num(op.loudness_lufs)}:TP=-1.5:LRA=11,aresample=48000[m]`);
  const args = [...BASE(ffmpeg), "-i", clip.path, "-i", overlayPath, "-filter_complex", filters.join(";")];
  if (clip.probe.has_video) args.push("-map", "0:v:0", "-c:v", "copy");
  args.push("-map", "[m]", "-sn", "-dn", ...ENCODE_A);
  if (clip.probe.has_video) args.push("-t", num(length));
  args.push(...FASTSTART, out);
  return args;
}

export function gainArgs(ffmpeg: string, src: string, out: string, op: Extract<EditOp, { op: "gain" }>): string[] {
  return [...BASE(ffmpeg), "-i", src, "-map", "0:v:0?", "-map", "0:a:0", "-sn", "-dn", "-c:v", "copy", "-af", `volume=${num(op.db)}dB`, ...ENCODE_A, ...FASTSTART, out];
}

export function fadeArgs(ffmpeg: string, clip: Clip, out: string, op: Extract<EditOp, { op: "fade" }>): string[] {
  const length = clip.probe.duration_s ?? 0;
  const video: string[] = []; const audio: string[] = [];
  if (op.in_s > 0) { video.push(`fade=t=in:st=0:d=${num(op.in_s)}`); audio.push(`afade=t=in:st=0:d=${num(op.in_s)}`); }
  if (op.out_s > 0) { const start = Math.max(0, length - op.out_s); video.push(`fade=t=out:st=${num(start)}:d=${num(op.out_s)}`); audio.push(`afade=t=out:st=${num(start)}:d=${num(op.out_s)}`); }
  const args = [...BASE(ffmpeg), "-i", clip.path, "-map", "0:v:0?", "-map", "0:a:0?", "-sn", "-dn"];
  if (clip.probe.has_video) args.push("-vf", video.join(","), ...ENCODE_V);
  if (clip.probe.has_audio) args.push("-af", audio.join(","), ...ENCODE_A);
  args.push(...FASTSTART, out);
  return args;
}

const ASPECT_SIZES: Record<Extract<EditOp, { op: "reframe" }>['aspect'], [number, number]> = { "9:16": [1080, 1920], "1:1": [1080, 1080], "16:9": [1920, 1080], "4:5": [1080, 1350] };
function reframeSize(probe: ProbeResult, aspect: Extract<EditOp, { op: "reframe" }>['aspect']): [number, number] {
  const [baseW, baseH] = ASPECT_SIZES[aspect]; const sw = probe.width ?? baseW; const sh = probe.height ?? baseH;
  const sourceLongSide = Math.max(sw, sh); const targetLongSide = Math.max(baseW, baseH);
  const factor = Math.min(1, (sourceLongSide * 2) / targetLongSide);
  return [Math.max(2, Math.floor(baseW * factor / 2) * 2), Math.max(2, Math.floor(baseH * factor / 2) * 2)];
}
export function reframeArgs(ffmpeg: string, clip: Clip, out: string, op: Extract<EditOp, { op: "reframe" }>): string[] {
  const [w, h] = reframeSize(clip.probe, op.aspect);
  const graph = op.fill === "crop"
    ? `[0:v:0]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1[v]`
    : `[0:v:0]split=2[bg][fg];[bg]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=20:10[blur];[fg]scale=${w}:${h}:force_original_aspect_ratio=decrease[sharp];[blur][sharp]overlay=(W-w)/2:(H-h)/2,setsar=1[v]`;
  return [...BASE(ffmpeg), "-i", clip.path, "-filter_complex", graph, "-map", "[v]", "-map", "0:a:0?", "-sn", "-dn", ...ENCODE_V, ...(clip.probe.has_audio ? ENCODE_A : []), ...FASTSTART, out];
}
export function gradeArgs(ffmpeg: string, clip: Clip, out: string, op: Extract<EditOp, { op: "grade" }>): string[] {
  const filters: string[] = [];
  if (op.brightness !== undefined || op.contrast !== undefined || op.saturation !== undefined) filters.push(`eq=brightness=${num(op.brightness ?? 0)}:contrast=${num(1 + (op.contrast ?? 0))}:saturation=${num(1 + (op.saturation ?? 0))}`);
  if (op.warmth !== undefined && op.warmth !== 0) filters.push(`colorbalance=rs=${num(op.warmth * 0.2)}:bs=${num(-op.warmth * 0.2)}`);
  if (op.grain !== undefined && op.grain > 0) filters.push(`noise=alls=${num(op.grain * 20)}:allf=t`);
  if (op.vignette !== undefined && op.vignette > 0) filters.push(`vignette=angle=${num(op.vignette * Math.PI / 4)}`);
  const args = [...BASE(ffmpeg), "-i", clip.path, "-map", "0:v:0?", "-map", "0:a:0?", "-sn", "-dn"];
  if (clip.probe.has_video) args.push("-vf", filters.join(","), ...ENCODE_V);
  if (clip.probe.has_audio) args.push("-c:a", "copy");
  return [...args, ...FASTSTART, out];
}
export function speedArgs(ffmpeg: string, clip: Clip, out: string, op: Extract<EditOp, { op: "speed" }>): string[] {
  const video = `setpts=PTS/${num(op.factor)}`; const audio: string[] = [];
  let remaining = op.factor;
  // atempo accepts 0.5..2 per stage, so split extreme factors into a safe chain.
  while (remaining > 2) { audio.push("atempo=2"); remaining /= 2; }
  while (remaining < 0.5) { audio.push("atempo=0.5"); remaining /= 0.5; }
  audio.push(`atempo=${num(remaining)}`);
  const args = [...BASE(ffmpeg), "-i", clip.path, "-map", "0:v:0?", "-map", "0:a:0?", "-sn", "-dn"];
  if (clip.probe.has_video) args.push("-vf", video, ...ENCODE_V);
  if (clip.probe.has_audio) args.push("-af", audio.join(","), ...ENCODE_A);
  return [...args, ...FASTSTART, out];
}
const drawTextEscape = (text: string): string => text.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/%/g, "\\%").replace(/\n/g, "\\n").replace(/\r/g, "");
export function captionsArgs(ffmpeg: string, clip: Clip, out: string, op: Extract<EditOp, { op: "captions" }>, font: string): string[] {
  const position = op.position === "top" ? "y=h*0.06" : op.position === "middle" ? "y=(h-text_h)/2" : "y=h-text_h-h*0.06";
  const filters = op.lines.map((line) => `drawtext=fontfile='${drawTextEscape(font)}':text='${drawTextEscape(line.text)}':enable='between(t,${num(line.from_s)},${num(line.to_s)})':fontsize=h/18:fontcolor=white:borderw=3:bordercolor=black:x=(w-text_w)/2:${position}`);
  const args = [...BASE(ffmpeg), "-i", clip.path, "-map", "0:v:0?", "-map", "0:a:0?", "-sn", "-dn"];
  if (clip.probe.has_video) args.push("-vf", filters.join(","), ...ENCODE_V);
  if (clip.probe.has_audio) args.push("-c:a", "copy");
  return [...args, ...FASTSTART, out];
}
