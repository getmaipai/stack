import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";
import { logger } from "@/lib/log";
import { imageToolsTmpDir, sweepImageToolsTmp } from "@/imagetools/imageTools";
import { jobsDir, sweepJobDirs } from "@/media/paths";
import { sweepVideoTmp, sweepResults as sweepVideoResults } from "@/video/results";
import { sweepMusicTmp, sweepResults as sweepMusicResults } from "@/music/results";
import { sweepImageTmp, sweepResults as sweepImageResults } from "@/images/results";
import { modelsDir } from "@/lib/paths";
import { sweepPartialDownloads } from "@/lib/download";

export interface SweepEntry { name: string; removed: number; bytes: number; }
export interface SweepSummary { reason: string; removed_files: number; freed_bytes: number; per_sweep: SweepEntry[]; }

export function folderBytes(dir: string): number {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  return entries.reduce((sum, entry) => {
    const path = join(dir, entry.name);
    try { return sum + (entry.isDirectory() ? folderBytes(path) : entry.isFile() ? statSync(path).size : 0); } catch { return sum; }
  }, 0);
}

export function sweepVoiceClips(now = Date.now()): number {
  const dir = voiceClipDir();
  return sweepVoiceClipDir(dir, now);
}

export function voiceClipDir(): string { return join(dataDir, "tmp", "voice-clips"); }

function sweepVoiceClipDir(dir: string, now: number): number {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(dir, entry.name);
    try { if (now - statSync(path).mtimeMs > 24 * 3600_000) { rmSync(path, { force: true }); removed++; } } catch { /* Already gone. */ }
  }
  return removed;
}

export function runSweeps(reason: string): SweepSummary {
  const summary: SweepSummary = { reason, removed_files: 0, freed_bytes: 0, per_sweep: [] };
  // The tmp folders hold the working files of jobs that are running now, so they are emptied only at start, when no job can be running.
  const atStart = reason === "start";
  const tasks: Array<[string, () => number | void, string]> = [
    ...(atStart ? [["image-tools-tmp", sweepImageToolsTmp, imageToolsTmpDir()] as [string, () => number | void, string]] : []),
    ["media-job-dirs", sweepJobDirs, jobsDir()],
    ...(atStart ? [["video-tmp", sweepVideoTmp, join(dataDir, "tmp", "video")] as [string, () => number | void, string]] : []),
    ["video-results", sweepVideoResults, join(dataDir, "video", "results")],
    ...(atStart ? [["music-tmp", sweepMusicTmp, join(dataDir, "tmp", "music")] as [string, () => number | void, string]] : []),
    ["music-results", sweepMusicResults, join(dataDir, "music", "results")],
    ...(atStart ? [["image-tmp", sweepImageTmp, join(dataDir, "tmp", "images")] as [string, () => number | void, string]] : []),
    ["image-results", sweepImageResults, join(dataDir, "images", "results")],
    ["partial-downloads", () => sweepPartialDownloads(), modelsDir],
    ["voice-clips", () => sweepVoiceClips(), voiceClipDir()],
  ];
  for (const [name, sweep, dir] of tasks) {
    try {
      const before = folderBytes(dir);
      const result = sweep();
      const bytes = Math.max(0, before - folderBytes(dir));
      const removed = typeof result === "number" ? result : bytes > 0 ? 1 : 0;
      summary.per_sweep.push({ name, removed, bytes });
      summary.removed_files += removed;
      summary.freed_bytes += bytes;
    } catch {
      summary.per_sweep.push({ name, removed: 0, bytes: 0 });
    }
  }
  if (summary.removed_files > 0) logger.appendLine(JSON.stringify({ event: "sweep.done", ...summary }));
  return summary;
}
