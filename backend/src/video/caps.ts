// VF-CAPS-01: the one contract for video operations. Every row here is built from the tables the engines already run on (VIDEO_SPECS, the
// measured LTX tables, the edit and Ingredients constants, the H3 constants and the swap limits of its pack) and from nothing else, so the
// discovery views, the request validators and the pack JSON read the same numbers and cannot drift apart. A request is checked against the
// row of the operation it asks for (`checkVideoInputs`); the jobs catalog publishes the rows; a test asserts the pack JSON equals what the
// rows derive (`jobLimitsFromRows`, `jobCapabilitiesFromRows`). Pure: no files, no processes, no clock.
import type { StackJobName, StackOperationRow, StackCapabilityOperation } from "@maipai/spec/stack/ts/stack-model-pack.js";
import { INGREDIENTS_ADAPTER_FILE, VIDEO_ENGINE_NAMES } from "@/packs/videoNames";
import { packFor } from "@/packs/loader";
import { H3_MIN_SECONDS } from "@/video/h3";
import { LTX25_FPS, LTX25_INGREDIENTS_HEIGHT, LTX25_INGREDIENTS_MAX_SECONDS, LTX25_INGREDIENTS_MAX_SHEETS, LTX25_INGREDIENTS_MIN_SECONDS, LTX25_INGREDIENTS_WIDTH, LTX25_MAX_MEASURED, LTX25_MEASURED, ltx25MaxRefusal, ltx25Refusal, ltx25TrueSize } from "@/video/ltx25";
import { LTX25_EDIT_EXTEND_MAX_SECONDS, LTX25_EDIT_EXTEND_MIN_SECONDS, LTX25_EDIT_RETAKE_MAX_SECONDS, LTX25_EDIT_RETAKE_MIN_SECONDS, LTX25_MAX_EDIT_MEASURED } from "@/video/ltx25Edit";
import { VIDEO_SPECS, type VideoQuality } from "@/video/videoGen";

export type VideoEngine = "ltx25" | "ltx25max" | "h3";
export const VIDEO_ENGINES: readonly VideoEngine[] = ["ltx25", "ltx25max", "h3"];
type Level = "standard" | "boost" | "max";
type Orientation = "landscape" | "portrait" | "square";
type Size = StackOperationRow["sizes"][number];
type Inputs = StackOperationRow["inputs"];

/** The quality each engine's rows read their flags from. The streaming H3 build makes the same clips, so it shares the H3 rows. */
const QUALITY: Record<VideoEngine, VideoQuality> = { ltx25: "ltx25", ltx25max: "ltx25max", h3: "h3" };
export function engineOfQuality(quality: VideoQuality): VideoEngine | null {
  return quality === "ltx25" || quality === "ltx25max" ? quality : quality === "h3" || quality === "h3stream" ? "h3" : null;
}
/** The part (and pack) that serves an engine: the model id the engine's quality already names. */
export const partOfEngine = (engine: VideoEngine): string => VIDEO_SPECS[QUALITY[engine]].modelId;
export const engineOfPart = (part: string): VideoEngine | null => VIDEO_ENGINES.find((engine) => partOfEngine(engine) === part) ?? null;

export const REFERENCES_UNAVAILABLE = "Nothing installed here makes reference-picture clips yet.";
export const ENHANCE_UNAVAILABLE = "Nothing installed here enhances a finished clip yet.";
export const SHEET_UNAVAILABLE = "Not served through the generic door yet; use the Ingredients route (POST /v1/videos/ingredients).";
/** The shortest window a swap is asked for, in seconds (the generic swap door's own floor). */
export const SWAP_WINDOW_MIN_SECONDS = 1;
const SHEET_LEVEL: Level = "standard"; // the Ingredients clip is the `standard` level of its job in the Max pack

const NONE: Inputs = { start_picture: false, end_picture: false, references: 0, sheets: 0, source_clip: false };
const orientationOf = (width: number, height: number): Orientation => (width > height ? "landscape" : width < height ? "portrait" : "square");
const sizeOf = (width: number, height: number): Size => ({ width, height, orientation: orientationOf(width, height) });
/** A size and the same size turned on its side (a tall clip has the pixels of its wide one). */
const withTall = (width: number, height: number): Size[] => (width === height ? [sizeOf(width, height)] : [sizeOf(width, height), sizeOf(height, width)]);
const sizeText = (size: { width: number; height: number }): string => `${size.width}x${size.height}`;

interface Draft { operation: StackCapabilityOperation; level: Level; reason: string | null; inputs?: Partial<Inputs>; seconds: { min: number; max: number }; sizes: Size[]; audio: boolean; keepsSourceAudio?: boolean; requires: string[] }
/** One row, with its own copy of every list so no caller can change another's. */
function row(draft: Draft): StackOperationRow {
  const engine = draft.operation === "swap" || draft.sizes.some((size) => size.width === 864 || size.height === 864) ? "h3" : draft.level === "max" ? "ltx25max" : "ltx25";
  const part = engine === "h3" ? VIDEO_SPECS.h3.modelId : VIDEO_SPECS[engine].modelId;
  const recipes = packFor(part)?.pack.jobs.find((job) => job.job === "clip")?.profiles ?? [];
  const recipe = recipes.find((item) => item.level === draft.level && (!item.operations || item.operations.includes(draft.operation)) && (!item.size || draft.sizes.some((size) => size.width === item.size!.width && size.height === item.size!.height))) ?? recipes.find((item) => item.level === draft.level && !item.size);
  return {
    operation: draft.operation, level: draft.level, available: draft.reason === null, ...(draft.reason === null ? {} : { unavailable_reason: draft.reason }),
    ...(recipe?.label ? { label: recipe.label } : {}), ...(recipe?.description ? { description: recipe.description } : {}),
    inputs: { ...NONE, ...draft.inputs }, seconds: { ...draft.seconds }, sizes: draft.sizes.map((size) => ({ ...size })),
    sound: { generated: draft.audio, voice_reference: false, keeps_source_audio: draft.keepsSourceAudio === true }, requires: [...draft.requires],
  };
}

/** The clips made from words or pictures at one level, plus the two operations no engine here does yet (they stay in the contract so Home sees them and why they are off). */
function generating(engine: VideoEngine, level: Level, sizes: Size[], seconds: { min: number; max: number }): StackOperationRow[] {
  const spec = VIDEO_SPECS[QUALITY[engine]];
  const subject = VIDEO_ENGINE_NAMES[engine].subject;
  const start = spec.imageToVideo;
  const both = start && spec.endImage;
  const common = { level, seconds, sizes, audio: spec.audio };
  const requires = [VIDEO_ENGINE_NAMES[engine].requires];
  return [
    row({ ...common, operation: "clip_text", reason: null, requires }),
    row({ ...common, operation: "clip_start_picture", reason: start ? null : `${subject} cannot start a clip from a picture.`, inputs: { start_picture: start }, requires }),
    row({ ...common, operation: "clip_start_end_pictures", reason: both ? null : `${subject} cannot end a clip on a picture.`, inputs: { start_picture: start, end_picture: both }, requires }),
    row({ ...common, operation: "clip_references", reason: REFERENCES_UNAVAILABLE, requires: [] }),
    row({ ...common, operation: "enhance", reason: ENHANCE_UNAVAILABLE, requires: [] }),
  ];
}

function ltx25Rows(): StackOperationRow[] {
  return (["standard", "boost"] as const).flatMap((level) => {
    const measured = LTX25_MEASURED.filter((item) => item.profile === level);
    if (!measured.length) return [];
    return generating("ltx25", level, measured.flatMap((item) => withTall(item.width, item.height)), { min: 1, max: Math.max(...measured.map((item) => item.maxSeconds)) });
  });
}

function ltx25MaxRows(): StackOperationRow[] {
  const spec = VIDEO_SPECS.ltx25max;
  const requires = [VIDEO_ENGINE_NAMES.ltx25max.requires];
  const edit = (operation: "extend" | "retake", min: number, max: number) => row({ operation, level: "max", reason: null, inputs: { source_clip: true }, seconds: { min, max }, sizes: LTX25_MAX_EDIT_MEASURED.map((item) => sizeOf(item.width, item.height)), audio: spec.audio, keepsSourceAudio: true, requires });
  return [
    ...generating("ltx25max", "max", withTall(1024, 576), { min: 1, max: 10 }),
    row({ operation: "clip_film_shot", level: "max", reason: null, seconds: { min: 1, max: 5 }, sizes: [{ width: 1920, height: 1088, orientation: "landscape" }, { width: 1088, height: 1920, orientation: "portrait" }], audio: spec.audio, requires }),
    edit("extend", LTX25_EDIT_EXTEND_MIN_SECONDS, LTX25_EDIT_EXTEND_MAX_SECONDS),
    edit("retake", LTX25_EDIT_RETAKE_MIN_SECONDS, LTX25_EDIT_RETAKE_MAX_SECONDS),
    // INGREDIENTS-01: served only by POST /v1/videos/ingredients, never through the generic door, so the row is in the contract but off.
    row({ operation: "clip_sheet", level: SHEET_LEVEL, reason: SHEET_UNAVAILABLE, inputs: { sheets: LTX25_INGREDIENTS_MAX_SHEETS }, seconds: { min: LTX25_INGREDIENTS_MIN_SECONDS, max: LTX25_INGREDIENTS_MAX_SECONDS }, sizes: [sizeOf(LTX25_INGREDIENTS_WIDTH, LTX25_INGREDIENTS_HEIGHT)], audio: spec.audio, requires: [...requires, `Ingredients adapter file ${INGREDIENTS_ADAPTER_FILE}`] }),
  ];
}

function h3Rows(): StackOperationRow[] {
  const spec = VIDEO_SPECS.h3;
  const [width, height] = spec.defaultSize.split("x").map(Number) as [number, number];
  const rows = [
    ...generating("h3", "standard", withTall(width, height), { min: H3_MIN_SECONDS, max: spec.maxSeconds }),
    ...generating("h3", "boost", withTall(width, height), { min: H3_MIN_SECONDS, max: spec.maxSeconds }),
  ];
  // The swap limits are the pack's own: the levels, the sizes and the most references and seconds it names.
  const swap = packFor(partOfEngine("h3"))?.pack.jobs.find((job) => job.job === "swap");
  if (swap) {
    for (const level of ["standard", "boost"] as const) {
      const max = swap.limits.max_seconds?.[level];
      const sizes = (["landscape", "portrait", "square"] as const).flatMap((shape) => { const pixels = swap.limits.shapes?.[shape]?.[level]; return pixels ? [sizeOf(pixels.width, pixels.height)] : []; });
      if (max === undefined || !sizes.length) continue;
      rows.push(row({ operation: "swap", level, reason: null, inputs: { references: swap.limits.max_references ?? 0, source_clip: true }, seconds: { min: SWAP_WINDOW_MIN_SECONDS, max }, sizes, audio: swap.capabilities.sound, keepsSourceAudio: true, requires: [VIDEO_ENGINE_NAMES.h3.requires] }));
    }
  }
  return rows;
}

/** Every row one engine publishes. */
export function rowsOfEngine(engine: VideoEngine): StackOperationRow[] {
  return engine === "ltx25" ? ltx25Rows() : engine === "ltx25max" ? ltx25MaxRows() : h3Rows();
}
/** Every row of every engine. */
export function videoOperationRows(): StackOperationRow[] { return VIDEO_ENGINES.flatMap(rowsOfEngine); }

/** The operations each generic job publishes rows for. */
export const JOB_OPERATIONS: Readonly<Partial<Record<StackJobName, readonly StackCapabilityOperation[]>>> = {
  clip: ["clip_text", "clip_start_picture", "clip_start_end_pictures", "clip_references", "clip_film_shot", "extend", "retake", "enhance"],
  clip_from_sheet: ["clip_sheet"],
  swap: ["swap"],
};
/** The rows of the part that serves a job, for that job's operations; none when the part is not a video engine here or the job has no rows. */
export function rowsForJob(part: string, job: StackJobName): StackOperationRow[] {
  const engine = engineOfPart(part);
  const operations = JOB_OPERATIONS[job];
  return engine && operations ? rowsOfEngine(engine).filter((item) => operations.includes(item.operation)) : [];
}

const area = (size: { width: number; height: number }): number => size.width * size.height;
/** The pack's `limits.max_seconds` and `limits.shapes` of a job: the longest clip per level over every row, and the largest size per orientation and level. */
export function jobLimitsFromRows(rows: readonly StackOperationRow[]) {
  const max_seconds: Partial<Record<Level, number>> = {};
  const shapes: Partial<Record<Orientation, Partial<Record<Level, { width: number; height: number }>>>> = {};
  for (const item of rows) {
    if (item.operation === "clip_film_shot" || item.operation === "enhance") continue;
    max_seconds[item.level] = Math.max(max_seconds[item.level] ?? 0, item.seconds.max);
    for (const size of item.sizes) {
      const level = (shapes[size.orientation] ??= {});
      const current = level[item.level];
      if (!current || area(size) > area(current)) level[item.level] = { width: size.width, height: size.height };
    }
  }
  return { max_seconds, shapes };
}
/** The pack's `capabilities` that rows decide. `text` and `keeps_likeness` are not about inputs and stay the pack's own. */
export function jobCapabilitiesFromRows(rows: readonly StackOperationRow[]): { end_picture: boolean; sound: boolean } {
  return { end_picture: rows.some((item) => item.inputs.end_picture), sound: rows.some((item) => item.sound.generated) };
}

/** The few numbers a model listing shows for an engine, read off its rows so the listing cannot say something the validators do not. */
export function engineFacts(engine: VideoEngine): { max_seconds: number; audio: boolean; image_to_video: boolean; end_image: boolean } {
  const rows = rowsOfEngine(engine);
  const text = rows.filter((item) => item.operation === "clip_text");
  return {
    max_seconds: Math.max(...text.map((item) => item.seconds.max)), audio: text.some((item) => item.sound.generated),
    image_to_video: rows.some((item) => item.available && item.inputs.start_picture), end_image: rows.some((item) => item.available && item.inputs.end_picture),
  };
}

// ---- choosing the row of a request ----

export interface VideoPictures { start_picture?: boolean; end_picture?: boolean; references?: number }
/** The operation a request asks for, from the pictures it sends. References win: they are a different operation. */
export function operationOfInputs(input: VideoPictures): StackCapabilityOperation {
  if ((input.references ?? 0) > 0) return "clip_references";
  return input.start_picture && input.end_picture ? "clip_start_end_pictures" : input.start_picture ? "clip_start_picture" : "clip_text";
}
/** The row of an operation at a size (a size names its level: 512x256 is Standard and 768x448 is Boost). Null when no row of the engine has that operation at that size. */
export function rowForRequest(engine: VideoEngine, operation: StackCapabilityOperation, size: { width: number; height: number }): StackOperationRow | null {
  return rowsOfEngine(engine).find((item) => item.operation === operation && item.sizes.some((s) => s.width === size.width && s.height === size.height)) ?? null;
}

/** The sizes an engine makes from words (the other operations at a level make the same ones). */
function engineSizes(engine: VideoEngine): Size[] {
  return rowsOfEngine(engine).filter((item) => item.operation === "clip_text" || item.operation === "clip_film_shot").flatMap((item) => item.sizes);
}
/** The plain refusal for a size the engine does not make. */
export function sizeRefusalLine(engine: VideoEngine): string {
  const sizes = engineSizes(engine);
  const wide = [...new Set(sizes.filter((size) => size.orientation !== "portrait").map(sizeText))];
  const tall = [...new Set(sizes.filter((size) => size.orientation === "portrait").map(sizeText))];
  const subject = VIDEO_ENGINE_NAMES[engine].subject;
  if (engine === "ltx25") return `${subject} makes ${wide.join(", ")}; a height between is rounded down to a multiple of 64 (512x288 gives 512x256). Pick one of those sizes (or the same size turned tall, such as ${tall[0]}).`;
  if (engine === "ltx25max") return `${subject} makes ${wide.join(", ")} only (or tall, ${tall.join(", ")}). Pick that size.`;
  return `${subject} makes ${wide.join(", ")} (wide) or ${tall.join(", ")} (tall) clips. Choose one of those.`;
}

/**
 * "832x480" (or the engine's default) to the size the clip is made, kept and reported at, or the sentence to return. A Standard or Boost
 * request may name the nominal size (each side a multiple of 32, rounded down to the true multiple of 64); the others name their size exactly.
 */
export function resolveVideoSize(engine: VideoEngine, text: string | undefined): { width: number; height: number } | string {
  const found = /^(\d{3,4})x(\d{3,4})$/.exec(text ?? VIDEO_SPECS[QUALITY[engine]].defaultSize);
  const line = sizeRefusalLine(engine);
  if (!found) return line;
  let width = Number(found[1]); let height = Number(found[2]);
  if (engine === "ltx25") { if (width % 32 || height % 32) return line; ({ width, height } = ltx25TrueSize(width, height)); }
  if (engine === "ltx25max" && (width % 64 || height % 64)) return line;
  const availableSizes = engine === "ltx25max" ? rowsOfEngine(engine).filter((item) => item.operation === "clip_text" || item.operation === "clip_film_shot").flatMap((item) => item.sizes) : engineSizes(engine);
  return availableSizes.some((size) => size.width === width && size.height === height) ? { width, height } : line;
}

// ---- checking a request against its row ----

export interface VideoInputs extends VideoPictures {
  /** Names the model in a refusal; without it a refusal says "This video model". */
  engine?: VideoEngine;
  size?: { width: number; height: number };
  seconds?: number;
  sheets?: number;
  source_clip?: boolean;
  /** Whether a requirement of the row (one of its `requires` strings) is installed. Left out, installation is not checked. */
  installed?: (requirement: string) => boolean;
}
export interface VideoRefusal { code: "input_not_supported" | "not_installed" | "bad_size" | "bad_seconds"; line: string; missing?: string[] }

const COMBINATION_LINE = "This model cannot use a start picture and reference pictures together yet. Send one or the other.";
/** What each operation needs sent: the control, and the words naming it. */
const REQUIRED: Partial<Record<StackCapabilityOperation, Array<[keyof Inputs, string, string]>>> = {
  clip_start_picture: [["start_picture", "start picture", "Send one, or ask for a clip from words only."]],
  clip_start_end_pictures: [["start_picture", "start picture", "Send one, or ask for a clip from words only."], ["end_picture", "end picture", "Send one, or send only a start picture."]],
  clip_sheet: [["sheets", "character sheet", "Send one or two."]],
  extend: [["source_clip", "source clip", "Send the clip to extend."]],
  retake: [["source_clip", "source clip", "Send the clip to retake."]],
  swap: [["source_clip", "source clip", "Send the clip to change."], ["references", "reference picture", "Send at least one."]],
};

function secondsLine(engine: VideoEngine | undefined, item: StackOperationRow, size: { width: number; height: number } | undefined, seconds: number): string {
  const subject = engine ? VIDEO_ENGINE_NAMES[engine].subject : "This video model";
  // The LTX tables already say, in words, which size a longer clip needs.
  if (seconds > item.seconds.max && size) {
    const legacy = engine === "ltx25" ? ltx25Refusal(size.width, size.height, seconds * LTX25_FPS + 1) : engine === "ltx25max" ? ltx25MaxRefusal(size.width, size.height, seconds * LTX25_FPS + 1) : null;
    if (legacy) return legacy;
  }
  return item.seconds.min === item.seconds.max ? `${subject} makes clips of ${item.seconds.max} seconds. Choose that length.` : `${subject} makes clips of ${item.seconds.min} to ${item.seconds.max} seconds. Choose a length in that range.`;
}

/**
 * Checks one request against the row of the operation it asks for: null when the row takes it, else the typed refusal. Order: the row is on,
 * the pictures fit together, every input is one the row takes, everything the operation needs was sent, the size, the length, and last what is
 * installed. A refusal names the control or the installation; nothing is dropped or lowered silently.
 */
export function checkVideoInputs(item: StackOperationRow, input: VideoInputs): VideoRefusal | null {
  const subject = input.engine ? VIDEO_ENGINE_NAMES[input.engine].subject : "This video model";
  const refuse = (code: VideoRefusal["code"], line: string, missing?: string[]): VideoRefusal => ({ code, line, ...(missing ? { missing } : {}) });
  if (!item.available) return refuse("input_not_supported", item.unavailable_reason ?? `${subject} does not do that yet.`);
  const references = input.references ?? 0;
  const sheets = input.sheets ?? 0;
  if (input.start_picture && references > 0 && !(item.inputs.start_picture && item.inputs.references > 0)) return refuse("input_not_supported", COMBINATION_LINE);
  if (input.start_picture && !item.inputs.start_picture) return refuse("input_not_supported", `${subject} cannot start a clip from a picture. Send words only, or pick a model that takes a start picture.`);
  if (input.end_picture && !item.inputs.end_picture) return refuse("input_not_supported", `${subject} cannot end a clip on a picture. Leave the end picture out, or pick a model that takes an end picture.`);
  if (references > 0 && item.inputs.references === 0) return refuse("input_not_supported", `${subject} cannot start a clip from reference pictures. Use a start picture, or pick a model that takes references.`);
  if (references > item.inputs.references) return refuse("input_not_supported", `${subject} takes at most ${item.inputs.references} reference pictures. Send ${item.inputs.references} or fewer.`);
  if (sheets > 0 && item.inputs.sheets === 0) return refuse("input_not_supported", `${subject} cannot make a clip from character sheets here. Send words, or use the Ingredients route.`);
  if (sheets > item.inputs.sheets) return refuse("input_not_supported", `${subject} takes at most ${item.inputs.sheets} character sheets. Send ${item.inputs.sheets} or fewer.`);
  if (input.source_clip && !item.inputs.source_clip) return refuse("input_not_supported", `${subject} cannot edit a clip you send in this operation. Leave the source clip out, or ask to extend, retake or swap.`);
  const given: Record<keyof Inputs, number> = { start_picture: input.start_picture ? 1 : 0, end_picture: input.end_picture ? 1 : 0, references, sheets, source_clip: input.source_clip ? 1 : 0 };
  for (const [control, words, advice] of REQUIRED[item.operation] ?? []) {
    if (given[control] === 0) return refuse("input_not_supported", `${subject} needs a ${words} for this. ${advice}`, [words]);
  }
  if (input.size && !item.sizes.some((size) => size.width === input.size!.width && size.height === input.size!.height)) {
    return refuse("bad_size", input.engine ? sizeRefusalLine(input.engine) : `${subject} does not make ${sizeText(input.size)}. It makes ${item.sizes.map(sizeText).join(", ")}. Pick one of those.`);
  }
  if (input.seconds !== undefined && (input.seconds < item.seconds.min || input.seconds > item.seconds.max)) return refuse("bad_seconds", secondsLine(input.engine, item, input.size, input.seconds));
  if (input.installed) {
    const missing = item.requires.filter((requirement) => !input.installed!(requirement));
    if (missing.length) return refuse("not_installed", `Not installed: ${missing.join("; ")}. An admin can add ${missing.length === 1 ? "it" : "them"} in Settings, AI and models.`, missing);
  }
  return null;
}
