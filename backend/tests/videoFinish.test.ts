// VF-FINISH-01: the typed clip finisher. Parsing and ffmpeg arguments are pure; the real-ffmpeg tests build tiny synthetic clips and skip with a
// plain message when ffmpeg is not on the PATH. No model runs, no network.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFinishArgs, finishClip, finisherSteps, type FinisherStep, type StackFinishStep } from "@/video/finish";
import { spawnRunner, type Runner } from "@/media/run";

const FFMPEG = process.env.STACK_MEDIA_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.STACK_MEDIA_FFPROBE ?? "ffprobe";
const haveFfmpeg = Bun.which(FFMPEG) !== null && Bun.which(FFPROBE) !== null;
const realTest = haveFfmpeg ? test : test.skip;
if (!haveFfmpeg) console.warn("videoFinish real-ffmpeg tests skipped: ffmpeg or ffprobe is not on the PATH (set STACK_MEDIA_FFMPEG and STACK_MEDIA_FFPROBE to use another build).");

// The steps a pack's level recipe declares (spec 0.1.433): LTX Max at 1920x1088 and the H3 quality level.
const MAX_SPEC: StackFinishStep[] = [{ op: "crop", params: { from_width: 1920, from_height: 1088, width: 1920, height: 1080 } }, { op: "unsharp", params: { luma_x: 5, luma_y: 5, amount: 0.4 } }];
const H3_SPEC: StackFinishStep[] = [{ op: "model_upscale", params: { factor: 2 } }, { op: "audio_lead_in", params: { mute_ms: 130, fade_ms: 50 } }];
const maxSteps = (): FinisherStep[] => finisherSteps(MAX_SPEC);
const h3Steps = (): FinisherStep[] => finisherSteps(H3_SPEC);
const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("finisherSteps", () => {
  test("the LTX Max steps become a centered crop and a luma sharpen", () => {
    expect(maxSteps()).toEqual([
      { kind: "crop", from: { width: 1920, height: 1088 }, to: { width: 1920, height: 1080 } },
      { kind: "unsharp", size: 5, amount: 0.4 },
    ]);
  });
  test("the H3 steps keep the model upscale as a step this module does not run, plus the audio lead-in", () => {
    expect(h3Steps()).toEqual([{ kind: "other", op: "model_upscale" }, { kind: "audio_lead_in", muteMs: 130, fadeMs: 50 }]);
  });
  test("an empty list is valid", () => { expect(finisherSteps([])).toEqual([]); });
  const crop = (over: Record<string, number>): StackFinishStep => ({ op: "crop", params: { from_width: 1920, from_height: 1088, width: 1920, height: 1080, ...over } });
  const bad: Array<[string, StackFinishStep, RegExp]> = [
    ["crop to larger than from", crop({ width: 2000 }), /"crop" crops to 2000x1080, which is larger than 1920x1088\. Fix that step in the pack's model-pack\.json/],
    ["odd rows removed", crop({ from_height: 1087 }), /"crop" must remove an even number of columns and rows/],
    ["odd columns removed", crop({ from_width: 1921 }), /"crop" must remove an even number of columns and rows/],
    ["odd output size", crop({ width: 1919, from_width: 1921 }), /"crop" needs an even width and height/],
    ["missing crop value", { op: "crop", params: { from_width: 1920 } }, /"crop" needs a number for "from_height"/],
    ["unsharp size even", { op: "unsharp", params: { luma_x: 4, luma_y: 4, amount: 0.4 } }, /"unsharp" needs an odd whole luma size from 3 to 23, not 4/],
    ["unsharp sizes differ", { op: "unsharp", params: { luma_x: 5, luma_y: 7, amount: 0.4 } }, /"unsharp" needs luma_x and luma_y to match/],
    ["unsharp not a number", { op: "unsharp", params: { luma_x: 5, luma_y: 5, amount: "strong" } }, /"unsharp" needs a number for "amount"/],
    ["negative mute", { op: "audio_lead_in", params: { mute_ms: -5, fade_ms: 50 } }, /"audio_lead_in" cannot use a negative time/],
    ["missing fade", { op: "audio_lead_in", params: { mute_ms: 130 } }, /"audio_lead_in" needs a number for "fade_ms"/],
  ];
  for (const [name, step, message] of bad) test(`throws for ${name}`, () => { expect(() => finisherSteps([step])).toThrow(message); });
});

describe("buildFinishArgs", () => {
  const base = { ffmpeg: "ffmpeg", source: "/c/in.mp4", target: "/c/out.mp4" };
  const flag = (args: string[], name: string): string | undefined => args[args.indexOf(name) + 1];

  test("LTX Max at 1920x1088 crops 1920x1080 centered and sharpens luma only", () => {
    const args = buildFinishArgs({ ...base, steps: maxSteps(), size: { width: 1920, height: 1088 }, hasAudio: true })!;
    expect(flag(args, "-vf")).toBe("crop=1920:1080:(in_w-1920)/2:(in_h-1080)/2,unsharp=5:5:0.4:5:5:0");
    expect(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 9)).toEqual(["-c:v", "libx264", "-crf", "15", "-preset", "slow", "-pix_fmt", "yuv420p", "-c:a"]);
    expect(flag(args, "-c:a")).toBe("copy");
    expect(args).toContain("-map"); expect(flag(args, "-map")).toBe("0");
    expect(args.slice(-3)).toEqual(["-movflags", "+faststart", "/c/out.mp4"]);
    expect(args.slice(0, 1)).toEqual(["ffmpeg"]);
    expect(flag(args, "-i")).toBe("/c/in.mp4");
  });
  test("the crop is skipped at 1280x704, and nothing else applying returns null", () => {
    expect(buildFinishArgs({ ...base, steps: maxSteps(), size: { width: 1280, height: 704 }, hasAudio: true })).toBeNull();
    expect(buildFinishArgs({ ...base, steps: [maxSteps()[0]!], size: { width: 1280, height: 704 }, hasAudio: true })).toBeNull();
  });
  test("the frame rate is never changed and the target is never overwritten", () => {
    for (const steps of [maxSteps(), h3Steps()]) {
      for (const size of [{ width: 1920, height: 1088 }, { width: 864, height: 480 }]) {
        const args = buildFinishArgs({ ...base, steps, size, hasAudio: true });
        if (!args) continue;
        expect(args).not.toContain("-r");
        expect(args).not.toContain("-y");
        expect(args.join(" ")).not.toContain("fps");
      }
    }
  });
  test("only the audio lead-in applying copies the video stream", () => {
    const args = buildFinishArgs({ ...base, steps: h3Steps(), size: { width: 864, height: 480 }, hasAudio: true })!;
    expect(flag(args, "-c:v")).toBe("copy");
    expect(args).not.toContain("-vf");
    expect(flag(args, "-af")).toBe("volume=enable='lt(t,0.13)':volume=0,afade=t=in:st=0.13:d=0.05");
    expect(args.slice(args.indexOf("-c:a"), args.indexOf("-c:a") + 4)).toEqual(["-c:a", "aac", "-b:a", "192k"]);
  });
  test("with no audio the lead-in does not apply and the model upscale is never run here", () => {
    expect(buildFinishArgs({ ...base, steps: h3Steps(), size: { width: 864, height: 480 }, hasAudio: false })).toBeNull();
    const withAudioOnly = buildFinishArgs({ ...base, steps: maxSteps(), size: { width: 1920, height: 1088 }, hasAudio: false })!;
    expect(flag(withAudioOnly, "-c:a")).toBe("copy");
    expect(withAudioOnly).not.toContain("-af");
  });
  test("an empty list returns null", () => {
    expect(buildFinishArgs({ ...base, steps: [], size: { width: 1920, height: 1088 }, hasAudio: true })).toBeNull();
  });
});

describe("finishClip with real ffmpeg", () => {
  let dir = "";
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "finish-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  async function makeClip(name: string, width: number, height: number, withAudio: boolean): Promise<string> {
    const path = join(dir, name);
    const audio = withAudio ? ["-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=48000"] : [];
    const codecs = withAudio ? ["-c:a", "aac", "-b:a", "192k"] : [];
    const made = await spawnRunner([FFMPEG, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=24:duration=2`, ...audio, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", ...codecs, path]);
    if (made.code !== 0) throw new Error(`Could not build the synthetic clip: ${made.stderr}`);
    return path;
  }
  async function pcm(path: string): Promise<Float32Array> {
    const child = Bun.spawn([FFMPEG, "-hide_banner", "-loglevel", "error", "-i", path, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], { stdout: "pipe", stderr: "pipe" });
    const bytes = new Uint8Array(await new Response(child.stdout).arrayBuffer());
    await child.exited;
    return new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4));
  }
  const db = (samples: Float32Array, fromMs: number, toMs: number): number => {
    const part = samples.slice(Math.floor(fromMs * 48), Math.floor(toMs * 48));
    let sum = 0; for (const s of part) sum += s * s;
    return 20 * Math.log10(Math.sqrt(sum / part.length) || 1e-12);
  };
  const probe = async (path: string) => (await import("@/media/probe")).probeFile(spawnRunner, FFPROBE, path);

  realTest("LTX Max steps turn a 1920x1088 clip into 1920x1080 at the same rate and length, leaving the source byte for byte", async () => {
    const source = await makeClip("max.mp4", 1920, 1088, true);
    const before = sha(source);
    const target = join(dir, "max.finished.mp4");
    const result = await finishClip({ ffmpeg: FFMPEG, ffprobe: FFPROBE, source, target, steps: maxSteps(), run: spawnRunner });
    expect(result.target).toBe(target);
    expect(result.ran.map((s) => s.kind)).toEqual(["crop", "unsharp"]);
    expect(result.skipped).toEqual([]);
    const made = await probe(target); const original = await probe(source);
    expect([made.width, made.height]).toEqual([1920, 1080]);
    expect(made.streams.find((s) => s.type === "video")!.fps).toBe(24);
    expect(Math.abs(made.duration_s! - original.duration_s!)).toBeLessThanOrEqual(0.05);
    expect(made.has_audio).toBe(true);
    expect(sha(source)).toBe(before);
  }, 120_000);

  realTest("a 1280x704 clip with the LTX Max steps returns no target and creates no file", async () => {
    const source = await makeClip("small.mp4", 1280, 704, true);
    const target = join(dir, "small.finished.mp4");
    const files = readdirSync(dir);
    const result = await finishClip({ ffmpeg: FFMPEG, ffprobe: FFPROBE, source, target, steps: maxSteps(), run: spawnRunner });
    expect(result).toEqual({ ran: [], skipped: maxSteps(), target: null });
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(dir)).toEqual(files);
  }, 120_000);

  realTest("the H3 audio lead-in silences the first 100 ms, keeps the tone later and reports the model upscale as skipped", async () => {
    const source = await makeClip("h3.mp4", 864, 480, true);
    const target = join(dir, "h3.finished.mp4");
    expect(db(await pcm(source), 0, 100)).toBeGreaterThan(-30);
    const result = await finishClip({ ffmpeg: FFMPEG, ffprobe: FFPROBE, source, target, steps: h3Steps(), run: spawnRunner });
    expect(result.ran.map((s) => s.kind)).toEqual(["audio_lead_in"]);
    expect(result.skipped.map((s) => s.kind)).toEqual(["other"]);
    const samples = await pcm(target);
    expect(db(samples, 0, 100)).toBeLessThan(-60);
    expect(db(samples, 300, 600)).toBeGreaterThan(-30);
    const made = await probe(target);
    expect([made.width, made.height]).toEqual([864, 480]);
    expect(made.video_codec).toBe("h264");
  }, 120_000);

  realTest("an ffmpeg that fails leaves no target, keeps the source untouched and says the clip was kept as made", async () => {
    const source = await makeClip("fail.mp4", 1920, 1088, true);
    const before = sha(source);
    const target = join(dir, "fail.finished.mp4");
    const failing: Runner = async (argv, options) => {
      if (argv[0] === FFMPEG) { writeFileSync(target, "partial"); return { code: 1, stdout: "", stderr: "Conversion failed!", aborted: false }; }
      return spawnRunner(argv, options);
    };
    await expect(finishClip({ ffmpeg: FFMPEG, ffprobe: FFPROBE, source, target, steps: maxSteps(), run: failing })).rejects.toThrow(/kept as made/);
    expect(existsSync(target)).toBe(false);
    expect(sha(source)).toBe(before);
  }, 120_000);

  realTest("a result that is not what the steps imply is deleted and the clip is kept as made", async () => {
    const source = await makeClip("wrong.mp4", 1920, 1088, true);
    const target = join(dir, "wrong.finished.mp4");
    const noCrop: Runner = async (argv, options) => spawnRunner(argv[0] === FFMPEG ? argv.map((a) => a.startsWith("crop=") ? "null" : a).map((a) => a.startsWith("null,") ? a.slice(5) : a) : argv, options);
    await expect(finishClip({ ffmpeg: FFMPEG, ffprobe: FFPROBE, source, target, steps: maxSteps(), run: noCrop })).rejects.toThrow(/1920x1088, not 1920x1080.*kept as made/);
    expect(existsSync(target)).toBe(false);
  }, 120_000);

  test("an existing target is refused and left alone", async () => {
    const source = join(dir, "a.mp4"); const target = join(dir, "b.mp4");
    writeFileSync(source, "x"); writeFileSync(target, "precious");
    const probing: Runner = async (argv) => argv[0] === FFPROBE
      ? { code: 0, stdout: JSON.stringify({ format: { duration: "2" }, streams: [{ index: 0, codec_type: "video", codec_name: "h264", width: 1920, height: 1088, avg_frame_rate: "24/1" }] }), stderr: "", aborted: false }
      : { code: 0, stdout: "", stderr: "", aborted: false };
    await expect(finishClip({ ffmpeg: FFMPEG, ffprobe: FFPROBE, source, target, steps: maxSteps(), run: probing })).rejects.toThrow(/already exists/);
    expect(readFileSync(target, "utf8")).toBe("precious");
    expect(readFileSync(source, "utf8")).toBe("x");
  });
});
