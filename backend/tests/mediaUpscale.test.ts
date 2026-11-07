import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __resetJobsForTests, waitForJob } from "@/lib/jobs";
import { HostLimiter } from "@/media/hosts";
import { registerMediaJobs, resetMediaDepsForTests, setMediaDepsForTests } from "@/media/jobs";
import { __resetRootsForTests, jobsDir, setRoots } from "@/media/paths";
import { spawnRunner } from "@/media/run";
import { defaultToolbox } from "@/media/tools";
import { setUpscaleDepsForTests, resetUpscaleDepsForTests } from "@/media/upscale";
import type { Runner } from "@/media/run";

const ffmpeg = process.env.STACK_MEDIA_FFMPEG; const ffprobe = process.env.STACK_MEDIA_FFPROBE;
const realBinaries = !!(ffmpeg && ffprobe && existsSync(ffmpeg) && existsSync(ffprobe));
let root = ""; let frameCount = 0; let signalGate: (() => void) | null = null;
async function submit(input: unknown): Promise<any> {
  const response = await app.request("/stack/v1/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "media.edit", input }) });
  const body = await response.json() as any;
  if (response.status !== 202) throw new Error(JSON.stringify(body));
  return waitForJob(body.job.id, 120_000);
}
let probeWidth = 64; let probeHeight = 48;
const fakeProbe = (path: string) => JSON.stringify({ format: { format_name: "mp4", duration: "0.5" }, streams: [{ index: 0, codec_type: "video", codec_name: "h264", width: path.includes("sharp.mp4") || path.includes(".part.mp4") ? 128 : probeWidth, height: path.includes("sharp.mp4") || path.includes(".part.mp4") ? 96 : probeHeight, pix_fmt: "yuv420p", avg_frame_rate: "24/1" }, { index: 1, codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000" }] });

beforeEach(() => {
  __resetJobsForTests(); __resetRootsForTests(); resetMediaDepsForTests(); resetUpscaleDepsForTests();
  root = realpathSync(mkdtempSync(join(tmpdir(), "media-upscale-"))); setRoots({ read: [root], write: [root] }); frameCount = 0; signalGate = null; probeWidth = 64; probeHeight = 48;
  const run: Runner = async (argv, options) => {
    if (argv[0]?.endsWith("ffprobe")) return { code: 0, stdout: fakeProbe(argv.at(-1)!), stderr: "", aborted: false };
    const output = argv.at(-1)!;
    if (output.includes("%04d.png")) { for (let i = 1; i <= 8; i++) writeFileSync(output.replace("%04d", String(i).padStart(4, "0")), "png"); }
    else if (output.endsWith(".mp4")) writeFileSync(output, "result");
    else if (output.endsWith(".mkv")) writeFileSync(output, "segment");
    return { code: 0, stdout: "", stderr: "", aborted: options?.signal?.aborted ?? false };
  };
  setMediaDepsForTests({ toolbox: { installed: () => true, path: async (tool) => `/fake/${tool}` }, run, limiter: new HostLimiter() });
  setUpscaleDepsForTests({ runImage: async (_input, options = {}) => { frameCount++; if (signalGate && frameCount === 3) { signalGate(); await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true })); } return { png: new Uint8Array([1, 2, 3]), width: 256, height: 192, operation: "upscale", engine: "fake", model: "fake", ms: 1 } as any; } });
  registerMediaJobs();
});
afterEach(() => { __resetJobsForTests(); __resetRootsForTests(); resetMediaDepsForTests(); resetUpscaleDepsForTests(); rmSync(root, { recursive: true, force: true }); rmSync(jobsDir(), { recursive: true, force: true }); });

// The fakes above never reach the tool, so the drift regressions below build real clips with the
// operator's ffmpeg and drive the op through the real runner, keeping only the image tools fake.
async function realMake(out: string, args: string[]): Promise<void> {
  const child = Bun.spawn([ffmpeg!, "-hide_banner", "-loglevel", "error", "-y", ...args], { stdout: "ignore", stderr: "pipe" });
  const code = await child.exited;
  if (code !== 0) throw new Error(await new Response(child.stderr).text());
}
// A 24 fps clip at the reported odd size (770x447, kept with 4:4:4 so the height stays odd), spliced
// with a tone via stream copy so the container length is the tone's, not the frames': that is how a
// real file can name one more frame than it holds. A short tone keeps the container at the frame length.
async function realClip(name: string, frames: string, tone: string): Promise<string> {
  const video = join(root, `${name}.v.mp4`), toneFile = join(root, `${name}.a.m4a`), out = join(root, `${name}.mp4`);
  await realMake(video, ["-f", "lavfi", "-i", "testsrc=rate=24:size=770x447", "-frames:v", frames, "-r", "24", "-c:v", "libx264", "-pix_fmt", "yuv444p", video]);
  await realMake(toneFile, ["-f", "lavfi", "-i", `sine=frequency=440:duration=${tone}`, "-c:a", "aac", toneFile]);
  await realMake(out, ["-i", video, "-i", toneFile, "-c", "copy", out]);
  return out;
}
function realFrameCount(path: string): Promise<number> {
  return new Promise((resolve) => {
    const child = Bun.spawn([ffprobe!, "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", "-i", path], { stdout: "pipe", stderr: "ignore" });
    (async () => { const text = await new Response(child.stdout).text(); await child.exited; resolve(parseInt(text.trim(), 10) ?? -1); })();
  });
}
// Run the op with the real ffmpeg/ffprobe and an image tool that passes the extracted frame through.
function realDeps(): void {
  setMediaDepsForTests({ toolbox: defaultToolbox, run: spawnRunner, limiter: new HostLimiter() });
  setUpscaleDepsForTests({ runImage: async (input) => ({ png: input.image, width: 2, height: 2, operation: "upscale", engine: "fake", model: "fake", ms: 1 }) as any });
}

describe("media.edit upscale", () => {
  test("accepts factor 2 only and reports the new operation", async () => {
    const input = join(root, "clip.mp4"); writeFileSync(input, "source");
    const done = await submit({ inputs: [input], ops: [{ op: "upscale", factor: 2 }], output: { name: "sharp.mp4" } });
    expect(done.state).toBe("done"); expect(done.result.steps).toEqual([{ op: "upscale", action: "upscale" }]); expect(done.result.width).toBe(128); expect(frameCount).toBeGreaterThan(0);
  });
  test("maps missing model and admission failures to the requested plain sentences", async () => {
    const input = join(root, "clip.mp4"); writeFileSync(input, "source");
    for (const [code, message] of [["model_missing", "The sharpening model is not installed yet. An admin can add it in Settings, Models and storage."], ["no_memory", "Home is busy with something larger. Try again in a minute."]] as const) {
      setUpscaleDepsForTests({ runImage: async () => { const error = new Error("failed") as Error & { code: string }; error.code = code; throw error; } });
      const result = await submit({ inputs: [input], ops: [{ op: "upscale" }], output: { name: `fail-${code}.mp4` } });
      expect(result.result.failure.message).toBe(message);
    }
  });
  test("cancellation removes the output and private temporary directory", async () => {
    const input = join(root, "clip.mp4"); writeFileSync(input, "source");
    const started = new Promise<void>((resolve) => { signalGate = resolve; });
    const response = await app.request("/stack/v1/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "media.edit", input: { inputs: [input], ops: [{ op: "upscale" }], output: { name: "cancelled.mp4" } } }) });
    const body = await response.json() as any; await started;
    await app.request(`/stack/v1/jobs/${body.job.id}`, { method: "DELETE" });
    const ended = await waitForJob(body.job.id, 5000);
    expect(ended?.state).toBe("cancelled"); expect(existsSync(join(root, "cancelled.mp4"))).toBe(false);
    expect(frameCount).toBe(3);
  });
  test("rejects dimensions above six megapixels before processing frames", async () => {
    const input = join(root, "clip.mp4"); writeFileSync(input, "source"); probeWidth = 3000; probeHeight = 3000;
    const result = await submit({ inputs: [input], ops: [{ op: "upscale" }], output: { name: "big.mp4" } });
    expect(result.state).toBe("failed"); expect(result.result.failure.message).toMatch(/6 megapixel/); expect(frameCount).toBe(0);
  });
  // Real ffmpeg regressions. A clip can name one more frame than it holds (a longer track sets the
  // container length); the frame loop must then stop at the files that exist, not at the probe's count,
  // which is what used to read a missing frame and die at 99%. Skipped unless the binaries are present.
  const real = realBinaries ? test : test.skip;
  real("sharpening a clip whose container names one more frame than it holds (72 frames, multiple of the batch)", async () => {
    const clip = await realClip("over", "72", "3.06"); realDeps();
    const done = await submit({ inputs: [clip], ops: [{ op: "upscale", factor: 2 }], output: { name: "over-sharp.mp4" } });
    expect(done.state).toBe("done"); expect(done.result.width).toBe(1540); expect(done.result.height).toBe(894);
    // The output holds the 72 frames that decode, not a phantom 73rd the probe predicted.
    expect(await realFrameCount(done.result.path)).toBe(72);
  }, 180_000);
  real("sharpening a clip that names one more frame than it holds and is not a multiple of the batch (71 frames)", async () => {
    const clip = await realClip("odd", "71", "3.00"); realDeps();
    const done = await submit({ inputs: [clip], ops: [{ op: "upscale", factor: 2 }], output: { name: "odd-sharp.mp4" } });
    expect(done.state).toBe("done"); expect(done.result.width).toBe(1540); expect(done.result.height).toBe(894);
  }, 180_000);
  real("sharpening a clip whose container matches its frames keeps every frame (72 frames, multiple of the batch)", async () => {
    const clip = await realClip("flat", "72", "2.90"); realDeps();
    const done = await submit({ inputs: [clip], ops: [{ op: "upscale", factor: 2 }], output: { name: "flat-sharp.mp4" } });
    expect(done.state).toBe("done"); expect(done.result.width).toBe(1540); expect(done.result.height).toBe(894);
    // The sound is shorter than the film, so the finished clip ends with the last sound, not the last frame.
    expect(await realFrameCount(done.result.path)).toBe(69);
  }, 180_000);
  real("sharpening a clip whose container matches its frames and is not a multiple of the batch (73 frames)", async () => {
    const clip = await realClip("tail", "73", "3.05"); realDeps();
    const done = await submit({ inputs: [clip], ops: [{ op: "upscale", factor: 2 }], output: { name: "tail-sharp.mp4" } });
    expect(done.state).toBe("done"); expect(done.result.width).toBe(1540); expect(done.result.height).toBe(894);
    expect(await realFrameCount(done.result.path)).toBe(73);
  }, 180_000);
});
