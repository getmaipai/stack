// VIDEOSHARE-01: the messaging copy of a clip. The pure parts always run; the real conversion runs when an ffmpeg is
// at hand (VIDEO_FFMPEG, or the one bundled in an installed video environment) and a clip is at VIDEO_TEST_CLIP.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { dataDir } from "@/lib/paths";
import { MESSAGES_MAX_EDGE, makeMessagesCopy, messagesArgs, parseProbe, probeClip, MessagesError } from "@/video/messages";
import { commitResult, workDir, type VideoResultMeta } from "@/video/results";

const PROBE_SILENT = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'video.mp4':
  Duration: 00:00:05.04, start: 0.000000, bitrate: 8043 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 832x480, 8039 kb/s, 24 fps, 24 tbr, 12288 tbn (default)`;
const PROBE_SOUND = `${PROBE_SILENT}\n  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 96 kb/s (default)`;
const PROBE_HEVC = `  Stream #0:0[0x1](und): Video: hevc (Main) (hvc1 / 0x31637668), yuv420p10le(tv), 1920x1080, 9000 kb/s, 30 fps`;

test("parseProbe reads codec, pixel format, size and whether there is sound", () => {
  expect(parseProbe(PROBE_SILENT)).toEqual({ videoCodec: "h264", pixelFormat: "yuv420p", width: 832, height: 480, hasAudio: false });
  expect(parseProbe(PROBE_SOUND).hasAudio).toBe(true);
  expect(parseProbe(PROBE_HEVC)).toMatchObject({ videoCodec: "hevc", pixelFormat: "yuv420p10le", width: 1920, height: 1080 });
  expect(parseProbe("nothing here").videoCodec).toBeNull();
});

test("a silent H.264 clip keeps its picture and gains a silent AAC track, moov first, with a title", () => {
  const args = messagesArgs("in.mp4", "out.mp4", parseProbe(PROBE_SILENT), "paper boat");
  expect(args).toContain("anullsrc=r=44100:cl=stereo");
  expect(args.join(" ")).toContain("-map 0:v:0 -map 1:a:0 -c:v copy");
  expect(args.join(" ")).toContain("-c:a aac");
  expect(args.join(" ")).toContain("-movflags +faststart");
  expect(args).toContain("title=paper boat");
});

test("a clip that already has sound keeps its own track and a clip that is not yuv420p H.264 within the edge is re-encoded", () => {
  const sound = messagesArgs("in.mp4", "out.mp4", parseProbe(PROBE_SOUND), "t");
  expect(sound).not.toContain("anullsrc=r=44100:cl=stereo");
  expect(sound.join(" ")).toContain("-map 0:v:0 -map 0:a:0");
  const hevc = messagesArgs("in.mp4", "out.mp4", parseProbe(PROBE_HEVC), "t").join(" ");
  expect(hevc).toContain("libx264");
  expect(hevc).toContain("-pix_fmt yuv420p");
  expect(hevc).toContain(`min(${MESSAGES_MAX_EDGE},iw)`);
  expect(messagesArgs("in.mp4", "out.mp4", parseProbe(PROBE_SILENT), "t", true).join(" ")).toContain("-crf 27");
});

test("without ffmpeg the copy says what to do", async () => {
  process.env.VIDEO_FFMPEG = "";
  try { await makeMessagesCopy("a.mp4", "b.mp4", "t", "/nowhere"); throw new Error("should have failed"); } catch (error) {
    expect(error).toBeInstanceOf(MessagesError);
    expect((error as MessagesError).code).toBe("no_ffmpeg");
  } finally { delete process.env.VIDEO_FFMPEG; }
  const response = await app.request("/v1/videos/messages", { method: "POST", headers: { "content-type": "video/mp4" }, body: new Uint8Array([1, 2, 3]) });
  delete process.env.VIDEO_FFMPEG;
  expect([503, 422]).toContain(response.status);
});

const FFMPEG = process.env.VIDEO_FFMPEG_TEST ?? "";
const CLIP = process.env.VIDEO_TEST_CLIP ?? "";
const real = FFMPEG !== "" && existsSync(FFMPEG) && CLIP !== "" && existsSync(CLIP);
const JOB = "job-00000000-0000-4000-8000-0000000000aa";

beforeEach(() => { rmSync(join(dataDir, "video"), { recursive: true, force: true }); });
afterEach(() => { delete process.env.VIDEO_FFMPEG; rmSync(join(dataDir, "video"), { recursive: true, force: true }); });

test.skipIf(!real)("real conversion: the silent clip gets one video and one audio track, still H.264 yuv420p, faststart, titled", async () => {
  process.env.VIDEO_FFMPEG = FFMPEG;
  const dir = mkdtempSync(join(tmpdir(), "vmsg-"));
  try {
    const out = join(dir, "out.mp4");
    const result = await makeMessagesCopy(CLIP, out, "paper boat in the rain", "/unused");
    expect(result.bytes).toBeGreaterThan(1000);
    const facts = await probeClip(FFMPEG, out);
    expect(facts).toMatchObject({ videoCodec: "h264", pixelFormat: "yuv420p", hasAudio: true });
    const bytes = readFileSync(out);
    const moov = bytes.indexOf("moov"); const mdat = bytes.indexOf("mdat");
    expect(moov).toBeGreaterThan(0); expect(moov).toBeLessThan(mdat);
    expect(bytes.includes("paper boat in the rain")).toBe(true);
    // Converting a clip that already has sound is a no-op in content: still one audio track.
    const again = join(dir, "again.mp4");
    await makeMessagesCopy(out, again, "x", "/unused");
    expect((await probeClip(FFMPEG, again)).hasAudio).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.skipIf(!real)("the routes: POST /v1/videos/messages converts, GET .../messages.mp4 makes and keeps one, the original stays", async () => {
  process.env.VIDEO_FFMPEG = FFMPEG;
  const post = await app.request("/v1/videos/messages", { method: "POST", headers: { "content-type": "video/mp4", "x-title": "boat%20in%20rain" }, body: readFileSync(CLIP) });
  expect(post.status).toBe(200);
  expect(post.headers.get("content-type")).toBe("video/mp4");
  const converted = new Uint8Array(await post.arrayBuffer());
  expect(Buffer.from(converted).includes("boat in rain")).toBe(true);
  const probeFile = join(tmpdir(), `vmsg-route-${process.pid}.mp4`);
  writeFileSync(probeFile, converted);
  try { expect((await probeClip(FFMPEG, probeFile)).hasAudio).toBe(true); } finally { rmSync(probeFile, { force: true }); }

  const work = workDir(JOB);
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "video.mp4"), readFileSync(CLIP)); writeFileSync(join(work, "poster.jpg"), "p");
  const meta: VideoResultMeta = { job: JOB, created: 1, width: 832, height: 480, frames: 121, fps: 24, seconds: 5, seed: 1, model: "m", mode: "text-to-video", lora_ids: [], ms: 1, bytes: 1, poster_bytes: 1, mlx_peak_gb: null };
  commitResult(meta, work);
  const lazy = await app.request(`/v1/videos/generations/${JOB}/messages.mp4?title=boat`);
  expect(lazy.status).toBe(200);
  expect(new Uint8Array(await lazy.arrayBuffer()).length).toBeGreaterThan(1000);
  expect(existsSync(join(dataDir, "video", "results", JOB, "messages.mp4"))).toBe(true);
  const original = await app.request(`/v1/videos/generations/${JOB}/video.mp4`);
  expect(original.status).toBe(200);
  expect(new Uint8Array(await original.arrayBuffer()).length).toBe(readFileSync(CLIP).length);
  expect((await app.request(`/v1/videos/generations/job-00000000-0000-4000-8000-0000000000bb/messages.mp4`)).status).toBe(404);
});
