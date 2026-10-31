import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerJobRunner, type Job, type JobProgress } from "@/lib/jobs";
import { GenTracker, recordRun } from "@/lib/genProgress";
import { STEMS_MODEL_ID } from "./stems";
import { stems, STEMS_PEAK_BYTES, STEMS_OWNED_MAX_SECONDS, type StemName } from "./stems";
import { recordMadeSong, sha256Hex } from "@/music/provenance";
import { resultDir, workDir } from "@/music/results";
import { dataDir } from "@/lib/paths";

export const STEMS_JOB_KIND = "stems_generation";
export interface StemEntry { stem: StemName; url: string; content_type: "audio/mp4"; bytes: number; sha256: string; }
const failures = new Map<string, { code: string; message: string }>();
const stages = new Map<string, string>();
const trackers = new Map<string, GenTracker>();
export const stemsFailure = (id: string) => failures.get(id) ?? null;
export const stemsStage = (id: string) => stages.get(id) ?? null;
export const stemsTracker = (id: string) => trackers.get(id) ?? null;
const remember = <T>(map: Map<string, T>, key: string, value: T) => { map.set(key, value); if (map.size > 200) map.delete(map.keys().next().value as string); };

async function run(job: Job, signal: AbortSignal, update: JobProgress) {
  const input = job.input as { token: string; origin?: "made_here" | "owned_file" } | null;
  const owned = input?.origin === "owned_file";
  const payload = stash.get(input?.token ?? ""); stash.delete(input?.token ?? "");
  if (!payload) throw new Error("The request was not received. Send it again.");
  const work = workDir(job.id); rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true, mode: 0o700 });
  try {
    const sourcePath = join(work, "source.m4a"); writeFileSync(sourcePath, payload.source, { mode: 0o600 });
    const outputDir = join(work, "out"); mkdirSync(outputDir, { mode: 0o700 });
    const names: StemName[] = ["vocals", "drums", "bass", "other"];
    const outputs = Object.fromEntries(names.map((name) => [name, join(outputDir, `${name}.m4a`)])) as Record<StemName, string>;
    const started = Date.now();
    const tracker = new GenTracker("music", "stems:htdemucs");
    remember(trackers, job.id, tracker);
    const result = await stems.run({ id: job.id, source: sourcePath, outputs, ...(owned ? { maxSeconds: STEMS_OWNED_MAX_SECONDS } : {}) }, (stage, fraction) => { remember(stages, job.id, stage); tracker.enter(stage === "loading" ? "load" : stage === "splitting" ? "music" : "save"); update({ status: stage, percent: Math.round(fraction * 100) }); }, signal);
    recordRun(tracker.key, tracker.finish());
    const files = result.files.map((file) => {
      const bytes = new Uint8Array(readFileSync(file.path)); const sha256 = owned ? sha256Hex(bytes) : recordMadeSong(bytes);
      return { stem: file.stem, bytes: bytes.length, sha256, path: file.path };
    });
    commitStemsResult(job.id, files, outputDir);
    update({ status: "ready", percent: 100 });
    return { job: job.id, model: STEMS_MODEL_ID, ms: Date.now() - started, stems: files.map(({ stem, bytes, sha256 }) => ({ stem, url: `/v1/audio/stems/${job.id}/${stem}`, content_type: "audio/mp4" as const, bytes, sha256 })) };
  } catch (error) {
    if (!signal.aborted) remember(failures, job.id, { code: "failed", message: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

// The common music retention sweeper treats each job directory as one result;
// this manifest and the four files share the same TTL and newest-six policy.
const stash = new Map<string, { source: Uint8Array; at: number }>();
export function stashSource(token: string, source: Uint8Array): void { stash.set(token, { source, at: Date.now() }); }
export function unstashSource(token: string): void { stash.delete(token); }
export function registerStemsJobs(): void {
  registerJobRunner(STEMS_JOB_KIND, run, { generator: { role: "music", memory: () => ({ requestedBytes: STEMS_PEAK_BYTES, measuredPeakBytes: STEMS_PEAK_BYTES, engine: "stems" }) } });
}


/** Stem results share the music result directory and the music retention settings. */
function commitStemsResult(job: string, files: Array<{ stem: StemName; bytes: number; sha256: string; path: string }>, work: string): void {
  const target = resultDir(job);
  mkdirSync(join(dataDir, "music", "results"), { recursive: true, mode: 0o700 });
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { mode: 0o700 });
  for (const file of files) renameSync(file.path, join(target, `${file.stem}.m4a`));
  writeFileSync(join(target, "stems.json"), JSON.stringify({ job, created: Math.floor(Date.now() / 1000), model: STEMS_MODEL_ID, files: files.map(({ stem, bytes, sha256 }) => ({ stem, bytes, sha256 })) }), { mode: 0o600 });
  rmSync(work, { recursive: true, force: true });
  const newest = Number(process.env.MUSIC_RESULT_KEEP ?? 6); const ttl = Number(process.env.MUSIC_RESULT_TTL_MS ?? 10 * 60 * 1000);
  const root = join(dataDir, "music", "results");
  const dirs = readdirSync(root).filter((id) => /^job-[0-9a-f-]{36}$/.test(id)).map((id) => ({ id, at: statSync(join(root, id)).mtimeMs })).sort((a, b) => b.at - a.at);
  dirs.forEach((entry, index) => { if (index >= newest || Date.now() - entry.at > ttl) rmSync(join(root, entry.id), { recursive: true, force: true }); });
}
