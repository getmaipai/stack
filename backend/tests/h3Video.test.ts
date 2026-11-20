import { expect, test } from "bun:test";
import { app } from "@/app";
import { H3_VIDEO_CAPABILITIES, H3_VIDEO_ID, finishH3Clip, h3VideoCommand } from "@/video/h3";
import { qualityOfModelName, VIDEO_SPECS, videoGen } from "@/video/videoGen";
import { TIER_CANDIDATES } from "@/lib/tiers";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VideoGenService, type VideoGenDeps, type VideoRunInput } from "@/video/videoGen";

test("MiniMax H3 has explicit CLI capabilities and a stable video identity", () => {
  expect(H3_VIDEO_ID).toBe("minimax-h3");
  expect(H3_VIDEO_CAPABILITIES).toEqual({ first_picture: true, last_picture: true, reference_pictures: false, extend: false, audio: true, lora: false });
  expect(qualityOfModelName("minimax-h3")).toBe("h3");
  expect(VIDEO_SPECS.h3.audio).toBe(true);
});

test("the fake-runner argv carries the prompt, paths, preset and measured clip settings", () => {
  const argv = h3VideoCommand("python", "generate_staged.py", { prompt: "A bright kitchen", build: "boost-8bit", checkpoint: "models/upstream/FL2VA", transformer: "models/transformers/8-bit", qwenDir: "models/qwen/8-bit", output: "out.mp4", seconds: 5, width: 864, height: 480, seed: 7, steps: 25, lora: "models/turbo.safetensors", firstImage: "first.png", lastImage: "last.png" });
  expect(argv).toContain("--first-image"); expect(argv).toContain("first.png"); expect(argv).toContain("--last-image"); expect(argv).toContain("last.png");
});

test("H3 clip finishing calls the Stack upscale seam exactly once", async () => {
  let calls = 0;
  await finishH3Clip(async (clip) => { expect(clip).toBe("clip.mp4"); calls += 1; }, "clip.mp4");
  expect(calls).toBe(1);
});

function h3Fixture(run: NonNullable<VideoGenDeps["run"]>, quality: "h3" | "h3stream" = "h3") {
  const root = mkdtempSync(join(tmpdir(), "h3-run-"));
  mkdirSync(join(root, "models/minimax_h3/loras"), { recursive: true });
  writeFileSync(join(root, "models/minimax_h3/loras/minimax_h3_turbo_v4_step600_ema.safetensors"), "adapter");
  const deps: VideoGenDeps = { supported: () => true, ensureEnvironment: async () => {}, spawn: async () => { throw new Error("H3 must use its one-shot runner"); }, paths: () => ({ modelDir: join(root, "models/minimax_h3"), tokenizerDir: "", h3Home: root, h3Build: quality === "h3" ? "boost-8bit" : "streaming-24gb" }), run, ffmpeg: () => "fake-ffmpeg" };
  const input: VideoRunInput = { prompt: "A bright kitchen", negativePrompt: null, imagePath: null, width: 864, height: 480, frames: 121, seed: 7, loras: [], outputDir: join(root, "out"), quality };
  return { root, service: new VideoGenService(deps), input };
}

test("H3 one-shot uses v4 adapter and seven steps, and returns the ordinary clip result", async () => {
  let command: string[] = [];
  const fixture = h3Fixture(async (argv) => { if (!argv.includes("-frames:v")) command = argv; writeFileSync(argv.at(-1)!, argv.includes("-frames:v") ? "JPEG" : "MP4"); return { code: 0, stdout: "", stderr: "", aborted: false }; });
  try {
    const result = await fixture.service.run(fixture.input, { jobId: "h3-test" });
    expect(command).toContain(join(fixture.root, "models/minimax_h3/loras/minimax_h3_turbo_v4_step600_ema.safetensors"));
    expect(command.slice(command.indexOf("--steps") + 1, command.indexOf("--steps") + 2)).toEqual(["7"]);
    expect(result).toMatchObject({ width: 864, height: 480, seed: 7, audio: true });
    expect(existsSync(join(fixture.input.outputDir, "video.mp4"))).toBe(true);
    expect(existsSync(join(fixture.input.outputDir, "poster.jpg"))).toBe(true);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("H3 one-shot forwards first and last picture paths to the fake CLI", async () => {
  let command: string[] = [];
  const fixture = h3Fixture(async (argv) => { if (!argv.includes("-frames:v")) command = argv; writeFileSync(argv.at(-1)!, "MP4"); return { code: 0, stdout: "", stderr: "", aborted: false }; });
  fixture.input.imagePath = "/job/first.png"; fixture.input.endImagePath = "/job/last.png";
  try {
    await fixture.service.run(fixture.input, { jobId: "h3-keyframes" });
    expect(command.slice(command.indexOf("--first-image"), command.indexOf("--first-image") + 2)).toEqual(["--first-image", "/job/first.png"]);
    expect(command.slice(command.indexOf("--last-image"), command.indexOf("--last-image") + 2)).toEqual(["--last-image", "/job/last.png"]);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("video status exposes honest H3 capabilities and becomes ready only with the one-shot files", async () => {
  const root = mkdtempSync(join(tmpdir(), "h3-status-"));
  const previous = process.env.MAIPAI_H3_VIDEO_HOME;
  process.env.MAIPAI_H3_VIDEO_HOME = root;
  const status = async () => (await (await app.request("/stack/v1/video")).json() as { video: { qualities: Record<string, Record<string, any>> } }).video.qualities;
  try {
    expect((await status()).h3).toMatchObject({ ready: false, image_to_video: true, end_image: true, audio: true, video_to_video: false, reference_pictures: false, reference_videos: false, reference_audio: false, limits: { max_seconds: 5, fps: 24, default_size: "864x480" }, licence: { id: "minimax-h3-community-2026-08-02" }, lora_base_model: "minimax-h3", loras: { supported: false } });
    const models = join(root, "models/minimax_h3");
    for (const path of ["node/scripts/generate_staged.py", ".venv/bin/python", "models/minimax_h3/upstream/FL2VA", "models/minimax_h3/qwen/8-bit", "models/minimax_h3/transformers/8-bit"]) { const full = join(root, path); mkdirSync(path.includes("/") ? full.slice(0, full.lastIndexOf("/")) : root, { recursive: true }); writeFileSync(full, "present"); }
    const qualities = await status();
    expect(qualities.h3).toMatchObject({ ready: true });
    expect(qualities.h3stream).toBeUndefined();
    mkdirSync(join(models, "transformers/4-bit-pruned-stream2"), { recursive: true });
    expect((await status()).h3stream).toMatchObject({ ready: true });
  } finally { if (previous === undefined) delete process.env.MAIPAI_H3_VIDEO_HOME; else process.env.MAIPAI_H3_VIDEO_HOME = previous; rmSync(root, { recursive: true, force: true }); videoGen.useDeps(null); }
});

test("H3 without its required Standard adapter refuses before starting the runner", async () => {
  let command: string[] = [];
  const fixture = h3Fixture(async (argv) => { if (!argv.includes("-frames:v")) command = argv; writeFileSync(argv.at(-1)!, argv.includes("-frames:v") ? "JPEG" : "MP4"); return { code: 0, stdout: "", stderr: "", aborted: false }; });
  rmSync(join(fixture.root, "models/minimax_h3/loras/minimax_h3_turbo_v4_step600_ema.safetensors"));
  try {
    await expect(fixture.service.run(fixture.input, { jobId: "h3-no-lora" })).rejects.toMatchObject({ code: "not_installed", status: 503 });
    expect(command).toEqual([]);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("H3 boost always uses the declared 24-step recipe even when an adapter file exists", async () => {
  let command: string[] = [];
  const fixture = h3Fixture(async (argv) => { if (!argv.includes("-frames:v")) command = argv; writeFileSync(argv.at(-1)!, argv.includes("-frames:v") ? "JPEG" : "MP4"); return { code: 0, stdout: "", stderr: "", aborted: false }; });
  fixture.input.level = "boost";
  try {
    const result = await fixture.service.run(fixture.input, { jobId: "h3-boost" });
    expect(command.slice(command.indexOf("--steps") + 1, command.indexOf("--steps") + 2)).toEqual(["24"]);
    expect(command).not.toContain("--lora");
    expect(result.ran).toMatchObject({ steps: 24, adapter: null, schedule: "h3-24" });
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("H3 Standard refuses when its required fast-draft adapter is absent", async () => {
  const fixture = h3Fixture(async () => { throw new Error("runner must not start"); });
  rmSync(join(fixture.root, "models/minimax_h3/loras/minimax_h3_turbo_v4_step600_ema.safetensors"));
  try { await expect(fixture.service.run(fixture.input, { jobId: "h3-adapter-missing" })).rejects.toMatchObject({ code: "not_installed", status: 503 }); }
  finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("cancelling H3 aborts its one-shot child runner", async () => {
  let observedSignal: AbortSignal | undefined;
  const fixture = h3Fixture(async (_argv, options) => { observedSignal = options?.signal; await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true })); return { code: null, stdout: "", stderr: "", aborted: true }; });
  const controller = new AbortController();
  try {
    const running = fixture.service.run(fixture.input, { jobId: "h3-cancel", signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(running).rejects.toMatchObject({ code: "cancelled" });
    expect(observedSignal).toBe(controller.signal);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});
