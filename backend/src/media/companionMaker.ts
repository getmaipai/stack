// MAKER-H: the companion maker's pack ops as media-lane job kinds. Each one validates its paths the way media.companion_clip does
// (inputs only inside the declared read folders or the job folders, outputs only inside a declared write folder or the job's own
// folder), delegates the work to the image-tools worker (its venv, its memory governor, one op at a time) and writes a report.json
// with `ok` and `reasons` next to its files. Contract: docs/integrations.md.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { z } from "zod";
import { JobFailure, type Job, type JobProgress, type JobRefusal } from "@/lib/jobs";
import { imageTools, ImageToolError, type ImageToolInput, type ImageToolResult } from "@/imagetools/imageTools";
import { inputProblem } from "./commands";
import { jobDir, MediaPathError, resolveReadable, resolveWritableDir, safeName } from "./paths";

export const COMPANION_MAKER_KINDS = ["media.companion_track", "media.companion_shapes", "media.companion_emotion", "media.companion_pack"] as const;
export type CompanionMakerKind = typeof COMPANION_MAKER_KINDS[number];
export const COMPANION_MAKER_LIMITS = { rest_bytes: 32_000_000, clip_bytes: 64_000_000, landmarks_bytes: 2_000_000, descriptor_bytes: 200_000, files_per_folder: 400, pose_files: 8 } as const;
export const COMPANION_MAKER_DEADLINES_MS: Record<CompanionMakerKind, number> = { "media.companion_track": 20 * 60_000, "media.companion_shapes": 20 * 60_000, "media.companion_emotion": 20 * 60_000, "media.companion_pack": 20 * 60_000 };

/** The image-tools call, replaceable by a test. */
export const makerDeps: { run: (input: ImageToolInput, options: { signal?: AbortSignal; onStatus?: (status: string) => void }) => Promise<ImageToolResult>; ffmpeg: (() => Promise<string>) | null } = { run: (input, options) => imageTools.run(input, options), ffmpeg: null };

const Path = z.string().min(1).max(4096);
const Out = { output_dir: Path.optional(), output_name: z.string().min(1).max(200).optional() };
const Box = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const Landmarks = z.record(z.string(), z.unknown()).refine((value) => JSON.stringify(value).length <= COMPANION_MAKER_LIMITS.landmarks_bytes, "landmarks are larger than 2 MB");

export const CompanionTrackInput = z.object({
  rest: Path, frames_dir: Path.optional(), clip: Path.optional(), ...Out,
  scale_clamp: z.number().min(0).max(0.5).optional(), confidence: z.number().min(-1).max(1).optional(), box: Box.optional(), hole: Box.optional(),
  /** MAKER-A3: the clip is a finished stacked-alpha clip (colour on top, matte below); only the top, colour square is tracked. Needs clip. */
  clip_stacked: z.boolean().optional(),
}).strict().refine((v) => !v.clip_stacked || !!v.clip, "clip_stacked needs clip (a stacked clip); frames_dir frames are used as they are").refine((v) => !!v.frames_dir !== !!v.clip, "send either frames_dir (a folder of PNG frames) or clip (an mp4, mov or webm), not both and not neither");
export const CompanionShapesInput = z.object({
  rest: Path, frames_dir: Path, landmarks: Landmarks.optional(), ...Out,
  path: z.enum(["photo", "stylised"]).optional(), mouth_box: Box.optional(), face_height_px: z.number().min(40).max(8000).optional(),
  sets: z.array(z.enum(["calm", "shout"])).min(1).max(2).optional(), region: z.unknown().optional(), tile: z.unknown().optional(),
  flow_scale: z.number().optional(), sharp_amt: z.number().optional(), grain: z.number().optional(), taper: z.number().optional(), chin_limit_px: z.number().optional(),
  // stylised path only
  flow_sigma: z.number().min(0).max(30).optional(), amp: z.number().min(0).max(1).optional(), prepull: z.record(z.string(), z.number().min(0).max(1)).optional(),
  fg_erode: z.number().min(0).max(31).optional(), fg_sigma: z.number().min(0).max(20).optional(), feather: z.number().min(0.5).max(60).optional(), chin_fade: z.tuple([z.number(), z.number()]).optional(),
  alpha_radii: z.tuple([z.number().min(0.1).max(0.5), z.number().min(0.1).max(0.5)]).optional(), key_green: z.boolean().optional(), dark_fraction: z.number().min(0.1).max(0.9).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.path === "stylised") { if (!v.mouth_box) ctx.addIssue({ code: "custom", message: "the stylised path needs mouth_box [x, y, width, height] in picture pixels: the tall lower-face box around the mouth" }); }
  else if (!v.landmarks) ctx.addIssue({ code: "custom", message: "the photo path needs landmarks (or send path: \"stylised\" with a mouth_box for a cartoon)" });
});
export const CompanionEmotionInput = z.object({
  rest: Path, landmarks: Landmarks, poses: z.record(z.string(), z.array(Path).min(1).max(2)).refine((value) => Object.keys(value).every((key) => ["angry", "excited", "alarmed", "sad"].includes(key)), "poses may name only angry, excited, alarmed and sad"), ...Out,
  kinds: z.array(z.enum(["angry", "excited", "alarmed", "sad"])).min(1).max(4).optional(), strength: z.number().min(0.2).max(1).optional(), calibrate: z.boolean().optional(),
}).strict();
export const CompanionPackInput = z.object({
  rest: Path, staging: Path, descriptor: z.record(z.string(), z.unknown()).refine((value) => JSON.stringify(value).length <= COMPANION_MAKER_LIMITS.descriptor_bytes, "the descriptor is larger than 200 KB"), ...Out,
}).strict();

const PARSERS = { "media.companion_track": CompanionTrackInput, "media.companion_shapes": CompanionShapesInput, "media.companion_emotion": CompanionEmotionInput, "media.companion_pack": CompanionPackInput } as const;
const bad = (message: string): JobFailure => new JobFailure(message, { failure: { code: "bad_input", message } });
const failure = (code: string, message: string): JobFailure => new JobFailure(message, { failure: { code, message } });

function fileProblem(path: string, cap: number, what: string, exts: string[]): void {
  if (!exts.includes(extname(path).toLowerCase())) throw bad(`${what} must be one of ${exts.join(", ")}. Convert it and send it again.`);
  if (statSync(path).size > cap) throw bad(`${what} is larger than ${Math.round(cap / 1_000_000)} MB. Send a smaller one.`);
}
function folderProblem(path: string, what: string): void {
  let count = 0;
  const walk = (dir: string): void => { for (const entry of readdirSync(dir, { withFileTypes: true })) { if (entry.isDirectory()) walk(join(dir, entry.name)); else if (++count > COMPANION_MAKER_LIMITS.files_per_folder) throw bad(`${what} holds more than ${COMPANION_MAKER_LIMITS.files_per_folder} files. Send only the files the step needs.`); } };
  walk(path);
}

/** The paths of an input, resolved and checked: the same rules the precheck and the runner share. */
function resolve(kind: CompanionMakerKind, raw: Record<string, unknown>) {
  const input = PARSERS[kind].parse(raw) as any;
  const rest = resolveReadable(input.rest, "The rest picture"); fileProblem(rest, COMPANION_MAKER_LIMITS.rest_bytes, "The rest picture", [".png", ".webp", ".jpg", ".jpeg"]);
  const out: Record<string, any> = { input, rest };
  if (input.frames_dir) { out.frames = resolveReadable(input.frames_dir, "The frames folder", "dir"); }
  if (input.clip) { out.clip = resolveReadable(input.clip, "The clip"); fileProblem(out.clip, COMPANION_MAKER_LIMITS.clip_bytes, "The clip", [".mp4", ".mov", ".webm"]); }
  if (input.staging) out.staging = resolveReadable(input.staging, "The staging folder", "dir");
  if (input.poses) {
    out.poses = {} as Record<string, string[]>; let total = 0;
    for (const [pose, paths] of Object.entries(input.poses as Record<string, string[]>)) { out.poses[pose] = paths.map((path) => { total++; const resolved = resolveReadable(path, `The ${pose} pose picture`); fileProblem(resolved, COMPANION_MAKER_LIMITS.rest_bytes, `The ${pose} pose picture`, [".png", ".webp", ".jpg", ".jpeg"]); return resolved; }); }
    if (total > COMPANION_MAKER_LIMITS.pose_files) throw bad("Too many pose pictures. Send one or two for each emotion.");
  }
  let dir: string | undefined;
  if (input.output_dir) { dir = resolveWritableDir(input.output_dir); if (input.output_name) dir = resolveWritableDir(join(dir, safeName(input.output_name, ""))); }
  else if (input.output_name) safeName(input.output_name, "");
  out.dir = dir;
  return out;
}

/** What can be refused before the job takes a place in the queue. */
export function companionMakerPrecheck(kind: CompanionMakerKind): (input: Record<string, unknown>) => JobRefusal | null {
  return (raw) => {
    try {
      const r = resolve(kind, raw);
      if (r.frames) folderProblem(r.frames, "The frames folder");
      if (r.staging) folderProblem(r.staging, "The staging folder");
      return null;
    } catch (error) {
      if (error instanceof MediaPathError) return { reason: error.message, code: error.code, status: 422 };
      if (error instanceof JobFailure) return { reason: error.message, code: "bad_input", status: 422 };
      if (error && typeof error === "object" && "issues" in error) return { reason: inputProblem(error as never), code: "bad_input", status: 422 };
      throw error;
    }
  };
}

const SUB: Record<CompanionMakerKind, string> = { "media.companion_track": "", "media.companion_shapes": "shapes", "media.companion_emotion": "emotion", "media.companion_pack": "pack" };
const report = (dir: string, body: Record<string, unknown>): string => { const path = join(dir, "report.json"); writeFileSync(path, JSON.stringify(body, null, 1)); return path; };

function workerFailure(error: unknown): never {
  if (error instanceof ImageToolError) throw failure(error.code === "cancelled" ? "cancelled" : error.code, error.message);
  throw error;
}

/** Runs one maker op; `signal` cancels it (the image-tools worker is stopped), `progress` goes 0, 5 while it works, 100 when it is written. */
export function companionMakerRunner(kind: CompanionMakerKind, extractFrames?: (clip: string, into: string, signal: AbortSignal, stacked?: boolean) => Promise<void>) {
  return async (job: Job, signal: AbortSignal, progress: JobProgress): Promise<Record<string, unknown>> => {
    progress({ status: "checking the files", percent: 0 });
    let r: Record<string, any>;
    try { r = resolve(kind, (job.input ?? {}) as Record<string, unknown>); }
    catch (error) { if (error instanceof MediaPathError) throw failure(error.code, error.message); if (error && typeof error === "object" && "issues" in error) throw bad(inputProblem(error as never)); throw error; }
    const dir: string = r.dir ?? jobDir(job.id);
    mkdirSync(dir, { recursive: true });
    if (existsSync(join(dir, "report.json"))) throw bad("The output folder already has a companion maker report. Choose an empty output folder or another output name.");
    const sub = SUB[kind] ? join(dir, SUB[kind]) : dir;
    if (SUB[kind] && existsSync(sub) && readdirSync(sub).length) throw bad(`The output folder already has a ${SUB[kind]} folder with files in it. Choose an empty output folder or another output name.`);
    const input = r.input;
    const started = Date.now();
    const onStatus = (status: string): void => progress({ status });
    const workDir = join(jobDir(job.id), `.maker-frames-${kind.split("_")[1]}`);
    let result: ImageToolResult;
    try {
      const restBytes = new Uint8Array(await Bun.file(r.rest).arrayBuffer());
      progress({ status: "working", percent: 5 });
      if (kind === "media.companion_track") {
        let frames = r.frames as string;
        if (r.clip) {
          if (!extractFrames) throw bad("Clip input is not available here. Send frames_dir instead.");
          rmSync(workDir, { recursive: true, force: true }); mkdirSync(workDir, { recursive: true });
          progress({ status: "reading the clip", percent: 8 });
          await extractFrames(r.clip, workDir, signal, input.clip_stacked === true); frames = workDir;
          progress({ status: "working", percent: 20 });
        }
        const params: Record<string, unknown> = { frames_dir: frames };
        for (const key of ["scale_clamp", "confidence", "box", "hole"]) if (input[key] !== undefined) params[key] = input[key];
        result = await makerDeps.run({ operation: "clip_track", image: restBytes, params }, { signal, onStatus });
        const track = result.track ?? { m: [], res: [], cc: [], low: [], frames: 0 };
        const trackPath = join(dir, "track.json");
        writeFileSync(trackPath, JSON.stringify(track));
        const reasons = track.low.length ? [`${track.low.length} of ${track.frames} frames tracked below the confidence; check frames ${track.low.slice(0, 10).join(", ")}.`] : [];
        const body = { ok: track.frames > 0 && reasons.length === 0, reasons, frames: track.frames, low: track.low, track_file: "track.json", elapsed_ms: Date.now() - started };
        const reportPath = report(dir, body);
        progress({ status: "done", percent: 100 });
        return { output_dir: dir, track_path: trackPath, report_path: reportPath, ...body, ms: result.ms };
      }
      if (kind === "media.companion_shapes") {
        const params: Record<string, unknown> = { frames_dir: r.frames, output_dir: sub };
        if (input.landmarks !== undefined) params.landmarks = input.landmarks;
        for (const key of ["sets", "region", "tile", "flow_scale", "sharp_amt", "grain", "taper", "chin_limit_px", "path", "mouth_box", "face_height_px", "flow_sigma", "amp", "prepull", "fg_erode", "fg_sigma", "feather", "chin_fade", "alpha_radii", "key_green", "dark_fraction"]) if (input[key] !== undefined) params[key] = input[key];
        result = await makerDeps.run({ operation: "shapes_bake", image: restBytes, params }, { signal, onStatus });
        const shapes = result.shapes;
        const body = { ok: !!shapes?.ok, reasons: shapes?.reasons ?? ["The mouth baker returned no report."], shapes_dir: sub, elapsed_ms: Date.now() - started };
        const reportPath = report(dir, body);
        progress({ status: "done", percent: 100 });
        return { output_dir: dir, report_path: reportPath, ...body, report: shapes, ms: result.ms };
      }
      if (kind === "media.companion_emotion") {
        const params: Record<string, unknown> = { landmarks: input.landmarks, poses: r.poses, out_dir: sub };
        for (const key of ["kinds", "strength", "calibrate"]) if (input[key] !== undefined) params[key] = input[key];
        result = await makerDeps.run({ operation: "emotion_bake", image: restBytes, params }, { signal, onStatus });
        const data = (result.data ?? {}) as { ok_all?: boolean; kinds?: Record<string, { ok?: boolean; reasons?: string[] }> };
        const reasons = Object.entries(data.kinds ?? {}).flatMap(([name, k]) => (k.reasons ?? []).map((reason) => `${name}: ${reason}`));
        const body = { ok: !!data.ok_all, reasons, emotion_dir: sub, elapsed_ms: Date.now() - started };
        const reportPath = report(dir, body);
        progress({ status: "done", percent: 100 });
        return { output_dir: dir, report_path: reportPath, ...body, report: data, ms: result.ms };
      }
      const descriptor = input.descriptor;
      result = await makerDeps.run({ operation: "pack_assemble", image: restBytes, params: { staging: r.staging, out_dir: sub, descriptor } }, { signal, onStatus });
      const pack = (result.data as { pack?: Record<string, unknown> } | undefined)?.pack ?? {};
      const body = { ok: true, reasons: [] as string[], pack_dir: sub, pack, elapsed_ms: Date.now() - started };
      const reportPath = report(dir, body);
      progress({ status: "done", percent: 100 });
      return { output_dir: dir, report_path: reportPath, ...body, ms: result.ms };
    } catch (error) {
      if (signal.aborted) throw new Error("Cancelled.");
      // A refusal the maker can act on (a 4xx from the worker: missing frames, wrong size, over budget) is a finished job with ok false, the way the bakers report their own validators; a cancelled or broken engine is a failed job.
      if (error instanceof ImageToolError && error.status >= 400 && error.status < 499) {
        const body = { ok: false, reasons: [error.message], code: error.code, elapsed_ms: Date.now() - started };
        return { output_dir: dir, report_path: report(dir, body), ...body };
      }
      workerFailure(error);
    } finally { rmSync(workDir, { recursive: true, force: true }); }
  };
}
