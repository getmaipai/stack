import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { denoiseArgs, editInputProblem, flipArgs, fpsBoostArgs, freezeArgs, kenBurnsArgs, loopArgs, pipArgs, reverseArgs, reverseDurationProblem, rotateArgs, sharpenArgs, speedRampArgs, type Clip } from "@/media/editOps";
import { normalizeProbe, probeFile } from "@/media/probe";
import { spawnRunner } from "@/media/run";

const makeClip = (path = "/clip.mp4", duration = 3, width = 640, height = 360, audio = true): Clip => ({ path, probe: normalizeProbe({ format: { format_name: "mp4", duration: String(duration) }, streams: [{ index: 0, codec_type: "video", codec_name: "h264", width, height, pix_fmt: "yuv420p", avg_frame_rate: "24/1" }, ...(audio ? [{ index: 1, codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000" }] : [])] }, path, 1) });
const base = { inputs: ["/clip.mp4", "/other.mp4"], output: { name: "out.mp4" } };
const ffmpeg = process.env.STACK_MEDIA_FFMPEG && existsSync(process.env.STACK_MEDIA_FFMPEG) ? process.env.STACK_MEDIA_FFMPEG : null;
const ffprobe = process.env.STACK_MEDIA_FFPROBE && existsSync(process.env.STACK_MEDIA_FFPROBE) ? process.env.STACK_MEDIA_FFPROBE : null;

describe("media.edit batch 3 plans and validation", () => {
  const c = makeClip();
  test("builders cover all batch 3 filters", () => {
    expect(speedRampArgs("ffmpeg", c, "/o.mp4", { op: "speed_ramp", from_factor: 1, to_factor: 2, at_s: 0.5, over_s: 1 }).join(" ")).toContain("atempo=2");
    expect(reverseArgs("ffmpeg", c, "/o.mp4").join(" ")).toContain("areverse");
    expect(freezeArgs("ffmpeg", c, "/o.mp4", { op: "freeze", at_s: 1, hold_s: 2 }).join(" ")).toContain("loop=loop=");
    expect(loopArgs("ffmpeg", c, "/o.mp4", 3).join(" ")).toContain("concat=n=3");
    expect(kenBurnsArgs("ffmpeg", c, "/o.mp4", { op: "kenburns", zoom_from: 1, zoom_to: 1.5, pan: "left", duration_s: 2 }).join(" ")).toContain("zoompan=");
    expect(fpsBoostArgs("ffmpeg", c, "/o.mp4", 48).join(" ")).toContain("minterpolate=fps=48:mi_mode=mci:mc_mode=aobmc:vsbmc=1");
    expect(flipArgs("ffmpeg", c, "/o.mp4", "horizontal").join(" ")).toContain("hflip");
    expect(rotateArgs("ffmpeg", c, "/o.mp4", 90).join(" ")).toContain("transpose=1");
    expect(sharpenArgs("ffmpeg", c, "/o.mp4", 0.5).join(" ")).toContain("unsharp=");
    expect(denoiseArgs("ffmpeg", c, "/o.mp4", 0.5).join(" ")).toContain("hqdn3d=");
    expect(pipArgs("ffmpeg", c, makeClip("/other.mp4"), "/o.mp4", { op: "pip", input: 1, corner: "bottom_right", size: 0.25, margin: 0.05 }).join(" ")).toContain("overlay=W-w-W*0.05:H-h-H*0.05");
  });
  test("schema limits and cross-field checks explain invalid choices", () => {
    const bad = (op: unknown) => editInputProblem({ ...base, ops: [op] });
    expect(bad({ op: "speed_ramp", from_factor: 5, to_factor: 2, at_s: 0, over_s: 1 })).toMatch(/from_factor/);
    expect(bad({ op: "freeze", at_s: 1, hold_s: 8 })).toMatch(/hold_s/);
    expect(bad({ op: "loop", times: 7 })).toMatch(/times/);
    expect(bad({ op: "fps_boost", fps: 50 })).toMatch(/fps/);
    expect(bad({ op: "flip", direction: "diagonal" })).toMatch(/horizontal.*vertical/);
    expect(bad({ op: "rotate", degrees: 45 })).toMatch(/degrees/);
    expect(bad({ op: "sharpen", amount: 2 })).toMatch(/amount/);
    expect(bad({ op: "denoise", amount: -1 })).toMatch(/amount/);
    expect(bad({ op: "pip", input: 1, corner: "center", size: 0.2, margin: 0 })).toMatch(/top_left.*top_right.*bottom_left.*bottom_right/);
    expect(editInputProblem({ inputs: ["/clip.mp4"], output: base.output, ops: [{ op: "pip", input: 1, corner: "top_left", size: 0.2, margin: 0 }] })).toMatch(/second file/);
    expect(editInputProblem({ ...base, ops: [{ op: "reverse" }] })).toBeNull();
    expect(editInputProblem({ ...base, ops: [{ op: "loop", times: 3 }] })).toBeNull();
    expect(editInputProblem({ ...base, ops: [{ op: "kenburns", zoom_from: 1, zoom_to: 2, pan: "none" }] })).toBeNull();
  });
  test("reverse duration and speed ramp interval limits have plain explanations", () => {
    expect(reverseDurationProblem(61)).toMatch(/60 seconds.*Trim/);
    expect(reverseDurationProblem(60)).toBeNull();
    expect(editInputProblem({ ...base, ops: [{ op: "speed_ramp", from_factor: 1, to_factor: 2, at_s: 0, over_s: 0.2 }] })).toMatch(/over_s/);
  });
});

const real = ffmpeg && ffprobe ? test : test.skip;
real("real ffmpeg batch 3 effects preserve their expected media", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "media-edit-batch3-")));
  try {
    const source = join(dir, "in.mp4");
    const made = await spawnRunner([ffmpeg!, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source]);
    expect(made.code).toBe(0);
    const signal = new AbortController().signal; const original = await probeFile(spawnRunner, ffprobe!, source, signal); const clip = { path: source, probe: original };
    const check = async (name: string, args: string[]) => { const out = join(dir, name); const result = await spawnRunner(args); expect(result.code, `${name}: ${result.stderr}`).toBe(0); return { path: out, probe: await probeFile(spawnRunner, ffprobe!, out, signal) }; };
    const ramp = await check("ramp.mp4", speedRampArgs(ffmpeg!, clip, join(dir, "ramp.mp4"), { op: "speed_ramp", from_factor: 1, to_factor: 2, at_s: 0.5, over_s: 1 }));
    expect(ramp.probe.duration_s!).toBeLessThan(2.2); expect(ramp.probe.duration_s!).toBeGreaterThan(1.7); expect(Math.abs(ramp.probe.duration_s! - (0.5 + Math.log(2) + 1.5 / 2))).toBeLessThan(0.2); expect(ramp.probe.has_audio).toBe(true);
    const streamInfo = await spawnRunner([ffprobe!, "-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", ramp.path], { collectStdout: true });
    const streamDurations = (JSON.parse(streamInfo.stdout) as { streams: Array<{ codec_type: string; duration?: string }> }).streams;
    const audioDuration = Number(streamDurations.find(s => s.codec_type === "audio")?.duration); expect(Math.abs(audioDuration - ramp.probe.duration_s!)).toBeLessThan(0.15);
    const reversed = await check("reverse.mp4", reverseArgs(ffmpeg!, clip, join(dir, "reverse.mp4"))); expect(Math.abs(reversed.probe.duration_s! - 3)).toBeLessThan(0.2);
    const frameHash = async (path: string, select: string) => { const result = await spawnRunner([ffmpeg!, "-hide_banner", "-loglevel", "error", "-i", path, "-map", "0:v:0", "-an", "-vf", `select='${select}'`, "-frames:v", "1", "-f", "framemd5", "-"], { collectStdout: true }); expect(result.code).toBe(0); return result.stdout.trim().split("\n").filter(line => line && !line.startsWith("#")).at(-1)?.split(",").at(-1)?.trim(); };
    expect(await frameHash(reversed.path, "eq(n\\,0)")).toBe(await frameHash(source, "eq(n\\,71)"));
    const frozen = await check("freeze.mp4", freezeArgs(ffmpeg!, clip, join(dir, "freeze.mp4"), { op: "freeze", at_s: 1, hold_s: 1 })); expect(Math.abs(frozen.probe.duration_s! - 4)).toBeLessThan(0.2);
    const repeated = await check("loop.mp4", loopArgs(ffmpeg!, clip, join(dir, "loop.mp4"), 3, 0)); expect(Math.abs(repeated.probe.duration_s! - 9)).toBeLessThan(0.2);
    const seamed = await check("loopseam.mp4", loopArgs(ffmpeg!, clip, join(dir, "loopseam.mp4"), 3)); expect(Math.abs(seamed.probe.duration_s! - 7.5)).toBeLessThan(0.2);
    const png = join(dir, "still.png"); expect((await spawnRunner([ffmpeg!, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=red:s=320x180", "-frames:v", "1", png])).code).toBe(0);
    const still = await probeFile(spawnRunner, ffprobe!, png, signal); const kb = await check("kenburns.mp4", kenBurnsArgs(ffmpeg!, { path: png, probe: still }, join(dir, "kenburns.mp4"), { op: "kenburns", zoom_from: 1, zoom_to: 1.2, pan: "none", duration_s: 2 }, true)); expect(kb.probe.width).toBe(1280); expect(kb.probe.height).toBe(720); expect(Math.abs(kb.probe.duration_s! - 2)).toBeLessThan(0.2);
    const boosted = await check("fps.mp4", fpsBoostArgs(ffmpeg!, clip, join(dir, "fps.mp4"), 48)); expect(boosted.probe.streams.find(s => s.type === "video")?.fps).toBe(48);
    const flipped = await check("flip.mp4", flipArgs(ffmpeg!, clip, join(dir, "flip.mp4"), "horizontal")); expect(flipped.probe.width).toBe(640); expect(flipped.probe.height).toBe(360);
    const rotated = await check("rotate.mp4", rotateArgs(ffmpeg!, clip, join(dir, "rotate.mp4"), 90)); expect(rotated.probe.width).toBe(360); expect(rotated.probe.height).toBe(640);
    for (const [name,args] of [["sharp.mp4",sharpenArgs(ffmpeg!,clip,join(dir,"sharp.mp4"),0.5)],["denoise.mp4",denoiseArgs(ffmpeg!,clip,join(dir,"denoise.mp4"),0.5)],["pip.mp4",pipArgs(ffmpeg!,clip,clip,join(dir,"pip.mp4"),{op:"pip",input:1,corner:"bottom_right",size:0.25,margin:0.05})]] as const) { const out=await check(name,args); expect(out.probe.width).toBe(640); expect(out.probe.height).toBe(360); expect(Math.abs(out.probe.duration_s!-3)).toBeLessThan(0.2); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 180_000);
