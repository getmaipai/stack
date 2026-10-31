import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { engineTagRoot } from "@/lib/store/layout";
import { dataDir } from "@/lib/paths";
import { getModel } from "@/lib/modelStore";
import { STACK_STEMS_MODEL_ID } from "@/lib/modelCatalog";
import { ensureUvEnvironment, managedEnv, uvEnvironmentReady, uvVenvPath, uvVenvPython, type UvEnvironmentSpec } from "@/lib/uvEnvironment";
import { heavyGate, PausableProcess, type PausableWorker } from "@/lib/heavyGate";
import { log } from "@/lib/log";
import workerAsset from "./stems_worker.py" with { type: "file" };
import requirements from "./stems.darwin-arm64.requirements.txt" with { type: "file" };

export const STEMS_NAME = "stems";
export const STEMS_VERSION = "4.1.0";
export const STEMS_PEAK_BYTES = 3_000_000_000;
export const STEMS_MODEL_ID = "htdemucs";
export const STEMS_MAX_SOURCE_BYTES = 40 * 1024 * 1024;
export const STEMS_OWNED_MAX_SECONDS = 12 * 60;
export const STEMS_IDLE_MS = 60_000;
export const stemsRoot = () => engineTagRoot(STEMS_NAME, STEMS_VERSION);
const root = stemsRoot;
const proof = () => join(uvVenvPath(root()), "lib", "python3.12", "site-packages", "demucs", "__init__.py");
export const stemsEnvironmentReady = (): boolean => uvEnvironmentReady({ name: STEMS_NAME, version: STEMS_VERSION, root: root(), proof: proof() });
const spec = (): UvEnvironmentSpec => ({ name: STEMS_NAME, version: STEMS_VERSION, root: root(), requirements: process.platform === "darwin" && process.arch === "arm64" ? requirements : null, proof: proof() });
export type StemName = "vocals" | "drums" | "bass" | "other";
export interface StemsRequest { maxSeconds?: number; id: string; source: string; outputs: Record<StemName, string>; checkpoint: string; config: string; ffmpeg: string; }
export interface StemsFile { stem: StemName; path: string; rms: number; }
export interface StemsHandle { send(request: StemsRequest, cb: (stage: string, fraction: number) => void, signal?: AbortSignal): Promise<{ files: StemsFile[]; ms: number }>; kill(): void; exited: Promise<number>; pausable?: PausableWorker; }
export interface StemsDeps { supported: () => boolean; installed: () => boolean; ensure: (stage: (s: string) => void, signal?: AbortSignal) => Promise<void>; runtime: () => { checkpoint: string; config: string; ffmpeg: string }; spawn: () => Promise<StemsHandle>; }
export function stemsWorkerEnv(): Record<string, string> {
  const env = managedEnv({ PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", HF_HUB_DISABLE_PROGRESS_BARS: "1", TQDM_DISABLE: "1", TOKENIZERS_PARALLELISM: "false", HOME: join(dataDir, "home") });
  for (const key of Object.keys(env)) if (/TOKEN|KEY|SECRET|PROXY|NO_PROXY|HTTP_PROXY|HTTPS_PROXY/i.test(key)) delete env[key];
  return env;
}
const modelPaths = () => { const record = getModel(STACK_STEMS_MODEL_ID); if (!record?.modelPath || !record.verifiedAt) return null; return { checkpoint: join(record.modelPath, "955717e8.safetensors"), config: join(record.modelPath, "htdemucs.yaml") }; };
export const defaultStemsDeps: StemsDeps = {
  supported: () => process.platform === "darwin" && process.arch === "arm64",
  installed: () => { const paths = modelPaths(); return !!paths && existsSync(paths.checkpoint) && existsSync(paths.config); },
  ensure: async (stage, signal) => {
    const model = modelPaths(); if (!model || !existsSync(model.checkpoint) || !existsSync(model.config)) throw new Error("The htdemucs model is not installed.");
    await ensureUvEnvironment(spec(), stage, { signal });
  },
  runtime: () => {
    const paths = modelPaths(); if (!paths) throw new Error("The htdemucs model is not installed.");
    const binDir = join(uvVenvPath(root()), "lib/python3.12/site-packages/imageio_ffmpeg/binaries");
    const ffmpeg = readdirSync(binDir).find((name) => name.startsWith("ffmpeg")); if (!ffmpeg) throw new Error("The bundled AAC encoder is missing.");
    return { ...paths, ffmpeg: join(binDir, ffmpeg) };
  },
  spawn: async () => {
    const dir = root(); mkdirSync(join(dir, "run"), { recursive: true });
    const script = join(dir, "stems_worker.py"); writeFileSync(script, await Bun.file(workerAsset).text());
    const env = stemsWorkerEnv();
    const child = Bun.spawn([process.env.STEMS_PYTHON ?? uvVenvPython(dir), "-s", script], { cwd: join(dir, "run"), stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
    return handle(child);
  },
};

export function handle(child: { pid?: number; stdin: { write(data: string): unknown; flush?(): unknown }; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): void }): StemsHandle {
  let stdoutBuffer = "";
  const callbacks = new Map<string, { resolve: (v: { files: StemsFile[]; ms: number }) => void; reject: (e: Error) => void; stage: (s: string, f: number) => void }>();
  let ready!: () => void; const started = new Promise<void>((r) => { ready = r; });
  void (async () => { for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>) { stdoutBuffer += new TextDecoder().decode(chunk); let newline: number; while ((newline = stdoutBuffer.indexOf("\n")) >= 0) { const line = stdoutBuffer.slice(0, newline).trim(); stdoutBuffer = stdoutBuffer.slice(newline + 1); try { const m = JSON.parse(line); if (m.ready) ready(); else if (m.event === "stage") callbacks.get(m.id)?.stage(m.stage, m.fraction ?? 0); else if (m.id && callbacks.has(m.id)) { const cb = callbacks.get(m.id)!; callbacks.delete(m.id); m.ok ? cb.resolve({ files: m.files, ms: m.ms }) : cb.reject(new Error(m.error ?? "The stem worker failed.")); } } catch {} } } })();
  void (async () => { for await (const _ of child.stderr as unknown as AsyncIterable<Uint8Array>) {} })();
  const exited = child.exited.then((code) => { for (const [id, cb] of callbacks) { callbacks.delete(id); cb.reject(new Error("The stem worker stopped before finishing. Try again.")); } return code; });
  const pausable = new PausableProcess(child.pid ?? null, child.exited);
  return { exited, pausable, kill: () => pausable.killAfterResume(() => { try { child.kill(); } catch {} }), send: async (request, stage, signal) => { await Promise.race([started, exited]); if (signal?.aborted) throw new Error("Cancelled."); return new Promise((resolve, reject) => { callbacks.set(request.id, { resolve, reject, stage }); child.stdin.write(`${JSON.stringify(request)}\n`); child.stdin.flush?.(); signal?.addEventListener("abort", () => { callbacks.delete(request.id); child.kill(); reject(new Error("Cancelled.")); }, { once: true }); }); } };
}
export async function ensureStemsEnvironment(onProgress: (stage: string) => void = () => {}, signal?: AbortSignal): Promise<void> {
  if (!defaultStemsDeps.supported()) throw new Error(`Stem splitting is not available on ${process.platform} ${process.arch}.`);
  await defaultStemsDeps.ensure(onProgress, signal);
}

export class StemsService {
  private worker: StemsHandle | null = null; private chain: Promise<unknown> = Promise.resolve(); private idle: ReturnType<typeof setTimeout> | null = null; private busy = 0; private building: string | null = null; private deps: StemsDeps;
  constructor(deps: StemsDeps = defaultStemsDeps) { this.deps = deps; }
  useDeps(deps: StemsDeps | null): void { this.stop(); this.deps = deps ?? defaultStemsDeps; this.chain = Promise.resolve(); }
  setDepsForTests(deps: StemsDeps | null): void { this.useDeps(deps); }
  get workerAlive(): boolean { return this.worker !== null; }
  get depsAvailable(): boolean { return this.deps.supported(); }
  get installed(): boolean { return this.deps.installed(); }
  get state(): string { return !this.deps.supported() ? "unsupported" : !this.installed ? "not-installed" : this.building ? "building" : this.busy ? "running" : this.worker ? "idle" : "needs-setup"; }
  run(request: Pick<StemsRequest, "id" | "source" | "outputs" | "maxSeconds">, onStage: (stage: string, fraction: number) => void, signal?: AbortSignal) {
    const job = this.chain.then(() => this.execute(request, onStage, signal), () => this.execute(request, onStage, signal)); this.chain = job.catch(() => {}); return job;
  }
  private async execute(request: Pick<StemsRequest, "id" | "source" | "outputs" | "maxSeconds">, stage: (s: string, f: number) => void, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error("Cancelled.");
    if (!this.deps.installed()) throw new Error("The htdemucs model is not installed."); this.busy++; if (this.idle) clearTimeout(this.idle);
    let lease: ReturnType<typeof heavyGate.attach> | undefined;
    try {
      if (!this.worker) { stage("loading", 0); this.building = "packages"; try { await this.deps.ensure((s) => { this.building = s; stage("loading", 0); }, signal); } finally { this.building = null; } this.worker = await this.deps.spawn(); const worker = this.worker; void worker.exited.then(() => { if (this.worker === worker) this.worker = null; }); }
      lease = heavyGate.attach({ role: "music", jobId: request.id, worker: this.worker.pausable });
      const runtime = this.deps.runtime();
      const result = await this.worker.send({ ...request, ...runtime }, stage, signal);
      return result;
    } finally { this.busy--; lease?.detach(); if (this.worker && !this.busy) this.idle = setTimeout(() => { this.stop(); log("stems worker stopped after 60 seconds idle"); }, STEMS_IDLE_MS); }
  }
  stop(): void { if (this.idle) clearTimeout(this.idle); this.idle = null; const worker = this.worker; this.worker = null; worker?.kill(); }
}
export const stems = new StemsService();
