// TALK-06: the Stack's LivePortrait engine. It turns one portrait into still
// mouth and eye frames (a set of lip-openness and eye-openness pictures at the
// picture's own size) that a talking companion plays back in time with speech.
// Source: LivePortrait (KwaiVGI, MIT) at one pinned commit, patched at build
// to use a licence-clean face finder (Apple Vision through a small compiled
// helper, `facefind.swift`, then MediaPipe, Apache-2.0); the research-only
// face finder the project ships is never installed. Six pinned MIT weights.
//
// The runtime is one managed uv environment (torch on Apple's GPU through MPS)
// and one worker process that exists only while work does: it starts on the
// first request, keeps its models for a short idle time, then exits and gives
// its memory back. Nothing here opens a network connection, and no picture,
// ratio list or frame is logged; results wait ten minutes in memory for the
// caller to fetch, then go.
//
// Safety posture: the engine acts on the pixels it is handed and makes no
// decision about who is in them (no identity, face-matching, age or
// sexual-content feature exists here). Age and surface gates live in Home,
// which decides who may call the route and screens every picture.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { admit, release, type GovernorHandle } from "@/lib/governor";
import { heavyGate, type Lease } from "@/lib/heavyGate";
import { log } from "@/lib/log";
import { installedEnginePin, ENGINE_READY_MARKER, MANAGED_RUNTIMES, selectEngineBinary } from "@/lib/engineCatalog";
import { ensureEngine } from "@/lib/engineInstall";
import { detectHardware } from "@/lib/hardware";
import { getModel } from "@/lib/modelStore";
import { dataDir } from "@/lib/paths";
import { engineTagRoot } from "@/lib/store/layout";
import { ensureUvEnvironment, managedEnv, uvEnvironmentReady, uvVenvPath, uvVenvPython, type UvEnvironmentSpec } from "@/lib/uvEnvironment";
import { imageDimensions } from "@/media/maskStill";
import { workerHandle, type WorkerHandle, type WorkerRequest, type WorkerReply } from "@/imagetools/imageTools";
import requirementsFile from "./liveportrait.darwin-arm64.requirements.txt" with { type: "file" };
import patchFile from "./liveportrait.patch.txt" with { type: "file" };
import workerScript from "./liveportrait_worker.py" with { type: "file" };
import helperSource from "./facefind.swift" with { type: "file" };

export const LIVEPORTRAIT_NAME = "liveportrait";
export const LIVEPORTRAIT_VERSION = MANAGED_RUNTIMES.find((runtime) => runtime.name === LIVEPORTRAIT_NAME)?.version ?? "1.0.0";
/** The one upstream commit the runtime builds from (the pin in `ENGINE_BINARIES` is its source archive, by sha256). */
export const LIVEPORTRAIT_SOURCE_COMMIT = "9b294b3d0536135442ea73cb01e6cb3ca7029dd3";
/** The pinned model records the worker loads, by the name the worker uses. */
export const LIVEPORTRAIT_MODEL_IDS = {
  landmark: "liveportrait-landmark",
  appearance: "liveportrait-appearance",
  motion: "liveportrait-motion",
  generator: "liveportrait-generator",
  warping: "liveportrait-warping",
  stitching: "liveportrait-stitching",
} as const;
export type LivePortraitModelKey = keyof typeof LIVEPORTRAIT_MODEL_IDS;
/** What the worker holds at its peak, asked of the governor while it lives. Measured 2026-11-09 on the Mac Studio (Apple M5 Max): the worker's peak memory footprint (macOS `footprint`, which counts the GPU buffers) was 4.06 GB on a 1024 x 1024 picture and 4.99 GB on a 16-megapixel one (four frames each; resident size alone read 1.56 GB and 2.54 GB). 5 GiB covers the largest picture the engine accepts. */
export const LIVEPORTRAIT_PEAK_BYTES = 5 * 1_073_741_824;
export const LIVEPORTRAIT_LIMITS = { max_megapixels: 16, max_ratios_per_list: 12 } as const;
export const NO_FACE_MESSAGE = "No face was found in this picture. Choose a picture where the face is clear.";
export const TOO_LARGE_MESSAGE = `This picture is over ${LIVEPORTRAIT_LIMITS.max_megapixels} megapixels. Choose a smaller picture.`;
const MEGAPIXEL = 1_000_000;
const idleMs = (): number => Number(process.env.LIVEPORTRAIT_IDLE_MS ?? 120_000);
const DEADLINE_MS = 240_000;
const RESULT_KEEP = 6;
const RESULT_TTL_MS = 10 * 60_000;
const STATUS_BY_CODE: Record<string, number> = { too_large: 413, bad_image: 422, bad_ratio: 422, too_many_ratios: 422, no_face: 422, model_missing: 503, no_memory: 503, setup_failed: 503, unsupported: 503, engine_unavailable: 503, engine_failed: 500, cancelled: 499, failed: 500 };

/** What the build removes from the pinned source: everything the worker does not import, and every file that names the research-only face finder. */
export const LIVEPORTRAIT_PRUNE = [
  "app.py", "app_animals.py", "inference.py", "inference_animals.py", "speed.py", "assets", "pretrained_weights", ".gitignore", "readme.md", "readme_zh_cn.md", "requirements.txt", "requirements_base.txt", "requirements_macOS.txt",
  "src/gradio_pipeline.py", "src/live_portrait_pipeline.py", "src/live_portrait_pipeline_animal.py", "src/config/argument_config.py",
  "src/utils/face_analysis_diy.py", "src/utils/dependencies", "src/utils/animal_landmark_runner.py", "src/utils/video.py", "src/utils/viz.py", "src/utils/check_windows_port.py",
] as const;

/** A refusal or failure with a stable code and a status the route returns; the message says what happened and what to do. */
export class LivePortraitError extends Error {
  constructor(readonly code: string, message: string, readonly status: number = STATUS_BY_CODE[code] ?? 500) { super(message); }
}

export function livePortraitRequirementsFileFor(platform = process.platform, arch = process.arch): string | null {
  return platform === "darwin" && arch === "arm64" ? requirementsFile : null;
}
export function livePortraitRoot(): string { return engineTagRoot(LIVEPORTRAIT_NAME, LIVEPORTRAIT_VERSION); }
export function livePortraitProof(): string { return join(uvVenvPath(livePortraitRoot()), "lib", "python3.12", "site-packages", "torch", "__init__.py"); }
export function livePortraitHelperPath(): string { return join(livePortraitRoot(), "facefind"); }
export function livePortraitTmpDir(): string { return join(dataDir, "tmp", "liveportrait"); }
const patchedMarker = (): string => join(livePortraitRoot(), ".patched");
const lastRunFile = (): string => join(livePortraitRoot(), "last-run");
function spec(): UvEnvironmentSpec { return { name: LIVEPORTRAIT_NAME, version: LIVEPORTRAIT_VERSION, root: livePortraitRoot(), requirements: livePortraitRequirementsFileFor(), proof: livePortraitProof() }; }
export function livePortraitEnvironmentSpec(): UvEnvironmentSpec { return spec(); }
export function livePortraitEnvironmentReady(): boolean { return uvEnvironmentReady(spec()); }
export function livePortraitSourceReady(): boolean { return existsSync(patchedMarker()) && existsSync(join(livePortraitRoot(), "src", "utils", "face_finder.py")); }

/** The installed, verified file for one weight, or null. */
export function livePortraitModelPath(key: LivePortraitModelKey): string | null {
  const record = getModel(LIVEPORTRAIT_MODEL_IDS[key]);
  return record?.modelPath && record.verifiedAt && existsSync(record.modelPath) ? record.modelPath : null;
}

/** Applies a patch with the system `patch` (-p1) inside `root`; throws with the tool's words when it does not apply. */
async function runTool(command: string[], cwd: string, env: Record<string, string>): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", env });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${command[0]} exited ${code}: ${(err || out).trim().split("\n").slice(-3).join(" | ")}`);
}

/** Installs the pinned source (the archive's sha256 is checked), patches it, prunes it. Safe to call again: a finished build is left alone, an unfinished one is redone from the archive. */
export async function ensureLivePortraitSource(onProgress: (phase: string) => void = () => {}, signal?: AbortSignal): Promise<void> {
  if (!livePortraitRequirementsFileFor()) throw new Error(`Talking pictures are not available on ${process.platform} ${process.arch} yet.`);
  if (livePortraitSourceReady()) return;
  const pin = installedEnginePin(LIVEPORTRAIT_NAME) ?? selectEngineBinary(await detectHardware(), LIVEPORTRAIT_NAME);
  if (!pin) throw new Error("No pinned LivePortrait source exists for this computer.");
  const root = livePortraitRoot();
  onProgress("source");
  // An engine marker without our own marker means an earlier build stopped half way: extract again over it.
  rmSync(join(root, ENGINE_READY_MARKER), { force: true });
  await ensureEngine(pin, () => {}, { signal, activate: true });
  onProgress("patch");
  const patchPath = join(root, "liveportrait.patch");
  writeFileSync(patchPath, await Bun.file(patchFile).text());
  await runTool(["/usr/bin/patch", "-p1", "-s", "-i", patchPath], root, managedEnv());
  for (const entry of LIVEPORTRAIT_PRUNE) rmSync(join(root, entry), { recursive: true, force: true });
  writeFileSync(patchedMarker(), `${LIVEPORTRAIT_SOURCE_COMMIT}\n`);
}

/** Compiles the Apple Vision face-rectangle helper once (Xcode command line tools); null when this Mac cannot, and MediaPipe finds the face instead. */
export async function ensureFaceHelper(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const target = livePortraitHelperPath();
  if (existsSync(target)) return target;
  const swiftc = Bun.which("swiftc");
  if (!swiftc) return null;
  const root = livePortraitRoot();
  mkdirSync(root, { recursive: true });
  const source = join(root, "facefind.swift");
  writeFileSync(source, await Bun.file(helperSource).text());
  const cache = join(root, "swift-cache");
  mkdirSync(cache, { recursive: true });
  const child = Bun.spawn([swiftc, "-O", source, "-o", target], { stdout: "pipe", stderr: "pipe", env: { ...managedEnv(), CLANG_MODULE_CACHE_PATH: cache } });
  const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) { rmSync(target, { force: true }); log("talk frames: the Apple face helper did not compile (exit %d): %s", code, err.trim().split("\n").slice(-2).join(" | ")); return null; }
  chmodSync(target, 0o755);
  return target;
}

/** Face landmarks from the 203-point model (landmark.onnx, MIT), `[x, y]` in the returned frame's own pixels. `points` holds all 203; a group the model layout does not name yet is empty. */
export interface TalkLandmarks { outerLips: number[][]; innerLips: number[][]; nose: number[][]; contour: number[][]; points: number[][] }
export interface TalkFrame { kind: "lip" | "eye"; ratio: number; png: Uint8Array; ms: number; landmarks?: TalkLandmarks | null }
export interface TalkInput { image: Uint8Array; lip: number[]; eye: number[]; sourceScale?: number }
export interface TalkResult { width: number; height: number; sourceEye: number; sourceLip: number; sourceLandmarks?: TalkLandmarks | null; frames: TalkFrame[]; ms: number; peakBytes?: number }
export type LivePortraitState = "unsupported" | "needs-setup" | "building" | "idle" | "running";
/** One request as the worker reads it (picture and frames travel as files under the Stack's own data directory). */
export interface TalkWorkerRequest { id: string; input: string; outdir: string; lip: number[]; eye: number[]; sourceScale: number; helper: string | null; source: string; models: Record<LivePortraitModelKey, string> }
export interface TalkWorkerReply { id: string | null; ok: boolean; code?: string; error?: string; width?: number; height?: number; sourceEye?: number; sourceLip?: number; sourceLandmarks?: TalkLandmarks | null; ms?: number; peakBytes?: number; frames?: Array<{ kind: "lip" | "eye"; ratio: number; landmarks?: TalkLandmarks | null; file: string; ms: number }> }

export interface LivePortraitDeps {
  requirements: () => string | null;
  ensureSource: (onProgress: (phase: string) => void) => Promise<void>;
  ensureEnvironment: (onProgress: (phase: string) => void) => Promise<void>;
  ensureHelper: () => Promise<string | null>;
  spawn: () => Promise<WorkerHandle>;
  modelPath: (key: LivePortraitModelKey) => string | null;
  /** Holds the memory the worker may use; a string is a refusal. */
  hold: (signal?: AbortSignal) => Promise<{ release(): void } | string>;
  tmpDir: () => string;
  sourceDir: () => string;
  /** Records the time of a successful run (a timestamp only) and reads it back. */
  recordRun: (iso: string) => void;
  lastRun: () => string | null;
}

export const defaultLivePortraitDeps: LivePortraitDeps = {
  requirements: () => livePortraitRequirementsFileFor(),
  ensureSource: (onProgress) => ensureLivePortraitSource(onProgress),
  ensureEnvironment: (onProgress) => ensureUvEnvironment(spec(), onProgress),
  ensureHelper: ensureFaceHelper,
  modelPath: livePortraitModelPath,
  tmpDir: livePortraitTmpDir,
  sourceDir: livePortraitRoot,
  recordRun: (iso) => { try { writeFileSync(lastRunFile(), iso); } catch { /* the stamp is a convenience */ } },
  lastRun: () => { try { return readFileSync(lastRunFile(), "utf8").trim() || null; } catch { return null; } },
  hold: async (signal) => {
    const answer = await admit({ id: "liveportrait", kind: "jit", requestedBytes: LIVEPORTRAIT_PEAK_BYTES, pinned: true });
    let handle: GovernorHandle;
    if ("refused" in answer) return answer.reason;
    if ("queued" in answer) {
      const settled = await Promise.race([answer.admitted, new Promise<{ refused: true; reason: string }>((resolve) => { signal?.addEventListener("abort", () => resolve({ refused: true, reason: "Cancelled." }), { once: true }); })]);
      if ("refused" in settled) return settled.reason;
      handle = settled;
    } else handle = answer;
    return { release: () => release(handle) };
  },
  spawn: async () => {
    const root = livePortraitRoot();
    const script = join(root, "liveportrait_worker.py");
    writeFileSync(script, await Bun.file(workerScript).text());
    const env = managedEnv({ PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1", PYTORCH_ENABLE_MPS_FALLBACK: "1", HF_HUB_OFFLINE: "1", OMP_NUM_THREADS: "4" });
    delete env.HF_TOKEN; delete env.HUGGING_FACE_HUB_TOKEN;
    const child = Bun.spawn([process.env.LIVEPORTRAIT_PYTHON ?? uvVenvPython(root), "-I", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
    return workerHandle(child);
  },
};

/** Checks what the caller sent, before anything starts. */
export function validateTalkInput(input: TalkInput): void {
  const { max_ratios_per_list: max } = LIVEPORTRAIT_LIMITS;
  if (input.lip.length > max || input.eye.length > max) throw new LivePortraitError("too_many_ratios", `Send at most ${max} lip values and ${max} eye values.`);
  if (input.lip.length + input.eye.length === 0) throw new LivePortraitError("bad_ratio", "Send at least one lip or eye value, each from 0 to 1.");
  for (const value of [...input.lip, ...input.eye]) if (!Number.isFinite(value) || value < 0 || value > 1) throw new LivePortraitError("bad_ratio", "Lip and eye values must be numbers from 0 to 1.");
  const size = imageDimensions(input.image);
  if (!size) throw new LivePortraitError("bad_image", "This picture could not be read. Send a JPEG, PNG or WebP picture.");
  if (size.width * size.height > LIVEPORTRAIT_LIMITS.max_megapixels * MEGAPIXEL) throw new LivePortraitError("too_large", TOO_LARGE_MESSAGE);
}

export class LivePortraitService {
  private worker: WorkerHandle | null = null;
  private holder: { release(): void } | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private building: string | null = null;
  private busy = 0;
  private helper: string | null | undefined;
  constructor(private deps: LivePortraitDeps = defaultLivePortraitDeps) {}

  /** Tests only: swaps the dependencies and stops any worker the old ones started. */
  useDeps(deps: LivePortraitDeps): void { this.stopWorker(); this.deps = deps; }

  /** What Home's engine row feeds on: installed, environment ready, models verified, helper compiled, last successful run. */
  status() {
    const supported = !!this.deps.requirements();
    const models = Object.fromEntries((Object.keys(LIVEPORTRAIT_MODEL_IDS) as LivePortraitModelKey[]).map((key) => [key, this.deps.modelPath(key) !== null])) as Record<LivePortraitModelKey, boolean>;
    const state: LivePortraitState = !supported ? "unsupported" : this.building ? "building" : this.busy > 0 ? "running" : this.worker ? "idle" : "needs-setup";
    return {
      state,
      phase: this.building,
      installed: livePortraitSourceReady(),
      environmentReady: livePortraitEnvironmentReady(),
      models,
      modelsVerified: Object.values(models).every(Boolean),
      helperCompiled: this.helper !== undefined ? !!this.helper : existsSync(livePortraitHelperPath()),
      lastSuccessfulRun: this.deps.lastRun(),
      limits: LIVEPORTRAIT_LIMITS,
      reason: supported ? null : `Talking pictures are not available on ${process.platform} ${process.arch} yet.`,
    };
  }

  /** Makes the requested frames, one request at a time. Throws a LivePortraitError that says what to do. */
  run(input: TalkInput, options: { signal?: AbortSignal; onStatus?: (status: string) => void } = {}): Promise<TalkResult> {
    const next = this.chain.then(() => this.execute(input, options), () => this.execute(input, options));
    this.chain = next.catch(() => {});
    return next;
  }

  private async ensureWorker(onStatus: (status: string) => void, signal?: AbortSignal): Promise<WorkerHandle> {
    if (this.worker) return this.worker;
    if (!this.deps.requirements()) throw new LivePortraitError("unsupported", `Talking pictures are not available on ${process.platform} ${process.arch} yet.`);
    for (const key of Object.keys(LIVEPORTRAIT_MODEL_IDS) as LivePortraitModelKey[]) {
      if (!this.deps.modelPath(key)) throw new LivePortraitError("model_missing", "The talking-picture model files are not installed yet. Install them from Home's Engines page, then try again.");
    }
    onStatus("setting up talking pictures (first time only)");
    try {
      this.building = "source"; await this.deps.ensureSource((phase) => { this.building = phase; onStatus(`setting up talking pictures: ${phase}`); });
      await this.deps.ensureEnvironment((phase) => { this.building = phase; onStatus(`setting up talking pictures: ${phase}`); });
    } catch (error) {
      throw new LivePortraitError("setup_failed", `Talking pictures could not be set up: ${error instanceof Error ? error.message : String(error)}. Check this computer's internet connection and try again.`);
    } finally { this.building = null; }
    if (this.helper === undefined) this.helper = await this.deps.ensureHelper().catch(() => null);
    onStatus("making room");
    const held = await this.deps.hold(signal);
    if (typeof held === "string") throw new LivePortraitError("no_memory", `There is not enough free memory for talking pictures right now (${held}). Wait for the current job to finish, then try again.`);
    try {
      const worker = await this.deps.spawn();
      this.worker = worker; this.holder = held;
      void worker.exited.then(() => { if (this.worker === worker) this.stopWorker(); });
      return worker;
    } catch (error) {
      held.release();
      throw new LivePortraitError("failed", `Talking pictures could not start: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }

  private stopWorker(graceMs = 5_000): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const worker = this.worker; this.worker = null;
    worker?.kill(graceMs);
    this.holder?.release(); this.holder = null;
  }

  /** Stops the worker now (shutdown, or a test). */
  stop(): void { this.stopWorker(); }

  /** Stops the worker only when it is loaded and not working (the memory watchdog's way to give memory back); true when it stopped one. */
  stopIfIdle(): boolean {
    if (!this.worker || this.busy > 0) return false;
    this.stopWorker();
    return true;
  }

  private async execute(input: TalkInput, options: { signal?: AbortSignal; onStatus?: (status: string) => void }): Promise<TalkResult> {
    const onStatus = options.onStatus ?? (() => {});
    if (options.signal?.aborted) throw new LivePortraitError("cancelled", "Cancelled.");
    validateTalkInput(input);
    this.busy += 1;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const dir = join(this.deps.tmpDir(), crypto.randomUUID());
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let lease: Lease | undefined;
    try {
      const worker = await this.ensureWorker(onStatus, options.signal);
      lease = heavyGate.attach({ role: "liveportrait", worker: worker.pausable });
      const inputPath = join(dir, "input");
      writeFileSync(inputPath, input.image);
      const models = Object.fromEntries((Object.keys(LIVEPORTRAIT_MODEL_IDS) as LivePortraitModelKey[]).map((key) => [key, this.deps.modelPath(key)!])) as Record<LivePortraitModelKey, string>;
      const request: TalkWorkerRequest = { id: crypto.randomUUID(), input: inputPath, outdir: dir, lip: input.lip, eye: input.eye, sourceScale: input.sourceScale ?? 2.3, helper: this.helper ?? null, source: this.deps.sourceDir(), models };
      onStatus("making the frames");
      const aborted = new Promise<never>((_, reject) => options.signal?.addEventListener("abort", () => { this.stopWorker(2_000); reject(new LivePortraitError("cancelled", "Cancelled.")); }, { once: true }));
      const reply = await Promise.race([worker.send(request as unknown as WorkerRequest, DEADLINE_MS) as Promise<WorkerReply & TalkWorkerReply>, aborted]);
      if (!reply.ok) throw new LivePortraitError(reply.code ?? "failed", reply.error ?? "The picture could not be processed.");
      const frames: TalkFrame[] = (reply.frames ?? []).map((frame) => ({ kind: frame.kind, ratio: frame.ratio, png: new Uint8Array(readFileSync(frame.file)), ms: frame.ms, landmarks: frame.landmarks ?? null }));
      this.deps.recordRun(new Date().toISOString());
      return { width: reply.width ?? 0, height: reply.height ?? 0, sourceEye: reply.sourceEye ?? 0, sourceLip: reply.sourceLip ?? 0, sourceLandmarks: reply.sourceLandmarks ?? null, frames, ms: reply.ms ?? 0, ...(reply.peakBytes ? { peakBytes: reply.peakBytes } : {}) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
      lease?.detach();
      this.busy -= 1;
      if (this.worker && this.busy === 0) this.idleTimer = setTimeout(() => { log("talk frames worker stopped after being idle"); this.stopWorker(); }, idleMs());
    }
  }
}

export const livePortrait = new LivePortraitService();

/** Removes any picture a crash left in the temporary folder; called once when the Stack starts. */
export function sweepLivePortraitTmp(dir = livePortraitTmpDir()): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* nothing there */ }
}

/** Results wait ten minutes in memory (newest six) and are never written to disk or logged. */
const results = new Map<string, { result: TalkResult; at: number }>();
export function keepTalkResult(id: string, result: TalkResult, now = Date.now()): void {
  for (const [key, value] of results) if (now - value.at > RESULT_TTL_MS) results.delete(key);
  results.set(id, { result, at: now });
  while (results.size > RESULT_KEEP) results.delete(results.keys().next().value as string);
}
export function takeTalkResult(id: string, now = Date.now()): TalkResult | null {
  const kept = results.get(id);
  if (!kept) return null;
  if (now - kept.at > RESULT_TTL_MS) { results.delete(id); return null; }
  return kept.result;
}
export function dropTalkResults(): void { results.clear(); }

/** The request bytes wait here between the route and the job runner, so a picture never sits in a job record or on the event feed. */
const pending = new Map<string, TalkInput>();
export function stashTalkInput(token: string, input: TalkInput): void { pending.set(token, input); }
export function unstashTalkInput(token: string): TalkInput | null { const input = pending.get(token) ?? null; pending.delete(token); return input; }
