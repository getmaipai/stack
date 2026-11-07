// SPATIAL-03: the `spatial_sound` edit op. Plans and refusals with a fake runner; the render, the 5.1 sibling and the numbers with the real
// Stack ffmpeg on a generated clip whose tone is panned by construction.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __resetJobsForTests, waitForJob } from "@/lib/jobs";
import { EDIT_OPS, editInputProblem, spatialArgs, SPATIAL_INLINE_GRAPH_LIMIT } from "@/media/editOps";
import { HostLimiter } from "@/media/hosts";
import { MEDIA_DEADLINES_MS, registerMediaJobs, resetMediaDepsForTests, setMediaDepsForTests } from "@/media/jobs";
import { __resetRootsForTests, jobsDir, setRoots } from "@/media/paths";
import { spawnRunner, type Runner, type RunResult } from "@/media/run";
import { resetSpatialDepsForTests, setSpatialDepsForTests } from "@/media/spatialSound";
import { spatialGains, spatialGraph, SPATIAL_LINES } from "@/media/spatialRender";
import type { SpatialSegment } from "@/media/spatialTrack";
import type { MediaToolbox } from "@/media/tools";

const base = { inputs: ["/clip.mp4"], output: { name: "out.mp4" } };
const problem = (ops: unknown[], output: { name: string } = base.output) => editInputProblem({ ...base, output, ops });

describe("spatial_sound plans", () => {
  test("it is one more entry in EDIT_OPS, added at the end", () => {
    expect(EDIT_OPS.at(-1)).toBe("spatial_sound");
    expect(EDIT_OPS).toContain("cutout");
  });
  test("it takes no args or a surround boolean, and nothing else (the request cannot smuggle positions in)", () => {
    expect(problem([{ op: "spatial_sound" }])).toBeNull();
    expect(problem([{ op: "spatial_sound", surround: false }])).toBeNull();
    expect(problem([{ op: "spatial_sound", surround: true }])).toBeNull();
    expect(problem([{ op: "spatial_sound", surround: "yes" }])).toMatch(/surround/);
    expect(problem([{ op: "spatial_sound", segments: [{ start_s: 0, end_s: 1, position: -1 }] }])).toMatch(/segments/);
    expect(problem([{ op: "spatial_sound", positions: [] }])).toMatch(/does not know/);
  });
  test("the 5.1 file must be made by the last step, with a plain line", () => {
    expect(problem([{ op: "spatial_sound", surround: true }, { op: "fade", out_s: 1 }])).toBe(SPATIAL_LINES.not_last);
    expect(SPATIAL_LINES.not_last).toBe("Make the 5.1 file as the last step of the edit.");
    expect(problem([{ op: "fade", out_s: 1 }, { op: "spatial_sound", surround: true }])).toBeNull();
    expect(problem([{ op: "spatial_sound" }, { op: "fade", out_s: 1 }])).toBeNull(); // stereo may sit anywhere
  });
  test("one spatial_sound step per edit", () => {
    expect(problem([{ op: "spatial_sound" }, { op: "spatial_sound" }])).toMatch(/only once/);
  });
  test("a 5.1 file needs an .mp4 or .mov output (webm cannot hold E-AC-3), with a plain line", () => {
    expect(problem([{ op: "spatial_sound", surround: true }], { name: "o.webm" })).toMatch(/\.mp4 or \.mov/);
    expect(problem([{ op: "spatial_sound", surround: true }], { name: "o.mov" })).toBeNull();
    expect(problem([{ op: "spatial_sound" }], { name: "o.png" })).toMatch(/png/);
  });
});

describe("spatial gains and the filter graph", () => {
  test("constant-power pan: the middle is 1 and 1; far left and far right are the extremes and keep the power", () => {
    const mid = spatialGains(0);
    expect(mid.l).toBeCloseTo(1, 9); expect(mid.r).toBeCloseTo(1, 9); expect(mid.c).toBeCloseTo(1, 9);
    const left = spatialGains(-0.75);
    expect(left.l).toBeGreaterThan(left.r);
    expect(left.c).toBeCloseTo(0.25, 9); // 1 - |p|
    for (const p of [-1, -0.75, -0.2, 0, 0.44, 1]) { const g = spatialGains(p); expect(g.l ** 2 + g.r ** 2).toBeCloseTo(2, 9); }
    expect(20 * Math.log10(spatialGains(-0.75).l / spatialGains(-0.75).r)).toBeCloseTo(14.0, 0);
    expect(20 * Math.log10(spatialGains(0.44).l / spatialGains(0.44).r)).toBeCloseTo(-6.2, 0);
  });
  const segs: SpatialSegment[] = [{ start_s: 1.8, end_s: 3.77, position: -0.75 }];
  test("the stereo graph is mid/side with no -shortest anywhere, and the 5.1 graph has six named channels", () => {
    const stereo = spatialGraph(segs, 5, false);
    expect(stereo).toContain("amix=inputs=2:normalize=0");
    expect(stereo).toContain("eval=frame");
    expect(stereo).not.toContain("amerge=inputs=6");
    const surround = spatialGraph(segs, 5, true);
    expect(surround).toContain("amerge=inputs=6");
    expect(surround).toContain("channel_layout=5.1");
    expect(surround).toContain("lowpass=f=120");
    expect(surround).toContain("adelay=10");
    expect(surround).toContain("lowpass=f=7000");
  });
  test("builders keep the picture bytes (-c:v copy), the container metadata (-map_metadata 0) and never use -shortest", () => {
    for (const surround of [false, true]) {
      const args = spatialArgs("ffmpeg", "/in.mp4", "/out.mp4", { graph: spatialGraph(segs, 5, surround), surround, scriptPath: null });
      expect(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2)).toEqual(["-c:v", "copy"]);
      expect(args[args.indexOf("-map_metadata") + 1]).toBe("0");
      expect(args).not.toContain("-shortest");
      expect(args).toContain(surround ? "eac3" : "aac");
      expect(args[args.indexOf("-b:a") + 1]).toBe(surround ? "384k" : "192k");
      expect(args).toContain("0:v:0?");
    }
  });
  test("64 segments make a long expression; it goes through a script file instead of one argument and still names every segment", () => {
    const many: SpatialSegment[] = Array.from({ length: 64 }, (_, i) => ({ start_s: i * 1.0, end_s: i * 1.0 + 0.6, position: i % 2 ? 0.7 : -0.7 }));
    const graph = spatialGraph(many, 70, true);
    expect(graph.length).toBeGreaterThan(SPATIAL_INLINE_GRAPH_LIMIT);
    const args = spatialArgs("ffmpeg", "/in.mp4", "/out.mp4", { graph, surround: true, scriptPath: "/work/graph.txt" });
    expect(args).toContain("-/filter_complex");
    expect(args).toContain("/work/graph.txt");
    expect(args.join(" ")).not.toContain("volume=");
    const small = spatialArgs("ffmpeg", "/in.mp4", "/out.mp4", { graph: spatialGraph(segs, 5, false), surround: false, scriptPath: null });
    expect(small).toContain("-filter_complex");
  });
  test("overlapping or unsorted segments are put in order without breaking time", () => {
    const graph = spatialGraph([{ start_s: 3, end_s: 4, position: 0.5 }, { start_s: 1, end_s: 3.5, position: -0.5 }], 6, false);
    expect(graph).toContain("volume=");
  });
});

// ---- fake runner: refusals that need a probe but no ffmpeg ----
let root = ""; const calls: string[][] = [];
const ok: RunResult = { code: 0, stdout: "", stderr: "", aborted: false };
const fakeToolbox: MediaToolbox = { installed: () => true, path: async (tool) => `/fake/bin/${tool}` };
const probeJson = (audio: boolean, video = true) => JSON.stringify({ format: { format_name: "mov,mp4", duration: "5" }, streams: [...(video ? [{ index: 0, codec_type: "video", codec_name: "h264", width: 640, height: 360, pix_fmt: "yuv420p", avg_frame_rate: "24/1" }] : []), ...(audio ? [{ index: video ? 1 : 0, codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000" }] : [])], chapters: [] });
async function post(input: unknown): Promise<{ status: number; body: any }> {
  const response = await app.request("/stack/v1/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "media.edit", input }) });
  return { status: response.status, body: await response.json() };
}
async function run(input: unknown, wait = 20_000): Promise<any> {
  const { status, body } = await post(input);
  if (status !== 202) throw new Error(`refused ${status}: ${JSON.stringify(body)}`);
  return waitForJob(body.job.id, wait);
}
function fresh(): void { __resetJobsForTests(); __resetRootsForTests(); calls.length = 0; root = realpathSync(mkdtempSync(join(tmpdir(), "spatial-edit-"))); setRoots({ read: [root], write: [root] }); }
function clean(): void { __resetJobsForTests(); __resetRootsForTests(); resetMediaDepsForTests(); resetSpatialDepsForTests(); rmSync(root, { recursive: true, force: true }); rmSync(jobsDir(), { recursive: true, force: true }); }

describe("spatial_sound with a fake runner", () => {
  beforeEach(() => { fresh(); });
  afterEach(clean);
  const useProbe = (audio: boolean, video = true) => {
    const fakeRun: Runner = async (argv) => { calls.push(argv); return { ...ok, stdout: argv[0]!.endsWith("ffprobe") ? probeJson(audio, video) : "" }; };
    setMediaDepsForTests({ toolbox: fakeToolbox, run: fakeRun, limiter: new HostLimiter() }); registerMediaJobs();
  };
  test("a clip with no sound is refused with a plain line and nothing is analysed", async () => {
    useProbe(false);
    let looked = 0;
    setSpatialDepsForTests({ look: async () => { looked += 1; return []; }, speech: async () => [] });
    writeFileSync(join(root, "a.mp4"), "x");
    const job = await run({ inputs: [join(root, "a.mp4")], ops: [{ op: "spatial_sound" }], output: { name: "o.mp4" } });
    expect(job).toMatchObject({ state: "failed", result: { failure: { code: "no_audio" } } });
    expect(job.result.failure.message).toBe("This clip has no sound, so there is nothing to place. Make or add sound first.");
    expect(looked).toBe(0);
    expect(calls.some((argv) => argv.includes("-filter_complex") || argv.includes("-/filter_complex"))).toBe(false);
  });
  test("a clip with sound but no picture is refused with a plain line", async () => {
    useProbe(true, false);
    writeFileSync(join(root, "a.m4a"), "x");
    const job = await run({ inputs: [join(root, "a.m4a")], ops: [{ op: "spatial_sound" }], output: { name: "o.mp4" } });
    expect(job).toMatchObject({ state: "failed", result: { failure: { code: "bad_input" } } });
    expect(job.result.failure.message).toMatch(/needs a picture/);
  });
  test("the not-last and twice refusals come back as 422 at submit", async () => {
    useProbe(true);
    writeFileSync(join(root, "a.mp4"), "x");
    const response = await post({ inputs: [join(root, "a.mp4")], ops: [{ op: "spatial_sound", surround: true }, { op: "fade", out_s: 1 }], output: { name: "o.mp4" } });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).toContain("Make the 5.1 file as the last step of the edit.");
  });
  test("the media.edit deadline table is unchanged", () => { expect(MEDIA_DEADLINES_MS["media.edit"]).toBe(30 * 60_000); });
});

// ---- real ffmpeg ----
const FFMPEG = process.env.STACK_MEDIA_FFMPEG && existsSync(process.env.STACK_MEDIA_FFMPEG) ? process.env.STACK_MEDIA_FFMPEG : ["/usr/local/maipai-home/stack/data/engines/ffmpeg/current/ffmpeg", "/opt/homebrew/bin/ffmpeg"].find(existsSync) ?? null;
const FFPROBE = FFMPEG ? [FFMPEG.replace(/ffmpeg$/, "ffprobe")].find(existsSync) ?? null : null;
if (!(FFMPEG && FFPROBE)) console.warn("SPATIAL-03 real ffmpeg tests skipped: set STACK_MEDIA_FFMPEG or install the Stack ffmpeg (data/engines/ffmpeg/current).");
const real = FFMPEG && FFPROBE ? describe : describe.skip;

async function bytes(argv: string[]): Promise<Uint8Array> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const out = new Uint8Array(await new Response(child.stdout).arrayBuffer()); await child.exited; return out;
}
/** RMS of one channel of `file` between from_s and to_s, as a linear amplitude. */
async function channelRms(file: string, channel: number, channels: number, from: number, to: number): Promise<number> {
  const raw = await bytes([FFMPEG!, "-hide_banner", "-loglevel", "error", "-ss", String(from), "-t", String(to - from), "-i", file, "-map", "0:a:0", "-af", `pan=mono|c0=c${channel}`, "-f", "f32le", "-ar", "48000", "-"]);
  const samples = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
  let sum = 0; for (const v of samples) sum += v * v; void channels;
  return Math.sqrt(sum / Math.max(1, samples.length));
}
const probeOf = async (file: string): Promise<any> => JSON.parse(new TextDecoder().decode(await bytes([FFPROBE!, "-v", "error", "-show_streams", "-show_format", "-of", "json", file])));
const videoMd5 = async (file: string): Promise<string> => new TextDecoder().decode(await bytes([FFMPEG!, "-hide_banner", "-loglevel", "error", "-i", file, "-map", "0:v:0", "-c", "copy", "-f", "md5", "-"])).trim();
const db = (ratio: number): number => 20 * Math.log10(ratio);

real("spatial_sound with the real ffmpeg on a clip whose tone is panned by construction", () => {
  let dir = "";
  const lines: string[] = [];
  // 6 s, picture with a title tag, a 440 Hz tone identical in both channels (so the side signal is zero), and a quiet 220 Hz second half.
  async function makeClip(name: string, extra: string[] = []): Promise<string> {
    const path = join(dir, name);
    const made = await spawnRunner([FFMPEG!, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=24:duration=6", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=6", "-ac", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-metadata", "title=Spatial test clip", "-metadata", "comment=kept", ...extra, path]);
    expect(made.code).toBe(0);
    return path;
  }
  beforeEach(() => {
    fresh(); dir = realpathSync(mkdtempSync(join(tmpdir(), "spatial-real-"))); setRoots({ read: [dir], write: [dir] });
    setMediaDepsForTests({ toolbox: { installed: () => true, path: async (tool) => tool === "ffmpeg" ? FFMPEG! : FFPROBE! }, run: spawnRunner, limiter: new HostLimiter() }); registerMediaJobs();
  });
  afterEach(() => { clean(); rmSync(dir, { recursive: true, force: true }); });
  const spans = (a: number, b: number) => [{ startSample: Math.round(a * 16_000), endSample: Math.round(b * 16_000) }];
  const person = (centre: number) => [[(centre + 1) / 2 - 0.1, 0.2, 0.2, 0.6]];

  test("a man on the left (position about -0.75) while the tone plays: left louder by about 14 dB, 2 channels AAC, picture bytes and tags kept, 5.1 sibling with FL over FC over FR over BL and BR", async () => {
    const clip = await makeClip("in.mp4");
    setSpatialDepsForTests({ look: async (frames) => frames.map(() => person(-0.75).map((box) => ({ label: "person", score: 0.9, box }))), speech: async () => spans(2, 4) });
    const job = await run({ inputs: [clip], ops: [{ op: "spatial_sound", surround: true }], output: { dir, name: "out.mp4" } }, 120_000);
    expect(job.state).toBe("done");
    const result = job.result;
    expect(result.spatial).toMatchObject({ applied: true, surround: true });
    expect(result.spatial.segments).toBe(1);
    expect(result.files).toHaveLength(2);
    expect(result.files[0]).toMatchObject({ role: "stereo", name: "out.mp4", audio_codec: "aac", channels: 2 });
    expect(result.files[1]).toMatchObject({ role: "surround_5_1", name: "out-5.1.mp4", audio_codec: "eac3", channels: 6 });
    expect(result.path).toBe(join(dir, "out.mp4"));
    expect(existsSync(result.files[1].path)).toBe(true);

    const stereo = await probeOf(result.files[0].path); const sur = await probeOf(result.files[1].path);
    const sAudio = stereo.streams.find((s: any) => s.codec_type === "audio"); const rAudio = sur.streams.find((s: any) => s.codec_type === "audio");
    expect([sAudio.codec_name, sAudio.channels]).toEqual(["aac", 2]);
    expect([rAudio.codec_name, rAudio.channels]).toEqual(["eac3", 6]);
    // the picture is not touched, the length is the source length, the tags are kept
    const source = await videoMd5(clip);
    expect(await videoMd5(result.files[0].path)).toBe(source);
    expect(await videoMd5(result.files[1].path)).toBe(source);
    expect(Math.abs(Number(stereo.format.duration) - Number((await probeOf(clip)).format.duration))).toBeLessThan(0.05);
    expect(stereo.format.tags?.title).toBe("Spatial test clip");
    expect(sur.format.tags?.title).toBe("Spatial test clip");

    // stereo: inside the line the left channel is louder by the constant-power pan; outside it nothing moved
    const l = await channelRms(result.files[0].path, 0, 2, 2.3, 3.7), r = await channelRms(result.files[0].path, 1, 2, 2.3, 3.7);
    const gains = spatialGains(-0.75);
    const balance = (r - l) / (r + l); const formula = (gains.r - gains.l) / (gains.r + gains.l);
    lines.push(`pan-left tone: L minus R ${db(l / r).toFixed(1)} dB, balance ${balance.toFixed(3)}, formula ${formula.toFixed(3)}`);
    expect(db(l / r)).toBeGreaterThan(13); expect(db(l / r)).toBeLessThan(15.5);
    expect(Math.abs(balance - formula)).toBeLessThan(0.02);
    const l0 = await channelRms(result.files[0].path, 0, 2, 0.3, 1.2), r0 = await channelRms(result.files[0].path, 1, 2, 0.3, 1.2);
    expect(Math.abs(db(l0 / r0))).toBeLessThan(0.5);

    // 5.1: FL > FC > FR > BL, BR  (FC gain is 1 - |p| = 0.25, FR is the quiet side)
    const [fl, fr, fc, lfe, bl, br] = await Promise.all([0, 1, 2, 3, 4, 5].map((c) => channelRms(result.files[1].path, c, 6, 2.3, 3.7)));
    lines.push(`5.1 pan-left: FL ${db(fl!).toFixed(1)} FR ${db(fr!).toFixed(1)} FC ${db(fc!).toFixed(1)} LFE ${db(lfe!).toFixed(1)} BL ${db(bl!).toFixed(1)} BR ${db(br!).toFixed(1)} dBFS`);
    expect(fl!).toBeGreaterThan(fr!); expect(fl!).toBeGreaterThan(fc!);
    expect(fr!).toBeGreaterThan(bl!); expect(fc!).toBeGreaterThan(bl!); expect(fr!).toBeGreaterThan(br!);
    expect(fc! / fl!).toBeLessThan(0.5); // a side speaker is mostly front-left, not centre
    expect(result.spatial.rear_quiet).toBe(true); // a mono tone has no width: the plain line applies
    console.log(lines.join("\n"));
    expect(readdirSync(dir).filter((name) => name.startsWith("."))).toEqual([]); // no partial left behind
  }, 180_000);

  test("a man on the right (about +0.44): right louder by about 6 dB", async () => {
    const clip = await makeClip("in.mp4");
    setSpatialDepsForTests({ look: async (frames) => frames.map(() => person(0.44).map((box) => ({ label: "person", score: 0.9, box }))), speech: async () => spans(2, 4) });
    const job = await run({ inputs: [clip], ops: [{ op: "spatial_sound" }], output: { dir, name: "out.mp4" } }, 120_000);
    expect(job.state).toBe("done");
    expect(job.result.files).toHaveLength(1);
    expect(existsSync(join(dir, "out-5.1.mp4"))).toBe(false);
    const l = await channelRms(job.result.path, 0, 2, 2.3, 3.7), r = await channelRms(job.result.path, 1, 2, 2.3, 3.7);
    const gains = spatialGains(0.44);
    const balance = (r - l) / (r + l); const formula = (gains.r - gains.l) / (gains.r + gains.l);
    console.log(`pan-right tone: L minus R ${db(l / r).toFixed(1)} dB, balance ${balance.toFixed(3)}, formula ${formula.toFixed(3)}`);
    expect(db(l / r)).toBeLessThan(-5); expect(db(l / r)).toBeGreaterThan(-7.5);
    expect(Math.abs(balance - formula)).toBeLessThan(0.02);
  }, 180_000);

  test("no person found (a cartoon): unchanged stereo, the plain line, and the audio stream is copied, not re-encoded", async () => {
    const clip = await makeClip("in.mp4");
    setSpatialDepsForTests({ look: async (frames) => frames.map(() => []), speech: async () => spans(2, 4) });
    const job = await run({ inputs: [clip], ops: [{ op: "spatial_sound" }], output: { dir, name: "out.mp4" } }, 120_000);
    expect(job.state).toBe("done");
    expect(job.result.spatial).toMatchObject({ applied: false, reason: "no_person" });
    expect(job.result.spatial.note).toBe(SPATIAL_LINES.no_person);
    expect(SPATIAL_LINES.no_person).toMatch(/unchanged stereo/);
    const l = await channelRms(job.result.path, 0, 2, 2.3, 3.7), r = await channelRms(job.result.path, 1, 2, 2.3, 3.7);
    expect(Math.abs(db(l / r))).toBeLessThan(0.2);
    expect(await videoMd5(job.result.path)).toBe(await videoMd5(clip));
  }, 180_000);

  test("two people in view: the dialog stays in the middle and the plain line says so", async () => {
    const clip = await makeClip("in.mp4");
    setSpatialDepsForTests({ look: async (frames) => frames.map(() => [...person(-0.6), ...person(0.6)].map((box) => ({ label: "person", score: 0.9, box }))), speech: async () => spans(2, 4) });
    const job = await run({ inputs: [clip], ops: [{ op: "spatial_sound" }], output: { dir, name: "out.mp4" } }, 120_000);
    expect(job.state).toBe("done");
    expect(job.result.spatial).toMatchObject({ applied: false, reason: "several_people" });
    const l = await channelRms(job.result.path, 0, 2, 2.3, 3.7), r = await channelRms(job.result.path, 1, 2, 2.3, 3.7);
    expect(Math.abs(db(l / r))).toBeLessThan(0.3);
  }, 180_000);

  test("64 segments render through the script file; the picture and the length survive", async () => {
    const long = join(dir, "long70.mp4");
    const made = await spawnRunner([FFMPEG!, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:size=64x64:rate=5:duration=70", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=70", "-ac", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", long]);
    expect(made.code).toBe(0);
    setSpatialDepsForTests({
      look: async (frames) => frames.map((_, i) => person(Math.floor(i / 4) % 2 ? 0.7 : -0.7).map((box) => ({ label: "person", score: 0.9, box }))),
      speech: async () => Array.from({ length: 64 }, (_, i) => ({ startSample: Math.round((i + 0.1) * 16_000), endSample: Math.round((i + 0.7) * 16_000) })),
    });
    const job = await run({ inputs: [long], ops: [{ op: "spatial_sound", surround: true }], output: { dir, name: "long-out.mp4" } }, 170_000);
    if (job.state !== "done") console.log(JSON.stringify(job.result));
    expect(job.state).toBe("done");
    expect(job.result.spatial.segments).toBeLessThanOrEqual(64);
    expect(job.result.spatial.segments).toBeGreaterThan(30);
    expect(job.result.files).toHaveLength(2);
    expect(Math.abs(Number((await probeOf(job.result.files[1].path)).format.duration) - 70)).toBeLessThan(0.1);
    expect(await videoMd5(job.result.files[1].path)).toBe(await videoMd5(long));
  }, 180_000);

  test("a chain: trim first, then spatial_sound last with 5.1 in the same job", async () => {
    const clip = await makeClip("in.mp4");
    setSpatialDepsForTests({ look: async (frames) => frames.map(() => person(-0.5).map((box) => ({ label: "person", score: 0.9, box }))), speech: async () => spans(0.5, 2) });
    const job = await run({ inputs: [clip], ops: [{ op: "trim", in_s: 0, out_s: 4 }, { op: "spatial_sound", surround: true }], output: { dir, name: "chain.mp4" } }, 120_000);
    expect(job.state).toBe("done");
    expect(job.result.steps.map((s: any) => s.op)).toEqual(["trim", "spatial_sound"]);
    expect(job.result.files).toHaveLength(2);
    expect(Math.abs(job.result.duration_s - 4)).toBeLessThan(0.3);
  }, 180_000);
});

void mkdirSync;
