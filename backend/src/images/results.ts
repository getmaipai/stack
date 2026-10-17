// IMGGEN-STACK-02: where finished pictures wait for Home to fetch them. One
// folder per job under data/images/results/<job>/ holding `<n>.png` (a fresh
// PNG with no metadata), `<n>.thumb.jpg` (384 px, JPEG) and `meta.json` (seed,
// size, model, steps, the LoRA ids and timings). Neither the prompt nor any
// input picture is ever written here: a record of what a person asked for is
// Home's, not the Stack's (rule 6a). Results are kept for a day and the newest
// few jobs; Home stores the files as attachments and may delete a result the
// moment it has them.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";

export interface ImageResultItem { index: number; seed: number; width: number; height: number; bytes: number; thumb_bytes: number; }
export interface ImageResultMeta {
  job: string;
  created: number;
  mode: "generate" | "image-to-image" | "edit" | "edit-masked";
  model: string;
  steps: number;
  quantize: number | null;
  lora_ids: string[];
  ms: number;
  mlx_peak_gb: number | null;
  images: ImageResultItem[];
}

const JOB_RE = /^job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isJobId = (value: string): boolean => JOB_RE.test(value);

const keepNewest = (): number => Number(process.env.IMAGE_RESULT_KEEP ?? 48);
const keepMs = (): number => Number(process.env.IMAGE_RESULT_TTL_MS ?? 24 * 60 * 60 * 1000);

export function resultsRoot(): string { return join(dataDir, "images", "results"); }
export function resultDir(job: string): string {
  if (!isJobId(job)) throw new Error("not a job id");
  return join(resultsRoot(), job);
}
export function workDir(job: string): string { return join(dataDir, "tmp", "images", job); }
export const pngPath = (job: string, index: number): string => join(resultDir(job), `${index}.png`);
export const thumbPath = (job: string, index: number): string => join(resultDir(job), `${index}.thumb.jpg`);

/** Moves a finished job's pictures from its work folder into the result store and writes its record. */
export function commitResult(meta: ImageResultMeta, work: string): void {
  const target = resultDir(meta.job);
  mkdirSync(resultsRoot(), { recursive: true, mode: 0o700 });
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { mode: 0o700 });
  for (const item of meta.images) {
    renameSync(join(work, `${item.index}.png`), join(target, `${item.index}.png`));
    renameSync(join(work, `${item.index}.thumb.jpg`), join(target, `${item.index}.thumb.jpg`));
  }
  writeFileSync(join(target, "meta.json"), JSON.stringify(meta), { mode: 0o600 });
  rmSync(work, { recursive: true, force: true });
  sweepResults();
}

export function readResult(job: string): ImageResultMeta | null {
  if (!isJobId(job)) return null;
  try {
    const meta = JSON.parse(readFileSync(join(resultDir(job), "meta.json"), "utf8")) as ImageResultMeta;
    return meta.images.every((item) => existsSync(pngPath(job, item.index))) ? meta : null;
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
export function sweepImageTmp(): void {
  try { rmSync(join(dataDir, "tmp", "images"), { recursive: true, force: true }); } catch { /* nothing there */ }
}
