import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { engineTagRoot } from "@/lib/store/layout";
import { dataDir } from "@/lib/paths";
import { getModel } from "@/lib/modelStore";
import { STACK_VOICE_CONVERT_F0, STACK_VOICE_CONVERT_MODEL, STACK_VOICE_CONVERT_WHISPER } from "@/lib/modelCatalog";
import { ensureUvEnvironment, managedEnv, uvEnvironmentReady, uvVenvPath, uvVenvPython, type UvEnvironmentSpec } from "@/lib/uvEnvironment";
import { heavyGate, PausableProcess, type PausableWorker } from "@/lib/heavyGate";
import { TreeSnapshot } from "@/lib/processTree";
import { registerOwned } from "@/lib/ownedProcesses";
import { forgetLoadedItem, setIdleTtlSeconds, setWarmWorkerUnload } from "@/lib/governor";
import { log } from "@/lib/log";
import workerAsset from "./voice_convert_worker.py" with { type: "file" };
import requirements from "./voice-convert.darwin-arm64.requirements.txt" with { type: "file" };
import { extractArchive } from "@maipai/core/src/archive";
import soulxSource from "./soulx-singer-source.tar.gz" with { type: "file" };

export const VOICE_CONVERT_NAME = "voice-convert";
export const VOICE_CONVERT_VERSION = "1.0.0";
export const VOICE_CONVERT_PEAK_BYTES = 8_000_000_000;
export const VOICE_CONVERT_MAX_SOURCE_BYTES = 40 * 1024 * 1024;
export const VOICE_CONVERT_IDLE_MS = 60_000;
export const voiceConvertRoot = () => engineTagRoot(VOICE_CONVERT_NAME, VOICE_CONVERT_VERSION);
const root = voiceConvertRoot;
const VOICE_CONVERT_SOURCE_SHA256 = "c446f166e66badb6476f336faaca74e961a7754be1c272ff95e5e2afb5367085";
export type EmbeddedArchiveReader = (path: string) => Promise<ArrayBuffer | Uint8Array>;
export async function extractVoiceConvertSource(assetPath: string, expectedHash: string, destination: string, readAsset: EmbeddedArchiveReader = (path) => Bun.file(path).arrayBuffer()): Promise<void> {
  const bytes = new Uint8Array(await readAsset(assetPath));
  const sourceHash = createHash("sha256").update(bytes).digest("hex");
  if (sourceHash !== expectedHash) throw new Error("The pinned voice conversion source did not verify.");
  if (existsSync(join(destination, "soulxsinger", "models", "soulxsinger_svc.py"))) return;
  mkdirSync(destination, { recursive: true });
  const archivePath = join(dirname(destination), "soulx-singer-source.tar.gz");
  try {
    await Bun.write(archivePath, bytes);
    await extractArchive(archivePath, destination);
  } finally {
    rmSync(archivePath, { force: true });
  }
}
const proof = () => join(uvVenvPath(root()), "lib", "python3.12", "site-packages", "torch", "__init__.py");
export const voiceConvertEnvironmentReady = (): boolean => uvEnvironmentReady({ name: VOICE_CONVERT_NAME, version: VOICE_CONVERT_VERSION, root: root(), proof: proof() });
const spec = (): UvEnvironmentSpec => ({ name: VOICE_CONVERT_NAME, version: VOICE_CONVERT_VERSION, root: root(), requirements: process.platform === "darwin" && process.arch === "arm64" ? requirements : null, proof: proof() });

export interface VoiceConvertRequest { id: string; source: string; reference: string; output: string; outputWav: string; workDir: string; checkpoint: string; config: string; rmvpe: string; whisper: string; pitch_shift: number; auto_shift: boolean; }
export interface VoiceConvertHandle { send(request: VoiceConvertRequest, cb: (stage: string, fraction: number) => void, signal?: AbortSignal): Promise<{ ms: number }>; kill(graceMs?: number): void; exited: Promise<number>; pausable?: PausableWorker; }
export interface VoiceConvertDeps { supported: () => boolean; installed: () => boolean; ensure: (stage: (s: string) => void, signal?: AbortSignal) => Promise<void>; runtime: () => { checkpoint: string; config: string; rmvpe: string; whisper: string }; spawn: () => Promise<VoiceConvertHandle>; }
export function voiceConvertWorkerEnv(): Record<string, string> { const env = managedEnv({ PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", HF_HUB_DISABLE_PROGRESS_BARS: "1", TQDM_DISABLE: "1", TOKENIZERS_PARALLELISM: "false", HOME: join(dataDir, "home") }); for (const key of Object.keys(env)) if (/TOKEN|KEY|SECRET|PROXY|NO_PROXY|HTTP_PROXY|HTTPS_PROXY/i.test(key)) delete env[key]; return env; }
const paths = () => { const model = getModel(STACK_VOICE_CONVERT_MODEL.id), f0 = getModel(STACK_VOICE_CONVERT_F0.id), whisperRecord = getModel(STACK_VOICE_CONVERT_WHISPER.id); if (!model?.modelPath || !model.verifiedAt || !f0?.modelPath || !f0.verifiedAt || !whisperRecord?.modelPath || !whisperRecord.verifiedAt) return null; const config = join(model.modelPath, "config.yaml"); const checkpoint = join(model.modelPath, "model-svc.pt"); return { checkpoint, config, rmvpe: f0.modelPath, whisper: join(dataDir,"models","hub"), whisperModel: whisperRecord.modelPath, ready: existsSync(config) && existsSync(checkpoint) && existsSync(f0.modelPath) && existsSync(whisperRecord.modelPath) }; };
export const defaultVoiceConvertDeps: VoiceConvertDeps = {
  supported: () => process.platform === "darwin" && process.arch === "arm64",
  installed: () => { const p=paths(); return !!p?.ready && uvEnvironmentReady(spec()) && existsSync(join(root(),"source","soulxsinger","models","soulxsinger_svc.py")); },
  ensure: async (_stage, signal) => { if (!paths()?.ready) throw new Error("The voice conversion models are not installed."); const sourceRoot = join(root(), "source"); await extractVoiceConvertSource(soulxSource, VOICE_CONVERT_SOURCE_SHA256, sourceRoot); await ensureUvEnvironment(spec(), _stage, { signal }); },
  runtime: () => { const p = paths(); if (!p?.ready) throw new Error("The voice conversion models are not installed."); return { checkpoint: p.checkpoint, config: p.config, rmvpe: p.rmvpe, whisper: p.whisperModel }; },
  spawn: async () => { const dir = root(); mkdirSync(join(dir, "run"), { recursive: true }); const script = join(dir, "voice_convert_worker.py"); writeFileSync(script, await Bun.file(workerAsset).text()); const env = voiceConvertWorkerEnv(); env.PYTHONPATH = join(dir, "source"); env.TRANSFORMERS_OFFLINE = "1"; env.HF_HUB_OFFLINE = "1"; env.HF_HOME = join(dataDir,"models"); env.NUMBA_CACHE_DIR = join(dir, "numba-cache"); const child = Bun.spawn([process.env.VOICE_CONVERT_PYTHON ?? uvVenvPython(dir), "-s", script], { cwd: join(dir, "run"), stdin: "pipe", stdout: "pipe", stderr: "pipe", env }); return handle(child); },
};
export function handle(child: { pid?: number; stdin: { write(data: string): unknown; flush?(): unknown }; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): void }): VoiceConvertHandle {
  let buffer = ""; const callbacks = new Map<string, { resolve: (v: { ms: number }) => void; reject: (e: Error) => void; stage: (s: string, f: number) => void }>(); let ready!: () => void; const started = new Promise<void>((r) => { ready = r; });
  void (async () => { for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>) { buffer += new TextDecoder().decode(chunk); let i: number; while ((i = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1); try { const m = JSON.parse(line); if (m.ready) ready(); else if (m.event === "stage") callbacks.get(m.id)?.stage(m.stage, m.fraction ?? 0); else if (callbacks.has(m.id)) { const cb = callbacks.get(m.id)!; callbacks.delete(m.id); m.ok ? cb.resolve({ ms: m.ms }) : cb.reject(new Error(m.error ?? "The voice conversion failed.")); } } catch {} } } })();
  void (async () => { for await (const _ of child.stderr as unknown as AsyncIterable<Uint8Array>) {} })();
  const exited = child.exited.then((code) => { for (const [id, cb] of callbacks) { callbacks.delete(id); cb.reject(new Error("The voice conversion worker stopped before finishing. Try again.")); } return code; }); const pausable = new PausableProcess(child.pid ?? null, child.exited); const tree = new TreeSnapshot(child.pid ?? -1); tree.refresh(); const owned = registerOwned("voice-convert-worker", tree);
  const stopTree = (grace: number) => pausable.killAfterResume(() => { const members = tree.refresh().length; void tree.stopAll(grace).then(() => { owned.finished(); const survivors = tree.survivors().length; if (members > 1) log(JSON.stringify({ event: "worker.tree_stopped", role: "music", members, survivors })); }); });
  return { exited, pausable, kill: (grace = 2_000) => stopTree(grace), send: async (request, stage, signal) => { await Promise.race([started, exited.then(() => {})]); if (signal?.aborted) throw new Error("Cancelled."); tree.refresh(); owned.refresh(); return new Promise((resolve, reject) => { callbacks.set(request.id, { resolve, reject, stage }); child.stdin.write(`${JSON.stringify(request)}\n`); child.stdin.flush?.(); signal?.addEventListener("abort", () => { callbacks.delete(request.id); stopTree(2_000); reject(new Error("Cancelled.")); }, { once: true }); }); } };
}
export async function ensureVoiceConvertEnvironment(on: (stage: string) => void = () => {}, signal?: AbortSignal): Promise<void> { if (!defaultVoiceConvertDeps.supported()) throw new Error(`Voice conversion is not available on ${process.platform} ${process.arch}.`); await defaultVoiceConvertDeps.ensure(on, signal); }
export class VoiceConvertService {
  private worker: VoiceConvertHandle | null = null; private chain: Promise<unknown> = Promise.resolve(); private idle: ReturnType<typeof setTimeout> | null = null; private busy = 0; private building: string | null = null; private deps: VoiceConvertDeps;
  constructor(deps: VoiceConvertDeps = defaultVoiceConvertDeps) { this.deps = deps; }
  useDeps(deps: VoiceConvertDeps | null): void { this.stop(); this.deps = deps ?? defaultVoiceConvertDeps; this.chain = Promise.resolve(); }
  get workerAlive(): boolean { return this.worker !== null; } get depsAvailable(): boolean { return this.deps.supported(); } get installed(): boolean { return this.deps.installed(); }
  get state(): string { return !this.deps.supported() ? "unsupported" : !this.installed ? "not-installed" : this.building ? "building" : this.busy ? "running" : this.worker ? "idle" : "needs-setup"; }
  run(request: Omit<VoiceConvertRequest, "checkpoint"|"config"|"rmvpe"|"whisper">, stage: (name: string, fraction: number) => void, signal?: AbortSignal) { const job = this.chain.then(() => this.execute(request, stage, signal), () => this.execute(request, stage, signal)); this.chain = job.catch(() => {}); return job; }
  private async execute(request: Omit<VoiceConvertRequest, "checkpoint"|"config"|"rmvpe"|"whisper">, stage: (name: string, fraction: number) => void, signal?: AbortSignal) { if (signal?.aborted) throw new Error("Cancelled."); if (!this.deps.installed()) throw new Error("The voice conversion models are not installed."); this.busy++; if (this.idle) clearTimeout(this.idle); let lease: ReturnType<typeof heavyGate.attach> | undefined; try { setIdleTtlSeconds("voice-convert-worker", 60); if (!this.worker) { stage("loading", 0); this.building = "packages"; try { await this.deps.ensure((s) => { this.building = s; stage("loading", 0); }, signal); } finally { this.building = null; } this.worker = await this.deps.spawn(); const w = this.worker; void w.exited.then(() => { if (this.worker === w) this.stop(); }); } lease = heavyGate.attach({ role: "music", jobId: request.id, worker: this.worker.pausable }); return await this.worker.send({ ...request, ...this.deps.runtime() }, stage, signal); } finally { this.busy--; lease?.detach(); if (this.worker && !this.busy) this.idle = setTimeout(() => { this.stop(); log("voice conversion worker stopped after 60 seconds idle"); }, VOICE_CONVERT_IDLE_MS); } }
  stopIfIdle(): boolean { if (!this.worker || this.busy) { if (!this.worker) forgetLoadedItem("voice-convert-worker"); return false; } this.stop(); return true; }
  stop(): void { if (this.idle) clearTimeout(this.idle); this.idle = null; const w = this.worker; this.worker = null; if (w) void w.exited.finally(() => forgetLoadedItem("voice-convert-worker")); else forgetLoadedItem("voice-convert-worker"); w?.kill(5_000); }
}
export const voiceConvert = new VoiceConvertService();
setWarmWorkerUnload("voice-convert-worker", () => voiceConvert.stopIfIdle());
