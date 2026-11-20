// VF-FINISH-01: the clip finisher. A pack's level recipe declares a short list of typed `finish` steps (`StackFinishStep` in the spec); they run after the
// engine writes a clip. The engine's file is never changed: the finished copy is written beside it, and a bad result is deleted so the clip stays as the engine
// made it. This module only validates the steps, plans them and runs ffmpeg. `model_upscale` is the caller's (the media upscale op); `lanczos_scale` and
// `loudness` are not run here and are reported as skipped.
import { existsSync, rmSync } from "node:fs";
import type { StackFinishStep as StackFinishStepSchema } from "@maipai/spec/stack/ts/stack-model-pack.js";
import { probeFile } from "@/media/probe";
import type { Runner } from "@/media/run";

/** One finish step as a pack declares it (spec 0.1.433). */
export type StackFinishStep = ReturnType<(typeof StackFinishStepSchema)["parse"]>;
export interface Size { width: number; height: number }
export type FinisherStep =
  | { kind: "crop"; from: Size; to: Size }
  | { kind: "unsharp"; size: number; amount: number }
  | { kind: "audio_lead_in"; muteMs: number; fadeMs: number }
  | { kind: "other"; op: StackFinishStep["op"] };

function fail(step: StackFinishStep, problem: string): never {
  throw new Error(`The pack's finish step "${step.op}" ${problem} Fix that step in the pack's model-pack.json.`);
}
function param(step: StackFinishStep, key: string): number {
  const value = step.params?.[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fail(step, `needs a number for "${key}".`);
  return value;
}

/** Validates the spec's finish steps and turns them into what this module runs. A step this module does not run is kept as `other` so it is reported as skipped. */
export function finisherSteps(steps: readonly StackFinishStep[]): FinisherStep[] {
  return steps.map((step): FinisherStep => {
    if (step.op === "crop") {
      const from = { width: param(step, "from_width"), height: param(step, "from_height") }, to = { width: param(step, "width"), height: param(step, "height") };
      if (to.width > from.width || to.height > from.height) fail(step, `crops to ${to.width}x${to.height}, which is larger than ${from.width}x${from.height}.`);
      if ((from.width - to.width) % 2 !== 0 || (from.height - to.height) % 2 !== 0) fail(step, "must remove an even number of columns and rows so it stays centered.");
      if (to.width % 2 !== 0 || to.height % 2 !== 0 || to.width < 2 || to.height < 2) fail(step, "needs an even width and height for the video format.");
      return { kind: "crop", from, to };
    }
    if (step.op === "unsharp") {
      const x = param(step, "luma_x"), y = param(step, "luma_y"), amount = param(step, "amount");
      if (x !== y) fail(step, `needs luma_x and luma_y to match, not ${x} and ${y}.`);
      if (!Number.isInteger(x) || x % 2 === 0 || x < 3 || x > 23) fail(step, `needs an odd whole luma size from 3 to 23, not ${x}.`);
      if (amount < -2 || amount > 5) fail(step, `needs an amount from -2 to 5, not ${amount}.`);
      return { kind: "unsharp", size: x, amount };
    }
    if (step.op === "audio_lead_in") {
      const muteMs = param(step, "mute_ms"), fadeMs = param(step, "fade_ms");
      if (muteMs < 0 || fadeMs < 0) fail(step, "cannot use a negative time.");
      return { kind: "audio_lead_in", muteMs, fadeMs };
    }
    return { kind: "other", op: step.op };
  });
}

export interface FinishPlan { ran: FinisherStep[]; skipped: FinisherStep[]; videoFilter: string | null; audioFilter: string | null; outSize: Size }

const seconds = (ms: number): string => String(ms / 1000);

/**
 * Decides which steps ffmpeg applies for a clip of this size. The video steps were measured together at the size the crop starts from:
 * when the list has a crop that does not fit this clip, no video step runs (the clip is a different format than the one measured).
 * Steps of kind `other` never run here.
 */
export function planFinish(steps: readonly FinisherStep[], size: Size, hasAudio: boolean): FinishPlan {
  const ran: FinisherStep[] = [];
  const filters: string[] = [];
  let current = size;
  const crops = steps.filter((s): s is Extract<FinisherStep, { kind: "crop" }> => s.kind === "crop");
  const fits = crops.every((c) => c.from.width === size.width && c.from.height === size.height);
  let audio: string | null = null;
  for (const step of steps) {
    if (step.kind === "crop" && fits && current.width === step.from.width && current.height === step.from.height) {
      filters.push(`crop=${step.to.width}:${step.to.height}:(in_w-${step.to.width})/2:(in_h-${step.to.height})/2`);
      current = step.to; ran.push(step);
    } else if (step.kind === "unsharp" && fits) {
      filters.push(`unsharp=${step.size}:${step.size}:${step.amount}:${step.size}:${step.size}:0`);
      ran.push(step);
    } else if (step.kind === "audio_lead_in" && hasAudio) {
      const parts: string[] = [];
      if (step.muteMs > 0) parts.push(`volume=enable='lt(t,${seconds(step.muteMs)})':volume=0`);
      if (step.fadeMs > 0) parts.push(`afade=t=in:st=${seconds(step.muteMs)}:d=${seconds(step.fadeMs)}`);
      if (parts.length) { audio = [audio, ...parts].filter(Boolean).join(","); ran.push(step); }
    }
  }
  return { ran, skipped: steps.filter((s) => !ran.includes(s)), videoFilter: filters.length ? filters.join(",") : null, audioFilter: audio, outSize: current };
}

export interface BuildFinishInput { ffmpeg: string; source: string; target: string; steps: readonly FinisherStep[]; size: Size; hasAudio: boolean }

/** The ffmpeg arguments for the steps this module runs, or null when none applies. The target must not exist (no `-y`). */
export function buildFinishArgs(input: BuildFinishInput): string[] | null {
  const plan = planFinish(input.steps, input.size, input.hasAudio);
  return argsFor(input, plan);
}

function argsFor(input: BuildFinishInput, plan: FinishPlan): string[] | null {
  if (plan.ran.length === 0) return null;
  const video = plan.videoFilter ? ["-vf", plan.videoFilter, "-c:v", "libx264", "-crf", "15", "-preset", "slow", "-pix_fmt", "yuv420p"] : ["-c:v", "copy"];
  const audio = plan.audioFilter ? ["-af", plan.audioFilter, "-c:a", "aac", "-b:a", "192k"] : ["-c:a", "copy"];
  return [input.ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-i", input.source, "-map", "0", ...video, ...audio, "-movflags", "+faststart", input.target];
}

export interface FinishClipInput { ffmpeg: string; ffprobe: string; source: string; target: string; steps: readonly FinisherStep[]; run: Runner; signal?: AbortSignal }
export interface FinishClipResult { ran: FinisherStep[]; skipped: FinisherStep[]; target: string | null }

const keptAsMade = (why: string): Error => new Error(`The clip could not be finished (${why}), so it was kept as made. Use the engine's file as it is, or check ffmpeg and finish it again.`);

/** Writes the finished copy at `target`, checks it, and returns what ran. On any problem the target is deleted and the clip is kept as made. The source is never touched. */
export async function finishClip(input: FinishClipInput): Promise<FinishClipResult> {
  if (input.target === input.source) throw new Error("The finished clip needs its own file name, not the engine's file. Pass a different target.");
  const probed = await probeFile(input.run, input.ffprobe, input.source, input.signal);
  if (!probed.has_video || probed.width === null || probed.height === null) throw new Error("The clip has no video to finish. Pass the file the engine wrote.");
  const size = { width: probed.width, height: probed.height };
  const plan = planFinish(input.steps, size, probed.has_audio);
  const args = argsFor({ ffmpeg: input.ffmpeg, source: input.source, target: input.target, steps: input.steps, size, hasAudio: probed.has_audio }, plan);
  if (!args) return { ran: [], skipped: [...input.steps], target: null };
  if (existsSync(input.target)) throw new Error(`The finished clip's file ${input.target} already exists, and it is never overwritten. Pass a new target name.`);
  try {
    const result = await input.run(args, { signal: input.signal });
    if (result.aborted) throw new Error("it was cancelled");
    if (result.code !== 0) throw new Error(`ffmpeg exited ${result.code}: ${result.stderr.trim().split("\n").slice(-1)[0] ?? "no message"}`);
    const made = await probeFile(input.run, input.ffprobe, input.target, input.signal);
    const source = probed.streams.find((s) => s.type === "video" && !s.cover_art);
    const finished = made.streams.find((s) => s.type === "video" && !s.cover_art);
    if (made.width !== plan.outSize.width || made.height !== plan.outSize.height) throw new Error(`the result is ${made.width}x${made.height}, not ${plan.outSize.width}x${plan.outSize.height}`);
    if (!finished || finished.fps !== (source?.fps ?? null)) throw new Error(`the frame rate changed from ${source?.fps ?? "unknown"} to ${finished?.fps ?? "unknown"}`);
    if (probed.duration_s === null || made.duration_s === null || Math.abs(made.duration_s - probed.duration_s) > 0.05) throw new Error(`the length changed from ${probed.duration_s}s to ${made.duration_s}s`);
    if (probed.has_audio && !made.has_audio) throw new Error("the sound is missing from the result");
  } catch (error) {
    rmSync(input.target, { force: true });
    throw keptAsMade(error instanceof Error ? error.message.replace(/\.$/, "") : String(error));
  }
  return { ran: plan.ran, skipped: plan.skipped, target: input.target };
}
