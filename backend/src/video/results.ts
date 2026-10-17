// VIDEO-GEN-02: where a finished clip waits for Home to fetch it. One folder
// per job under data/video/results/<job>/ holding `video.mp4` (H.264, yuv420p,
// moov box first), `poster.jpg` (frame 0) and `meta.json` (seed, size, model,
// the LoRA ids and the timings). Neither the prompt nor the reference picture
// is ever written here: a record of what a person asked for is Home's, not the
// Stack's (rule 6a). Clips are kept for a day and the newest few; Home stores
// the file as an attachment and may delete the result the moment it has it.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";

export interface VideoResultMeta {
  job: string;
  created: number;
  width: number;
  height: number;
  frames: number;
  fps: number;
  seconds: number;
  seed: number;
  model: string;
  /** Quick or Detailed (older results have none: Quick). */
  quality?: "quick" | "detailed";
  /** The clip has a sound track the model made (older results have none: no). */
  audio?: boolean;
  mode: "text-to-video" | "image-to-video";
  lora_ids: string[];
  ms: number;
  bytes: number;
  poster_bytes: number;
  mlx_peak_gb: number | null;
}

const JOB_RE = /^job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isJobId = (value: string): boolean => JOB_RE.test(value);

const keepNewest = (): number => Number(process.env.VIDEO_RESULT_KEEP ?? 24);
const keepMs = (): number => Number(process.env.VIDEO_RESULT_TTL_MS ?? 24 * 60 * 60 * 1000);

export function resultsRoot(): string { return join(dataDir, "video", "results"); }
export function resultDir(job: string): string {
  if (!isJobId(job)) throw new Error("not a job id");
  return join(resultsRoot(), job);
}
export function workDir(job: string): string { return join(dataDir, "tmp", "video", job); }
export const videoPath = (job: string): string => join(resultDir(job), "video.mp4");
export const messagesPath = (job: string): string => join(resultDir(job), "messages.mp4");
export const posterPath = (job: string): string => join(resultDir(job), "poster.jpg");

/** Moves a finished clip from the job's work folder into the result store and writes its record. */
export function commitResult(meta: VideoResultMeta, work: string): void {
  const target = resultDir(meta.job);
  mkdirSync(resultsRoot(), { recursive: true, mode: 0o700 });
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { mode: 0o700 });
  renameSync(join(work, "video.mp4"), join(target, "video.mp4"));
  renameSync(join(work, "poster.jpg"), join(target, "poster.jpg"));
  writeFileSync(join(target, "meta.json"), JSON.stringify(meta), { mode: 0o600 });
  rmSync(work, { recursive: true, force: true });
  sweepResults();
}

export function readResult(job: string): VideoResultMeta | null {
  if (!isJobId(job)) return null;
  try {
    const meta = JSON.parse(readFileSync(join(resultDir(job), "meta.json"), "utf8")) as VideoResultMeta;
    return existsSync(videoPath(job)) ? meta : null;
  } catch { return null; }
}

export function deleteResult(job: string): boolean {
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
    if (index >= keepNewest() || now - entry.at > keepMs()) { rmSync(join(resultsRoot(), entry.job), { recursive: true, force: true }); removed += 1; }
  });
  return removed;
}

/** Removes work folders an earlier crash left behind; called once when the Stack starts. */
export function sweepVideoTmp(): void {
  try { rmSync(join(dataDir, "tmp", "video"), { recursive: true, force: true }); } catch { /* nothing there */ }
}
