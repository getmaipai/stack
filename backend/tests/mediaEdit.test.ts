// EDITOR-11: media.edit end to end through the Stack job API. The first half
// uses a fake toolbox and runner (path guards, op limits, argument plans, the
// deadline kill); the second half runs real ffmpeg on tiny generated clips and
// is skipped, with the reason printed, when no ffmpeg and ffprobe are installed
// (set STACK_MEDIA_FFMPEG and STACK_MEDIA_FFPROBE to point at them).
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __resetJobsForTests, waitForJob } from "@/lib/jobs";
import { HostLimiter } from "@/media/hosts";
import { concatCompatible, concatEncodeArgs, hasKeyframeAt, overlayArgs, trimArgs } from "@/media/editOps";
import { MEDIA_DEADLINES_MS, registerMediaJobs, resetMediaDepsForTests, setMediaDepsForTests } from "@/media/jobs";
import { __resetRootsForTests, jobsDir, setRoots } from "@/media/paths";
import { normalizeProbe } from "@/media/probe";
import { spawnRunner, type Runner, type RunResult } from "@/media/run";
import type { MediaToolbox } from "@/media/tools";

let root = ""; let outside = "";
const calls: string[][] = [];
let script: (argv: string[], options: Parameters<Runner>[1]) => Promise<Partial<RunResult>> | Partial<RunResult> = () => ({});
const ok: RunResult = { code: 0, stdout: "", stderr: "", aborted: false };
const fakeToolbox: MediaToolbox = { installed: () => true, path: async (tool) => `/fake/bin/${tool}` };
const fakeRun: Runner = async (argv, options) => { calls.push(argv); return { ...ok, ...(await script(argv, options)) }; };

async function post(input: unknown): Promise<{ status: number; body: any }> {
  const response = await app.request("/stack/v1/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "media.edit", input }) });
  return { status: response.status, body: await response.json() };
}
async function run(input: unknown, wait = 5000): Promise<any> {
  const { status, body } = await post(input);
  if (status !== 202) throw new Error(`refused ${status}: ${JSON.stringify(body)}`);
  return waitForJob(body.job.id, wait);
}
const touch = (name: string): string => { const path = join(root, name); writeFileSync(path, "x"); return path; };
const probeJson = (seconds: number, audio = true) => JSON.stringify({ format: { format_name: "mov,mp4", duration: String(seconds) }, streams: [{ index: 0, codec_type: "video", codec_name: "h264", width: 640, height: 360, pix_fmt: "yuv420p", avg_frame_rate: "24/1" }, ...(audio ? [{ index: 1, codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000" }] : [])], chapters: [] });

function freshRoots(): void {
  __resetJobsForTests(); __resetRootsForTests(); calls.length = 0;
  root = realpathSync(mkdtempSync(join(tmpdir(), "edit-lib-"))); outside = realpathSync(mkdtempSync(join(tmpdir(), "edit-out-")));
  setRoots({ read: [root], write: [root] });
}
function cleanRoots(): void { __resetJobsForTests(); __resetRootsForTests(); resetMediaDepsForTests(); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); rmSync(jobsDir(), { recursive: true, force: true }); }

describe("media.edit with a fake runner", () => {
  beforeEach(() => { freshRoots(); script = () => ({}); setMediaDepsForTests({ toolbox: fakeToolbox, run: fakeRun, limiter: new HostLimiter() }); registerMediaJobs(); });
  afterEach(cleanRoots);

  test("refuses inputs outside the read roots, missing files, outputs outside the writable dir and unsafe names, before the queue", async () => {
    const clip = touch("a.mp4"); const secret = join(outside, "secret.mp4"); writeFileSync(secret, "x"); symlinkSync(secret, join(root, "link.mp4"));
    const trim = [{ op: "trim", in_s: 0, out_s: 1 }];
    const cases: Array<[unknown, string]> = [
      [{ inputs: [secret], ops: trim, output: { name: "o.mp4" } }, "path_outside_roots"],
      [{ inputs: [join(root, "link.mp4")], ops: trim, output: { name: "o.mp4" } }, "path_outside_roots"],
      [{ inputs: [join(root, "missing.mp4")], ops: trim, output: { name: "o.mp4" } }, "path_not_found"],
      [{ inputs: [clip], ops: trim, output: { dir: outside, name: "o.mp4" } }, "path_outside_roots"],
      [{ inputs: [clip], ops: trim, output: { name: "../o.mp4" } }, "path_invalid"],
    ];
    for (const [input, code] of cases) {
      const { status, body } = await post(input);
      expect({ status, code: body.code }).toEqual({ status: 422, code });
      expect(body.error.length).toBeGreaterThan(20);
    }
    expect(calls.length).toBe(0);
  });

  test("refuses unknown ops, more than 12 ops, more than 24 inputs, and a frame that is not last, each with a plain sentence", async () => {
    const clip = touch("a.mp4");
    const out = { name: "o.mp4" };
    const refused = async (input: unknown, words: RegExp) => { const { status, body } = await post(input); expect({ status, code: body.code }).toEqual({ status: 422, code: "bad_input" }); expect(body.error).toMatch(words); };
    await refused({ inputs: [clip], ops: [{ op: "explode" }], output: out }, /does not know.*trim, concat, mute, frame, audio_overlay, fade/);
    await refused({ inputs: [clip], ops: Array.from({ length: 13 }, () => ({ op: "mute" })), output: out }, /at most 12 steps/);
    await refused({ inputs: Array.from({ length: 25 }, () => clip), ops: [{ op: "mute" }], output: out }, /at most 24 files/);
    await refused({ inputs: [clip], ops: [{ op: "frame" }, { op: "mute" }], output: { name: "o.png" } }, /must be the last step/);
    await refused({ inputs: [clip], ops: [{ op: "frame" }], output: out }, /must end in \.png/);
    await refused({ inputs: [clip], ops: [{ op: "trim", in_s: 3, out_s: 2 }], output: out }, /out_s: must be after in_s/);
    await refused({ inputs: [clip], ops: [{ op: "mute", loud: 1 }], output: out }, /does not know/);
    expect((await post({ inputs: [clip], ops: Array.from({ length: 12 }, () => ({ op: "mute" })), output: out })).status).toBe(202);
  });

  test("a clip over ten minutes is refused with a plain error, and the output may not replace an input", async () => {
    const clip = touch("long.mp4");
    script = (argv) => argv[0]!.endsWith("ffprobe") ? { stdout: probeJson(700) } : {};
    const job = await run({ inputs: [clip], ops: [{ op: "mute" }], output: { name: "o.mp4" } });
    expect(job).toMatchObject({ state: "failed", result: { failure: { code: "too_long" } } });
    expect(job.result.failure.message).toMatch(/at most 10 minutes/);
    script = (argv) => argv[0]!.endsWith("ffprobe") ? { stdout: probeJson(5) } : {};
    const same = await run({ inputs: [clip], ops: [{ op: "mute" }], output: { dir: root, name: "long.mp4" } });
    expect(same).toMatchObject({ state: "failed", result: { failure: { code: "bad_input" } } });
  });

  test("a joined film over ten minutes is refused before ffmpeg runs", async () => {
    const a = touch("a.mp4"); const b = touch("b.mp4");
    script = (argv) => argv[0]!.endsWith("ffprobe") ? { stdout: probeJson(400) } : {};
    const job = await run({ inputs: [a, b], ops: [{ op: "concat" }], output: { name: "o.mp4" } });
    expect(job).toMatchObject({ state: "failed", result: { failure: { code: "too_long" } } });
    expect(calls.some((argv) => argv[0]!.endsWith("ffmpeg"))).toBe(false);
  });

  test("ffmpeg runs without a shell, one argv entry per argument, and the plan applies the ops in order", async () => {
    const a = touch("a.mp4"); const voice = touch("voice.wav");
    script = (argv) => { if (argv[0]!.endsWith("ffprobe")) return { stdout: probeJson(5) }; writeFileSync(argv[argv.length - 1]!, "out"); return {}; };
    const job = await run({ inputs: [a, voice], ops: [{ op: "trim", in_s: 0, out_s: 4 }, { op: "audio_overlay", input: 1, gain_db: -3, clip_gain_db: -9, start_s: 0.5, duck: true, loudness_lufs: -16 }, { op: "fade", out_s: 1 }], output: { name: "film.mp4" } });
    expect(job.state).toBe("done");
    expect(job.result.steps.map((step: any) => step.op)).toEqual(["trim", "audio_overlay", "fade"]);
    // the fake probe reports 5 s for the 4 s copy, so the late-copy check redoes it as an encode
    expect(job.result.steps[0].action).toBe("encode");
    expect(job.result.steps[1].action).toBe("audio_mix_video_copy");
    const edits = calls.filter((argv) => argv[0]!.endsWith("ffmpeg"));
    expect(edits.length).toBe(4);
    for (const argv of edits) expect(argv.every((part) => typeof part === "string") && !argv.some((part) => part === "sh" || part === "-c:sh")).toBe(true);
    const overlay = edits[2]!;
    expect(overlay).toContain("-c:v"); expect(overlay[overlay.indexOf("-c:v") + 1]).toBe("copy");
    const graph = overlay[overlay.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("volume=-9dB"); expect(graph).toContain("volume=-3dB"); expect(graph).toContain("adelay=500|500"); expect(graph).toContain("sidechaincompress"); expect(graph).toContain("loudnorm=I=-16");
    expect(existsSync(join(root, "film.mp4"))).toBe(false);
    expect(job.result.path.startsWith(jobsDir())).toBe(true);
  });

  test("a job past its deadline is stopped: ffmpeg is told to abort and no partial file is left", async () => {
    const a = touch("a.mp4"); let aborted = false;
    script = (argv, options) => {
      if (argv[0]!.endsWith("ffprobe")) return { stdout: probeJson(5) };
      return new Promise((resolve) => options!.signal!.addEventListener("abort", () => { aborted = true; resolve({ code: null, aborted: true }); }, { once: true }));
    };
    const prior = MEDIA_DEADLINES_MS["media.edit"];
    MEDIA_DEADLINES_MS["media.edit"] = 300;
    try {
      const job = await run({ inputs: [a], ops: [{ op: "mute" }], output: { dir: root, name: "o.mp4" } }, 5000);
      expect(job.state).toBe("failed");
      expect(JSON.stringify(job)).toMatch(/longer than/);
    } finally { MEDIA_DEADLINES_MS["media.edit"] = prior; }
    await Bun.sleep(50);
    expect(aborted).toBe(true);
    expect(readdirSync(root).filter((name) => name.includes("part"))).toEqual([]);
  });
});

describe("media.edit command plans", () => {
  const probe = (width: number, fps = 24, audio = true) => normalizeProbe(JSON.parse(probeJson(5, audio).replace('"width":640', `"width":${width}`).replace('"avg_frame_rate":"24/1"', `"avg_frame_rate":"${fps}/1"`)), "/x.mp4", 1);
  test("trim copies from a keyframe or 0 and re-encodes otherwise", () => {
    const op = { op: "trim" as const, in_s: 1, out_s: 3 };
    expect(trimArgs("ffmpeg", "/a.mp4", "/o.mp4", op, probe(640), true).action).toBe("copy");
    expect(trimArgs("ffmpeg", "/a.mp4", "/o.mp4", op, probe(640), false).action).toBe("encode");
    expect(trimArgs("ffmpeg", "/a.mp4", "/o.mp4", { ...op, in_s: 0 }, probe(640), false).action).toBe("copy");
    expect(hasKeyframeAt("0.000000\n1.000000\n2.000000\n", 1, 24)).toBe(true);
    expect(hasKeyframeAt("0.000000\n1.250000\n", 1, 24)).toBe(false);
  });
  test("concat copies only when codec, size, rate and sound layout agree", () => {
    const clips = [{ path: "/a", probe: probe(640) }, { path: "/b", probe: probe(640) }];
    expect(concatCompatible(clips)).toBe(true);
    expect(concatCompatible([clips[0]!, { path: "/c", probe: probe(320) }])).toBe(false);
    expect(concatCompatible([clips[0]!, { path: "/c", probe: probe(640, 30) }])).toBe(false);
    expect(concatCompatible([clips[0]!, { path: "/c", probe: probe(640, 24, false) }])).toBe(false);
    const graph = concatEncodeArgs("ffmpeg", [clips[0]!, { path: "/c", probe: probe(320, 24, false) }], "/o.mp4");
    expect(graph[graph.indexOf("-filter_complex") + 1]).toMatch(/scale=640:360.*anullsrc.*concat=n=2:v=1:a=1/);
  });
  test("overlay without a picture maps only the mix", () => {
    const audioOnly = normalizeProbe(JSON.parse(probeJson(5).replace(/\{"index":0,"codec_type":"video"[^}]*\},/, "")), "/x.m4a", 1);
    const args = overlayArgs("ffmpeg", { path: "/a.m4a", probe: audioOnly }, "/v.wav", "/o.mp4", { op: "audio_overlay", input: 1, gain_db: 0, clip_gain_db: 0, start_s: 0, duck: false });
    expect(args).not.toContain("0:v:0");
  });
});

// ---- real ffmpeg ----
function findTool(name: "ffmpeg" | "ffprobe"): string | null {
  const env = name === "ffmpeg" ? process.env.STACK_MEDIA_FFMPEG : process.env.STACK_MEDIA_FFPROBE;
  if (env && existsSync(env)) return env;
  for (const dir of (process.env.PATH ?? "").split(":")) if (dir && existsSync(join(dir, name))) return join(dir, name);
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]) if (existsSync(join(dir, name))) return join(dir, name);
  return null;
}
const ffmpeg = findTool("ffmpeg"); const ffprobe = findTool("ffprobe");
const haveTools = !!ffmpeg && !!ffprobe;
if (!haveTools) console.warn("media.edit real-ffmpeg tests skipped: no ffmpeg and ffprobe found (set STACK_MEDIA_FFMPEG and STACK_MEDIA_FFPROBE).");
const real = haveTools ? describe : describe.skip;

real("media.edit with real ffmpeg", () => {
  const priorNice = process.env.STACK_MEDIA_NO_NICE;
  let clip5 = ""; let clipNoB = ""; let clip2 = ""; let tone = "";
  const tools: MediaToolbox = { installed: () => true, path: async (tool) => (tool === "ffmpeg" ? ffmpeg! : ffprobe!) };
  async function ff(args: string[]): Promise<void> { const result = await spawnRunner([ffmpeg!, "-hide_banner", "-loglevel", "error", "-y", ...args]); if (result.code !== 0) throw new Error(result.stderr); }
  async function md5(path: string, map: "0:v:0" | "0:a:0"): Promise<string> {
    const result = await spawnRunner([ffmpeg!, "-hide_banner", "-loglevel", "error", "-i", path, "-map", map, ...(map === "0:v:0" ? ["-c", "copy"] : ["-f", "s16le", "-c:a", "pcm_s16le"]), "-f", "md5", "-"], { collectStdout: true });
    return /MD5=(\w+)/.exec(result.stdout)?.[1] ?? `none:${result.stderr}`;
  }
  async function streamDurations(path: string): Promise<{ video: number; audio: number; format: number }> {
    const result = await spawnRunner([ffprobe!, "-v", "error", "-show_entries", "stream=codec_type,duration:format=duration", "-of", "json", path], { collectStdout: true });
    const json = JSON.parse(result.stdout);
    const of = (type: string) => Number(json.streams.find((stream: any) => stream.codec_type === type)?.duration ?? NaN);
    return { video: of("video"), audio: of("audio"), format: Number(json.format.duration) };
  }
  beforeAll(async () => {
    process.env.STACK_MEDIA_NO_NICE = "1";
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "edit-fixture-")));
    clip5 = join(dir, "clip5.mp4"); clip2 = join(dir, "clip2.mp4"); tone = join(dir, "tone.wav");
    await ff(["-f", "lavfi", "-i", "testsrc=s=320x180:r=24:d=5", "-f", "lavfi", "-i", "sine=f=440:r=48000:d=5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "12", "-keyint_min", "12", "-sc_threshold", "0", "-c:a", "aac", "-b:a", "128k", "-shortest", clip5]);
    clipNoB = join(dir, "clipnob.mp4");
    await ff(["-f", "lavfi", "-i", "testsrc=s=320x180:r=24:d=5", "-f", "lavfi", "-i", "sine=f=440:r=48000:d=5", "-c:v", "libx264", "-bf", "0", "-pix_fmt", "yuv420p", "-g", "12", "-keyint_min", "12", "-sc_threshold", "0", "-c:a", "aac", "-b:a", "128k", "-shortest", clipNoB]);
    await ff(["-f", "lavfi", "-i", "testsrc2=s=160x120:r=24:d=2", "-f", "lavfi", "-i", "sine=f=330:r=44100:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip2]);
    await ff(["-f", "lavfi", "-i", "sine=f=880:r=48000:d=2", tone]);
  });
  beforeEach(() => { freshRoots(); setMediaDepsForTests({ toolbox: tools, run: spawnRunner, limiter: new HostLimiter() }); registerMediaJobs(); setRoots({ read: [root, join(clip5, "..")], write: [root] }); });
  afterEach(() => { cleanRoots(); });
  const out = (name: string) => ({ dir: root, name });

  test("trim keeps the length and audio sync within 50 ms (stream copy on a keyframe, no B-frames)", async () => {
    const job = await run({ inputs: [clipNoB], ops: [{ op: "trim", in_s: 1, out_s: 3 }], output: out("t.mp4") }, 60_000);
    expect(job.state).toBe("done");
    expect(job.result.steps[0].action).toBe("copy");
    const lengths = await streamDurations(job.result.path);
    expect(Math.abs(lengths.format - 2)).toBeLessThan(0.05);
    expect(Math.abs(lengths.video - lengths.audio)).toBeLessThan(0.05);
    expect(job.result).toMatchObject({ container: "mp4", width: 320, height: 180, video_codec: "h264", audio_codec: "aac" });
    expect(job.result.streams.length).toBe(2);
  });

  test("trim of a B-frame clip stays within 50 ms (a copy that comes out late is redone as an encode)", async () => {
    const job = await run({ inputs: [clip5], ops: [{ op: "trim", in_s: 1, out_s: 3 }], output: out("t3.mp4") }, 60_000);
    expect(job.state).toBe("done");
    const lengths = await streamDurations(job.result.path);
    expect(Math.abs(lengths.format - 2)).toBeLessThan(0.05);
    expect(Math.abs(lengths.video - lengths.audio)).toBeLessThan(0.05);
  });

  test("trim off a keyframe re-encodes and is still the right length", async () => {
    const job = await run({ inputs: [clip5], ops: [{ op: "trim", in_s: 1.3, out_s: 3.3 }], output: out("t2.mp4") }, 60_000);
    expect(job.state).toBe("done");
    expect(job.result.steps[0].action).toBe("encode");
    const lengths = await streamDurations(job.result.path);
    expect(Math.abs(lengths.format - 2)).toBeLessThan(0.08);
    expect(Math.abs(lengths.video - lengths.audio)).toBeLessThan(0.05);
  });

  test("concat joins two clips of different sizes at the first clip's size", async () => {
    const job = await run({ inputs: [clip5, clip2], ops: [{ op: "concat" }], output: out("j.mp4") }, 120_000);
    expect(job.state).toBe("done");
    expect(job.result.steps[0].action).toBe("encode");
    expect(job.result).toMatchObject({ width: 320, height: 180 });
    expect(Math.abs(job.result.duration_s - 7)).toBeLessThan(0.2);
    expect(job.result.streams.some((stream: any) => stream.type === "audio")).toBe(true);
  });

  test("audio_overlay mixes a 2 s sine over a 5 s clip, the mix differs, the picture stream is bit-identical", async () => {
    const job = await run({ inputs: [clip5, tone], ops: [{ op: "audio_overlay", input: 1, gain_db: -6, clip_gain_db: -6, start_s: 1 }], output: out("m.mp4") }, 120_000);
    expect(job.state).toBe("done");
    expect(Math.abs(job.result.duration_s - 5)).toBeLessThan(0.1);
    expect(await md5(job.result.path, "0:v:0")).toBe(await md5(clip5, "0:v:0"));
    expect(await md5(job.result.path, "0:a:0")).not.toBe(await md5(clip5, "0:a:0"));
  });

  test("mute leaves no audio stream and the picture untouched", async () => {
    const job = await run({ inputs: [clip5], ops: [{ op: "mute" }], output: out("mute.mp4") }, 60_000);
    expect(job.state).toBe("done");
    expect(job.result.streams.some((stream: any) => stream.type === "audio")).toBe(false);
    expect(job.result.audio_codec).toBeNull();
    expect(await md5(job.result.path, "0:v:0")).toBe(await md5(clip5, "0:v:0"));
  });

  test("frame writes a png of the clip's size", async () => {
    const job = await run({ inputs: [clip5], ops: [{ op: "frame", at_s: 2 }], output: out("f.png") }, 60_000);
    expect(job.state).toBe("done");
    expect(job.result).toMatchObject({ container: "png", width: 320, height: 180, duration_s: null });
    expect(readFileSync(job.result.path).subarray(0, 4).toString("hex")).toBe("89504e47");
  });

  test("fade keeps the length", async () => {
    const job = await run({ inputs: [clip5], ops: [{ op: "fade", in_s: 0.5, out_s: 0.5 }], output: out("fade.mp4") }, 60_000);
    expect(job.state).toBe("done");
    expect(Math.abs(job.result.duration_s - 5)).toBeLessThan(0.1);
  });

  test("a real deadline kills the real ffmpeg", async () => {
    const prior = MEDIA_DEADLINES_MS["media.edit"]; MEDIA_DEADLINES_MS["media.edit"] = 1;
    try {
      const job = await run({ inputs: [clip5], ops: [{ op: "fade", in_s: 1 }], output: out("late.mp4") }, 20_000);
      expect(job.state).toBe("failed");
    } finally { MEDIA_DEADLINES_MS["media.edit"] = prior; }
    expect(existsSync(join(root, "late.mp4"))).toBe(false);
  });
  void priorNice; void mkdirSync;
});
