// SPATIAL-02: the speaker position track. Pure functions on fixed box sequences, the Look batch entry with a fake worker, and (when the
// Look model, its Python environment and the bench clip are on this computer) the real chain on a real clip.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOOK_RATE_PER_MINUTE, LookService, workerHandle, type LookDeps, type LookWorker, type WorkerReply } from "@/look/look";
import { boxPosition, buildTrack, computeSpatialTrack, framePosition, limitSegments, SPATIAL_FPS, SPATIAL_MAX_SEGMENTS, smoothPositions, speechSegments, type SpatialSegment } from "@/media/spatialTrack";
import { spawnRunner } from "@/media/run";

const dt = 1 / SPATIAL_FPS;
const person = (centre: number, width = 0.2, height = 0.6): number[] => [(centre + 1) / 2 - width / 2, 0.2, width, height]; // [x, y, w, h] as Look returns it

describe("one frame to one position", () => {
  test("the box centre maps to -1 (left edge) .. 0 (middle) .. +1 (right edge)", () => {
    expect(boxPosition([0, 0, 0.2, 0.5])).toBeCloseTo(-0.8, 6);
    expect(boxPosition([0.4, 0, 0.2, 0.5])).toBeCloseTo(0, 6);
    expect(boxPosition([0.8, 0, 0.2, 0.5])).toBeCloseTo(0.8, 6);
    expect(boxPosition([0.9, 0, 0.3, 0.5])).toBe(1); // clamped when a box leaves the frame
  });
  test("nobody is null, one person is the box centre, two or more people are centre on doubt (no motion tie-break)", () => {
    expect(framePosition([])).toBeNull();
    expect(framePosition([person(-0.75)])).toBeCloseTo(-0.75, 6);
    expect(framePosition([person(-0.75), person(0.5)])).toBe(0);
    expect(framePosition([person(-0.75, 0.5), person(0.5, 0.1)])).toBe(0); // even a much larger box does not win
    expect(framePosition([person(0.9), person(0.8), person(-0.9)])).toBe(0);
  });
});

describe("smoothing", () => {
  test("a speaker walking left to right never jumps faster than 0.6 a second", () => {
    const raw = Array.from({ length: 40 }, (_, i) => (i < 20 ? -0.8 : 0.8)); // a hard cut from the left to the right
    const out = smoothPositions(raw, dt);
    expect(out).toHaveLength(40);
    for (let i = 1; i < out.length; i++) expect(Math.abs(out[i]! - out[i - 1]!)).toBeLessThanOrEqual(0.6 * dt + 1e-9);
    expect(out[0]).toBeCloseTo(-0.8, 6);
    expect(out.at(-1)!).toBeGreaterThan(-0.8);
  });
  test("a single wild frame is removed by the median of 5", () => {
    const raw: Array<number | null> = Array.from({ length: 21 }, () => 0.3);
    raw[10] = -0.9;
    expect(Math.max(...smoothPositions(raw, dt).map((v) => Math.abs(v - 0.3)))).toBeLessThan(1e-9);
  });
  test("a dropout of 1.5 s holds the last value", () => {
    const raw: Array<number | null> = [...Array.from({ length: 12 }, () => 0.5), ...Array.from({ length: 6 }, () => null), ...Array.from({ length: 12 }, () => 0.5)];
    for (const v of smoothPositions(raw, dt)) expect(v).toBeCloseTo(0.5, 6);
  });
  test("a dropout of 4 s holds for 1.5 s and then glides back to the middle, never past it", () => {
    const raw: Array<number | null> = [...Array.from({ length: 12 }, () => 0.5), ...Array.from({ length: 16 }, () => null), ...Array.from({ length: 12 }, () => 0.5)];
    const out = smoothPositions(raw, dt);
    expect(out[12 + 5]).toBeCloseTo(0.5, 6); // 1.25 s into the gap: still held
    expect(Math.abs(out[12 + 15]!)).toBeLessThan(0.01); // the glide ended in the middle
    expect(Math.min(...out)).toBeGreaterThanOrEqual(-1e-9);
    expect(out.at(-1)!).toBeGreaterThan(0.1); // and he is placed again when he is back
  });
  test("nobody at all is the middle all the way", () => {
    expect(smoothPositions(Array.from({ length: 10 }, () => null), dt)).toEqual(Array.from({ length: 10 }, () => 0));
    expect(smoothPositions([], dt)).toEqual([]);
  });
});

describe("speech segments", () => {
  const steady = (p: number, n = 40) => Array.from({ length: n }, () => p);
  test("one value per speech span: the median of the smoothed samples inside it", () => {
    const segs = speechSegments([{ start_s: 1, end_s: 3 }, { start_s: 5, end_s: 7 }], [...steady(-0.7, 20), ...steady(0.4, 20)], dt);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ start_s: 1, end_s: 3 });
    expect(segs[0]!.position).toBeCloseTo(-0.7, 6);
    expect(segs[1]!.position).toBeCloseTo(0.4, 6);
  });
  test("a span longer than 4 s splits when the median moves by more than 0.25", () => {
    const smoothed = [...steady(-0.6, 24), ...steady(0.5, 24)]; // 12 s
    const segs = speechSegments([{ start_s: 0, end_s: 11 }], smoothed, dt);
    expect(segs.length).toBeGreaterThanOrEqual(2);
    expect(segs[0]!.position).toBeCloseTo(-0.6, 1);
    expect(segs.at(-1)!.position).toBeCloseTo(0.5, 1);
    expect(segs[0]!.start_s).toBe(0);
    expect(segs.at(-1)!.end_s).toBe(11);
    for (let i = 1; i < segs.length; i++) expect(segs[i]!.start_s).toBeCloseTo(segs[i - 1]!.end_s, 6);
  });
  test("a long span that stays put stays one segment", () => {
    expect(speechSegments([{ start_s: 0, end_s: 9 }], steady(0.2, 40), dt)).toHaveLength(1);
  });
  test("no speech, no segments", () => { expect(speechSegments([], steady(0.2), dt)).toEqual([]); });
  test("a span past the last sampled frame uses the last value", () => {
    expect(speechSegments([{ start_s: 8, end_s: 9 }], steady(0.3, 10), dt)[0]!.position).toBeCloseTo(0.3, 6);
  });
  test("at most 64 segments: the rest merge by nearest position and the order and span are kept", () => {
    const many: SpatialSegment[] = Array.from({ length: 100 }, (_, i) => ({ start_s: i, end_s: i + 0.5, position: i % 2 ? 0.8 : -0.8 }));
    many[10]!.position = 0.1; many[11]!.position = 0.12;
    const out = limitSegments(many, SPATIAL_MAX_SEGMENTS);
    expect(out).toHaveLength(SPATIAL_MAX_SEGMENTS);
    expect(out[0]!.start_s).toBe(0);
    expect(out.at(-1)!.end_s).toBe(99.5);
    for (let i = 1; i < out.length; i++) expect(out[i]!.start_s).toBeGreaterThanOrEqual(out[i - 1]!.end_s - 1e-9);
    expect(limitSegments(many.slice(0, 3), 64)).toHaveLength(3);
  });
});

describe("buildTrack from fixed box sequences", () => {
  const spans = [{ start_s: 1, end_s: 3 }];
  test("a speaker standing on the left gives a left segment", () => {
    const frames = Array.from({ length: 20 }, () => [person(-0.75)]);
    const track = buildTrack(frames, spans);
    expect(track.reason).toBeNull();
    expect(track.segments).toHaveLength(1);
    expect(track.segments[0]!.position).toBeCloseTo(-0.75, 2);
    expect(track.people_frames).toBe(20);
  });
  test("a speaker moving left to right is placed where he stands while talking", () => {
    const frames = Array.from({ length: 40 }, (_, i) => [person(-0.8 + (1.6 * i) / 39)]);
    const early = buildTrack(frames, [{ start_s: 0.5, end_s: 2 }]).segments[0]!.position;
    const late = buildTrack(frames, [{ start_s: 7, end_s: 9 }]).segments[0]!.position;
    expect(early).toBeLessThan(-0.3);
    expect(late).toBeGreaterThan(0.3);
  });
  test("two people in every frame centre the dialog and say so", () => {
    const frames = Array.from({ length: 20 }, () => [person(-0.6), person(0.6)]);
    const track = buildTrack(frames, spans);
    expect(track.segments[0]!.position).toBe(0);
    expect(track.reason).toBe("several_people");
  });
  test("nobody in any frame (a cartoon, a cat) is the no_person reason with no segments", () => {
    const track = buildTrack(Array.from({ length: 20 }, () => []), spans);
    expect(track.reason).toBe("no_person");
    expect(track.segments).toEqual([]);
    expect(track.people_frames).toBe(0);
  });
  test("a person but no speech is the no_speech reason", () => {
    const track = buildTrack(Array.from({ length: 20 }, () => [person(0.5)]), []);
    expect(track.reason).toBe("no_speech");
    expect(track.segments).toEqual([]);
  });
  test("a speaker found in the middle of the frame is the centred reason (nothing to move)", () => {
    expect(buildTrack(Array.from({ length: 20 }, () => [person(0.01)]), spans).reason).toBe("centered");
  });
  test("a 2 s dropout in the middle of a line keeps the speaker where he was", () => {
    const frames: number[][][] = Array.from({ length: 40 }, () => [person(-0.5)]);
    for (let i = 12; i < 20; i++) frames[i] = [];
    expect(buildTrack(frames, [{ start_s: 0.5, end_s: 9 }]).segments[0]!.position).toBeCloseTo(-0.5, 1);
  });
});

describe("Look batch entry", () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
  const reply = (): WorkerReply => ({ ok: true, detections: [{ label: "person", score: 0.9, box: [0.1, 0.2, 0.3, 0.6] }, { label: "couch", score: 0.8, box: [0.5, 0.5, 0.3, 0.3] }], light: "bright", colours: [], tags: [], ms: 5 });
  function build() {
    let spawned = 0; const logs: string[] = []; const seen: Uint8Array[] = [];
    const deps: LookDeps = {
      supported: () => true, ensureEnvironment: async () => {}, modelPath: () => "/verified/model.onnx", hold: async () => ({ release: () => {} }),
      spawn: async (): Promise<LookWorker> => { spawned += 1; let end!: (code: number) => void; const exited = new Promise<number>((done) => { end = done; }); return { exited, kill: () => end(143), request: async (_m, jpeg) => { seen.push(jpeg); return reply(); } }; },
      now: () => 1_000_000, log: (message, ...values) => { let i = 0; logs.push(message.replace(/%d/g, () => String(values[i++] ?? ""))); },
    };
    const service = new LookService(deps);
    return { service, logs, seen, spawned: () => spawned };
  }
  test("30 frames in one call pass: no per-minute counter, one worker, person boxes only", async () => {
    const { service, seen, spawned } = build();
    const out = await service.lookFrames(Array.from({ length: LOOK_RATE_PER_MINUTE * 3 }, () => JPEG));
    expect(out).toHaveLength(36);
    expect(out.every((boxes) => boxes.length === 1 && boxes[0]!.label === "person")).toBe(true);
    expect(seen).toHaveLength(36);
    expect(spawned()).toBe(1);
    service.stop();
  });
  test("the outside caller limit is still enforced on look()", async () => {
    const { service } = build();
    for (let i = 0; i < LOOK_RATE_PER_MINUTE; i++) await service.look("cam", JPEG);
    await service.lookFrames([JPEG]); // a Stack job is not a camera
    expect(() => service.look("cam", JPEG)).toThrow(/at most 12 pictures/);
    service.stop();
  });
  test("frames do not feed the camera memory and no log line carries a box or a label", async () => {
    const { service, logs } = build();
    await service.lookFrames([JPEG, JPEG]);
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) expect(line).not.toMatch(/person|couch|0\.1|0\.9/);
    service.stop();
  });
  test("a picture that is not a complete JPEG is refused with a plain line", async () => {
    const { service } = build();
    await expect(service.lookFrames([new Uint8Array([1, 2, 3])])).rejects.toThrow(/complete JPEG/);
    service.stop();
  });
  test("a missing model is the Look part plain line", async () => {
    const { service } = (() => { const b = build(); return { service: new LookService({ ...(b.service as any).deps, modelPath: () => null }) }; })();
    await expect(service.lookFrames([JPEG])).rejects.toThrow(/Look part is not installed/);
    service.stop();
  });
});

describe("computeSpatialTrack with fake tools", () => {
  test("frame extraction failure is a plain error and the work folder is left empty", async () => {
    const work = mkdtempSync(join(tmpdir(), "spatial-fake-"));
    const run = async () => ({ code: 1, stdout: "", stderr: "boom", aborted: false });
    await expect(computeSpatialTrack({ ffmpeg: "ffmpeg", source: "/x.mp4", work, run, signal: new AbortController().signal, deps: { look: async () => [], speech: async () => [] } })).rejects.toThrow(/could not be read/);
    expect(readdirSync(work)).toEqual([]);
    rmSync(work, { recursive: true, force: true });
  });
});

// ---- real ffmpeg, the real Look model and the bench clip, when they are on this computer ----
const FFMPEG = process.env.STACK_MEDIA_FFMPEG && existsSync(process.env.STACK_MEDIA_FFMPEG) ? process.env.STACK_MEDIA_FFMPEG : ["/usr/local/maipai-home/stack/data/engines/ffmpeg/current/ffmpeg", "/opt/homebrew/bin/ffmpeg"].find(existsSync) ?? null;
const IMAGE_TOOLS = "/usr/local/maipai-home/stack/data/engines/image-tools/1.0.0";
const MODEL = "/usr/local/maipai-home/stack/data/models/image-tool-yolox-nano/yolox_nano.onnx";
const CLIP = join(process.env.HOME ?? "", "video-bench/lora-test/runs/pan-left.mp4");
const haveReal = FFMPEG && existsSync(join(IMAGE_TOOLS, "venv/bin/python")) && existsSync(MODEL) && existsSync(CLIP);
if (!haveReal) console.warn("SPATIAL-02 real Look test skipped: needs ffmpeg, the image-tools environment, the yolox_nano model and ~/video-bench/lora-test/runs/pan-left.mp4 on this computer.");
(haveReal ? describe : describe.skip)("the real Look model on a real clip", () => {
  let service: LookService | null = null;
  afterEach(() => { service?.stop(); service = null; });
  test("the man standing on the left of pan-left.mp4 is found at about -0.75 while he talks, and no frame stays behind", async () => {
    service = new LookService({
      supported: () => true, ensureEnvironment: async () => {}, modelPath: () => MODEL, hold: async () => ({ release: () => {} }), now: () => Date.now(), log: () => {},
      spawn: async () => workerHandle(Bun.spawn([join(IMAGE_TOOLS, "venv/bin/python"), "-I", "-B", join(import.meta.dir, "../src/look/look_worker.py")], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1" } })),
    });
    const work = mkdtempSync(join(tmpdir(), "spatial-real-"));
    const track = await computeSpatialTrack({ ffmpeg: FFMPEG!, source: CLIP, work, run: spawnRunner, signal: new AbortController().signal, deps: { look: (frames, signal) => service!.lookFrames(frames, signal), speech: async () => [{ startSample: Math.round(1.8 * 16_000), endSample: Math.round(3.77 * 16_000) }] } });
    console.log(`SPATIAL-02 real clip: ${track.frames} frames, ${track.people_frames} with a person, segments ${JSON.stringify(track.segments.map((s) => ({ ...s, position: Math.round(s.position * 100) / 100 })))}`);
    expect(track.frames).toBeGreaterThanOrEqual(19);
    expect(track.people_frames).toBeGreaterThanOrEqual(18); // bench: 19 of 20
    expect(track.segments).toHaveLength(1);
    expect(Math.abs(track.segments[0]!.position - -0.75)).toBeLessThanOrEqual(0.25);
    expect(readdirSync(work)).toEqual([]); // retention: no frame, no audio file kept after the job
    rmSync(work, { recursive: true, force: true });
  }, 120_000);
});
