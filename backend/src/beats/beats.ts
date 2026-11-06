import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { engineTagRoot } from "@/lib/store/layout";
import { dataDir } from "@/lib/paths";
import { ensureUvEnvironment, managedEnv, uvEnvironmentReady, uvVenvPath, uvVenvPython, type UvEnvironmentSpec } from "@/lib/uvEnvironment";
import { heavyGate, PausableProcess, type PausableWorker } from "@/lib/heavyGate";
import { TreeSnapshot } from "@/lib/processTree";
import { registerOwned } from "@/lib/ownedProcesses";
import { forgetLoadedItem, setIdleTtlSeconds, setWarmWorkerUnload } from "@/lib/governor";
import { log } from "@/lib/log";
import workerAsset from "./beats_worker.py" with { type: "file" };
import requirements from "./beats.darwin-arm64.requirements.txt" with { type: "file" };

export const BEATS_NAME = "beats";
export const BEATS_VERSION = "1.0.0";
export const BEATS_MAX_SOURCE_BYTES = 40 * 1024 * 1024;
export const BEATS_MAX_SECONDS = 12 * 60;
/** Footprint peak, measured on the Studio (Apple M5 Max, 2026-11-05, /usr/bin/time -l, hash-pinned environment, m4a input): 40 s 0.31 GB, 200 s 0.73 GB (about 2.7 MB per second of audio), so the 12 minute cap needs about 2.3 GB; admission uses 2.5 GB. */
export const BEATS_PEAK_BYTES = 2_500_000_000;
export const BEATS_IDLE_MS = 60_000;
export const beatsRoot = () => engineTagRoot(BEATS_NAME, BEATS_VERSION);
const root = beatsRoot;
const proof = () => join(uvVenvPath(root()), "lib", "python3.12", "site-packages", "librosa", "__init__.py");
export const beatsEnvironmentReady = () => uvEnvironmentReady({ name: BEATS_NAME, version: BEATS_VERSION, root: root(), proof: proof() });
const spec = (): UvEnvironmentSpec => ({ name: BEATS_NAME, version: BEATS_VERSION, root: root(), requirements: process.platform === "darwin" && process.arch === "arm64" ? requirements : null, proof: proof() });

export interface BeatsResult { tempo_bpm: number; beats: number[]; confidence: number; meter: number; downbeats: number[]; downbeat_confidence: number; sections: Array<{ start_s: number; end_s: number; label: string }>; duration_s: number; engine: "librosa"; ms: number; }
interface Request { id: string; source: string; workDir: string; maxSeconds: number; }
interface Handle { send(request: Request, cb: (stage: string, fraction: number) => void, signal?: AbortSignal): Promise<BeatsResult>; kill(graceMs?: number): void; exited: Promise<number>; pausable?: PausableWorker; }
interface Deps { supported: () => boolean; installed: () => boolean; ensure: (stage: (s: string) => void, signal?: AbortSignal) => Promise<void>; runtime: () => { ffmpeg: string }; spawn: () => Promise<Handle>; }
export function beatsWorkerEnv(): Record<string, string> { const env = managedEnv({ PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1", HOME: join(dataDir, "home"), NUMBA_CACHE_DIR: join(root(), "numba-cache") }); for (const key of Object.keys(env)) if (/TOKEN|KEY|SECRET|PROXY|NO_PROXY|HTTP_PROXY|HTTPS_PROXY/i.test(key)) delete env[key]; return env; }
const defaultDeps: Deps = {
  supported: () => process.platform === "darwin" && process.arch === "arm64",
  installed: () => beatsEnvironmentReady(),
  ensure: async (stage, signal) => { await ensureUvEnvironment(spec(), stage, { signal }); },
  runtime: () => { const binDir = join(uvVenvPath(root()), "lib/python3.12/site-packages/imageio_ffmpeg/binaries"); const ffmpeg = readdirSync(binDir).find((name) => name.startsWith("ffmpeg")); if (!ffmpeg) throw new Error("The bundled audio decoder is missing."); return { ffmpeg: join(binDir, ffmpeg) }; },
  spawn: async () => { const dir = root(); mkdirSync(join(dir, "run"), { recursive: true }); const script = join(dir, "beats_worker.py"); writeFileSync(script, await Bun.file(workerAsset).text()); const child = Bun.spawn([process.env.MAIPAI_BEATS_PYTHON ?? uvVenvPython(dir), "-s", script], { cwd: join(dir, "run"), stdin: "pipe", stdout: "pipe", stderr: "pipe", env: beatsWorkerEnv() }); return handle(child); },
};
export function handle(child: { pid?: number; stdin: { write(data: string): unknown; flush?(): unknown }; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): void }): Handle {
  let buffer = ""; const callbacks = new Map<string, { resolve: (v: BeatsResult) => void; reject: (e: Error) => void; stage: (s: string, f: number) => void }>(); let ready!: () => void; const started = new Promise<void>((r) => { ready = r; });
  void (async () => { for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>) { buffer += new TextDecoder().decode(chunk); let n: number; while ((n = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, n).trim(); buffer = buffer.slice(n + 1); try { const m = JSON.parse(line); if (m.ready) ready(); else if (m.event === "stage") callbacks.get(m.id)?.stage(m.stage, m.fraction ?? 0); else if (m.id && callbacks.has(m.id)) { const cb = callbacks.get(m.id)!; callbacks.delete(m.id); m.ok ? cb.resolve({ tempo_bpm: m.tempo_bpm, beats: m.beats, confidence: m.confidence, meter: m.meter, downbeats: m.downbeats, downbeat_confidence: m.downbeat_confidence, sections: m.sections, duration_s: m.duration_s, engine: m.engine, ms: m.ms }) : cb.reject(new Error(m.error ?? "The beat analysis failed. Try again.")); } } catch {} } } })();
  void (async () => { for await (const _ of child.stderr as unknown as AsyncIterable<Uint8Array>) {} })();
  const exited = child.exited.then((code) => { for (const [id, cb] of callbacks) { callbacks.delete(id); cb.reject(new Error("The beat worker stopped before finishing. Try again.")); } return code; }); const pausable = new PausableProcess(child.pid ?? null, child.exited); const tree = new TreeSnapshot(child.pid ?? -1); tree.refresh(); const owned = registerOwned("beats-worker", tree); const stop = (ms: number) => pausable.killAfterResume(() => { void tree.stopAll(ms).then(() => owned.finished()); });
  return { exited, pausable, kill: (ms = 2000) => stop(ms), send: async (request, stage, signal) => { await Promise.race([started, exited]); if (signal?.aborted) throw new Error("Cancelled."); tree.refresh(); owned.refresh(); return new Promise((resolve, reject) => { callbacks.set(request.id, { resolve, reject, stage }); child.stdin.write(`${JSON.stringify({ ...request, ...defaultDeps.runtime() })}\n`); child.stdin.flush?.(); signal?.addEventListener("abort", () => { callbacks.delete(request.id); stop(2000); reject(new Error("Cancelled.")); }, { once: true }); }); } };
}
export class BeatsService {
  private worker: Handle | null = null; private chain: Promise<unknown> = Promise.resolve(); private idle: ReturnType<typeof setTimeout> | null = null; private busy = 0; private deps = defaultDeps;
  setDepsForTests(deps: Deps | null): void { this.stop(); this.deps = deps ?? defaultDeps; this.chain = Promise.resolve(); }
  get depsAvailable() { return this.deps.supported(); } get installed() { return this.deps.installed(); } get state() { return !this.depsAvailable ? "unsupported" : !this.installed ? "not-installed" : this.busy ? "running" : this.worker ? "idle" : "needs-setup"; }
  run(request: Request, stage: (s: string, f: number) => void, signal?: AbortSignal) { const task = this.chain.then(() => this.execute(request, stage, signal), () => this.execute(request, stage, signal)); this.chain = task.catch(() => {}); return task; }
  private async execute(request: Request, stage: (s: string, f: number) => void, signal?: AbortSignal) { this.busy++; if (this.idle) clearTimeout(this.idle); let lease: ReturnType<typeof heavyGate.attach> | undefined; try { setIdleTtlSeconds("beats-worker", 60); if (!this.worker) { stage("loading", 0); await this.deps.ensure(() => stage("loading", .05), signal); this.worker = await this.deps.spawn(); const w = this.worker; void w.exited.then(() => { if (this.worker === w) this.stop(); }); } lease = heavyGate.attach({ role: "music", jobId: request.id, worker: this.worker.pausable }); return await this.worker.send(request, stage, signal); } finally { this.busy--; lease?.detach(); if (this.worker && !this.busy) this.idle = setTimeout(() => this.stop(), BEATS_IDLE_MS); } }
  stop() { if (this.idle) clearTimeout(this.idle); this.idle = null; const w = this.worker; this.worker = null; if (w) void w.exited.finally(() => forgetLoadedItem("beats-worker")); else forgetLoadedItem("beats-worker"); w?.kill(5000); }
}
export const beats = new BeatsService();
export async function ensureBeatsEnvironment(stage: (s: string) => void = () => {}, signal?: AbortSignal) { if (!defaultDeps.supported()) throw new Error(`Beat analysis is not available on ${process.platform} ${process.arch}.`); await defaultDeps.ensure(stage, signal); }
setWarmWorkerUnload("beats-worker", () => { if (beats.state !== "running") { beats.stop(); return true; } return false; });
