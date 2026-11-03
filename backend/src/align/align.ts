import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { engineTagRoot } from "@/lib/store/layout";
import { dataDir } from "@/lib/paths";
import { getModel } from "@/lib/modelStore";
import { STACK_ALIGN_MODEL, STACK_ALIGN_MODEL_ID } from "@/lib/modelCatalog";
import { ensureUvEnvironment, managedEnv, uvEnvironmentReady, uvVenvPath, uvVenvPython, type UvEnvironmentSpec } from "@/lib/uvEnvironment";
import { heavyGate, PausableProcess, type PausableWorker } from "@/lib/heavyGate";
import { TreeSnapshot } from "@/lib/processTree";
import { registerOwned } from "@/lib/ownedProcesses";
import { forgetLoadedItem, setIdleTtlSeconds, setWarmWorkerUnload } from "@/lib/governor";
import { log } from "@/lib/log";
import workerAsset from "./align_worker.py" with { type: "file" };
import requirements from "./align.darwin-arm64.requirements.txt" with { type: "file" };

export const ALIGN_NAME = "align";
export const ALIGN_VERSION = "1.0.0";
/** Footprint peak of the worker, measured on the Studio (Apple M5 Max, 2026-11-03, /usr/bin/time -l, a cold worker with the 1.26 GB model loaded)
 * on a real sung song looped to length: 40 s 3.80 GB, 60 s 4.67 GB, 120 s 7.37 GB, 240 s 11.04 GB. The model attends over the whole song, so memory grows with
 * its length; admission uses the longest file the route accepts (240 s) so a long song can never outgrow what was reserved. */
export const ALIGN_PEAK_BYTES = 11_100_000_000;
/** Admission size for a window of `seconds`: an upper-bound line through the measured peaks above (2.1 GB plus 0.046 GB per second), never below the 40 s peak and never above the full-file figure. */
export const alignPeakBytesFor = (seconds: number): number => Math.min(ALIGN_PEAK_BYTES, Math.max(3_800_000_000, Math.ceil(2_100_000_000 + 46_000_000 * seconds)));
export const ALIGN_MODEL_ID = STACK_ALIGN_MODEL_ID;
export const ALIGN_MAX_SOURCE_BYTES = 40 * 1024 * 1024;
export const ALIGN_MAX_LYRICS_CHARS = 8000;
/** A longer file is refused with a reason (the worker checks after decoding); 240 s is the longest song the music engine makes. */
export const ALIGN_MAX_SECONDS = 4 * 60;
export const ALIGN_IDLE_MS = 60_000;
export const alignRoot = () => engineTagRoot(ALIGN_NAME, ALIGN_VERSION);
const root = alignRoot;
const proof = () => join(uvVenvPath(root()), "lib", "python3.12", "site-packages", "torchaudio", "__init__.py");
export const alignEnvironmentReady = (): boolean => uvEnvironmentReady({ name: ALIGN_NAME, version: ALIGN_VERSION, root: root(), proof: proof() });
const spec = (): UvEnvironmentSpec => ({ name: ALIGN_NAME, version: ALIGN_VERSION, root: root(), requirements: process.platform === "darwin" && process.arch === "arm64" ? requirements : null, proof: proof() });

export interface AlignWord { t: number; end: number; text: string; }
export interface AlignResult { words: AlignWord[]; aligned_words: number; total_words: number; line_starts: number[]; ms: number; }
export interface AlignRequest { id: string; source: string; lyrics: string; maxSeconds?: number; fromS?: number; toS?: number; modelPath: string; modelHash: string; ffmpeg: string; workDir: string; }
export interface AlignHandle { send(request: AlignRequest, cb: (stage: string, fraction: number) => void, signal?: AbortSignal): Promise<AlignResult>; kill(graceMs?: number): void; exited: Promise<number>; pausable?: PausableWorker; }
export interface AlignDeps { supported: () => boolean; installed: () => boolean; ensure: (stage: (s: string) => void, signal?: AbortSignal) => Promise<void>; runtime: () => { modelPath: string; modelHash: string; ffmpeg: string }; spawn: () => Promise<AlignHandle>; }

/** The worker runs with no network, no tokens and no proxy. TORCH_HOME points at a folder under the engine root where the pinned file sits at hub/checkpoints/model.pt, so torchaudio finds it without fetching. */
export function alignWorkerEnv(): Record<string, string> {
  const env = managedEnv({ PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", HF_HUB_DISABLE_PROGRESS_BARS: "1", TQDM_DISABLE: "1", TOKENIZERS_PARALLELISM: "false", TORCH_HOME: join(root(), "torch-home"), HOME: join(dataDir, "home") });
  for (const key of Object.keys(env)) if (/TOKEN|KEY|SECRET|PROXY|NO_PROXY|HTTP_PROXY|HTTPS_PROXY/i.test(key)) delete env[key];
  return env;
}
const modelFile = (): string | null => { const record = getModel(STACK_ALIGN_MODEL.id); if (!record?.modelPath || !record.verifiedAt) return null; return record.modelPath; };
/** Puts the installed file where torchaudio looks for it: TORCH_HOME/hub/checkpoints/model.pt, a link to the verified copy. */
function linkModel(file: string): void {
  const target = join(root(), "torch-home", "hub", "checkpoints", "model.pt");
  mkdirSync(dirname(target), { recursive: true });
  try { if (lstatSync(target)) rmSync(target, { force: true }); } catch { /* not there yet */ }
  symlinkSync(file, target);
}
export const defaultAlignDeps: AlignDeps = {
  supported: () => process.platform === "darwin" && process.arch === "arm64",
  installed: () => { const file = modelFile(); return !!file && existsSync(file); },
  ensure: async (stage, signal) => {
    const file = modelFile(); if (!file || !existsSync(file)) throw new Error("The alignment model is not installed.");
    await ensureUvEnvironment(spec(), stage, { signal });
  },
  runtime: () => {
    const file = modelFile(); if (!file) throw new Error("The alignment model is not installed.");
    const binDir = join(uvVenvPath(root()), "lib/python3.12/site-packages/imageio_ffmpeg/binaries");
    const ffmpeg = readdirSync(binDir).find((name) => name.startsWith("ffmpeg")); if (!ffmpeg) throw new Error("The bundled audio decoder is missing.");
    linkModel(file);
    return { modelPath: file, modelHash: STACK_ALIGN_MODEL.download!.sha256, ffmpeg: join(binDir, ffmpeg) };
  },
  spawn: async () => {
    const dir = root(); mkdirSync(join(dir, "run"), { recursive: true });
    const script = join(dir, "align_worker.py"); writeFileSync(script, await Bun.file(workerAsset).text());
    const child = Bun.spawn([process.env.ALIGN_PYTHON ?? uvVenvPython(dir), "-s", script], { cwd: join(dir, "run"), stdin: "pipe", stdout: "pipe", stderr: "pipe", env: alignWorkerEnv() });
    return handle(child);
  },
};

export function handle(child: { pid?: number; stdin: { write(data: string): unknown; flush?(): unknown }; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): void }): AlignHandle {
  let stdoutBuffer = "";
  const callbacks = new Map<string, { resolve: (v: AlignResult) => void; reject: (e: Error) => void; stage: (s: string, f: number) => void }>();
  let ready!: () => void; const started = new Promise<void>((r) => { ready = r; });
  void (async () => { for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>) { stdoutBuffer += new TextDecoder().decode(chunk); let newline: number; while ((newline = stdoutBuffer.indexOf("\n")) >= 0) { const line = stdoutBuffer.slice(0, newline).trim(); stdoutBuffer = stdoutBuffer.slice(newline + 1); try { const m = JSON.parse(line); if (m.ready) ready(); else if (m.event === "stage") callbacks.get(m.id)?.stage(m.stage, m.fraction ?? 0); else if (m.id && callbacks.has(m.id)) { const cb = callbacks.get(m.id)!; callbacks.delete(m.id); m.ok ? cb.resolve({ words: m.words, aligned_words: m.aligned_words, total_words: m.total_words, line_starts: m.line_starts, ms: m.ms }) : cb.reject(new Error(m.error ?? "The alignment worker failed.")); } } catch {} } } })();
  void (async () => { for await (const _ of child.stderr as unknown as AsyncIterable<Uint8Array>) {} })();
  const exited = child.exited.then((code) => { for (const [id, cb] of callbacks) { callbacks.delete(id); cb.reject(new Error("The alignment worker stopped before finishing. Try again.")); } return code; });
  const pausable = new PausableProcess(child.pid ?? null, child.exited);
  const tree = new TreeSnapshot(child.pid ?? -1); tree.refresh();
  const owned = registerOwned("align-worker", tree);
  const stopTree = (graceMs: number) => pausable.killAfterResume(() => { const members = tree.refresh().length; void tree.stopAll(graceMs).then(() => { owned.finished(); const survivors = tree.survivors().length; if (members > 1) log(JSON.stringify({ event: "worker.tree_stopped", role: "align", members, survivors })); }); });
  return { exited, pausable, kill: (graceMs = 2_000) => stopTree(graceMs), send: async (request, stage, signal) => { await Promise.race([started, exited]); if (signal?.aborted) throw new Error("Cancelled."); tree.refresh(); owned.refresh(); return new Promise((resolve, reject) => { callbacks.set(request.id, { resolve, reject, stage }); child.stdin.write(`${JSON.stringify(request)}\n`); child.stdin.flush?.(); signal?.addEventListener("abort", () => { callbacks.delete(request.id); stopTree(2_000); reject(new Error("Cancelled.")); }, { once: true }); }); } };
}
export async function ensureAlignEnvironment(onProgress: (stage: string) => void = () => {}, signal?: AbortSignal): Promise<void> {
  if (!defaultAlignDeps.supported()) throw new Error(`Lyric alignment is not available on ${process.platform} ${process.arch}.`);
  await defaultAlignDeps.ensure(onProgress, signal);
}

/** Rule 6a: an error text must never carry a lyric word. Every word of the lyrics (three letters or more, any case) is blanked, as a second guard behind the worker's fixed sentences. */
export function scrubLyrics(message: string, lyrics: string): string {
  const words = new Set(lyrics.split(/[^\p{L}\p{N}']+/u).map((w) => w.replace(/^'+|'+$/g, "")).filter((w) => w.length >= 3));
  let out = message;
  for (const word of words) out = out.replace(new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "…");
  return out;
}

export class AlignService {
  private worker: AlignHandle | null = null; private chain: Promise<unknown> = Promise.resolve(); private idle: ReturnType<typeof setTimeout> | null = null; private busy = 0; private building: string | null = null; private deps: AlignDeps;
  constructor(deps: AlignDeps = defaultAlignDeps) { this.deps = deps; }
  useDeps(deps: AlignDeps | null): void { this.stop(); this.deps = deps ?? defaultAlignDeps; this.chain = Promise.resolve(); }
  get workerAlive(): boolean { return this.worker !== null; }
  get depsAvailable(): boolean { return this.deps.supported(); }
  get installed(): boolean { return this.deps.installed(); }
  get state(): string { return !this.deps.supported() ? "unsupported" : !this.installed ? "not-installed" : this.building ? "building" : this.busy ? "running" : this.worker ? "idle" : "needs-setup"; }
  run(request: Pick<AlignRequest, "id" | "source" | "lyrics" | "maxSeconds" | "fromS" | "toS" | "workDir">, onStage: (stage: string, fraction: number) => void, signal?: AbortSignal): Promise<AlignResult> {
    const job = this.chain.then(() => this.execute(request, onStage, signal), () => this.execute(request, onStage, signal)); this.chain = job.catch(() => {}); return job;
  }
  private async execute(request: Pick<AlignRequest, "id" | "source" | "lyrics" | "maxSeconds" | "fromS" | "toS" | "workDir">, stage: (s: string, f: number) => void, signal?: AbortSignal): Promise<AlignResult> {
    if (signal?.aborted) throw new Error("Cancelled.");
    if (!this.deps.installed()) throw new Error("The alignment model is not installed."); this.busy++; if (this.idle) clearTimeout(this.idle);
    let lease: ReturnType<typeof heavyGate.attach> | undefined;
    try {
      setIdleTtlSeconds("align-worker", Math.ceil(ALIGN_IDLE_MS / 1000));
      if (!this.worker) { stage("loading", 0); this.building = "packages"; try { await this.deps.ensure((s) => { this.building = s; stage("loading", 0); }, signal); } finally { this.building = null; } this.worker = await this.deps.spawn(); const worker = this.worker; void worker.exited.then(() => { if (this.worker === worker) this.stop(); }); }
      lease = heavyGate.attach({ role: "music", jobId: request.id, worker: this.worker.pausable });
      const runtime = this.deps.runtime();
      return await this.worker.send({ ...request, ...runtime }, stage, signal);
    } catch (error) {
      throw new Error(scrubLyrics(error instanceof Error ? error.message : String(error), request.lyrics));
    } finally { this.busy--; lease?.detach(); if (this.worker && !this.busy) this.idle = setTimeout(() => { this.stop(); log("align worker stopped after 60 seconds idle"); }, ALIGN_IDLE_MS); }
  }
  stopIfIdle(): boolean { if (!this.worker) { forgetLoadedItem("align-worker"); return false; } if (this.busy > 0) return false; this.stop(); return true; }
  stop(): void { if (this.idle) clearTimeout(this.idle); this.idle = null; const worker = this.worker; this.worker = null; if (worker) void worker.exited.finally(() => forgetLoadedItem("align-worker")); else forgetLoadedItem("align-worker"); worker?.kill(5_000); }
}
export const align = new AlignService();
setWarmWorkerUnload("align-worker", () => align.stopIfIdle());
