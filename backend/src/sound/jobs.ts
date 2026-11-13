// The job runner behind POST /v1/audio/sound (MP-07). The job record (which
// Home lists and the event feed carries) holds only the length, the steps and
// the seed; the description waits in memory under a token the route made, is
// taken by the runner once, and is never written to a record, a log or the
// results folder. `sound_generation` is queued on the music generator queue
// (one generator at a time per role) and holds the governor's admission for
// the whole sound. The finished file goes to the music result store: it is
// held, served and swept like a song, and it is recorded as made here, so
// Home can trim, fade or set the loudness of it later through the music edit.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { registerJobRunner, type Job, type JobProgress } from "@/lib/jobs";
import { heavyGate } from "@/lib/heavyGate";
import { STACK_SFX_MODEL_ID } from "@/lib/modelCatalog";
import { GenTracker, recordRun } from "@/lib/genProgress";
import { commitResult, workDir, type MusicResultMeta } from "@/music/results";
import { recordMadeSong } from "@/music/provenance";
import { SfxError, sfxGen, SFX_PEAK_BYTES, SOUND_FILE, type SfxRunFields } from "./sfxGen";

export const SOUND_JOB_KIND = "sound_generation";

const pending = new Map<string, { fields: SfxRunFields; at: number }>();
const STASH_TTL_MS = 30 * 60_000;
/** A sound cancelled or refused before its runner started never takes its stash, so anything older than half an hour goes. */
export function stashSound(token: string, fields: SfxRunFields): void {
  const now = Date.now();
  for (const [key, value] of pending) if (now - value.at > STASH_TTL_MS) pending.delete(key);
  pending.set(token, { fields, at: now });
}
export function unstashSound(token: string): SfxRunFields | null {
  const entry = pending.get(token) ?? null;
  pending.delete(token);
  return entry?.fields ?? null;
}

/** The history bucket of a sound: short, medium or long (a 47 s ambience takes longer than a 3 s one-shot). */
export function soundHistoryKey(seconds: number): string { return `sound:${seconds <= 5 ? 5 : seconds <= 15 ? 15 : 47}`; }

const failures = new Map<string, { code: string; message: string; status: number }>();
export function soundFailure(job: string): { code: string; message: string; status: number } | null { return failures.get(job) ?? null; }
const trackers = new Map<string, GenTracker>();
export function soundTracker(job: string): GenTracker | null { return trackers.get(job) ?? null; }
function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.set(key, value);
  while (map.size > 200) map.delete(map.keys().next().value as string);
}

export interface SoundJobResult { job: string; model: string; duration_s: number; seed: number; ms: number; }

async function runSound(job: Job, signal: AbortSignal, update: JobProgress): Promise<SoundJobResult> {
  const token = String((job.input as { token?: string } | null)?.token ?? "");
  const fields = unstashSound(token);
  if (!fields) throw new SfxError("failed", "The request was not received. Send it again.", 400);
  const work = workDir(job.id);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true, mode: 0o700 });
  try {
    const outputDir = join(work, "out");
    const started = Date.now();
    const pacing = heavyGate.pacing(job.id);
    const tracker = new GenTracker("sound", soundHistoryKey(fields.seconds), pacing.now, 1, pacing.paused);
    remember(trackers, job.id, tracker);
    const result = await sfxGen.run(fields, outputDir, {
      jobId: job.id, signal,
      onStage: (stage, fraction) => {
        tracker.enter(stage, fraction === null ? null : Math.round(fraction * 1000), fraction === null ? null : 1000);
        update({ status: stage, percent: Math.round(tracker.snapshot().fraction * 100) });
      },
    });
    recordRun(tracker.key, tracker.finish());
    const bytes = new Uint8Array(readFileSync(join(outputDir, SOUND_FILE)));
    // Every sound this Stack writes counts as made here, so a later music edit (trim, fade, loudness) may start from it.
    recordMadeSong(bytes);
    const meta: MusicResultMeta = {
      job: job.id, created: Math.floor(new Date(job.createdAt).getTime() / 1000), task: "sound", duration_s: result.duration_s, seed: result.seed,
      model: STACK_SFX_MODEL_ID, ms: Date.now() - started, bytes: bytes.length, mlx_peak_gb: result.peakBytes === null ? null : Math.round(result.peakBytes / 1e8) / 10,
    };
    update({ status: "ready", percent: 100 });
    commitResult(meta, outputDir);
    return { job: job.id, model: meta.model, duration_s: meta.duration_s, seed: result.seed, ms: meta.ms };
  } catch (error) {
    if (!signal.aborted && error instanceof SfxError) remember(failures, job.id, { code: error.code, message: error.message, status: error.status });
    else if (!signal.aborted) remember(failures, job.id, { code: "failed", message: error instanceof Error ? error.message : String(error), status: 500 });
    throw error;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function registerSoundJobs(): void {
  registerJobRunner(SOUND_JOB_KIND, runSound, { generator: { role: "music", memory: () => ({ requestedBytes: SFX_PEAK_BYTES, measuredPeakBytes: SFX_PEAK_BYTES, engine: "sfx-gen" }) } });
}
