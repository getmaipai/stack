// The job runners behind POST /v1/audio/music (MUSIC-GEN-02). The job record
// (which Home lists and the event feed carries) holds only the task, the length,
// the quality and the seed; the description, the lyrics, the title and the
// source song wait in memory under a token the route made, are taken by the
// runner once, and are never written to a record, a log or the results folder.
// Two kinds share one runner: `music_generation` is queued on the generator
// queue and holds the governor's admission for the whole song; `music_edit`
// (trim, fade, loudness: CPU only, under a second) takes no admission. Both go
// through the one service chain, so the worker is never shared concurrently.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerJobRunner, type Job, type JobProgress } from "@/lib/jobs";
import { STACK_MUSIC_MODEL_ID } from "@/lib/modelCatalog";
import { GenTracker, recordRun } from "@/lib/genProgress";
import { commitResult, rememberLrc, workDir, type MusicResultMeta } from "./results";
import { recordMadeSong } from "./provenance";
import { musicAdmissionBytes, MusicError, musicGen, SONG_FILE, type MusicRunFields } from "./musicGen";

export const MUSIC_JOB_KIND = "music_generation";
export const MUSIC_EDIT_JOB_KIND = "music_edit";
export const isMusicJob = (kind: string): boolean => kind === MUSIC_JOB_KIND || kind === MUSIC_EDIT_JOB_KIND;

export interface StashedSong {
  /** Everything the worker needs except the source path, the output path and the machine's own paths. */
  fields: Omit<MusicRunFields, "source">;
  /** The song to start from (bytes of an m4a this Stack made), or null. */
  source: Uint8Array | null;
  /** Where this job's stage times are kept for the ETA. */
  historyKey: string;
}
const pending = new Map<string, StashedSong & { at: number }>();
const STASH_TTL_MS = 30 * 60_000;
/** A song cancelled or refused before its runner started never takes its stash, so anything older than half an hour goes. */
export function stashSong(token: string, song: StashedSong): void {
  const now = Date.now();
  for (const [key, value] of pending) if (now - value.at > STASH_TTL_MS) pending.delete(key);
  pending.set(token, { ...song, at: now });
}
export function unstashSong(token: string): StashedSong | null {
  const song = pending.get(token) ?? null;
  pending.delete(token);
  if (!song) return null;
  const { at: _at, ...rest } = song;
  return rest;
}

/** The history bucket of a job: the task, and for a new song its length (a minute takes longer than half a minute). */
export function musicHistoryKey(task: string, durationS: number | undefined): string {
  if (task !== "text2music") return `music:${task}`;
  const seconds = durationS ?? 60;
  return `music:text2music:${seconds <= 30 ? 30 : seconds <= 60 ? 60 : seconds <= 120 ? 120 : 240}`;
}

const failures = new Map<string, { code: string; message: string; status: number }>();
export function musicFailure(job: string): { code: string; message: string; status: number } | null { return failures.get(job) ?? null; }
/** Stages of the songs in flight, for the status route. */
const trackers = new Map<string, GenTracker>();
export function musicTracker(job: string): GenTracker | null { return trackers.get(job) ?? null; }
function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.set(key, value);
  while (map.size > 200) map.delete(map.keys().next().value as string);
}

export interface MusicJobResult { job: string; model: string; task: string; duration_s: number; seed: number | null; ms: number; }

async function runSong(job: Job, signal: AbortSignal, update: JobProgress): Promise<MusicJobResult> {
  const token = String((job.input as { token?: string } | null)?.token ?? "");
  const song = unstashSong(token);
  if (!song) throw new MusicError("failed", "The request was not received. Send it again.", 400);
  const work = workDir(job.id);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true, mode: 0o700 });
  try {
    let sourcePath: string | undefined;
    if (song.source) { sourcePath = join(work, "source.m4a"); writeFileSync(sourcePath, song.source, { mode: 0o600 }); }
    const outputDir = join(work, "out");
    const started = Date.now();
    const tracker = new GenTracker("music", song.historyKey);
    remember(trackers, job.id, tracker);
    const result = await musicGen.run({ fields: { ...song.fields, ...(sourcePath ? { source: sourcePath } : {}) }, outputDir }, {
      jobId: job.id, signal,
      onStage: (stage, fraction) => {
        tracker.enter(stage, fraction === null ? null : Math.round(fraction * 1000), fraction === null ? null : 1000);
        update({ status: stage, percent: Math.round(tracker.snapshot().fraction * 100) });
      },
    });
    recordRun(tracker.key, tracker.finish());
    const file = join(outputDir, SONG_FILE);
    const bytes = new Uint8Array(readFileSync(file));
    // Every song file this Stack writes counts as made here, so a later change may start from it.
    recordMadeSong(bytes);
    const edit = song.fields.op === "edit";
    const meta: MusicResultMeta = {
      job: job.id, created: Math.floor(new Date(job.createdAt).getTime() / 1000), task: result.task, duration_s: result.duration_s, seed: result.seed,
      model: edit ? "none" : STACK_MUSIC_MODEL_ID, ms: Date.now() - started, bytes: bytes.length, mlx_peak_gb: result.peakBytes === null ? null : Math.round(result.peakBytes / 1e8) / 10,
    };
    update({ status: "ready", percent: 100 });
    commitResult(meta, outputDir);
    rememberLrc(job.id, result.lrc);
    return { job: job.id, model: meta.model, task: meta.task, duration_s: meta.duration_s, seed: meta.seed, ms: meta.ms };
  } catch (error) {
    if (!signal.aborted && error instanceof MusicError) remember(failures, job.id, { code: error.code, message: error.message, status: error.status });
    else if (!signal.aborted) remember(failures, job.id, { code: "failed", message: error instanceof Error ? error.message : String(error), status: 500 });
    throw error;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function registerMusicJobs(): void {
  registerJobRunner(MUSIC_JOB_KIND, runSong, { generator: { role: "music", memory: () => { const bytes = musicAdmissionBytes(); return { requestedBytes: bytes, measuredPeakBytes: bytes, engine: "music-gen" }; } } });
  registerJobRunner(MUSIC_EDIT_JOB_KIND, runSong);
}
