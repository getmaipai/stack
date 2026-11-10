// MAKER-A: light_flatten, rest_reference and the phone twin of media.companion_clip, on a synthetic character.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __resetJobsForTests, waitForJob } from "@/lib/jobs";
import { CompanionClipInput } from "@/media/commands";
import { applyLightOffsets, defaultLightRegions, lightReasons, lightStep, reduceForLight, restFrameDifference, rgbToLab, smoothLightOffsets, solveLightOffsets, type LightRegions } from "@/media/companionClip";
import { registerMediaJobs, resetMediaDepsForTests, setMediaDepsForTests } from "@/media/jobs";
import { __resetRootsForTests, jobsDir, setRoots } from "@/media/paths";
import { spawnRunner } from "@/media/run";

// ---- the fixture: 24 frames of a 96 x 96 character on a green screen ----
const SIZE = 96, FRAMES = 24;
const REGIONS_96: LightRegions = { hair_left: [0, 0, 48, 28], hair_right: [48, 0, 96, 28], clothes_left: [0, 70, 48, 96], clothes_right: [48, 70, 96, 96] };
type Drift = "none" | "bump" | "ramp";
/** The drift of frame f, 0..1: nothing, a smooth bump that is zero at both ends (the way a pinned clip drifts: the ends sit at the rest frame), or a ramp that ends away from the rest frame. */
const driftAt = (drift: Drift, f: number) => drift === "none" ? 0 : drift === "bump" ? Math.sin(Math.PI * f / (FRAMES - 1)) ** 2 : f / (FRAMES - 1);

/** One frame as straight RGBA. `keyed` makes the screen transparent; otherwise it is opaque green and the edge pixels carry green spill. */
function characterFrame(f: number, drift: Drift, keyed: boolean): Uint8Array {
  const out = new Uint8Array(SIZE * SIZE * 4), s = driftAt(drift, f);
  const gain = 1 + 0.16 * s, hue = 14 * s;
  const inDisc = (x: number, y: number) => (x - 48) ** 2 + (y - 50) ** 2 <= 24 * 24;
  const colourAt = (x: number, y: number): [number, number, number] | null => {
    if (y >= 70 && x >= 8 && x < 88) return [60, 90, 160];
    if (inDisc(x, y)) return [224, 172, 105];
    if (y < 28 && x >= 18 && x < 78) return [40, 28, 22];
    return null;
  };
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4, c = colourAt(x, y);
    if (!c) { out.set(keyed ? [0, 0, 0, 0] : [0, 255, 0, 255], i); continue; }
    let [r, g, b] = c;
    r = r * gain + hue; g = g * gain; b = b * gain - hue;
    // spill: pixels within one pixel of the screen carry extra green
    const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => { const nx = x + dx!, ny = y + dy!; return nx >= 0 && ny >= 0 && nx < SIZE && ny < SIZE && !colourAt(nx, ny); });
    if (edge && !keyed) g += 28;
    out.set([r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v)))), i); out[i + 3] = 255;
  }
  return out;
}

const lab = (frame: Uint8Array, x: number, y: number) => { const o = new Float32Array(3); const i = (y * SIZE + x) * 4; rgbToLab(frame[i]!, frame[i + 1]!, frame[i + 2]!, o); return [...o]; };

test("light_flatten: the injected brightness and hue drift falls under 0.9 Lab, alpha is identical, and the rest frame is untouched", () => {
  const frames = Array.from({ length: FRAMES }, (_, f) => characterFrame(f, "bump", true));
  const small = (list: Uint8Array[]) => list.map((frame) => reduceForLight(frame, SIZE, SIZE));
  const before = lightStep(small(frames), REGIONS_96, SIZE);
  expect(before).toBeGreaterThan(4);
  const offsets = solveLightOffsets(small(frames), REGIONS_96, SIZE);
  const fixed = frames.map((frame, f) => { const copy = frame.slice(); applyLightOffsets(copy, SIZE, SIZE, offsets[f]!, REGIONS_96, SIZE); return copy; });
  const after = lightStep(small(fixed), REGIONS_96, SIZE);
  expect(after).toBeLessThan(0.9);
  for (let f = 0; f < FRAMES; f++) for (let i = 3; i < fixed[f]!.length; i += 4) if (fixed[f]![i] !== frames[f]![i]) throw new Error(`alpha changed in frame ${f}`);
  expect([...fixed[0]!]).toEqual([...frames[0]!]);
  // the face (outside the four regions) moves with the same field, never more than the drift itself
  const mid = FRAMES >> 1, skinBefore = lab(frames[mid]!, 48, 50), skinAfter = lab(fixed[mid]!, 48, 50), skinRest = lab(frames[0]!, 48, 50);
  expect(Math.abs(skinAfter[0]! - skinRest[0]!)).toBeLessThan(Math.abs(skinBefore[0]! - skinRest[0]!));
});

test("light_flatten leaves a clip with no drift alone, and the temporal smoothing pins both ends to zero", () => {
  const frames = Array.from({ length: FRAMES }, (_, f) => characterFrame(f, "none", true));
  const offsets = solveLightOffsets(frames.map((frame) => reduceForLight(frame, SIZE, SIZE)), REGIONS_96, SIZE);
  for (const frame of offsets) for (const row of frame) for (const v of row) expect(Math.abs(v)).toBeLessThan(0.05);
  const ramp = Array.from({ length: 10 }, () => [[5, 5, 5], [5, 5, 5], [5, 5, 5], [5, 5, 5]]);
  const smooth = smoothLightOffsets(ramp);
  expect(smooth[0]).toEqual([[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
  expect(smooth[9]).toEqual(smooth[0]);
  expect(smooth[5]![0]![0]).toBeGreaterThan(4.9);
});

test("the default regions are the demo's fractions of the tile, and the request schema takes boxes, a rest reference and the phone flag", () => {
  expect(defaultLightRegions(480)).toEqual({ hair_left: [0, 0, 240, 120], hair_right: [240, 0, 480, 120], clothes_left: [0, 432, 240, 480], clothes_right: [240, 432, 480, 480] });
  const base = { path: "/a.mp4", key: "#00FF00", kind: "loop", min_seconds: 1, max_seconds: 1 };
  const parsed = CompanionClipInput.parse(base);
  expect([parsed.light_flatten, parsed.phone, parsed.rest_reference, parsed.light_regions]).toEqual([false, false, undefined, undefined]);
  expect(CompanionClipInput.safeParse({ ...base, light_flatten: true, phone: true, light_regions: { hair_left: [0, 0, 100, 100] }, rest_reference: "QUJD" }).success).toBe(true);
  expect(CompanionClipInput.safeParse({ ...base, light_regions: { hair_left: [10, 0, 5, 100] } }).success).toBe(false);
  expect(CompanionClipInput.safeParse({ ...base, rest_reference: "palette_reference" }).success).toBe(false);
  expect(CompanionClipInput.safeParse({ ...base, rest_reference: "palette_reference", palette_reference: "QUJD" }).success).toBe(true);
});

test("rest_frame_diff: a frame that matches the rest picture reads 0 and a drifted last frame is over the 1.0 limit and gives the rest_boundary reason", () => {
  const rest = characterFrame(0, "ramp", true), first = characterFrame(0, "ramp", true), last = characterFrame(FRAMES - 1, "ramp", true);
  expect(restFrameDifference(first, rest)).toBe(0);
  const lastDiff = restFrameDifference(last, rest);
  expect(lastDiff).toBeGreaterThan(1);
  const reasons = lightReasons({ rest_frame_diff: { first: 0, last: lastDiff } });
  expect(reasons).toHaveLength(1);
  expect(reasons[0]).toContain("rest picture");
  expect(lightReasons({ rest_frame_diff: { first: 0.2, last: 0.7 }, light_step_after: 0.5 })).toEqual([]);
  expect(lightReasons({ light_step_after: 1.4 })[0]).toContain("lighting");
});

// ---- the real op, where the bundled ffmpeg exists ----
const candidates = [process.env.STACK_TEST_FFMPEG_DIR, "/usr/local/maipai-home/stack/data/engines/ffmpeg/v8.1.3-1"].filter(Boolean) as string[];
const toolDir = candidates.find((dir) => existsSync(join(dir, "ffmpeg")) && existsSync(join(dir, "ffprobe")));
const ffmpeg = toolDir ? join(toolDir, "ffmpeg") : "", ffprobe = toolDir ? join(toolDir, "ffprobe") : "";
if (!toolDir) console.warn("companionLight: the job-level tests are skipped because no ffmpeg and ffprobe were found (set STACK_TEST_FFMPEG_DIR to a folder that has both).");
const real = toolDir ? test : test.skip;
const priorNoNice = process.env.STACK_MEDIA_NO_NICE;
process.env.STACK_MEDIA_NO_NICE = "1";
let root = "";

async function makeClip(path: string, drift: Drift): Promise<void> {
  const child = Bun.spawn([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${SIZE}x${SIZE}`, "-framerate", "24", "-i", "pipe:0", "-an", "-c:v", "libx264", "-crf", "8", "-pix_fmt", "yuv420p", path], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  for (let f = 0; f < FRAMES; f++) child.stdin.write(characterFrame(f, drift, false));
  await child.stdin.end();
  if (await child.exited !== 0) throw new Error(await new Response(child.stderr).text());
}
async function submit(input: Record<string, unknown>) {
  const response = await app.request("/stack/v1/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "media.companion_clip", input: { key: "#00FF00", kind: "loop", min_seconds: 1, max_seconds: 1, ...input } }) });
  const body = await response.json() as any;
  if (response.status !== 202) throw new Error(`refused ${response.status}: ${JSON.stringify(body)}`);
  const done = await waitForJob(body.job.id, 240_000) as any;
  if (done.state !== "done") throw new Error(`job ${done.state}: ${JSON.stringify(done.error ?? done)}`);
  return done.result as any;
}
async function probe(path: string) {
  const out = await spawnRunner([ffprobe, "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_read_frames,pix_fmt,color_space,color_primaries,color_transfer,color_range", "-of", "json", path], { collectStdout: true });
  return JSON.parse(out.stdout).streams[0] as Record<string, string | number>;
}
async function rgba(path: string): Promise<Uint8Array> {
  const output = `${path}.rgba`;
  const result = await spawnRunner([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", output]);
  if (result.code !== 0) throw new Error(result.stderr);
  return new Uint8Array(readFileSync(output));
}

beforeAll(async () => {
  if (!toolDir) return;
  __resetJobsForTests(); __resetRootsForTests();
  root = realpathSync(mkdtempSync(join(tmpdir(), "companion-light-")));
  setRoots({ read: [root], write: [root] });
  for (const drift of ["none", "bump", "ramp"] as const) await makeClip(join(root, `${drift}.mp4`), drift);
  setMediaDepsForTests({ toolbox: { installed: () => true, path: async (tool) => tool === "ffprobe" ? ffprobe : ffmpeg } });
  registerMediaJobs();
});
afterAll(() => {
  if (priorNoNice === undefined) delete process.env.STACK_MEDIA_NO_NICE; else process.env.STACK_MEDIA_NO_NICE = priorNoNice;
  if (!toolDir) return;
  __resetJobsForTests(); __resetRootsForTests(); resetMediaDepsForTests();
  rmSync(root, { recursive: true, force: true }); rmSync(jobsDir(), { recursive: true, force: true });
});

real("the job with light_flatten reports light_step_before and after, keeps alpha identical, and leaves the default output unchanged", async () => {
  const plain = await submit({ path: join(root, "bump.mp4"), output_dir: root, output_name: "bump-plain" });
  expect(plain.light_step_before).toBeUndefined(); expect(plain.rest_frame_diff).toBeUndefined(); expect(plain.phone).toBeUndefined();
  expect(plain.files.map((file: any) => file.name)).not.toContain("clip.phone.h264.mp4");
  const flat = await submit({ path: join(root, "bump.mp4"), output_dir: root, output_name: "bump-flat", light_flatten: true });
  expect(flat.light_step_before).toBeGreaterThan(2);
  expect(flat.light_step_after).toBeLessThan(0.9);
  expect(flat.reasons.join(" ")).not.toContain("lighting");
  const report = JSON.parse(readFileSync(flat.report_path, "utf8"));
  expect(report.light_step_after).toBe(flat.light_step_after);
  const a = await rgba(join(root, "bump-plain", "still.png")), b = await rgba(join(root, "bump-flat", "still.png"));
  for (let i = 3; i < a.length; i += 4) if (a[i] !== b[i]) throw new Error("the still's alpha differs between the plain and the flattened run");
});

real("a drifting last frame is reported against the rest picture and gives rest_boundary; a steady clip does not", async () => {
  const steady = await submit({ path: join(root, "none.mp4"), output_dir: root, output_name: "none-out" });
  const restPicture = readFileSync(join(root, "none-out", "still.png")).toString("base64");
  const same = await submit({ path: join(root, "none.mp4"), output_dir: root, output_name: "none-check", rest_reference: restPicture });
  expect(same.rest_frame_diff.first).toBeLessThan(1); expect(same.rest_frame_diff.last).toBeLessThan(1);
  expect(same.reasons.join(" ")).not.toContain("rest picture");
  expect(steady.ok).toBe(true);
  // the same picture reused through palette_reference
  const reused = await submit({ path: join(root, "none.mp4"), output_dir: root, output_name: "none-reuse", palette_reference: restPicture, rest_reference: "palette_reference" });
  expect(reused.rest_frame_diff.last).toBeLessThan(1);
  const drift = await submit({ path: join(root, "ramp.mp4"), output_dir: root, output_name: "ramp-out", rest_reference: restPicture });
  expect(drift.rest_frame_diff.first).toBeLessThan(1);
  expect(drift.rest_frame_diff.last).toBeGreaterThan(1);
  expect(drift.reasons.some((reason: string) => reason.includes("rest picture"))).toBe(true);
  expect(drift.ok).toBe(false);
});

real("phone: true also writes a 320 x 640 twin with the same frame count and BT.709 limited-range tags", async () => {
  const done = await submit({ path: join(root, "none.mp4"), output_dir: root, output_name: "phone-out", phone: true });
  const phone = done.files.find((file: any) => file.name === "clip.phone.h264.mp4");
  expect(phone).toBeTruthy();
  expect(phone.bytes).toBeLessThanOrEqual(614400);
  const small = await probe(join(root, "phone-out", "clip.phone.h264.mp4")), big = await probe(join(root, "phone-out", "clip.h264.mp4"));
  expect([small.width, small.height]).toEqual([320, 640]);
  expect([big.width, big.height]).toEqual([480, 960]);
  expect(small.nb_read_frames).toBe(big.nb_read_frames);
  expect(Number(small.nb_read_frames)).toBe(done.frames);
  expect(small).toMatchObject({ pix_fmt: "yuv420p", color_space: "bt709", color_primaries: "bt709", color_transfer: "bt709", color_range: "tv" });
  expect(done.phone).toEqual({ width: 320, height: 640 });
});
