// LOOK-01 step 3a: the Stack's fast Look. One JPEG in, a LookResult out (spec look-result schema), nothing kept.
//
// A separate worker process in the managed image-tools environment (onnxruntime, numpy, opencv; no new
// dependency) runs YOLOX-nano on the picture. The picture goes to it over stdin and the answer comes back over
// stdout, so no picture is ever written to disk (unlike the image tools' file protocol). The worker holds a small
// governor admission while it lives, is paused by the heavy gate while chat works, and is stopped after
// LOOK_IDLE_MS without a request. No log line carries a label, tag, colour or box: counts and milliseconds only.
// There is no way to fetch a look by id (Robot vision R1): the caller gets the answer to its own request.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { admit, release, type GovernorHandle } from "@/lib/governor";
import { heavyGate, PausableProcess, type Lease, type PausableWorker } from "@/lib/heavyGate";
import { log } from "@/lib/log";
import { getModel } from "@/lib/modelStore";
import { ensureUvEnvironment, managedEnv, uvVenvPython } from "@/lib/uvEnvironment";
import { imageToolsEnvironmentSpec, imageToolsRequirementsFileFor, imageToolsRoot, LOOK_MODEL_ID } from "@/imagetools/imageTools";
import workerScript from "./look_worker.py" with { type: "file" };
import coreScript from "./look_core.py" with { type: "file" };
import { LOOK_TRACK_TTL_S, LookTracker, type LookDetection, type LookObject } from "./lookTracker";

export { LOOK_TRACK_TTL_S } from "./lookTracker";
export const LOOK_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const LOOK_RATE_PER_MINUTE = 12;
/** What the worker may use while it lives: the 3.7 MB model plus onnxruntime and the decoded picture (measured near 120 MB). */
export const LOOK_ESTIMATED_BYTES = 600_000_000;
const idleMs = (): number => Number(process.env.LOOK_IDLE_MS ?? 120_000);
const MODEL_MISSING = "The Look part is not installed yet. Install it from Home's Engines page, then try again.";

export type LookErrorCode = "too_large" | "not_jpeg" | "too_fast" | "detail_unavailable" | "model_missing" | "no_memory" | "unsupported" | "setup_failed" | "failed";
/** A refusal with a stable code and the status the route returns; the message says what happened and what to do. */
export class LookError extends Error {
  constructor(readonly code: LookErrorCode, message: string, readonly status: number) { super(message); }
}

export interface LookResult {
  objects: LookObject[];
  scene: { light: "dark" | "dim" | "bright"; colours: string[]; tags: { label: string; score: number }[] };
  cost: { ms: number; tier: "fast" };
  expires_in_s: number;
}

export interface WorkerReply { ok: boolean; code?: string; detections?: LookDetection[]; light?: string; colours?: string[]; tags?: { label: string; score: number }[]; ms?: number }
export interface LookWorker { request(modelPath: string, jpeg: Uint8Array): Promise<WorkerReply>; kill(): void; exited: Promise<number>; pausable?: PausableWorker }

export interface LookDeps {
  supported: () => boolean;
  ensureEnvironment: () => Promise<void>;
  modelPath: () => string | null;
  /** Holds the memory the worker may use; a string is a refusal. */
  hold: (signal?: AbortSignal) => Promise<{ release(): void } | string>;
  spawn: () => Promise<LookWorker>;
  now: () => number;
  log: (message: string, ...values: unknown[]) => void;
}

const jpegLooksComplete = (jpeg: Uint8Array): boolean => jpeg.length >= 4 && jpeg[0] === 0xff && jpeg[1] === 0xd8 && jpeg[jpeg.length - 2] === 0xff && jpeg[jpeg.length - 1] === 0xd9;

export class LookService {
  private worker: LookWorker | null = null;
  private holder: { release(): void } | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private building = false;
  private busy = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly tracker = new LookTracker();
  private readonly requestTimes = new Map<string, number[]>();

  constructor(private readonly deps: LookDeps = defaultLookDeps) {}

  status(): { state: "unsupported" | "needs-setup" | "building" | "idle" | "running"; models: { yolox_nano: boolean }; reason: string | null } {
    const supported = this.deps.supported();
    const state = !supported ? "unsupported" : this.building ? "building" : this.busy > 0 ? "running" : this.worker ? "idle" : "needs-setup";
    return { state, models: { yolox_nano: this.deps.modelPath() !== null }, reason: supported ? null : `Look is not available on ${process.platform} ${process.arch} yet.` };
  }

  /** Looks at one picture. `source` keys the short memory of what that camera has seen; detail "detailed" is not built yet. */
  look(source: string, jpeg: Uint8Array, detail: "fast" | "detailed" = "fast", signal?: AbortSignal): Promise<LookResult> {
    if (detail === "detailed") throw new LookError("detail_unavailable", "The detailed look is not available yet. Ask for detail=fast.", 422);
    if (jpeg.byteLength > LOOK_MAX_IMAGE_BYTES) throw new LookError("too_large", "The picture must be 2 MB or smaller. Send a smaller JPEG.", 413);
    if (!jpegLooksComplete(jpeg)) throw new LookError("not_jpeg", "Send one complete JPEG picture.", 415);
    this.checkRate(source);
    const next = this.chain.then(() => this.execute(source, jpeg, signal), () => this.execute(source, jpeg, signal));
    this.chain = next.catch(() => {});
    return next;
  }

  /** Stops the worker now (shutdown, or a test). */
  stop(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const worker = this.worker;
    this.worker = null;
    worker?.kill();
    this.holder?.release();
    this.holder = null;
  }

  /** Stops the worker only when it is loaded and not working (the memory watchdog's way to give memory back); true when it stopped one. */
  stopIfIdle(): boolean {
    if (!this.worker || this.busy > 0) return false;
    this.stop();
    return true;
  }

  private checkRate(source: string): void {
    const now = this.deps.now();
    const recent = (this.requestTimes.get(source) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= LOOK_RATE_PER_MINUTE) throw new LookError("too_fast", `Look takes at most ${LOOK_RATE_PER_MINUTE} pictures a minute from one source. Wait a moment and try again.`, 429);
    recent.push(now);
    this.requestTimes.set(source, recent);
    for (const [id, times] of this.requestTimes) if (times.every((at) => now - at >= 60_000)) this.requestTimes.delete(id);
  }

  private async ensureWorker(signal?: AbortSignal): Promise<LookWorker> {
    if (this.worker) return this.worker;
    if (!this.deps.supported()) throw new LookError("unsupported", `Look is not available on ${process.platform} ${process.arch} yet.`, 503);
    this.building = true;
    try { await this.deps.ensureEnvironment(); }
    catch (error) { throw new LookError("setup_failed", `Look could not be set up: ${error instanceof Error ? error.message : String(error)}. Check this computer's internet connection and try again.`, 503); }
    finally { this.building = false; }
    const held = await this.deps.hold(signal);
    if (typeof held === "string") throw new LookError("no_memory", `There is not enough free memory for Look right now (${held}). Close something heavy or wait, then try again.`, 503);
    try {
      const worker = await this.deps.spawn();
      this.worker = worker;
      this.holder = held;
      void worker.exited.then(() => { if (this.worker === worker) this.stop(); });
      return worker;
    } catch (error) {
      held.release();
      throw new LookError("failed", `Look could not start: ${error instanceof Error ? error.message : String(error)}.`, 500);
    }
  }

  private async execute(source: string, jpeg: Uint8Array, signal?: AbortSignal): Promise<LookResult> {
    if (signal?.aborted) throw new LookError("failed", "Cancelled.", 499);
    this.busy += 1;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    let lease: Lease | undefined;
    try {
      const model = this.deps.modelPath();
      if (!model) throw new LookError("model_missing", MODEL_MISSING, 503);
      const worker = await this.ensureWorker(signal);
      if (worker.pausable) lease = heavyGate.attach({ role: "look", worker: worker.pausable });
      const reply = await worker.request(model, jpeg);
      if (!reply.ok || !reply.detections || !reply.tags) {
        throw new LookError("failed", reply.code === "not_jpeg" ? "That is not a picture Look can read. Send a complete JPEG." : "Look could not read this picture. Try another one.", reply.code === "not_jpeg" ? 415 : 500);
      }
      const objects = this.tracker.update(source, reply.detections, this.deps.now());
      const ms = reply.ms ?? 0;
      this.deps.log("look: %d objects in %d ms", objects.length, Math.round(ms));
      return {
        objects,
        scene: {
          light: (reply.light as LookResult["scene"]["light"] | undefined) ?? "bright",
          colours: reply.colours ?? [],
          tags: [...objects.map((object) => ({ label: object.label, score: object.score })), ...reply.tags],
        },
        cost: { ms, tier: "fast" },
        expires_in_s: LOOK_TRACK_TTL_S,
      };
    } finally {
      lease?.detach();
      this.busy -= 1;
      if (this.worker && this.busy === 0) this.idleTimer = setTimeout(() => { this.deps.log("look worker stopped after being idle"); this.stop(); }, idleMs());
    }
  }
}

/** Takes the memory the worker may use from the governor; a string is the reason it was refused. */
async function holdMemory(signal?: AbortSignal): Promise<{ release(): void } | string> {
  const answer = await admit({ id: "look", kind: "jit", requestedBytes: LOOK_ESTIMATED_BYTES, pinned: true });
  if ("refused" in answer) return answer.reason;
  let handle: GovernorHandle;
  if ("queued" in answer) {
    const settled = await Promise.race([answer.admitted, new Promise<{ refused: true; reason: string }>((resolve) => { signal?.addEventListener("abort", () => resolve({ refused: true, reason: "Cancelled." }), { once: true }); })]);
    if ("refused" in settled) return settled.reason;
    handle = settled;
  } else handle = answer;
  return { release: () => release(handle) };
}

/** Wraps a spawned worker in the length-prefixed binary protocol, one request at a time. */
export function workerHandle(child: { pid?: number; stdin: { write(data: Uint8Array): unknown; flush?(): unknown }; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): void }): LookWorker {
  const waiting: ((reply: WorkerReply) => void)[] = [];
  void (async () => { for await (const _ of child.stderr as unknown as AsyncIterable<Uint8Array>) { /* the worker says nothing worth keeping */ } })().catch(() => {});
  void (async () => {
    let buffer = new Uint8Array(0);
    for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>) {
      const joined = new Uint8Array(buffer.length + chunk.length);
      joined.set(buffer);
      joined.set(chunk, buffer.length);
      buffer = joined;
      while (buffer.length >= 4) {
        const length = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0);
        if (buffer.length < 4 + length) break;
        const text = new TextDecoder().decode(buffer.slice(4, 4 + length));
        buffer = buffer.slice(4 + length);
        try { waiting.shift()?.(JSON.parse(text) as WorkerReply); } catch { waiting.shift()?.({ ok: false, code: "failed" }); }
      }
    }
  })().catch(() => {});
  const exited = child.exited.then((code) => { for (const resolve of waiting.splice(0)) resolve({ ok: false, code: "failed" }); return code; });
  const pausable = new PausableProcess(child.pid ?? null, child.exited);
  return {
    exited,
    pausable,
    kill: () => pausable.killAfterResume(() => { try { child.kill(); } catch { /* already gone */ } }),
    request: (modelPath, jpeg) => new Promise<WorkerReply>((resolve) => {
      waiting.push(resolve);
      const header = new TextEncoder().encode(JSON.stringify({ model: modelPath }));
      const frame = new Uint8Array(8 + header.length + jpeg.length);
      const view = new DataView(frame.buffer);
      view.setUint32(0, header.length);
      view.setUint32(4, jpeg.length);
      frame.set(header, 8);
      frame.set(jpeg, 8 + header.length);
      child.stdin.write(frame);
      child.stdin.flush?.();
    }),
  };
}

export const defaultLookDeps: LookDeps = {
  supported: () => imageToolsRequirementsFileFor() !== null,
  ensureEnvironment: () => ensureUvEnvironment(imageToolsEnvironmentSpec(), () => {}),
  modelPath: () => {
    const record = getModel(LOOK_MODEL_ID);
    return record?.modelPath && record.verifiedAt && existsSync(record.modelPath) ? record.modelPath : null;
  },
  hold: holdMemory,
  spawn: async () => {
    const root = imageToolsRoot();
    // The worker's code (not any picture) goes next to the image tools' own worker, as that one does.
    writeFileSync(join(root, "look_worker.py"), await Bun.file(workerScript).text());
    writeFileSync(join(root, "look_core.py"), await Bun.file(coreScript).text());
    const env = managedEnv({ PYTHONUNBUFFERED: "1", HF_HUB_OFFLINE: "1", PYTHONDONTWRITEBYTECODE: "1" });
    delete env.HF_TOKEN; delete env.HUGGING_FACE_HUB_TOKEN;
    const child = Bun.spawn([process.env.IMAGE_TOOLS_PYTHON ?? uvVenvPython(root), "-I", join(root, "look_worker.py")], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
    return workerHandle(child);
  },
  now: () => Date.now(),
  log,
};

export const lookService = new LookService();
