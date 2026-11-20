// VF-FINISH-01: a level recipe's typed finish steps run on the delivered copy and land in the receipt. Real ffmpeg on tiny synthetic clips (skipped with a plain
// message when ffmpeg is missing); the media upscale op is stubbed with a file copy (it needs the image tools). No model runs, no network.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyFileSync } from "node:fs";
import { spawnRunner } from "@/media/run";
import { probeFile } from "@/media/probe";
import { deliverClip } from "@/video/deliver";
import { setReceiptProbeForTests } from "@/video/receipt";
import { applyRecipeFinish, RecipeFinishFailure } from "@/video/recipeFinish";
import { packFor } from "@/packs/loader";
import type { StackFinishStep } from "@/video/finish";

const FFMPEG = process.env.STACK_MEDIA_FFMPEG ?? "ffmpeg", FFPROBE = process.env.STACK_MEDIA_FFPROBE ?? "ffprobe";
const have = Bun.which(FFMPEG) !== null && Bun.which(FFPROBE) !== null;
const real = have ? test : test.skip;
if (!have) console.warn("videoRecipeFinish real-ffmpeg tests skipped: ffmpeg or ffprobe is not on the PATH.");
const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const MAX_STEPS: StackFinishStep[] = [{ op: "crop", params: { from_width: 1920, from_height: 1088, width: 1920, height: 1080 } }, { op: "unsharp", params: { luma_x: 5, luma_y: 5, amount: 0.4 } }];
const H3_STEPS: StackFinishStep[] = [{ op: "model_upscale", params: { factor: 2 } }, { op: "audio_lead_in", params: { mute_ms: 130, fade_ms: 50 } }];

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "recipe-finish-"));
  // the receipt reads the real files with the ffprobe of this machine (the Stack's own toolbox is not installed in a test)
  setReceiptProbeForTests(async (path) => {
    const probe = await probeFile(spawnRunner, FFPROBE, path); const video = probe.streams.find((s) => s.type === "video")!; const fps = video.fps ?? 24; const seconds = video.duration_s ?? probe.duration_s ?? 0;
    return { width: video.width!, height: video.height!, frames: Math.round(seconds * fps), fps, seconds, audio: probe.has_audio, bytes: probe.size_bytes };
  });
});
afterEach(() => { setReceiptProbeForTests(null); rmSync(dir, { recursive: true, force: true }); });

async function clip(name: string, width: number, height: number): Promise<string> {
  const path = join(dir, name);
  const made = await spawnRunner([FFMPEG, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=24:duration=2`, "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=48000",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", path], {});
  if (made.code !== 0) throw new Error(made.stderr);
  return path;
}
const deps = (path: string) => ({ ffmpeg: FFMPEG, ffprobe: FFPROBE, run: spawnRunner, path, workDir: dir });
const copyUpscale = async (from: string, target: string) => { copyFileSync(from, target); };

describe("the packs declare the finishers the design measured", () => {
  test("the LTX Max pack's HD recipe crops 1920x1088 to 1920x1080 and sharpens luma", () => {
    const recipes = packFor("ltx-2-5-bf16-distilled-mlx-max")!.pack.jobs.find((job) => job.job === "clip")!.profiles ?? [];
    const withFinish = recipes.filter((r) => r.finish?.length);
    expect(withFinish.length).toBeGreaterThan(0);
    for (const recipe of withFinish) expect(recipe.finish!.map((s) => s.op)).toEqual(["crop", "unsharp"]);
  });
  test("the H3 pack's quality recipe upscales then lead-ins the audio; a preview recipe has no finish", () => {
    const recipes = packFor("minimax-h3")!.pack.jobs.find((job) => job.job === "clip")!.profiles ?? [];
    const withFinish = recipes.filter((r) => r.finish?.length);
    expect(withFinish.length).toBeGreaterThan(0);
    for (const recipe of withFinish) expect(recipe.finish!.map((s) => s.op)).toEqual(["model_upscale", "audio_lead_in"]);
    expect(recipes.filter((r) => r.profile === "preview").every((r) => !r.finish?.length)).toBe(true);
  });
});

describe("applyRecipeFinish and the receipt", () => {
  real("LTX Max: native kept byte for byte, delivered 1920x1080, the receipt names crop and unsharp", async () => {
    const video = await clip("video.mp4", 1920, 1088); const nativeBytes = sha(video);
    const made = await deliverClip({
      outputDir: dir, derivedByGenerator: false, reported: { width: 1920, height: 1088, frames: 48, fps: 24, audio: true },
      finish: (path) => applyRecipeFinish({ ...deps(path), steps: MAX_STEPS, upscale: copyUpscale }),
      recutPoster: async (file, target) => { await spawnRunner([FFMPEG, "-y", "-i", file, "-frames:v", "1", target], {}); },
    });
    expect(sha(join(dir, "native.mp4"))).toBe(nativeBytes);
    expect([made.native.width, made.native.height, made.delivered.width, made.delivered.height]).toEqual([1920, 1088, 1920, 1080]);
    expect(made).toMatchObject({ keptNative: true, deliveredIs: "finished" });
    expect(made.finish.map((f) => [f.operation, f.ok, f.code])).toEqual([["crop", true, null], ["unsharp", true, null]]);
    expect(made.finish[0]).toMatchObject({ from: { width: 1920, height: 1088 }, to: { width: 1920, height: 1080 } });
    const probed = await probeFile(spawnRunner, FFPROBE, join(dir, "video.mp4"));
    expect(probed.streams.find((s) => s.type === "video")!.fps).toBe(24);
  }, 180_000);

  real("a crop that does not fit the clip's size is reported not_applicable, never silently dropped, and the clip is kept as made", async () => {
    const video = await clip("video.mp4", 1280, 704); const before = sha(video);
    const made = await deliverClip({
      outputDir: dir, derivedByGenerator: false, reported: { width: 1280, height: 704, frames: 48, fps: 24, audio: true },
      finish: (path) => applyRecipeFinish({ ...deps(path), steps: MAX_STEPS, upscale: copyUpscale }), recutPoster: async () => {},
    });
    expect(made.finish.map((f) => [f.operation, f.ok, f.code])).toEqual([["crop", false, "not_applicable"], ["unsharp", false, "not_applicable"]]);
    expect(made.deliveredIs).toBe("native"); expect(sha(join(dir, "video.mp4"))).toBe(before);
  }, 180_000);

  real("H3: the model upscale step runs through the media op and then the audio lead-in silences the first 130 ms; both land in the receipt in order", async () => {
    await clip("video.mp4", 864, 480);
    const applied = await applyRecipeFinish({ ...deps(join(dir, "video.mp4")), steps: H3_STEPS, upscale: copyUpscale });
    expect(applied.map((a) => [a.operation, a.ok])).toEqual([["model_upscale", true], ["audio_lead_in", true]]);
  }, 180_000);

  test("a step this Stack does not run is reported not_supported, not dropped", async () => {
    // lanczos_scale and loudness are not built; the step list is validated and reported without touching ffmpeg
    writeFileSync(join(dir, "video.mp4"), "x");
    const applied = await applyRecipeFinish({ ffmpeg: "unused", ffprobe: "unused", run: async () => ({ code: 0, stdout: JSON.stringify({ format: { duration: "2" }, streams: [{ index: 0, codec_type: "video", codec_name: "h264", width: 64, height: 64, avg_frame_rate: "24/1" }] }), stderr: "", aborted: false }),
      path: join(dir, "video.mp4"), workDir: dir, steps: [{ op: "loudness", params: { target: -16 } }], upscale: copyUpscale });
    expect(applied).toEqual([{ operation: "loudness", from: { width: 64, height: 64 }, to: { width: 64, height: 64 }, ok: false, code: "not_supported" }]);
  });

  test("a failing model upscale leaves the delivered file as it was and the failure carries what ran before it", async () => {
    writeFileSync(join(dir, "video.mp4"), "x");
    await expect(applyRecipeFinish({ ffmpeg: "unused", ffprobe: "unused", run: async () => ({ code: 0, stdout: JSON.stringify({ format: { duration: "2" }, streams: [{ index: 0, codec_type: "video", codec_name: "h264", width: 64, height: 64, avg_frame_rate: "24/1" }] }), stderr: "", aborted: false }),
      path: join(dir, "video.mp4"), workDir: dir, steps: [{ op: "model_upscale", params: { factor: 2 } }], upscale: async () => { throw new Error("no gpu"); } })).rejects.toBeInstanceOf(RecipeFinishFailure);
    expect(existsSync(join(dir, "video-upscaled.mp4"))).toBe(false);
  });
});
