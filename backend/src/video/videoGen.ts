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
import { lowMemoryRefusal } from "@/lib/memoryState";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installedEnginePin, MANAGED_RUNTIMES } from "@/lib/engineCatalog";
import { ensureEngine } from "@/lib/engineInstall";
import { getGovernorStatus } from "@/lib/governor";
import { log } from "@/lib/log";
import { ffmpegPath, makeMessagesCopy } from "@/video/messages";
import { getModel } from "@/lib/modelStore";
import { STACK_VIDEO_MODEL_ID, STACK_VIDEO_TOKENIZER_ID } from "@/lib/modelCatalog";
import { engineTagRoot } from "@/lib/store/layout";
import { ensureUvEnvironment, managedEnv, uvEnvironmentReady, uvVenvPath, uvVenvPython, type UvEnvironmentSpec } from "@/lib/uvEnvironment";
import type { RoleStateRecord } from "@/roles";
import { READY_TTL_MS } from "@/roles";
import darwinArm64Requirements from "./video-gen.darwin-arm64.requirements.txt" with { type: "file" };
import workerScript from "./video_worker.py" with { type: "file" };

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
const idleMs = (): number => Number(process.env.VIDEO_IDLE_MS ?? 10 * 60_000);
const deadlineMs = (): number => Number(process.env.VIDEO_DEADLINE_MS ?? 15 * 60_000);

export class VideoError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}
const STATUS_BY_CODE: Record<string, number> = { bad_request: 422, model_missing: 503, out_of_memory: 507, timeout: 504, worker_stopped: 500, failed: 500 };

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

export interface VideoModelPaths { modelDir: string; tokenizerDir: string; }
/** The installed, verified weights and tokenizer folders, or null when either is missing. */
export function videoModelPaths(): VideoModelPaths | null {
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
export function memoryVerdict(): { ok: true } | { ok: false; reason: string } {
  const lowMemory = lowMemoryRefusal();
  if (lowMemory) return { ok: false, reason: lowMemory };
  const status = getGovernorStatus();
  const resident = status.loaded.filter((item) => item.kind === "resident").reduce((sum, item) => sum + item.peakBytes, 0);
  if (resident + VIDEO_PEAK_BYTES > status.capBytes) return { ok: false, reason: "Not enough free memory for video right now. Close other big jobs, or try again in a few minutes." };
  return { ok: true };
}

// ---- the worker protocol ----

export interface WorkerRequest {
  id: string; op: "generate"; model_dir: string; tokenizer_dir: string; prompt: string; negative_prompt: string | null; image: string | null;
  width: number; height: number; num_frames: number; seed: number; loras: Array<[string, number]>; output: string; poster: string;
}
export interface WorkerEvent { id: string | null; event: "phase"; phase: "loading" | "rendering" | "decoding" | "encoding"; percent?: number; }
export interface WorkerReply { id: string | null; ok: boolean; code?: string; error?: string; width?: number; height?: number; frames?: number; fps?: number; seed?: number; ms?: number; peak_bytes?: number; }
export interface WorkerHandle { send(request: WorkerRequest, options: { onEvent: (event: WorkerEvent) => void; deadlineMs: number }): Promise<WorkerReply>; kill(): void; exited: Promise<number>; }

export interface VideoGenDeps {
  supported: () => boolean;
  ensureEnvironment: (onProgress: (phase: string) => void, signal?: AbortSignal) => Promise<void>;
  spawn: () => Promise<WorkerHandle>;
  paths: () => VideoModelPaths | null;
}

export const defaultVideoGenDeps: VideoGenDeps = {
  supported: () => !!videoRequirementsFileFor(),
  ensureEnvironment: (onProgress, signal) => ensureVideoGenEnvironment(onProgress, { signal }),
  paths: videoModelPaths,
  spawn: async () => {
    const root = videoGenRoot();
    const script = join(root, "video_worker.py");
    writeFileSync(script, await Bun.file(workerScript).text());
    const cwd = join(root, "run");
    mkdirSync(cwd, { recursive: true });
    const env = managedEnv({ PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: root, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_PROGRESS_BARS: "1", TQDM_DISABLE: "1", TOKENIZERS_PARALLELISM: "false" });
    delete env.HF_TOKEN; delete env.HUGGING_FACE_HUB_TOKEN;
    const child = Bun.spawn([process.env.VIDEO_GEN_PYTHON ?? uvVenvPython(root), "-s", script], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
    return workerHandle(child);
  },
};

/** Wraps a spawned worker in the line protocol: one request at a time, phase events while it runs, one reply at the end. */
export function workerHandle(child: { stdin: { write(data: string): unknown; flush?(): unknown }; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): void }): WorkerHandle {
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
          else if ("event" in message && message.event === "phase") { if (slot.current && message.id === slot.current.id) slot.current.onEvent(message as WorkerEvent); }
          else if (slot.current && message.id === slot.current.id) slot.current.resolve(message as WorkerReply);
        } catch { /* not a message */ }
      }
    }
  })().catch(() => {});
  const exited = child.exited.then((code) => {
    if (slot.current) slot.current.resolve({ id: slot.current.id, ok: false, code: "worker_stopped", error: "The video engine stopped before the clip was finished. Try again." });
    return code;
  });
  return {
    exited,
    kill: () => { try { child.kill(); } catch { /* already gone */ } },
    send: async (request, options) => {
      await Promise.race([started, exited.then(() => {})]);
      return await new Promise<WorkerReply>((resolve) => {
        const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve({ id: request.id, ok: false, code: "timeout", error: "The clip took too long and was stopped. Try a shorter clip." }); }, options.deadlineMs);
        slot.current = { id: request.id, onEvent: options.onEvent, resolve: (reply) => { clearTimeout(timer); slot.current = null; resolve(reply); } };
        child.stdin.write(`${JSON.stringify(request)}\n`); child.stdin.flush?.();
      });
    },
  };
}

// ---- the service ----

export type VideoState = "unsupported" | "off" | "not-installed" | "needs-setup" | "building" | "idle" | "running";

export interface VideoRunInput {
  prompt: string; negativePrompt: string | null; imagePath: string | null; width: number; height: number; frames: number; seed: number;
  loras: Array<[string, number]>; outputDir: string;
}
export interface VideoRunResult { width: number; height: number; frames: number; fps: number; seed: number; ms: number; peakBytes: number | null; }

/** Overall progress of a clip from the phases, weighted by where the time goes (measured: load 3 percent, denoise 8, decode 85, encode 4). */
export function overallPercent(phase: string, phasePercent: number): number {
  const p = Math.max(0, Math.min(100, phasePercent)) / 100;
  if (phase === "loading" || phase === "setting up") return Math.round(4 * p);
  if (phase === "rendering") return Math.round(4 + 9 * p);
  if (phase === "decoding") return Math.round(13 + 84 * p);
  if (phase === "encoding") return Math.round(97 + 3 * p);
  return 0;
}

export class VideoGenService {
  private worker: WorkerHandle | null = null;
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
  hasModels(): boolean { return this.deps.paths() !== null; }

  /** The worker is alive (loaded) or building; for the role state and the status route. */
  get workerAlive(): boolean { return this.worker !== null; }
  get phase(): string | null { return this.lastPhase; }
  get lastSuccess(): number | null { return this.lastSuccessAt; }

  status(): { state: VideoState; phase: string | null; building: string | null; models: boolean; environment: boolean } {
    const availability = tierAvailability();
    const models = this.deps.paths() !== null;
    const state: VideoState = !this.deps.supported() ? "unsupported" : !availability.available ? "off" : !models ? "not-installed" : this.building ? "building" : this.busy > 0 ? "running" : this.worker ? "idle" : "needs-setup";
    return { state, phase: this.busy > 0 ? this.lastPhase : null, building: this.building, models, environment: videoGenEnvironmentReady() };
  }

  /** Runs one clip, one at a time. The caller (the job runner) holds the governor admission. Throws a VideoError that says what to do. */
  run(input: VideoRunInput, options: { signal?: AbortSignal; onPhase?: (phase: string, phasePercent: number) => void; jobId: string } ): Promise<VideoRunResult> {
    const next = this.chain.then(() => this.execute(input, options), () => this.execute(input, options));
    this.chain = next.catch(() => {});
    return next;
  }

  private async ensureWorker(onPhase: (phase: string, percent: number) => void, signal?: AbortSignal): Promise<WorkerHandle> {
    if (this.worker) return this.worker;
    onPhase("setting up", 0);
    try {
      await this.deps.ensureEnvironment((phase) => { this.building = phase; onPhase("setting up", 0); }, signal);
    } catch (error) {
      if (signal?.aborted) throw new VideoError("cancelled", "Cancelled.", 499);
      throw new VideoError("setup_failed", `The video engine could not be set up: ${error instanceof Error ? error.message : String(error)}. Check this computer's internet connection and try again.`, 503);
    } finally { this.building = null; }
    try {
      const worker = await this.deps.spawn();
      this.worker = worker;
      void worker.exited.then(() => { if (this.worker === worker) this.stopWorker(); });
      return worker;
    } catch (error) {
      throw new VideoError("failed", `The video engine could not start: ${error instanceof Error ? error.message : String(error)}.`, 500);
    }
  }

  private stopWorker(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const worker = this.worker; this.worker = null;
    worker?.kill();
  }

  /** Stops the worker now (shutdown, a cancel, or a test). */
  stop(): void { this.stopWorker(); }

  /** Stops the worker only when it is loaded and not working (the memory watchdog's way to give memory back); true when it stopped one. */
  stopIfIdle(): boolean {
    if (!this.worker || this.busy > 0) return false;
    this.stopWorker();
    return true;
  }

  private async execute(input: VideoRunInput, options: { signal?: AbortSignal; onPhase?: (phase: string, phasePercent: number) => void; jobId: string }): Promise<VideoRunResult> {
    const onPhase = (phase: string, percent: number) => { this.lastPhase = phase; options.onPhase?.(phase, percent); };
    if (options.signal?.aborted) throw new VideoError("cancelled", "Cancelled.", 499);
    const paths = this.deps.paths();
    if (!paths) throw new VideoError("model_missing", "The video model is not installed yet. Install it from Home's Engines page, then try again.", 503);
    this.busy += 1;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    try {
      const worker = await this.ensureWorker(onPhase, options.signal);
      mkdirSync(input.outputDir, { recursive: true, mode: 0o700 });
      const output = join(input.outputDir, "video.mp4");
      const poster = join(input.outputDir, "poster.jpg");
      const request: WorkerRequest = { id: options.jobId, op: "generate", model_dir: paths.modelDir, tokenizer_dir: paths.tokenizerDir, prompt: input.prompt, negative_prompt: input.negativePrompt, image: input.imagePath, width: input.width, height: input.height, num_frames: input.frames, seed: input.seed, loras: input.loras, output, poster };
      const aborted = new Promise<never>((_, reject) => {
        const stop = () => { this.stopWorker(); reject(new VideoError("cancelled", "Cancelled.", 499)); };
        if (options.signal?.aborted) stop(); else options.signal?.addEventListener("abort", stop, { once: true });
      });
      onPhase("loading", 0);
      const reply = await Promise.race([worker.send(request, { deadlineMs: deadlineMs(), onEvent: (event) => onPhase(event.phase, event.percent ?? 0) }), aborted]);
      if (!reply.ok) {
        // A worker that failed mid-clip may hold a half-built graph; start the next clip from a fresh process.
        if (reply.code === "out_of_memory" || reply.code === "timeout" || reply.code === "worker_stopped") this.stopWorker();
        throw new VideoError(reply.code ?? "failed", reply.error ?? "The clip could not be made.", STATUS_BY_CODE[reply.code ?? "failed"] ?? 500);
      }
      if (!existsSync(output) || !existsSync(poster)) throw new VideoError("failed", "The video engine finished without a file. Try again.", 500);
      // The stored clip is the messaging-ready one (silent AAC track, faststart, title): what Home keeps and the person sends.
      if (ffmpegPath(videoGenRoot())) {
        try { await makeMessagesCopy(output, output, "MaiPai video", videoGenRoot()); } catch (error) { log(`video: kept the plain clip, the messaging copy failed: ${error instanceof Error ? error.message : "unknown"}`); }
      }
      this.lastSuccessAt = Date.now();
      return { width: reply.width ?? input.width, height: reply.height ?? input.height, frames: reply.frames ?? input.frames, fps: reply.fps ?? VIDEO_FPS, seed: reply.seed ?? input.seed, ms: reply.ms ?? 0, peakBytes: reply.peak_bytes ?? null };
    } finally {
      this.busy -= 1;
      if (options.signal?.aborted) rmSync(input.outputDir, { recursive: true, force: true });
      if (this.worker && this.busy === 0) this.idleTimer = setTimeout(() => { log("video worker stopped after being idle"); this.stopWorker(); }, idleMs());
    }
  }
}

export const videoGen = new VideoGenService();

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
