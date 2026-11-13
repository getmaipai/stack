// MP-07: the Stack's sound effects service. Stable Audio 3 Small-SFX (the
// stable-audio-3 source pinned by commit and checksum, the weights pinned file
// by file) runs in one managed Python 3.12 environment (the same uv builder as
// music, stems and the voice engines) and one worker process that exists only
// while sound work does: it starts on the first sound, keeps the model for the
// music keep-warm window (sounds come in bursts), then exits and gives its
// memory back. Never resident at boot. The worker runs offline (no hub, no
// token, no proxy) and reads only the pinned folder; the text encoder is
// pointed at its local copy. It also finishes each sound so Home needs no tool
// for it: the model's silent tail is cut and the loudness set to one level
// (sfx_worker.py), with the Stack's managed ffmpeg.
//
// Memory: a sound holds one governor admission (SFX_PEAK_BYTES) from the first
// byte loaded to the file written. The job queue takes it before this service
// is called. Measured on the Studio 2026-11-13: 5.27 GB peak footprint for the
// whole process, the same for a 2 s and a 47 s sound; 2 to 12 s per sound warm,
// about 20 s with the model load.
//
// Safety posture: the model has no filter and the Stack makes no decision about
// who is asking; age and surface gates and the minor line on every description
// live in Home, where the person is known.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { engineIdleMs } from "@/lib/engineIdle";
import { lowMemoryRefusal } from "@/lib/memoryState";
import { heavyGate, PausableProcess, type Lease, type PausableWorker } from "@/lib/heavyGate";
import { TreeSnapshot } from "@/lib/processTree";
import { registerOwned } from "@/lib/ownedProcesses";
import { forgetLoadedItem, getGovernorStatus, setIdleTtlSeconds, setWarmWorkerUnload } from "@/lib/governor";
import { installedEnginePin, MANAGED_RUNTIMES } from "@/lib/engineCatalog";
import { ensureEngine } from "@/lib/engineInstall";
import { log } from "@/lib/log";
import { getModel } from "@/lib/modelStore";
import { STACK_SFX_MODEL_ID } from "@/lib/modelCatalog";
import { engineTagRoot } from "@/lib/store/layout";
import { ensureUvEnvironment, managedEnv, uvEnvironmentReady, uvVenvPath, uvVenvPython, type UvEnvironmentSpec } from "@/lib/uvEnvironment";
import { defaultToolbox } from "@/media/tools";
import darwinArm64Requirements from "./sfx-gen.darwin-arm64.requirements.txt" with { type: "file" };
import workerScript from "./sfx_worker.py" with { type: "file" };

export const SFX_GEN_NAME = "sfx-gen";
export const SFX_GEN_VERSION = MANAGED_RUNTIMES.find((runtime) => runtime.name === SFX_GEN_NAME)?.version ?? "790793b";

/** Hard ceilings in the Stack, not settings. 47 s is the longest length run end to end on the Studio (2026-11-13); the model's own
 * window is 120 s, unverified past that run. */
export const SFX_MIN_SECONDS = 1;
export const SFX_MAX_SECONDS = 47;
export const SFX_DEFAULT_SECONDS = 5;
export const SFX_MAX_PROMPT_CHARS = 1000;
/** The model is distilled for 8 steps (Stability's default); 4 to 16 are allowed, 8 is the only count listened to. */
export const SFX_DEFAULT_STEPS = 8;
export const SFX_MIN_STEPS = 4;
export const SFX_MAX_STEPS = 16;
/** The clip is made this much longer than asked, then cut back to the sound's end and the asked length (the model ends a clip with
 * 0.5 to 1 s of silence, so a full-length ambience needs the extra second). */
export const SFX_EXTRA_SECONDS = 1;
/** The loudness every sound is set to (integrated LUFS), the worker's SFX_TARGET_LUFS; the gain is capped at +24 dB. */
export const SFX_TARGET_LUFS = -16;
export const SFX_QUEUE_MAX = 4;
/** The measured peak footprint of the whole worker (5.27 GB on the Studio, 2026-11-13, for 2 to 47 s sounds) with about a
 * gigabyte of margin. */
export const SFX_PEAK_BYTES = 6_500_000_000;
/** Tiers that make sounds: p16 keeps its memory for chat and voice. */
export const SFX_TIERS = ["p32", "p64", "p128"] as const;
const idleMs = (): number => engineIdleMs("music");
const deadlineMs = (): number => Number(process.env.SFX_DEADLINE_MS ?? 3 * 60_000);
/** The file name of a finished sound inside its output folder (the music result store's name, so a sound is held, served and
 * swept like a song). */
export const SOUND_FILE = "song.m4a";

export class SfxError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}
const STATUS_BY_CODE: Record<string, number> = { bad_request: 422, silent: 422, model_missing: 503, out_of_memory: 507, timeout: 504, worker_stopped: 500, failed: 500 };

export function sfxRequirementsFileFor(platform = process.platform, arch = process.arch): string | null {
  if (platform === "darwin" && arch === "arm64") return darwinArm64Requirements;
  return null;
}
export function sfxGenRoot(): string { return engineTagRoot(SFX_GEN_NAME, SFX_GEN_VERSION); }
/** A package the sync installs: proof the environment finished. */
export function sfxGenProof(): string { return join(uvVenvPath(sfxGenRoot()), "lib", "python3.12", "site-packages", "torchaudio", "__init__.py"); }
/** stable-audio-3's `stable_audio_3` package sits at the root of the extracted source, and the root is the worker's PYTHONPATH. */
export function sfxGenSourceInstalled(): boolean { return existsSync(join(sfxGenRoot(), "stable_audio_3", "model.py")); }
export function sfxGenEnvironmentReady(): boolean { return sfxGenSourceInstalled() && uvEnvironmentReady({ name: SFX_GEN_NAME, version: SFX_GEN_VERSION, root: sfxGenRoot(), proof: sfxGenProof() }); }
function spec(): UvEnvironmentSpec { return { name: SFX_GEN_NAME, version: SFX_GEN_VERSION, root: sfxGenRoot(), requirements: sfxRequirementsFileFor(), proof: sfxGenProof() }; }

/** The pinned stable-audio-3 source, then the environment on top of it (first time only; a second caller joins the build). */
export async function ensureSfxGenEnvironment(onProgress: (phase: string) => void = () => {}, options: { signal?: AbortSignal } = {}): Promise<void> {
  if (!sfxRequirementsFileFor()) throw new Error(`Sound effects are not available on ${process.platform} ${process.arch} yet.`);
  const pin = installedEnginePin(SFX_GEN_NAME);
  if (!pin) throw new Error(`No pinned stable-audio-3 build for ${process.platform} ${process.arch}.`);
  if (!sfxGenSourceInstalled() || !existsSync(join(sfxGenRoot(), ".engine-ready"))) {
    onProgress("source");
    await ensureEngine(pin, () => {}, { signal: options.signal, activate: true });
  }
  await ensureUvEnvironment(spec(), onProgress, options);
}

/** The installed, verified model folder, or null when it is missing. */
export function sfxModelDir(): string | null {
  const model = getModel(STACK_SFX_MODEL_ID);
  if (!model?.modelPath || !model.verifiedAt) return null;
  for (const file of ["model.safetensors", "model_config.json", join("t5gemma-b-b-ul2", "model.safetensors"), join("t5gemma-b-b-ul2", "tokenizer.json")]) if (!existsSync(join(model.modelPath, file))) return null;
  return model.modelPath;
}

export interface Availability { available: boolean; code: string | null; reason: string | null; tier: string; }
/** Whether this computer's tier makes sounds at all. */
export function sfxTierAvailability(tier = getGovernorStatus().tier, totalMemoryBytes = getGovernorStatus().totalMemoryBytes): Availability {
  if (!sfxRequirementsFileFor()) return { available: false, code: "unsupported", reason: `Sound effects are not available on ${process.platform} ${process.arch} yet.`, tier };
  if (!(SFX_TIERS as readonly string[]).includes(tier)) return { available: false, code: "not_available_on_this_computer", reason: `Sound effects need a computer with 32 GB of memory or more; this one has ${Math.round(totalMemoryBytes / 1_073_741_824)} GB.`, tier };
  return { available: true, code: null, reason: null, tier };
}

/** Whether a sound's peak can ever fit beside what is resident right now. One that cannot is refused now; one that only waits on another generator queues. */
export function sfxMemoryVerdict(): { ok: true } | { ok: false; reason: string } {
  const lowMemory = lowMemoryRefusal();
  if (lowMemory) return { ok: false, reason: lowMemory };
  const status = getGovernorStatus();
  const resident = status.loaded.filter((item) => item.kind === "resident").reduce((sum, item) => sum + item.peakBytes, 0);
  if (resident + SFX_PEAK_BYTES > status.capBytes) return { ok: false, reason: "Not enough free memory for sound effects right now. Close other big jobs, or try again in a few minutes." };
  return { ok: true };
}

// ---- the worker protocol ----

export interface SfxWorkerRequest { id: string; prompt: string; seconds: number; gen_seconds: number; seed: number; steps: number; output: string; model_dir: string; ffmpeg: string; }
export type SfxWorkerEvent = { id: string | null; event: "stage"; stage: "load" | "sound" | "save"; fraction?: number };
export interface SfxWorkerReply { id: string | null; ok: boolean; code?: string; error?: string; duration_s?: number; seed?: number; steps?: number; ms?: number; peak_bytes?: number; trimmed_s?: number; input_lufs?: number | null; normalised?: boolean; }
export interface SfxWorkerHandle { send(request: SfxWorkerRequest, options: { onEvent: (event: SfxWorkerEvent) => void; deadlineMs: number }): Promise<SfxWorkerReply>; kill(graceMs?: number): void; exited: Promise<number>; pausable?: PausableWorker; }

export interface SfxRuntime { modelDir: string; ffmpeg: string; }
export interface SfxGenDeps {
  supported: () => boolean;
  ensureEnvironment: (onProgress: (phase: string) => void, signal?: AbortSignal) => Promise<void>;
  spawn: () => Promise<SfxWorkerHandle>;
  /** Whether the weights are installed and verified. */
  installed: () => boolean;
  /** The model folder and the managed ffmpeg the worker is handed, made ready just before a request (ffmpeg installs on first use). */
  runtime: (onStatus: (status: string) => void, signal?: AbortSignal) => Promise<SfxRuntime>;
}

/** The worker's environment: offline, no token, no proxy, every cache under the Stack's data directory. */
export function sfxWorkerEnv(root = sfxGenRoot()): Record<string, string> {
  const env = managedEnv({
    PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: root, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", HF_HUB_DISABLE_PROGRESS_BARS: "1",
    TQDM_DISABLE: "1", TOKENIZERS_PARALLELISM: "false", PYTORCH_ENABLE_MPS_FALLBACK: "1", SFX_MAX_SECONDS: String(SFX_MAX_SECONDS), SFX_TARGET_LUFS: String(SFX_TARGET_LUFS),
  });
  for (const key of Object.keys(env)) if (/TOKEN|SECRET|PROXY/i.test(key) || key === "HF_ENDPOINT") delete env[key];
  return env;
}

export const defaultSfxGenDeps: SfxGenDeps = {
  supported: () => !!sfxRequirementsFileFor(),
  ensureEnvironment: (onProgress, signal) => ensureSfxGenEnvironment(onProgress, { signal }),
  installed: () => sfxModelDir() !== null,
  runtime: async (onStatus, signal) => {
    const modelDir = sfxModelDir();
    if (!modelDir) throw new SfxError("model_missing", "The sound effects model is not installed yet. Install it in Settings, AI and models, then try again.", 503);
    try { return { modelDir, ffmpeg: await defaultToolbox.path("ffmpeg", onStatus, signal) }; } catch (error) { throw new SfxError("failed", error instanceof Error ? error.message : String(error), 503); }
  },
  spawn: async () => {
    const root = sfxGenRoot();
    const script = join(root, "sfx_worker.py");
    writeFileSync(script, await Bun.file(workerScript).text());
    const cwd = join(root, "run");
    mkdirSync(cwd, { recursive: true });
    const child = Bun.spawn([process.env.SFX_GEN_PYTHON ?? uvVenvPython(root), "-s", script], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: sfxWorkerEnv(root) });
    return sfxWorkerHandle(child);
  },
};

/** Wraps a spawned worker in the line protocol: one request at a time, stage events while it runs, one reply at the end. */
export function sfxWorkerHandle(child: { pid?: number; stdin: { write(data: string): unknown; flush?(): unknown }; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): void }): SfxWorkerHandle {
  let ready: () => void = () => {};
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const slot: { current: { id: string; onEvent: (event: SfxWorkerEvent) => void; resolve: (reply: SfxWorkerReply) => void } | null } = { current: null };
  // The worker writes a stage, a code and an exception type only to stderr (and the library's own prints); drained, never kept.
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
          const message = JSON.parse(line) as (SfxWorkerReply & { ready?: boolean; event?: string }) | SfxWorkerEvent;
          if ("ready" in message && message.ready) ready();
          else if ("event" in message && message.event) { if (slot.current && message.id === slot.current.id) slot.current.onEvent(message as SfxWorkerEvent); }
          else if (slot.current && message.id === slot.current.id) slot.current.resolve(message as SfxWorkerReply);
        } catch { /* not a message */ }
      }
    }
  })().catch(() => {});
  const exited = child.exited.then((code) => {
    if (slot.current) slot.current.resolve({ id: slot.current.id, ok: false, code: "worker_stopped", error: "The sound engine stopped before the sound was finished. Try again." });
    return code;
  });
  const pausable = new PausableProcess(child.pid ?? null, child.exited);
  const tree = new TreeSnapshot(child.pid ?? -1); tree.refresh();
  const owned = registerOwned("sfx-worker", tree);
  const stopTree = (graceMs: number) => pausable.killAfterResume(() => { const members = tree.refresh().length; void tree.stopAll(graceMs).then(() => { owned.finished(); const survivors = tree.survivors().length; if (members > 1) log(JSON.stringify({ event: "worker.tree_stopped", role: "sound", members, survivors })); }); });
  return {
    exited,
    pausable,
    kill: (graceMs = 2_000) => stopTree(graceMs),
    send: async (request, options) => {
      await Promise.race([started, exited.then(() => {})]);
      return await new Promise<SfxWorkerReply>((resolve) => {
        tree.refresh(); owned.refresh();
        const timer = pausable.deadline(options.deadlineMs, () => { stopTree(2_000); resolve({ id: request.id, ok: false, code: "timeout", error: "The sound took too long and was stopped. Try a shorter sound." }); });
        slot.current = { id: request.id, onEvent: options.onEvent, resolve: (reply) => { timer.clear(); slot.current = null; resolve(reply); } };
        child.stdin.write(`${JSON.stringify(request)}\n`); child.stdin.flush?.();
      });
    },
  };
}

// ---- the service ----

export type SfxState = "unsupported" | "off" | "not-installed" | "needs-setup" | "building" | "idle" | "running";
export interface SfxRunFields { prompt: string; seconds: number; seed: number; steps: number; }
export interface SfxRunResult { duration_s: number; seed: number; steps: number; ms: number; peakBytes: number | null; trimmed_s: number | null; input_lufs: number | null; normalised: boolean; }
export interface SfxRunOptions { signal?: AbortSignal; jobId: string; onStage?: (stage: string, fraction: number | null) => void; }

export class SfxGenService {
  private worker: SfxWorkerHandle | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private building: string | null = null;
  private busy = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private deps: SfxGenDeps;
  constructor(deps: SfxGenDeps = defaultSfxGenDeps) { this.deps = deps; }

  /** The suite swaps in a scripted worker; null puts the real one back. */
  useDeps(deps: SfxGenDeps | null): void { this.stopWorker(); this.chain = Promise.resolve(); this.deps = deps ?? defaultSfxGenDeps; }
  hasModels(): boolean { return this.deps.installed(); }
  get workerAlive(): boolean { return this.worker !== null; }

  status(): { state: SfxState; building: string | null; models: boolean } {
    const availability = sfxTierAvailability();
    const models = this.deps.installed();
    const state: SfxState = !this.deps.supported() ? "unsupported" : !availability.available ? "off" : !models ? "not-installed" : this.building ? "building" : this.busy > 0 ? "running" : this.worker ? "idle" : "needs-setup";
    return { state, building: this.building, models };
  }

  /** Runs one sound, one at a time. The caller (the job runner) holds the governor admission. Throws an SfxError that says what to do. */
  run(fields: SfxRunFields, outputDir: string, options: SfxRunOptions): Promise<SfxRunResult> {
    setIdleTtlSeconds("sfx-worker", Math.ceil(idleMs() / 1000));
    const next = this.chain.then(() => this.execute(fields, outputDir, options), () => this.execute(fields, outputDir, options));
    this.chain = next.catch(() => {});
    return next;
  }

  private async ensureWorker(onStage: (stage: string, fraction: number | null) => void, signal?: AbortSignal): Promise<SfxWorkerHandle> {
    if (this.worker) return this.worker;
    onStage("load", null);
    try {
      await this.deps.ensureEnvironment((phase) => { this.building = phase; onStage("load", null); }, signal);
    } catch (error) {
      if (signal?.aborted) throw new SfxError("cancelled", "Cancelled.", 499);
      throw new SfxError("setup_failed", `The sound engine could not be set up: ${error instanceof Error ? error.message : String(error)}. Check this computer's internet connection and try again.`, 503);
    } finally { this.building = null; }
    try {
      const worker = await this.deps.spawn();
      this.worker = worker;
      void worker.exited.then(() => { if (this.worker === worker) this.stopWorker(); });
      return worker;
    } catch (error) {
      throw new SfxError("failed", `The sound engine could not start: ${error instanceof Error ? error.message : String(error)}.`, 500);
    }
  }

  private stopWorker(graceMs = 5_000): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const worker = this.worker; this.worker = null;
    if (worker) void worker.exited.finally(() => forgetLoadedItem("sfx-worker"));
    else forgetLoadedItem("sfx-worker");
    worker?.kill(graceMs);
  }

  stop(): void { this.stopWorker(); }

  /** Stops the worker only when it is loaded and not working (the memory watchdog's way to give memory back); true when it stopped one. */
  stopIfIdle(): boolean {
    if (!this.worker) { forgetLoadedItem("sfx-worker"); return false; }
    if (this.busy > 0) return false;
    this.stopWorker();
    return true;
  }

  private async execute(fields: SfxRunFields, outputDir: string, options: SfxRunOptions): Promise<SfxRunResult> {
    const onStage = (stage: string, fraction: number | null) => options.onStage?.(stage, fraction);
    if (options.signal?.aborted) throw new SfxError("cancelled", "Cancelled.", 499);
    if (!this.deps.installed()) throw new SfxError("model_missing", "The sound effects model is not installed yet. Install it in Settings, AI and models, then try again.", 503);
    this.busy += 1;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    let lease: Lease | undefined;
    try {
      const runtime = await this.deps.runtime((status) => { this.building = status; onStage("load", null); }, options.signal).finally(() => { this.building = null; });
      const worker = await this.ensureWorker(onStage, options.signal);
      lease = heavyGate.attach({ role: "music", jobId: options.jobId, worker: worker.pausable });
      mkdirSync(outputDir, { recursive: true, mode: 0o700 });
      const output = join(outputDir, SOUND_FILE);
      const request: SfxWorkerRequest = { id: options.jobId, prompt: fields.prompt, seconds: fields.seconds, gen_seconds: Math.min(fields.seconds + SFX_EXTRA_SECONDS, SFX_MAX_SECONDS + SFX_EXTRA_SECONDS), seed: fields.seed, steps: fields.steps, output, model_dir: runtime.modelDir, ffmpeg: runtime.ffmpeg };
      const aborted = new Promise<never>((_, reject) => {
        const stop = () => { this.stopWorker(2_000); reject(new SfxError("cancelled", "Cancelled.", 499)); };
        if (options.signal?.aborted) stop(); else options.signal?.addEventListener("abort", stop, { once: true });
      });
      const reply = await Promise.race([worker.send(request, { deadlineMs: deadlineMs(), onEvent: (event) => { if (event.event === "stage") onStage(event.stage, event.fraction ?? null); } }), aborted]);
      if (!reply.ok) {
        // A worker that failed mid-sound may hold a half-built graph; start the next sound from a fresh process.
        if (reply.code === "out_of_memory" || reply.code === "timeout" || reply.code === "worker_stopped") this.stopWorker();
        throw new SfxError(reply.code ?? "failed", reply.error ?? "The sound could not be made.", STATUS_BY_CODE[reply.code ?? "failed"] ?? 500);
      }
      if (!existsSync(output)) throw new SfxError("failed", "The sound engine finished without a file. Try again.", 500);
      return { duration_s: reply.duration_s ?? fields.seconds, seed: reply.seed ?? fields.seed, steps: reply.steps ?? fields.steps, ms: reply.ms ?? 0, peakBytes: reply.peak_bytes ?? null, trimmed_s: reply.trimmed_s ?? null, input_lufs: reply.input_lufs ?? null, normalised: reply.normalised ?? false };
    } finally {
      this.busy -= 1;
      lease?.detach();
      if (options.signal?.aborted) rmSync(outputDir, { recursive: true, force: true });
      if (this.worker && this.busy === 0) this.idleTimer = setTimeout(() => { log("sfx worker stopped after being idle"); this.stopWorker(); }, idleMs());
    }
  }
}

export const sfxGen = new SfxGenService();
setWarmWorkerUnload("sfx-worker", () => sfxGen.stopIfIdle());
