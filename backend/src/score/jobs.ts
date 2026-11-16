import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { registerJobRunner, type Job, type JobProgress } from "@/lib/jobs";
import { heavyGate } from "@/lib/heavyGate";
import { GenTracker, recordRun } from "@/lib/genProgress";
import { getScoreDeps, SCORE_PEAK_BYTES, scoreOutputDir } from "./scoreGen";

export const SCORE_JOB_KIND = "score_generation";
const errors = new Map<string, { code: string; message: string }>();
const pending = new Map<string, { input: string; owned: boolean; at: number }>();
export function stashScore(token: string, input: string, owned: boolean): void { const now = Date.now(); for (const [key, item] of pending) if (now - item.at > 30 * 60_000) { pending.delete(key); if (item.owned) rmSync(item.input, { force: true }); } pending.set(token, { input, owned, at: now }); }
export function unstashScore(token: string): { input: string; owned: boolean } | null { const item = pending.get(token); pending.delete(token); return item ?? null; }
export const scoreFailure = (id: string): { code: string; message: string } | null => errors.get(id) ?? null;
function remember(id: string, error: { code: string; message: string }) { errors.set(id, error); while (errors.size > 200) errors.delete(errors.keys().next().value as string); }
export async function runScore(job: Job, signal: AbortSignal, update: JobProgress): Promise<Record<string, unknown>> {
  const token = String((job.input as { token?: string } | null)?.token ?? "");
  const jobInput = unstashScore(token);
  const input = jobInput?.input ?? "";
  const output = scoreOutputDir(job.id);
  try {
    if (!existsSync(input)) throw new Error("The audio file is missing. Send it again or choose an existing file on the Stack host.");
    rmSync(output, { recursive: true, force: true }); mkdirSync(output, { recursive: true, mode: 0o700 });
    const deps = getScoreDeps(); await deps.ensure((phase) => update({ status: phase, percent: 1 }), signal);
    const ffmpeg = await deps.ffmpeg((phase) => update({ status: phase, percent: 2 }), signal);
    const end = heavyGate.begin("music");
    try {
      const tracker = new GenTracker("score", "audio", () => Date.now(), 1, () => false);
      const result = await deps.runWorker({ id: job.id, input, output_dir: output, ffmpeg }, signal, (stage, fraction) => {
        tracker.enter(stage, fraction === null ? null : Math.round(fraction * 1000), fraction === null ? null : 1000);
        update({ status: stage, percent: Math.max(2, Math.round(tracker.snapshot().fraction * 100)) });
      });
      if (!result.ok) { remember(job.id, { code: result.code ?? "failed", message: result.error ?? "The score could not be made. Check the audio file and try again." }); throw new Error(result.error ?? "The score could not be made. Check the audio file and try again."); }
      if (!existsSync(join(output, `${job.id}.mid`)) || !existsSync(join(output, `${job.id}.notes.json`))) throw new Error("The score engine did not save both result files. Try again.");
      recordRun(tracker.key, tracker.finish()); update({ status: "ready", percent: 100 });
      return { tempo_bpm: result.tempo_bpm ?? 120, notes: result.notes ?? 0, ms: result.ms ?? 0 };
    } finally { end(); }
  } catch (error) { if (!errors.has(job.id)) remember(job.id, { code: "failed", message: error instanceof Error ? error.message : "The score could not be made. Try again." }); throw error; }
  finally { if (jobInput?.owned) rmSync(input, { force: true }); }
}
export function registerScoreJobs(): void { registerJobRunner(SCORE_JOB_KIND, runScore, { generator: { role: "music", memory: () => ({ requestedBytes: SCORE_PEAK_BYTES, measuredPeakBytes: null, engine: "score-gen" }) } }); }
