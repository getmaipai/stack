// MAKER-H: the four companion maker job kinds. Scripted-worker tests check validation and plain-words refusals, progress and cancel;
// the real-worker tests (IMAGE_TOOLS_PYTHON, with OpenCV, NumPy and Pillow) run each kind on the small MAKER-B and MAKER-C fixtures.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __resetJobsForTests, getJob, waitForJob } from "@/lib/jobs";
import { HostLimiter } from "@/media/hosts";
import { makerDeps, COMPANION_MAKER_KINDS } from "@/media/companionMaker";
import { MEDIA_KINDS, registerMediaJobs, resetMediaDepsForTests, setMediaDepsForTests } from "@/media/jobs";
import { __resetRootsForTests, jobsDir, setRoots } from "@/media/paths";
import { IMAGE_TOOLS_OPERATIONS, ImageToolsService, workerHandle, type ImageToolsDeps, type ImageToolInput, type ImageToolResult } from "@/imagetools/imageTools";

const python = process.env.IMAGE_TOOLS_PYTHON;
const script = join(import.meta.dir, "../src/imagetools/image_tools_worker.py");
const emotionFixture = join(import.meta.dir, "helpers/emotion_fixture.py");
const original = makerDeps.run;
let root: string; const seen: ImageToolInput[] = [];
let scripted: (input: ImageToolInput, signal?: AbortSignal) => Promise<Partial<ImageToolResult>> | Partial<ImageToolResult>;

beforeEach(() => {
  __resetJobsForTests(); __resetRootsForTests(); seen.length = 0;
  root = realpathSync(mkdtempSync(join(tmpdir(), "maker-root-")));
  setRoots({ read: [root], write: [root] });
  setMediaDepsForTests({ limiter: new HostLimiter() });
  registerMediaJobs();
  scripted = () => ({});
  makerDeps.run = async (input, options) => { seen.push(input); return { png: new Uint8Array(0), width: 0, height: 0, engine: "x", model: "none", ms: 1, operation: input.operation, ...(await scripted(input, options.signal)) } as ImageToolResult; };
});
afterEach(() => { makerDeps.run = original; __resetJobsForTests(); __resetRootsForTests(); resetMediaDepsForTests(); rmSync(root, { recursive: true, force: true }); rmSync(jobsDir(), { recursive: true, force: true }); });

async function post(kind: string, input: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const response = await app.request("/stack/v1/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, input }) });
  return { status: response.status, body: await response.json() };
}
async function run(kind: string, input: Record<string, unknown>): Promise<any> {
  const { status, body } = await post(kind, input);
  if (status !== 202) throw new Error(`refused ${status}: ${JSON.stringify(body)}`);
  return waitForJob(body.job.id, 120_000);
}
const png = (name: string, bytes = "png"): string => { const path = join(root, name); writeFileSync(path, bytes); return path; };
const folder = (name: string): string => { const path = join(root, name); mkdirSync(path, { recursive: true }); return path; };

test("the four kinds are media kinds, internal image-tools operations, and not on the upload route", () => {
  for (const kind of COMPANION_MAKER_KINDS) expect((MEDIA_KINDS as readonly string[]).includes(kind)).toBe(true);
  for (const op of ["clip_track", "shapes_bake", "emotion_bake", "pack_assemble"]) expect((IMAGE_TOOLS_OPERATIONS as readonly string[]).includes(op)).toBe(false);
});

const GOOD: Record<string, () => Record<string, unknown>> = {
  "media.companion_track": () => ({ rest: png("rest.png"), frames_dir: folder("frames") }),
  "media.companion_shapes": () => ({ rest: png("rest.png"), frames_dir: folder("frames"), landmarks: { rest: {} } }),
  "media.companion_emotion": () => ({ rest: png("rest.png"), landmarks: {}, poses: { angry: [png("angry.png")] } }),
  "media.companion_pack": () => ({ rest: png("rest.png"), staging: folder("staging"), descriptor: { id: "x" } }),
};

for (const kind of COMPANION_MAKER_KINDS) {
  test(`${kind}: a missing input, a path escape and a size cap are refused in plain words before the queue`, async () => {
    const good = GOOD[kind]!();
    const missing = await post(kind, { ...good, rest: join(root, "nope.png") });
    expect(missing.status).toBe(422); expect(missing.body.error ?? JSON.stringify(missing.body)).toContain("does not exist");
    const escape = await post(kind, { ...good, rest: `${root}/../etc/passwd` });
    expect(escape.status).toBe(422); expect(JSON.stringify(escape.body)).toContain("..");
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "maker-out-"))); writeFileSync(join(outside, "x.png"), "x");
    const away = await post(kind, { ...good, rest: join(outside, "x.png") });
    expect(away.status).toBe(422); expect(JSON.stringify(away.body)).toContain("outside the media folders");
    const outDir = await post(kind, { ...good, output_dir: outside });
    expect(outDir.status).toBe(422); expect(JSON.stringify(outDir.body)).toContain("outside the folders Home declared for writing");
    rmSync(outside, { recursive: true, force: true });
    writeFileSync(good.rest as string, Buffer.alloc(32_000_001));
    const big = await post(kind, good);
    expect(big.status).toBe(422); expect(JSON.stringify(big.body)).toContain("larger than 32 MB");
    const extra = await post(kind, { ...GOOD[kind]!(), surprise: 1 });
    expect(extra.status).toBe(422); expect(JSON.stringify(extra.body)).toContain("surprise");
    expect(seen.length).toBe(0);
  });
}

test("media.companion_track: frames_dir or clip, not both and not neither; a clip over the cap; a folder over the file cap", async () => {
  const rest = png("rest.png");
  expect((await post("media.companion_track", { rest })).status).toBe(422);
  expect((await post("media.companion_track", { rest, frames_dir: folder("f"), clip: png("c.mp4") })).status).toBe(422);
  writeFileSync(join(root, "c.mp4"), Buffer.alloc(64_000_001));
  const big = await post("media.companion_track", { rest, clip: join(root, "c.mp4") });
  expect(JSON.stringify(big.body)).toContain("larger than 64 MB");
  const many = folder("many"); for (let i = 0; i < 401; i++) writeFileSync(join(many, `${i}.png`), "x");
  const tooMany = await post("media.companion_track", { rest, frames_dir: many });
  expect(JSON.stringify(tooMany.body)).toContain("more than 400 files");
});

test("media.companion_pack and media.companion_shapes: a pose list over the cap and a bad emotion name are refused", async () => {
  const bad = await post("media.companion_emotion", { rest: png("rest.png"), landmarks: {}, poses: { happy: [png("a.png")] } });
  expect(bad.status).toBe(422);
  const three = await post("media.companion_emotion", { rest: png("rest.png"), landmarks: {}, poses: { angry: [png("a.png"), png("b.png"), png("c.png")] } });
  expect(three.status).toBe(422);
});

test("each kind sends its op, writes track.json or its folder, a report.json with ok and reasons, and the progress goes 0 to 100", async () => {
  const track = { m: [[1, 0, 0, 0, 1, 0]], res: [0], cc: [1], low: [], frames: 1 };
  scripted = (input) => input.operation === "clip_track" ? { track } : input.operation === "shapes_bake" ? { shapes: { ok: true, reasons: [], sets: {} } as never } : input.operation === "emotion_bake" ? { data: { ok_all: true, kinds: {} } } : { data: { pack: { id: "x", files: 3 } } };
  const track1 = await run("media.companion_track", GOOD["media.companion_track"]!());
  expect(track1.state).toBe("done"); expect(track1.percent).toBe(100);
  expect(track1.result).toMatchObject({ ok: true, reasons: [], frames: 1 });
  expect(JSON.parse(readFileSync(track1.result.track_path, "utf8")).frames).toBe(1);
  expect(JSON.parse(readFileSync(track1.result.report_path, "utf8"))).toMatchObject({ ok: true, reasons: [] });
  expect(seen[0]!.operation).toBe("clip_track"); expect((seen[0]!.params as any).frames_dir).toBe(join(root, "frames"));
  const shapes = await run("media.companion_shapes", GOOD["media.companion_shapes"]!());
  expect(shapes.result).toMatchObject({ ok: true }); expect(seen[1]!.params).toMatchObject({ output_dir: join(shapes.result.output_dir, "shapes") });
  const emotion = await run("media.companion_emotion", GOOD["media.companion_emotion"]!());
  expect(emotion.result).toMatchObject({ ok: true }); expect((seen[2]!.params as any).poses).toEqual({ angry: [join(root, "angry.png")] });
  const pack = await run("media.companion_pack", GOOD["media.companion_pack"]!());
  expect(pack.result).toMatchObject({ ok: true, pack: { id: "x" } }); expect((seen[3]!.params as any).out_dir).toBe(join(pack.result.output_dir, "pack"));
});

test("progress runs from 0, through 5 while the worker runs, to 100", async () => {
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  let started!: () => void; const running = new Promise<void>((r) => { started = r; });
  scripted = async () => { started(); await gate; return { track: { m: [], res: [], cc: [], low: [], frames: 0 } }; };
  const { body } = await post("media.companion_track", GOOD["media.companion_track"]!());
  await running;
  expect(getJob(body.job.id)!.percent).toBe(5);
  release();
  const done = await waitForJob(body.job.id, 5000);
  expect(done!.percent).toBe(100);
  expect(done!.result).toMatchObject({ ok: false });
});

test("media.companion_track from a clip: ffmpeg writes the frames and the tracker is pointed at them", async () => {
  setMediaDepsForTests({ toolbox: { installed: () => true, path: async (tool) => `/fake/bin/${tool}` }, run: async (argv) => { writeFileSync(argv[argv.length - 1]!.replace("%05d", "00001"), "x"); return { code: 0, stdout: "", stderr: "", aborted: false }; } });
  scripted = () => ({ track: { m: [[1, 0, 0, 0, 1, 0]], res: [0], cc: [1], low: [], frames: 1 } });
  const job = await run("media.companion_track", { rest: png("rest.png"), clip: png("clip.mp4") });
  expect(job.result).toMatchObject({ ok: true, frames: 1 });
  expect((seen[0]!.params as any).frames_dir).toContain(".maker-frames-track");
  scripted = () => { throw new Error("must not run"); };
  setMediaDepsForTests({ toolbox: { installed: () => true, path: async (tool) => `/fake/bin/${tool}` }, run: async () => ({ code: 1, stdout: "", stderr: "bad", aborted: false }) });
  const unreadable = await run("media.companion_track", { rest: png("rest.png"), clip: png("clip.mp4") });
  expect(unreadable.state).toBe("failed"); expect(JSON.stringify(unreadable)).toContain("could not be read");
});

test("a worker refusal the maker can act on is a finished job with ok false and the plain reason; cancel stops a running job", async () => {
  const { ImageToolError } = await import("@/imagetools/imageTools");
  scripted = () => { throw new ImageToolError("pose_missing", "There is no pose picture for sad. Make one.", 422); };
  const refused = await run("media.companion_emotion", GOOD["media.companion_emotion"]!());
  expect(refused.state).toBe("done"); expect(refused.result).toMatchObject({ ok: false, reasons: ["There is no pose picture for sad. Make one."], code: "pose_missing" });
  let aborted = false;
  scripted = (_input, signal) => new Promise((_, reject) => { signal?.addEventListener("abort", () => { aborted = true; reject(new Error("Cancelled.")); }); });
  const { body } = await post("media.companion_shapes", GOOD["media.companion_shapes"]!());
  await Bun.sleep(100);
  const response = await app.request(`/stack/v1/jobs/${body.job.id}`, { method: "DELETE" });
  expect(((await response.json()) as any).job.state).toBe("cancelled");
  expect(aborted).toBe(true);
});

// ---- real worker ----
function realService(): ImageToolsService {
  const deps: ImageToolsDeps = { requirements: () => "requirements.txt", ensureEnvironment: async () => {}, ensureHelper: async () => null, modelPath: () => null, tmpDir: () => mkdtempSync(join(tmpdir(), "maker-svc-")), hold: async () => ({ release: () => {} }), spawn: async () => workerHandle(Bun.spawn([python!, "-I", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }) as never) };
  return new ImageToolsService(deps);
}
const fixture = (kind: string, dir: string, extra: string[] = []) => { const r = Bun.spawnSync([python!, "-I", emotionFixture, kind, dir, ...extra]); expect(String(r.stderr)).toBe(""); expect(r.exitCode).toBe(0); };

test.skipIf(!python)("real worker: media.companion_track writes track.json for frames and refuses an empty folder in words", async () => {
  makerDeps.run = (input, options) => svc.run(input, options); const svc = realService();
  const dir = join(root, "face"); fixture("face", dir);
  const frames = join(root, "tf"); mkdirSync(frames); for (const n of ["00001", "00002", "00003"]) copyFileSync(join(dir, "rest.png"), join(frames, `${n}.png`));
  const job = await run("media.companion_track", { rest: join(dir, "rest.png"), frames_dir: frames });
  expect(job.state).toBe("done"); expect(job.result).toMatchObject({ ok: true, frames: 3 });
  const track = JSON.parse(readFileSync(job.result.track_path, "utf8"));
  expect(track.m.length).toBe(3); expect(Math.abs(track.m[2][2])).toBeLessThan(0.5);
  expect(existsSync(join(job.result.output_dir, "report.json"))).toBe(true);
  const refused = await run("media.companion_track", { rest: join(dir, "rest.png"), frames_dir: folder("emptyframes") });
  expect(refused.result).toMatchObject({ ok: false, code: "frames_required" });
  svc.stop();
});

test.skipIf(!python)("real worker: media.companion_emotion bakes the four layers into the output folder with an ok report", async () => {
  const svc = realService(); makerDeps.run = (input, options) => svc.run(input, options);
  const dir = join(root, "face"); fixture("face", dir);
  const job = await run("media.companion_emotion", { rest: join(dir, "rest.png"), landmarks: JSON.parse(readFileSync(join(dir, "landmarks.json"), "utf8")), poses: Object.fromEntries(["angry", "excited", "alarmed", "sad"].map((k) => [k, [join(dir, `${k}.png`)]])) });
  expect(job.state).toBe("done"); expect(job.result).toMatchObject({ ok: true, reasons: [] });
  expect(readdirSync(job.result.emotion_dir).sort()).toContain("angry.flow.bin"); expect(existsSync(join(job.result.emotion_dir, "meta.json"))).toBe(true);
  expect(JSON.parse(readFileSync(job.result.report_path, "utf8")).ok).toBe(true);
  svc.stop();
});

test.skipIf(!python)("real worker: media.companion_pack assembles a staging folder into a pack folder", async () => {
  const svc = realService(); makerDeps.run = (input, options) => svc.run(input, options);
  const dir = join(root, "stage"); fixture("staging", dir);
  const descriptor = { id: "tiny", name: "Tiny", tile: { desktop: 480, phone: 320 }, provenance: { source: "generated" }, mouth: { anchor: { x: 0.4, y: 0.55, w: 0.15, h: 0.14 } }, life: { nod: 1.2 } };
  for (const name of ["idle1", "idle2", "listen", "think"]) copyFileSync(join(dir, "clips", `${name}.mp4`), join(dir, "clips", `${name}.phone.mp4`));
  const job = await run("media.companion_pack", { rest: join(dir, "rest.png"), staging: dir, descriptor });
  expect(job.state).toBe("done"); expect(job.result).toMatchObject({ ok: true, pack: { id: "tiny" } });
  expect(existsSync(join(job.result.pack_dir, "pack.json"))).toBe(true);
  const noStaging = await run("media.companion_pack", { rest: join(dir, "rest.png"), staging: folder("empty-stage"), descriptor });
  expect(noStaging.result.ok).toBe(false);
  svc.stop();
});

test.skipIf(!python)("real worker: media.companion_shapes bakes the calm set on the MAKER-B drawn face", async () => {
  const svc = realService(); makerDeps.run = (input, options) => svc.run(input, options);
  const src = readFileSync(join(import.meta.dir, "shapesBake.test.ts"), "utf8");
  const FIXTURE = src.match(/const FIXTURE = `([\s\S]*?)`;/)![1]!;
  const dir = join(root, "shapes"); mkdirSync(dir);
  const made = Bun.spawnSync([python!, "-I", "-c", FIXTURE, dir, JSON.stringify({ calm: { B: 4, C: 6, D: 10, E: 6, F: 2, G: 4, H: 6 } })]);
  expect(String(made.stderr)).toBe("");
  const job = await run("media.companion_shapes", { rest: join(dir, "rest.png"), frames_dir: join(dir, "frames"), landmarks: JSON.parse(readFileSync(join(dir, "lm.json"), "utf8")), sets: ["calm"] });
  expect(job.state).toBe("done"); expect(job.result.ok, JSON.stringify(job.result.reasons)).toBe(true);
  expect(existsSync(join(job.result.shapes_dir, "calm", "atlas.png"))).toBe(true);
  expect(JSON.parse(readFileSync(join(job.result.report_path), "utf8")).ok).toBe(true);
  svc.stop();
});
