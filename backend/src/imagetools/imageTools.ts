// IMAGETOOLS-01: the Stack's image tools service, the non-generative edits
// the canvas editor needs on a picture the person already has: remove the
// background, erase an object under a painted mask (inpainting), upscale,
// resize. The model for each is a small ONNX file the Stack pins and
// verifies; the runtime is one managed Python environment (onnxruntime,
// numpy, pillow, opencv; the same uv builder as the voice engines and the
// search sidecar) and one worker process that exists only while work
// does: it starts on the first request, keeps its model for a short idle
// time (an erase session paints many strokes), then exits and gives its
// memory back. On a Mac the background is cut by Apple's on-device
// foreground finder through a 70 KB helper the Stack compiles once from
// source (`fgmask.swift`); where that is not possible the ONNX model does
// it. Nothing here opens a network connection, and no picture, mask or
// result is logged or kept beyond the request (results wait a few minutes
// in memory for the caller to fetch, then go).
//
// Safety posture: the tools act on the pixels they are handed and make no
// decision about who is in them (no face, identity or age feature exists
// here). Age and surface gates live in Home, which decides who may call
// the route at all. Every output is a fresh PNG with no EXIF, GPS or colour
// profile.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { admit, release, type GovernorHandle } from "@/lib/governor";
import { log } from "@/lib/log";
import { MANAGED_RUNTIMES } from "@/lib/engineCatalog";
import { dataDir } from "@/lib/paths";
import { getModel } from "@/lib/modelStore";
import { engineTagRoot } from "@/lib/store/layout";
import { ensureUvEnvironment, managedEnv, uvEnvironmentReady, uvVenvPath, uvVenvPython, type UvEnvironmentSpec } from "@/lib/uvEnvironment";
import darwinArm64Requirements from "./image-tools.darwin-arm64.requirements.txt" with { type: "file" };
import workerScript from "./image_tools_worker.py" with { type: "file" };
import helperSource from "./fgmask.swift" with { type: "file" };

export const IMAGE_TOOLS_NAME = "image-tools";
export const IMAGE_TOOLS_VERSION = MANAGED_RUNTIMES.find((runtime) => runtime.name === IMAGE_TOOLS_NAME)?.version ?? "1.0.0";
export const IMAGE_TOOLS_OPERATIONS = ["remove_background", "erase", "upscale", "resize"] as const;
export type ImageToolOperation = typeof IMAGE_TOOLS_OPERATIONS[number];

/** The pinned model records the worker loads, by the name the worker uses. */
export const IMAGE_TOOL_MODEL_IDS = { isnet: "image-tool-isnet-general", lama: "image-tool-lama-big", esrgan: "image-tool-realesrgan-general-x4v3" } as const;
/** What the worker holds at its largest (IS-Net on CPU peaked at 3.2 GB in the bench, plus the decoded picture), asked of the governor while the worker lives. */
export const IMAGE_TOOLS_ESTIMATED_BYTES = 4 * 1_073_741_824;
/** Megapixels each tool accepts; the worker enforces them and says them in words. Mirrored here so the status route and the docs state them once. */
export const IMAGE_TOOL_LIMITS = { remove_background_in: 25, erase_in: 25, upscale_in: 6, upscale_out: 36, resize_out: 36 } as const;
const idleMs = (): number => Number(process.env.IMAGE_TOOLS_IDLE_MS ?? 120_000);
const DEADLINE_MS: Record<ImageToolOperation, number> = { remove_background: 120_000, erase: 120_000, upscale: 300_000, resize: 60_000 };
const RESULT_KEEP = 6;
const RESULT_TTL_MS = 10 * 60_000;

/** A refusal or failure with a stable code and a status the route returns; the message says what happened and what to do. */
export class ImageToolError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}
const STATUS_BY_CODE: Record<string, number> = { too_large: 413, bad_scale: 422, bad_operation: 422, mask_required: 422, mask_empty: 422, mask_too_big: 422, size_required: 422, no_subject: 422, model_missing: 503, engine_unavailable: 422, engine_failed: 500, out_of_memory: 507, failed: 500 };

export function imageToolsRequirementsFileFor(platform = process.platform, arch = process.arch): string | null {
  if (platform === "darwin" && arch === "arm64") return darwinArm64Requirements;
  return null;
}
export function imageToolsRoot(): string { return engineTagRoot(IMAGE_TOOLS_NAME, IMAGE_TOOLS_VERSION); }
export function imageToolsProof(): string { return join(uvVenvPath(imageToolsRoot()), "lib", "python3.12", "site-packages", "onnxruntime", "__init__.py"); }
export function imageToolsHelperPath(): string { return join(imageToolsRoot(), "fgmask"); }
export function imageToolsTmpDir(): string { return join(dataDir, "tmp", "imagetools"); }
function spec(): UvEnvironmentSpec { return { name: IMAGE_TOOLS_NAME, version: IMAGE_TOOLS_VERSION, root: imageToolsRoot(), requirements: imageToolsRequirementsFileFor(), proof: imageToolsProof() }; }

/** The installed, verified model file for one tool, or null. */
export function imageToolModelPath(id: string): string | null {
  const record = getModel(id);
  return record?.modelPath && record.verifiedAt && existsSync(record.modelPath) ? record.modelPath : null;
}

/** Compiles Apple's foreground finder helper once, when the Mac has `swiftc` (the Xcode command line tools); null elsewhere, and the ONNX model is used. */
export async function ensureHelper(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const target = imageToolsHelperPath();
  if (existsSync(target)) return target;
  const swiftc = Bun.which("swiftc");
  if (!swiftc) return null;
  mkdirSync(imageToolsRoot(), { recursive: true });
  const source = join(imageToolsRoot(), "fgmask.swift");
  writeFileSync(source, await Bun.file(helperSource).text());
  const cache = join(imageToolsRoot(), "swift-cache");
  mkdirSync(cache, { recursive: true });
  const child = Bun.spawn([swiftc, "-O", source, "-o", target], { stdout: "pipe", stderr: "pipe", env: { ...managedEnv(), CLANG_MODULE_CACHE_PATH: cache } });
  const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) { rmSync(target, { force: true }); log("image tools: the Apple foreground helper did not compile (exit %d): %s", code, err.trim().split("\n").slice(-2).join(" | ")); return null; }
  chmodSync(target, 0o755);
  return target;
}

export interface WorkerRequest { id: string; op: ImageToolOperation; input: string; output: string; mask?: string; params: Record<string, unknown>; models: Record<string, string | null>; helper: string | null; }
export interface WorkerReply { id: string | null; ok: boolean; code?: string; error?: string; width?: number; height?: number; engine?: string; model?: string; ms?: number; crop_px?: number; }
export interface WorkerHandle { send(request: WorkerRequest, deadlineMs: number): Promise<WorkerReply>; kill(): void; exited: Promise<number>; }

export interface ImageToolsDeps {
  requirements: () => string | null;
  ensureEnvironment: (onProgress: (phase: string) => void) => Promise<void>;
  ensureHelper: () => Promise<string | null>;
  spawn: () => Promise<WorkerHandle>;
  modelPath: (id: string) => string | null;
  /** Holds the memory the worker may use; a string is a refusal. */
  hold: (signal?: AbortSignal) => Promise<{ release(): void } | string>;
  tmpDir: () => string;
}

export const defaultImageToolsDeps: ImageToolsDeps = {
  requirements: () => imageToolsRequirementsFileFor(),
  ensureEnvironment: (onProgress) => ensureUvEnvironment(spec(), onProgress),
  ensureHelper,
  modelPath: imageToolModelPath,
  tmpDir: imageToolsTmpDir,
  hold: async (signal) => {
    const request = { id: "image-tools", kind: "jit" as const, requestedBytes: IMAGE_TOOLS_ESTIMATED_BYTES, pinned: true };
    const answer = await admit(request);
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
    const root = imageToolsRoot();
    const script = join(root, "image_tools_worker.py");
    writeFileSync(script, await Bun.file(workerScript).text());
    const env = managedEnv({ PYTHONUNBUFFERED: "1", HF_HUB_OFFLINE: "1", PYTHONDONTWRITEBYTECODE: "1" });
    delete env.HF_TOKEN; delete env.HUGGING_FACE_HUB_TOKEN;
    const child = Bun.spawn([process.env.IMAGE_TOOLS_PYTHON ?? uvVenvPython(root), "-I", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
    return workerHandle(child);
  },
};

/** Wraps a spawned worker in the one-request-at-a-time line protocol. */
export function workerHandle(child: { stdin: { write(data: string): unknown; flush?(): unknown }; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): void }): WorkerHandle {
  const waiting = new Map<string, (reply: WorkerReply) => void>();
  let ready: () => void = () => {};
  const started = new Promise<void>((resolve) => { ready = resolve; });
  let stderrTail = "";
  void (async () => { for await (const chunk of child.stderr as unknown as AsyncIterable<Uint8Array>) stderrTail = (stderrTail + new TextDecoder().decode(chunk)).slice(-800); })().catch(() => {});
  void (async () => {
    let buffer = "";
    for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>) {
      buffer += new TextDecoder().decode(chunk);
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (!line.startsWith("{")) continue;
        try { const reply = JSON.parse(line) as WorkerReply & { ready?: boolean }; if (reply.ready) ready(); else if (reply.id && waiting.get(reply.id)) waiting.get(reply.id)!(reply); } catch { /* not a reply */ }
      }
    }
  })().catch(() => {});
  const exited = child.exited.then((code) => { for (const [id, resolve] of waiting) resolve({ id, ok: false, code: "worker_stopped", error: `The image tool stopped (${stderrTail.trim().split("\n").slice(-1)[0] ?? `exit ${code}`}). Try again.` }); waiting.clear(); return code; });
  return {
    exited,
    kill: () => { try { child.kill(); } catch { /* already gone */ } },
    send: async (request, deadlineMs) => {
      await Promise.race([started, exited.then(() => {})]);
      return await new Promise<WorkerReply>((resolve) => {
        const timer = setTimeout(() => { waiting.delete(request.id); try { child.kill(); } catch { /* gone */ } resolve({ id: request.id, ok: false, code: "failed", error: "The picture took too long to process and was stopped. Try a smaller picture." }); }, deadlineMs);
        waiting.set(request.id, (reply) => { clearTimeout(timer); waiting.delete(request.id); resolve(reply); });
        child.stdin.write(`${JSON.stringify(request)}\n`); child.stdin.flush?.();
      });
    },
  };
}

export interface ImageToolInput { operation: ImageToolOperation; image: Uint8Array; mask?: Uint8Array; params?: Record<string, unknown>; }
export interface ImageToolResult { png: Uint8Array; width: number; height: number; engine: string; model: string; ms: number; operation: ImageToolOperation; }
export type ImageToolsState = "unsupported" | "needs-setup" | "building" | "idle" | "running";

export class ImageToolsService {
  private worker: WorkerHandle | null = null;
  private holder: { release(): void } | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private building: string | null = null;
  private busy = 0;
  private helper: string | null | undefined;
  constructor(private readonly deps: ImageToolsDeps = defaultImageToolsDeps) {}

  status(): { state: ImageToolsState; phase: string | null; vision: boolean; models: Record<string, boolean>; limits: typeof IMAGE_TOOL_LIMITS; operations: ImageToolOperation[]; reason: string | null } {
    const supported = !!this.deps.requirements();
    const models = Object.fromEntries(Object.entries(IMAGE_TOOL_MODEL_IDS).map(([name, id]) => [name, this.deps.modelPath(id) !== null]));
    const state: ImageToolsState = !supported ? "unsupported" : this.building ? "building" : this.busy > 0 ? "running" : this.worker ? "idle" : "needs-setup";
    return { state, phase: this.building, vision: !!this.helper, models, limits: IMAGE_TOOL_LIMITS, operations: [...IMAGE_TOOLS_OPERATIONS], reason: supported ? null : `The image tools are not available on ${process.platform} ${process.arch} yet.` };
  }

  /** Runs one edit, one at a time. Throws an ImageToolError that says what to do. */
  run(input: ImageToolInput, options: { signal?: AbortSignal; onStatus?: (status: string) => void } = {}): Promise<ImageToolResult> {
    const next = this.chain.then(() => this.execute(input, options), () => this.execute(input, options));
    this.chain = next.catch(() => {});
    return next;
  }

  private async ensureWorker(onStatus: (status: string) => void, signal?: AbortSignal): Promise<WorkerHandle> {
    if (this.worker) return this.worker;
    if (!this.deps.requirements()) throw new ImageToolError("unsupported", `The image tools are not available on ${process.platform} ${process.arch} yet.`, 503);
    onStatus("setting up the image tools (first time only)");
    try {
      await this.deps.ensureEnvironment((phase) => { this.building = phase; onStatus(`setting up the image tools: ${phase}`); });
    } catch (error) {
      throw new ImageToolError("setup_failed", `The image tools could not be set up: ${error instanceof Error ? error.message : String(error)}. Check this computer's internet connection and try again.`, 503);
    } finally { this.building = null; }
    if (this.helper === undefined) this.helper = await this.deps.ensureHelper().catch(() => null);
    onStatus("making room");
    const held = await this.deps.hold(signal);
    if (typeof held === "string") throw new ImageToolError("no_memory", `There is not enough free memory for the image tools right now (${held}). Close something heavy or wait for a render to finish, then try again.`, 503);
    try {
      const worker = await this.deps.spawn();
      this.worker = worker; this.holder = held;
      void worker.exited.then(() => { if (this.worker === worker) this.stopWorker(); });
      return worker;
    } catch (error) {
      held.release();
      throw new ImageToolError("failed", `The image tools could not start: ${error instanceof Error ? error.message : String(error)}.`, 500);
    }
  }

  private stopWorker(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const worker = this.worker; this.worker = null;
    worker?.kill();
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

  private async execute(input: ImageToolInput, options: { signal?: AbortSignal; onStatus?: (status: string) => void }): Promise<ImageToolResult> {
    const onStatus = options.onStatus ?? (() => {});
    if (options.signal?.aborted) throw new ImageToolError("cancelled", "Cancelled.", 499);
    if (!IMAGE_TOOLS_OPERATIONS.includes(input.operation)) throw new ImageToolError("bad_operation", `The operation must be one of ${IMAGE_TOOLS_OPERATIONS.join(", ")}.`, 422);
    this.busy += 1;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const dir = this.deps.tmpDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stem = join(dir, crypto.randomUUID());
    const files = [`${stem}.in`, `${stem}.mask`, `${stem}.out.png`, `${stem}.out.png.prepared.png`];
    try {
      const worker = await this.ensureWorker(onStatus, options.signal);
      const needed = input.operation === "erase" ? ["lama"] : input.operation === "upscale" ? ["esrgan"] : input.operation === "remove_background" ? ["isnet"] : [];
      const models = Object.fromEntries(Object.entries(IMAGE_TOOL_MODEL_IDS).map(([name, id]) => [name, this.deps.modelPath(id)]));
      for (const name of needed) {
        // Apple's finder needs no model; the ONNX one is the fallback and is required only when no helper exists or the engine is forced.
        if (name === "isnet" && this.helper && (input.params?.engine ?? "auto") !== "isnet") continue;
        if (!models[name]) throw new ImageToolError("model_missing", `The ${name === "lama" ? "erase" : name === "esrgan" ? "upscale" : "background"} model is not installed yet. Install the image tools from Home's Engines page, then try again.`, 503);
      }
      writeFileSync(files[0]!, input.image);
      if (input.mask) writeFileSync(files[1]!, input.mask);
      onStatus("working on the picture");
      const aborted = new Promise<never>((_, reject) => options.signal?.addEventListener("abort", () => { this.stopWorker(); reject(new ImageToolError("cancelled", "Cancelled.", 499)); }, { once: true }));
      const reply = await Promise.race([worker.send({ id: crypto.randomUUID(), op: input.operation, input: files[0]!, output: files[2]!, ...(input.mask ? { mask: files[1]! } : {}), params: input.params ?? {}, models, helper: this.helper ?? null }, DEADLINE_MS[input.operation]), aborted]);
      if (!reply.ok) throw new ImageToolError(reply.code ?? "failed", reply.error ?? "The picture could not be processed.", STATUS_BY_CODE[reply.code ?? "failed"] ?? 500);
      const png = new Uint8Array(readFileSync(files[2]!));
      return { png, width: reply.width ?? 0, height: reply.height ?? 0, engine: reply.engine ?? "unknown", model: reply.model ?? "unknown", ms: reply.ms ?? 0, operation: input.operation };
    } finally {
      for (const file of files) rmSync(file, { force: true });
      this.busy -= 1;
      if (this.worker && this.busy === 0) this.idleTimer = setTimeout(() => { log("image tools worker stopped after being idle"); this.stopWorker(); }, idleMs());
    }
  }
}

export const imageTools = new ImageToolsService();

/** Removes any picture a crash left in the temporary folder; called once when the Stack starts. */
export function sweepImageToolsTmp(dir = imageToolsTmpDir()): void {
  try { for (const name of readdirSync(dir)) rmSync(join(dir, name), { force: true, recursive: true }); } catch { /* nothing there */ }
}

/** Results wait a few minutes in memory for the caller to fetch, newest six, and are never written to disk or logged. */
const results = new Map<string, { result: ImageToolResult; at: number }>();
export function keepResult(id: string, result: ImageToolResult): void {
  const now = Date.now();
  for (const [key, value] of results) if (now - value.at > RESULT_TTL_MS) results.delete(key);
  results.set(id, { result, at: now });
  while (results.size > RESULT_KEEP) results.delete(results.keys().next().value as string);
}
export function takeResult(id: string): ImageToolResult | null { return results.get(id)?.result ?? null; }
export function dropResult(id: string): void { results.delete(id); }

/** The request bytes wait here between the route and the job runner, so a picture never sits in a job record or on the event feed. */
const pending = new Map<string, ImageToolInput>();
export function stashInput(token: string, input: ImageToolInput): void { pending.set(token, input); }
export function unstashInput(token: string): ImageToolInput | null { const input = pending.get(token) ?? null; pending.delete(token); return input; }
