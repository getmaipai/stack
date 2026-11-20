// VIDEO-GEN-01: the Stack's video generation service. Wan2.2 TI2V-5B with the
// FastWan 3-step distillation, run by mlx-video (MIT, pinned by commit) on the
// Apple GPU inside one managed Python 3.12 environment (the same uv builder
// as the voice engines, ComfyUI and the image tools) and one worker process
// that exists only while video work does: it starts on the first clip, waits
// ten minutes for the next one, then exits and gives its memory back. Never
// resident at boot. The weights are pinned model records (a directory of
// four files and the umt5 tokenizer files), so the worker needs no network at
// run time and runs with HF_HUB_OFFLINE=1.
//
// Memory: a clip holds one governor admission of 44.1 GB (the measured peak
// with `--tiling aggressive`, which the worker always passes; every other
// tiling peaks near 112 GB) from the first byte loaded to the last frame
// written. The job queue takes that admission before this service is called;
// this file never talks to the governor for a run. The Stack keeps about 28 GB
// resident, so a Mac of 64 GB cannot hold both: the p64 tier does not offer video at
// all (owner call, 2026-10-17), and a p128 Mac with too little free memory is
// refused with a plain reason; chat is never evicted for a clip.
//
// Safety posture: the model has no filter and the Stack makes no decision
// about who is in a picture or who is asking. The Stack enforces what it can
// know: the hard size limits, the tier, the LoRA audience lock, and that a
// reference picture arrives with a declared source that is not an upload
// (Home owns the gate). Age and surface gates, the household-name gate on the
// prompt, and the two absolute lines live in Home, where the person is known.
import { engineIdleMs } from "@/lib/engineIdle";
import { defaultToolbox } from "@/media/tools";
import { H3_MAX_SECONDS, H3_VIDEO_ID, H3_VIDEO_VERSION, h3VideoCommand, type H3VideoBuild } from "./h3";
import { spawnRunner } from "@/media/run";
import { heavyGate, PausableProcess, type Lease, type PausableWorker } from "@/lib/heavyGate";
import { TreeSnapshot } from "@/lib/processTree";
import { registerOwned } from "@/lib/ownedProcesses";
import { forgetLoadedItem, setIdleTtlSeconds, setWarmWorkerUnload } from "@/lib/governor";
import { lowMemoryRefusal } from "@/lib/memoryState";
import { lowDiskRefusal } from "@/lib/diskState";
import { diskAdmission } from "@/lib/diskState";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installedEnginePin, MANAGED_RUNTIMES } from "@/lib/engineCatalog";
import { ensureEngine } from "@/lib/engineInstall";
import { getGovernorStatus } from "@/lib/governor";
import { log } from "@/lib/log";
import { ffmpegPath, makeMessagesCopy } from "@/video/messages";
import { probeReceiptFile } from "./receipt";
import { getModel } from "@/lib/modelStore";
import { STACK_VIDEO_LTX25_MAX_MODEL_ID, STACK_VIDEO_LTX25_MODEL_ID, STACK_VIDEO_MODEL_ID, STACK_VIDEO_TOKENIZER_ID } from "@/lib/modelCatalog";
import { engineTagRoot } from "@/lib/store/layout";
import { ensureUvEnvironment, managedEnv, uvEnvironmentReady, uvVenvPath, uvVenvPython, type UvEnvironmentSpec } from "@/lib/uvEnvironment";
import type { RoleStateRecord } from "@/roles";
import { READY_TTL_MS } from "@/roles";
import darwinArm64Requirements from "./video-gen.darwin-arm64.requirements.txt" with { type: "file" };
import workerScript from "./video_worker.py" with { type: "file" };
import { ltx25LoraMode, ensureLtx25Environment, ensureLtx25MaxEnvironment, ltx25GenRoot, ltx25MaxGenRoot, ltx25MaxModelPaths, ltx25ModelPaths, ltx25WorkerEnv, ltx25WorkerScript, LTX25_DEFAULT_SIZE, LTX25_MAX_DEFAULT_SIZE, LTX25_MAX_MODEL_NAMES, LTX25_MAX_PEAK_BYTES, LTX25_MAX_PROFILE_SECONDS, LTX25_MAX_SECONDS, LTX25_MODEL_NAMES, LTX25_PEAK_BYTES } from "./ltx25";

export const VIDEO_GEN_NAME = "video-gen";
export const VIDEO_GEN_VERSION = MANAGED_RUNTIMES.find((runtime) => runtime.name === VIDEO_GEN_NAME)?.version ?? "87db56a";

/** Hard ceilings in the Stack, not settings. 720p was measured (308 s, 53.9 GB) and is not offered. */
export const VIDEO_FPS = 24;
export const VIDEO_MAX_SECONDS = 5;
export const VIDEO_MAX_FRAMES = VIDEO_FPS * VIDEO_MAX_SECONDS + 1;
export const VIDEO_DEFAULT_SIZE = "832x480";
export const VIDEO_MAX_PIXELS = 832 * 480;
export const VIDEO_SIZE_STEP = 32;
export const VIDEO_MIN_SIDE = 256;
export const VIDEO_MAX_PROMPT_CHARS = 4000;
export const VIDEO_MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
export const VIDEO_QUEUE_MAX = 4;
/** The measured peak memory footprint of a whole clip (832 x 480, 121 frames, aggressive tiling), M5 Max, 2026-10-17. */
export const VIDEO_PEAK_BYTES = 44_088_747_800;
/** Tiers that run video; the others are off (the 44 GB peak does not fit beside chat). */
export const VIDEO_TIERS = ["p128"] as const;

/**
 * The video models are Wan Quick and LTX-2.5 Standard, Boost and Max. Every number is a hard ceiling in the Stack, measured on the Studio, never a setting.
 */
export type VideoQuality = "quick" | "ltx25" | "ltx25max" | "h3" | "h3stream";
export const VIDEO_QUALITIES: readonly VideoQuality[] = ["quick", "ltx25", "ltx25max"];
export interface VideoSpec {
  quality: VideoQuality; modelId: string; maxSeconds: number; frameStep: number; defaultSize: string; maxPixels: number; sizeStep: number; minSide: number;
  /** A clip of this model has a sound track. */
  audio: boolean; peakBytes: number; loraBase: string; worker: "video_worker.py" | "ltx25_worker.py";
  /** A picture can start a clip of this model. */
  imageToVideo: boolean;
  /** VIDEO-INPUTS-01: a second picture can end the clip (`end_image`). Only the LTX-2.5 runtimes take one. */
  endImage: boolean;
}
export const VIDEO_SPECS: Record<VideoQuality, VideoSpec> = {
  quick: { quality: "quick", modelId: STACK_VIDEO_MODEL_ID, maxSeconds: VIDEO_MAX_SECONDS, frameStep: 4, defaultSize: VIDEO_DEFAULT_SIZE, maxPixels: VIDEO_MAX_PIXELS, sizeStep: VIDEO_SIZE_STEP, minSide: VIDEO_MIN_SIDE, audio: false, peakBytes: VIDEO_PEAK_BYTES, loraBase: "wan2.2-ti2v-5b", worker: "video_worker.py", imageToVideo: true, endImage: false },
  // LTX25-ENGINE-01: the sizes and lengths are the measured table in video/ltx25.ts (checked by the route and the worker), the peak is its largest row.
  ltx25: { quality: "ltx25", modelId: STACK_VIDEO_LTX25_MODEL_ID, maxSeconds: LTX25_MAX_SECONDS, frameStep: 8, defaultSize: LTX25_DEFAULT_SIZE, maxPixels: 768 * 448, sizeStep: 32, minSide: 256, audio: true, peakBytes: LTX25_PEAK_BYTES, loraBase: "ltx-2.5", worker: "ltx25_worker.py", imageToVideo: true, endImage: true },
  // LTX25-MAX-01: the Max profile (1024x576, 10 s) on the dgrauet runtime and the bf16 pack; the peak is its admission figure (measured footprint with headroom).
  ltx25max: { quality: "ltx25max", modelId: STACK_VIDEO_LTX25_MAX_MODEL_ID, maxSeconds: LTX25_MAX_PROFILE_SECONDS, frameStep: 8, defaultSize: LTX25_MAX_DEFAULT_SIZE, maxPixels: 1024 * 576, sizeStep: 64, minSide: 256, audio: true, peakBytes: LTX25_MAX_PEAK_BYTES, loraBase: "ltx-2.5", worker: "ltx25_worker.py", imageToVideo: true, endImage: true },
  // VF-CAPS-01: H3 takes a first and a last picture (the route and `h3VideoCommand` carry them) and makes 4 to 5 s clips; video/caps.ts reads these flags into its rows.
  h3: { quality: "h3", modelId: H3_VIDEO_ID, maxSeconds: H3_MAX_SECONDS, frameStep: 1, defaultSize: "864x480", maxPixels: 864 * 480, sizeStep: 1, minSide: 1, audio: true, peakBytes: 42_100_000_000, loraBase: "minimax-h3", worker: "ltx25_worker.py", imageToVideo: true, endImage: true },
  h3stream: { quality: "h3stream", modelId: H3_VIDEO_ID, maxSeconds: H3_MAX_SECONDS, frameStep: 1, defaultSize: "864x480", maxPixels: 864 * 480, sizeStep: 1, minSide: 1, audio: true, peakBytes: 14_800_000_000, loraBase: "minimax-h3", worker: "ltx25_worker.py", imageToVideo: true, endImage: true },
};
/** Whether a quality's runtime and weights come from the LTX-2.5 engine (its own environment). */
export const usesLtx25Engine = (quality: VideoQuality): boolean => quality === "ltx25" || quality === "ltx25max";
/** The quality a request's `model` names. Retired Detailed values remain recognizable for a clear refusal. */
export function qualityOfModelName(name: string | undefined): VideoQuality | null {
  // Home's lane guard sends a teen or a child the Quick model by this id (Wan 2.2 FastWan); it names the same model.
  if (name === undefined || name === "" || name === "video" || name === "quick" || name === VIDEO_SPECS.quick.modelId || name === "wan2.2-ti2v-5b-fastwan-mlx") return "quick";
  if (name === "detailed" || name === "ltx-2-3-distilled-mlx") return null;
  if ((LTX25_MODEL_NAMES as readonly string[]).includes(name) || name === VIDEO_SPECS.ltx25.modelId) return "ltx25";
  if ((LTX25_MAX_MODEL_NAMES as readonly string[]).includes(name) || name === VIDEO_SPECS.ltx25max.modelId) return "ltx25max";
  if (name === H3_VIDEO_ID || name === "minimax-h3-8bit") return "h3";
  if (name === "minimax-h3-streaming") return "h3stream";
  return null;
}
/** The environment root a quality runs in (the LTX-2.5 engine has its own, and Max has a second one). */
const rootOf = (quality: VideoQuality): string => (quality === "ltx25" ? ltx25GenRoot() : quality === "ltx25max" ? ltx25MaxGenRoot() : videoGenRoot());
const idleMs = (): number => engineIdleMs("video");
const deadlineMs = (): number => Number(process.env.VIDEO_DEADLINE_MS ?? 15 * 60_000);

/**
 * VF-RECEIPT-01: the delivered `video.mp4` is made from the model's file, which is set aside as `native.mp4` and never rewritten. A copy that cannot be
 * made leaves the native bytes in place as `video.mp4`. Returns "messaging_copy" when `video.mp4` is now the derived file.
 */
export async function deriveDelivered(output: string, native: string, derive: (from: string, to: string) => Promise<void>): Promise<"messaging_copy" | undefined> {
  try { renameSync(output, native); } catch (error) { log(`video: kept the plain clip, the native copy could not be set aside: ${error instanceof Error ? error.message : "unknown"}`); return undefined; }
  try { await derive(native, output); return "messaging_copy"; }
  catch (error) { copyFileSync(native, output); log(`video: kept the plain clip, the messaging copy failed: ${error instanceof Error ? error.message : "unknown"}`); return undefined; }
}

export class VideoError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}
const STATUS_BY_CODE: Record<string, number> = { bad_request: 422, model_missing: 503, out_of_memory: 507, timeout: 504, worker_stopped: 500, failed: 500, lora_keys_unsupported: 422 };

export function videoRequirementsFileFor(platform = process.platform, arch = process.arch): string | null {
  if (platform === "darwin" && arch === "arm64") return darwinArm64Requirements;
  return null;
}
export function videoGenRoot(): string { return engineTagRoot(VIDEO_GEN_NAME, VIDEO_GEN_VERSION); }
/** A package the sync installs last-ish: proof the environment finished. */
export function videoGenProof(): string { return join(uvVenvPath(videoGenRoot()), "lib", "python3.12", "site-packages", "mlx_vlm", "__init__.py"); }
export function videoGenSourceInstalled(): boolean { return existsSync(join(videoGenRoot(), "mlx_video", "__init__.py")); }
export function videoGenEnvironmentReady(): boolean { return videoGenSourceInstalled() && uvEnvironmentReady({ name: VIDEO_GEN_NAME, version: VIDEO_GEN_VERSION, root: videoGenRoot(), proof: videoGenProof() }); }
function spec(): UvEnvironmentSpec { return { name: VIDEO_GEN_NAME, version: VIDEO_GEN_VERSION, root: videoGenRoot(), requirements: videoRequirementsFileFor(), proof: videoGenProof() }; }

/** The pinned mlx-video source, then the environment on top of it (first time only; a second caller joins the build). */
export async function ensureVideoGenEnvironment(onProgress: (phase: string) => void = () => {}, options: { signal?: AbortSignal } = {}): Promise<void> {
  if (!videoRequirementsFileFor()) throw new Error(`Video generation is not available on ${process.platform} ${process.arch} yet.`);
  const pin = installedEnginePin(VIDEO_GEN_NAME);
  if (!pin) throw new Error(`No pinned mlx-video build for ${process.platform} ${process.arch}.`);
  if (!videoGenSourceInstalled() || !existsSync(join(videoGenRoot(), ".engine-ready"))) {
    onProgress("source");
    await ensureEngine(pin, () => {}, { signal: options.signal, activate: true });
  }
  await ensureUvEnvironment(spec(), onProgress, options);
}

/**
 * The worker request of one clip. The Max profile always carries the Gemma folder of its pack (`text_encoder_dir`) and `profile: "max"`:
 * the dgrauet runtime ignores the prompt without it, and the worker refuses a Max request that lacks it (LTX25-MAX-01).
 */
export function buildWorkerRequest(quality: VideoQuality, paths: VideoModelPaths, input: VideoRunInput, jobId: string, output: string, poster: string): WorkerRequest {
  const edit = input.edit;
  const icLora = input.icLora;
  return { id: jobId, op: icLora ? "ic_lora" : edit ? edit.kind : "generate", model_dir: paths.modelDir, tokenizer_dir: paths.tokenizerDir, ...(paths.textEncoderDir ? { text_encoder_dir: paths.textEncoderDir, ffmpeg: ffmpegPath(rootOf(quality)) } : {}), ...(quality === "ltx25max" ? { profile: "max" as const } : {}), prompt: input.prompt, negative_prompt: input.negativePrompt, image: input.imagePath, ...(input.endImagePath ? { end_image: input.endImagePath } : {}), width: input.width, height: input.height, num_frames: input.frames, seed: input.seed, loras: icLora ? [[icLora.path, icLora.strength]] : input.loras, ...(input.loras.length > 0 && usesLtx25Engine(quality) ? { lora_mode: ltx25LoraMode(quality as "ltx25" | "ltx25max") } : {}), output, poster, ...(input.previewPath ? { preview: input.previewPath } : {}), ...(icLora ? { ic_lora_path: icLora.path, ic_lora_strength: icLora.strength, ...(icLora.sheets ? { reference_sheets: icLora.sheets } : { source_video: icLora.sourcePath, conditioning: icLora.conditioning, preserve_source_audio: true }), ...(icLora.ffprobe ? { ffprobe: icLora.ffprobe, ...(icLora.ffmpeg ? { ffmpeg: icLora.ffmpeg } : {}) } : {}) } : {}),
    // LTX25-EDIT-01: an extend or a retake names the (fitted) source clip and the latent numbers, and the Stack's own ffmpeg and ffprobe.
    ...(edit ? { source_video: edit.sourcePath, ffmpeg: edit.ffmpeg, ffprobe: edit.ffprobe, ...(edit.kind === "extend" ? { extend_frames: edit.extendFrames } : { retake_start_latent: edit.retakeStartLatent }) } : {}) };
}

export interface VideoModelPaths { modelDir: string; tokenizerDir: string; textEncoderDir?: string; h3Home?: string; h3Build?: H3VideoBuild; }
/** The installed, verified weights and text folders of one quality, or null when any is missing. */
export function videoModelPaths(quality: VideoQuality = "quick"): VideoModelPaths | null {
  if (quality === "h3" || quality === "h3stream") {
    const home = process.env.MAIPAI_H3_VIDEO_HOME || engineTagRoot("minimax-h3-video-gen", H3_VIDEO_VERSION);
    const models = join(home, "models/minimax_h3");
    const required = [join(home, "node/scripts/generate_staged.py"), join(home, ".venv/bin/python"), join(models, "upstream/FL2VA"), join(models, "qwen/8-bit")];
    const stream = join(models, "transformers/4-bit-pruned-stream2");
    const build: H3VideoBuild = quality === "h3stream" ? "streaming-24gb" : "boost-8bit";
    if (!required.every(existsSync) || (quality === "h3stream" ? !existsSync(stream) : !existsSync(join(models, "transformers/8-bit")))) return null;
    return { modelDir: models, tokenizerDir: join(models, "qwen/8-bit"), h3Home: home, h3Build: build };
  }
  if (quality === "ltx25max") { const paths = ltx25MaxModelPaths(); return paths ? { modelDir: paths.modelDir, tokenizerDir: paths.gemmaDir, textEncoderDir: paths.gemmaDir } : null; }
  if (quality === "ltx25") { const paths = ltx25ModelPaths(); return paths ? { modelDir: paths.modelDir, tokenizerDir: join(paths.modelDir, "text_encoder"), textEncoderDir: join(paths.modelDir, "text_encoder") } : null; }
  const model = getModel(STACK_VIDEO_MODEL_ID);
  const tokenizer = getModel(STACK_VIDEO_TOKENIZER_ID);
  if (!model?.modelPath || !model.verifiedAt || !existsSync(join(model.modelPath, "model.safetensors"))) return null;
  if (!tokenizer?.modelPath || !tokenizer.verifiedAt || !existsSync(join(tokenizer.modelPath, "tokenizer.json"))) return null;
  return { modelDir: model.modelPath, tokenizerDir: tokenizer.modelPath };
}

export interface Availability { available: boolean; code: string | null; reason: string | null; tier: string; }
/** Whether this computer's tier runs video at all. */
export function tierAvailability(tier = getGovernorStatus().tier, totalMemoryBytes = getGovernorStatus().totalMemoryBytes): Availability {
  if (!videoRequirementsFileFor()) return { available: false, code: "unsupported", reason: `Video generation is not available on ${process.platform} ${process.arch} yet.`, tier };
  if (!(VIDEO_TIERS as readonly string[]).includes(tier)) return { available: false, code: "not_available_on_this_computer", reason: `Video needs a computer with 128 GB of memory; this one has ${Math.round(totalMemoryBytes / 1_073_741_824)} GB.`, tier };
  return { available: true, code: null, reason: null, tier };
}

/** Whether a clip's peak can ever fit beside what is resident right now. A clip that cannot is refused now with the numbers; one that only waits on another generator queues. */
export async function memoryVerdict(quality: VideoQuality = "quick", peakBytes: number = VIDEO_SPECS[quality].peakBytes): Promise<{ ok: true } | { ok: false; kind?: "disk"; reason: string }> {
  const lowMemory = lowMemoryRefusal();
  if (lowMemory) return { ok: false, reason: lowMemory };
  const lowDisk = await lowDiskRefusal();
  if (lowDisk) return { ok: false, ...lowDisk };
  const disk = await diskAdmission(peakBytes);
  if (!disk.ok) return { ok: false, kind: "disk", reason: disk.reason };
  const status = getGovernorStatus();
  const resident = status.loaded.filter((item) => item.kind === "resident").reduce((sum, item) => sum + item.peakBytes, 0);
  if (resident + peakBytes > status.capBytes) return { ok: false, reason: "Not enough free memory for video right now. Close other big jobs, or try again in a few minutes." };
  return { ok: true };
}

// ---- the worker protocol ----

export interface WorkerRequest {
  id: string; op: "generate" | "extend" | "retake" | "ic_lora"; model_dir: string; tokenizer_dir: string; /** The model text folder and ffmpeg path, when its worker needs them. */ text_encoder_dir?: string; ffmpeg?: string | null; prompt: string; negative_prompt: string | null; image: string | null;
  /** VIDEO-INPUTS-01: the picture the clip ends on (LTX-2.5 only), with `image` as the start. */
  end_image?: string | null;
  width: number; height: number; num_frames: number; seed: number; loras: Array<[string, number]>; output: string; poster: string;
  reference_sheets?: string[]; ic_lora_path?: string; ic_lora_strength?: number; conditioning?: "source" | "edges"; preserve_source_audio?: boolean;
  /** GENPREVIEW-01: where the worker writes the first-frame preview once the motion is done. */
  preview?: string;
  /** VIDEO-LORA-05 (LTX-2.5 only, with `loras`): how the runtime applies them. The worker sets LTX2_LORA_MODE to it before it builds the pipeline; `unfused` is refused by a runtime that has none. */
  lora_mode?: "fused" | "unfused";
  /** LTX25-MAX-01: `max` selects the Max table and the dgrauet runtime's rules; the worker then refuses a request whose `text_encoder_dir` is not the pack's own Gemma folder. */
  profile?: "max";
  /** LTX25-EDIT-01 (op `extend` or `retake`, Max only): the source clip (on the 64 grid at 24 a second), the ffprobe the runtime reads it with, and the edit's own number in latent frames. */
  source_video?: string; ffprobe?: string; extend_frames?: number; retake_start_latent?: number;
}
export type WorkerEvent =
  | { id: string | null; event: "phase"; phase: "loading" | "rendering" | "decoding" | "encoding"; percent?: number }
  | { id: string | null; event: "stage"; stage: string; n?: number; of?: number }
  | { id: string | null; event: "preview"; ms?: number };
export interface WorkerReply { id: string | null; ok: boolean; code?: string; error?: string; width?: number; height?: number; frames?: number; fps?: number; seed?: number; ms?: number; peak_bytes?: number; audio?: boolean; }
export interface WorkerHandle { send(request: WorkerRequest, options: { onEvent: (event: WorkerEvent) => void; deadlineMs: number }): Promise<WorkerReply>; kill(graceMs?: number): void; exited: Promise<number>; /** ISOLATION-01: the process, for the gate that stops it while chat is working (absent on a scripted worker). */ pausable?: PausableWorker; }

export interface VideoGenDeps {
  supported: () => boolean;
  /** The quality is passed so the LTX-2.5 engine builds its own environment; a scripted dependency may ignore it. */
  ensureEnvironment: (onProgress: (phase: string) => void, signal?: AbortSignal, quality?: VideoQuality) => Promise<void>;
  spawn: (quality: VideoQuality) => Promise<WorkerHandle>;
  paths: (quality: VideoQuality) => VideoModelPaths | null;
  run?: typeof spawnRunner;
  ffmpeg?: (quality: VideoQuality) => string | null;
}

export const defaultVideoGenDeps: VideoGenDeps = {
  supported: () => !!videoRequirementsFileFor(),
  ensureEnvironment: (onProgress, signal, quality) => quality === "ltx25max" ? ensureLtx25MaxEnvironment(onProgress, { signal }) : quality === "ltx25" ? ensureLtx25Environment(onProgress, { signal }) : ensureVideoGenEnvironment(onProgress, { signal }),
  paths: videoModelPaths,
  run: spawnRunner,
  spawn: async (quality) => {
    if (quality === "ltx25" || quality === "ltx25max") return spawnLtx25(quality);
    const root = videoGenRoot();
    writeFileSync(join(root, "video_worker.py"), await Bun.file(workerScript).text());
    const script = join(root, VIDEO_SPECS[quality].worker);
    const cwd = join(root, "run");
    mkdirSync(cwd, { recursive: true });
    const env = managedEnv({ PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: root, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_PROGRESS_BARS: "1", TQDM_DISABLE: "1", TOKENIZERS_PARALLELISM: "false" });
    delete env.HF_TOKEN; delete env.HUGGING_FACE_HUB_TOKEN;
    const child = Bun.spawn([process.env.VIDEO_GEN_PYTHON ?? uvVenvPython(root), "-s", script], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
    return workerHandle(child);
  },
};

/** The LTX-2.5 worker: its own environment, the pinned runtime packages on PYTHONPATH, offline, no Hugging Face token. */
async function spawnLtx25(quality: "ltx25" | "ltx25max" = "ltx25"): Promise<WorkerHandle> {
  const root = quality === "ltx25max" ? ltx25MaxGenRoot() : ltx25GenRoot();
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "ltx25_worker.py"), await Bun.file(ltx25WorkerScript).text());
  const cwd = join(root, "run");
  mkdirSync(cwd, { recursive: true });
  const env = ltx25WorkerEnv(root);
  const child = Bun.spawn([(quality === "ltx25max" ? process.env.LTX25_MAX_GEN_PYTHON : process.env.LTX25_GEN_PYTHON) ?? uvVenvPython(root), "-s", join(root, "ltx25_worker.py")], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
  return workerHandle(child);
}

/** Wraps a spawned worker in the line protocol: one request at a time, phase events while it runs, one reply at the end. */
export function workerHandle(child: { pid?: number; stdin: { write(data: string): unknown; flush?(): unknown }; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): void }): WorkerHandle {
  let ready: () => void = () => {};
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const slot: { current: { id: string; onEvent: (event: WorkerEvent) => void; resolve: (reply: WorkerReply) => void } | null } = { current: null };
  // The worker writes phase and code only to stderr; it is drained so a full pipe never stalls it, and never kept (rule 6a).
  void (async () => { for await (const _chunk of child.stderr as unknown as AsyncIterable<Uint8Array>) { /* drained */ } })().catch(() => {});
  void (async () => {
    let buffer = "";
    for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>) {
      buffer += new TextDecoder().decode(chunk);
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (!line.startsWith("{")) continue;
        try {
          const message = JSON.parse(line) as (WorkerReply & { ready?: boolean; event?: string }) | WorkerEvent;
          if ("ready" in message && message.ready) ready();
          else if ("event" in message && message.event) { if (slot.current && message.id === slot.current.id) slot.current.onEvent(message as WorkerEvent); }
          else if (slot.current && message.id === slot.current.id) slot.current.resolve(message as WorkerReply);
        } catch { /* not a message */ }
      }
    }
  })().catch(() => {});
  const exited = child.exited.then((code) => {
    if (slot.current) slot.current.resolve({ id: slot.current.id, ok: false, code: "worker_stopped", error: "The video engine stopped before the clip was finished. Try again." });
    return code;
  });
  const pausable = new PausableProcess(child.pid ?? null, child.exited);
  const tree = new TreeSnapshot(child.pid ?? -1); tree.refresh();
  const owned = registerOwned("video-worker", tree);
  const stopTree = (graceMs: number) => pausable.killAfterResume(() => { const members = tree.refresh().length; void tree.stopAll(graceMs).then(() => { owned.finished(); const survivors = tree.survivors().length; if (members > 1) log(JSON.stringify({ event: "worker.tree_stopped", role: "video", members, survivors })); }); });
  return {
    exited,
    pausable,
    kill: (graceMs = 2_000) => stopTree(graceMs),
    send: async (request, options) => {
      await Promise.race([started, exited.then(() => {})]);
      return await new Promise<WorkerReply>((resolve) => {
        // The deadline does not run while the process is stopped for a chat (ISOLATION-01).
        tree.refresh(); owned.refresh();
        const timer = pausable.deadline(options.deadlineMs, () => { stopTree(2_000); resolve({ id: request.id, ok: false, code: "timeout", error: "The clip took too long and was stopped. Try a shorter clip." }); });
        slot.current = { id: request.id, onEvent: options.onEvent, resolve: (reply) => { timer.clear(); slot.current = null; resolve(reply); } };
        child.stdin.write(`${JSON.stringify(request)}\n`); child.stdin.flush?.();
      });
    },
  };
}

// ---- the service ----

export type VideoState = "unsupported" | "off" | "not-installed" | "needs-setup" | "building" | "idle" | "running";

export interface VideoRunInput {
  prompt: string; negativePrompt: string | null; imagePath: string | null; /** VIDEO-INPUTS-01: the picture the clip ends on; needs imagePath. */ endImagePath?: string | null; width: number; height: number; frames: number; seed: number;
  loras: Array<[string, number]>; outputDir: string;
  /** Which model makes the clip (default Quick). */
  quality?: VideoQuality;
  /** LTX25-EDIT-01: extend or retake a source clip (Max only). `sourcePath` is the fitted private copy; `extendFrames` and `retakeStartLatent` are latent frames (video/ltx25Edit.ts maps seconds to them). */
  edit?: { kind: "extend" | "retake"; sourcePath: string; ffmpeg: string; ffprobe: string; extendFrames?: number; retakeStartLatent?: number };
  icLora?: { sourcePath: string; path: string; strength: number; conditioning: "source" | "edges"; /** INGREDIENTS-01: reference sheet pictures (private copies in the job folder) instead of a source clip; the worker loops each as a static reference video. */ sheets?: string[]; /** The Stack's own ffmpeg and ffprobe: the worker links both on PATH and refuses to run without them (an IC-LoRA clip, from a source clip or from sheets, never ran without ffprobe). */ ffmpeg?: string; ffprobe?: string };
  /** Where the worker writes the first-frame preview (a file the job's runner serves while the clip runs). */
  previewPath?: string;
}
export interface VideoRunResult {
  width: number; height: number; frames: number; fps: number; seed: number; ms: number; peakBytes: number | null; /** The clip has a sound track the model made. */ audio: boolean;
  /** VF-RECEIPT-01: what really ran, for the receipt. `steps` is the count the runner used (H3 reads it from the adapter on disk today), `adapter` the one applied. */
  ran?: { steps: number | null; schedule: string | null; adapter: { id: string; strength: number | null } | null };
  /** VF-RECEIPT-01: the model's own file was kept as `native.mp4` and `video.mp4` is a derived copy of it (the messaging-ready one). Absent: `video.mp4` is the native file. */
  derived?: "messaging_copy";
}

/** Overall progress of a clip from the phases, weighted by where the time goes (measured: load 3 percent, denoise 8, decode 85, encode 4). */
export function overallPercent(phase: string, phasePercent: number): number {
  const p = Math.max(0, Math.min(100, phasePercent)) / 100;
  if (phase === "loading" || phase === "setting up") return Math.round(4 * p);
  if (phase === "rendering") return Math.round(4 + 9 * p);
  if (phase === "decoding") return Math.round(13 + 84 * p);
  if (phase === "encoding") return Math.round(97 + 3 * p);
  return 0;
}

export interface VideoRunOptions {
  signal?: AbortSignal; jobId: string;
  onPhase?: (phase: string, phasePercent: number) => void;
  onStage?: (stage: string, n: number | null, of: number | null) => void;
  onPreview?: () => void;
}

export class VideoGenService {
  private worker: WorkerHandle | null = null;
  private workerQuality: VideoQuality = "quick";
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private building: string | null = null;
  private busy = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private lastSuccessAt: number | null = null;
  private lastPhase: string | null = null;
  private deps: VideoGenDeps;
  constructor(deps: VideoGenDeps = defaultVideoGenDeps) { this.deps = deps; }

  /** The suite swaps in a scripted worker; null puts the real one back. */
  useDeps(deps: VideoGenDeps | null): void { this.stopWorker(); this.deps = deps ?? defaultVideoGenDeps; }
  /** Whether the weights and the tokenizer are installed and verified. */
  hasModels(quality: VideoQuality = "quick"): boolean { return this.deps.paths(quality) !== null; }

  /** The worker is alive (loaded) or building; for the role state and the status route. */
  get workerAlive(): boolean { return this.worker !== null; }
  get phase(): string | null { return this.lastPhase; }
  get lastSuccess(): number | null { return this.lastSuccessAt; }

  status(): { state: VideoState; phase: string | null; building: string | null; models: boolean; environment: boolean } {
    const availability = tierAvailability();
    // Any installed video pack can make a video.
    const models = this.deps.paths("quick") !== null || this.deps.paths("ltx25") !== null || this.deps.paths("ltx25max") !== null || this.deps.paths("h3") !== null || this.deps.paths("h3stream") !== null;
    const state: VideoState = !this.deps.supported() ? "unsupported" : !availability.available ? "off" : !models ? "not-installed" : this.building ? "building" : this.busy > 0 ? "running" : this.worker ? "idle" : "needs-setup";
    return { state, phase: this.busy > 0 ? this.lastPhase : null, building: this.building, models, environment: videoGenEnvironmentReady() };
  }

  /** Runs one clip, one at a time. The caller (the job runner) holds the governor admission. Throws a VideoError that says what to do. */
  run(input: VideoRunInput, options: VideoRunOptions): Promise<VideoRunResult> {
    setIdleTtlSeconds("video-worker", Math.ceil(idleMs() / 1000));
    const next = this.chain.then(() => this.execute(input, options), () => this.execute(input, options));
    this.chain = next.catch(() => {});
    return next;
  }

  private async ensureWorker(quality: VideoQuality, onPhase: (phase: string, percent: number) => void, signal?: AbortSignal): Promise<WorkerHandle> {
    // One video model is in memory at a time: the other one's worker leaves before this one starts.
    if (this.worker && this.workerQuality !== quality) this.stopWorker();
    if (this.worker) return this.worker;
    onPhase("setting up", 0);
    try {
      await this.deps.ensureEnvironment((phase) => { this.building = phase; onPhase("setting up", 0); }, signal, quality);
    } catch (error) {
      if (signal?.aborted) throw new VideoError("cancelled", "Cancelled.", 499);
      throw new VideoError("setup_failed", `The video engine could not be set up: ${error instanceof Error ? error.message : String(error)}. Check this computer's internet connection and try again.`, 503);
    } finally { this.building = null; }
    try {
      const worker = await this.deps.spawn(quality);
      this.worker = worker;
      this.workerQuality = quality;
      void worker.exited.then(() => { if (this.worker === worker) this.stopWorker(); });
      return worker;
    } catch (error) {
      throw new VideoError("failed", `The video engine could not start: ${error instanceof Error ? error.message : String(error)}.`, 500);
    }
  }

  private stopWorker(graceMs = 5_000): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const worker = this.worker; this.worker = null;
    if (worker) void worker.exited.finally(() => forgetLoadedItem("video-worker"));
    else forgetLoadedItem("video-worker");
    worker?.kill(graceMs);
  }

  /** Stops the worker now (shutdown, a cancel, or a test). */
  stop(): void { this.stopWorker(); }

  /** Stops the worker only when it is loaded and not working (the memory watchdog's way to give memory back); true when it stopped one. */
  stopIfIdle(): boolean {
    // No worker alive: nothing holds the memory, so the ledger entry goes at once.
    if (!this.worker) { forgetLoadedItem("video-worker"); return false; }
    if (!this.worker || this.busy > 0) return false;
    this.stopWorker();
    return true;
  }

  private async execute(input: VideoRunInput, options: VideoRunOptions): Promise<VideoRunResult> {
    const onPhase = (phase: string, percent: number) => { this.lastPhase = phase; options.onPhase?.(phase, percent); };
    if (options.signal?.aborted) throw new VideoError("cancelled", "Cancelled.", 499);
    const quality = input.quality ?? "quick";
    const paths = this.deps.paths(quality);
    if (!paths) throw new VideoError("model_missing", quality === "ltx25max" ? "The LTX-2.5 Max video model is not installed yet. An admin can install it in Settings, Models and storage, then try again." : quality === "ltx25" ? "The LTX-2.5 video model is not installed yet. An admin can install it in Settings, Models and storage, then try again." : "The video model is not installed yet. Install it from Home's Engines page, then try again.", 503);
    this.busy += 1;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    let lease: Lease | undefined;
    try {
      if (quality === "h3" || quality === "h3stream") {
        lease = heavyGate.attach({ role: "video", jobId: options.jobId, worker: undefined });
        mkdirSync(input.outputDir, { recursive: true, mode: 0o700 });
        const output = join(input.outputDir, "video.mp4");
        const home = paths.h3Home!; const models = paths.modelDir;
        const lora = join(models, "loras/minimax_h3_turbo_v4_step600_ema.safetensors");
        const hasLora = existsSync(lora);
        const transformer = paths.h3Build === "streaming-24gb" ? join(models, "transformers/4-bit-pruned-stream2") : join(models, "transformers/8-bit");
        const argv = h3VideoCommand(join(home, ".venv/bin/python"), join(home, "node/scripts/generate_staged.py"), {
          prompt: input.prompt, build: paths.h3Build!, checkpoint: join(models, "upstream/FL2VA"), transformer,
          qwenDir: join(models, "qwen/8-bit"), output,
          seconds: Math.max(4, Math.min(10, Math.round(input.frames / VIDEO_FPS))), width: input.width, height: input.height,
          seed: input.seed, steps: hasLora ? 7 : 12, ...(hasLora ? { lora } : {}),
          ...(input.imagePath ? { firstImage: input.imagePath } : {}), ...(input.endImagePath ? { lastImage: input.endImagePath } : {}),
        });
        onPhase("loading", 0);
        const result = await (this.deps.run ?? spawnRunner)(argv, { cwd: home, signal: options.signal, env: { HF_HUB_OFFLINE: "1", PYTHONPATH: join(home, "node"), PYTHONUNBUFFERED: "1" }, onStdoutLine: (line) => {
          const stage = /(?:stage|step)\s*[:#]?\s*(\d+)(?:\s*\/\s*(\d+))?/i.exec(line);
          if (stage) options.onStage?.("render", Number(stage[1]), stage[2] ? Number(stage[2]) : null);
          else if (/load|model/i.test(line)) onPhase("loading", 10);
          else if (/audio|encode|write|save/i.test(line)) onPhase("encoding", 80);
          else onPhase("rendering", 30);
        } });
        if (result.aborted || options.signal?.aborted) throw new VideoError("cancelled", "Cancelled.", 499);
        if (result.code !== 0 || !existsSync(output)) throw new VideoError("failed", "MiniMax H3 could not finish the clip. Check that its files are available in MAIPAI_H3_VIDEO_HOME.", 500);
        const ffmpeg = this.deps.ffmpeg ? this.deps.ffmpeg(quality) : (ffmpegPath(rootOf(quality)) ?? await defaultToolbox.path("ffmpeg", () => {}, options.signal).catch(() => null));
        if (!ffmpeg) throw new VideoError("failed", "The video tools are not installed (no_ffmpeg).", 503);
        await (this.deps.run ?? spawnRunner)([ffmpeg, "-y", "-i", output, "-frames:v", "1", join(input.outputDir, "poster.jpg")], { signal: options.signal });
        this.lastSuccessAt = Date.now();
        // VF-RECEIPT-01: the reply is read from the file the runner wrote, not taken from the request (the generator's own report is the fallback only when the file cannot be probed).
        const made = await probeReceiptFile(output, options.signal);
        const steps = hasLora ? 7 : 12;
        return { width: made?.width ?? input.width, height: made?.height ?? input.height, frames: made?.frames ?? input.frames, fps: made?.fps ?? VIDEO_FPS, seed: input.seed, ms: 0, peakBytes: VIDEO_SPECS[quality].peakBytes, audio: made?.audio ?? true,
          ran: { steps, schedule: null, adapter: hasLora ? { id: "turbo-adapter", strength: null } : null } };
      }
      const worker = await this.ensureWorker(quality, onPhase, options.signal);
      lease = heavyGate.attach({ role: "video", jobId: options.jobId, worker: worker.pausable });
      mkdirSync(input.outputDir, { recursive: true, mode: 0o700 });
      const output = join(input.outputDir, "video.mp4");
      const poster = join(input.outputDir, "poster.jpg");
      const request = buildWorkerRequest(quality, paths, input, options.jobId, output, poster);
      const aborted = new Promise<never>((_, reject) => {
        const stop = () => { this.stopWorker(2_000); reject(new VideoError("cancelled", "Cancelled.", 499)); };
        if (options.signal?.aborted) stop(); else options.signal?.addEventListener("abort", stop, { once: true });
      });
      onPhase("loading", 0);
      const reply = await Promise.race([worker.send(request, { deadlineMs: deadlineMs(), onEvent: (event) => {
        if (event.event === "phase") onPhase(event.phase, event.percent ?? 0);
        else if (event.event === "stage") options.onStage?.(event.stage, event.n ?? null, event.of ?? null);
        else if (event.event === "preview") options.onPreview?.();
      } }), aborted]);
      if (!reply.ok) {
        // A worker that failed mid-clip may hold a half-built graph; start the next clip from a fresh process.
        if (reply.code === "out_of_memory" || reply.code === "timeout" || reply.code === "worker_stopped") this.stopWorker();
        throw new VideoError(reply.code ?? "failed", reply.error ?? "The clip could not be made.", STATUS_BY_CODE[reply.code ?? "failed"] ?? 500);
      }
      if (!existsSync(output) || !existsSync(poster)) throw new VideoError("failed", "The video engine finished without a file. Try again.", 500);
      // The stored clip is the messaging-ready one (silent AAC track, faststart, title): what Home keeps and the person sends.
      // VF-RECEIPT-01: the model's file is never rewritten in place. It is kept as native.mp4, and the messaging-ready copy is made from it as the delivered video.mp4;
      // a copy that cannot be made leaves the native file as the delivered one.
      let derived: "messaging_copy" | undefined;
      if (ffmpegPath(rootOf(quality))) derived = await deriveDelivered(output, join(input.outputDir, "native.mp4"), (from, to) => makeMessagesCopy(from, to, "MaiPai video", rootOf(quality)).then(() => undefined));
      this.lastSuccessAt = Date.now();
      return { width: reply.width ?? input.width, height: reply.height ?? input.height, frames: reply.frames ?? input.frames, fps: reply.fps ?? VIDEO_FPS, seed: reply.seed ?? input.seed, ms: reply.ms ?? 0, peakBytes: reply.peak_bytes ?? null, audio: reply.audio === true, ...(derived ? { derived } : {}), ran: { steps: usesLtx25Engine(quality) ? 11 : null, schedule: usesLtx25Engine(quality) ? "distilled 8 + 3 steps, 2x spatial upscale" : null, adapter: null } };
    } finally {
      this.busy -= 1;
      lease?.detach();
      if (options.signal?.aborted) rmSync(input.outputDir, { recursive: true, force: true });
      if (this.worker && this.busy === 0) this.idleTimer = setTimeout(() => { log("video worker stopped after being idle"); this.stopWorker(); }, idleMs());
    }
  }
}

export const videoGen = new VideoGenService();
setWarmWorkerUnload("video-worker", () => videoGen.stopIfIdle());

/** The role's state for /stack/v1/roles, derived and never stored. */
export function videoRoleState(service: VideoGenService = videoGen, now = Date.now()): RoleStateRecord {
  const since = new Date(now).toISOString();
  const status = service.status();
  if (status.state === "unsupported" || status.state === "off") return { state: "notInstalled", since, reason: tierAvailability().reason };
  if (status.state === "not-installed") return { state: "notInstalled", since };
  if (!service.workerAlive) return { state: "installed", since };
  const last = service.lastSuccess;
  if (last !== null && now - last <= READY_TTL_MS) return { state: "ready", since, checkedAt: new Date(last).toISOString() };
  return { state: "loaded", since };
}
