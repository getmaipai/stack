import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerJobRunner, type Job, type JobProgress } from "@/lib/jobs";
import { GenTracker, recordRun } from "@/lib/genProgress";
import { workDir } from "@/music/results";
import { log } from "@/lib/log";
import { beats, BEATS_MAX_SECONDS, BEATS_PEAK_BYTES, type BeatsResult } from "./beats";

export const BEATS_JOB_KIND = "beats_analysis";
type Output = Omit<BeatsResult, "ms">;
const failures = new Map<string, { code: string; message: string }>(); const stages = new Map<string, string>(); const trackers = new Map<string, GenTracker>(); const results = new Map<string, Output>();
export const beatsFailure = (id: string) => failures.get(id) ?? null; export const beatsStage = (id: string) => stages.get(id) ?? null; export const beatsTracker = (id: string) => trackers.get(id) ?? null; export const beatsOutput = (id: string) => results.get(id) ?? null; export const forgetBeatsOutput = (id: string) => results.delete(id);
const stash = new Map<string, { source: Uint8Array; at: number }>();
export function stashBeats(token: string, source: Uint8Array) { const now = Date.now(); for (const [key, value] of stash) if (now - value.at > 30 * 60_000) stash.delete(key); stash.set(token, { source, at: now }); }
export function unstashBeats(token: string) { stash.delete(token); }
export function __beatsStashHasForTests(token: string) { return stash.has(token); }
async function run(job: Job, signal: AbortSignal, update: JobProgress) { const input = job.input as { token: string } | null; const payload = stash.get(input?.token ?? ""); stash.delete(input?.token ?? ""); if (!payload) throw new Error("The request was not received. Send it again."); const work = workDir(job.id); rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true, mode: 0o700 }); try { const source = join(work, "source.audio"); writeFileSync(source, payload.source, { mode: 0o600 }); const tracker = new GenTracker("music", "beats"); trackers.set(job.id, tracker); const started = Date.now(); const result = await beats.run({ id: job.id, source, workDir: work, maxSeconds: BEATS_MAX_SECONDS }, (stage, fraction) => { stages.set(job.id, stage); tracker.enter(stage === "loading" ? "load" : "music"); update({ status: stage, percent: Math.round(fraction * 100) }); }, signal); recordRun(tracker.key, tracker.finish()); const { ms, ...output } = result; results.set(job.id, output); if (results.size > 32) results.delete(results.keys().next().value as string); log(JSON.stringify({ event: "beats.done", beats: result.beats.length, sections: result.sections.length, ms: Date.now() - started })); update({ status: "ready", percent: 100 }); return { job: job.id, ms: Date.now() - started, beats: result.beats.length }; } catch (error) { if (!signal.aborted) { failures.set(job.id, { code: "failed", message: "The beat analysis failed. Try again." }); log(JSON.stringify({ event: "beats.failed" })); } throw error; } finally { rmSync(work, { recursive: true, force: true }); } }
export function registerBeatsJobs() { registerJobRunner(BEATS_JOB_KIND, run, { generator: { role: "music", memory: () => ({ requestedBytes: BEATS_PEAK_BYTES, measuredPeakBytes: BEATS_PEAK_BYTES, engine: "beats" }) } }); }
