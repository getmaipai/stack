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
import { concatCompatible, concatEncodeArgs, crossfadeArgs, gainArgs, hasKeyframeAt, overlayArgs, trimArgs } from "@/media/editOps";
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
    await refused({ inputs: [clip], ops: [{ op: "explode" }], output: out }, /does not know.*trim, concat, mute, frame, audio_overlay, fade, crossfade, gain/);
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
    const args = overlayArgs("ffmpeg", { path: "/a.m4a", probe: audioOnly }, "/v.wav", "/o.mp4", { op: "audio_overlay", input: 1, gain_db: 0, clip_gain_db: 0, start_s: 0, duck: false, fade_in_s: 0, fade_out_s: 0 });
    expect(args).not.toContain("0:v:0");
  });
});

describe("media.edit crossfade plan", () => {
  const probe = (seconds: number, audio = true) => normalizeProbe(JSON.parse(probeJson(seconds, audio)), "/x.mp4", 1);
  test("offsets accumulate: sum of the previous lengths minus k times the blend, one acrossfade per seam, silence for a clip without sound", () => {
    const args = crossfadeArgs("ffmpeg", [{ path: "/a", probe: probe(5) }, { path: "/b", probe: probe(4, false) }, { path: "/c", probe: probe(3) }], 0.5, "/o.mp4");
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("xfade=transition=fade:duration=0.5:offset=4.5");
    expect(graph).toContain("xfade=transition=fade:duration=0.5:offset=8");
    expect(graph.match(/acrossfade=d=0.5/g)?.length).toBe(2);
    expect(graph).toMatch(/anullsrc.*atrim=0:4/);
  });
  test("no sound anywhere: video only", () => {
    const args = crossfadeArgs("ffmpeg", [{ path: "/a", probe: probe(5, false) }, { path: "/b", probe: probe(4, false) }], 0.3, "/o.mp4");
    expect(args.join(" ")).not.toContain("acrossfade");
    expect(args).not.toContain("[a]");
  });
});

describe("media.edit crossfade validation", () => {
  beforeEach(() => { freshRoots(); script = () => ({}); setMediaDepsForTests({ toolbox: fakeToolbox, run: fakeRun, limiter: new HostLimiter() }); registerMediaJobs(); });
  afterEach(cleanRoots);
  test("refuses a bad blend length, one file, more than six clips and a missing list position, each with a plain sentence", async () => {
    const a = touch("a.mp4"); const b = touch("b.mp4");
    const refused = async (input: unknown, words: RegExp) => { const { status, body } = await post(input); expect({ status, code: body.code }).toEqual({ status: 422, code: "bad_input" }); expect(body.error).toMatch(words); };
    const out = { name: "o.mp4" };
    await refused({ inputs: [a, b], ops: [{ op: "crossfade", duration_s: 0.1 }], output: out }, /duration_s: must be from 0.3 to 1 seconds/);
    await refused({ inputs: [a, b], ops: [{ op: "crossfade", duration_s: 2 }], output: out }, /duration_s: must be from 0.3 to 1 seconds/);
    await refused({ inputs: [a], ops: [{ op: "crossfade" }], output: out }, /needs at least two files/);
    await refused({ inputs: [a, a, a, a, a, a, a], ops: [{ op: "crossfade" }], output: out }, /blends 7 clips and the limit is 6/);
    await refused({ inputs: [a, b], ops: [{ op: "crossfade", with: [5] }], output: out }, /not in the list/);
    expect((await post({ inputs: [a, b], ops: [{ op: "crossfade" }], output: out })).status).toBe(202);
    expect((await post({ inputs: [a, a, a, a, a, a], ops: [{ op: "crossfade", duration_s: 1 }], output: out })).status).toBe(202);
  });
  test("a clip no longer than twice the blend is refused with its length", async () => {
    const a = touch("a.mp4"); const b = touch("b.mp4");
    script = (argv) => (argv[0]!.endsWith("ffprobe") ? { stdout: probeJson(argv.includes(b) ? 0.8 : 5) } : {});
    const job = await run({ inputs: [a, b], ops: [{ op: "crossfade", duration_s: 0.5 }], output: { name: "o.mp4" } });
    expect(job.state).toBe("failed");
    expect(job.result.failure.code).toBe("bad_input");
    expect(job.result.failure.message).toMatch(/File 2 is 0.8 s long, too short for a 0.5 s crossfade/);
  });
});

describe("media.edit gain and overlay fades: plans and validation", () => {
  beforeEach(() => { freshRoots(); script = (argv) => (argv[0]?.endsWith("ffprobe") ? { stdout: probeJson(5) } : {}); setMediaDepsForTests({ toolbox: fakeToolbox, run: fakeRun, limiter: new HostLimiter() }); registerMediaJobs(); });
  afterEach(cleanRoots);
  const probe = (seconds: number, audio = true) => normalizeProbe(JSON.parse(probeJson(seconds, audio)), "/x.mp4", 1);
  const refused = async (input: unknown, pattern: RegExp) => { const { status, body } = await post(input); expect(status).toBe(422); expect(body.error).toMatch(pattern); };

  test("gain copies the picture and sets volume in dB; the overlay trims, fades in, fades out before the delay", () => {
    const g = gainArgs("ffmpeg", "/a.mp4", "/o.mp4", { op: "gain", db: -6 }).join(" ");
    expect(g).toContain("-c:v copy"); expect(g).toContain("volume=-6dB");
    const args = overlayArgs("ffmpeg", { path: "/a", probe: probe(5) }, "/t.wav", "/o.mp4", { op: "audio_overlay", input: 1, gain_db: 0, clip_gain_db: 0, start_s: 0.5, duck: false, fade_in_s: 1, fade_out_s: 1, end_s: 3.5 }, 4);
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("[1:a:0]atrim=0:3,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=1,afade=t=out:st=2:d=1,volume=0dB");
    expect(graph.indexOf("afade")).toBeLessThan(graph.indexOf("adelay=500|500"));
  });
  test("refuses a gain outside -60 to 24 dB, a missing db, an end before the start, and fades longer than the overlay, each with a plain sentence", async () => {
    const a = touch("a.mp4"); const b = touch("b.wav"); const out = { name: "o.mp4" };
    await refused({ inputs: [a], ops: [{ op: "gain", db: 30 }], output: out }, /db: must be from -60 to 24 dB/);
    await refused({ inputs: [a], ops: [{ op: "gain", db: -61 }], output: out }, /db: must be from -60 to 24 dB/);
    await refused({ inputs: [a], ops: [{ op: "gain" }], output: out }, /ops > 1/);
    await refused({ inputs: [a, b], ops: [{ op: "audio_overlay", input: 1, start_s: 2, end_s: 2 }], output: out }, /ends at 2 s but starts at 2 s/);
    await refused({ inputs: [a, b], ops: [{ op: "audio_overlay", input: 1, start_s: 1, end_s: 3, fade_in_s: 1.5, fade_out_s: 1 }], output: out }, /fades for 2.5 s in all, longer than the 2 s between start_s and end_s/);
    await refused({ inputs: [a, b], ops: [{ op: "audio_overlay", input: 1, fade_in_s: -1 }], output: out }, /fade_in_s/);
    expect((await post({ inputs: [a], ops: [{ op: "gain", db: -60 }, { op: "gain", db: 24 }], output: out })).status).toBe(202);
    expect((await post({ inputs: [a, b], ops: [{ op: "audio_overlay", input: 1, start_s: 1, end_s: 3, fade_in_s: 1, fade_out_s: 1 }], output: out })).status).toBe(202);
  });
  test("a clip with no sound, an end past the clip and fades longer than the overlay's own length fail with a sentence", async () => {
    const a = touch("a.mp4"); const b = touch("b.wav");
    script = (argv) => (argv[0]?.endsWith("ffprobe") ? { stdout: argv.includes(b) ? probeJson(2) : probeJson(5, false) } : {});
    const gain = await run({ inputs: [a], ops: [{ op: "gain", db: -6 }], output: { name: "o.mp4" } });
    expect(gain.state).toBe("failed"); expect(gain.result.failure.message).toMatch(/Step 1 \(gain\) changes the clip's sound level, but the clip has no sound/);
    const past = await run({ inputs: [a, b], ops: [{ op: "audio_overlay", input: 1, end_s: 9 }], output: { name: "o.mp4" } });
    expect(past.result.failure.message).toMatch(/ends at 9 s but the clip is only 5 s long/);
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
  let clipSilent = ""; let tone4 = ""; let clip5 = ""; let clipNoB = ""; let clip2 = ""; let tone = "";
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
    tone4 = join(dir, "tone4.wav"); clipSilent = join(dir, "silent5.mp4");
    await ff(["-f", "lavfi", "-i", "sine=f=880:r=48000:d=4", tone4]);
    await ff(["-f", "lavfi", "-i", "testsrc=s=320x180:r=24:d=5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", clipSilent]);
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

  test("crossfade of three clips (one silent, one a different size): length is the sum minus the seams, sound present, the seam frame is a blend", async () => {
    const dir = join(clip5, "..");
    const silent = join(dir, "silent3.mp4"); const other = join(dir, "other4.mp4");
    await ff(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", silent]);
    await ff(["-f", "lavfi", "-i", "smptebars=s=320x180:r=24:d=4", "-f", "lavfi", "-i", "sine=f=660:r=48000:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", other]);
    const d = 0.5;
    const job = await run({ inputs: [clip5, silent, other], ops: [{ op: "crossfade", duration_s: d }], output: out("x3.mp4") }, 120_000);
    expect(job.state).toBe("done");
    expect(job.result).toMatchObject({ width: 320, height: 180, audio_codec: "aac" });
    expect(Math.abs(job.result.duration_s - (12 - 2 * d))).toBeLessThan(1 / 24 + 0.03);
    const lengths = await streamDurations(job.result.path);
    expect(Math.abs(lengths.video - lengths.audio)).toBeLessThan(0.1);
    // Seam 1 runs 4.5 to 5.0 s; at 4.75 the picture is half of clip 1 and half of clip 2 (which is at 0.25 s of its own time).
    const gray = async (path: string, at: number, name: string): Promise<Buffer> => { const file = join(root, name); await ff(["-ss", String(at), "-i", path, "-frames:v", "1", "-vf", "scale=320:180,format=gray", "-f", "rawvideo", file]); return readFileSync(file); };
    const mix = await gray(job.result.path, 4.75, "mix.raw"); const first = await gray(clip5, 4.75, "first.raw"); const second = await gray(silent, 0.25, "second.raw");
    const diff = (x: Buffer, y: Buffer) => { let sum = 0; for (let i = 0; i < x.length; i++) sum += Math.abs(x[i]! - y[i]!); return sum / x.length; };
    const average = Buffer.from(first.map((value, i) => Math.round((value + second[i]!) / 2)));
    expect(diff(mix, first)).toBeGreaterThan(8);
    expect(diff(mix, second)).toBeGreaterThan(8);
    expect(diff(mix, average)).toBeLessThan(Math.min(diff(mix, first), diff(mix, second)) / 2);
    // Outside the seam the picture is the plain clip.
    expect(diff(await gray(job.result.path, 2, "p.raw"), await gray(clip5, 2, "q.raw"))).toBeLessThan(6);
  });

  test("crossfade of two clips with sound and the default 0.5 s blend, and a clip too short for the blend fails with a sentence", async () => {
    const job = await run({ inputs: [clip5, clip2], ops: [{ op: "crossfade" }], output: out("x2.mp4") }, 120_000);
    expect(job.state).toBe("done");
    expect(Math.abs(job.result.duration_s - 6.5)).toBeLessThan(0.1);
    expect(job.result.streams.some((stream: any) => stream.type === "audio")).toBe(true);
    const short = await run({ inputs: [clip5, clip2], ops: [{ op: "crossfade", duration_s: 1 }], output: out("x2s.mp4") }, 60_000);
    expect(short.state).toBe("failed");
    expect(short.result.failure.message).toMatch(/too short for a 1 s crossfade/);
  });

  test("audio_overlay mixes a 2 s sine over a 5 s clip, the mix differs, the picture stream is bit-identical", async () => {
    const job = await run({ inputs: [clip5, tone], ops: [{ op: "audio_overlay", input: 1, gain_db: -6, clip_gain_db: -6, start_s: 1 }], output: out("m.mp4") }, 120_000);
    expect(job.state).toBe("done");
    expect(Math.abs(job.result.duration_s - 5)).toBeLessThan(0.1);
    expect(await md5(job.result.path, "0:v:0")).toBe(await md5(clip5, "0:v:0"));
    expect(await md5(job.result.path, "0:a:0")).not.toBe(await md5(clip5, "0:a:0"));
  });

  async function level(path: string, from: number, length: number): Promise<{ mean: number; max: number }> {
    const result = await spawnRunner([ffmpeg!, "-hide_banner", "-nostats", "-ss", String(from), "-t", String(length), "-i", path, "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"], { collectStdout: true });
    const text = `${result.stdout}\n${result.stderr}`;
    const read = (key: string) => { const found = new RegExp(`${key}: (-?[\\d.]+|-inf) dB`).exec(text)?.[1]; return found === undefined || found === "-inf" ? -120 : Number(found); };
    return { mean: read("mean_volume"), max: read("max_volume") };
  }

  test("gain of -6.02 dB halves the measured amplitude (within 0.5 dB), keeps the length, copies the picture; +6 dB doubles it", async () => {
    const before = await level(clip5, 0.5, 4);
    const down = await run({ inputs: [clip5], ops: [{ op: "gain", db: -6.02 }], output: out("g-down.mp4") }, 60_000);
    expect(down.state).toBe("done");
    expect(Math.abs(down.result.duration_s - 5)).toBeLessThan(0.1);
    expect(await md5(down.result.path, "0:v:0")).toBe(await md5(clip5, "0:v:0"));
    const after = await level(down.result.path, 0.5, 4);
    expect(Math.abs(before.mean - after.mean - 6.02)).toBeLessThan(0.5);
    const up = await run({ inputs: [clip5], ops: [{ op: "gain", db: 6 }], output: out("g-up.mp4") }, 60_000);
    expect(Math.abs((await level(up.result.path, 0.5, 4)).mean - before.mean - 6)).toBeLessThan(0.5);
  });

  test("gain on a clip with no sound fails with a plain sentence", async () => {
    const job = await run({ inputs: [clipSilent], ops: [{ op: "gain", db: -6 }], output: out("g-none.mp4") }, 60_000);
    expect(job.state).toBe("failed");
    expect(job.result.failure.message).toMatch(/has no sound/);
  });

  test("audio_overlay fades ramp, end_s trims the overlay and the clip's own sound is untouched", async () => {
    // Silent-sound 5 s clip, a 4 s tone laid from 0.5 s to 3.5 s with 1 s fades each side.
    const job = await run({ inputs: [clipSilent, tone4], ops: [{ op: "audio_overlay", input: 1, start_s: 0.5, end_s: 3.5, fade_in_s: 1, fade_out_s: 1 }], output: out("fade.mp4") }, 120_000);
    expect(job.state).toBe("done");
    expect(Math.abs(job.result.duration_s - 5)).toBeLessThan(0.1);
    const full = await level(job.result.path, 1.7, 0.6); // inside the flat part
    const early = await level(job.result.path, 0.5, 0.15); const late = await level(job.result.path, 3.35, 0.15);
    expect(full.max).toBeGreaterThan(-24); // the sine source peaks near -21 dB
    expect(full.max - early.max).toBeGreaterThan(8); // the start is ramping up
    expect(full.max - late.max).toBeGreaterThan(8); // the end is ramping down
    expect((await level(job.result.path, 0, 0.4)).max).toBeLessThan(-60); // before start_s
    expect((await level(job.result.path, 3.7, 1.2)).max).toBeLessThan(-60); // after end_s: the 4 s tone is cut at 3 s of its own
    // Without fades or end_s the overlay is unchanged: full level from the start and a tone to its own end (0.5 + 4 = 4.5 s).
    const plain = await run({ inputs: [clipSilent, tone4], ops: [{ op: "audio_overlay", input: 1, start_s: 0.5 }], output: out("plain.mp4") }, 120_000);
    expect((await level(plain.result.path, 0.55, 0.15)).max).toBeGreaterThan(-24);
    expect((await level(plain.result.path, 4.2, 0.2)).max).toBeGreaterThan(-24);
    expect((await level(plain.result.path, 4.65, 0.3)).max).toBeLessThan(-60);
  });

  test("an overlay fade longer than the overlay's own length fails with a sentence", async () => {
    const job = await run({ inputs: [clipSilent, tone], ops: [{ op: "audio_overlay", input: 1, fade_in_s: 1.5, fade_out_s: 1 }], output: out("fade-long.mp4") }, 60_000);
    expect(job.state).toBe("failed");
    expect(job.result.failure.message).toMatch(/fades for 2.5 s in all, longer than the 2 s overlay/);
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
