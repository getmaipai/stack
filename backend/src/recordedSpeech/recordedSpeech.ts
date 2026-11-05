import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";
import { engineTagRoot } from "@/lib/store/layout";
import { getModel } from "@/lib/modelStore";
import { STACK_RECORDED_SPEECH_MODEL_ID } from "@/lib/modelCatalog";
import { ensureUvEnvironment, managedEnv, uvEnvironmentReady, uvVenvPath, uvVenvPython, type UvEnvironmentSpec } from "@/lib/uvEnvironment";
import { heavyGate, PausableProcess, type PausableWorker } from "@/lib/heavyGate";
import { TreeSnapshot } from "@/lib/processTree";
import { registerOwned } from "@/lib/ownedProcesses";
import { forgetLoadedItem, setIdleTtlSeconds, setWarmWorkerUnload } from "@/lib/governor";
import { log } from "@/lib/log";
import workerAsset from "./recorded_speech_worker.py" with { type: "file" };
import requirements from "@/speech/recorded-speech.darwin-arm64.requirements.txt" with { type: "file" };

export const RECORDED_SPEECH_NAME = "recorded-speech";
export const RECORDED_SPEECH_VERSION = "1.0.0";
export const RECORDED_SPEECH_PEAK_BYTES = 30_000_000_000;
export const RECORDED_SPEECH_IDLE_MS = 60_000;
export const RECORDED_SPEECH_MAX_TEXT = 4_000;
export const RECORDED_SPEECH_MAX_REFERENCE_BYTES = 40 * 1024 * 1024;
export const recordedSpeechRoot = () => engineTagRoot(RECORDED_SPEECH_NAME, RECORDED_SPEECH_VERSION);
const root = recordedSpeechRoot;
const proof = () => join(uvVenvPath(root()), "lib", "python3.12", "site-packages", "mlx_audio", "__init__.py");
const spec = (): UvEnvironmentSpec => ({ name: RECORDED_SPEECH_NAME, version: RECORDED_SPEECH_VERSION, root: root(), requirements: process.platform === "darwin" && process.arch === "arm64" ? requirements : null, proof: proof() });
export const recordedSpeechEnvironmentReady = () => uvEnvironmentReady(spec());

export interface RecordedSpeaker { audio: string; text: string; }
export interface RecordedSpeechRequest { id: string; text: string; references: RecordedSpeaker[]; format: "m4a" | "wav"; output: string; outputWav: string; work_dir: string; model: string; }
export interface RecordedSpeechResult { ms: number; duration: number; sample_rate: number; peak_gb?: number; }
export interface RecordedSpeechHandle { send(request: RecordedSpeechRequest, cb: (stage: string, fraction: number) => void, signal?: AbortSignal): Promise<RecordedSpeechResult>; kill(graceMs?: number): void; exited: Promise<number>; pausable?: PausableWorker; }
export interface RecordedSpeechDeps { supported: () => boolean; installed: () => boolean; ensure: (stage: (name: string) => void, signal?: AbortSignal) => Promise<void>; modelPath: () => string; spawn: () => Promise<RecordedSpeechHandle>; }

export function recordedSpeechWorkerEnv(): Record<string, string> {
  const env = managedEnv({ PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1", HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", HF_HUB_DISABLE_PROGRESS_BARS: "1", TQDM_DISABLE: "1", TOKENIZERS_PARALLELISM: "false", HOME: join(dataDir, "home"), HF_HOME: join(dataDir, "models") });
  for (const key of Object.keys(env)) if (/TOKEN|KEY|SECRET|PROXY|NO_PROXY|HF_/i.test(key)) delete env[key];
  env.HF_HUB_OFFLINE = "1"; env.HF_HUB_DISABLE_TELEMETRY = "1"; env.HF_HOME = join(dataDir, "models");
  return env;
}

const getModelPath = () => { const record = getModel(STACK_RECORDED_SPEECH_MODEL_ID); return record?.modelPath && record.verifiedAt ? record.modelPath : null; };
export const defaultRecordedSpeechDeps: RecordedSpeechDeps = {
  supported: () => process.platform === "darwin" && process.arch === "arm64",
  installed: () => { const path = getModelPath(); return !!path && existsSync(join(path, "config.json")) && recordedSpeechEnvironmentReady(); },
  ensure: async (stage, signal) => { const path = getModelPath(); if (!path || !existsSync(join(path, "config.json"))) throw new Error("The Fish Audio Drama 3 model is not installed."); await ensureUvEnvironment(spec(), stage, { signal }); },
  modelPath: () => { const path = getModelPath(); if (!path) throw new Error("The Fish Audio Drama 3 model is not installed."); return path; },
  spawn: async () => {
    const dir = root(); mkdirSync(join(dir, "run"), { recursive: true });
    const script = join(dir, "recorded_speech_worker.py"); writeFileSync(script, await Bun.file(workerAsset).text());
    const child = Bun.spawn([process.env.RECORDED_SPEECH_PYTHON ?? uvVenvPython(dir), "-s", script], { cwd: join(dir, "run"), stdin: "pipe", stdout: "pipe", stderr: "pipe", env: recordedSpeechWorkerEnv() });
    return handle(child);
  },
};

export function handle(child: { pid?: number; stdin: { write(data: string): unknown; flush?(): unknown }; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): void }): RecordedSpeechHandle {
  let buffer = ""; const callbacks = new Map<string, { resolve: (v: RecordedSpeechResult) => void; reject: (e: Error) => void; stage: (name: string, fraction: number) => void }>(); let ready!: () => void; const started = new Promise<void>((r) => { ready = r; });
  void (async () => { for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>) { buffer += new TextDecoder().decode(chunk); let i: number; while ((i = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1); try { const m = JSON.parse(line); if (m.ready) ready(); else if (m.event === "stage") callbacks.get(m.id)?.stage(m.stage, m.fraction ?? 0); else if (callbacks.has(m.id)) { const cb = callbacks.get(m.id)!; callbacks.delete(m.id); m.ok ? cb.resolve({ ms: m.ms, duration: m.duration, sample_rate: m.sample_rate, peak_gb: m.peak_gb }) : cb.reject(new Error(m.error ?? "Recorded speech could not be rendered.")); } } catch {} } } })();
  void (async () => { for await (const _ of child.stderr as unknown as AsyncIterable<Uint8Array>) {} })();
  const exited = child.exited.then((code) => { for (const [id, cb] of callbacks) { callbacks.delete(id); cb.reject(new Error("The recorded speech worker stopped before finishing. Try again.")); } return code; });
  const pausable = new PausableProcess(child.pid ?? null, child.exited); const tree = new TreeSnapshot(child.pid ?? -1); tree.refresh(); const owned = registerOwned("recorded-speech-worker", tree);
  const stopTree = (grace: number) => pausable.killAfterResume(() => { const members = tree.refresh().length; void tree.stopAll(grace).then(() => { owned.finished(); const survivors = tree.survivors().length; if (members > 1) log(JSON.stringify({ event: "worker.tree_stopped", role: "tts", members, survivors })); }); });
  return { exited, pausable, kill: (grace = 2_000) => stopTree(grace), send: async (request, stage, signal) => { await Promise.race([started, exited.then(() => {})]); if (signal?.aborted) throw new Error("Cancelled."); tree.refresh(); owned.refresh(); return new Promise((resolve, reject) => { callbacks.set(request.id, { resolve, reject, stage }); child.stdin.write(`${JSON.stringify(request)}\n`); child.stdin.flush?.(); signal?.addEventListener("abort", () => { callbacks.delete(request.id); stopTree(2_000); reject(new Error("Cancelled.")); }, { once: true }); }); } };
}

export class RecordedSpeechService {
  private worker: RecordedSpeechHandle | null = null; private chain: Promise<unknown> = Promise.resolve(); private idle: ReturnType<typeof setTimeout> | null = null; private busy = 0; private building: string | null = null; private deps: RecordedSpeechDeps;
  constructor(deps: RecordedSpeechDeps = defaultRecordedSpeechDeps) { this.deps = deps; }
  useDeps(deps: RecordedSpeechDeps | null): void { this.stop(); this.deps = deps ?? defaultRecordedSpeechDeps; this.chain = Promise.resolve(); }
  get workerAlive(): boolean { return this.worker !== null; } get depsAvailable(): boolean { return this.deps.supported(); } get installed(): boolean { return this.deps.installed(); }
  get state(): string { return !this.deps.supported() ? "unsupported" : !this.installed ? "not-installed" : this.building ? "building" : this.busy ? "running" : this.worker ? "idle" : "needs-setup"; }
  run(request: Omit<RecordedSpeechRequest, "model">, stage: (name: string, fraction: number) => void, signal?: AbortSignal) { const job = this.chain.then(() => this.execute(request, stage, signal), () => this.execute(request, stage, signal)); this.chain = job.catch(() => {}); return job; }
  private async execute(request: Omit<RecordedSpeechRequest, "model">, stage: (name: string, fraction: number) => void, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error("Cancelled."); if (!this.deps.installed()) throw new Error("The Fish Audio Drama 3 model is not installed."); this.busy++; if (this.idle) clearTimeout(this.idle); let lease: ReturnType<typeof heavyGate.attach> | undefined;
    try { setIdleTtlSeconds("recorded-speech-worker", 60); if (!this.worker) { stage("loading", 0); this.building = "packages"; try { await this.deps.ensure((name) => { this.building = name; stage("loading", 0); }, signal); } finally { this.building = null; } this.worker = await this.deps.spawn(); const worker = this.worker; void worker.exited.then(() => { if (this.worker === worker) this.stop(); }); }
      lease = heavyGate.attach({ role: "tts", jobId: request.id, worker: this.worker.pausable });
      return await this.worker.send({ ...request, model: this.deps.modelPath() }, stage, signal);
    } finally { this.busy--; lease?.detach(); if (this.worker && !this.busy) this.idle = setTimeout(() => { this.stop(); log("recorded speech worker stopped after 60 seconds idle"); }, RECORDED_SPEECH_IDLE_MS); }
  }
  stopIfIdle(): boolean { if (!this.worker || this.busy) { if (!this.worker) forgetLoadedItem("recorded-speech-worker"); return false; } this.stop(); return true; }
  stop(): void { if (this.idle) clearTimeout(this.idle); this.idle = null; const worker = this.worker; this.worker = null; if (worker) void worker.exited.finally(() => forgetLoadedItem("recorded-speech-worker")); else forgetLoadedItem("recorded-speech-worker"); worker?.kill(5_000); }
}
export const recordedSpeech = new RecordedSpeechService();
setWarmWorkerUnload("recorded-speech-worker", () => recordedSpeech.stopIfIdle());
export async function ensureRecordedSpeechEnvironment(on: (phase: string) => void = () => {}, signal?: AbortSignal): Promise<void> { if (!defaultRecordedSpeechDeps.supported()) throw new Error(`Recorded speech is not available on ${process.platform} ${process.arch}.`); await defaultRecordedSpeechDeps.ensure(on, signal); }
