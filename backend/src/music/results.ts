// MUSIC-GEN-02: where a finished song waits for Home to fetch it. One folder
// per job under data/music/results/<job>/ holding `song.m4a` (AAC-LC, 48 kHz
// stereo, faststart) and `meta.json` (seed, task, model, duration, timings).
// Neither the description, the lyrics, the title nor the lyric timings are
// ever written here (rule 6a): a record of what a person asked for is Home's,
// not the Stack's. Songs are held about ten minutes and the six newest; Home
// stores the file as an attachment and deletes the result the moment it has it.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";

export interface MusicResultMeta {
  job: string;
  created: number;
  task: string;
  duration_s: number;
  seed: number | null;
  /** The pinned model id, or "none" for an edit that ran no model. */
  model: string;
  ms: number;
  bytes: number;
  mlx_peak_gb: number | null;
}

const JOB_RE = /^job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isJobId = (value: string): boolean => JOB_RE.test(value);

const keepNewest = (): number => Number(process.env.MUSIC_RESULT_KEEP ?? 6);
const keepMs = (): number => Number(process.env.MUSIC_RESULT_TTL_MS ?? 10 * 60 * 1000);

export function resultsRoot(): string { return join(dataDir, "music", "results"); }
export function resultDir(job: string): string {
  if (!isJobId(job)) throw new Error("not a job id");
  return join(resultsRoot(), job);
}
export function workDir(job: string): string { return join(dataDir, "tmp", "music", job); }
export const songPath = (job: string): string => join(resultDir(job), "song.m4a");

/** The lyric timings of the songs in the result store, in memory only: the words are the person's, so they are never written to disk. A restart loses them (the answer then carries `lrc: null`). */
const lrcs = new Map<string, string>();
export function rememberLrc(job: string, lrc: string | null): void {
  if (lrc) lrcs.set(job, lrc); else lrcs.delete(job);
  while (lrcs.size > 12) lrcs.delete(lrcs.keys().next().value as string);
}
export const lrcOf = (job: string): string | null => lrcs.get(job) ?? null;

/** Moves a finished song from the job's work folder into the result store and writes its record. */
export function commitResult(meta: MusicResultMeta, work: string): void {
  const target = resultDir(meta.job);
  mkdirSync(resultsRoot(), { recursive: true, mode: 0o700 });
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { mode: 0o700 });
  renameSync(join(work, "song.m4a"), join(target, "song.m4a"));
  writeFileSync(join(target, "meta.json"), JSON.stringify(meta), { mode: 0o600 });
  rmSync(work, { recursive: true, force: true });
  sweepResults();
}

/** The record of a held song, or null when it is gone or past its ten minutes (an expired one is removed on the spot). */
export function readResult(job: string, now = Date.now()): MusicResultMeta | null {
  if (!isJobId(job)) return null;
  try {
    const meta = JSON.parse(readFileSync(join(resultDir(job), "meta.json"), "utf8")) as MusicResultMeta;
    if (!existsSync(songPath(job))) return null;
    if (now - statSync(resultDir(job)).mtimeMs > keepMs()) { deleteResult(job); return null; }
    return meta;
  } catch { return null; }
}

export function deleteResult(job: string): boolean {
  lrcs.delete(job);
  if (!isJobId(job) || !existsSync(resultDir(job))) return false;
  rmSync(resultDir(job), { recursive: true, force: true });
  return true;
}

/** Removes results older than the retention time and all but the newest few. */
export function sweepResults(now = Date.now()): number {
  let removed = 0;
  let entries: Array<{ job: string; at: number }> = [];
  try { entries = readdirSync(resultsRoot()).filter(isJobId).map((job) => ({ job, at: statSync(join(resultsRoot(), job)).mtimeMs })); } catch { return 0; }
  entries.sort((a, b) => b.at - a.at);
  entries.forEach((entry, index) => {
    if (index >= keepNewest() || now - entry.at > keepMs()) { rmSync(join(resultsRoot(), entry.job), { recursive: true, force: true }); lrcs.delete(entry.job); removed += 1; }
  });
  return removed;
}

/** Removes work folders an earlier crash left behind; called once when the Stack starts. */
export function sweepMusicTmp(): void {
  try { rmSync(join(dataDir, "tmp", "music"), { recursive: true, force: true }); } catch { /* nothing there */ }
}
