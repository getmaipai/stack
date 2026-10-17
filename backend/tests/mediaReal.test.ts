// MEDIA-STACK-01: the media jobs against the real pinned binaries. Skipped
// cleanly unless STACK_MEDIA_FFMPEG, STACK_MEDIA_FFPROBE and STACK_MEDIA_YTDLP
// name installed programs (a scratch STACK_DATA_DIR where the Stack installed
// them, or the operator's own). Never touches a video service: the fetch
// source is a localhost server in this file, read by yt-dlp's generic
// extractor (RULES.md V1); a second route answers 429 to prove quiet mode.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __resetJobsForTests, waitForJob } from "@/lib/jobs";
import { HostLimiter } from "@/media/hosts";
import { registerMediaJobs, resetMediaDepsForTests, setMediaDepsForTests } from "@/media/jobs";
import { __resetRootsForTests, jobsDir, setRoots } from "@/media/paths";
import { defaultToolbox } from "@/media/tools";

const ffmpeg = process.env.STACK_MEDIA_FFMPEG; const ffprobe = process.env.STACK_MEDIA_FFPROBE; const ytdlp = process.env.STACK_MEDIA_YTDLP;
const have = !!ffmpeg && !!ffprobe && !!ytdlp && existsSync(ffmpeg) && existsSync(ffprobe) && existsSync(ytdlp);
const real = have ? test : test.skip;

let root = ""; let server: ReturnType<typeof Bun.serve> | null = null; let base = ""; let h264 = ""; let hevc = ""; let audio = "";
const timings: Record<string, number> = {};

async function make(args: string[]): Promise<void> {
  const child = Bun.spawn([ffmpeg!, "-hide_banner", "-loglevel", "error", "-y", ...args], { stdout: "ignore", stderr: "pipe" });
  const code = await child.exited;
  if (code !== 0) throw new Error(await new Response(child.stderr).text());
}
async function job(kind: string, input: Record<string, unknown>): Promise<any> {
  const response = await app.request("/stack/v1/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, input }) });
  const body = await response.json() as any;
  if (response.status !== 202) throw new Error(`refused ${response.status} ${JSON.stringify(body)}`);
  const started = Date.now();
  const done = await waitForJob(body.job.id, 110_000);
  timings[kind] = Date.now() - started;
  return done;
}

beforeAll(async () => {
  if (!have) return;
  __resetJobsForTests(); __resetRootsForTests();
  root = realpathSync(mkdtempSync(join(tmpdir(), "media-real-")));
  setRoots({ read: [root], write: [root] });
  h264 = join(root, "clip.mp4"); hevc = join(root, "hevc.mp4"); audio = join(root, "tone.m4a");
  const sources = ["-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=12", "-f", "lavfi", "-i", "sine=frequency=440:duration=12"];
  await make([...sources, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart", "-metadata", "title=Fixture Clip", h264]);
  await make([...sources, "-c:v", "libx265", "-tag:v", "hvc1", "-pix_fmt", "yuv420p", "-c:a", "ac3", "-shortest", hevc]);
  await make(["-f", "lavfi", "-i", "sine=frequency=330:duration=5", "-c:a", "aac", audio]);
  const clip = readFileSync(h264);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/limited")) return new Response("slow down", { status: 429, headers: { "retry-after": "60" } });
    if (path === "/missing.mp4") return new Response("gone", { status: 404 });
    if (path.endsWith(".mp4")) return new Response(clip, { headers: { "content-type": "video/mp4", "content-length": String(clip.length) } });
    return new Response("not found", { status: 404 });
  } });
  base = `http://127.0.0.1:${server.port}`;
  setMediaDepsForTests({ toolbox: defaultToolbox, limiter: new HostLimiter(), sleep: async () => {} });
  registerMediaJobs();
});
afterAll(() => {
  server?.stop(true);
  if (have) { __resetJobsForTests(); __resetRootsForTests(); resetMediaDepsForTests(); rmSync(root, { recursive: true, force: true }); rmSync(jobsDir(), { recursive: true, force: true }); console.log("media real timings (ms):", JSON.stringify(timings)); }
});

real("probe reads the codecs, the hevc tag, duration, size and the embedded title", async () => {
  const h = await job("media.probe", { path: h264 });
  expect(h).toMatchObject({ state: "done", result: { video_codec: "h264", audio_codec: "aac", width: 640, height: 360, hevc_tag: null, title: "Fixture Clip" } });
  expect(h.result.duration_s).toBeGreaterThan(11.5); expect(h.result.duration_s).toBeLessThan(12.5);
  const x = await job("media.probe", { path: hevc });
  expect(x.result).toMatchObject({ video_codec: "hevc", hevc_tag: "hvc1", audio_codec: "ac3" });
}, 60_000);

real("transcode turns HEVC and AC-3 into H.264 and AAC with the moov atom up front", async () => {
  const done = await job("media.transcode", { path: hevc, output_dir: join(root, "tc") });
  expect(done.state).toBe("done");
  expect(done.result).toMatchObject({ video_action: "encode", audio_action: "encode", video_codec: "h264", audio_codec: "aac", container: "mp4" });
  const head = readFileSync(done.result.path).subarray(0, 4096).toString("latin1");
  expect(head.indexOf("moov")).toBeGreaterThan(-1);
  expect(head.indexOf("mdat") === -1 || head.indexOf("moov") < head.indexOf("mdat")).toBe(true);
  expect(existsSync(`${done.result.path}.part`)).toBe(false);
}, 120_000);

real("transcode copies a stream that is already H.264 and AAC", async () => {
  const done = await job("media.transcode", { path: h264, output_dir: join(root, "tc"), output_name: "copied" });
  expect(done.result).toMatchObject({ video_action: "copy", audio_action: "copy", video_codec: "h264" });
}, 60_000);

real("preview makes a thumbnail, a storyboard sheet and a silent clip", async () => {
  const done = await job("media.preview", { path: h264, output_dir: join(root, "pv") });
  expect(done.state).toBe("done");
  const result = done.result;
  expect(result.thumbnail).toMatchObject({ width: 640, height: 360 });
  expect(result.storyboard.frames).toBe(12);
  expect(result.storyboard.width).toBeGreaterThan(result.storyboard.tile_width);
  expect(result.clip).toMatchObject({ duration_s: 6, has_audio: false });
  const clipProbe = await job("media.probe", { path: result.clip.path });
  expect(clipProbe.result).toMatchObject({ has_audio: false, video_codec: "h264" });
  const audioPreview = await job("media.preview", { path: audio, output_dir: join(root, "pv") });
  expect(audioPreview.result.skipped.map((entry: any) => entry.part)).toEqual(["thumbnail", "storyboard", "clip"]);
}, 120_000);

real("a clip served from localhost is fetched with yt-dlp's generic extractor, then the archive keeps it from coming twice", async () => {
  const first = await job("media.fetch", { url: `${base}/clip.mp4`, person_initiated: true, archive_key: "fixture" });
  expect(first.state).toBe("done");
  expect(first.result).toMatchObject({ host: "127.0.0.1", count: 1 });
  const item = first.result.items[0];
  expect(item.extractor).toBe("Generic"); expect(existsSync(item.path)).toBe(true); expect(item.size_bytes).toBeGreaterThan(1000);
  expect(item.path.startsWith(jobsDir())).toBe(true);
  const probed = await job("media.probe", { path: item.path });
  expect(probed.result).toMatchObject({ video_codec: "h264", has_audio: true });
  const second = await job("media.fetch", { url: `${base}/clip.mp4`, person_initiated: true, archive_key: "fixture" });
  expect(second.result.count).toBe(0);
  await app.request(`/stack/v1/media/outputs/${first.id}`, { method: "DELETE" });
}, 120_000);

real("a 404 is an unavailable video, not a reason to rest", async () => {
  const done = await job("media.fetch", { url: `${base}/missing.mp4`, person_initiated: true });
  expect(done.state).toBe("failed");
  expect(done.result.failure.code).not.toBe("rate_limited");
  expect(done.result.failure.quiet).toBe(false);
}, 60_000);

real("a server answering 429 four times puts it in quiet mode for background fetches only", async () => {
  const outcomes: string[] = [];
  for (let n = 0; n < 4; n += 1) { const done = await job("media.fetch", { url: `${base}/limited-${n}.mp4` }); outcomes.push(done.result.failure.code); }
  expect(outcomes).toEqual(["rate_limited", "rate_limited", "rate_limited", "rate_limited"]);
  const refused = await app.request("/stack/v1/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "media.fetch", input: { url: `${base}/limited-5.mp4` } }) });
  expect(refused.status).toBe(503); expect(((await refused.json()) as any).code).toBe("media_quiet_mode");
  const person = await job("media.fetch", { url: `${base}/limited-6.mp4`, person_initiated: true });
  expect(person.state).toBe("failed");
}, 120_000);
