// IMGGEN-STACK-01: the Stack's picture generation service. FLUX.2 Klein 4B
// (the default) and Z-Image-Turbo, run by mflux (MIT, pinned in a hashed
// requirements file) on the Apple GPU inside one managed Python 3.12
// environment (the same uv builder as the voice engines, the image tools and
// the video engine). One worker starts on the first request and exits after
// the configured idle window. It keeps the create model warm and can load the
// edit model beside it when the governor reports room. The weights are pinned
// model records in the hub cache, so the worker needs no network at run time
// and runs with HF_HUB_OFFLINE=1.
//
// The job queue takes its per-request governor admission before this service is
// called. When an edit grows the warm pool, this service checks the remaining
// budget for the planned 29 GB pair and tells the worker to keep both models
// or swap one at a time. The governor lets one generator job run at a time
// across pictures and video.
//
// Safety posture: the model has no filter and the Stack makes no decision about
// who is in a picture or who is asking. The Stack enforces what it can know:
// the hard size limits, the tier, the LoRA audience lock, and which LoRAs may
// ever be added (never a minor in a sexual context, never a real person's
// likeness). Age and surface gates, the prompt floor and the finished-picture
// check live in Home, where the person is known.
import { heavyGate, PausableProcess, type Lease, type PausableWorker } from "@/lib/heavyGate";
import { lowMemoryRefusal } from "@/lib/memoryState";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MANAGED_RUNTIMES } from "@/lib/engineCatalog";
import { forgetLoadedItem, getGovernorStatus, GovernorRules, refreshMeasuredPeakById, setIdleTtlSeconds, setImagePoolUnload } from "@/lib/governor";
import { log, logger } from "@/lib/log";
import { engineTagRoot } from "@/lib/store/layout";
import { ensureUvEnvironment, managedEnv, uvEnvironmentReady, uvVenvPath, uvVenvPython, type UvEnvironmentSpec } from "@/lib/uvEnvironment";
import { READY_TTL_MS, type RoleStateRecord } from "@/roles";
import { familyInstalled, familySnapshot, IMAGE_FAMILIES, imageAvailability, installedFamilies, peakBytes, type ImageFamilyId } from "@/images/models";
import darwinArm64Requirements from "./image-gen.darwin-arm64.requirements.txt" with { type: "file" };
import workerScript from "./mflux_worker.py" with { type: "file" };

export const IMAGE_GEN_NAME = "image-gen";
export const IMAGE_GEN_VERSION = MANAGED_RUNTIMES.find((runtime) => runtime.name === IMAGE_GEN_NAME)?.version ?? "0.23.0";
const idleMs = (): number => Number(process.env.IMAGE_IDLE_MS ?? 10 * 60_000);
const deadlineMs = (family: ImageFamilyId, count: number): number => Number(process.env.IMAGE_DEADLINE_MS ?? (family === "z-image-turbo" ? 4 : 2) * 60_000 * Math.max(1, count));

export class ImageError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}
const STATUS_BY_CODE: Record<string, number> = { bad_request: 422, unsupported_edit: 422, mask_empty: 422, model_missing: 503, out_of_memory: 507, timeout: 504, cancelled: 499, worker_stopped: 500, failed: 500 };
const MESSAGE_BY_CODE: Record<string, string> = {
  mask_empty: "The mask is empty. Paint the part of the picture to change, then try again.",
  unsupported_edit: "This picture model cannot edit a picture. Edits use FLUX.2 Klein 4B.",
};

export function imageRequirementsFileFor(platform = process.platform, arch = process.arch): string | null {
  if (platform === "darwin" && arch === "arm64") return darwinArm64Requirements;
  return null;
}
export function imageGenRoot(): string { return engineTagRoot(IMAGE_GEN_NAME, IMAGE_GEN_VERSION); }
export function imageGenProof(): string { return join(uvVenvPath(imageGenRoot()), "lib", "python3.12", "site-packages", "mflux", "__init__.py"); }
export function imageGenEnvironmentReady(): boolean { return uvEnvironmentReady({ name: IMAGE_GEN_NAME, version: IMAGE_GEN_VERSION, root: imageGenRoot(), proof: imageGenProof() }); }
function spec(): UvEnvironmentSpec { return { name: IMAGE_GEN_NAME, version: IMAGE_GEN_VERSION, root: imageGenRoot(), requirements: imageRequirementsFileFor(), proof: imageGenProof() }; }

/** The environment (first time only; a second caller joins the build). */
export function ensureImageGenEnvironment(onProgress: (phase: string) => void = () => {}, options: { signal?: AbortSignal } = {}): Promise<void> {
  if (!imageRequirementsFileFor()) throw new Error(`The picture generator is not available on ${process.platform} ${process.arch} yet.`);
  return ensureUvEnvironment(spec(), onProgress, options);
}

// ---- the worker protocol ----

export interface WorkerRequest {
  id: string; op: "generate" | "edit"; family: ImageFamilyId; quantize: number | null; model_dir: string; loras: Array<[string, number]>;
  create_family?: ImageFamilyId; edit_family?: ImageFamilyId; pool_strategy?: "pool" | "single";
  prompt: string; width?: number; height?: number; steps: number; seed: number; count?: number; out_dir: string;
  init_image?: string; strength?: number; image?: string; mask?: string; references?: string[]; region?: [number, number, number, number]; feather?: number;
  /** GENPREVIEW-01: write a small preview picture (`<out_dir>/preview.jpg`) after each denoising step. */
  preview?: boolean;
}
export type WorkerEvent =
  | { id: string | null; event: "phase"; phase: "loading" | "rendering" | "decoding"; percent?: number }
  | { id: string | null; event: "stage"; stage: string; n?: number; of?: number }
  | { id: string | null; event: "preview"; index: number; step: number; steps: number }
  | { id: string | null; event: "image"; index: number; seed: number };
export interface WorkerReply { id: string | null; ok: boolean; code?: string; error?: string; diag?: { type?: string; frames?: string[]; message?: string | null }; seeds?: number[]; ms?: number; peak_bytes?: number; width?: number; height?: number; }
export interface WorkerHandle {
  send(request: WorkerRequest, options: { onEvent: (event: WorkerEvent) => void; deadlineMs: number }): Promise<WorkerReply>;
  cancel(id: string): void;
  kill(): void;
  exited: Promise<number>;
  /** ISOLATION-01: the process, for the gate that stops it while chat is working (absent on a scripted worker). */
  pausable?: PausableWorker;
}

export interface ImageGenDeps {
  supported: () => boolean;
  ensureEnvironment: (onProgress: (phase: string) => void, signal?: AbortSignal) => Promise<void>;
  spawn: () => Promise<WorkerHandle>;
  /** The snapshot folder of an installed family, or null. */
  snapshot: (family: ImageFamilyId) => string | null;
  /** Test seam for the governor's incremental pool-growth verdict. */
  poolGrowthFits?: (activeRequestPeakBytes: number) => boolean;
}

export const defaultImageGenDeps: ImageGenDeps = {
  supported: () => !!imageRequirementsFileFor(),
  ensureEnvironment: (onProgress, signal) => ensureImageGenEnvironment(onProgress, { signal }),
  snapshot: familySnapshot,
  spawn: async () => {
    const root = imageGenRoot();
    const script = join(root, "mflux_worker.py");
    mkdirSync(root, { recursive: true });
    writeFileSync(script, await Bun.file(workerScript).text());
    const cwd = join(root, "run");
    mkdirSync(cwd, { recursive: true });
    const env = managedEnv({ PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_PROGRESS_BARS: "1", TQDM_DISABLE: "1", TOKENIZERS_PARALLELISM: "false", MFLUX_CACHE_DIR: join(root, "cache") });
    delete env.HF_TOKEN; delete env.HUGGING_FACE_HUB_TOKEN;
    const child = Bun.spawn([process.env.IMAGE_GEN_PYTHON ?? uvVenvPython(root), "-s", script], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
    return workerHandle(child);
  },
};

/** Wraps a spawned worker in the line protocol: one request at a time, events while it runs, one reply at the end, a cancel line at any moment. */
export function workerHandle(child: { pid?: number; stdin: { write(data: string): unknown; flush?(): unknown }; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): void }): WorkerHandle {
  let ready: () => void = () => {};
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const slot: { current: { id: string; onEvent: (event: WorkerEvent) => void; resolve: (reply: WorkerReply) => void } | null } = { current: null };
  // The worker's stderr is drained so a full pipe never stalls it, and never kept: it can carry a traceback with a prompt in it (rule 6a).
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
    if (slot.current) slot.current.resolve({ id: slot.current.id, ok: false, code: "worker_stopped", error: "The picture engine stopped before the picture was finished. Try again." });
    return code;
  });
  const pausable = new PausableProcess(child.pid ?? null, child.exited);
  return {
    exited,
    pausable,
    kill: () => pausable.killAfterResume(() => { try { child.kill(); } catch { /* already gone */ } }),
    // A cancel line is read only by a running worker.
    cancel: (id) => { pausable.resume(); try { child.stdin.write(`${JSON.stringify({ op: "cancel", id })}\n`); child.stdin.flush?.(); } catch { /* gone */ } },
    send: async (request, options) => {
      await Promise.race([started, exited.then(() => {})]);
      return await new Promise<WorkerReply>((resolve) => {
        const timer = pausable.deadline(options.deadlineMs, () => { try { child.kill(); } catch { /* gone */ } resolve({ id: request.id, ok: false, code: "timeout", error: "The picture took too long and was stopped. Try a smaller size or fewer pictures." }); });
        slot.current = { id: request.id, onEvent: options.onEvent, resolve: (reply) => { timer.clear(); slot.current = null; resolve(reply); } };
        child.stdin.write(`${JSON.stringify(request)}\n`); child.stdin.flush?.();
      });
    },
  };
}

// ---- the service ----

export type ImageState = "unsupported" | "off" | "not-installed" | "needs-setup" | "building" | "idle" | "running";

export interface ImageRunInput {
  op: "generate" | "edit"; family: ImageFamilyId; quantize: number | null; prompt: string; width?: number; height?: number; steps: number; seed: number; count?: number;
  loras: Array<[string, number]>; outDir: string;
  initImage?: string; strength?: number; image?: string; mask?: string; references?: string[]; region?: [number, number, number, number]; feather?: number;
  /** Ask the worker for per-step previews (generate only). */
  preview?: boolean;
}
export interface ImageRunResult { seeds: number[]; ms: number; peakBytes: number | null; width: number | null; height: number | null; }

/** Overall progress from the phases: load 5 percent, the steps and decode 95 (the worker reports the picture-weighted percent itself). */
export function overallPercent(phase: string, phasePercent: number): number {
  const p = Math.max(0, Math.min(100, phasePercent)) / 100;
  if (phase === "loading" || phase === "setting up") return Math.round(5 * p);
  return Math.round(5 + 94 * p);
}

export interface ImageRunOptions {
  signal?: AbortSignal; jobId: string;
  onPhase?: (phase: string, phasePercent: number) => void;
  onStage?: (stage: string, n: number | null, of: number | null) => void;
  onPreview?: (step: number, steps: number) => void;
  onImage?: (index: number) => void;
}

export class ImageGenService {
  private worker: WorkerHandle | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private building: string | null = null;
  private busy = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private lastSuccessAt: number | null = null;
  private lastPhase: string | null = null;
  private deps: ImageGenDeps;
  constructor(deps: ImageGenDeps = defaultImageGenDeps) { this.deps = deps; }

  /** The suite swaps in a scripted worker; null puts the real one back. */
  useDeps(deps: ImageGenDeps | null): void { this.stopWorker(); this.deps = deps ?? defaultImageGenDeps; }
  supported(): boolean { return this.deps.supported(); }
  /** The picture families whose weights are installed and verified. */
  families(): ImageFamilyId[] { return installedFamilies(); }
  hasModels(): boolean { return this.families().length > 0; }
  get workerAlive(): boolean { return this.worker !== null; }
  get phase(): string | null { return this.lastPhase; }
  get lastSuccess(): number | null { return this.lastSuccessAt; }

  status(): { state: ImageState; phase: string | null; building: string | null; models: boolean; environment: boolean } {
    const availability = imageAvailability(this.deps.supported());
    const models = this.hasModels();
    const state: ImageState = !this.deps.supported() ? "unsupported" : !availability.available ? "off" : !models ? "not-installed" : this.building ? "building" : this.busy > 0 ? "running" : this.worker ? "idle" : "needs-setup";
    return { state, phase: this.busy > 0 ? this.lastPhase : null, building: this.building, models, environment: imageGenEnvironmentReady() };
  }

  /** Runs one request, one at a time. The caller (the job runner) holds the governor admission. Throws an ImageError that says what to do. */
  run(input: ImageRunInput, options: ImageRunOptions): Promise<ImageRunResult> {
    setIdleTtlSeconds("image-pool", Math.ceil(idleMs() / 1000));
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
      if (signal?.aborted) throw new ImageError("cancelled", "Cancelled.", 499);
      throw new ImageError("setup_failed", `The picture engine could not be set up: ${error instanceof Error ? error.message : String(error)}. Check this computer's internet connection and try again.`, 503);
    } finally { this.building = null; }
    try {
      const worker = await this.deps.spawn();
      this.worker = worker;
      void worker.exited.then(() => { if (this.worker === worker) this.stopWorker(); });
      return worker;
    } catch (error) {
      throw new ImageError("failed", `The picture engine could not start: ${error instanceof Error ? error.message : String(error)}.`, 500);
    }
  }

  private stopWorker(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const worker = this.worker; this.worker = null;
    worker?.kill();
    forgetLoadedItem("image-pool");
  }

  /** Stops the worker now (shutdown, a repair, or a test). */
  stop(): void { this.stopWorker(); }

  /** Stops the worker only when it is loaded and not working (the memory watchdog's way to give memory back); true when it stopped one. */
  stopIfIdle(): boolean {
    if (!this.worker || this.busy > 0) return false;
    this.stopWorker();
    return true;
  }

  private async execute(input: ImageRunInput, options: ImageRunOptions): Promise<ImageRunResult> {
    const onPhase = (phase: string, percent: number) => { this.lastPhase = phase; options.onPhase?.(phase, percent); };
    if (options.signal?.aborted) throw new ImageError("cancelled", "Cancelled.", 499);
    const modelDir = this.deps.snapshot(input.family);
    if (!modelDir) throw new ImageError("model_missing", `${IMAGE_FAMILIES[input.family].label} is not installed yet. Install it from Home's Engines page, then try again.`, 503);
    this.busy += 1;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let lease: Lease | undefined;
    try {
      const worker = await this.ensureWorker(onPhase, options.signal);
      lease = heavyGate.attach({ role: "image", jobId: options.jobId, worker: worker.pausable });
      mkdirSync(input.outDir, { recursive: true, mode: 0o700 });
      const request: WorkerRequest = {
        id: options.jobId, op: input.op, family: input.family, quantize: input.quantize, model_dir: modelDir, loras: input.loras, prompt: input.prompt, steps: input.steps, seed: input.seed, out_dir: input.outDir,
        create_family: input.family, edit_family: "flux2-klein-4b", pool_strategy: (this.deps.poolGrowthFits?.(peakBytes(input.family, input.op, input.quantize, input.loras.length)) ?? getGovernorStatus().loaded.some((item) => item.id === "image-pool" && item.peakBytes >= IMAGE_POOL_PEAK_BYTES)) ? "pool" : "single",
        ...(input.width !== undefined ? { width: input.width, height: input.height } : {}), ...(input.count !== undefined ? { count: input.count } : {}),
        ...(input.preview && input.op === "generate" ? { preview: true } : {}), ...(input.initImage ? { init_image: input.initImage, strength: input.strength } : {}), ...(input.image ? { image: input.image } : {}), ...(input.mask ? { mask: input.mask } : {}), ...(input.references && input.references.length > 0 ? { references: input.references } : {}), ...(input.region ? { region: input.region } : {}), ...(input.feather !== undefined ? { feather: input.feather } : {}),
      };
      const aborted = new Promise<never>((_, reject) => {
        const stop = () => {
          // Between steps the worker stops by itself; a worker that does not answer in ten seconds is killed and the next job starts a fresh one.
          worker.cancel(options.jobId);
          killTimer = setTimeout(() => { this.stopWorker(); }, 10_000);
          reject(new ImageError("cancelled", "Cancelled.", 499));
        };
        if (options.signal?.aborted) stop(); else options.signal?.addEventListener("abort", stop, { once: true });
      });
      aborted.catch(() => {});
      onPhase("loading", 0);
      const sent = worker.send(request, { deadlineMs: deadlineMs(input.family, input.count ?? 1), onEvent: (event) => {
        if (event.event === "phase") onPhase(event.phase, event.percent ?? 0);
        else if (event.event === "stage") options.onStage?.(event.stage, event.n ?? null, event.of ?? null);
        else if (event.event === "preview") options.onPreview?.(event.step, event.steps);
        else options.onImage?.(event.index);
      } });
      const reply = await Promise.race([sent, aborted]);
      if (!reply.ok) {
        // The worker's own words are never kept (a traceback can carry a prompt); this one line is the diagnosis: what failed, where, on which family.
        logger.appendLine(JSON.stringify({ event: "image.worker_failed", family: input.family, op: request.op, code: reply.code ?? "failed", ...(reply.diag ? { diag: reply.diag } : {}) }));
        // A worker that failed mid-picture may hold a half-built graph; start the next one from a fresh process.
        if (reply.code === "out_of_memory" || reply.code === "timeout" || reply.code === "worker_stopped") this.stopWorker();
        throw new ImageError(reply.code ?? "failed", MESSAGE_BY_CODE[reply.code ?? ""] ?? reply.error ?? "The picture could not be made.", STATUS_BY_CODE[reply.code ?? "failed"] ?? 500);
      }
      if (reply.peak_bytes && reply.peak_bytes > 0) refreshMeasuredPeakById("image-pool", reply.peak_bytes);
      this.lastSuccessAt = Date.now();
      return { seeds: reply.seeds ?? [input.seed], ms: reply.ms ?? 0, peakBytes: reply.peak_bytes ?? null, width: reply.width ?? null, height: reply.height ?? null };
    } finally {
      this.busy -= 1;
      lease?.detach();
      if (killTimer) clearTimeout(killTimer);
      if (options.signal?.aborted) rmSync(input.outDir, { recursive: true, force: true });
      if (this.worker && this.busy === 0) this.idleTimer = setTimeout(() => { log("picture worker stopped after being idle"); this.stopWorker(); }, idleMs());
    }
  }
}

export const IMAGE_POOL_PEAK_BYTES = GovernorRules.imagePoolPeakBytes;

/** Decide whether the existing picture admission has room to grow to the planned two-model pool. */
export function imagePoolGrowthFits(activeRequestPeakBytes: number, status = getGovernorStatus()): boolean {
  void activeRequestPeakBytes;
  const pool = status.loaded.find((item) => item.id === "image-pool");
  const current = pool?.peakBytes ?? 0;
  const growth = Math.max(0, GovernorRules.imagePoolPeakBytes - current);
  const loaded = status.loaded.reduce((sum, item) => sum + item.peakBytes, 0);
  return loaded + growth <= status.capBytes && status.freeMemoryBytes - growth >= status.marginBytes;
}

export const imageGen = new ImageGenService();
setImagePoolUnload(() => imageGen.stopIfIdle());

/** Whether the mflux path serves the image role on this computer: its weights are installed, so it, and not the ComfyUI checkpoint, answers. */
export function imageEngineActive(service: ImageGenService = imageGen): boolean { return service.supported() && service.hasModels(); }

/** Whether a request for a family could ever fit beside what is resident right now. A job that cannot is refused now with the numbers; one that only waits on another generator queues. */
export function memoryVerdict(peak: number): { ok: true } | { ok: false; reason: string } {
  const lowMemory = lowMemoryRefusal();
  if (lowMemory) return { ok: false, reason: lowMemory };
  const status = getGovernorStatus();
  const resident = status.loaded.filter((item) => item.kind === "resident").reduce((sum, item) => sum + item.peakBytes, 0);
  if (resident + peak > status.capBytes) return { ok: false, reason: `Pictures need about ${Math.ceil(peak / 1e9)} GB of free memory, and there is not enough right now. Close other big jobs, or try again in a few minutes.` };
  return { ok: true };
}

/** The role's state for /stack/v1/roles, derived and never stored. */
export function imageRoleState(service: ImageGenService = imageGen, now = Date.now()): RoleStateRecord {
  const since = new Date(now).toISOString();
  const status = service.status();
  if (status.state === "unsupported" || status.state === "off") return { state: "notInstalled", since, reason: imageAvailability(service.supported()).reason };
  if (status.state === "not-installed") return { state: "notInstalled", since };
  if (!service.workerAlive) return { state: "installed", since };
  const last = service.lastSuccess;
  if (last !== null && now - last <= READY_TTL_MS) return { state: "ready", since, checkedAt: new Date(last).toISOString() };
  return { state: "loaded", since };
}

export { familyInstalled };
