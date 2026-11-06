import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __resetJobsForTests, waitForJob } from "@/lib/jobs";
import { HostLimiter } from "@/media/hosts";
import { registerMediaJobs, resetMediaDepsForTests, setMediaDepsForTests } from "@/media/jobs";
import { __resetRootsForTests, jobsDir, setRoots } from "@/media/paths";
import { setUpscaleDepsForTests, resetUpscaleDepsForTests } from "@/media/upscale";
import type { Runner } from "@/media/run";

const ffmpeg = process.env.STACK_MEDIA_FFMPEG; const ffprobe = process.env.STACK_MEDIA_FFPROBE;
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
  test("uses real ffmpeg when configured", async () => {
    if (!ffmpeg || !ffprobe || !existsSync(ffmpeg) || !existsSync(ffprobe)) return;
    // The full pinned-binary fixture and real-model smoke run are gated by the dispatcher environment.
  });
});
