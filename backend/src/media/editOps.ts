// EDITOR-11: the input of `media.edit` and the exact ffmpeg command lines of its
// ops. Pure functions: a test reads the arguments without a binary. One job
// takes `inputs[]`, `ops[]` and `output`; the ops run in order on a working
// clip that starts as inputs[0]. No shell, no network: every argument is a
// separate argv entry and every input is a local file the path guards passed.
import { z } from "zod";
import type { ProbeResult } from "./probe";
import { SPATIAL_LINES } from "./spatialRender";
import { ASS_HEADER, assColor, assText, fitTitleFontSize, resolveFonts, wrapTitle, writeAss } from "./typography";

const assTime = (seconds: number): string => { const cs = Math.round(seconds * 100); return `0:${String(Math.floor(cs / 6000)).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`; };
const assFilterPath = (path: string): string => path.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/,/g, "\\,").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
const wrapCaption = (text: string): string => { const words = text.split(/\s+/), lines: string[] = []; let line = ""; for (const word of words) { if (line && (line.length + word.length + 1 > 42 || lines.length === 0 && line.length + word.length + 1 > 42)) { lines.push(line); line = word; } else line += `${line ? " " : ""}${word}`; } if (line) lines.push(line); return lines.slice(0, 2).join("\\N"); };

/** `dissolve` is the smooth blend people expect (ffmpeg calls that `fade`); ffmpeg's own `dissolve` is a grainy speckle, kept as `speckle`. */
const XFADE_NAME: Record<string, string> = { dissolve: "fade", speckle: "dissolve" };
export const TRANSITION_KINDS = ["fade", "dissolve", "speckle", "wipeleft", "wiperight", "wipeup", "wipedown", "slideleft", "slideright", "slideup", "slidedown", "circleopen", "circleclose", "radial", "smoothleft", "smoothright", "fadeblack", "fadewhite", "zoomin", "pixelize"] as const;
export const FILM_LOOK_PRESETS = ["70s_color", "noir", "teal_orange", "bleach_bypass", "technicolor", "faded_vintage", "cool_thriller", "night"] as const;
export const LETTERBOX_RATIOS = ["2.39:1", "2:1", "1.85:1", "1.33:1"] as const;
export const EDIT_OPS = ["trim", "concat", "mute", "frame", "audio_overlay", "fade", "crossfade", "gain", "reframe", "grade", "film_look", "letterbox", "speed", "speed_ramp", "reverse", "freeze", "loop", "kenburns", "fps_boost", "flip", "rotate", "sharpen", "denoise", "ripple", "upscale", "pip", "captions", "transition", "title_card", "credits", "cutout", "spatial_sound"] as const;
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
  /** Who is lowered while the other plays: the clip's own sound under the overlay (default: the overlay is a voice) or the overlay under the clip's sound (the overlay is music). */
  duck_target: z.enum(["clip", "overlay"]).optional(),
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
const FilmLookOp = z.object({ op: z.literal("film_look"), preset: z.enum(FILM_LOOK_PRESETS), strength: z.number().min(0.2).max(1).default(1) }).strict();
const LetterboxOp = z.object({ op: z.literal("letterbox"), ratio: z.enum(LETTERBOX_RATIOS) }).strict();
const SpeedOp = z.object({ op: z.literal("speed"), factor: z.number().min(0.25).max(4) }).strict();
const SpeedRampOp = z.object({ op: z.literal("speed_ramp"), from_factor: z.number().min(0.25).max(4), to_factor: z.number().min(0.25).max(4), at_s: Seconds, over_s: z.number().min(0.3).max(10) }).strict();
const ReverseOp = z.object({ op: z.literal("reverse") }).strict();
const FreezeOp = z.object({ op: z.literal("freeze"), at_s: Seconds, hold_s: z.number().min(0.5).max(5) }).strict();
/** `seam_s` (default 0.5): the last seconds of each pass blend into its first seconds so the end meets the start with no jump; 0 is a plain repeat. */
const LoopOp = z.object({ op: z.literal("loop"), times: z.number().int().min(2).max(6), seam_s: z.number().min(0).max(2).default(0.5) }).strict();
const KenBurnsOp = z.object({ op: z.literal("kenburns"), zoom_from: z.number().min(1).max(2), zoom_to: z.number().min(1).max(2), pan: z.enum(["none", "left", "right", "up", "down"]), duration_s: z.number().min(1).max(30).optional() }).strict();
const FpsBoostOp = z.object({ op: z.literal("fps_boost"), fps: z.union([z.literal(30), z.literal(48), z.literal(60)]) }).strict();
const FlipOp = z.object({ op: z.literal("flip"), direction: z.enum(["horizontal", "vertical"]) }).strict();
const RotateOp = z.object({ op: z.literal("rotate"), degrees: z.union([z.literal(90), z.literal(180), z.literal(270)]) }).strict();
const AmountOp = z.number().min(0).max(1);
/** Sharpen amount: 0 to 1 as before (unsharp strength is amount x 2); above 1 up to 1.5 is "Sharpen+" (strength 3). */
export const SHARPEN_MAX_AMOUNT = 1.5;
const SharpenOp = z.object({ op: z.literal("sharpen"), amount: z.number().min(0).max(SHARPEN_MAX_AMOUNT) }).strict();
/** `deblock` (default off) runs ffmpeg's deblocking filter before the denoise, for compression blocks. */
const DenoiseOp = z.object({ op: z.literal("denoise"), amount: AmountOp, deblock: z.boolean().optional() }).strict();
/** A gentle whole-frame water-like wobble, 0 (none) to 1 (about 1% of the height); audio untouched. */
const RippleOp = z.object({ op: z.literal("ripple"), amount: AmountOp }).strict();
const UpscaleOp = z.object({ op: z.literal("upscale"), factor: z.literal(2).optional() }).strict();
const PipOp = z.object({ op: z.literal("pip"), input: Index, corner: z.enum(["top_left", "top_right", "bottom_left", "bottom_right"]), size: z.number().min(0.15).max(0.5), margin: z.number().min(0).max(0.1) }).strict();
const CaptionsOp = z.object({ op: z.literal("captions"), lines: z.array(z.object({ from_s: Seconds, to_s: z.number().gt(0).max(MAX_EDIT_SECONDS), text: z.string().min(1).max(120) }).strict()).min(1).max(2000), position: z.enum(["bottom", "middle", "top"]) }).strict()
  .refine((op) => op.lines.every((line) => line.to_s > line.from_s), { path: ["lines"], message: "each to_s must be after from_s" });

/** Joins like concat, but each seam blends the last duration_s of one clip into the first duration_s of the next. */
const CrossfadeOp = z.object({
  op: z.literal("crossfade"),
  duration_s: z.number().min(MIN_CROSSFADE_S, `must be from ${MIN_CROSSFADE_S} to ${MAX_CROSSFADE_S} seconds`).max(MAX_CROSSFADE_S, `must be from ${MIN_CROSSFADE_S} to ${MAX_CROSSFADE_S} seconds`).default(0.5),
  with: z.array(Index).min(1).max(MAX_EDIT_INPUTS - 1).optional(),
}).strict();
const TransitionOp = z.object({ op: z.literal("transition"), kind: z.enum(TRANSITION_KINDS), duration_s: z.number().min(MIN_CROSSFADE_S, `must be from ${MIN_CROSSFADE_S} to ${MAX_CROSSFADE_S} seconds`).max(MAX_CROSSFADE_S, `must be from ${MIN_CROSSFADE_S} to ${MAX_CROSSFADE_S} seconds`).default(0.5), with: z.array(Index).min(1).max(MAX_EDIT_INPUTS - 1).optional() }).strict();
const Colour = z.union([z.enum(["black", "white"]), z.string().regex(/^#[0-9A-Fa-f]{6}$/)]);
const TitleCardOp = z.object({ op: z.literal("title_card"), text: z.string().min(1).max(120), subtitle: z.string().max(160).optional(), duration_s: z.number().min(1).max(10), position: z.enum(["center", "lower_third", "top"]), background: Colour, text_color: Colour, fade_in_s: z.number().min(0).max(10).optional(), fade_out_s: z.number().min(0).max(10).optional(), place: z.enum(["start", "end"]) }).strict().refine((op) => (op.fade_in_s ?? 0) + (op.fade_out_s ?? 0) <= op.duration_s, { path: ["fade_out_s"], message: "combined fades must fit within duration_s" });
const CreditsOp = z.object({ op: z.literal("credits"), lines: z.array(z.object({ role: z.string().max(40).optional(), name: z.string().min(1).max(60) }).strict()).min(1).max(60), duration_s: z.number().min(3).max(120).optional(), speed: z.number().min(1).max(1000).default(60), background: Colour, text_color: Colour, title: z.string().max(120).optional() }).strict();
const CutoutSubject = z.object({ frame: z.number().int().min(0).optional(), box: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(), point: z.object({ x: z.number(), y: z.number() }).strict().optional() }).strict().refine((s) => !(s.box && s.point), { message: "choose a box or a point" });
const CutoutOp = z.object({ op: z.literal("cutout"), background: z.union([z.enum(["black", "white", "green", "blur", "transparent"]), z.string().regex(/^#[0-9a-fA-F]{6}$/)]), subject: CutoutSubject.optional(), feather_px: z.number().min(0).max(12).default(2) }).strict();

/** SPATIAL-03: direction (and optionally a 5.1 sibling file) for the clip's own sound. The positions are found inside the job, never taken from the request. */
const SpatialSoundOp = z.object({ op: z.literal("spatial_sound"), surround: z.boolean().optional(), side: z.enum(["left", "right"]).optional() }).strict();

export const EditOp = z.union([TrimOp, ConcatOp, MuteOp, FrameOp, AudioOverlayOp, FadeOp, CrossfadeOp, GainOp, ReframeOp, GradeOp, FilmLookOp, LetterboxOp, SpeedOp, SpeedRampOp, ReverseOp, FreezeOp, LoopOp, KenBurnsOp, FpsBoostOp, FlipOp, RotateOp, SharpenOp, DenoiseOp, RippleOp, UpscaleOp, PipOp, CaptionsOp, TransitionOp, TitleCardOp, CreditsOp, CutoutOp, SpatialSoundOp]);
export type EditOp = z.infer<typeof EditOp>;

export const EditInput = z.object({
  inputs: z.array(Path).min(1).max(MAX_EDIT_INPUTS),
  ops: z.array(EditOp).min(1).max(MAX_EDIT_OPS),
  output: z.object({
    dir: Path.optional(),
    /** File name with extension: .mp4 or .mov for a clip, .png for a frame. */
    name: z.string().min(1).max(200).regex(/\.(mp4|mov|webm|png)$/i, "must end in .mp4, .mov, .webm or .png"),
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
      if (name === "transition") {
        const kind = (raw.ops[i] as { kind?: unknown } | null)?.kind;
        if (typeof kind !== "string" || !(TRANSITION_KINDS as readonly string[]).includes(kind)) return `Step ${i + 1} asks for transition ${JSON.stringify(kind ?? null)}. The transitions it knows are ${TRANSITION_KINDS.join(", ")}.`;
      }
      if (name === "film_look") {
        const preset = (raw.ops[i] as { preset?: unknown } | null)?.preset;
        if (typeof preset !== "string" || !(FILM_LOOK_PRESETS as readonly string[]).includes(preset)) return `Step ${i + 1} asks for film look ${JSON.stringify(preset ?? null)}. The film looks it knows are ${FILM_LOOK_PRESETS.join(", ")}.`;
      }
      if (name === "letterbox") {
        const ratio = (raw.ops[i] as { ratio?: unknown } | null)?.ratio;
        if (typeof ratio !== "string" || !(LETTERBOX_RATIOS as readonly string[]).includes(ratio)) return `Step ${i + 1} asks for letterbox ratio ${JSON.stringify(ratio ?? null)}. The ratios it knows are ${LETTERBOX_RATIOS.join(", ")}.`;
      }
      if (name === "pip") {
        const corner = (raw.ops[i] as { corner?: unknown } | null)?.corner;
        if (typeof corner !== "string" || !["top_left", "top_right", "bottom_left", "bottom_right"].includes(corner)) return `Step ${i + 1} asks for picture-in-picture corner ${JSON.stringify(corner ?? null)}. Choose top_left, top_right, bottom_left or bottom_right.`;
      }
      if (name === "fps_boost") {
        const fps = (raw.ops[i] as { fps?: unknown } | null)?.fps;
        if (![30, 48, 60].includes(fps as number)) return `Step ${i + 1} (fps_boost) accepts 30, 48 or 60 fps.`;
      }
      if (name === "flip") {
        const direction = (raw.ops[i] as { direction?: unknown } | null)?.direction;
        if (direction !== "horizontal" && direction !== "vertical") return `Step ${i + 1} (flip) accepts horizontal or vertical.`;
      }
      if (name === "denoise") {
        const deblock = (raw.ops[i] as { deblock?: unknown } | null)?.deblock;
        if (deblock !== undefined && typeof deblock !== "boolean") return `Step ${i + 1} (denoise) takes deblock as true or false.`;
      }
      if (name === "spatial_sound") {
        const surround = (raw.ops[i] as { surround?: unknown } | null)?.surround;
        if (surround !== undefined && typeof surround !== "boolean") return `Step ${i + 1} (spatial_sound) takes surround as true or false.`;
        const side = (raw.ops[i] as { side?: unknown } | null)?.side;
        if (side !== undefined && side !== "left" && side !== "right") return `Step ${i + 1} (spatial_sound) takes side as "left" or "right".`;
      }
      if (name === "rotate") {
        const degrees = (raw.ops[i] as { degrees?: unknown } | null)?.degrees;
        if (![90, 180, 270].includes(degrees as number)) return `Step ${i + 1} (rotate) accepts 90, 180 or 270 degrees.`;
      }
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
  const cutout = input.ops.find((op) => op.op === "cutout");
  if (cutout?.op === "cutout" && (cutout.background === "transparent" ? !/\.webm$/i.test(input.output.name) : !/\.mp4$/i.test(input.output.name))) return "A transparent cutout must be saved as a .webm file; other backgrounds must be saved as .mp4.";
  if (cutout?.op === "cutout" && cutout.background === "transparent" && input.ops.at(-1)?.op !== "cutout") return "A transparent cutout must be the last edit step.";
  const last = input.ops.length - 1;
  const spatial = input.ops.flatMap((op, index) => op.op === "spatial_sound" ? [{ op, index }] : []);
  if (spatial.length > 1) return SPATIAL_LINES.only_once;
  if (spatial[0]?.op.surround === true) {
    if (spatial[0].index !== last) return SPATIAL_LINES.not_last;
    if (!/\.(mp4|mov)$/i.test(input.output.name)) return SPATIAL_LINES.surround_container;
  }
  const png = /\.png$/i.test(input.output.name);
  for (let i = 0; i < input.ops.length; i++) {
    const op = input.ops[i]!;
    if (op.op === "audio_overlay" && op.input >= input.inputs.length) return `Step ${i + 1} (audio_overlay) uses file ${op.input + 1}, but the edit lists only ${input.inputs.length}.`;
    if (op.op === "pip" && (op.input >= input.inputs.length || op.input === 0)) return `Step ${i + 1} (pip) needs a second file from inputs[]. Add the picture-in-picture clip after the working clip.`;
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
  if (!endsInFrame && png) return "Only a frame step makes a .png. Name the output .mp4, .mov or .webm.";
  return null;
}

/** Input files that concat joins when it names none: every file after the first that no audio_overlay uses. */
export function concatMembers(input: EditInput, op: Extract<EditOp, { op: "concat" | "crossfade" | "transition" }>): number[] {
  if (op.with) return op.with;
  const overlays = new Set(input.ops.flatMap((step) => step.op === "audio_overlay" ? [step.input] : []));
  return input.inputs.map((_, index) => index).filter((index) => index > 0 && !overlays.has(index));
}

// ---- command lines ----
const BASE = (ffmpeg: string): string[] => [ffmpeg, "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-progress", "pipe:1", "-nostats"];
/** bt709 on every encode: a player that guesses for an untagged file shifts reds and greens. */
const COLOUR_TAGS = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];
/** Final encodes are CRF 18; the runner drops every step but the last to CRF 14 (intermediateArgs) so a film that goes through five steps loses little. */
const ENCODE_V = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", ...COLOUR_TAGS, "-fps_mode", "cfr"];
/** The same command line at the intermediate quality (CRF 14). Everything else is untouched. */
export function intermediateArgs(args: string[]): string[] {
  const at = args.indexOf("-crf");
  if (at < 0 || args[at + 1] !== "18") return args;
  const next = [...args]; next[at + 1] = "14"; return next;
}
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

/**
 * True when a stream-copied file's sound is as long as its picture (within 150 ms). Joining AAC streams by copy keeps each file's encoder delay, and a cut that
 * starts between audio packets does the same: the result can have 83 s of picture and 42 s of sound. A copy that fails this check is made again as an encode.
 */
export function audioMatchesVideo(probe: ProbeResult): boolean {
  const video = probe.streams.find((stream) => stream.type === "video" && !stream.cover_art)?.duration_s;
  const audio = probe.streams.find((stream) => stream.type === "audio")?.duration_s;
  if (!probe.has_audio || !probe.has_video || !video || !audio) return true;
  return Math.abs(video - audio) <= 0.15;
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
  return transitionArgs(ffmpeg, clips, "fade", d, out);
}
/**
 * Frame-exact seams. xfade takes seconds and rounds to a frame, acrossfade is sample exact, so an offset between frames drifts the picture up to a frame
 * per seam against the sound (LTX clips are 8n+1 frames, 121 frames is 5.0417 s). The blend is an even number of frames (an odd split rounds up twice) and
 * every offset is a whole number of frames, counted from the frame counts of the clips.
 */
export function crossfadeTiming(durations: number[], d: number, rate: number): { d: number; frames: number; offsets: number[] } {
  const frames = Math.max(2, Math.round(d * rate / 2) * 2);
  const frameCounts = durations.map((seconds) => Math.max(frames, Math.round(seconds * rate)));
  const offsets: number[] = [];
  let sum = frameCounts[0] ?? 0;
  for (let k = 1; k < frameCounts.length; k++) { offsets.push((sum - frames) / rate); sum = sum - frames + frameCounts[k]!; }
  return { d: frames / rate, frames, offsets };
}
const exact = (value: number): string => String(Math.round(value * 1e6) / 1e6);
export function transitionArgs(ffmpeg: string, clips: Clip[], kind: typeof TRANSITION_KINDS[number], d: number, out: string): string[] {
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
  const timing = crossfadeTiming(clips.map((clip) => clip.probe.duration_s ?? 0), d, Number(rate));
  let video = "[v0]"; let audio = "[a0]";
  for (let k = 1; k < clips.length; k++) {
    const last = k === clips.length - 1;
    parts.push(`${video}[v${k}]xfade=transition=${XFADE_NAME[kind] ?? kind}:duration=${exact(timing.d)}:offset=${exact(timing.offsets[k - 1]!)}[${last ? "v" : `x${k}`}]`);
    video = `[x${k}]`;
    if (anyAudio) { parts.push(`${audio}[a${k}]acrossfade=d=${exact(timing.d)}[${last ? "a" : `y${k}`}]`); audio = `[y${k}]`; }
  }
  args.push("-filter_complex", parts.join(";"), "-map", "[v]");
  if (anyAudio) args.push("-map", "[a]");
  args.push("-sn", "-dn", ...ENCODE_V);
  if (anyAudio) args.push(...ENCODE_A);
  args.push(...FASTSTART, out);
  return args;
}

/** Lay a second audio file over the clip's own sound; the picture is copied untouched. */
const LIMIT = "0.89";
/** Integrated loudness a mix is normalised to when the op names none. */
export const MIX_LUFS = -16;
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
  const duckOverlay = op.duck && op.duck_target === "overlay";
  filters.push(`[1:a:0]${shaping.map((step) => `${step},`).join("")}volume=${num(op.gain_db)}dB,${layout}${delay > 0 ? `,adelay=${delay}|${delay}` : ""}${op.duck && !duckOverlay ? ",asplit=2[o][k]" : "[o]"}`);
  let clipLabel = "[c]"; let overlayLabel = "[o]";
  const DUCK = "sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400:makeup=1";
  if (op.duck && !duckOverlay) { filters.push(`[c][k]${DUCK}[d]`); clipLabel = "[d]"; }
  // The overlay is music: the clip's own sound (the voice) keys the compressor that lowers it.
  if (duckOverlay) { filters.push("[c]asplit=2[cm][k]"); filters.push(`[o][k]${DUCK}[od]`); clipLabel = "[cm]"; overlayLabel = "[od]"; }
  const mixed = "[x]";
  filters.push(`${clipLabel}${overlayLabel}amix=inputs=2:duration=first:normalize=0${mixed}`);
  // Never clip: a limiter on the sum, then loudness to the target (default -16 LUFS), then a final limiter for loudnorm's overshoot.
  filters.push(`[x]alimiter=limit=${LIMIT}:level=0[y]`);
  filters.push(`[y]loudnorm=I=${num(op.loudness_lufs ?? MIX_LUFS)}:TP=-1.5:LRA=11,aresample=48000,alimiter=limit=${LIMIT}:level=0[m]`);
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

/** Below this length the graph is one -filter_complex argument; above it (about 40 segments in 5.1) it goes through a script file the job writes. */
export const SPATIAL_INLINE_GRAPH_LIMIT = 24_000;
/**
 * SPATIAL-03: re-mix the working clip's first sound track with the graph from spatialGraph. The picture is copied byte for byte (-c:v copy), the
 * container metadata is kept (-map_metadata 0) and -shortest is never used (it cut the picture short in the bench). Stereo is AAC 192k; 5.1 is
 * E-AC-3 384k. `scriptPath` is set when the graph is too long for one argument; the caller has written the graph to that file.
 */
export function spatialArgs(ffmpeg: string, src: string, out: string, plan: { graph: string; surround: boolean; scriptPath: string | null }): string[] {
  const graph = plan.scriptPath ? ["-/filter_complex", plan.scriptPath] : ["-filter_complex", plan.graph];
  return [...BASE(ffmpeg), "-i", src, "-map_metadata", "0", ...graph, "-map", "0:v:0?", "-map", "[out]", "-sn", "-dn", "-c:v", "copy", ...(plan.surround ? ["-c:a", "eac3", "-b:a", "384k"] : ["-c:a", "aac", "-b:a", "192k"]), ...FASTSTART, out];
}
/** The unchanged-stereo result of spatial_sound: every stream copied, nothing re-encoded. */
export function spatialUnchangedArgs(ffmpeg: string, src: string, out: string): string[] {
  return [...BASE(ffmpeg), "-i", src, "-map_metadata", "0", "-map", "0:v:0?", "-map", "0:a:0", "-sn", "-dn", "-c", "copy", ...FASTSTART, out];
}
/** Loudness of the side signal (L minus R), read from the stderr lines of volumedetect; it decides whether the back speakers have anything to play. */
export function spatialSideLevelArgs(ffmpeg: string, src: string): string[] {
  return [ffmpeg, "-hide_banner", "-nostdin", "-nostats", "-loglevel", "info", "-i", src, "-map", "0:a:0", "-vn", "-af", "aformat=channel_layouts=stereo,pan=mono|c0=0.5*c0-0.5*c1,volumedetect", "-f", "null", "-"];
}
/** The mean level in dBFS from volumedetect's output, or -91 (digital silence) when it printed none. */
export function parseMeanVolume(stderr: string): number {
  const match = /mean_volume:\s*(-?[\d.]+|-inf)\s*dB/.exec(stderr);
  if (!match || match[1] === "-inf") return -91;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : -91;
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
const filmFilters: Record<(typeof FILM_LOOK_PRESETS)[number], string> = {
  "70s_color": "eq=contrast=1.08:saturation=0.82:gamma=1.08,colorbalance=rs=0.05:gs=0.05:bs=-0.08:rh=0.09:gh=0.07:bh=-0.11,noise=c0s=12:c0f=t,vignette=angle=0.62",
  noir: "hue=s=0,eq=contrast=1.65:brightness=-0.035:gamma=0.78,noise=c0s=26:c0f=t,vignette=angle=0.9",
  teal_orange: "eq=saturation=1.16,colorbalance=rs=0.04:gs=-0.025:bs=-0.09:rh=0.12:gh=0.015:bh=-0.1,noise=c0s=5:c0f=t",
  bleach_bypass: "eq=saturation=0.6:contrast=1.28,colorbalance=rs=-0.015:gs=0.025:bs=0.02,noise=c0s=8:c0f=t",
  technicolor: "eq=saturation=1.32:brightness=-0.02:contrast=1.1,colorchannelmixer=rr=1.05:rg=0.01:gg=1.0:gb=0.0:bb=1.0",
  faded_vintage: "curves=master='0/0.08 0.25/0.29 0.75/0.76 1/1',eq=contrast=0.82:saturation=0.72,colorbalance=rs=0.045:gs=0.025:bs=-0.07,noise=c0s=5:c0f=t",
  night: "eq=saturation=0.5:contrast=1.12:brightness=-0.1:gamma=0.82,colorbalance=rs=-0.02:gs=0:bs=0.14:rm=-0.05:bm=0.08:rh=-0.06:bh=0.05,vignette=angle=0.7,noise=c0s=5:c0f=t",
  cool_thriller: "eq=saturation=0.72:contrast=1.2:brightness=-0.015,colorbalance=rs=-0.04:gs=-0.015:bs=0.09:rh=-0.035:gh=0.005:bh=0.06,vignette=angle=0.72,noise=c0s=5:c0f=t",
};
export function filmLookArgs(ffmpeg: string, clip: Clip, out: string, op: Extract<EditOp, { op: "film_look" }>): string[] {
  const graph = `[0:v:0]split=2[original][source];[source]${filmFilters[op.preset]}[graded0]`;
  const fixedGraph = op.preset === "70s_color"
    ? `[0:v:0]split=2[original][source];[source]${filmFilters[op.preset]},split=2[base][hot];[hot]gblur=sigma=12[soft];[base][soft]blend=c0_mode=screen:c0_opacity=${op.preset === "70s_color" ? "0.16" : "0.04"}:c1_opacity=0:c2_opacity=0[graded];[original][graded]blend=all_expr='A*(1-${num(op.strength)})+B*${num(op.strength)}'[v]`
    : `${graph};[original][graded0]blend=all_expr='A*(1-${num(op.strength)})+B*${num(op.strength)}'[v]`;
  return [...BASE(ffmpeg), "-i", clip.path, "-map_metadata", "0", "-filter_complex", fixedGraph, "-map", "[v]", "-map", "0:a:0?", "-sn", "-dn", ...ENCODE_V, ...(clip.probe.has_audio ? ["-c:a", "copy"] : []), ...FASTSTART, out];
}
function ratioValue(ratio: (typeof LETTERBOX_RATIOS)[number]): number { const [w, h] = ratio.split(":").map(Number); return w! / h!; }
export function letterboxArgs(ffmpeg: string, clip: Clip, out: string, op: Extract<EditOp, { op: "letterbox" }>): string[] {
  const width = Math.max(2, Math.round((clip.probe.width ?? 1280) / 2) * 2);
  const height = Math.max(2, Math.round((clip.probe.height ?? 720) / 2) * 2);
  const frameRatio = width / height; const ratio = ratioValue(op.ratio);
  if (Math.abs(frameRatio - ratio) < 0.005 || (ratio > 1.33 && frameRatio >= ratio) || (ratio <= 1.33 && frameRatio <= ratio)) throw new Error(`The frame already matches ${op.ratio} or has no area to add those bars to. Choose a ratio that changes the picture.`);
  const cropW = ratio > frameRatio ? width : Math.max(2, Math.floor(height * ratio / 2) * 2);
  const cropH = ratio > frameRatio ? Math.max(2, Math.floor(width / ratio / 2) * 2) : height;
  const graph = `[0:v:0]crop=${cropW}:${cropH}:(iw-${cropW})/2:(ih-${cropH})/2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v]`;
  return [...BASE(ffmpeg), "-i", clip.path, "-filter_complex", graph, "-map", "[v]", "-map", "0:a:0?", "-sn", "-dn", ...ENCODE_V, ...(clip.probe.has_audio ? ["-c:a", "copy"] : []), ...FASTSTART, out];
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
export function reverseDurationProblem(duration: number): string | null { return duration > 60 ? "Reverse works only on clips up to 60 seconds. Trim the clip first." : null; }
export function speedRampArgs(ffmpeg: string, clip: Clip, out: string, op: Extract<EditOp, { op: "speed_ramp" }>): string[] {
  const d = clip.probe.duration_s ?? 0; const rampEnd = Math.min(d, op.at_s + op.over_s);
  const slope = (op.to_factor - op.from_factor) / op.over_s;
  const during = Math.abs(slope) < 1e-9
    ? `(T*TB-${num(op.at_s)})/${num(op.from_factor)}`
    : `log((${num(op.from_factor)}+${num(slope)}*(T*TB-${num(op.at_s)}))/${num(op.from_factor)})/${num(slope)}`;
  const rampLength = Math.abs(slope) < 1e-9 ? num(op.over_s / op.from_factor) : `log(${num(op.to_factor / op.from_factor)})/${num(slope)}`;
  const mapped = `if(lt(T*TB,${num(op.at_s)}),T*TB/${num(op.from_factor)},if(lt(T*TB,${num(rampEnd)}),${num(op.at_s / op.from_factor)}+${during},${num(op.at_s / op.from_factor)}+${rampLength}+(T*TB-${num(rampEnd)})/${num(op.to_factor)}))/TB`;
  if (!clip.probe.has_audio) return [...BASE(ffmpeg), "-i", clip.path, "-vf", `setpts='${mapped}'`, "-map", "0:v:0", "-an", "-sn", "-dn", ...ENCODE_V, ...FASTSTART, out];
  const parts = [`[0:v:0]setpts='${mapped}'[v]`]; const audioLabels: string[] = [];
  const addAudioSegment = (from: number, to: number, factor: number, index: number) => {
    let remaining = factor; const chain: string[] = [];
    while (remaining > 2) { chain.push("atempo=2"); remaining /= 2; }
    while (remaining < 0.5) { chain.push("atempo=0.5"); remaining /= 0.5; }
    chain.push(`atempo=${num(remaining)}`);
    parts.push(`[0:a:0]atrim=${num(from)}:${num(to)},asetpts=PTS-STARTPTS,${chain.join(",")}[a${index}]`); audioLabels.push(`[a${index}]`);
  };
  if (op.at_s > 0) addAudioSegment(0, Math.min(op.at_s, d), op.from_factor, 0);
  const pieces = Math.max(1, Math.ceil((rampEnd - op.at_s) * 24));
  for (let i = 0; i < pieces && rampEnd > op.at_s; i++) {
    const from = op.at_s + (rampEnd - op.at_s) * i / pieces; const to = op.at_s + (rampEnd - op.at_s) * (i + 1) / pieces;
    const factor = op.from_factor + slope * ((from + to) / 2 - op.at_s); addAudioSegment(from, to, factor, audioLabels.length);
  }
  if (d > rampEnd) addAudioSegment(rampEnd, d, op.to_factor, audioLabels.length);
  parts.push(`${audioLabels.join("")}concat=n=${audioLabels.length}:v=0:a=1[a]`);
  return [...BASE(ffmpeg), "-i", clip.path, "-filter_complex", parts.join(";"), "-map", "[v]", "-map", "[a]", "-sn", "-dn", ...ENCODE_V, ...ENCODE_A, ...FASTSTART, out];
}
export function reverseArgs(ffmpeg:string,clip:Clip,out:string):string[]{return [...BASE(ffmpeg),"-i",clip.path,"-vf","reverse,setpts=PTS-STARTPTS","-af","areverse,asetpts=PTS-STARTPTS","-map","0:v:0?","-map","0:a:0?","-sn","-dn","-c:v","libx264","-preset","veryfast","-crf","0","-pix_fmt","yuv420p",...COLOUR_TAGS,...(clip.probe.has_audio?ENCODE_A:[]),...FASTSTART,out];}
export function freezeArgs(ffmpeg:string,clip:Clip,out:string,op:Extract<EditOp,{op:"freeze"}>):string[]{const video=`[0:v:0]trim=0:${num(op.at_s)},setpts=PTS-STARTPTS[a];[0:v:0]trim=${num(op.at_s)}:${num(op.at_s+0.04)},setpts=PTS-STARTPTS,loop=loop=${Math.max(1,Math.round(op.hold_s*24))}:size=1:start=0,setpts=PTS-STARTPTS[b];[0:v:0]trim=${num(op.at_s)},setpts=PTS-STARTPTS[c];[a][b][c]concat=n=3:v=1:a=0[v]`;const audio=clip.probe.has_audio?`;[0:a:0]atrim=0:${num(op.at_s)},asetpts=PTS-STARTPTS[x];anullsrc=r=48000:cl=stereo,atrim=0:${num(op.hold_s)}[sil];[0:a:0]atrim=${num(op.at_s)},asetpts=PTS-STARTPTS[y];[x][sil][y]concat=n=3:v=0:a=1[a]`:"";return [...BASE(ffmpeg),"-i",clip.path,"-filter_complex",video+audio,"-map","[v]",...(clip.probe.has_audio?["-map","[a]"]:[]),"-sn","-dn",...ENCODE_V,...(clip.probe.has_audio?ENCODE_A:[]),...FASTSTART,out];}
/** Seam length for a seamless loop: a whole number of frames, at most a quarter of the clip, 0 when off or the clip is too short to spare it. */
export function loopSeamSeconds(clipSeconds: number, fps: number, wanted: number): number {
  if (!(wanted > 0) || !(clipSeconds > 0) || !(fps > 0)) return 0;
  const frames = Math.floor(Math.min(wanted, clipSeconds / 4) * fps);
  return frames >= 2 ? frames / fps : 0;
}
/** One pass of a seamless loop is the clip with its last `seam` seconds blended into its first `seam` seconds: the pass starts on the blend, then plays on from the clip's seam mark, so its end flows into its own start. Length: clip minus seam. */
export function loopPassSeconds(clipSeconds: number, fps: number, seam: number): number { return clipSeconds - loopSeamSeconds(clipSeconds, fps, seam); }
export function loopArgs(ffmpeg: string, clip: Clip, out: string, times: number, seamSeconds = 0.5): string[] {
  const hasAudio = clip.probe.has_audio;
  const fps = videoOf(clip.probe)?.fps ?? 24;
  const length = clip.probe.duration_s ?? 0;
  const d = loopSeamSeconds(length, fps, seamSeconds);
  const L = num(length), D = num(d), T = num(length - d), M = num(d);
  const inputs = Array.from({ length: times }, () => ["-i", clip.path]).flat();
  const parts: string[] = []; const labels: string[] = [];
  for (let i = 0; i < times; i++) {
    if (d > 0) {
      parts.push(`[${i}:v:0]setpts=PTS-STARTPTS,split=3[vh${i}][vm${i}][vt${i}]`);
      parts.push(`[vh${i}]trim=0:${D},setpts=PTS-STARTPTS[vhh${i}]`, `[vt${i}]trim=${T}:${L},setpts=PTS-STARTPTS[vtt${i}]`, `[vm${i}]trim=${M}:${T},setpts=PTS-STARTPTS[vmm${i}]`);
      parts.push(`[vtt${i}][vhh${i}]xfade=transition=fade:duration=${D}:offset=0[vs${i}]`, `[vs${i}][vmm${i}]concat=n=2:v=1:a=0[v${i}]`);
      if (hasAudio) {
        parts.push(`[${i}:a:0]asetpts=PTS-STARTPTS,asplit=3[ah${i}][am${i}][at${i}]`);
        parts.push(`[ah${i}]atrim=0:${D},asetpts=PTS-STARTPTS[ahh${i}]`, `[at${i}]atrim=${T}:${L},asetpts=PTS-STARTPTS[att${i}]`, `[am${i}]atrim=${M}:${T},asetpts=PTS-STARTPTS[amm${i}]`);
        parts.push(`[att${i}][ahh${i}]acrossfade=d=${D}[as${i}]`, `[as${i}][amm${i}]concat=n=2:v=0:a=1[a${i}]`);
      }
    } else {
      parts.push(`[${i}:v:0]setpts=PTS-STARTPTS[v${i}]`);
      if (hasAudio) parts.push(`[${i}:a:0]asetpts=PTS-STARTPTS[a${i}]`);
    }
    labels.push(`[v${i}]`); if (hasAudio) labels.push(`[a${i}]`);
  }
  parts.push(`${labels.join("")}concat=n=${times}:v=1:a=${hasAudio ? 1 : 0}[v]${hasAudio ? "[a]" : ""}`);
  return [...BASE(ffmpeg), ...inputs, "-filter_complex", parts.join(";"), "-map", "[v]", ...(hasAudio ? ["-map", "[a]"] : []), "-sn", "-dn", ...ENCODE_V, ...(hasAudio ? ENCODE_A : []), ...FASTSTART, out];
}
/**
 * Ken Burns by zoompan. zoompan's `d` is output frames per INPUT frame and `on` counts output frames, so the move is timed in frames: the last frame
 * lands exactly on zoom_to (and the pan edge) at the end of the clip. A video keeps its own frame rate and length (frames in = frames out, d=1); a still is
 * read at 24 fps for duration_s. The picture is scaled to twice the output size first so zoompan's whole-pixel steps are half a pixel after it scales back.
 */
export function kenBurnsArgs(ffmpeg: string, clip: Clip, out: string, op: Extract<EditOp, { op: "kenburns" }>, still = false): string[] {
  const w = still ? 1280 : Math.max(2, Math.round((clip.probe.width ?? 1280) / 2) * 2), h = still ? 720 : Math.max(2, Math.round((clip.probe.height ?? 720) / 2) * 2);
  const fps = still ? 24 : (videoOf(clip.probe)?.fps && videoOf(clip.probe)!.fps! > 0 ? videoOf(clip.probe)!.fps! : 24);
  const clipSeconds = clip.probe.duration_s ?? 0;
  const seconds = still ? op.duration_s ?? 5 : op.duration_s !== undefined ? (clipSeconds > 0 ? Math.min(op.duration_s, clipSeconds) : op.duration_s) : clipSeconds > 0 ? clipSeconds : 5;
  const last = Math.max(1, Math.round(seconds * fps) - 1);
  const p = `on/${last}`;
  const pan = op.pan === "left" ? `x=(iw-iw/zoom)*(1-${p})` : op.pan === "right" ? `x=(iw-iw/zoom)*${p}` : op.pan === "up" ? `y=(ih-ih/zoom)*(1-${p})` : op.pan === "down" ? `y=(ih-ih/zoom)*${p}` : "x=(iw-iw/zoom)/2:y=(ih-ih/zoom)/2";
  const zoom = `z='${num(op.zoom_from)}+((${num(op.zoom_to)}-${num(op.zoom_from)})*${p})'`;
  const vf = `scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase,crop=${w * 2}:${h * 2},zoompan=${zoom}:${pan}:d=1:s=${w}x${h}:fps=${num(fps)}`;
  const args = [...BASE(ffmpeg), ...(still ? ["-loop", "1", "-framerate", "24"] : []), "-i", clip.path];
  if (still) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  args.push("-vf", vf, "-t", num(seconds), "-map", "0:v:0", ...(still ? ["-map", "1:a:0"] : ["-map", "0:a:0?"]), "-sn", "-dn", ...ENCODE_V, ...(still ? ENCODE_A : clip.probe.has_audio ? ["-c:a", "copy"] : []), ...(still ? ["-shortest"] : []), ...FASTSTART, out);
  return args;
}
export function fpsBoostArgs(ffmpeg:string,clip:Clip,out:string,fps:number):string[]{return [...BASE(ffmpeg),"-i",clip.path,"-vf",`minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:vsbmc=1`,"-map","0:v:0","-map","0:a:0?","-sn","-dn",...ENCODE_V,...(clip.probe.has_audio?["-c:a","copy"]:[]),...FASTSTART,out];}
export function flipArgs(ffmpeg:string,clip:Clip,out:string,direction:string):string[]{return [...BASE(ffmpeg),"-i",clip.path,"-vf",direction==="horizontal"?"hflip":"vflip","-map","0:v:0","-map","0:a:0?","-sn","-dn",...ENCODE_V,...(clip.probe.has_audio?["-c:a","copy"]:[]),...FASTSTART,out];}
export function rotateArgs(ffmpeg:string,clip:Clip,out:string,degrees:number):string[]{const vf=degrees===90?"transpose=1":degrees===270?"transpose=2":"hflip,vflip";return [...BASE(ffmpeg),"-i",clip.path,"-vf",vf,"-map","0:v:0","-map","0:a:0?","-sn","-dn",...ENCODE_V,...(clip.probe.has_audio?["-c:a","copy"]:[]),...FASTSTART,out];}
export function sharpenArgs(ffmpeg:string,clip:Clip,out:string,amount:number):string[]{return [...BASE(ffmpeg),"-i",clip.path,"-map_metadata","0","-vf",`unsharp=5:5:${num(amount*2)}:5:5:0`,"-map","0:v:0","-map","0:a:0?","-sn","-dn",...ENCODE_V,...(clip.probe.has_audio?["-c:a","copy"]:[]),...FASTSTART,out];}
/** Ripple: each pixel is read from a position shifted by two crossing sine waves that drift with time. Amplitude is amount x height/100 pixels (about 4.5 px at 448 high), wavelength about height/4. */
export function rippleArgs(ffmpeg:string,clip:Clip,out:string,amount:number):string[]{const a=num(amount),dx=`${a}*H/100*sin(Y*25.6/H+T*5)`,dy=`${a}*H/160*sin(X*25.6/H+T*4)`;const plane=(p:string)=>`${p}='${p}(X+${dx},Y+${dy})'`;return [...BASE(ffmpeg),"-i",clip.path,"-map_metadata","0","-vf",`format=yuv444p,geq=${plane("lum")}:${plane("cb")}:${plane("cr")}`,"-map","0:v:0","-map","0:a:0?","-sn","-dn",...ENCODE_V,...(clip.probe.has_audio?["-c:a","copy"]:[]),...FASTSTART,out];}
export function denoiseArgs(ffmpeg:string,clip:Clip,out:string,amount:number,deblock=false):string[]{return [...BASE(ffmpeg),"-i",clip.path,"-map_metadata","0","-vf",`${deblock?"deblock=filter=strong:block=8,":""}hqdn3d=${num(amount*4.5)}:${num(amount*3.375)}:${num(amount*6.75)}:${num(amount*4.5)}`,"-map","0:v:0","-map","0:a:0?","-sn","-dn",...ENCODE_V,...(clip.probe.has_audio?["-c:a","copy"]:[]),...FASTSTART,out];}
export function pipArgs(ffmpeg:string,clip:Clip,other:Clip,out:string,op:Extract<EditOp,{op:"pip"}>):string[]{const w=Math.max(2,Math.floor((clip.probe.width??1280)*op.size/2)*2),x=op.corner.endsWith("right")?`W-w-W*${num(op.margin)}`:`W*${num(op.margin)}`,y=op.corner.startsWith("bottom")?`H-h-H*${num(op.margin)}`:`H*${num(op.margin)}`;const graph=`[1:v:0]scale=${w}:-2[small];[0:v:0][small]overlay=${x}:${y}:shortest=0[v]`;return [...BASE(ffmpeg),"-i",clip.path,"-stream_loop","-1","-i",other.path,"-filter_complex",graph,"-map","[v]","-map","0:a:0?","-t",num(clip.probe.duration_s??0),"-sn","-dn",...ENCODE_V,...(clip.probe.has_audio?["-c:a","copy"]:[]),...FASTSTART,out];}
/** An apostrophe cannot be escaped inside the single-quoted drawtext value (ffmpeg ends the quote at it, found 2026-11-06 with a title "The Lighthouse's Secret"), so it is drawn as the typographic apostrophe, which is what a printed title uses anyway. */
export const drawTextEscape = (text: string): string => text.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\u2019").replace(/%/g, "\\%").replace(/\n/g, "\\n").replace(/\r/g, "");
export const filterEscape = (text: string): string => drawTextEscape(text).replace(/[{}]/g, (char) => `\\${char}`);
export function captionsArgs(ffmpeg: string, clip: Clip, out: string, op: Extract<EditOp, { op: "captions" }>, font: string, assPath?: string): string[] {
  const fonts = resolveFonts();
  if (fonts && assPath) { const { width, height } = targetDimensions(clip); const events = op.lines.map((line) => `Dialogue: 0,${assTime(line.from_s)},${assTime(line.to_s)},Caption,,0,0,${Math.round(height * 0.06)},,${assText(wrapCaption(line.text))}`).join("\n"); writeAss(assPath, ASS_HEADER(width, height, `Style: Caption,${fonts.caption},${Math.round(height / 24)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,2,2,40,40,${Math.round(height * 0.06)},1`) + events + "\n"); const args = [...BASE(ffmpeg), "-i", clip.path, "-map", "0:v:0?", "-map", "0:a:0?", "-sn", "-dn"]; if (clip.probe.has_video) args.push("-vf", `ass=${assFilterPath(assPath)}:fontsdir=${assFilterPath(fonts.fontsdir)}`, ...ENCODE_V); if (clip.probe.has_audio) args.push("-c:a", "copy"); return [...args, ...FASTSTART, out]; }
  const position = op.position === "top" ? "y=h*0.06" : op.position === "middle" ? "y=(h-text_h)/2" : "y=h-text_h-h*0.06";
  const filters = op.lines.map((line) => `drawtext=fontfile='${drawTextEscape(font)}':text='${drawTextEscape(line.text)}':enable='between(t,${num(line.from_s)},${num(line.to_s)})':fontsize=h/18:fontcolor=white:borderw=3:bordercolor=black:x=(w-text_w)/2:${position}`);
  const args = [...BASE(ffmpeg), "-i", clip.path, "-map", "0:v:0?", "-map", "0:a:0?", "-sn", "-dn"];
  if (clip.probe.has_video) args.push("-vf", filters.join(","), ...ENCODE_V);
  if (clip.probe.has_audio) args.push("-c:a", "copy");
  return [...args, ...FASTSTART, out];
}
const targetDimensions = (clip: Clip) => { const video = videoOf(clip.probe)!; return { width: Math.max(2, Math.round((video.width ?? 1280) / 2) * 2), height: Math.max(2, Math.round((video.height ?? 720) / 2) * 2), rate: video.fps && video.fps > 0 ? num(video.fps) : "30", sampleRate: clip.probe.streams.find((stream) => stream.type === "audio")?.sample_rate ?? 48000 }; };
const rgb = (colour: string): string => colour === "black" ? "0x000000" : colour === "white" ? "0xFFFFFF" : `0x${colour.slice(1)}`;
export function titleCardArgs(ffmpeg: string, clip: Clip, out: string, op: Extract<EditOp, { op: "title_card" }>, font: string, assPath?: string): string[] {
  const { width, height, rate } = targetDimensions(clip);
  const fonts = resolveFonts();
  if (fonts && assPath) {
    const duration = op.duration_s, fadeIn = op.fade_in_s ?? 1.4, fadeOut = op.fade_out_s ?? 0.9, title = op.text.toLocaleUpperCase();
    const wrapped = wrapTitle(title, width, height), size = Math.min(fitTitleFontSize(title, width, height), height / 10), wrappedTitle = wrapped.includes("\\N"), cy = op.position === "top" ? height * 0.25 : op.position === "lower_third" ? height * 0.72 : height * (wrappedTitle ? 0.44 : 0.48);
    const common = `\\fad(${Math.round(fadeIn * 1000)},${Math.round(fadeOut * 1000)})`;
    const titleEvent = `Dialogue: 0,0:00:00.00,${assTime(duration)},Title,,0,0,0,,{\\an5\\pos(${width / 2},${Math.round(cy)})${common}\\blur1.2\\fsp${Math.round(size * 0.06)}\\t(0,${Math.round(duration * 1000)},\\fsp${Math.round(size * 0.07)})}${assText(wrapped)}`;
    const ry = Math.round(cy + size * (wrapped.includes("\\N") ? 1.1 : 0.8));
    const rule = `Dialogue: 0,0:00:00.00,${assTime(duration)},Rule,,0,0,0,,{\\an5\\pos(${width / 2},${ry})${common}\\p1\\bord0\\shad0}m -${Math.round(width * .06)} 0 l ${Math.round(width * .06)} 0 l ${Math.round(width * .06)} 1 l -${Math.round(width * .06)} 1{\\p0}`;
    const sub = op.subtitle ? `\nDialogue: 0,0:00:00.00,${assTime(duration)},Sub,,0,0,0,,{\\an5\\pos(${width / 2},${ry + Math.round(size * .62)})${common}\\fsp${Math.round(height * .006)}}${assText(op.subtitle.toLocaleUpperCase())}` : "";
    const styles = `Style: Title,${fonts.display},${Math.round(size)},${assColor(op.text_color)},${assColor(op.text_color)},&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1\nStyle: Sub,${fonts.smallCaps},${Math.round(height / 32)},${assColor(op.text_color)},${assColor(op.text_color)},&H00000000,&H00000000,0,0,0,0,100,100,${Math.round(height * .006)},0,1,0,0,5,0,0,0,1\nStyle: Rule,${fonts.display},10,${assColor(op.text_color)},${assColor(op.text_color)},&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`;
    writeAss(assPath, ASS_HEADER(width, height, styles) + titleEvent + "\n" + rule + sub + "\n");
    const args = [...BASE(ffmpeg), "-f", "lavfi", "-i", `color=c=${rgb(op.background)}:s=${width}x${height}:r=${rate}:d=${num(duration)}`, "-f", "lavfi", "-i", `anullsrc=r=${targetDimensions(clip).sampleRate}:cl=stereo`, "-filter_complex", `[0:v]format=yuv420p,setsar=1,ass=${assFilterPath(assPath)}:fontsdir=${assFilterPath(fonts.fontsdir)}[v];[1:a]atrim=0:${num(duration)},asetpts=PTS-STARTPTS[a]`, "-map", "[v]", "-map", "[a]", "-t", num(duration), "-shortest", "-r", rate, ...ENCODE_V, ...ENCODE_A]; return [...args, ...FASTSTART, out];
  }
  const y = op.position === "top" ? "h*0.08" : op.position === "lower_third" ? "h*0.68" : "(h-text_h)/2";
  const textFilter = `drawtext=fontfile='${filterEscape(font)}':text='${filterEscape(op.text)}':fontsize=h/9:fontcolor=${rgb(op.text_color)}:x=(w-text_w)/2:y=${y}`;
  const subtitle = op.subtitle ? `,drawtext=fontfile='${filterEscape(font)}':text='${filterEscape(op.subtitle)}':fontsize=h/16:fontcolor=${rgb(op.text_color)}:x=(w-text_w)/2:y=${op.position === "top" ? "h*0.2" : op.position === "lower_third" ? "h*0.78" : "(h-text_h)/2+h*0.09"}` : "";
  const fades = `${op.fade_in_s ? `,fade=t=in:st=0:d=${num(op.fade_in_s)}` : ""}${op.fade_out_s ? `,fade=t=out:st=${num(op.duration_s - op.fade_out_s)}:d=${num(op.fade_out_s)}` : ""}`;
  const args = [...BASE(ffmpeg), "-f", "lavfi", "-i", `color=c=${rgb(op.background)}:s=${width}x${height}:r=${rate}:d=${num(op.duration_s)}`, "-f", "lavfi", "-i", `anullsrc=r=${targetDimensions(clip).sampleRate}:cl=stereo`, "-filter_complex", `[0:v]format=yuv420p,setsar=1,${textFilter}${subtitle}${fades}[v];[1:a]atrim=0:${num(op.duration_s)},asetpts=PTS-STARTPTS[a]`, "-map", "[v]", "-map", "[a]", "-t", num(op.duration_s), "-shortest", "-r", rate, ...ENCODE_V, ...ENCODE_A];
  return [...args, ...FASTSTART, out];
}
/**
 * How far the credits roll and for how long. The block is as tall as its last row sits below the first (`lastRow` rows of h/11 under the frame's bottom edge);
 * the scroll runs from the first row just under the bottom to the last row 10 percent of the height above the top, so every line crosses the frame and leaves.
 * With no duration_s the length is distance / speed (pixels per second) plus a half second of black; with one, the card is exactly that long and the roll is timed to
 * end with it (the length the caller chose wins over speed).
 */
export function creditsLayout(op: { lines: { role?: string | undefined; name: string }[]; speed: number; duration_s?: number | undefined; title?: string | undefined }, height: number, lastRow?: number): { rows: number; distance: number; seconds: number; duration: number } {
  const rows = lastRow ?? (op.lines.length - 1 + (op.title ? 1.4 : 0));
  const distance = height + rows * height / 11 + 0.1 * height;
  if (op.duration_s !== undefined) return { rows, distance, seconds: op.duration_s, duration: op.duration_s };
  const seconds = distance / op.speed;
  return { rows, distance, seconds, duration: Math.max(3, Math.min(120, Math.ceil((seconds + 0.5) * 10) / 10)) };
}
const CREDITS_FADE_S = 0.5;
export function creditsArgs(ffmpeg: string, clip: Clip, out: string, op: Extract<EditOp, { op: "credits" }>, font: string, assPath?: string): string[] {
  const { width, height, rate, sampleRate } = targetDimensions(clip);
  const fonts = resolveFonts();
  if (fonts && assPath) {
    const layout = creditsLayout(op, height), duration = layout.duration, travelMs = Math.round(Math.min(layout.seconds, duration) * 1000);
    const rows: string[] = [];
    const rowOffset = op.title ? 1.4 : 0;
    const fade = `\\fad(${Math.round(CREDITS_FADE_S * 1000)},0)`;
    const move = (x: number, y0: number) => `\\move(${x},${y0},${x},${Math.round(y0 - layout.distance)},0,${travelMs})${fade}`;
    if (op.title) rows.push(`Dialogue: 0,0:00:00.00,${assTime(duration)},Title,,0,0,0,,{\\an5${move(width / 2, height)}}${assText(op.title.toLocaleUpperCase())}`);
    op.lines.forEach((line, i) => { const y0 = Math.round(height + (i + rowOffset) * height / 11); if (!line.role) rows.push(`Dialogue: 0,0:00:00.00,${assTime(duration)},Name,,0,0,0,,{\\an5${move(width / 2, y0)}}${assText(line.name)}`); else { rows.push(`Dialogue: 0,0:00:00.00,${assTime(duration)},Role,,0,0,0,,{\\an6${move(Math.round(width * .49), y0)}}${assText(line.role.toLocaleUpperCase())}`); rows.push(`Dialogue: 0,0:00:00.00,${assTime(duration)},Name,,0,0,0,,{\\an4${move(Math.round(width * .51), y0)}}${assText(line.name)}`); } });
    const styles = `Style: Role,${fonts.smallCaps},${Math.round(height / 36)},${assColor(op.text_color)},${assColor(op.text_color)},&H00000000,&H00000000,0,0,0,0,100,100,${Math.round(height * .006)},0,1,0,0,6,0,0,0,1\nStyle: Name,${fonts.names},${Math.round(height / 24)},${assColor(op.text_color)},${assColor(op.text_color)},&H00000000,&H00000000,0,0,0,0,100,100,${Math.round(height * .002)},0,1,0,0,4,0,0,0,1\nStyle: Title,${fonts.display},${Math.round(height / 12)},${assColor(op.text_color)},${assColor(op.text_color)},&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`;
    writeAss(assPath, ASS_HEADER(width, height, styles) + rows.join("\n") + "\n");
    const graph = `[0:v]format=yuv420p,setsar=1,ass=${assFilterPath(assPath)}:fontsdir=${assFilterPath(fonts.fontsdir)}[v];[1:a]atrim=0:${num(duration)},asetpts=PTS-STARTPTS[a]`;
    return [...BASE(ffmpeg), "-f", "lavfi", "-i", `color=c=${rgb(op.background)}:s=${width}x${height}:r=${rate}:d=${num(duration)}`, "-f", "lavfi", "-i", `anullsrc=r=${sampleRate}:cl=stereo`, "-filter_complex", graph, "-map", "[v]", "-map", "[a]", "-t", num(duration), "-shortest", "-r", rate, ...ENCODE_V, ...ENCODE_A, ...FASTSTART, out];
  }

  const lastLine = op.lines[op.lines.length - 1]!;
  const lastRow = (op.lines.length - 1) * 2 + (op.title ? 2 : 0) + (lastLine.role ? 1 : 0);
  const layout = creditsLayout(op, height, lastRow), duration = layout.duration;
  const speed = op.duration_s !== undefined ? layout.distance / layout.duration : op.speed;
  const entries = [...(op.title ? [{ text: op.title, size: "h/11", y: `h - t*${num(speed)}` }] : []), ...op.lines.flatMap((line, i) => [
    ...(line.role ? [{ text: line.role, size: "h/24", y: `h - t*${num(speed)} + ${i * 2 + (op.title ? 2 : 0)}*h/11` }] : []),
    { text: line.name, size: "h/15", y: `h - t*${num(speed)} + ${i * 2 + (op.title ? 2 : 0) + (line.role ? 1 : 0)}*h/11` },
  ])];
  const filters = entries.map((entry) => `drawtext=fontfile='${filterEscape(font)}':text='${filterEscape(entry.text)}':fontsize=${entry.size}:fontcolor=${rgb(op.text_color)}:x=(w-text_w)/2:y=${entry.y}:alpha='min(1,t/${CREDITS_FADE_S})'`).join(",");
  const args = [...BASE(ffmpeg), "-f", "lavfi", "-i", `color=c=${rgb(op.background)}:s=${width}x${height}:r=${rate}:d=${num(duration)}`, "-f", "lavfi", "-i", `anullsrc=r=${sampleRate}:cl=stereo`, "-filter_complex", `[0:v]format=yuv420p,setsar=1,${filters}[v];[1:a]atrim=0:${num(duration)},asetpts=PTS-STARTPTS[a]`, "-map", "[v]", "-map", "[a]", "-t", num(duration), "-shortest", "-r", rate, ...ENCODE_V, ...ENCODE_A];
  return [...args, ...FASTSTART, out];
}
