// MEDIA-STACK-01: the pure parts: host keys, failure attribution, the per-host
// limiter and quiet mode, the exact yt-dlp and ffmpeg command lines, and the
// ffprobe normalizer. No binary runs here.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchArgs, FetchInput, parseFetchedItem, parseFetchProgress, parseProgressSeconds, PreviewInput, storyboardArgs, TranscodeInput, transcodePlan } from "@/media/commands";
import { BACKGROUND_GAP_MS, classifyFetchFailure, HostLimiter, hostKey, QUIET_AFTER_FAILURES, QUIET_MS } from "@/media/hosts";
import { isoDate, normalizeProbe } from "@/media/probe";
import { ffmpegPinFor, FFMPEG_PINS, MEDIA_COMPONENTS, ytDlpRequirementsFileFor } from "@/media/pins";

test("a host key groups a site's subdomains and keeps an IP or a two-part suffix whole", () => {
  expect(hostKey("https://www.example.com/watch?v=1")).toBe("example.com");
  expect(hostKey("https://m.example.com/x")).toBe("example.com");
  expect(hostKey("https://media.example.co.uk/a")).toBe("example.co.uk");
  expect(hostKey("http://127.0.0.1:8123/clip.mp4")).toBe("127.0.0.1");
  expect(hostKey("http://localhost:9/clip.mp4")).toBe("localhost");
  expect(hostKey("not a url")).toBeNull();
});

test("only a host pushing back counts as a failure for quiet mode", () => {
  expect(classifyFetchFailure("ERROR: unable to download video data: HTTP Error 429: Too Many Requests")).toMatchObject({ code: "rate_limited", pushback: true });
  expect(classifyFetchFailure("ERROR: [site] abc: Sign in to confirm you're not a bot")).toMatchObject({ code: "login_wall", pushback: true });
  expect(classifyFetchFailure("ERROR: Unsupported URL: http://x/y")).toMatchObject({ code: "unsupported", pushback: false });
  expect(classifyFetchFailure("ERROR: Video unavailable. This video has been removed")).toMatchObject({ code: "unavailable", pushback: false });
  expect(classifyFetchFailure("ERROR: unable to download webpage: <urlopen error [Errno 61] Connection refused>")).toMatchObject({ code: "network", pushback: false });
  expect(classifyFetchFailure("something odd")).toMatchObject({ code: "failed", pushback: false });
});

test("four pushbacks put a host in quiet mode for 30 minutes; a person's request still goes; a success clears it", () => {
  let now = 1_000_000;
  const limiter = new HostLimiter({ now: () => now });
  for (let n = 1; n < QUIET_AFTER_FAILURES; n += 1) expect(limiter.record("example.com", "pushback").quiet).toBe(false);
  expect(limiter.admission("example.com", false).ok).toBe(true);
  const fourth = limiter.record("example.com", "pushback");
  expect(fourth).toEqual({ quiet: true, quietUntil: now + QUIET_MS });
  const background = limiter.admission("example.com", false);
  expect(background).toEqual({ ok: false, quietUntil: now + QUIET_MS });
  expect(limiter.admission("example.com", true)).toEqual({ ok: true, waitMs: 0 });
  expect(limiter.admission("other.example.org", false).ok).toBe(true);
  expect(limiter.quietHosts().map((entry) => entry.host)).toEqual(["example.com"]);
  // More pushback while resting does not extend the rest.
  now += 10 * 60_000;
  limiter.record("example.com", "pushback");
  expect(limiter.quietUntil("example.com")).toBe(1_000_000 + QUIET_MS);
  // Thirty minutes after it began, the host is open again.
  now = 1_000_000 + QUIET_MS;
  expect(limiter.admission("example.com", false).ok).toBe(true);
  expect(limiter.quietHosts()).toEqual([]);
});

test("a success resets the count, and other failures do not add to it", () => {
  const limiter = new HostLimiter({ now: () => 5 });
  limiter.record("a.example.com", "pushback"); limiter.record("a.example.com", "pushback"); limiter.record("a.example.com", "pushback");
  limiter.record("a.example.com", "other");
  limiter.record("a.example.com", "success");
  limiter.record("a.example.com", "pushback"); limiter.record("a.example.com", "pushback"); limiter.record("a.example.com", "pushback");
  expect(limiter.record("a.example.com", "other").quiet).toBe(false);
  expect(limiter.quietUntil("a.example.com")).toBeNull();
});

test("a success on a person's request ends quiet mode early", () => {
  const limiter = new HostLimiter({ now: () => 1000 });
  for (let n = 0; n < 4; n += 1) limiter.record("b.example.com", "pushback");
  expect(limiter.quietUntil("b.example.com")).not.toBeNull();
  limiter.record("b.example.com", "success");
  expect(limiter.quietUntil("b.example.com")).toBeNull();
});

test("background requests to one host are spaced; a person's are not", () => {
  let now = 50_000;
  const limiter = new HostLimiter({ now: () => now });
  limiter.started("c.example.com");
  expect(limiter.admission("c.example.com", false)).toEqual({ ok: true, waitMs: BACKGROUND_GAP_MS });
  now += 2_000;
  expect(limiter.admission("c.example.com", false)).toEqual({ ok: true, waitMs: BACKGROUND_GAP_MS - 2_000 });
  expect(limiter.admission("c.example.com", true)).toEqual({ ok: true, waitMs: 0 });
});

test("quiet mode survives a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "quiet-"));
  const file = join(dir, "quiet.json");
  try {
    const first = new HostLimiter({ now: () => 10, file: () => file });
    for (let n = 0; n < 4; n += 1) first.record("d.example.com", "pushback");
    const second = new HostLimiter({ now: () => 20, file: () => file });
    second.load();
    expect(second.quietUntil("d.example.com")).toBe(10 + QUIET_MS);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const fetchContext = { ytDlp: "/t/yt-dlp", ffmpegDir: "/t", outputDir: "/out", archiveFile: null, cookiesFile: null };

test("a fetch runs FileTube's yt-dlp arguments: embedded metadata, thumbnail and chapters; subtitles as VTT", () => {
  const args = fetchArgs(FetchInput.parse({ url: "http://127.0.0.1:1/clip.mp4" }), fetchContext);
  for (const flag of ["--embed-metadata", "--embed-thumbnail", "--embed-chapters", "--write-subs", "--write-auto-subs", "--no-playlist", "--ignore-config"]) expect(args).toContain(flag);
  expect(args.slice(args.indexOf("--sub-langs"), args.indexOf("--sub-langs") + 4)).toEqual(["--sub-langs", "en.*", "--convert-subs", "vtt"]);
  expect(args.slice(-2)).toEqual(["--", "http://127.0.0.1:1/clip.mp4"]);
  expect(args).not.toContain("--cookies");
  expect(args).not.toContain("--download-archive");
  // A background poll goes at a person's pace.
  expect(args).toContain("--sleep-interval");
});

test("a video fetch defaults to the 1080p household ceiling; best lifts it only when asked (owner ruling 2026-10-17)", () => {
  const ceiling = fetchArgs(FetchInput.parse({ url: "http://127.0.0.1:1/clip.mp4" }), fetchContext);
  expect(ceiling[ceiling.indexOf("-f") + 1] ?? ceiling.join(" ")).toContain("height<=1080");
  const best = fetchArgs(FetchInput.parse({ url: "http://127.0.0.1:1/clip.mp4", quality: "best" }), fetchContext);
  expect(best.join(" ")).not.toContain("height<=");
});

test("a person's own fetch does not pause; cookies and the archive are passed only when given", () => {
  const args = fetchArgs(FetchInput.parse({ url: "https://example.com/v", person_initiated: true, playlist: true, archive_key: "chan-1", max_items: 2, quality: "720", date_after: "20260101", min_duration_s: 61 }), { ...fetchContext, archiveFile: "/a/chan-1.txt", cookiesFile: "/c/cookies.txt" });
  expect(args).not.toContain("--sleep-interval");
  expect(args.slice(args.indexOf("--download-archive"), args.indexOf("--download-archive") + 2)).toEqual(["--download-archive", "/a/chan-1.txt"]);
  expect(args.slice(args.indexOf("--cookies"), args.indexOf("--cookies") + 2)).toEqual(["--cookies", "/c/cookies.txt"]);
  expect(args).toContain("--yes-playlist"); expect(args).toContain("--break-on-existing");
  expect(args.slice(args.indexOf("--playlist-end"), args.indexOf("--playlist-end") + 4)).toEqual(["--playlist-end", "2", "--max-downloads", "2"]);
  expect(args[args.indexOf("-f") + 1]).toContain("height<=720");
  expect(args[args.indexOf("--match-filters") + 1]).toBe("!is_live & duration >= 61");
});

test("an audio fetch extracts m4a and writes no subtitles", () => {
  const args = fetchArgs(FetchInput.parse({ url: "https://example.com/a", kind: "audio" }), fetchContext);
  expect(args).toContain("-x"); expect(args[args.indexOf("--audio-format") + 1]).toBe("m4a");
  expect(args).not.toContain("--write-subs");
});

test("a fetch refuses anything but a web address and unknown fields", () => {
  expect(FetchInput.safeParse({ url: "file:///etc/passwd" }).success).toBe(false);
  expect(FetchInput.safeParse({ url: "javascript:alert(1)" }).success).toBe(false);
  expect(FetchInput.safeParse({ url: "https://example.com/v", archive_key: "../../etc" }).success).toBe(false);
  expect(FetchInput.safeParse({ url: "https://example.com/v", exec: "rm" }).success).toBe(false);
});

test("yt-dlp's progress and result lines parse", () => {
  expect(parseFetchProgress("MPPROG 31744 75901 NA 30671270.7")).toEqual({ completedBytes: 31744, totalBytes: 75901, bytesPerSecond: 30671270.7 });
  expect(parseFetchProgress("MPPROG 100 NA 5000 NA")).toEqual({ completedBytes: 100, totalBytes: 5000 });
  expect(parseFetchProgress("[download] 10%")).toBeNull();
  const item = parseFetchedItem('MPJSON {"id": "clip", "title": "Clip", "upload_date": "20261017", "webpage_url": "http://127.0.0.1:1/clip.mp4", "extractor_key": "Generic", "ext": "mp4", "duration": 6.0, "filepath": "/out/clip [clip].mp4"}');
  expect(item).toMatchObject({ id: "clip", title: "Clip", upload_date: "2026-10-17", extractor: "Generic", duration_s: 6, path: "/out/clip [clip].mp4" });
  expect(parseFetchedItem("MPJSON not json")).toBeNull();
  expect(parseFetchedItem('MPJSON {"title": "no id or path"}')).toBeNull();
});

const h264Source = { has_video: true, has_audio: true, video_codec: "h264", pix_fmt: "yuv420p", height: 720, audio_codec: "aac" };
test("transcode copies what is already H.264 and AAC, encodes the rest, always with faststart", () => {
  const input = TranscodeInput.parse({ path: "/in.mkv" });
  const copy = transcodePlan(input, h264Source, "/t/ffmpeg", "/in.mkv", "/out.part");
  expect(copy).toMatchObject({ video: "copy", audio: "copy", container: "mp4" });
  expect(copy.args).toContain("+faststart");
  const hevc = transcodePlan(input, { ...h264Source, video_codec: "hevc", audio_codec: "ac3" }, "/t/ffmpeg", "/in.mkv", "/out.part");
  expect(hevc).toMatchObject({ video: "encode", audio: "encode" });
  expect(hevc.args).toEqual(expect.arrayContaining(["libx264", "aac", "yuv420p", "+faststart"]));
  const tall = transcodePlan(TranscodeInput.parse({ path: "/in.mkv", max_height: 480 }), h264Source, "/t/ffmpeg", "/in.mkv", "/out.part");
  expect(tall.video).toBe("encode");
  expect(tall.args.join(" ")).toContain("scale=-2:'min(480,ih)'");
  const forced = transcodePlan(TranscodeInput.parse({ path: "/in.mkv", video: "encode" }), h264Source, "/t/ffmpeg", "/in.mkv", "/out.part");
  expect(forced.video).toBe("encode");
});

test("an audio-only source becomes m4a with no picture", () => {
  const plan = transcodePlan(TranscodeInput.parse({ path: "/in.flac" }), { has_video: false, has_audio: true, video_codec: null, pix_fmt: null, height: null, audio_codec: "flac" }, "/t/ffmpeg", "/in.flac", "/out.part");
  expect(plan).toMatchObject({ video: "none", audio: "encode", container: "m4a" });
  expect(plan.args).toContain("-vn");
  expect(plan.args).not.toContain("0:v:0");
});

test("ffmpeg's progress lines give seconds", () => {
  expect(parseProgressSeconds("out_time_us=2500000")).toBe(2.5);
  expect(parseProgressSeconds("out_time_ms=1000000")).toBe(1);
  expect(parseProgressSeconds("frame=10")).toBeNull();
});

test("the storyboard sheet is one image of columns by rows tiles", () => {
  const args = storyboardArgs("/t/ffmpeg", "/in.mp4", "/o.jpg", 2.5, 10, 4, 160);
  expect(args[args.indexOf("-vf") + 1]).toBe("fps=1/2.500,scale=160:-2,tile=10x4");
  expect(args).toContain("-frames:v");
  expect(PreviewInput.parse({ path: "/in.mp4" })).toMatchObject({ storyboard_columns: 10, storyboard_frames: 100, clip_length_s: 6 });
});

const probeJson = {
  format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "6.0230", bit_rate: "100000", tags: { title: "Fixture", date: "20260102", PURL: "https://example.com/watch/1", creation_time: "2026-10-17T10:00:00.000000Z" } },
  streams: [
    { index: 0, codec_type: "video", codec_name: "hevc", codec_tag_string: "hvc1", profile: "Main", width: 1920, height: 1080, pix_fmt: "yuv420p", avg_frame_rate: "30000/1001", disposition: { default: 1, attached_pic: 0 }, side_data_list: [{ side_data_type: "Spherical Mapping", projection: "equirectangular" }] },
    { index: 1, codec_type: "audio", codec_name: "aac", codec_tag_string: "mp4a", channels: 2, sample_rate: "48000", bit_rate: "128000", tags: { language: "eng" }, disposition: { default: 1 } },
    { index: 2, codec_type: "video", codec_name: "mjpeg", codec_tag_string: "[0][0][0][0]", width: 600, height: 600, disposition: { attached_pic: 1 } },
  ],
  chapters: [{ start_time: "0.000000", end_time: "3.000000", tags: { title: "Intro" } }, { start_time: "3.000000", end_time: "6.023000", tags: { title: "Main" } }],
};
test("a probe is normalized: codecs with the hevc tag, size, chapters, tags, embedded date and source url", () => {
  const result = normalizeProbe(probeJson, "/lib/a.mp4", 1234);
  expect(result).toMatchObject({ path: "/lib/a.mp4", size_bytes: 1234, duration_s: 6.023, width: 1920, height: 1080, video_codec: "hevc", hevc_tag: "hvc1", audio_codec: "aac", channels: 2, sample_rate: 48000, has_cover_art: true, projection: "equirectangular", title: "Fixture", embedded_date: "2026-01-02", source_url: "https://example.com/watch/1", created_at: "2026-10-17T10:00:00.000000Z" });
  expect(result.chapters).toEqual([{ index: 0, start_s: 0, end_s: 3, title: "Intro" }, { index: 1, start_s: 3, end_s: 6.023, title: "Main" }]);
  expect(result.streams.find((stream) => stream.type === "video")?.fps).toBe(29.97);
  expect(result.tags.purl).toBe("https://example.com/watch/1");
});
test("an hev1 HEVC stream is reported as hev1, and a non-HEVC one has no hevc tag", () => {
  const hev1 = normalizeProbe({ ...probeJson, streams: [{ ...probeJson.streams[0], codec_tag_string: "hev1" }] }, "/a.mp4", 1);
  expect(hev1.hevc_tag).toBe("hev1");
  const h264 = normalizeProbe({ ...probeJson, streams: [{ ...probeJson.streams[0], codec_name: "h264", codec_tag_string: "avc1" }] }, "/a.mp4", 1);
  expect(h264.hevc_tag).toBeNull();
});
test("an audio file with a source url only in its comment still reports it", () => {
  const audio = normalizeProbe({ format: { format_name: "mp3", duration: "10", tags: { comment: "https://example.com/podcast/ep1", year: "2025" } }, streams: [{ index: 0, codec_type: "audio", codec_name: "mp3" }], chapters: [] }, "/a.mp3", 5);
  expect(audio).toMatchObject({ has_video: false, has_audio: true, source_url: "https://example.com/podcast/ep1", embedded_date: "2025", video_codec: null });
});
test("embedded dates normalize", () => {
  expect(isoDate("20260102")).toBe("2026-01-02"); expect(isoDate("2026-01-02T10:00:00Z")).toBe("2026-01-02"); expect(isoDate("1999")).toBe("1999"); expect(isoDate("sometime")).toBeNull(); expect(isoDate(undefined)).toBeNull();
});

test("the pins: sha256 and size recorded for every platform, one licence record per tool, a hashed yt-dlp file", () => {
  expect(FFMPEG_PINS.length).toBe(4);
  for (const pin of FFMPEG_PINS) { expect(pin.archive.sha256).toMatch(/^[0-9a-f]{64}$/); expect(pin.archive.url).toContain("jellyfin-ffmpeg"); expect(pin.archive.approxBytes).toBeGreaterThan(1_000_000); }
  expect(ffmpegPinFor("darwin", "arm64")?.verified).toBe(true);
  expect(ffmpegPinFor("win32", "x64")).toBeNull();
  expect(MEDIA_COMPONENTS.map((component) => component.name)).toEqual(["ffmpeg", "ffprobe", "yt-dlp"]);
  for (const component of MEDIA_COMPONENTS) expect(component.licence.length).toBeGreaterThan(5);
  expect(ytDlpRequirementsFileFor("win32", "x64")).toBeNull();
  expect(ytDlpRequirementsFileFor("darwin", "arm64")).not.toBeNull();
});
