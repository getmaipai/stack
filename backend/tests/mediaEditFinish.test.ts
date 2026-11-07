import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __resetJobsForTests, waitForJob } from "@/lib/jobs";
import { gradeArgs, reframeArgs, speedArgs, captionsArgs, editInputProblem } from "@/media/editOps";
import { registerMediaJobs, resetMediaDepsForTests, setMediaDepsForTests } from "@/media/jobs";
import { __resetRootsForTests, jobsDir, setRoots } from "@/media/paths";
import { normalizeProbe } from "@/media/probe";
import { spawnRunner } from "@/media/run";
import type { MediaToolbox } from "@/media/tools";

let root = "";
const probe = (w = 640, h = 360, audio = true) => normalizeProbe({ format: { format_name: "mov,mp4", duration: "2" }, streams: [{ index: 0, codec_type: "video", codec_name: "h264", width: w, height: h, pix_fmt: "yuv420p", avg_frame_rate: "24/1" }, ...(audio ? [{ index: 1, codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000" }] : [])], chapters: [] }, "/x.mp4", 1);
const clip = (audio = true) => ({ path: "/x.mp4", probe: probe(640, 360, audio) });
const fakeToolbox: MediaToolbox = { installed: () => true, path: async (tool) => `/fake/${tool}` };
async function post(input: unknown) { const r = await app.request("/stack/v1/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "media.edit", input }) }); return { status: r.status, body: await r.json() as any }; }
beforeEach(() => { __resetJobsForTests(); __resetRootsForTests(); root = realpathSync(mkdtempSync(join(tmpdir(), "edit-finish-"))); writeFileSync(join(root, "x.mp4"), "x"); setRoots({ read: [root], write: [root] }); registerMediaJobs(); });
afterEach(() => { __resetJobsForTests(); __resetRootsForTests(); resetMediaDepsForTests(); rmSync(root, { recursive: true, force: true }); rmSync(jobsDir(), { recursive: true, force: true }); });

describe("media.edit finishing operation plans", () => {
  test("reframe chooses capped even dimensions and blur graph", () => {
    const args = reframeArgs("ffmpeg", clip(), "/o.mp4", { op: "reframe", aspect: "9:16", fill: "blur" });
    expect(args.join(" ")).toContain("scale=720:1280");
  });
  test("grade, speed, and caption argv are pure argument lists", () => {
    const grade = gradeArgs("ffmpeg", clip(), "/o.mp4", { op: "grade", brightness: 0.1, contrast: 0.2, saturation: 0.3, warmth: 0.2, grain: 0.1, vignette: 0.2 });
    expect(grade).toContain("-vf"); expect(grade.join(" ")).toContain("colorbalance"); expect(grade.join(" ")).toContain("noise=");
    const speed = speedArgs("ffmpeg", clip(), "/o.mp4", { op: "speed", factor: 4 });
    expect(speed.join(" ")).toContain("setpts=PTS/4"); expect(speed.join(" ")).toContain("atempo=2,atempo=2");
    const text = "quote' colon: slash\\ percent% %{x}\nnext";
    const captions = captionsArgs("ffmpeg", clip(), "/o.mp4", { op: "captions", position: "bottom", lines: [{ from_s: 0, to_s: 1, text }] }, "/System/Library/Fonts/Helvetica.ttc");
    expect(captions.join(" ")).not.toContain("text='quote' colon:");
    expect(captions.join(" ")).toContain("\\%"); expect(captions.join(" ")).toContain("\\nnext");
  });
  test("bad values are refused at submit", async () => {
    const base = { inputs: [join(root, "x.mp4")], output: { name: "o.mp4" } };
    expect(editInputProblem({ ...base, ops: [{ op: "reframe", aspect: "2:3", fill: "crop" }] })).not.toBeNull();
    expect(editInputProblem({ ...base, ops: [{ op: "grade", brightness: 0, contrast: 0, saturation: 0, warmth: 0, grain: 0, vignette: 0 }] })).toMatch(/at least one/);
    expect(editInputProblem({ ...base, ops: [{ op: "speed", factor: 0.1 }] })).toMatch(/factor/);
    expect(editInputProblem({ ...base, ops: [{ op: "captions", position: "bottom", lines: Array.from({ length: 2001 }, () => ({ from_s: 0, to_s: 1, text: "hi" })) }] })).toMatch(/2000/);
    expect(editInputProblem({ ...base, ops: [{ op: "captions", position: "bottom", lines: [{ from_s: 0, to_s: 1, text: "' : \\ %{\n" }] }] })).toBeNull();
    expect((await post({ ...base, ops: [{ op: "speed", factor: 0.1 }] })).status).toBe(422);
  });
});

const findTool = (name: string): string | null => {
  const configured = process.env[name === "ffmpeg" ? "STACK_MEDIA_FFMPEG" : "STACK_MEDIA_FFPROBE"];
  if (configured && existsSync(configured)) return configured;
  for (const path of [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`]) if (existsSync(path)) return path;
  return null;
};
const ffmpeg = findTool("ffmpeg"); const ffprobe = findTool("ffprobe");
const real = ffmpeg && ffprobe ? describe : describe.skip;
if (!(ffmpeg && ffprobe)) console.warn("media.edit finish real-ffmpeg test skipped: ffmpeg and ffprobe are required.");
real("media.edit finishing operations with ffmpeg", () => {
  test("reframe, grade, speed, captions produce a 1 second portrait clip", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "edit-finish-real-"))); const source = join(dir, "in.mp4");
    const made = await spawnRunner([ffmpeg!, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=24:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source]);
    expect(made.code).toBe(0);
    setRoots({ read: [dir], write: [dir] });
    const tools: MediaToolbox = { installed: () => true, path: async (tool) => tool === "ffmpeg" ? ffmpeg! : ffprobe! };
    setMediaDepsForTests({ toolbox: tools, run: spawnRunner });
    const response = await post({ inputs: [source], ops: [{ op: "reframe", aspect: "9:16", fill: "blur" }, { op: "grade", brightness: 0.05, saturation: 0.1 }, { op: "speed", factor: 2 }, { op: "captions", position: "bottom", lines: [{ from_s: 0, to_s: 1, text: "A safe caption" }] }], output: { dir, name: "out.mp4" } });
    expect(response.status).toBe(202);
    const job: any = await waitForJob(response.body.job.id, 120_000);
    expect(job?.state).toBe("done"); expect(existsSync(join(dir, "out.mp4"))).toBe(true);
    expect(job?.result?.width).toBe(720); expect(job?.result?.height).toBe(1280); expect(job?.result?.duration_s).toBeGreaterThan(0.85); expect(job?.result?.duration_s).toBeLessThan(1.15);
    rmSync(dir, { recursive: true, force: true });
  }, 150_000);
});
