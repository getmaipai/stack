import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";
import { commitResult, deleteResult, readTake, sweepResults, takePath, workDir, type VideoResultMeta } from "@/video/results";

const job = (n: number) => `job-00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const facts = { route: "words", operation: "clip_text", level: "standard", shape: "landscape", seed: 17, part: "minimax-h3", pack_version: "1", recipe: { level: "standard", steps: 7 } };
beforeEach(() => { rmSync(join(dataDir, "video"), { recursive: true, force: true }); rmSync(join(dataDir, "loras"), { recursive: true, force: true }); });
afterEach(() => { rmSync(join(dataDir, "video"), { recursive: true, force: true }); rmSync(join(dataDir, "loras"), { recursive: true, force: true }); });

test("commit writes only the take facts, mode 0600, and deleteResult leaves the record", () => {
  const id = job(1), work = workDir(id); mkdirSync(work, { recursive: true }); writeFileSync(join(work, "video.mp4"), "v"); writeFileSync(join(work, "poster.jpg"), "p");
  const meta: VideoResultMeta = { job: id, created: 123, width: 10, height: 10, frames: 1, fps: 24, seconds: 0, seed: 17, model: "m", mode: "text-to-video", lora_ids: [], ms: 1, bytes: 1, poster_bytes: 1, mlx_peak_gb: null };
  commitResult(meta, work, undefined, facts, Date.now());
  const record = JSON.parse(readFileSync(takePath(id), "utf8"));
  expect(Object.keys(record).sort()).toEqual(["at", "job", "level", "operation", "pack_version", "part", "recipe", "route", "seed", "shape"].sort());
  expect(record).toEqual({ job: id, at: expect.any(Number), ...facts });
  expect(readTake(id)).toEqual(record);
  expect(deleteResult(id)).toBe(true);
  expect(readTake(id)).toEqual(record);
});

test("sweep removes take records older than 30 days and beyond the newest 500", () => {
  const takes = join(dataDir, "video", "takes"); mkdirSync(takes, { recursive: true });
  const now = Date.now();
  for (let n = 1; n <= 502; n++) {
    const path = takePath(job(n));
    writeFileSync(path, JSON.stringify({ job: job(n), at: now - (502 - n) * 10_000 }));
    const stamp = new Date(now - (502 - n) * 10_000);
    utimesSync(path, stamp, stamp);
  }
  const expired = takePath(job(503)); writeFileSync(expired, JSON.stringify({ job: job(503), at: now - 31 * 86400_000 }));
  utimesSync(expired, new Date(now - 31 * 86400_000), new Date(now - 31 * 86400_000));
  sweepResults(now);
  expect(readTake(job(1))).toBeNull();
  expect(readTake(job(2))).toBeNull();
  expect(readTake(job(3))).not.toBeNull();
  expect(readTake(job(503))).toBeNull();
});

test("the Stack's own finished result is a valid extend or retake source without a declared media folder; any other path is not", async () => {
  const { ownResultVideo, resultsRoot } = await import("@/video/results");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const job = "job-00000000-0000-0000-0000-000000000001";
  mkdirSync(join(resultsRoot(), job), { recursive: true });
  writeFileSync(join(resultsRoot(), job, "video.mp4"), "x");
  expect(ownResultVideo(join(resultsRoot(), job, "video.mp4"))).toContain(`${job}/video.mp4`);
  expect(ownResultVideo(join(resultsRoot(), job, "poster.jpg"))).toBeNull();
  expect(ownResultVideo(join(resultsRoot(), "..", "video.mp4"))).toBeNull();
  expect(ownResultVideo("/etc/hosts")).toBeNull();
  expect(ownResultVideo(undefined)).toBeNull();
});
