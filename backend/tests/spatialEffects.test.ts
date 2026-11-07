// SPATIAL-07: sound-source follow (the effects pan) and the two gates. Pure functions on fixed tracks and generated audio; the render with the real
// Stack ffmpeg on clips whose tones are panned by construction; and (when the bench clips and the image-tools environment are on this computer)
// the real Look model on the three bench clips in ~/video-bench/spatial/effects/.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __resetJobsForTests, waitForJob } from "@/lib/jobs";
import { LookService, workerHandle } from "@/look/look";
import { editInputProblem } from "@/media/editOps";
import { HostLimiter } from "@/media/hosts";
import { registerMediaJobs, resetMediaDepsForTests, setMediaDepsForTests } from "@/media/jobs";
import { __resetRootsForTests, jobsDir, setRoots } from "@/media/paths";
import { spawnRunner } from "@/media/run";
import {
  analyzeClipAudio, analyzeStereo, cameraMoving, computeEffectsTrack, effectsGate, impactEvents, mergeKnots, motionPairs, motionPosition, nativeTracksPerson, vehiclePositions, walkerPositions,
  EFFECTS_DUAL_MONO_CORRELATION, EFFECTS_SPATIAL_RANGE, MOTION_H, MOTION_W,
} from "@/media/spatialEffects";
import { resetSpatialDepsForTests, setSpatialDepsForTests } from "@/media/spatialSound";
import { spatialGains, SPATIAL_LINES } from "@/media/spatialRender";
import { smoothPositions } from "@/media/spatialTrack";

const RATE = 16_000;
const dt = 0.25;

// ---- generated audio ----
function stereo(seconds: number, make: (t: number, i: number) => [number, number]): Float32Array {
  const n = Math.round(seconds * RATE); const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { const [l, r] = make(i / RATE, i); out[2 * i] = l; out[2 * i + 1] = r; }
  return out;
}
const tone = (t: number, f = 440): number => 0.5 * Math.sin(2 * Math.PI * f * t);

describe("the gate on the audio (effects pan only)", () => {
  test("identical channels (a knock) are dual mono: correlation 1, balance range 0", () => {
    const stats = analyzeStereo(stereo(5, (t) => [tone(t), tone(t)]), RATE);
    expect(stats.correlation).toBeCloseTo(1, 6);
    expect(stats.balance_range).toBeLessThan(0.01);
    expect(effectsGate(stats)).toBe("dual_mono");
  });
  test("a source that pans by itself (balance -0.7 to +0.7, correlation under 0.98) is already spatial", () => {
    const stats = analyzeStereo(stereo(5, (t) => { const b = -0.7 + 1.4 * (t / 5); return [tone(t) * (1 - b), tone(t) * (1 + b)]; }), RATE);
    expect(stats.correlation).toBeLessThan(EFFECTS_DUAL_MONO_CORRELATION);
    expect(stats.balance_range).toBeGreaterThanOrEqual(EFFECTS_SPATIAL_RANGE);
    expect(effectsGate(stats)).toBe("already_spatial");
  });
  test("wide but flat (correlation 0.7, balance flat) sits between the two: the effects pan leaves it alone", () => {
    const stats = analyzeStereo(stereo(5, (t) => [tone(t, 440), 0.7 * tone(t, 440) + 0.714 * tone(t, 613)]), RATE);
    expect(stats.correlation).toBeGreaterThan(0.6); expect(stats.correlation).toBeLessThan(0.8);
    expect(stats.balance_range).toBeLessThan(EFFECTS_SPATIAL_RANGE);
    expect(effectsGate(stats)).toBe("between");
  });
  test("a clip that is dual mono but already sits off to one side (a static pan) is not re-panned", () => {
    const stats = analyzeStereo(stereo(5, (t) => [tone(t) * 0.2, tone(t) * 1.8]), RATE);
    expect(stats.correlation).toBeGreaterThanOrEqual(0.98);
    expect(effectsGate(stats)).toBe("already_spatial");
  });
  test("the three bench clips' measured numbers: train and steps already spatial, the knock dual mono (zero false positives)", () => {
    const mk = (correlation: number, balances: number[], dbs: number[]) => ({ correlation, windows: balances.map((balance, k) => ({ t: k * 0.5, balance, db: dbs[k]!, audible: true })), onsets: [], duration_s: 5 });
    const rangeOf = (balances: number[], dbs: number[]) => { const peak = Math.max(...dbs); const a = balances.filter((_, k) => dbs[k]! >= peak - 35); return Math.max(...a) - Math.min(...a); };
    const train = { b: [-0.0, -0.01, -0.11, -0.22, -0.35, -0.46, -0.64, -0.66, -0.68, -0.65], d: [-12, -13, -12, -12, -12, -14, -18, -21, -23, -25] };
    const steps = { b: [-0.49, -0.5, -0.38, -0.17, -0.01, -0.0, 0.05, 0.31, 0.44, 0.56], d: [-41, -35, -33, -33, -32, -41, -32, -31, -32, -38] };
    const knock = { b: [-0.18, 0.0, -0.0, -0.0, -0.0, 0.0, -0.0, -0.0, 0.0, 0.01], d: [-84, -96, -20, -15, -15, -15, -31, -72, -97, -100] };
    expect(effectsGate({ ...mk(0.898, train.b, train.d), balance_range: rangeOf(train.b, train.d) })).toBe("already_spatial");
    expect(effectsGate({ ...mk(0.807, steps.b, steps.d), balance_range: rangeOf(steps.b, steps.d) })).toBe("already_spatial");
    expect(effectsGate({ ...mk(0.99998, knock.b, knock.d), balance_range: rangeOf(knock.b, knock.d) })).toBe("dual_mono");
  });
  test("onsets: a tone burst every half second gives an onset each time; a steady tone gives none", () => {
    const bursts = analyzeStereo(stereo(4, (t) => { const v = (t % 0.5) < 0.08 ? tone(t, 600) : 0; return [v, v]; }), RATE);
    expect(bursts.onsets.map((o) => Math.round(o.t * 10) / 10)).toEqual([0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
    expect(analyzeStereo(stereo(4, (t) => [tone(t), tone(t)]), RATE).onsets).toHaveLength(0);
  });
});

describe("the speech skip: native balance must range by 0.5 and correlate with the person track", () => {
  const frames = 20; const person = Array.from({ length: frames }, (_, i) => -0.8 + 1.6 * (i / (frames - 1)));
  const statsWith = (balanceAt: (t: number) => number) => analyzeStereo(stereo(5, (t) => { const b = balanceAt(t); return [tone(t) * (1 - b), tone(t) * (1 + b)]; }), RATE);
  test("native balance that follows the walking speaker: skip", () => {
    const stats = statsWith((t) => -0.7 + 1.4 * (t / 5));
    expect(nativeTracksPerson(stats, person, dt)).toBe(true);
  });
  test("native balance that ranges the opposite way (anti-correlated) or by itself (zigzag): no skip", () => {
    expect(nativeTracksPerson(statsWith((t) => 0.7 - 1.4 * (t / 5)), person, dt)).toBe(false);
    expect(nativeTracksPerson(statsWith((t) => (Math.floor(t / 0.5) % 2 ? 0.7 : -0.7)), person, dt)).toBe(false);
  });
  test("range under 0.5 never skips, even when it points the same way", () => {
    expect(nativeTracksPerson(statsWith((t) => -0.2 + 0.4 * (t / 5)), person, dt)).toBe(false);
  });
  test("a speech clip at correlation 0.7 with flat balance does not skip (willsmith-like): the speech op still pans", () => {
    const stats = analyzeStereo(stereo(5, (t) => [tone(t, 440), 0.7 * tone(t, 440) + 0.714 * tone(t, 613)]), RATE);
    expect(nativeTracksPerson(stats, person, dt)).toBe(false);
    expect(nativeTracksPerson(stats, Array.from({ length: frames }, () => -0.75), dt)).toBe(false); // a still speaker: no track to correlate with
  });
});

describe("position sources", () => {
  const box = (x: number, w: number, label = "train") => ({ label, box: [x, 0.3, w, 0.3] });
  test("a person walking left to right is placed by the box centre, smoothed", () => {
    const people = Array.from({ length: 20 }, (_, i) => [[(i / 19) * 0.8 + 0.0, 0.2, 0.2, 0.6]]);
    const out = walkerPositions(people)!;
    expect(out.walking).toBe(true);
    expect(out.positions[0]!).toBeLessThan(-0.7); expect(out.positions.at(-1)!).toBeGreaterThan(0.7);
    expect(walkerPositions(Array.from({ length: 20 }, () => [[0.1, 0.2, 0.2, 0.6]]))!.walking).toBe(false); // standing still: not a walker
    expect(walkerPositions(Array.from({ length: 20 }, () => []))).toBeNull();
  });
  test("a train wider than the frame, right to left: the LEADING edge (left) gives the sign; the centre would stay flat", () => {
    // the bench train: the right edge stays at the frame border, the left edge runs from 0.2 to 0 (position -0.6 to -1.0)
    const frames = Array.from({ length: 20 }, (_, i) => { const x0 = 0.2 - 0.2 * (i / 19); return [box(x0, 0.98 - x0)]; });
    const out = vehiclePositions(frames);
    expect(out.direction).toBe(-1);
    expect(out.positions[0]!).toBeCloseTo(-0.6, 1); expect(out.positions.at(-1)!).toBeCloseTo(-1, 1);
    for (const p of out.positions) expect(p!).toBeLessThan(0);
    const centre = frames.map((f) => 2 * (f[0]!.box[0]! + f[0]!.box[2]! / 2) - 1);
    expect(Math.max(...centre.map(Math.abs))).toBeLessThan(0.25); // the flat centre the note warns about
  });
  test("the same train left to right: the leading edge is the RIGHT edge, positive", () => {
    const frames = Array.from({ length: 20 }, (_, i) => { const x1 = 0.8 + 0.2 * (i / 19); return [box(0.02, x1 - 0.02)]; });
    const out = vehiclePositions(frames);
    expect(out.direction).toBe(1);
    expect(out.positions[0]!).toBeCloseTo(0.6, 1); expect(out.positions.at(-1)!).toBeCloseTo(1, 1);
  });
  test("a narrow car moving right uses its right edge, not its centre; a boat and a bus count too; a person does not", () => {
    const frames = Array.from({ length: 12 }, (_, i) => [box(0.1 + 0.05 * i, 0.2, i % 2 ? "car" : "bus")]);
    const out = vehiclePositions(frames);
    expect(out.positions[0]!).toBeCloseTo(2 * 0.3 - 1, 1); // right edge at 0.3, centre would be 0.2
    expect(vehiclePositions([[box(0.1, 0.2, "boat")]]).positions[0]!).not.toBeNull();
    expect(vehiclePositions([[box(0.1, 0.2, "person")]]).positions[0]).toBeNull();
    expect(vehiclePositions([[box(0.1, 0.2, "motorcycle")]]).positions[0]).toBeNull();
  });
  test("several of the same class in one frame: centre on doubt (no position)", () => {
    const out = vehiclePositions([[box(0.1, 0.2, "car"), box(0.6, 0.2, "car")]]);
    expect(out.positions[0]).toBeNull();
  });
});

describe("the dominant-motion region and the moving camera", () => {
  const W = MOTION_W; const H = MOTION_H;
  const frame = (blocks: Array<[number, number]>, on = true): Uint8Array => { // [x0, x1] columns that are bright when `on`
    const f = new Uint8Array(W * H).fill(40);
    if (on) for (const [a, b] of blocks) for (let y = 20; y < 44; y++) for (let x = a; x < b; x++) f[y * W + x] = 220;
    return f;
  };
  const sequence = (blocks: Array<[number, number]>) => Array.from({ length: 12 }, (_, i) => frame(blocks, i % 2 === 0));
  test("a flicker in the left third is a negative position, in the right third positive, like the knock hand", () => {
    const left = motionPairs(sequence([[10, 30]]), W, H).map((p) => motionPosition(p, W));
    const right = motionPairs(sequence([[74, 94]]), W, H).map((p) => motionPosition(p, W));
    for (const p of left) expect(p!).toBeLessThan(-0.5);
    for (const p of right) expect(p!).toBeGreaterThan(0.5);
  });
  test("two separate regions of similar size: no position (centre on doubt); nothing moving: no position", () => {
    for (const p of motionPairs(sequence([[10, 30], [74, 94]]), W, H)) expect(motionPosition(p, W)).toBeNull();
    for (const p of motionPairs(Array.from({ length: 6 }, () => frame([])), W, H)) expect(motionPosition(p, W)).toBeNull();
  });
  test("a static camera with something moving is not a moving camera; a sliding picture is", () => {
    expect(cameraMoving(sequence([[10, 30]]), W, H)).toBe(false);
    const texture = (shift: number) => { const f = new Uint8Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) f[y * W + x] = 30 + ((((x + shift) * 37 + y * 11) % 17) * 12); return f; };
    expect(cameraMoving(Array.from({ length: 12 }, (_, i) => texture(i * 2)), W, H)).toBe(true);
    expect(cameraMoving(Array.from({ length: 12 }, () => texture(0)), W, H)).toBe(false);
  });
});

describe("impact events and knots", () => {
  test("each onset takes the middle of the motion around it; an onset with no motion near it is left centred", () => {
    const motion: Array<number | null> = [null, -0.5, -0.5, null, null, null, null, null, null, null, 0.4, 0.4, 0.4];
    const events = impactEvents([{ t: 0.4, rise_db: 20 }, { t: 1.5, rise_db: 20 }, { t: 3.0, rise_db: 20 }], motion, dt);
    expect(events).toHaveLength(2);
    expect(events[0]!.position).toBeCloseTo(-0.5, 2);
    expect(events[1]!.position).toBeCloseTo(0.4, 2);
    expect(events[0]!.end_s).toBeLessThan(events[1]!.start_s);
  });
  test("merging effect knots with speech knots: speech wins inside a line, no jump at its edges", () => {
    const speech: Array<[number, number]> = [[0, 0], [1.85, 0], [2, -0.75], [3, -0.75], [3.15, 0], [5, 0]];
    const effect: Array<[number, number]> = [[0, 0.5], [5, 0.5]];
    const merged = mergeKnots(speech, effect, [{ start_s: 2, end_s: 3 }], 0.15);
    const at = (t: number) => { for (let i = 0; i + 1 < merged.length; i++) { const [t0, v0] = merged[i]!; const [t1, v1] = merged[i + 1]!; if (t >= t0 && t <= t1) return t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0); } return merged.at(-1)![1]; };
    expect(at(2.5)).toBeCloseTo(-0.75, 2);
    expect(at(0.5)).toBeCloseTo(0.5, 2);
    expect(at(4.5)).toBeCloseTo(0.5, 2);
    for (let i = 1; i < merged.length; i++) { expect(merged[i]![0]).toBeGreaterThan(merged[i - 1]![0]); expect(Math.abs(merged[i]![1])).toBeLessThanOrEqual(1); }
  });
  test("smoothing is the speech smoothing (0.6 a second at most)", () => {
    const out = smoothPositions(Array.from({ length: 20 }, (_, i) => (i < 10 ? -0.8 : 0.8)), dt);
    for (let i = 1; i < out.length; i++) expect(Math.abs(out[i]! - out[i - 1]!)).toBeLessThanOrEqual(0.6 * dt + 1e-9);
  });
});

describe("the request: one op, one new optional argument", () => {
  const base = { inputs: ["/clip.mp4"], output: { name: "out.mp4" } };
  const problem = (op: unknown) => editInputProblem({ ...base, ops: [op] });
  test("side is left or right; anything else gets a plain line; unknown keys are still refused; existing requests behave as before", () => {
    expect(problem({ op: "spatial_sound", side: "left" })).toBeNull();
    expect(problem({ op: "spatial_sound", side: "right", surround: true })).toBeNull();
    expect(problem({ op: "spatial_sound" })).toBeNull();
    expect(problem({ op: "spatial_sound", surround: true })).toBeNull();
    expect(problem({ op: "spatial_sound", side: "up" })).toBe('Step 1 (spatial_sound) takes side as "left" or "right".');
    expect(problem({ op: "spatial_sound", side: 1 })).toBe('Step 1 (spatial_sound) takes side as "left" or "right".');
    expect(problem({ op: "spatial_sound", position: 0.5 })).toMatch(/does not know/);
    expect(problem({ op: "spatial_sound", segments: [] })).toMatch(/segments/);
  });
  test("the already_spatial line is exactly the note's", () => {
    expect(SPATIAL_LINES.already_spatial).toBe("This clip's sound already moves with the picture, so it is unchanged.");
    expect(spatialGains(-1).l).toBeGreaterThan(spatialGains(-1).r);
  });
});

// ---- real ffmpeg: clips whose tones are panned by construction ----
const FFMPEG = process.env.STACK_MEDIA_FFMPEG && existsSync(process.env.STACK_MEDIA_FFMPEG) ? process.env.STACK_MEDIA_FFMPEG : ["/usr/local/maipai-home/stack/data/engines/ffmpeg/current/ffmpeg", "/opt/homebrew/bin/ffmpeg"].find(existsSync) ?? null;
const FFPROBE = FFMPEG ? [FFMPEG.replace(/ffmpeg$/, "ffprobe")].find(existsSync) ?? null : null;
if (!(FFMPEG && FFPROBE)) console.warn("SPATIAL-07 real ffmpeg tests skipped: set STACK_MEDIA_FFMPEG or install the Stack ffmpeg (data/engines/ffmpeg/current).");
const real = FFMPEG && FFPROBE ? describe : describe.skip;

async function bytes(argv: string[]): Promise<Uint8Array> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const out = new Uint8Array(await new Response(child.stdout).arrayBuffer()); await child.exited; return out;
}
/** Per-channel RMS of `file` between from and to seconds. */
async function rmsPair(file: string, from: number, to: number): Promise<[number, number]> {
  const raw = await bytes([FFMPEG!, "-hide_banner", "-loglevel", "error", "-ss", String(from), "-t", String(to - from), "-i", file, "-map", "0:a:0", "-af", "aformat=channel_layouts=stereo", "-f", "f32le", "-ar", "48000", "-"]);
  const s = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
  let l = 0, r = 0, n = 0; for (let i = 0; i + 1 < s.length; i += 2) { l += s[i]! ** 2; r += s[i + 1]! ** 2; n++; }
  return [Math.sqrt(l / Math.max(1, n)), Math.sqrt(r / Math.max(1, n))];
}
const balanceOf = ([l, r]: [number, number]): number => (r - l) / (r + l + 1e-12);
const pearson = (a: number[], b: number[]): number => { const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / b.length; let c = 0, va = 0, vb = 0; a.forEach((x, i) => { c += (x - ma) * (b[i]! - mb); va += (x - ma) ** 2; vb += (b[i]! - mb) ** 2; }); return c / Math.sqrt(va * vb); };
const channelCount = async (file: string): Promise<number> => (JSON.parse(new TextDecoder().decode(await bytes([FFPROBE!, "-v", "error", "-show_streams", "-of", "json", file]))).streams.find((s: any) => s.codec_type === "audio")?.channels ?? 0);
const audioMd5 = async (file: string): Promise<string> => new TextDecoder().decode(await bytes([FFMPEG!, "-hide_banner", "-loglevel", "error", "-i", file, "-map", "0:a:0", "-c", "copy", "-f", "md5", "-"])).trim();

let root = "";
async function post(input: unknown): Promise<{ status: number; body: any }> {
  const response = await app.request("/stack/v1/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "media.edit", input }) });
  return { status: response.status, body: await response.json() };
}
async function run(input: unknown, wait = 120_000): Promise<any> {
  const { status, body } = await post(input);
  if (status !== 202) throw new Error(`refused ${status}: ${JSON.stringify(body)}`);
  return waitForJob(body.job.id, wait);
}

real("spatial_sound effects pan with the real ffmpeg", () => {
  let dir = "";
  beforeEach(() => {
    __resetJobsForTests(); __resetRootsForTests(); dir = realpathSync(mkdtempSync(join(tmpdir(), "spatial-fx-"))); root = dir; setRoots({ read: [dir], write: [dir] });
    setMediaDepsForTests({ toolbox: { installed: () => true, path: async (tool) => tool === "ffmpeg" ? FFMPEG! : FFPROBE! }, run: spawnRunner, limiter: new HostLimiter() }); registerMediaJobs();
  });
  afterEach(() => { __resetJobsForTests(); __resetRootsForTests(); resetMediaDepsForTests(); resetSpatialDepsForTests(); rmSync(dir, { recursive: true, force: true }); rmSync(jobsDir(), { recursive: true, force: true }); });

  const still = "color=c=gray:size=320x180:rate=24:duration=6";
  /** A clip: `video` is a lavfi source (+ optional -vf), `audio` an aevalsrc expression pair (L|R) or one expression for dual mono. */
  async function makeClip(name: string, audio: string, video: string = still, vf?: string): Promise<string> {
    const path = join(dir, name);
    const channels = audio.includes("|") ? audio : null;
    const aInput = channels ? `aevalsrc='${channels}':s=48000:d=6:c=stereo` : `aevalsrc='${audio}':s=48000:d=6`;
    const made = await spawnRunner([FFMPEG!, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", video, "-f", "lavfi", "-i", aInput, ...(vf ? ["-vf", vf] : []), "-ac", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", path]);
    expect(made.code).toBe(0);
    return path;
  }
  const personAt = (centre: number) => ({ label: "person", score: 0.9, box: [(centre + 1) / 2 - 0.1, 0.2, 0.2, 0.6] });
  const idle = { look: async (frames: Uint8Array[]) => frames.map(() => []), speech: async () => [] as Array<{ startSample: number; endSample: number }> };
  const flicker = (x: number) => `drawbox=x=${x}:y=60:w=60:h=60:color=white:t=fill:enable='lt(mod(t,0.5),0.25)'`;
  const knocks = "0.7*sin(2*PI*600*t)*lt(mod(t,0.5),0.08)";

  test("a walker on a dual-mono clip: the rendered balance follows the person box (Pearson 0.9 or more, right sign and order), 2 channels", async () => {
    const clip = await makeClip("walk.mp4", "0.5*sin(2*PI*440*t)");
    const posAt = (i: number) => -0.8 + 1.6 * (i / 23);
    setSpatialDepsForTests({ ...idle, look: async (frames) => frames.map((_, i) => [personAt(posAt(i))]) });
    const job = await run({ inputs: [clip], ops: [{ op: "spatial_sound" }], output: { dir, name: "out.mp4" } });
    expect(job.state).toBe("done");
    expect(job.result.spatial).toMatchObject({ applied: true, reason: null });
    expect(job.result.spatial.note).toBe(SPATIAL_LINES.applied_effects);
    const balances: number[] = [], expected: number[] = [];
    for (let k = 0; k < 11; k++) { balances.push(balanceOf(await rmsPair(job.result.path, k * 0.5 + 0.05, k * 0.5 + 0.45))); expected.push(posAt(Math.min(23, (k * 0.5 + 0.25) * 4))); }
    console.log(`walker: Pearson ${pearson(balances, expected).toFixed(3)} balances ${balances.map((b) => b.toFixed(2)).join(" ")}`);
    expect(pearson(balances, expected)).toBeGreaterThan(0.9);
    expect(balances[0]!).toBeLessThan(-0.15); expect(balances.at(-1)!).toBeGreaterThan(0.15);
  }, 180_000);

  test("a train: dual-mono rumble follows the leading edge of the box, not its flat centre", async () => {
    const clip = await makeClip("train.mp4", "0.5*sin(2*PI*110*t)");
    const frame = (i: number) => { const x0 = 0.2 - 0.2 * (i / 23); return { label: "train", score: 0.7, box: [x0, 0.3, 0.98 - x0, 0.3] }; };
    setSpatialDepsForTests({ ...idle, lookAll: async (frames) => frames.map((_, i) => [frame(i)]) });
    const job = await run({ inputs: [clip], ops: [{ op: "spatial_sound" }], output: { dir, name: "out.mp4" } });
    expect(job.state).toBe("done");
    expect(job.result.spatial).toMatchObject({ applied: true, sources: ["vehicle"] });
    const early = balanceOf(await rmsPair(job.result.path, 0.2, 1.0)), late = balanceOf(await rmsPair(job.result.path, 4.8, 5.8));
    console.log(`train: early balance ${early.toFixed(2)} late ${late.toFixed(2)}`);
    expect(early).toBeLessThan(-0.2); expect(late).toBeLessThan(early); expect(late).toBeLessThan(-0.4);
  }, 180_000);

  test("a knock follows the dominant-motion region: motion on the left puts each knock on the left, on the right on the right", async () => {
    for (const [name, x, sign] of [["left", 40, -1], ["right", 220, 1]] as const) {
      const clip = await makeClip(`knock-${name}.mp4`, knocks, "color=c=black:size=320x180:rate=24:duration=6", flicker(x));
      setSpatialDepsForTests({ ...idle });
      const job = await run({ inputs: [clip], ops: [{ op: "spatial_sound", surround: true }], output: { dir, name: `knock-${name}-out.mp4` } });
      expect(job.state).toBe("done");
      expect(job.result.spatial).toMatchObject({ applied: true, sources: ["impact"] });
      const expected = (spatialGains(sign * 0.56).r - spatialGains(sign * 0.56).l) / (spatialGains(sign * 0.56).r + spatialGains(sign * 0.56).l);
      const onsets = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5];
      const bal = await Promise.all(onsets.map(async (t) => balanceOf(await rmsPair(job.result.path, t + 0.02, t + 0.07))));
      console.log(`knock ${name}: onset balances ${bal.map((b) => b.toFixed(2)).join(" ")} expected ${expected.toFixed(2)}`);
      expect(bal.filter((b) => Math.sign(b) !== sign).length).toBe(0); // zero wrong-side results
      expect(bal.filter((b) => Math.abs(b - expected) <= 0.25).length / bal.length).toBeGreaterThanOrEqual(0.9);
      expect(await channelCount(join(dir, `knock-${name}-out-5.1.mp4`))).toBe(6); // the 5.1 file is made from the panned audio
    }
  }, 240_000);

  test("a user-given side is an override: knocks go right although nothing on screen says so, still gated and still plain", async () => {
    const clip = await makeClip("side.mp4", knocks);
    setSpatialDepsForTests({ ...idle });
    const job = await run({ inputs: [clip], ops: [{ op: "spatial_sound", side: "right" }], output: { dir, name: "out.mp4" } });
    expect(job.state).toBe("done");
    expect(job.result.spatial).toMatchObject({ applied: true, sources: ["side"] });
    const bal = await balanceOf(await rmsPair(job.result.path, 1.02, 1.07));
    expect(bal).toBeGreaterThan(0.3);
    // without the argument the same clip has no visible source and stays unchanged
    const plain = await run({ inputs: [clip], ops: [{ op: "spatial_sound" }], output: { dir, name: "plain.mp4" } });
    expect(plain.result.spatial).toMatchObject({ applied: false, reason: "no_person" });
  }, 180_000);

  test("a moving camera keeps the impact centred (a camera pan moves every source)", async () => {
    const clip = await makeClip("pan.mp4", knocks, "testsrc=size=640x360:rate=24:duration=6", "crop=320:180:x='t*20':y=90");
    setSpatialDepsForTests({ ...idle });
    const job = await run({ inputs: [clip], ops: [{ op: "spatial_sound" }], output: { dir, name: "out.mp4" } });
    expect(job.state).toBe("done");
    expect(job.result.spatial).toMatchObject({ applied: false, reason: "no_person" });
    expect(Math.abs(balanceOf(await rmsPair(job.result.path, 1.02, 1.07)))).toBeLessThan(0.02);
  }, 180_000);

  test("music or anything with no visible source stays centred: a steady dual-mono tone, nothing moving", async () => {
    const clip = await makeClip("music.mp4", "0.5*sin(2*PI*440*t)");
    setSpatialDepsForTests({ ...idle });
    const job = await run({ inputs: [clip], ops: [{ op: "spatial_sound" }], output: { dir, name: "out.mp4" } });
    expect(job.result.spatial).toMatchObject({ applied: false, reason: "no_person" });
  }, 120_000);

  test("an effects clip whose native balance already follows the object is left alone: already_spatial, audio bytes untouched, and the 5.1 file is still made", async () => {
    // L and R are the same tone with gains that sweep (corr about 0.72, balance -0.7 to +0.7), and a person walks the same way
    const clip = await makeClip("native.mp4", "0.5*sin(2*PI*440*t)*(1-(-0.7+1.4*t/6))|0.5*sin(2*PI*440*t)*(1+(-0.7+1.4*t/6))");
    setSpatialDepsForTests({ ...idle, look: async (frames) => frames.map((_, i) => [personAt(-0.8 + 1.6 * (i / 23))]) });
    const job = await run({ inputs: [clip], ops: [{ op: "spatial_sound", surround: true }], output: { dir, name: "out.mp4" } });
    expect(job.state).toBe("done");
    expect(job.result.spatial).toMatchObject({ applied: false, reason: "already_spatial", surround: true });
    expect(job.result.spatial.note).toBe("This clip's sound already moves with the picture, so it is unchanged.");
    expect(await audioMd5(job.result.files[0].path)).toBe(await audioMd5(clip)); // copied, not re-encoded
    expect(job.result.files).toHaveLength(2);
    expect(await channelCount(job.result.files[1].path)).toBe(6);
    expect(job.result.files[1].name).toBe("out-5.1.mp4");
  }, 180_000);

  test("a speech clip whose native balance follows the speaker is left alone (already_spatial); one with flat balance at correlation 0.7 is still panned", async () => {
    const native = await makeClip("speech-native.mp4", "0.5*sin(2*PI*440*t)*(1-(-0.7+1.4*t/6))|0.5*sin(2*PI*440*t)*(1+(-0.7+1.4*t/6))");
    const spans = [{ startSample: 0, endSample: 6 * 16_000 }];
    setSpatialDepsForTests({ look: async (frames) => frames.map((_, i) => [personAt(-0.8 + 1.6 * (i / 23))]), speech: async () => spans });
    const skipped = await run({ inputs: [native], ops: [{ op: "spatial_sound" }], output: { dir, name: "skipped.mp4" } });
    expect(skipped.result.spatial).toMatchObject({ applied: false, reason: "already_spatial" });
    expect(await audioMd5(skipped.result.path)).toBe(await audioMd5(native));

    const wide = await makeClip("speech-wide.mp4", "0.5*sin(2*PI*440*t)|0.35*sin(2*PI*440*t)+0.357*sin(2*PI*613*t)");
    setSpatialDepsForTests({ look: async (frames) => frames.map(() => [personAt(-0.75)]), speech: async () => [{ startSample: 2 * 16_000, endSample: 4 * 16_000 }] });
    const panned = await run({ inputs: [wide], ops: [{ op: "spatial_sound" }], output: { dir, name: "panned.mp4" } });
    expect(panned.result.spatial).toMatchObject({ applied: true, reason: null });
    expect(panned.result.spatial.note).toBe(SPATIAL_LINES.applied);
    const inside = balanceOf(await rmsPair(panned.result.path, 2.3, 3.7)), outside = balanceOf(await rmsPair(panned.result.path, 0.3, 1.2));
    console.log(`speech at correlation 0.7, flat balance: inside the line ${inside.toFixed(2)}, outside ${outside.toFixed(2)}`);
    expect(inside).toBeLessThan(outside - 0.25);
  }, 240_000);

  test("retention: no frame, no grey picture and no audio file is left in the work folder, and no position is returned to the caller", async () => {
    const clip = await makeClip("keep.mp4", knocks, "color=c=black:size=320x180:rate=24:duration=6", flicker(40));
    const work = mkdtempSync(join(tmpdir(), "spatial-keep-"));
    const sig = new AbortController().signal;
    const stats = (await analyzeClipAudio({ ffmpeg: FFMPEG!, source: clip, work, run: spawnRunner, signal: sig }))!;
    expect(stats.duration_s).toBeGreaterThan(5.5);
    const seen: number[] = [];
    const track = await computeEffectsTrack({ ffmpeg: FFMPEG!, source: clip, work, run: spawnRunner, signal: sig, durationS: stats.duration_s, stats, people: [], lookAll: async (frames) => { seen.push(frames.length); return frames.map(() => []); } });
    expect(track?.kind).toBe("impact");
    expect(seen.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(23); // 4 frames a second were looked at
    expect(readdirSync(work)).toEqual([]);
    rmSync(work, { recursive: true, force: true });
  }, 120_000);

  test("effects never touch the speech lines: speech spans are excluded from the effects pan and keep the speaker's side", async () => {
    const clip = await makeClip("both.mp4", "0.5*sin(2*PI*440*t)");
    const posAt = (i: number) => -0.8 + 1.6 * (i / 23);
    setSpatialDepsForTests({ look: async (frames) => frames.map((_, i) => [personAt(posAt(i))]), speech: async () => [{ startSample: 2 * 16_000, endSample: 3 * 16_000 }] });
    const job = await run({ inputs: [clip], ops: [{ op: "spatial_sound" }], output: { dir, name: "out.mp4" } });
    expect(job.result.spatial.applied).toBe(true);
    const speechBal = balanceOf(await rmsPair(job.result.path, 2.2, 2.8));
    expect(Math.abs(speechBal)).toBeLessThan(0.6); // the line sits where the speaker is, not where the effects pan would put it
    expect(readdirSync(dir).filter((n) => n.startsWith("."))).toEqual([]);
  }, 180_000);
});

// ---- the real Look model on the three bench clips ----
const BENCH = join(process.env.HOME ?? "", "video-bench/spatial/effects");
const IMAGE_TOOLS = "/usr/local/maipai-home/stack/data/engines/image-tools/1.0.0";
const NANO = "/usr/local/maipai-home/stack/data/models/image-tool-yolox-nano/yolox_nano.onnx";
const haveBench = FFMPEG && FFPROBE && existsSync(join(IMAGE_TOOLS, "venv/bin/python")) && existsSync(NANO) && ["train", "steps", "knock", "train-mono", "steps-mono"].every((n) => existsSync(join(BENCH, `${n}.mp4`)));
if (!haveBench) console.warn("SPATIAL-07 bench-clip tests skipped: needs ffmpeg, the image-tools environment, yolox_nano and train/steps/knock(+ -mono) mp4 in ~/video-bench/spatial/effects/.");
(haveBench ? describe : describe.skip)("the real Look model on the bench clips", () => {
  let service: LookService | null = null;
  let dir = "";
  beforeEach(() => {
    __resetJobsForTests(); __resetRootsForTests(); dir = realpathSync(mkdtempSync(join(tmpdir(), "spatial-bench-"))); setRoots({ read: [dir, BENCH], write: [dir] });
    setMediaDepsForTests({ toolbox: { installed: () => true, path: async (tool) => tool === "ffmpeg" ? FFMPEG! : FFPROBE! }, run: spawnRunner, limiter: new HostLimiter() }); registerMediaJobs();
    service = new LookService({
      supported: () => true, ensureEnvironment: async () => {}, modelPath: () => NANO, hold: async () => ({ release: () => {} }), now: () => Date.now(), log: () => {},
      spawn: async () => workerHandle(Bun.spawn([join(IMAGE_TOOLS, "venv/bin/python"), "-I", join(import.meta.dir, "../src/look/look_worker.py")], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1" } })),
    });
    setSpatialDepsForTests({ look: (frames, signal) => service!.lookFrames(frames, signal), lookAll: (frames, signal) => service!.lookFrames(frames, signal, "all"), speech: async () => [] });
  });
  afterEach(() => { service?.stop(); service = null; __resetJobsForTests(); __resetRootsForTests(); resetMediaDepsForTests(); resetSpatialDepsForTests(); rmSync(dir, { recursive: true, force: true }); rmSync(jobsDir(), { recursive: true, force: true }); });
  const go = async (name: string, ops: unknown[] = [{ op: "spatial_sound" }]) => run({ inputs: [join(BENCH, `${name}.mp4`)], ops, output: { dir, name: `${name}-out.mp4` } });

  test("the gate on the real files: train and steps (native pan) are left alone, the knock (dual mono) is not", async () => {
    for (const name of ["train", "steps"]) {
      const job = await go(name);
      expect(job.state).toBe("done");
      expect(job.result.spatial).toMatchObject({ applied: false, reason: "already_spatial" });
    }
    const knock = await go("knock");
    expect(knock.result.spatial.reason).not.toBe("already_spatial");
  }, 240_000);

  test("steps (made mono first): the footsteps follow the man left to right, no wrong side", async () => {
    const started = performance.now();
    const job = await go("steps-mono");
    const ms = performance.now() - started;
    expect(job.result.spatial).toMatchObject({ applied: true, sources: ["walker"] });
    const balances: number[] = [];
    for (let k = 0; k < 10; k++) balances.push(balanceOf(await rmsPair(job.result.path, k * 0.5 + 0.02, k * 0.5 + 0.48)));
    console.log(`bench steps-mono (walker): balances ${balances.map((b) => b.toFixed(2)).join(" ")} wall ${Math.round(ms)} ms`);
    expect(pearson(balances, balances.map((_, k) => -0.8 + 1.6 * (k / 9)))).toBeGreaterThan(0.9);
    expect(balances[0]!).toBeLessThan(0); expect(balances.at(-1)!).toBeGreaterThan(0);
  }, 240_000);

  test("train (made mono first): the rumble goes to the locomotive's exit side (left), by the leading edge", async () => {
    const job = await go("train-mono");
    expect(job.result.spatial).toMatchObject({ applied: true, sources: ["vehicle"] });
    const balances: number[] = [];
    for (let k = 0; k < 10; k++) balances.push(balanceOf(await rmsPair(job.result.path, k * 0.5 + 0.02, k * 0.5 + 0.48)));
    console.log(`bench train-mono (leading edge): balances ${balances.map((b) => b.toFixed(2)).join(" ")}`);
    expect(balances.filter((b) => b > 0.05).length).toBe(0); // zero wrong-side windows
    expect(balances.at(-1)!).toBeLessThan(-0.4);
  }, 240_000);

  test("knock (native dual mono): each of the six knocks sits on the side of the hand (left)", async () => {
    const job = await go("knock", [{ op: "spatial_sound", surround: true }]);
    expect(job.result.spatial).toMatchObject({ applied: true, sources: ["impact"] });
    const onsets = [1.32, 1.62, 1.89, 2.16, 2.46, 2.82];
    const bal = await Promise.all(onsets.map(async (t) => balanceOf(await rmsPair(job.result.path, t + 0.01, t + 0.09))));
    console.log(`bench knock (motion region): onset balances ${bal.map((b) => b.toFixed(2)).join(" ")}`);
    expect(bal.filter((b) => b >= 0).length).toBe(0);
    expect(await channelCount(join(dir, "knock-out-5.1.mp4"))).toBe(6);
  }, 240_000);
});
