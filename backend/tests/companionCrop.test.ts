// MAKER-A3: the shared pack frame. media.companion_clip takes an optional crop in source pixels; media.companion_track takes clip_stacked.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __resetJobsForTests, waitForJob } from "@/lib/jobs";
import { CompanionClipInput } from "@/media/commands";
import { companionCrop, cropInSourcePixels, resolveCompanionCrop } from "@/media/companionClip";
import { CompanionTrackInput, makerDeps } from "@/media/companionMaker";
import { registerMediaJobs, resetMediaDepsForTests, setMediaDepsForTests, STACKED_TOP_FILTER } from "@/media/jobs";
import { HostLimiter } from "@/media/hosts";
import { __resetRootsForTests, jobsDir, setRoots } from "@/media/paths";
import type { ImageToolResult } from "@/imagetools/imageTools";

const params = { path: "/x.mp4", key: "none", kind: "loop", min_seconds: 1, max_seconds: 2 };
let root: string; const original = makerDeps.run;
beforeEach(() => {
  __resetJobsForTests(); __resetRootsForTests();
  root = realpathSync(mkdtempSync(join(tmpdir(), "crop-root-")));
  setRoots({ read: [root], write: [root] });
});
afterEach(() => { makerDeps.run = original; __resetJobsForTests(); __resetRootsForTests(); resetMediaDepsForTests(); rmSync(root, { recursive: true, force: true }); rmSync(jobsDir(), { recursive: true, force: true }); });
async function run(kind: string, input: Record<string, unknown>): Promise<any> {
  const response = await app.request("/stack/v1/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, input }) });
  const body = await response.json() as any;
  if (response.status !== 202) throw new Error(`refused ${response.status}: ${JSON.stringify(body)}`);
  return waitForJob(body.job.id, 30_000);
}

test("the crop input is optional, whole numbers, and at least 64", () => {
  expect(CompanionClipInput.parse(params).crop).toBeUndefined();
  expect(CompanionClipInput.parse({ ...params, crop: { x: 10, y: 20, size: 300 } }).crop).toEqual({ x: 10, y: 20, size: 300 });
  expect(CompanionClipInput.safeParse({ ...params, crop: { x: 0, y: 0, size: 63 } }).success).toBe(false);
  expect(CompanionClipInput.safeParse({ ...params, crop: { x: 0.5, y: 0, size: 100 } }).success).toBe(false);
  expect(CompanionClipInput.safeParse({ ...params, crop: { x: 0, y: 0, size: 100, extra: 1 } }).success).toBe(false);
});

test("a crop in source pixels becomes the cut on the 480-high frames; a 480-high source is used as is", () => {
  expect(resolveCompanionCrop({ x: 100, y: 40, size: 300 }, 854, 480, 854, 480)).toEqual({ ok: true, frame: { x: 100, y: 40, size: 300 } });
  // a 1920x1080 source is decoded 854 wide: the square is scaled by 480 / 1080
  expect(resolveCompanionCrop({ x: 810, y: 0, size: 1080 }, 1920, 1080, 854, 480)).toEqual({ ok: true, frame: { x: 360, y: 0, size: 480 } });
  expect(cropInSourcePixels({ x: 360, y: 0, size: 480 }, 1080, 480)).toEqual({ x: 810, y: 0, size: 1080 });
});

test("a crop outside the clip, or under 64, is refused in words", () => {
  const outside = resolveCompanionCrop({ x: 600, y: 0, size: 300 }, 854, 480, 854, 480);
  expect(outside.ok).toBe(false); if (!outside.ok) expect(outside.message).toContain("not inside the 854x480 clip");
  expect(resolveCompanionCrop({ x: 0, y: 200, size: 300 }, 854, 480, 854, 480).ok).toBe(false);
  expect(resolveCompanionCrop({ x: -1, y: 0, size: 100 }, 854, 480, 854, 480).ok).toBe(false);
  const small = resolveCompanionCrop({ x: 0, y: 0, size: 63 }, 854, 480, 854, 480);
  expect(small.ok).toBe(false); if (!small.ok) expect(small.message).toContain("at least 64");
});

test("absent crop keeps the old behaviour: the cut is still the matte box with six percent padding", () => {
  const frame = new Uint8Array(100 * 100 * 4);
  for (let y = 40; y < 60; y++) for (let x = 30; x < 50; x++) frame[(y * 100 + x) * 4 + 3] = 255;
  expect(companionCrop([frame], 100, 100)).toEqual({ x: 29, y: 39, size: 22 });
});

test("a crop outside the frame fails the job in plain words, before any frame is decoded", async () => {
  const clip = join(root, "c.mp4"); writeFileSync(clip, "x");
  setMediaDepsForTests({ limiter: new HostLimiter(), toolbox: { installed: () => true, path: async (tool) => `/fake/bin/${tool}` }, run: async (argv) => {
    if (argv[0] === "/fake/bin/ffprobe") return { code: 0, aborted: false, stderr: "", stdout: JSON.stringify({ format: { format_name: "mov,mp4,m4a", duration: "3" }, streams: [{ index: 0, codec_type: "video", codec_name: "h264", width: 854, height: 480, pix_fmt: "yuv420p", avg_frame_rate: "24/1", disposition: { attached_pic: 0 } }] }) };
    return { code: 1, stdout: "", stderr: "must not decode", aborted: false };
  } });
  registerMediaJobs();
  const job = await run("media.companion_clip", { path: clip, key: "#00FF00", kind: "loop", min_seconds: 1, max_seconds: 3, output_dir: root, output_name: "o", crop: { x: 700, y: 0, size: 400 } });
  expect(job.state).toBe("failed");
  expect(JSON.stringify(job)).toContain("not inside the 854x480 clip");
});

test("clip_stacked needs a clip, and the clip is cut to its top square before tracking", async () => {
  expect(CompanionTrackInput.safeParse({ rest: "/r.png", frames_dir: "/f", clip_stacked: true }).success).toBe(false);
  expect(CompanionTrackInput.safeParse({ rest: "/r.png", clip: "/c.mp4", clip_stacked: true }).success).toBe(true);
  expect(CompanionTrackInput.parse({ rest: "/r.png", clip: "/c.mp4" }).clip_stacked).toBeUndefined();
  const argvs: string[][] = [];
  setMediaDepsForTests({ limiter: new HostLimiter(), toolbox: { installed: () => true, path: async (tool) => `/fake/bin/${tool}` }, run: async (argv) => { argvs.push(argv); writeFileSync(argv[argv.length - 1]!.replace("%05d", "00001"), "x"); return { code: 0, stdout: "", stderr: "", aborted: false }; } });
  registerMediaJobs();
  makerDeps.run = async (input) => ({ png: new Uint8Array(0), width: 0, height: 0, engine: "x", model: "none", ms: 1, operation: input.operation, track: { m: [[1, 0, 0, 0, 1, 0]], res: [0], cc: [1], low: [], frames: 1 } }) as ImageToolResult;
  const rest = join(root, "rest.png"), clip = join(root, "clip.mp4"); writeFileSync(rest, "png"); writeFileSync(clip, "x");
  const stacked = await run("media.companion_track", { rest, clip, clip_stacked: true });
  expect(stacked.result).toMatchObject({ ok: true });
  expect(argvs[0]).toContain("-vf"); expect(argvs[0]![argvs[0]!.indexOf("-vf") + 1]).toBe(STACKED_TOP_FILTER);
  expect(STACKED_TOP_FILTER).toBe("crop=iw:iw:0:0"); // 480x960 stacked -> 480x480
  const plain = await run("media.companion_track", { rest, clip, output_name: "plain" });
  expect(plain.result).toMatchObject({ ok: true });
  expect(argvs[1]).not.toContain("-vf");
});
