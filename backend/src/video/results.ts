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
  /** Quick or LTX-2.5 (older results have none: Quick). */
  quality?: "quick" | "detailed" | "ltx25" | "ltx25max" | "h3" | "h3stream";
  /** The clip has a sound track the model made (older results have none: no). */
  audio?: boolean;
  mode: "text-to-video" | "image-to-video" | "extend" | "retake" | "ic_lora" | "swap";
  lora_ids: string[];
  /** ADULT-LOCK-04: the clip was made for an adult audience; the Stack serves it only to the full view. */
  audience?: "adult";
  ms: number;
  bytes: number;
  poster_bytes: number;
  mlx_peak_gb: number | null;
  /** VF-RECEIPT-01: the file the model made, kept as it was beside the delivered `video.mp4` (a finished or messaging-ready copy). Sizes only; the receipt itself holds the rest. */
  native?: { width: number; height: number; frames: number; bytes: number; kept: boolean };
  /** Which of the two `video.mp4` is: the model's own file, a finished (sharpened or enlarged) copy, or the messaging-ready copy. */
  delivered_is?: "native" | "finished" | "messaging_copy";
}

const JOB_RE = /^job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isJobId = (value: string): boolean => JOB_RE.test(value);

// VF-RECEIPT-01 retention rule: a result (its delivered file, its native file and its receipt) is kept for 24 hours and the newest 120 results.
// A film makes one clip per shot; 120 is far above any film the product plans (a 30 second film is about six shots), so the first shot's
// native file is still there when the cut is made. It was 24, which a film of more than 24 shots, or a busy hub, could outrun.
const keepNewest = (): number => Number(process.env.VIDEO_RESULT_KEEP ?? 120);
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
/** VF-RECEIPT-01: the model's own file when a derived copy replaced `video.mp4` as the delivered one. */
export const nativePath = (job: string): string => join(resultDir(job), "native.mp4");
/** VF-RECEIPT-01: the job's receipt, part of the owner's record (rule 6a): served on the owner's route only, never logged. */
export const receiptPath = (job: string): string => join(resultDir(job), "receipt.json");

/** Moves a finished clip from the job's work folder into the result store and writes its record. */
export function commitResult(meta: VideoResultMeta, work: string, receipt?: unknown): void {
  const target = resultDir(meta.job);
  mkdirSync(resultsRoot(), { recursive: true, mode: 0o700 });
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { mode: 0o700 });
  renameSync(join(work, "video.mp4"), join(target, "video.mp4"));
  renameSync(join(work, "poster.jpg"), join(target, "poster.jpg"));
  if (existsSync(join(work, "native.mp4"))) renameSync(join(work, "native.mp4"), join(target, "native.mp4"));
  writeFileSync(join(target, "meta.json"), JSON.stringify(meta), { mode: 0o600 });
  if (receipt !== undefined) writeFileSync(join(target, "receipt.json"), JSON.stringify(receipt), { mode: 0o600 });
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

/** The job's receipt, or null when it has none (an older result) or it cannot be read. */
export function readReceipt(job: string): unknown | null {
  if (!isJobId(job)) return null;
  try { return JSON.parse(readFileSync(receiptPath(job), "utf8")); } catch { return null; }
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
