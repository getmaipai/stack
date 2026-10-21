import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __resetJobsForTests, waitForJob } from "@/lib/jobs";
import { registerMediaJobs, resetMediaDepsForTests, setMediaDepsForTests } from "@/media/jobs";
import { __resetRootsForTests, jobsDir, setRoots } from "@/media/paths";
import { spawnRunner } from "@/media/run";
import type { RunOptions, RunResult } from "@/media/run";
import { parseProbe } from "@/video/messages";

const ffmpeg = "/Users/jessetorres/.cache/uv/archive-v0/_tZvViE2XqBtGyd7/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1";
const priorNoNice = process.env.STACK_MEDIA_NO_NICE;
process.env.STACK_MEDIA_NO_NICE = "1";
const real = existsSync(ffmpeg) ? test : test.skip;
let root = "", green = "", magenta = "";
let passthroughRun: (argv: string[], options?: RunOptions) => Promise<RunResult>;

async function command(args: string[]): Promise<void> {
  const result = await spawnRunner([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", ...args]);
  if (result.code !== 0) throw new Error(result.stderr);
}
async function makeCircle(path: string, colour: string): Promise<void> {
  const background = `color=c=${colour}:s=320x180:r=24:d=3`;
  const circle = `color=c=red:s=64x64:r=24:d=3,format=rgba,geq=r='255':g='0':b='0':a='if(lte((X-32)^2+(Y-32)^2,900),255,0)'`;
  const position = `[0:v][1:v]overlay=x='128+55*cos(2*PI*t/3)':y='58+35*sin(2*PI*t/3)':shortest=1,format=yuv420p`;
  await command(["-f", "lavfi", "-i", background, "-f", "lavfi", "-i", circle, "-filter_complex", position, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", path]);
}
async function submit(input: Record<string, unknown>) {
  const id = await start(input);
  return await waitForJob(id, 120_000) as any;
}
async function start(input: Record<string, unknown>): Promise<string> {
  const response = await app.request("/stack/v1/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "media.companion_clip", input }) });
  const body = await response.json() as any;
  if (response.status !== 202) throw new Error(`refused ${response.status}: ${JSON.stringify(body)}`);
  return body.job.id;
}
async function info(path: string) { return spawnRunner([ffmpeg, "-hide_banner", "-i", path]); }
async function rawRgba(path: string, frame: number): Promise<Uint8Array> {
  const output = `${path}.frame-${frame}.rgba`;
  const result = await spawnRunner([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", path, "-vf", `select=eq(n\\,${frame})`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", output]);
  if (result.code !== 0) throw new Error(result.stderr);
  return new Uint8Array(readFileSync(output));
}
async function stillDiscCentre(path: string): Promise<{ x: number; y: number }> {
  const output = `${path}.rgba`;
  const result = await spawnRunner([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", output]);
  if (result.code !== 0) throw new Error(result.stderr);
  const pixels = new Uint8Array(readFileSync(output));
  let minX = 480, minY = 480, maxX = -1, maxY = -1;
  for (let y = 0; y < 480; y++) for (let x = 0; x < 480; x++) if (pixels[(y * 480 + x) * 4 + 3]! > 128) {
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  if (maxX < 0) throw new Error("still has no opaque disc pixels");
  return { x: Math.round((minX + maxX) / 2), y: Math.round((minY + maxY) / 2) };
}
function pixel(frame: Uint8Array, x: number, y: number): number[] {
  const offset = (y * 480 + x) * 4;
  return [...frame.slice(offset, offset + 3)];
}

beforeAll(async () => {
  if (!existsSync(ffmpeg)) return;
  __resetJobsForTests(); __resetRootsForTests();
  root = realpathSync(mkdtempSync(join(tmpdir(), "companion-real-")));
  green = join(root, "green.mp4"); magenta = join(root, "magenta.mp4");
  setRoots({ read: [root], write: [root] });
  await makeCircle(green, "#00FF00"); await makeCircle(magenta, "#FF00FF");
  passthroughRun = async (argv, options) => {
      if (argv[0] === "/test/ffprobe") {
        const path = argv[argv.length - 1]!;
        const probed = await spawnRunner([ffmpeg, "-hide_banner", "-i", path], { signal: options?.signal });
        const facts = parseProbe(probed.stderr);
        const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(probed.stderr);
        const seconds = duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : null;
        const raw = { format: { format_name: path.endsWith(".mp4") ? "mov,mp4,m4a" : "png", duration: seconds === null ? null : String(seconds) }, streams: facts.videoCodec ? [{ index: 0, codec_type: "video", codec_name: facts.videoCodec, width: facts.width, height: facts.height, pix_fmt: facts.pixelFormat, avg_frame_rate: "24/1", disposition: { attached_pic: 0 } }] : [] };
        return { code: 0, stdout: JSON.stringify(raw), stderr: "", aborted: false };
      }
      return spawnRunner(argv, options);
  };
  setMediaDepsForTests({
    toolbox: { installed: () => true, path: async (tool) => tool === "ffprobe" ? "/test/ffprobe" : ffmpeg },
    run: passthroughRun,
  });
  registerMediaJobs();
});
afterAll(() => {
  if (priorNoNice === undefined) delete process.env.STACK_MEDIA_NO_NICE;
  else process.env.STACK_MEDIA_NO_NICE = priorNoNice;
  if (!existsSync(ffmpeg)) return;
  __resetJobsForTests(); __resetRootsForTests(); resetMediaDepsForTests();
  rmSync(root, { recursive: true, force: true }); rmSync(jobsDir(), { recursive: true, force: true });
});

real("green and magenta clips produce a 480x960 alpha-stack mp4 and straight-alpha still", async () => {
  for (const [path, key] of [[green, "#00FF00"], [magenta, "#FF00FF"]] as const) {
    const done = await submit({ path, key, kind: "loop", min_seconds: 3, max_seconds: 3, colours: ["#FF0000"], output_dir: root, output_name: `out-${key.slice(1, 3)}` });
    expect(done.state).toBe("done");
    expect(done.result).toMatchObject({ ok: true, fps: 24, width: 480, height: 960, av1: true });
    const report = JSON.parse(await Bun.file(done.result.report_path).text());
    expect(report.files.find((file: any) => file.name === "clip.h264.mp4").bytes).toBeLessThanOrEqual(614400);
    const video = await info(join(root, `out-${key.slice(1, 3)}`, "clip.h264.mp4"));
    expect(video.stderr).toContain("480x960"); expect(video.stderr).toMatch(/24 fps/); expect(video.stderr).not.toContain("Audio:");
    const stillPath = join(root, `out-${key.slice(1, 3)}`, "still.png");
    expect(statSync(stillPath).size).toBeGreaterThan(100);
    const stillInfo = await info(stillPath); expect(stillInfo.stderr).toContain("480x480"); expect(stillInfo.stderr).toContain("rgba");
    expect((await rawRgba(stillPath, 0))[3]).toBe(0);
    const centre = await stillDiscCentre(stillPath);
    for (const filename of ["clip.h264.mp4", ...(report.av1 ? ["clip.av1.mp4"] : [])]) {
      const frame = await rawRgba(join(root, `out-${key.slice(1, 3)}`, filename), Math.floor(report.frames / 2));
      const top = pixel(frame, centre.x, centre.y);
      const matte = pixel(frame, centre.x, centre.y + 480);
      const corner = pixel(frame, 0, 0);
      expect(top[0]).toBeGreaterThan(180);
      expect(top[1]).toBeLessThan(70); expect(top[2]).toBeLessThan(70);
      expect(matte.every((channel) => channel > 200)).toBe(true);
      expect(corner.every((channel) => channel < 40)).toBe(true);
    }
  }
}, 180_000);

real("wrong character colours fail quality, and opaque input with key none fails no_alpha", async () => {
  const wrong = await submit({ path: green, key: "#00FF00", kind: "loop", min_seconds: 3, max_seconds: 3, colours: ["#0000FF"], output_dir: root, output_name: "wrong" });
  expect(wrong.result.ok).toBe(false); expect(wrong.result.reasons.join(" ")).toContain("colours");
  const noAlpha = await submit({ path: green, key: "none", kind: "loop", min_seconds: 1, max_seconds: 3, output_dir: root, output_name: "no-alpha" });
  expect(noAlpha.state).toBe("failed"); expect(noAlpha.result.failure.code).toBe("no_alpha");
}, 180_000);

real("cancelling during encoding removes every generated and partial file", async () => {
  let signalEncoding!: () => void;
  const encoding = new Promise<void>((resolve) => { signalEncoding = resolve; });
  setMediaDepsForTests({ run: async (argv, options) => {
    if (argv.includes("-encoders")) {
      signalEncoding();
      return await new Promise<RunResult>((resolve) => options?.signal?.addEventListener("abort", () => resolve({ code: null, stdout: "", stderr: "", aborted: true }), { once: true }));
    }
    return passthroughRun(argv, options);
  } });
  const id = await start({ path: green, key: "#00FF00", kind: "loop", min_seconds: 3, max_seconds: 3, output_dir: root, output_name: "cancelled" });
  await encoding;
  await app.request(`/stack/v1/jobs/${id}`, { method: "DELETE" });
  const done = await waitForJob(id, 120_000) as any;
  expect(done.state).toBe("cancelled");
  expect(readdirSync(join(root, "cancelled"))).toEqual([]);
  setMediaDepsForTests({ run: passthroughRun });
}, 180_000);
