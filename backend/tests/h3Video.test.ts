import { expect, test } from "bun:test";
import { H3_VIDEO_CAPABILITIES, H3_VIDEO_ID, finishH3Clip, h3VideoCommand } from "@/video/h3";
import { qualityOfModelName, VIDEO_SPECS } from "@/video/videoGen";
import { TIER_CANDIDATES } from "@/lib/tiers";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VideoGenService, type VideoGenDeps, type VideoRunInput } from "@/video/videoGen";

test("MiniMax H3 has explicit CLI capabilities and a stable video identity", () => {
  expect(H3_VIDEO_ID).toBe("minimax-h3");
  expect(H3_VIDEO_CAPABILITIES).toEqual({ first_picture: false, last_picture: false, reference_pictures: false, extend: false, audio: true, lora: true });
  expect(qualityOfModelName("minimax-h3")).toBe("h3");
  expect(VIDEO_SPECS.h3.audio).toBe(true);
});

test("the fake-runner argv carries the prompt, paths, preset and measured clip settings", () => {
  const argv = h3VideoCommand("python", "generate_staged.py", { prompt: "A bright kitchen", build: "boost-8bit", checkpoint: "models/upstream/FL2VA", transformer: "models/transformers/8-bit", qwenDir: "models/qwen/8-bit", output: "out.mp4", seconds: 5, width: 864, height: 480, seed: 7, steps: 25, lora: "models/turbo.safetensors" });
  expect(argv).toEqual(["python", "generate_staged.py", "A bright kitchen", "--checkpoint", "models/upstream/FL2VA", "--transformer", "models/transformers/8-bit", "--qwen-dir", "models/qwen/8-bit", "--qwen-stages", "2", "--lora", "models/turbo.safetensors", "--steps", "25", "--duration", "5", "--width", "864", "--height", "480", "--seed", "7", "--output", "out.mp4"]);
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

test("H3 without the optional adapter uses twelve steps", async () => {
  let command: string[] = [];
  const fixture = h3Fixture(async (argv) => { if (!argv.includes("-frames:v")) command = argv; writeFileSync(argv.at(-1)!, argv.includes("-frames:v") ? "JPEG" : "MP4"); return { code: 0, stdout: "", stderr: "", aborted: false }; });
  rmSync(join(fixture.root, "models/minimax_h3/loras/minimax_h3_turbo_v4_step600_ema.safetensors"));
  try {
    await fixture.service.run(fixture.input, { jobId: "h3-no-lora" });
    expect(command.slice(command.indexOf("--steps") + 1, command.indexOf("--steps") + 2)).toEqual(["12"]);
    expect(command).not.toContain("--lora");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
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
