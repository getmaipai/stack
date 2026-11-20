// The job runner behind POST /v1/videos/generations (VIDEO-GEN-02). The job
// record (which Home lists and the event feed carries) holds only the size,
// the seed and the LoRA ids; the prompt and the reference picture wait in
// memory under a token the route made, are taken by the runner once, and are
// never written to a record, a log or the results folder. The generator queue
// (lib/jobs.ts) gives the clip its place in line and the governor's admission
// of 44 GB before this runner is called. The kind is not a role id on
// purpose: `/v1/images/generations` with model "video" must never reach it.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerJobRunner } from "@/lib/jobs";
import { heavyGate } from "@/lib/heavyGate";

import { ownResultVideo, workDir, commitResult, type VideoResultMeta } from "./results";
import { recordGeneratedImage } from "./provenance";
import { GenTracker, historyKey, previewExists, previewFile, recordRun } from "@/lib/genProgress";
import { overallPercent, VideoError, videoGen, VIDEO_SPECS, type VideoQuality, type VideoRunInput } from "./videoGen";
import { engineOfQuality } from "./caps";
import { videoRecipe } from "./recipes";
import { applyRecipeFinish } from "./recipeFinish";
import { ltx25MaxPeakBytes, ltx25PeakBytes, LTX25_ICLORA_PEAK_BYTES, LTX25_INGREDIENTS_PEAK_BYTES } from "./ltx25";
import { checkEdit, EditSourceError, editRuntime, extendLatentFrames, extendPixelFrames, fitArgs, ltx25EditAdmitBytes, planSource, probeSource, retakeStartLatent, type Ltx25EditKind } from "./ltx25Edit";
import { resolveReadable } from "@/media/paths";
import { upscaleClip } from "@/media/upscale";
import { defaultToolbox } from "@/media/tools";
import { probeFile } from "@/media/probe";
import { spawnRunner } from "@/media/run";
import { H3_VIDEO_ENGINE, H3_VIDEO_VERSION } from "./h3";
import { buildReceipt, phaseDurations, sha256File, sha256Hex, type BuildReceiptInput, type ReceiptOperation } from "./receipt";
import { deliverClip } from "./deliver";
import { LTX25_GEN_NAME, LTX25_GEN_VERSION, LTX25_MAX_GEN_NAME, LTX25_MAX_GEN_VERSION } from "./ltx25";
import { VIDEO_GEN_NAME, VIDEO_GEN_VERSION } from "./videoGen";

export const VIDEO_JOB_KIND = "video_generation";
export function videoAdmission(input: { quality?: VideoQuality; size?: string; seconds?: number; mode?: string; edit?: Ltx25EditKind; lora_admit_bytes?: number; level?: string }): { requestedBytes: number; measuredPeakBytes: number; engine: string } {
  const withPicture = input.mode === "image-to-video"; const quality = input.quality ?? "quick"; const size = /^(\d+)x(\d+)$/.exec(input.size ?? "");
  const peak = input.mode === "ic_lora" ? (input.size === "768x448" ? LTX25_INGREDIENTS_PEAK_BYTES : LTX25_ICLORA_PEAK_BYTES) : (input.lora_admit_bytes ?? 0) + (input.edit && quality === "ltx25max" ? ltx25EditAdmitBytes(input.edit, size ? `${size[1]}x${size[2]}` : null) : quality === "ltx25max" ? ltx25MaxPeakBytes(withPicture, input.size) : quality === "ltx25" && size && input.seconds ? ltx25PeakBytes(Number(size[1]), Number(size[2]), input.seconds * 24 + 1, withPicture) : VIDEO_SPECS[quality].peakBytes);
  return { requestedBytes: peak, measuredPeakBytes: peak, engine: "video-gen" };
}

export interface StashedClip {
  prompt: string;
  negativePrompt: string | null;
  image: Uint8Array | null;
  /** VIDEO-INPUTS-01: the picture the clip ends on (LTX-2.5 only; needs `image`). */
  endImage?: Uint8Array | null;
  width: number; height: number; frames: number; seed: number;
  loras: Array<[string, number]>;
  loraIds: string[];
  /** Which model makes the clip (default Quick). */
  quality?: VideoQuality;
  /** The level chosen by Home or the legacy route; old records without it replay as Standard. */
  level?: "standard" | "boost" | "max";
  recipe?: import("@maipai/spec/stack/ts/stack-model-pack.js").StackLevelRecipe;
  /** GENPREVIEW-01: draw the first-frame preview when the motion is done (default on). */
  preview?: boolean;
  /** LTX25-EDIT-01 (Max only): extend or retake the clip at `sourcePath` (already resolved inside a declared media folder). `seconds` is `extend_seconds` or `retake_from_seconds`. */
  edit?: { kind: Ltx25EditKind; sourcePath: string; seconds: number };
  icLora?: { sourcePath: string; sourceIsResult: boolean; loraPath: string; loraId: string; strength: number; conditioning: "source" | "edges"; audio: boolean };
  /** INGREDIENTS-01 (Max only): one or two reference sheet PNGs (768x448) and the installed Ingredients adapter. */
  ingredients?: { sheets: Uint8Array[]; loraPath: string; loraId: string };
  /** VF-ROLES-01: the typed inputs of the generic door's clip request (role and file hash), written to the receipt and not acted on yet. */
  roles?: Array<{ role: "identity" | "wardrobe" | "voice_reference" | "edit_source"; sha256: string; bytes: number }>;
  /** VF-PROMPT-01: the prompt writer that made `prompt` and its hints, written to the receipt. */
  promptWriter?: { id: string; version: string };
  promptHints?: string[];
  route?: { name: string; reason: string };
  takeOf?: string;
  takeFacts?: { part: string; pack_version: string; shape: string; operation: string };
  takeRecipeSteps?: number;
  receiptRecipe?: { id: string; version: string };
}
const pending = new Map<string, StashedClip & { at: number }>();
const STASH_TTL_MS = 30 * 60_000;
/** A clip cancelled or refused before its runner started never takes its stash, so anything older than half an hour goes. */
export function stashClip(token: string, clip: StashedClip): void {
  const now = Date.now();
  for (const [key, value] of pending) if (now - value.at > STASH_TTL_MS) pending.delete(key);
  pending.set(token, { ...clip, at: now });
}
export function unstashClip(token: string): StashedClip | null {
  const clip = pending.get(token) ?? null;
  pending.delete(token);
  if (!clip) return null;
  const { at: _at, ...rest } = clip;
  return rest;
}

/** What a job is doing right now, for the status route (the job record carries the percent only). */
const progress = new Map<string, { phase: string; phasePercent: number }>();
const failures = new Map<string, { code: string; message: string; status: number }>();
export function videoProgress(job: string): { phase: string; phasePercent: number } | null { return progress.get(job) ?? null; }
export function videoFailure(job: string): { code: string; message: string; status: number } | null { return failures.get(job) ?? null; }
/** Stages and previews of the clips in flight, for the status route. */
const trackers = new Map<string, GenTracker>();
export function videoTracker(job: string): GenTracker | null { return trackers.get(job) ?? null; }
/** The first-frame preview of a running clip, or null (the work folder goes with the job). */
export function videoPreviewPath(job: string): string | null {
  return trackers.has(job) && previewExists(join(workDir(job), "out")) ? previewFile(join(workDir(job), "out")) : null;
}
function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.set(key, value);
  while (map.size > 200) map.delete(map.keys().next().value as string);
}

/** The job's copy of an edit's source, and what the worker is told about it. Throws a VideoError with a plain message for a source the table does not allow. */
async function prepareEditSource(edit: NonNullable<StashedClip["edit"]>, work: string, signal: AbortSignal, status: (text: string) => void): Promise<{ edit: NonNullable<VideoRunInput["edit"]>; width: number; height: number; frames: number }> {
  try {
    const source = ownResultVideo(edit.sourcePath) ?? resolveReadable(edit.sourcePath, "The source clip");
    const ffmpeg = await editRuntime.toolbox.path("ffmpeg", status, signal);
    const ffprobe = await editRuntime.toolbox.path("ffprobe", status, signal);
    const plan = planSource(await probeSource(ffprobe, source, editRuntime.run, signal));
    checkEdit(edit.kind, plan, edit.seconds);
    const sourcePath = join(work, "source.mp4");
    if (plan.fit) {
      const made = await editRuntime.run([ffmpeg, ...fitArgs(source, sourcePath, plan)], { signal });
      if (made.aborted) throw new VideoError("cancelled", "Cancelled.", 499);
      if (made.code !== 0) throw new EditSourceError("bad_source", "The source could not be fitted to the size the video model edits. Send an mp4 clip with a picture and sound.");
    } else copyFileSync(source, sourcePath);
    const extendFrames = edit.kind === "extend" ? extendLatentFrames(edit.seconds) : undefined;
    // The expected length of the result, for the progress estimate (the worker reports the real one): an extend adds 8 frames per latent frame.
    const frames = edit.kind === "extend" ? plan.frames + extendPixelFrames(edit.seconds) : plan.frames;
    return { edit: { kind: edit.kind, sourcePath, ffmpeg, ffprobe, ...(extendFrames !== undefined ? { extendFrames } : { retakeStartLatent: retakeStartLatent(edit.seconds) }) }, width: plan.width, height: plan.height, frames };
  } catch (error) {
    if (error instanceof EditSourceError) throw new VideoError(error.code, error.message, error.status);
    if (error instanceof VideoError) throw error;
    if (signal.aborted) throw new VideoError("cancelled", "Cancelled.", 499);
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === "string" && /^(path_|no_roots|root_|tool_)/.test(code)) throw new VideoError(code === "path_not_found" ? "source_not_found" : code, error instanceof Error ? error.message : "The source clip could not be read.", code.startsWith("tool_") ? 503 : 422);
    throw error;
  }
}

/** VF-RECEIPT-01: the runtime, the model build and its quantization, as each quality runs them (the numbers are the ones the runner uses). */
function receiptFacts(quality: VideoQuality): Pick<BuildReceiptInput, "runtime" | "model"> {
  const model = VIDEO_SPECS[quality].modelId;
  if (quality === "ltx25max") return { runtime: { id: LTX25_MAX_GEN_NAME, revision: LTX25_MAX_GEN_VERSION }, model: { id: model, build: "distilled", quantization: "bf16" } };
  if (quality === "ltx25") return { runtime: { id: LTX25_GEN_NAME, revision: LTX25_GEN_VERSION }, model: { id: model, build: "distilled", quantization: "q8" } };
  if (quality === "h3") return { runtime: { id: H3_VIDEO_ENGINE, revision: H3_VIDEO_VERSION }, model: { id: model, build: "boost-8bit", quantization: "8-bit" } };
  if (quality === "h3stream") return { runtime: { id: H3_VIDEO_ENGINE, revision: H3_VIDEO_VERSION }, model: { id: model, build: "streaming-24gb", quantization: "4-bit" } };
  return { runtime: { id: VIDEO_GEN_NAME, revision: VIDEO_GEN_VERSION }, model: { id: model, build: "standard", quantization: null } };
}
const receiptOperation = (clip: StashedClip): ReceiptOperation => clip.ingredients ? "ingredients" : clip.icLora ? "restyle" : clip.edit ? clip.edit.kind : "generate";

export interface VideoJobResult { job: string; model: string; width: number; height: number; frames: number; fps: number; seconds: number; seed: number; lora_ids: string[]; ms: number; }

export function registerVideoJobs(): void {
  registerJobRunner(VIDEO_JOB_KIND, async (job, signal, update): Promise<VideoJobResult> => {
    const token = String((job.input as { token?: string } | null)?.token ?? "");
    const clip = unstashClip(token);
    if (!clip) throw new VideoError("failed", "The request was not received. Send it again.", 400);
    const work = workDir(job.id);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true, mode: 0o700 });
    try {
      let imagePath: string | null = null;
      if (clip.image) { imagePath = join(work, "reference.bin"); writeFileSync(imagePath, clip.image, { mode: 0o600 }); }
      let endImagePath: string | null = null;
      if (clip.endImage) { endImagePath = join(work, "end-reference.bin"); writeFileSync(endImagePath, clip.endImage, { mode: 0o600 }); }
      const outputDir = join(work, "out");
      const started = Date.now();
      const quality = clip.quality ?? "quick";
      const storedInput = (job.input ?? {}) as { level?: "standard" | "boost" | "max" };
      const level = clip.level ?? storedInput.level ?? (quality === "ltx25max" ? "max" : "standard");
      // VF-RECEIPT-01: what was asked (before an edit's source sets the real size), the order phases were entered in, and the inputs by role and hash.
      const requested = { width: clip.width, height: clip.height, frames: clip.frames, seconds: Math.max(0, Math.round(((clip.frames - 1) / 24) * 1000) / 1000) };
      const entered: Array<{ name: string; at: number }> = [{ name: "waiting", at: started }];
      const receiptInputs: BuildReceiptInput["inputs"] = [];
      const addInput = (role: BuildReceiptInput["inputs"][number]["role"], bytes: Uint8Array): void => { receiptInputs.push({ role, sha256: sha256Hex(bytes), bytes: bytes.length }); };
      if (clip.image) addInput("start", clip.image);
      if (clip.endImage) addInput("end", clip.endImage);
      for (const sheet of clip.ingredients?.sheets ?? []) addInput("sheet", sheet);
      for (const role of clip.roles ?? []) receiptInputs.push(role);
      // LTX25-EDIT-01: the source is probed again (the authority), fitted to the runtime's table when needed and copied into the job's private folder.
      let editInput: VideoRunInput["edit"] | undefined;
      if (clip.edit) {
        const prepared = await prepareEditSource(clip.edit, work, signal, (status) => update({ status }));
        editInput = prepared.edit;
        clip.width = prepared.width; clip.height = prepared.height; clip.frames = prepared.frames;
      }
      let icLoraInput: VideoRunInput["icLora"] | undefined;
      if (clip.icLora) {
        const source = clip.icLora.sourceIsResult ? clip.icLora.sourcePath : resolveReadable(clip.icLora.sourcePath, "The source clip");
        const ffprobe = await editRuntime.toolbox.path("ffprobe", (status) => update({ status }), signal);
        const facts = await probeSource(ffprobe, source, editRuntime.run, signal);
        if (!facts.hasVideo || facts.frames <= 0) throw new VideoError("source_not_found", "The source clip is missing or unreadable. Choose a readable video clip.", 422);
        if (facts.frames / (facts.fps || 24) > 10.01 || facts.frames > 241) throw new VideoError("source_too_long", "The source is over 10 seconds (241 frames). Trim it to 10 seconds or less.", 422);
        clip.frames = 1 + Math.floor((Math.min(facts.frames, 241) - 1) / 8) * 8;
        const sourcePath = join(work, "source.mp4");
        copyFileSync(source, sourcePath);
        icLoraInput = { sourcePath, path: clip.icLora.loraPath, strength: clip.icLora.strength, conditioning: clip.icLora.conditioning, ffprobe, ffmpeg: await editRuntime.toolbox.path("ffmpeg", (status) => update({ status }), signal) };
      }
      if (clip.ingredients) {
        const sheets = clip.ingredients.sheets.map((bytes, i) => { const file = join(work, `sheet-${i + 1}.png`); writeFileSync(file, bytes, { mode: 0o600 }); return file; });
        const status = (value: string) => update({ status: value });
        icLoraInput = { sourcePath: "", path: clip.ingredients.loraPath, strength: 1, conditioning: "source", sheets, ffprobe: await editRuntime.toolbox.path("ffprobe", status, signal), ffmpeg: await editRuntime.toolbox.path("ffmpeg", status, signal) };
      }
      if (editInput) { const source = sha256File(editInput.sourcePath); receiptInputs.push({ role: "source_clip", ...source }); }
      else if (icLoraInput && !clip.ingredients && icLoraInput.sourcePath) { const source = sha256File(icLoraInput.sourcePath); receiptInputs.push({ role: "source_clip", ...source }); }
      const pacing = heavyGate.pacing(job.id);
      const tracker = clip.icLora || clip.ingredients
        ? new GenTracker("video_edit", historyKey("video_edit", clip.width, clip.height, `ic_lora-${clip.frames}`), pacing.now, Math.max(0.25, (clip.frames - 1) / 120), pacing.paused)
        : clip.edit
        ? new GenTracker("video_edit", historyKey("video_edit", clip.width, clip.height, `${clip.edit.kind}-${clip.frames}`), pacing.now, Math.max(0.25, ((clip.frames - 1) / 240) * (clip.edit.kind === "retake" ? 1.4 : 0.93)), pacing.paused)
        : quality === "quick"
        ? new GenTracker("video", historyKey("video", clip.width, clip.height, clip.frames), pacing.now, 1, pacing.paused)
        : quality === "ltx25" || quality === "ltx25max"
          ? new GenTracker("video", historyKey("video", clip.width, clip.height, `${quality}-${clip.frames}${clip.image ? "-picture" : ""}`), pacing.now, Math.max(0.25, (clip.frames - 1) / 120), pacing.paused)
          : new GenTracker("video", historyKey("video", clip.width, clip.height, clip.frames), pacing.now, Math.max(0.25, (clip.frames - 1) / 120), pacing.paused);
      remember(trackers, job.id, tracker);
      const recipeEngine = engineOfQuality(quality) ?? "ltx25";
      const recipeOperation = clip.width === 1920 ? "clip_film_shot" : clip.image && clip.endImage ? "clip_start_end_pictures" : clip.image ? "clip_start_picture" : "clip_text";
      const chosenRecipe = clip.recipe ?? videoRecipe(recipeEngine, level, recipeOperation, `${clip.width}x${clip.height}`, videoAdmission({ quality, size: `${clip.width}x${clip.height}`, mode: clip.image ? "image-to-video" : "text-to-video" }).requestedBytes, quality === "h3stream" ? "h3stream" : "h3")?.recipe;
      if (clip.takeRecipeSteps && chosenRecipe) chosenRecipe.steps = clip.takeRecipeSteps;
      const result = await videoGen.run({ ...(clip.preview !== false ? { previewPath: previewFile(outputDir) } : {}), prompt: clip.prompt, negativePrompt: clip.negativePrompt, imagePath, endImagePath, width: clip.width, height: clip.height, frames: clip.frames, seed: clip.seed, loras: clip.loras, outputDir, quality, level, ...(chosenRecipe ? { recipe: chosenRecipe } : {}), ...(editInput ? { edit: editInput } : {}), ...(icLoraInput ? { icLora: icLoraInput } : {}) }, {
        jobId: job.id, signal,
        onPhase: (phase, phasePercent) => { if (entered[entered.length - 1]?.name !== phase) entered.push({ name: phase, at: Date.now() }); remember(progress, job.id, { phase, phasePercent }); update({ status: phase, percent: tracker.started ? Math.round(tracker.snapshot().fraction * 100) : overallPercent(phase, phasePercent) }); },
        onStage: (stage, n, of) => { tracker.enter(stage, n, of); update({ percent: Math.round(tracker.snapshot().fraction * 100) }); },
        onPreview: () => tracker.setPreview(null, null),
      });
      // VF-RECEIPT-01: the model's own file is kept; see deliver.ts. A failed finish tells the person (the clip is kept as made) and still delivers the native file.
      const video = join(outputDir, "video.mp4");
      const poster = join(outputDir, "poster.jpg");
      // The finish comes from the recipe the pack declared for this level and size (VF-FINISH-01); a recipe without one leaves the file as the engine made it.
      const finishSteps = chosenRecipe?.finish ?? [];
      const delivery = await deliverClip({
        outputDir, derivedByGenerator: result.derived === "messaging_copy", signal,
        reported: { width: result.width, height: result.height, frames: result.frames, fps: result.fps, audio: result.audio },
        finish: finishSteps.length ? async (path) => {
          try {
            const ffmpeg = await defaultToolbox.path("ffmpeg", (status) => update({ status }), signal);
            const ffprobe = await defaultToolbox.path("ffprobe", (status) => update({ status }), signal);
            return await applyRecipeFinish({
              steps: finishSteps, path, workDir: outputDir, ffmpeg, ffprobe, run: spawnRunner, ...(signal ? { signal } : {}),
              upscale: async (from, target) => { const probe = await probeFile(spawnRunner, ffprobe, from, signal); await upscaleClip({ ffmpeg, run: spawnRunner, input: from, target, work: outputDir, probe, signal, progress: (next) => update(next), basePercent: 95, percentSpan: 4 }); },
            });
          } catch (error) { if (!signal.aborted) update({ status: "The clip is kept as made: the finishing step could not run, so it is not finished." }); throw error; }
        } : null,
        recutPoster: async (file, target) => { const ffmpeg = await defaultToolbox.path("ffmpeg", () => {}, signal); await spawnRunner([ffmpeg, "-y", "-i", file, "-frames:v", "1", "-q:v", "2", target], { signal }); },
      });
      recordRun(tracker.key, tracker.finish());
      const nativeFile = delivery.native, deliveredFile = delivery.delivered, deliveredIs = delivery.deliveredIs, finish = delivery.finish, keptNative = delivery.keptNative;
      const loraAdapter = clip.loraIds[0] !== undefined ? { id: clip.loraIds[0], strength: clip.loras[0]?.[1] ?? null, sha256: null } : null;
      const adapter = clip.ingredients ? { id: clip.ingredients.loraId, strength: 1, sha256: null } : clip.icLora ? { id: clip.icLora.loraId, strength: clip.icLora.strength, sha256: null } : result.ran?.adapter ? { ...result.ran.adapter, sha256: null } : loraAdapter;
      const receipt = buildReceipt({
        job: job.id, operation: receiptOperation(clip), madeAt: new Date(), ...receiptFacts(quality), steps: { count: result.ran?.steps ?? null, schedule: result.ran?.schedule ?? null }, adapter,
        inputs: receiptInputs, promptWriter: clip.promptWriter, promptHints: clip.promptHints, requested, native: nativeFile, delivered: deliveredFile, deliveredIs, seed: result.seed, phases: phaseDurations(entered, Date.now()), peakBytes: result.peakBytes, finish, prompt: clip.prompt, ...(clip.route ? { route: clip.route } : {}), ...(clip.takeOf ? { takeOf: clip.takeOf } : {}), ...(clip.receiptRecipe ? { recipe: clip.receiptRecipe } : {})
      });
      const meta: VideoResultMeta = {
        job: job.id, created: Math.floor(new Date(job.createdAt).getTime() / 1000), width: deliveredFile.width, height: deliveredFile.height, frames: deliveredFile.frames, fps: Math.round(deliveredFile.fps) || result.fps, seconds: Math.round((deliveredFile.frames - 1) / (deliveredFile.fps || result.fps)),
        seed: result.seed, model: VIDEO_SPECS[quality].modelId, quality, audio: result.audio, mode: clip.icLora || clip.ingredients ? "ic_lora" : clip.edit ? clip.edit.kind : clip.image ? "image-to-video" : "text-to-video", lora_ids: clip.loraIds, ...((job.input as { audience?: unknown } | null)?.audience === "adult" ? { audience: "adult" as const } : {}), ms: Date.now() - started,
        bytes: Bun.file(video).size, poster_bytes: Bun.file(poster).size, mlx_peak_gb: result.peakBytes === null ? null : Math.round(result.peakBytes / 1e8) / 10,
        native: { width: nativeFile.width, height: nativeFile.height, frames: nativeFile.frames, bytes: nativeFile.bytes, kept: keptNative }, delivered_is: deliveredIs,
      };
      update({ status: "ready", percent: 100 });
      // The poster of a clip the Stack made counts as a picture made here, except one that looks like a person: starting from it again needs a fresh proof.
      recordGeneratedImage(new Uint8Array(readFileSync(poster)));
      const takeFacts = { route: clip.route?.name ?? "words", operation: clip.takeFacts?.operation ?? (clip.image && clip.endImage ? "clip_start_end_pictures" : clip.image ? "clip_start_picture" : "clip_text"), level, shape: clip.takeFacts?.shape ?? `${clip.width}x${clip.height}`, seed: result.seed, part: clip.takeFacts?.part ?? VIDEO_SPECS[quality].modelId, pack_version: clip.takeFacts?.pack_version ?? "unknown", ...(chosenRecipe ? { recipe: { level: chosenRecipe.level, steps: chosenRecipe.steps } } : {}) };
      commitResult(meta, outputDir, receipt, takeFacts, new Date(job.createdAt).getTime());
      remember(progress, job.id, { phase: "ready", phasePercent: 100 });
      return { job: job.id, model: meta.model, width: meta.width, height: meta.height, frames: meta.frames, fps: meta.fps, seconds: meta.seconds, seed: meta.seed, lora_ids: meta.lora_ids, ms: meta.ms };
    } catch (error) {
      if (!signal.aborted && error instanceof VideoError) remember(failures, job.id, { code: error.code, message: error.message, status: error.status });
      else if (!signal.aborted) { const neverFit = error instanceof Error && (error as Error & { code?: string }).code === "never_fits"; remember(failures, job.id, { code: neverFit ? "never_fits" : "failed", message: error instanceof Error ? error.message : String(error), status: neverFit ? 503 : 500 }); }
      throw error;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, { generator: { role: "video", memory: (job) => videoAdmission((job.input ?? {}) as Parameters<typeof videoAdmission>[0]) } });
}
