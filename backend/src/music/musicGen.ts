// MUSIC-GEN-01: the Stack's music generation service. ACE-Step 1.5 (MIT, pinned
// by commit and checksum) runs in process inside one managed Python 3.12
// environment (the same uv builder as the voice engines, ComfyUI, the image
// tools and video) and one worker process that exists only while music work
// does: it starts on the first song, keeps its models for five idle minutes
// (songs come in bursts of edits), then exits and gives its memory back. Never
// resident at boot. The weights are pinned model records (a directory of the
// DiT, the text encoder, the VAE and the 1.7B planning LM, plus the 0.6B
// planning LM as a second record), so the worker needs no network at run time
// and runs with HF_HUB_OFFLINE=1. Design and every measurement: Home
// docs/design/music-generation-2026-10-17.md.
//
// Memory: a song holds one governor admission (MUSIC_PEAK_BYTES) from the first
// byte loaded to the last sample written. The job queue takes that admission
// before this service is called; this file never talks to the governor for a
// run. An edit (trim, fade, loudness) is CPU only and takes no admission, but it
// goes through the same chain as a song so the worker is never shared.
//
// Safety posture: the model has no filter and the Stack makes no decision about
// who is asking. The Stack enforces what it can know: the hard limits, the tier,
// and that a source track is one this Stack made (music/provenance.ts). Age and
// surface gates, the minor line on every description, lyric and title, and the
// no-real-voice line live in Home, where the person is known.
import { lowMemoryRefusal } from "@/lib/memoryState";
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installedEnginePin, MANAGED_RUNTIMES } from "@/lib/engineCatalog";
import { ensureEngine } from "@/lib/engineInstall";
import { getGovernorStatus } from "@/lib/governor";
import { log } from "@/lib/log";
import { getModel } from "@/lib/modelStore";
import { STACK_MUSIC_LM_06_ID, STACK_MUSIC_MODEL_ID } from "@/lib/modelCatalog";
import { engineTagRoot } from "@/lib/store/layout";
import { ensureUvEnvironment, managedEnv, uvEnvironmentReady, uvVenvPath, uvVenvPython, type UvEnvironmentSpec } from "@/lib/uvEnvironment";
import type { RoleStateRecord } from "@/roles";
import { READY_TTL_MS } from "@/roles";
import darwinArm64Requirements from "./music-gen.darwin-arm64.requirements.txt" with { type: "file" };
import workerScript from "./music_worker.py" with { type: "file" };

export const MUSIC_GEN_NAME = "music-gen";
export const MUSIC_GEN_VERSION = MANAGED_RUNTIMES.find((runtime) => runtime.name === MUSIC_GEN_NAME)?.version ?? "ca1e85f";

/** Hard ceilings in the Stack, not settings. */
export const MUSIC_MIN_SECONDS = 10;
export const MUSIC_DEFAULT_SECONDS = 60;
export const MUSIC_MAX_TEXT_CHARS = 4000;
export const MUSIC_MIN_BPM = 30;
export const MUSIC_MAX_BPM = 300;
export const MUSIC_MAX_SOURCE_BYTES = 40 * 1024 * 1024;
export const MUSIC_MIN_EXTEND_SECONDS = 5;
export const MUSIC_MAX_EXTEND_SECONDS = 120;
export const MUSIC_QUEUE_MAX = 4;
/** The measured peak memory footprint of a whole song, see Home's note section 4.2 (the owning session sets the measured value). */
export const MUSIC_PEAK_BYTES = 24_000_000_000;
/** Tiers that run music; p16 and p32 keep it in `notAvailable`. */
export const MUSIC_TIERS = ["p64", "p128"] as const;
/** The longest song per tier; also passed to the worker as MUSIC_MAX_SECONDS. */
export const MUSIC_MAX_SECONDS: Record<(typeof MUSIC_TIERS)[number], number> = { p64: 120, p128: 240 };
export type MusicQuality = "quick" | "detailed";
/** What each tier offers: p128 both (default detailed), p64 quick only. */
export const MUSIC_QUALITY: Record<(typeof MUSIC_TIERS)[number], { offered: MusicQuality[]; default: MusicQuality }> = {
  p64: { offered: ["quick"], default: "quick" },
  p128: { offered: ["quick", "detailed"], default: "detailed" },
};
/** The planning LM each quality loads. */
export const MUSIC_LM: Record<MusicQuality, string> = { quick: "acestep-5Hz-lm-0.6B", detailed: "acestep-5Hz-lm-1.7B" };
const idleMs = (): number => Number(process.env.MUSIC_IDLE_MS ?? 5 * 60_000);
const deadlineMs = (): number => Number(process.env.MUSIC_DEADLINE_MS ?? 10 * 60_000);
/** MLX's buffer cache is capped at 2 GB in the worker (Home's note, section 3). */
const CACHE_GB = 2;

export class MusicError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}
const STATUS_BY_CODE: Record<string, number> = { bad_request: 422, model_missing: 503, out_of_memory: 507, timeout: 504, worker_stopped: 500, failed: 500 };

export function musicRequirementsFileFor(platform = process.platform, arch = process.arch): string | null {
  if (platform === "darwin" && arch === "arm64") return darwinArm64Requirements;
  return null;
}
export function musicGenRoot(): string { return engineTagRoot(MUSIC_GEN_NAME, MUSIC_GEN_VERSION); }
/** A package the sync installs last-ish: proof the environment finished. */
export function musicGenProof(): string { return join(uvVenvPath(musicGenRoot()), "lib", "python3.12", "site-packages", "mlx_lm", "__init__.py"); }
/** ACE-Step's `acestep` package sits at the root of the extracted source, and the root is the worker's PYTHONPATH. */
export function musicGenSourceInstalled(): boolean { return existsSync(join(musicGenRoot(), "acestep", "__init__.py")); }
export function musicGenEnvironmentReady(): boolean { return musicGenSourceInstalled() && uvEnvironmentReady({ name: MUSIC_GEN_NAME, version: MUSIC_GEN_VERSION, root: musicGenRoot(), proof: musicGenProof() }); }
function spec(): UvEnvironmentSpec { return { name: MUSIC_GEN_NAME, version: MUSIC_GEN_VERSION, root: musicGenRoot(), requirements: musicRequirementsFileFor(), proof: musicGenProof() }; }

/** The ffmpeg bundled with this environment (imageio-ffmpeg, the AAC encoder) or the one MUSIC_FFMPEG names. */
export function musicFfmpegPath(root = musicGenRoot()): string | null {
  const named = process.env.MUSIC_FFMPEG;
  if (named !== undefined) return named !== "" && existsSync(named) ? named : null;
  try {
    const dir = join(uvVenvPath(root), "lib", "python3.12", "site-packages", "imageio_ffmpeg", "binaries");
    const file = readdirSync(dir).find((name) => name.startsWith("ffmpeg"));
    return file ? join(dir, file) : null;
  } catch { return null; }
}

/** The pinned ACE-Step source, then the environment on top of it (first time only; a second caller joins the build). */
export async function ensureMusicGenEnvironment(onProgress: (phase: string) => void = () => {}, options: { signal?: AbortSignal } = {}): Promise<void> {
  if (!musicRequirementsFileFor()) throw new Error(`Music generation is not available on ${process.platform} ${process.arch} yet.`);
  const pin = installedEnginePin(MUSIC_GEN_NAME);
  if (!pin) throw new Error(`No pinned ACE-Step build for ${process.platform} ${process.arch}.`);
  if (!musicGenSourceInstalled() || !existsSync(join(musicGenRoot(), ".engine-ready"))) {
    onProgress("source");
    await ensureEngine(pin, () => {}, { signal: options.signal, activate: true });
  }
  await ensureUvEnvironment(spec(), onProgress, options);
}

export interface MusicModelPaths { modelDir: string; lm06Dir: string; }
/** The installed, verified weights folders (the shared pieces with the 1.7B LM, and the 0.6B LM), or null when either is missing. */
export function musicModelPaths(): MusicModelPaths | null {
  const model = getModel(STACK_MUSIC_MODEL_ID);
  const lm = getModel(STACK_MUSIC_LM_06_ID);
  if (!model?.modelPath || !model.verifiedAt || !existsSync(join(model.modelPath, "acestep-v15-turbo", "model.safetensors"))) return null;
  if (!lm?.modelPath || !lm.verifiedAt || !existsSync(join(lm.modelPath, "model.safetensors"))) return null;
  return { modelDir: model.modelPath, lm06Dir: lm.modelPath };
}

/**
 * The checkpoints folder the worker is handed: the folder ACE-Step reads
 * (`acestep-v15-turbo/`, `acestep-5Hz-lm-1.7B/`, `acestep-5Hz-lm-0.6B/`,
 * `Qwen3-Embedding-0.6B/`, `vae/`), assembled from the two pinned model
 * folders by links, in the engine's own run folder. The DiT folder is a real
 * folder of links to the pinned files: ACE-Step copies its own pinned model
 * code (two .py files) into it before loading, and that must land here, never
 * in a pinned, verified folder. Rebuilt at every worker start (it is a few
 * links).
 */
export function assembleCheckpointDir(paths: MusicModelPaths, into: string): string {
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  for (const entry of readdirSync(paths.modelDir)) {
    if (entry === "acestep-v15-turbo") {
      mkdirSync(join(into, entry));
      for (const file of readdirSync(join(paths.modelDir, entry))) symlinkSync(join(paths.modelDir, entry, file), join(into, entry, file));
    } else symlinkSync(join(paths.modelDir, entry), join(into, entry));
  }
  symlinkSync(paths.lm06Dir, join(into, MUSIC_LM.quick));
  return into;
}

/** Where the worker's checkpoints folder is assembled. */
export function checkpointDirPath(): string { return join(musicGenRoot(), "run", "ckpt"); }

export interface Availability { available: boolean; code: string | null; reason: string | null; tier: string; }
/** Whether this computer's tier runs music at all. */
export function tierAvailability(tier = getGovernorStatus().tier, totalMemoryBytes = getGovernorStatus().totalMemoryBytes): Availability {
  if (!musicRequirementsFileFor()) return { available: false, code: "unsupported", reason: `Music generation is not available on ${process.platform} ${process.arch} yet.`, tier };
  if (!(MUSIC_TIERS as readonly string[]).includes(tier)) return { available: false, code: "not_available_on_this_computer", reason: `Music needs a computer with 64 GB of memory or more; this one has ${Math.round(totalMemoryBytes / 1_073_741_824)} GB.`, tier };
  return { available: true, code: null, reason: null, tier };
}
/** The tier's limits, or null when it runs no music. */
export function tierLimits(tier: string = getGovernorStatus().tier): { max_seconds: number; quality: MusicQuality[]; default_quality: MusicQuality } | null {
  if (!(MUSIC_TIERS as readonly string[]).includes(tier)) return null;
  const key = tier as (typeof MUSIC_TIERS)[number];
  return { max_seconds: MUSIC_MAX_SECONDS[key], quality: [...MUSIC_QUALITY[key].offered], default_quality: MUSIC_QUALITY[key].default };
}

/** Whether a song's peak can ever fit beside what is resident right now. A song that cannot is refused now with the numbers; one that only waits on another generator queues. */
export function memoryVerdict(): { ok: true } | { ok: false; reason: string } {
  const lowMemory = lowMemoryRefusal();
  if (lowMemory) return { ok: false, reason: lowMemory };
  const status = getGovernorStatus();
  const resident = status.loaded.filter((item) => item.kind === "resident").reduce((sum, item) => sum + item.peakBytes, 0);
  if (resident + MUSIC_PEAK_BYTES > status.capBytes) return { ok: false, reason: "Not enough free memory for music right now. Close other big jobs, or try again in a few minutes." };
  return { ok: true };
}

// ---- the worker protocol ----

export interface WorkerRequest {
  id: string; op?: "edit"; task: string; caption?: string; lyrics?: string; instrumental?: boolean; duration_s?: number; bpm?: number; key?: string; language?: string; seed?: number;
  lm?: string; source?: string; from_s?: number; to_s?: number; add_s?: number; at?: "start" | "end"; strength?: number;
  edit?: { op: "trim" | "fade" | "loudness"; from_s?: number; to_s?: number; seconds?: number; where?: "in" | "out" | "both"; lufs?: number };
  output: string; ckpt_dir: string; ffmpeg: string; cache_gb?: number; title?: string; lrc?: boolean;
}
export type WorkerEvent = { id: string | null; event: "stage"; stage: "load" | "plan" | "music" | "mix" | "save"; fraction?: number };
export interface WorkerReply { id: string | null; ok: boolean; code?: string; error?: string; duration_s?: number; seed?: number | null; task?: string; lrc?: string | null; ms?: number; peak_bytes?: number; }
export interface WorkerHandle { send(request: WorkerRequest, options: { onEvent: (event: WorkerEvent) => void; deadlineMs: number }): Promise<WorkerReply>; kill(): void; exited: Promise<number>; }

export interface MusicRuntime { ckptDir: string; ffmpeg: string; }
export interface MusicGenDeps {
  supported: () => boolean;
  ensureEnvironment: (onProgress: (phase: string) => void, signal?: AbortSignal) => Promise<void>;
  spawn: () => Promise<WorkerHandle>;
  /** Whether the weights are installed and verified. */
  installed: () => boolean;
  /** The checkpoints folder and the ffmpeg binary the worker is handed, made ready just before a request. */
  runtime: () => MusicRuntime;
}

export const defaultMusicGenDeps: MusicGenDeps = {
  supported: () => !!musicRequirementsFileFor(),
  ensureEnvironment: (onProgress, signal) => ensureMusicGenEnvironment(onProgress, { signal }),
  installed: () => musicModelPaths() !== null,
  runtime: () => {
    const paths = musicModelPaths();
    if (!paths) throw new MusicError("model_missing", "The music model is not installed yet. Install it from Home's Engines page, then try again.", 503);
    const ffmpeg = musicFfmpegPath();
    if (!ffmpeg) throw new MusicError("failed", "The music tools are not installed on this computer, so the song cannot be saved as a sound file. Install music from Home's Engines page.", 503);
    return { ckptDir: checkpointDirPath(), ffmpeg };
  },
  spawn: async () => {
    const root = musicGenRoot();
    // Assembled once per worker start, never under a warm worker: ACE-Step writes its model code into this folder before it loads the model.
    const paths = musicModelPaths();
    if (!paths) throw new MusicError("model_missing", "The music model is not installed yet. Install it from Home's Engines page, then try again.", 503);
    assembleCheckpointDir(paths, checkpointDirPath());
    const script = join(root, "music_worker.py");
    writeFileSync(script, await Bun.file(workerScript).text());
    const cwd = join(root, "run");
    mkdirSync(cwd, { recursive: true });
    const tier = getGovernorStatus().tier as (typeof MUSIC_TIERS)[number];
    const env = managedEnv({
      PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: root, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", HF_HUB_DISABLE_PROGRESS_BARS: "1",
      TQDM_DISABLE: "1", TOKENIZERS_PARALLELISM: "false", ACESTEP_MLX_VAE_CHUNK: "256", MUSIC_MAX_SECONDS: String(MUSIC_MAX_SECONDS[tier] ?? MUSIC_MAX_SECONDS.p128),
    });
    delete env.HF_TOKEN; delete env.HUGGING_FACE_HUB_TOKEN;
    const child = Bun.spawn([process.env.MUSIC_GEN_PYTHON ?? uvVenvPython(root), "-s", script], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
    return workerHandle(child);
  },
};

/** Wraps a spawned worker in the line protocol: one request at a time, stage events while it runs, one reply at the end. */
export function workerHandle(child: { stdin: { write(data: string): unknown; flush?(): unknown }; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): void }): WorkerHandle {
  let ready: () => void = () => {};
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const slot: { current: { id: string; onEvent: (event: WorkerEvent) => void; resolve: (reply: WorkerReply) => void } | null } = { current: null };
  // The worker writes a stage, a code and an exception type only to stderr; it is drained so a full pipe never stalls it, and never kept (rule 6a).
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
    if (slot.current) slot.current.resolve({ id: slot.current.id, ok: false, code: "worker_stopped", error: "The music engine stopped before the song was finished. Try again." });
    return code;
  });
  return {
    exited,
    kill: () => { try { child.kill(); } catch { /* already gone */ } },
    send: async (request, options) => {
      await Promise.race([started, exited.then(() => {})]);
      return await new Promise<WorkerReply>((resolve) => {
        const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve({ id: request.id, ok: false, code: "timeout", error: "The song took too long and was stopped. Try a shorter song." }); }, options.deadlineMs);
        slot.current = { id: request.id, onEvent: options.onEvent, resolve: (reply) => { clearTimeout(timer); slot.current = null; resolve(reply); } };
        child.stdin.write(`${JSON.stringify(request)}\n`); child.stdin.flush?.();
      });
    },
  };
}

// ---- the service ----

export type MusicState = "unsupported" | "off" | "not-installed" | "needs-setup" | "building" | "idle" | "running";

/** What a run asks the worker for: the request fields the route validated, and where the song goes. The service adds the id, the output path, the checkpoints folder and ffmpeg. */
export type MusicRunFields = Omit<WorkerRequest, "id" | "output" | "ckpt_dir" | "ffmpeg" | "cache_gb">;
export interface MusicRunInput { fields: MusicRunFields; outputDir: string; }
export interface MusicRunResult { duration_s: number; seed: number | null; task: string; lrc: string | null; ms: number; peakBytes: number | null; }

export interface MusicRunOptions {
  signal?: AbortSignal; jobId: string;
  onStage?: (stage: string, fraction: number | null) => void;
}

/** The file name of a finished song inside its output folder. */
export const SONG_FILE = "song.m4a";

export class MusicGenService {
  private worker: WorkerHandle | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private building: string | null = null;
  private busy = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private lastSuccessAt: number | null = null;
  private deps: MusicGenDeps;
  constructor(deps: MusicGenDeps = defaultMusicGenDeps) { this.deps = deps; }

  /** The suite swaps in a scripted worker; null puts the real one back. */
  useDeps(deps: MusicGenDeps | null): void { this.stopWorker(); this.chain = Promise.resolve(); this.deps = deps ?? defaultMusicGenDeps; }
  /** Whether the weights are installed and verified. */
  hasModels(): boolean { return this.deps.installed(); }

  /** The worker is alive (loaded) or building; for the role state and the status route. */
  get workerAlive(): boolean { return this.worker !== null; }
  get lastSuccess(): number | null { return this.lastSuccessAt; }

  status(): { state: MusicState; building: string | null; models: boolean; environment: boolean } {
    const availability = tierAvailability();
    const models = this.deps.installed();
    const state: MusicState = !this.deps.supported() ? "unsupported" : !availability.available ? "off" : !models ? "not-installed" : this.building ? "building" : this.busy > 0 ? "running" : this.worker ? "idle" : "needs-setup";
    return { state, building: this.building, models, environment: musicGenEnvironmentReady() };
  }

  /** Runs one song or edit, one at a time. The caller (the job runner) holds the governor admission for a song. Throws a MusicError that says what to do. */
  run(input: MusicRunInput, options: MusicRunOptions): Promise<MusicRunResult> {
    const next = this.chain.then(() => this.execute(input, options), () => this.execute(input, options));
    this.chain = next.catch(() => {});
    return next;
  }

  private async ensureWorker(onStage: (stage: string, fraction: number | null) => void, signal?: AbortSignal): Promise<WorkerHandle> {
    if (this.worker) return this.worker;
    onStage("load", null);
    try {
      await this.deps.ensureEnvironment((phase) => { this.building = phase; onStage("load", null); }, signal);
    } catch (error) {
      if (signal?.aborted) throw new MusicError("cancelled", "Cancelled.", 499);
      throw new MusicError("setup_failed", `The music engine could not be set up: ${error instanceof Error ? error.message : String(error)}. Check this computer's internet connection and try again.`, 503);
    } finally { this.building = null; }
    try {
      const worker = await this.deps.spawn();
      this.worker = worker;
      void worker.exited.then(() => { if (this.worker === worker) this.stopWorker(); });
      return worker;
    } catch (error) {
      throw new MusicError("failed", `The music engine could not start: ${error instanceof Error ? error.message : String(error)}.`, 500);
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

  private async execute(input: MusicRunInput, options: MusicRunOptions): Promise<MusicRunResult> {
    const onStage = (stage: string, fraction: number | null) => options.onStage?.(stage, fraction);
    if (options.signal?.aborted) throw new MusicError("cancelled", "Cancelled.", 499);
    if (!this.deps.installed()) throw new MusicError("model_missing", "The music model is not installed yet. Install it from Home's Engines page, then try again.", 503);
    this.busy += 1;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    try {
      const worker = await this.ensureWorker(onStage, options.signal);
      mkdirSync(input.outputDir, { recursive: true, mode: 0o700 });
      const output = join(input.outputDir, SONG_FILE);
      const runtime = this.deps.runtime();
      const request: WorkerRequest = { ...input.fields, id: options.jobId, output, ckpt_dir: runtime.ckptDir, ffmpeg: runtime.ffmpeg, cache_gb: CACHE_GB };
      const aborted = new Promise<never>((_, reject) => {
        const stop = () => { this.stopWorker(); reject(new MusicError("cancelled", "Cancelled.", 499)); };
        if (options.signal?.aborted) stop(); else options.signal?.addEventListener("abort", stop, { once: true });
      });
      const reply = await Promise.race([worker.send(request, { deadlineMs: deadlineMs(), onEvent: (event) => { if (event.event === "stage") onStage(event.stage, event.fraction ?? null); } }), aborted]);
      if (!reply.ok) {
        // A worker that failed mid-song may hold a half-built graph; start the next song from a fresh process.
        if (reply.code === "out_of_memory" || reply.code === "timeout" || reply.code === "worker_stopped") this.stopWorker();
        throw new MusicError(reply.code ?? "failed", reply.error ?? "The song could not be made.", STATUS_BY_CODE[reply.code ?? "failed"] ?? 500);
      }
      if (!existsSync(output)) throw new MusicError("failed", "The music engine finished without a file. Try again.", 500);
      this.lastSuccessAt = Date.now();
      return { duration_s: reply.duration_s ?? input.fields.duration_s ?? 0, seed: reply.seed ?? null, task: reply.task ?? input.fields.task, lrc: reply.lrc ?? null, ms: reply.ms ?? 0, peakBytes: reply.peak_bytes ?? null };
    } finally {
      this.busy -= 1;
      if (options.signal?.aborted) rmSync(input.outputDir, { recursive: true, force: true });
      if (this.worker && this.busy === 0) this.idleTimer = setTimeout(() => { log("music worker stopped after being idle"); this.stopWorker(); }, idleMs());
    }
  }
}

export const musicGen = new MusicGenService();

/** The role's state for /stack/v1/roles, derived and never stored. */
export function musicRoleState(service: MusicGenService = musicGen, now = Date.now()): RoleStateRecord {
  const since = new Date(now).toISOString();
  const status = service.status();
  if (status.state === "unsupported" || status.state === "off") return { state: "notInstalled", since, reason: tierAvailability().reason };
  if (status.state === "not-installed") return { state: "notInstalled", since };
  if (!service.workerAlive) return { state: "installed", since };
  const last = service.lastSuccess;
  if (last !== null && now - last <= READY_TTL_MS) return { state: "ready", since, checkedAt: new Date(last).toISOString() };
  return { state: "loaded", since };
}
