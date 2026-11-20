// VF-RECEIPT-01: the receipt, the native file and the delivered file, without a model. The job-API side (a clip made through the route, the
// receipt route, the log) is in videoGen.test.ts beside the scripted worker.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackVideoReceipt } from "@maipai/spec/stack/ts/stack-video-receipt.js";
import { deliverClip } from "@/video/deliver";
import { buildReceipt, phaseDurations, setReceiptProbeForTests, sha256Hex, type ReceiptFile } from "@/video/receipt";
import { commitResult, nativePath, readReceipt, readResult, receiptPath, resultsRoot, sweepResults, videoPath, workDir, type VideoResultMeta } from "@/video/results";
import { deriveDelivered } from "@/video/videoGen";
import { commitCompositeSwap } from "@/video/swap";
import { dataDir } from "@/lib/paths";

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "receipt-")); });
afterEach(() => { setReceiptProbeForTests(null); rmSync(dir, { recursive: true, force: true }); rmSync(join(dataDir, "video"), { recursive: true, force: true }); delete process.env.VIDEO_RESULT_KEEP; });

const file = (width: number, height: number, bytes = 10): ReceiptFile => ({ width, height, frames: 121, fps: 24, seconds: 5.04, audio: true, bytes });
const sizes = (map: Record<string, ReceiptFile>) => setReceiptProbeForTests(async (path) => map[path.split("/").pop()!] ?? null);

test("the receipt holds the prompt as a byte count and a hash, and inputs as a role and a hash, never text or a file name", () => {
  const prompt = "une chanson très secrète: the key is under the pot";
  const receipt = buildReceipt({
    job: "job-1", operation: "generate", madeAt: new Date("2026-11-20T10:00:00Z"), runtime: { id: "engine-a", revision: "abc1234" }, model: { id: "model-a", build: "distilled", quantization: "bf16" },
    steps: { count: 11, schedule: "8 + 3" }, adapter: null, inputs: [{ role: "start", sha256: sha256Hex("photo-bytes"), bytes: 11 }], requested: { width: 1920, height: 1088, frames: 121, seconds: 5 },
    native: file(1920, 1088), delivered: file(1280, 720), deliveredIs: "messaging_copy", seed: 7, phases: [{ name: "rendering", ms: 1000 }], peakBytes: null, finish: [], prompt,
  });
  expect(receipt.prompt).toEqual({ bytes: new TextEncoder().encode(prompt).length, sha256: sha256Hex(prompt) });
  expect(new TextEncoder().encode(prompt).length).toBeGreaterThan(prompt.length);   // bytes, not characters
  const text = JSON.stringify(receipt);
  expect(text).not.toContain("secrète"); expect(text).not.toContain("under the pot"); expect(text).not.toContain("photo-bytes"); expect(text).not.toContain(".png");
  expect(StackVideoReceipt.safeParse(receipt).success).toBe(true);
  expect(StackVideoReceipt.safeParse({ ...receipt, prompt: { ...receipt.prompt, text: prompt } }).success).toBe(false);
  expect(StackVideoReceipt.safeParse({ ...receipt, inputs: [{ ...receipt.inputs[0], name: "photo.png" }] }).success).toBe(false);
});

test("a receipt with a bad hash is refused rather than written", () => {
  expect(() => buildReceipt({
    job: "job-1", operation: "swap", madeAt: new Date(), runtime: { id: "a", revision: "b" }, model: { id: "m", build: "b", quantization: null }, steps: { count: null, schedule: null }, adapter: null,
    inputs: [{ role: "source_clip", sha256: "short", bytes: 1 }], requested: { width: 640, height: 480, frames: 49, seconds: 2 }, native: file(640, 480), delivered: file(640, 480), deliveredIs: "native",
    seed: null, phases: [], peakBytes: null, finish: [], prompt: "",
  })).toThrow();
});

test("phase times add up the time each phase was in, in the order entered", () => {
  expect(phaseDurations([{ name: "waiting", at: 0 }, { name: "loading", at: 100 }, { name: "rendering", at: 300 }, { name: "rendering", at: 400 }], 1000)).toEqual([{ name: "waiting", ms: 100 }, { name: "loading", ms: 200 }, { name: "rendering", ms: 700 }]);
});

test("the model's file is set aside as native.mp4 and never rewritten; the derived copy is the delivered video.mp4", async () => {
  const output = join(dir, "video.mp4"), native = join(dir, "native.mp4");
  writeFileSync(output, "NATIVE-BYTES");
  const kind = await deriveDelivered(output, native, async (from, to) => { expect(readFileSync(from, "utf8")).toBe("NATIVE-BYTES"); writeFileSync(to, "DERIVED"); });
  expect(kind).toBe("messaging_copy");
  expect(readFileSync(native, "utf8")).toBe("NATIVE-BYTES");   // not rewritten in place
  expect(readFileSync(output, "utf8")).toBe("DERIVED");
});

test("a derived copy that fails leaves the native bytes delivered, and the native file is still kept", async () => {
  const output = join(dir, "video.mp4"), native = join(dir, "native.mp4");
  writeFileSync(output, "NATIVE-BYTES");
  const kind = await deriveDelivered(output, native, async () => { throw new Error("ffmpeg failed"); });
  expect(kind).toBeUndefined();
  expect(readFileSync(output, "utf8")).toBe("NATIVE-BYTES"); expect(readFileSync(native, "utf8")).toBe("NATIVE-BYTES");
});

test("an H3 finish works on a copy: native.mp4 keeps the model's bytes, video.mp4 is the finished one, the poster is cut again and both sizes are probed", async () => {
  writeFileSync(join(dir, "video.mp4"), "H3-NATIVE"); writeFileSync(join(dir, "poster.jpg"), "OLD-POSTER");
  sizes({ "native.mp4": file(864, 480), "video.mp4": file(1728, 960) });
  let poster = "";
  const made = await deliverClip({
    outputDir: dir, derivedByGenerator: false, reported: { width: 864, height: 480, frames: 121, fps: 24, audio: true },
    finish: async (path) => { writeFileSync(path, "H3-FINISHED"); },
    recutPoster: async (video, target) => { poster = readFileSync(video, "utf8"); writeFileSync(target, "NEW-POSTER"); },
  });
  expect(readFileSync(join(dir, "native.mp4"), "utf8")).toBe("H3-NATIVE");
  expect(readFileSync(join(dir, "video.mp4"), "utf8")).toBe("H3-FINISHED");
  expect(readFileSync(join(dir, "poster.jpg"), "utf8")).toBe("NEW-POSTER"); expect(poster).toBe("H3-FINISHED");
  expect(made).toMatchObject({ keptNative: true, deliveredIs: "finished" });
  expect([made.native.width, made.native.height, made.delivered.width, made.delivered.height]).toEqual([864, 480, 1728, 960]);   // true sizes, not the generator's
  expect(made.finish).toEqual([{ operation: "model_upscale", from: { width: 864, height: 480 }, to: { width: 1728, height: 960 }, ok: true, code: null }]);
});

test("a failed H3 finish leaves the native file delivered, says so in the receipt, and keeps the poster", async () => {
  writeFileSync(join(dir, "video.mp4"), "H3-NATIVE"); writeFileSync(join(dir, "poster.jpg"), "OLD-POSTER");
  sizes({ "native.mp4": file(864, 480), "video.mp4": file(864, 480) });
  const made = await deliverClip({
    outputDir: dir, derivedByGenerator: false, reported: { width: 864, height: 480, frames: 121, fps: 24, audio: true },
    finish: async () => { throw new Error("upscale failed"); }, recutPoster: async () => { throw new Error("must not be called"); },
  });
  expect(readFileSync(join(dir, "video.mp4"), "utf8")).toBe("H3-NATIVE"); expect(readFileSync(join(dir, "poster.jpg"), "utf8")).toBe("OLD-POSTER");
  expect(made).toMatchObject({ deliveredIs: "native", keptNative: true });
  expect(made.finish).toEqual([{ operation: "model_upscale", from: { width: 864, height: 480 }, to: { width: 864, height: 480 }, ok: false, code: "finish_failed" }]);
});

test("a cancelled finish is a cancel, not a failed finish", async () => {
  writeFileSync(join(dir, "video.mp4"), "H3-NATIVE");
  const controller = new AbortController();
  await expect(deliverClip({
    outputDir: dir, derivedByGenerator: false, signal: controller.signal, reported: { width: 864, height: 480, frames: 121, fps: 24, audio: true },
    finish: async () => { controller.abort(); throw new Error("aborted"); }, recutPoster: async () => {},
  })).rejects.toThrow("aborted");
});

test("with no finish and no derived copy the native file is the delivered one and nothing is duplicated", async () => {
  writeFileSync(join(dir, "video.mp4"), "NATIVE");
  sizes({ "video.mp4": file(768, 448) });
  const made = await deliverClip({ outputDir: dir, derivedByGenerator: false, reported: { width: 1, height: 1, frames: 1, fps: 24, audio: false }, finish: null, recutPoster: async () => {} });
  expect(existsSync(join(dir, "native.mp4"))).toBe(false);
  expect(made).toMatchObject({ keptNative: false, deliveredIs: "native", finish: [] });
  expect(made.delivered).toEqual(made.native); expect(made.delivered.width).toBe(768);   // read from the file, not from the report
});

test("the generator's report stands in only when a file cannot be probed, with the file's real byte count", async () => {
  writeFileSync(join(dir, "video.mp4"), "ABCDEFGH");
  setReceiptProbeForTests(async () => null);
  const made = await deliverClip({ outputDir: dir, derivedByGenerator: false, reported: { width: 832, height: 480, frames: 121, fps: 24, audio: true }, finish: null, recutPoster: async () => {} });
  expect(made.delivered).toMatchObject({ width: 832, height: 480, bytes: 8 });
});

function meta(job: string, over: Partial<VideoResultMeta> = {}): VideoResultMeta {
  return { job, created: 1, width: 832, height: 480, frames: 121, fps: 24, seconds: 5, seed: 1, model: "m", mode: "text-to-video", lora_ids: [], ms: 1, bytes: 1, poster_bytes: 1, mlx_peak_gb: null, ...over };
}
const jobId = (n: number) => `job-00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
function commit(n: number, receipt?: unknown): string {
  const job = jobId(n), work = workDir(job);
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "video.mp4"), `V${n}`); writeFileSync(join(work, "poster.jpg"), "P"); writeFileSync(join(work, "native.mp4"), `N${n}`);
  commitResult(meta(job), work, receipt);
  return job;
}

test("a result keeps its native file and its receipt beside the delivered clip, and reads them back", () => {
  const job = commit(1, { version: 1, note: "r" });
  expect(readFileSync(videoPath(job), "utf8")).toBe("V1"); expect(readFileSync(nativePath(job), "utf8")).toBe("N1");
  expect(readReceipt(job)).toEqual({ version: 1, note: "r" }); expect(existsSync(receiptPath(job))).toBe(true);
  expect(readResult(job)).not.toBeNull();
  expect(readReceipt("../../etc/passwd")).toBeNull();
  expect(readReceipt(jobId(99))).toBeNull();   // a result made before receipts has none
});

test("retention: a film of thirty shots loses no early shot's native file or receipt before the cut", () => {
  // The rule: results are kept for 24 hours and the newest 120 (it was the newest 24, which a film of more than 24 shots outran).
  const jobs = Array.from({ length: 30 }, (_, i) => commit(i + 1, { shot: i + 1 }));
  expect(sweepResults()).toBe(0);
  for (const job of jobs) { expect(existsSync(nativePath(job))).toBe(true); expect(readReceipt(job)).not.toBeNull(); }
  expect(resultsRoot()).toContain("video");
});

test("retention still has a bound: more than the window and the oldest go with their native file and receipt", () => {
  process.env.VIDEO_RESULT_KEEP = "2";
  const jobs = [1, 2, 3].map((n) => commit(n, { n }));
  expect(existsSync(nativePath(jobs[0]!))).toBe(false); expect(readReceipt(jobs[0]!)).toBeNull();
  expect(existsSync(nativePath(jobs[2]!))).toBe(true);
});

test("a swap's result tells the truth: its real byte counts, the swap mode, the sound of the delivered file, and a receipt that names its inputs by role and hash", async () => {
  const job = jobId(7), work = workDir(job);
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "video.mp4"), "SWAPPED-CLIP"); writeFileSync(join(work, "poster.jpg"), "POSTER");
  sizes({ "video.mp4": { ...file(1080, 1920, 12), audio: false } });
  await commitCompositeSwap({ job, width: 1080, height: 1920, fps: 30, frames: 90, seconds: 3, seed: 5, ms: 4000, peakBytes: 66 * 1024 ** 3, description: "swap the head", inputs: [{ role: "source_clip", sha256: sha256Hex("clip"), bytes: 4 }, { role: "identity", sha256: sha256Hex("face"), bytes: 4 }] }, work);
  expect(readResult(job)).toMatchObject({ mode: "swap", bytes: 12, poster_bytes: 6, audio: false, delivered_is: "native", native: { kept: false } });
  const receipt = StackVideoReceipt.parse(readReceipt(job));
  expect(receipt).toMatchObject({ operation: "swap", delivered_is: "native", finish: [], inputs: [{ role: "source_clip" }, { role: "identity" }] });
  expect(receipt.delivered).toEqual(receipt.native);
  expect(JSON.stringify(receipt)).not.toContain("swap the head");
});
