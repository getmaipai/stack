import { expect, test } from "bun:test";
import { seriesFromFrames } from "@/media/clipCheck";
import { afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __resetJobsForTests, waitForJob } from "@/lib/jobs";
import { mediaDeps, registerMediaJobs, resetMediaDepsForTests, setMediaDepsForTests } from "@/media/jobs";
import { __resetRootsForTests, jobsDir, setRoots } from "@/media/paths";
import type { Runner, RunResult } from "@/media/run";
import type { MediaToolbox } from "@/media/tools";

let root: string; let outside: string;
const good: RunResult = { code: 0, stdout: "", stderr: "", aborted: false };
const toolbox: MediaToolbox = { installed: () => true, path: async (tool) => `/fake/bin/${tool}` };
const runner: Runner = async (argv) => argv[0]!.endsWith("ffprobe") ? { ...good, stdout: JSON.stringify({ format: { duration: "1" }, streams: [{ index: 0, codec_type: "audio", codec_name: "aac" }] }) } : good;
beforeEach(() => {
  __resetJobsForTests(); __resetRootsForTests(); root = realpathSync(mkdtempSync(join(tmpdir(), "media-check-"))); outside = realpathSync(mkdtempSync(join(tmpdir(), "media-check-out-")));
  setRoots({ read: [root] }); setMediaDepsForTests({ toolbox, run: runner }); registerMediaJobs();
});
afterEach(() => { __resetJobsForTests(); __resetRootsForTests(); resetMediaDepsForTests(); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); rmSync(jobsDir(), { recursive: true, force: true }); });
async function submit(path: string): Promise<{ status: number; body: any }> {
  const response = await app.request("/stack/v1/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "media.check", input: { path } }) });
  return { status: response.status, body: await response.json() };
}

const frame = (w: number, h: number, value: (x: number, y: number) => number): Uint8Array => {
  const bytes = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) bytes[y * w + x] = value(x, y);
  return bytes;
};

test("clip series reports black, frozen, and sudden-change stretches", () => {
  const w = 16; const h = 16;
  const black = frame(w, h, () => 0);
  const white = frame(w, h, () => 255);
  const result = seriesFromFrames([black, black.slice(), black.slice(), white], w, h);
  expect(result.luma.slice(0, 3)).toEqual([0, 0, 0]);
  expect(result.diff).toEqual([0, 0, 0, 255]);
});

test("Laplacian variance separates a blurred patch from noise", () => {
  const w = 32; const h = 32;
  const blurred = frame(w, h, (x, y) => ((x >> 2) + (y >> 2)) % 2 ? 230 : 25);
  const noisy = frame(w, h, (x, y) => (x * 73 + y * 151 + x * y * 19) & 255);
  const result = seriesFromFrames([blurred, noisy], w, h);
  expect(result.sharpness[1]!).toBeGreaterThan(result.sharpness[0]!);
});

test("global flow estimates a three pixel right shift", () => {
  const w = 64; const h = 48;
  const pattern = (x: number, y: number) => ((x * 73 + y * 151 + x * y * 19) & 255);
  const first = frame(w, h, pattern);
  const shifted = frame(w, h, (x, y) => pattern(Math.max(0, x - 3), y));
  const result = seriesFromFrames([first, shifted], w, h, true);
  expect(result.flow).toHaveLength(1);
  expect(result.flow![0]!.dx).toBeCloseTo(3, 0);
});

test("media.check refuses paths outside allowed folders", async () => {
  const secret = join(outside, "audio.m4a"); writeFileSync(secret, "x");
  const result = await submit(secret);
  expect(result.status).toBe(422); expect(result.body.code).toBe("path_outside_roots");
});

test("media.check refuses an audio only file with a plain next step", async () => {
  const file = join(root, "audio.m4a"); writeFileSync(file, "x");
  const { status, body } = await submit(file);
  expect(status).toBe(202);
  const job = await waitForJob(body.job.id, 5000);
  expect(job).toMatchObject({ state: "failed", result: { failure: { code: "bad_input", message: "This file has no video track to check. Choose a video file and try again." } } });
});
