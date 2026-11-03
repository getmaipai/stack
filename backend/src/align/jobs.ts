import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerJobRunner, type Job, type JobProgress } from "@/lib/jobs";
import { GenTracker, recordRun } from "@/lib/genProgress";
import { align, ALIGN_MAX_SECONDS, ALIGN_PEAK_BYTES, type AlignResult } from "./align";
import { workDir } from "@/music/results";
import { log } from "@/lib/log";

export const ALIGN_JOB_KIND = "align_generation";
export type AlignOutput = Pick<AlignResult, "words" | "aligned_words" | "total_words" | "line_starts">;
const failures = new Map<string, { code: string; message: string }>();
const stages = new Map<string, string>();
const trackers = new Map<string, GenTracker>();
/** The timed words are the person's lyrics, so they are held in memory only (as music holds `lrc`): never written to disk, gone on a restart. */
const results = new Map<string, AlignOutput>();
export const alignFailure = (id: string) => failures.get(id) ?? null;
export const alignStage = (id: string) => stages.get(id) ?? null;
export const alignTracker = (id: string) => trackers.get(id) ?? null;
export const alignOutput = (id: string) => results.get(id) ?? null;
export const forgetAlignOutput = (id: string) => { results.delete(id); };
const remember = <T>(map: Map<string, T>, key: string, value: T) => { map.set(key, value); if (map.size > 200) map.delete(map.keys().next().value as string); };

const stash = new Map<string, { source: Uint8Array; lyrics: string; at: number }>();
export function stashAlign(token: string, source: Uint8Array, lyrics: string): void { const now = Date.now(); for (const [key, value] of stash) if (now - value.at > 30 * 60_000) stash.delete(key); stash.set(token, { source, lyrics, at: now }); }
export function unstashAlign(token: string): void { stash.delete(token); }
export function __alignStashHasForTests(token: string): boolean { return stash.has(token); }

async function run(job: Job, signal: AbortSignal, update: JobProgress) {
  const input = job.input as { token: string; origin?: "made_here" | "owned_file" } | null;
  const payload = stash.get(input?.token ?? ""); stash.delete(input?.token ?? "");
  if (!payload) throw new Error("The request was not received. Send it again.");
  const work = workDir(job.id); rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true, mode: 0o700 });
  try {
    const sourcePath = join(work, "source.audio"); writeFileSync(sourcePath, payload.source, { mode: 0o600 });
    const tracker = new GenTracker("music", "align");
    remember(trackers, job.id, tracker);
    const started = Date.now();
    const result = await align.run({ id: job.id, source: sourcePath, lyrics: payload.lyrics, maxSeconds: ALIGN_MAX_SECONDS, workDir: work }, (stage, fraction) => { remember(stages, job.id, stage); tracker.enter(stage === "loading" ? "load" : "music"); update({ status: stage, percent: Math.round(fraction * 100) }); }, signal);
    recordRun(tracker.key, tracker.finish());
    const output: AlignOutput = { words: result.words, aligned_words: result.aligned_words, total_words: result.total_words, line_starts: result.line_starts };
    results.set(job.id, output); if (results.size > 12) results.delete(results.keys().next().value as string);
    // Rule 6a: counts and milliseconds only, never a lyric word or a file name.
    log(JSON.stringify({ event: "align.done", words: result.aligned_words, total: result.total_words, lines: result.line_starts.length, ms: Date.now() - started }));
    update({ status: "ready", percent: 100 });
    return { job: job.id, ms: Date.now() - started, aligned_words: result.aligned_words, total_words: result.total_words };
  } catch (error) {
    if (!signal.aborted) { remember(failures, job.id, { code: "failed", message: error instanceof Error ? error.message : String(error) }); log(JSON.stringify({ event: "align.failed" })); }
    throw error;
  } finally { rmSync(work, { recursive: true, force: true }); }
}
export function registerAlignJobs(): void {
  registerJobRunner(ALIGN_JOB_KIND, run, { generator: { role: "music", memory: () => ({ requestedBytes: ALIGN_PEAK_BYTES, measuredPeakBytes: ALIGN_PEAK_BYTES, engine: "align" }) } });
}
