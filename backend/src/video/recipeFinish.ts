// VF-FINISH-01: runs the typed `finish` steps a level recipe declares (spec 0.1.433) on the delivered copy, in order, and says what each step did for the
// receipt. Consecutive steps this Stack runs with ffmpeg (crop, unsharp, audio_lead_in) are one pass in finish.ts; `model_upscale` is the existing media
// upscale op, passed in. A step that cannot run is reported, never dropped: `lanczos_scale` and `loudness` are not built yet, and a crop that does not fit
// the clip's size is not applicable. The caller keeps the native file; this only rewrites the delivered copy it is handed.
import { copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { probeFile } from "@/media/probe";
import type { Runner } from "@/media/run";
import { finishClip, finisherSteps, type FinisherStep, type Size, type StackFinishStep } from "./finish";

export interface AppliedFinish { operation: string; from: Size; to: Size; ok: boolean; code: string | null }
export interface RecipeFinishInput {
  steps: readonly StackFinishStep[]; path: string; workDir: string; ffmpeg: string; ffprobe: string; run: Runner; signal?: AbortSignal;
  /** The media upscale op: writes the enlarged clip to `target` from `input`. */
  upscale: (input: string, target: string) => Promise<void>;
}
/** Thrown when a step fails after others may have run; carries what was recorded so far. The delivered file is left as it was before the failing step. */
export class RecipeFinishFailure extends Error { constructor(readonly operation: string, readonly applied: AppliedFinish[], readonly cause_: unknown) { super(`The finish step "${operation}" could not run.`); } }

const FFMPEG_KINDS = new Set<FinisherStep["kind"]>(["crop", "unsharp", "audio_lead_in"]);

async function sizeOf(input: RecipeFinishInput): Promise<Size> {
  const probed = await probeFile(input.run, input.ffprobe, input.path, input.signal);
  return { width: probed.width ?? 0, height: probed.height ?? 0 };
}

export async function applyRecipeFinish(input: RecipeFinishInput): Promise<AppliedFinish[]> {
  const steps = finisherSteps(input.steps);
  const applied: AppliedFinish[] = [];
  let at = 0;
  while (at < steps.length) {
    const step = steps[at]!; const spec = input.steps[at]!;
    if (FFMPEG_KINDS.has(step.kind)) {
      let end = at; while (end < steps.length && FFMPEG_KINDS.has(steps[end]!.kind)) end++;
      const group = steps.slice(at, end); const before = await sizeOf(input);
      const target = join(input.workDir, "video-finished.mp4");
      rmSync(target, { force: true });
      try {
        const result = await finishClip({ ffmpeg: input.ffmpeg, ffprobe: input.ffprobe, source: input.path, target, steps: group, run: input.run, ...(input.signal ? { signal: input.signal } : {}) });
        if (result.target) { copyFileSync(result.target, input.path); rmSync(result.target, { force: true }); }
        const after = result.target ? await sizeOf(input) : before;
        for (const item of group) {
          const ran = result.ran.includes(item);
          applied.push({ operation: input.steps[at + group.indexOf(item)]!.op, from: before, to: ran ? after : before, ok: ran, code: ran ? null : "not_applicable" });
        }
      } catch (error) {
        rmSync(target, { force: true });
        throw new RecipeFinishFailure(input.steps[at]!.op, applied, error);
      }
      at = end; continue;
    }
    if (spec.op === "model_upscale") {
      const before = await sizeOf(input); const target = join(input.workDir, "video-upscaled.mp4");
      try { await input.upscale(input.path, target); copyFileSync(target, input.path); rmSync(target, { force: true }); }
      catch (error) { rmSync(target, { force: true }); throw new RecipeFinishFailure("model_upscale", applied, error); }
      applied.push({ operation: "model_upscale", from: before, to: await sizeOf(input), ok: true, code: null });
    } else {
      const size = await sizeOf(input);
      applied.push({ operation: spec.op, from: size, to: size, ok: false, code: "not_supported" });
    }
    at++;
  }
  return applied;
}
