import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";
import { engineTagRoot } from "@/lib/store/layout";
import { ensureUvEnvironment, managedEnv, uvEnvironmentReady, uvVenvPath, uvVenvPython, type UvEnvironmentSpec } from "@/lib/uvEnvironment";
import { defaultToolbox } from "@/media/tools";
import { registerOwned } from "@/lib/ownedProcesses";
import requirements from "./score-gen.darwin-arm64.requirements.txt" with { type: "file" };
import worker from "./score_worker.py" with { type: "file" };

export const SCORE_GEN_NAME = "score-gen";
export const SCORE_GEN_VERSION = "0.4.0";
export const SCORE_PEAK_BYTES = 1_000_000_000;
export const SCORE_QUEUE_MAX = 4;
export const SCORE_MAX_SECONDS = 600;
export const scoreRequirementsFileFor = (platform = process.platform, arch = process.arch): string | null => platform === "darwin" && arch === "arm64" ? requirements : null;
export const scoreGenRoot = (): string => engineTagRoot(SCORE_GEN_NAME, SCORE_GEN_VERSION);
export const scoreGenProof = (): string => join(uvVenvPath(scoreGenRoot()), "lib", "python3.12", "site-packages", "basic_pitch", "__init__.py");
export const scoreGenEnvironmentReady = (): boolean => uvEnvironmentReady({ name: SCORE_GEN_NAME, version: SCORE_GEN_VERSION, root: scoreGenRoot(), proof: scoreGenProof() });
const spec = (): UvEnvironmentSpec => ({ name: SCORE_GEN_NAME, version: SCORE_GEN_VERSION, root: scoreGenRoot(), requirements: scoreRequirementsFileFor(), noDeps: true, proof: scoreGenProof() });
export async function ensureScoreGenEnvironment(onProgress: (phase: string) => void = () => {}, signal?: AbortSignal): Promise<void> { await ensureUvEnvironment(spec(), onProgress, { signal }); }
export interface ScoreWorkerRequest { id: string; input: string; output_dir: string; ffmpeg: string; }
export interface ScoreWorkerReply { id: string | null; ok: boolean; code?: string; error?: string; tempo_bpm?: number; notes?: number; ms?: number; }
export interface ScoreDeps {
  supported: () => boolean; ready: () => boolean;
  ensure: (progress: (phase: string) => void, signal?: AbortSignal) => Promise<void>;
  ffmpeg: (progress: (status: string) => void, signal?: AbortSignal) => Promise<string>;
  runWorker: (request: ScoreWorkerRequest, signal: AbortSignal, stage: (stage: string, fraction: number | null) => void) => Promise<ScoreWorkerReply>;
}
const workerStops = new Set<() => void>();
export function stopScoreWorkers(): void { for (const stop of workerStops) stop(); workerStops.clear(); }
const defaultRunWorker: ScoreDeps["runWorker"] = async (request, signal, stage) => {
  const root = scoreGenRoot(), script = join(root, "score_worker.py");
  mkdirSync(root, { recursive: true }); writeFileSync(script, await Bun.file(worker).text());
  const env = managedEnv({ PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: root, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", HTTPS_PROXY: "", HTTP_PROXY: "", ALL_PROXY: "" });
  for (const key of Object.keys(env)) if (/TOKEN|SECRET|PROXY/i.test(key) || key === "HF_ENDPOINT") delete env[key];
  const child = Bun.spawn([process.env.SCORE_GEN_PYTHON ?? uvVenvPython(root), "-s", script], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
  const owned = registerOwned("score-gen-worker", child.pid ?? -1);
  const stop = () => { if (!child.killed) child.kill(); }; workerStops.add(stop);
  const stderr = child.stderr; void new Response(stderr).text().catch(() => {});
  const reader = child.stdout.getReader(); let pending = ""; let settled: ScoreWorkerReply | null = null;
  const abort = () => child.kill(); signal.addEventListener("abort", abort, { once: true });
  try {
    child.stdin.write(JSON.stringify(request) + "\n"); child.stdin.flush();
    while (!settled) {
      const { value, done } = await reader.read(); if (done) break;
      pending += new TextDecoder().decode(value);
      let n; while ((n = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, n); pending = pending.slice(n + 1); let msg: any; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.event === "stage") stage(msg.stage, msg.fraction ?? null); else if (msg.id === request.id) settled = msg;
      }
    }
    if (!settled) throw new Error("The score engine stopped before the MIDI was ready. Try again.");
    const code = await child.exited; owned.refresh(); owned.finished(); if (code && settled.ok) throw new Error("The score engine stopped unexpectedly. Try again.");
    return settled;
  } finally { signal.removeEventListener("abort", abort); stop(); workerStops.delete(stop); owned.finished(); }
};
export const scoreDeps: ScoreDeps = { supported: () => !!scoreRequirementsFileFor(), ready: scoreGenEnvironmentReady, ensure: ensureScoreGenEnvironment, ffmpeg: (progress, signal) => defaultToolbox.path("ffmpeg", progress, signal), runWorker: defaultRunWorker };
export function useScoreDepsForTests(deps: ScoreDeps | null): void { activeDeps = deps ?? scoreDeps; }
let activeDeps: ScoreDeps = scoreDeps;
export function getScoreDeps(): ScoreDeps { return activeDeps; }
export function scoreOutputDir(id: string): string { return join(scoreDataRoot(), id); }
export function scoreDataRoot(): string { return join(dataDir, "score", "results"); }
export function scoreFile(id: string, kind: "midi" | "notes"): string { return join(scoreOutputDir(id), kind === "midi" ? `${id}.mid` : `${id}.notes.json`); }
export function readScoreNotes(id: string): unknown | null { try { return JSON.parse(readFileSync(scoreFile(id, "notes"), "utf8")); } catch { return null; } }

/** Retain scores for ten minutes and the six newest, matching other music results. */
export function sweepScoreResults(now = Date.now()): number {
  const root = scoreDataRoot(); if (!existsSync(root)) return 0;
  const entries = readdirSync(root).map((id) => { const path = join(root, id); try { return { id, path, mtime: statSync(path).mtimeMs }; } catch { return null; } }).filter((item): item is { id: string; path: string; mtime: number } => !!item).sort((a, b) => b.mtime - a.mtime);
  let removed = 0; for (const [index, item] of entries.entries()) if (index >= 6 || now - item.mtime > 10 * 60_000) { rmSync(item.path, { recursive: true, force: true }); removed++; }
  return removed;
}

/** Remove abandoned multipart uploads after cancelled or expired queued jobs. */
export function sweepScoreInputs(now = Date.now()): number {
  const root = join(dataDir, "score", "inputs"); if (!existsSync(root)) return 0;
  let removed = 0; for (const name of readdirSync(root)) { const path = join(root, name); try { if (now - statSync(path).mtimeMs > 30 * 60_000) { rmSync(path, { force: true }); removed++; } } catch { /* the file disappeared while sweeping */ } }
  return removed;
}
