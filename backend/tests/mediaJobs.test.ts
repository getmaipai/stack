// MEDIA-STACK-01: the media job kinds end to end through the Stack job API,
// with a fake toolbox and a fake runner (no network, no binary): path
// validation against the folders Home declares, the quiet-mode refusal, what
// each kind runs and returns, and the idle lane under a cancelled fetch.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __resetJobsForTests, getJob, waitForJob } from "@/lib/jobs";
import { dataDir } from "@/lib/paths";
import { HostLimiter } from "@/media/hosts";
import { mediaDeps, registerMediaJobs, resetMediaDepsForTests, setMediaDepsForTests } from "@/media/jobs";
import { __resetRootsForTests, jobsDir, setRoots, MediaPathError, resolveReadable, resolveWritableDir } from "@/media/paths";
import type { Runner, RunResult } from "@/media/run";
import type { MediaToolbox } from "@/media/tools";

let root: string; let outside: string;
const calls: string[][] = [];
let script: (argv: string[], options: Parameters<Runner>[1]) => Promise<Partial<RunResult>> | Partial<RunResult>;
const ok: RunResult = { code: 0, stdout: "", stderr: "", aborted: false };

const toolbox: MediaToolbox = { installed: () => true, path: async (tool) => `/fake/bin/${tool}` };
const fakeRun: Runner = async (argv, options) => { calls.push(argv); return { ...ok, ...(await script(argv, options)) }; };

beforeEach(() => {
  __resetJobsForTests(); __resetRootsForTests(); calls.length = 0;
  root = realpathSync(mkdtempSync(join(tmpdir(), "media-lib-"))); outside = realpathSync(mkdtempSync(join(tmpdir(), "media-out-")));
  setRoots({ read: [root], write: [root] });
  script = () => ({});
  setMediaDepsForTests({ toolbox, run: fakeRun, limiter: new HostLimiter() });
  registerMediaJobs();
});
afterEach(() => { __resetJobsForTests(); __resetRootsForTests(); resetMediaDepsForTests(); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); rmSync(jobsDir(), { recursive: true, force: true }); });

async function post(kind: string, input: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const response = await app.request("/stack/v1/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, input }) });
  return { status: response.status, body: await response.json() };
}
async function run(kind: string, input: Record<string, unknown>): Promise<any> {
  const { status, body } = await post(kind, input);
  if (status !== 202) throw new Error(`refused ${status}: ${JSON.stringify(body)}`);
  return waitForJob(body.job.id, 5000);
}
const touch = (name: string, bytes = "x"): string => { const path = join(root, name); writeFileSync(path, bytes); return path; };

const PROBE_JSON = JSON.stringify({ format: { format_name: "mov,mp4", duration: "12.5", tags: { title: "Clip", purl: "https://example.com/v/1" } }, streams: [{ index: 0, codec_type: "video", codec_name: "h264", codec_tag_string: "avc1", width: 640, height: 360, pix_fmt: "yuv420p", avg_frame_rate: "30/1" }, { index: 1, codec_type: "audio", codec_name: "aac", channels: 2 }], chapters: [] });

test("media.probe returns the normalized result", async () => {
  const file = touch("a.mp4");
  script = (argv) => argv[0]!.endsWith("ffprobe") ? { stdout: PROBE_JSON } : {};
  const job = await run("media.probe", { path: file });
  expect(job).toMatchObject({ state: "done", result: { path: file, duration_s: 12.5, width: 640, height: 360, video_codec: "h264", audio_codec: "aac", source_url: "https://example.com/v/1" } });
  expect(calls[0]).toEqual(["/fake/bin/ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-show_chapters", "-i", file]);
});

test("a path outside the declared folders, with .., a symlink out, or missing is refused before the queue", async () => {
  touch("a.mp4"); const secret = join(outside, "secret.mp4"); writeFileSync(secret, "x");
  symlinkSync(secret, join(root, "link.mp4"));
  for (const [path, code] of [[secret, "path_outside_roots"], [`${root}/../${outside.split("/").pop()}/secret.mp4`, "path_invalid"], [join(root, "link.mp4"), "path_outside_roots"], [join(root, "missing.mp4"), "path_not_found"], ["a.mp4", "path_invalid"], ["/etc/passwd", "path_outside_roots"]] as const) {
    const { status, body } = await post("media.probe", { path });
    expect({ path, status, code: body.code }).toEqual({ path, status: 422, code });
    expect(body.error.length).toBeGreaterThan(20);
  }
  expect(calls.length).toBe(0);
});

test("before Home declares any folder, media jobs say so", async () => {
  __resetRootsForTests();
  const { status, body } = await post("media.probe", { path: join(root, "a.mp4") });
  expect(status).toBe(422); expect(body.code).toBe("no_roots");
});

test("declaring folders refuses / and the Stack's own data folder, and missing folders", () => {
  for (const bad of ["/", dataDir, join(dataDir, "media"), join(dataDir, "..")]) expect(() => setRoots({ read: [bad] }), bad).toThrow(MediaPathError);
  expect(() => setRoots({ read: [join(root, "nope")] })).toThrow(MediaPathError);
  expect(() => setRoots({ read: ["relative/dir"] })).toThrow(MediaPathError);
  expect(setRoots({ read: [root, root] }).read).toEqual([root]);
});

test("output goes inside a declared write folder or the job's own folder, never elsewhere", () => {
  expect(resolveWritableDir(join(root, "new", "deeper"))).toBe(join(root, "new", "deeper"));
  expect(() => resolveWritableDir(outside)).toThrow(MediaPathError);
  expect(() => resolveWritableDir(join(root, "..", "x"))).toThrow(MediaPathError);
  setRoots({ read: [root] });
  expect(() => resolveWritableDir(join(root, "x"))).toThrow(MediaPathError);
  expect(() => resolveReadable(join(root, "x"))).toThrow(MediaPathError);
});

test("PUT /roots saves the declaration and GET shows it; a bad folder is a 422 with words", async () => {
  const good = await app.request("/stack/v1/media/roots", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ read: [root], write: [] }) });
  expect(good.status).toBe(200);
  const bad = await app.request("/stack/v1/media/roots", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ read: ["/"] }) });
  expect(bad.status).toBe(422);
  expect((await bad.json() as any).code).toBe("root_refused");
  const status = await (await app.request("/stack/v1/media")).json() as any;
  expect(status.media.roots.read).toEqual([root]);
  expect(status.media.kinds).toEqual(["media.probe", "media.fetch", "media.transcode", "media.preview", "media.setup"]);
  expect(status.media.lane).toMatchObject({ name: "idle", cap: 64, queued: 0 });
  expect(status.media.tools.map((tool: any) => tool.name)).toEqual(["ffmpeg", "ffprobe", "yt-dlp"]);
  expect(status.media.quiet_policy).toEqual({ failures: 4, minutes: 30 });
});

test("a bad job input is a 422 that names the field", async () => {
  const unknown = await post("media.transcode", { path: touch("a.mp4"), codec: "x265" });
  expect(unknown.status).toBe(422); expect(unknown.body.code).toBe("bad_input"); expect(unknown.body.error).toContain("codec");
  const scheme = await post("media.fetch", { url: "file:///etc/passwd" });
  expect(scheme.status).toBe(422); expect(scheme.body.error).toContain("url");
  const name = await post("media.transcode", { path: touch("b.mp4"), output_name: "../escape" });
  expect(name.status).toBe(422); expect(name.body.code).toBe("path_invalid");
});

const itemLine = (path: string, id = "clip") => `MPJSON ${JSON.stringify({ id, title: "Clip", upload_date: "20261017", webpage_url: "http://127.0.0.1:1/clip.mp4", extractor_key: "Generic", ext: "mp4", duration: 6, filepath: path })}`;

test("media.fetch runs yt-dlp into a folder the job owns and returns the items with their sidecars", async () => {
  script = (argv, options) => {
    const dir = argv[argv.indexOf("-o") + 1]!.replace(/\/%\(.*$/, "");
    const file = join(dir, "Clip [clip].mp4"); writeFileSync(file, "video"); writeFileSync(join(dir, "Clip [clip].en.vtt"), "WEBVTT");
    options?.onStdoutLine?.("MPPROG 50 100 NA 10"); options?.onStdoutLine?.(itemLine(file));
    return {};
  };
  const job = await run("media.fetch", { url: "http://127.0.0.1:1/clip.mp4", person_initiated: true, archive_key: "src-1" });
  expect(job.state).toBe("done");
  expect(job.result).toMatchObject({ host: "127.0.0.1", count: 1, items: [{ id: "clip", title: "Clip", upload_date: "2026-10-17", size_bytes: 5, subtitle_paths: [expect.stringContaining(".en.vtt")], thumbnail_path: null }] });
  expect(job.result.output_dir.startsWith(jobsDir())).toBe(true);
  expect(calls[0]).toContain(join(dataDir, "media", "archives", "src-1.txt"));
  // Home releases the folder after it has taken what it keeps.
  const release = await app.request(`/stack/v1/media/outputs/${job.id}`, { method: "DELETE" });
  expect(await release.json()).toEqual({ released: true });
  expect(existsSync(job.result.output_dir)).toBe(false);
});

test("media.fetch writes into a declared write folder when asked, and refuses one that is not declared", async () => {
  const dest = join(root, "fetched");
  script = (argv, options) => { const file = join(dest, "Clip [clip].mp4"); writeFileSync(file, "v"); options?.onStdoutLine?.(itemLine(file)); return {}; };
  const job = await run("media.fetch", { url: "https://example.com/v/1", person_initiated: true, output_dir: dest });
  expect(job.result.output_dir).toBe(dest);
  const refused = await post("media.fetch", { url: "https://example.com/v/1", output_dir: outside });
  expect(refused.status).toBe(422); expect(refused.body.code).toBe("path_outside_roots");
});

test("a cookies file is passed only from a declared folder", async () => {
  const cookies = touch("cookies.txt");
  script = () => ({});
  await run("media.fetch", { url: "https://example.com/v/1", person_initiated: true, cookies_path: cookies });
  expect(calls[0]![calls[0]!.indexOf("--cookies") + 1]).toBe(cookies);
  const refused = await post("media.fetch", { url: "https://example.com/v/1", cookies_path: join(outside, "c.txt") });
  expect(refused.status).toBe(422);
});

test("a 429 four times puts the host in quiet mode: the fifth background fetch is refused, a person's still runs, and the status lists the host", async () => {
  script = () => ({ code: 1, stderr: "ERROR: unable to download video data: HTTP Error 429: Too Many Requests" });
  setMediaDepsForTests({ sleep: async () => {} });
  const fails: any[] = [];
  for (let n = 0; n < 4; n += 1) fails.push(await run("media.fetch", { url: `https://www.example.com/watch/${n}` }));
  for (const job of fails) expect(job).toMatchObject({ state: "failed", result: { failure: { code: "rate_limited", host: "example.com" } } });
  expect(fails[3].result.failure).toMatchObject({ quiet: true });
  expect(fails[2].result.failure).toMatchObject({ quiet: false });
  const refused = await post("media.fetch", { url: "https://m.example.com/watch/5" });
  expect(refused.status).toBe(503); expect(refused.body.code).toBe("media_quiet_mode"); expect(refused.body.error).toContain("example.com");
  const before = calls.length;
  const person = await post("media.fetch", { url: "https://m.example.com/watch/6", person_initiated: true });
  expect(person.status).toBe(202);
  await waitForJob(person.body.job.id, 3000);
  expect(calls.length).toBe(before + 1);
  const status = await (await app.request("/stack/v1/media")).json() as any;
  expect(status.media.quiet_hosts.map((entry: any) => entry.host)).toEqual(["example.com"]);
  // Another site is unaffected.
  expect((await post("media.fetch", { url: "https://other.example.org/v", person_initiated: false })).status).toBe(202);
});

test("a login wall counts the same, and a removed video does not", async () => {
  setMediaDepsForTests({ sleep: async () => {} });
  script = () => ({ code: 1, stderr: "ERROR: [x] a: Sign in to confirm you're not a bot" });
  for (let n = 0; n < 4; n += 1) await run("media.fetch", { url: `https://wall.example.net/${n}` });
  expect((await post("media.fetch", { url: "https://wall.example.net/5" })).body.code).toBe("media_quiet_mode");
  script = () => ({ code: 1, stderr: "ERROR: Video unavailable. This video has been removed" });
  for (let n = 0; n < 6; n += 1) expect((await run("media.fetch", { url: `https://gone.example.edu/${n}` })).result.failure.code).toBe("unavailable");
  expect((await post("media.fetch", { url: "https://gone.example.edu/7" })).status).toBe(202);
});

test("a fetch that reached max_items (exit 101) is a success", async () => {
  script = (argv, options) => { const dir = argv[argv.indexOf("-o") + 1]!.replace(/\/%\(.*$/, ""); for (const id of ["a", "b"]) { const file = join(dir, `${id}.mp4`); writeFileSync(file, "v"); options?.onStdoutLine?.(itemLine(file, id)); } return { code: 101 }; };
  const job = await run("media.fetch", { url: "https://example.com/channel", playlist: true, max_items: 2, archive_key: "chan" });
  expect(job).toMatchObject({ state: "done", result: { count: 2 } });
});

test("a cancelled fetch stops its tool and the next job still runs", async () => {
  let sawAbort = false;
  script = (argv, options) => argv.includes("--embed-metadata") ? new Promise((resolve) => { options?.signal?.addEventListener("abort", () => { sawAbort = true; resolve({ aborted: true, code: null }); }); }) : { stdout: PROBE_JSON };
  const file = touch("a.mp4");
  const fetching = await post("media.fetch", { url: "https://example.com/v/1", person_initiated: true });
  const probing = await post("media.probe", { path: file });
  await Bun.sleep(20);
  expect(getJob(probing.body.job.id)?.state).toBe("queued");
  const cancelled = await app.request(`/stack/v1/jobs/${fetching.body.job.id}`, { method: "DELETE" });
  expect(((await cancelled.json()) as any).job.state).toBe("cancelled");
  const after = await waitForJob(probing.body.job.id, 3000);
  expect(after?.state).toBe("done");
  expect(sawAbort).toBe(true);
  expect(readdirSync(jobsDir()).includes(fetching.body.job.id)).toBe(true); // the folder stays until Home releases it or the sweep takes it
});

test("media.transcode writes H.264 + AAC with faststart beside a .part, renames it, and reports what it did", async () => {
  const file = touch("film.mkv");
  script = (argv, options) => {
    if (argv[0]!.endsWith("ffprobe")) return { stdout: argv.includes(file) ? JSON.stringify({ format: { duration: "100" }, streams: [{ index: 0, codec_type: "video", codec_name: "hevc", codec_tag_string: "hev1", width: 1920, height: 1080, pix_fmt: "yuv420p10le" }, { index: 1, codec_type: "audio", codec_name: "ac3", channels: 6 }] }) : PROBE_JSON };
    writeFileSync(argv[argv.length - 1]!, "mp4data"); options?.onStdoutLine?.("out_time_us=50000000");
    return {};
  };
  const job = await run("media.transcode", { path: file, output_dir: join(root, "tc"), max_height: 720 });
  expect(job.state).toBe("done");
  expect(job.result).toMatchObject({ path: join(root, "tc", "film.mp4"), container: "mp4", video_action: "encode", audio_action: "encode", size_bytes: 7 });
  const ffmpegCall = calls.find((argv) => argv[0]!.endsWith("ffmpeg"))!;
  expect(ffmpegCall).toEqual(expect.arrayContaining(["libx264", "aac", "+faststart", "-pix_fmt", "yuv420p"]));
  expect(ffmpegCall[ffmpegCall.length - 1]).toBe(join(root, "tc", "film.mp4.part"));
  expect(existsSync(join(root, "tc", "film.mp4.part"))).toBe(false);
});

test("a failed transcode leaves no partial file and says what to do", async () => {
  const file = touch("bad.mkv");
  script = (argv) => argv[0]!.endsWith("ffprobe") ? { stdout: PROBE_JSON } : (writeFileSync(argv[argv.length - 1]!, "half"), { code: 1, stderr: "Error while decoding stream" });
  const job = await run("media.transcode", { path: file, output_dir: join(root, "tc") });
  expect(job).toMatchObject({ state: "failed", result: { failure: { code: "failed" } } });
  expect(existsSync(join(root, "tc", "bad.mp4.part"))).toBe(false);
});

test("an unreadable file is reported as such, not as a crash", async () => {
  const file = touch("notmedia.txt");
  script = () => ({ code: 1, stderr: "Invalid data found when processing input" });
  const job = await run("media.probe", { path: file });
  expect(job).toMatchObject({ state: "failed", result: { failure: { code: "unreadable" } } });
});

test("media.preview makes a thumbnail, a storyboard sheet and a silent clip, and says which parts it skipped", async () => {
  const file = touch("clip.mp4");
  script = (argv) => {
    if (argv[0]!.endsWith("ffprobe")) return { stdout: argv.includes(file) ? JSON.stringify({ format: { duration: "60" }, streams: [{ index: 0, codec_type: "video", codec_name: "h264", width: 1280, height: 720, pix_fmt: "yuv420p" }] }) : JSON.stringify({ format: {}, streams: [{ index: 0, codec_type: "video", codec_name: "mjpeg", width: 640, height: 360 }] }) };
    writeFileSync(argv[argv.length - 1]!, "img"); return {};
  };
  const job = await run("media.preview", { path: file });
  expect(job.state).toBe("done");
  const result = job.result;
  expect(result.duration_s).toBe(60);
  expect(result.thumbnail).toMatchObject({ width: 640, height: 360, at_s: 6, from_cover_art: false });
  expect(result.storyboard).toMatchObject({ columns: 10, rows: 6, tile_width: 160, tile_height: 90, frames: 60, interval_s: 1 });
  expect(result.clip).toMatchObject({ start_s: 18, duration_s: 6, has_audio: false });
  expect(result.skipped).toEqual([]);
  for (const part of [result.thumbnail, result.storyboard, result.clip]) expect(part.path.startsWith(jobsDir())).toBe(true);
  const clipCall = calls.find((argv) => argv.includes("preview.mp4") || argv[argv.length - 1]!.endsWith(".preview.mp4"))!;
  expect(clipCall).toContain("-an");
});

test("an audio file's preview uses its cover art and skips the video parts with a reason", async () => {
  const file = touch("song.m4a");
  script = (argv) => {
    if (argv[0]!.endsWith("ffprobe")) return { stdout: JSON.stringify({ format: { duration: "200" }, streams: [{ index: 0, codec_type: "audio", codec_name: "aac" }, { index: 1, codec_type: "video", codec_name: "mjpeg", width: 500, height: 500, disposition: { attached_pic: 1 } }] }) };
    writeFileSync(argv[argv.length - 1]!, "img"); return {};
  };
  const result = (await run("media.preview", { path: file })).result;
  expect(result.thumbnail).toMatchObject({ from_cover_art: true });
  expect(result.storyboard).toBeNull(); expect(result.clip).toBeNull();
  expect(result.skipped.map((entry: any) => entry.part)).toEqual(["storyboard", "clip"]);
});

test("media.setup installs all three tools and reports their paths", async () => {
  const job = await run("media.setup", {});
  expect(job).toMatchObject({ state: "done", result: { tools: { ffmpeg: "/fake/bin/ffmpeg", ffprobe: "/fake/bin/ffprobe", "yt-dlp": "/fake/bin/yt-dlp" } } });
});

test("a tool that cannot be set up fails the job with words, not a stack trace", async () => {
  const { MediaToolError } = await import("@/media/tools");
  setMediaDepsForTests({ toolbox: { installed: () => false, path: async () => { throw new MediaToolError("tool_setup_failed", "The video tools could not be downloaded: offline. Check this computer's internet connection and try again."); } } });
  const job = await run("media.probe", { path: touch("a.mp4") });
  expect(job).toMatchObject({ state: "failed", reason: expect.stringContaining("internet connection"), result: { failure: { code: "tool_setup_failed" } } });
});

test("the sweep removes job folders nobody released", async () => {
  const { sweepJobDirs, jobDir } = await import("@/media/paths");
  const dir = jobDir("job-old"); writeFileSync(join(dir, "f"), "x");
  expect(sweepJobDirs(1000, Date.now() + 10_000)).toBe(1);
  expect(existsSync(dir)).toBe(false);
  mkdirSync(jobDir("job-new"), { recursive: true });
  expect(sweepJobDirs(7 * 24 * 3600_000)).toBe(0);
  void mediaDeps;
});
