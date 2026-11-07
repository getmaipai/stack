import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { componentDefs } from "@/lib/components";
import { ENGINE_BINARIES, MANAGED_RUNTIMES } from "@/lib/engineCatalog";
import { STACK_VIDEO_MASK_MODEL, STACK_VIDEO_MASK_MODELS } from "@/lib/modelCatalog";
import { videoMaskInstallModels } from "@/lib/installPlan";
import { TIER_CANDIDATES } from "@/lib/tiers";
import { editInputProblem } from "@/media/editOps";
import { chooseCutoutSubject, cutoutClip, cutoutCompositeArgs, cutoutSubjectProblem, CUTOUT_FAILED, CUTOUT_MODEL_MISSING, CUTOUT_NO_MEMORY, CUTOUT_NO_SUBJECT } from "@/media/cutout";
import type { ProbeResult } from "@/media/probe";

describe("VIDEO-MASK-01 pins and declarations", () => {
  test("the optional mask component, plans, source archive and model share exact pins and measured sizing", () => {
    const component = componentDefs().find((row) => row.id === STACK_VIDEO_MASK_MODEL.id)!;
    const engine = ENGINE_BINARIES.find((row) => row.name === "mask-gen")!;
    expect(component).toMatchObject({ group: "video", role: "video", tiers: ["p64", "p128"], pins: [STACK_VIDEO_MASK_MODEL] });
    expect(component.usedBy()).toContain("Cutouts and background removal on clips");
    expect(engine).toMatchObject({ tag: "2b90b9f", archive: { url: "https://codeload.github.com/facebookresearch/sam2/tar.gz/2b90b9f5ceec907a1c18123530e92e794ad901a4", sha256: "1f2fbfad3ffa38110368abac76c6ef9df9c282a66d5c2807bc94abf4d2fb30f8", approxBytes: 55645345 } });
    expect(STACK_VIDEO_MASK_MODEL).toMatchObject({ revision: "ee5bba1d82bb8749febdf90f45e84b687142ba03", license: "Apache-2.0", download: { sha256: "6d1aa6f30de5c92224f8172114de081d104bbd23dd9dc5c58996f0cad5dc4d38", approx_bytes: 184416285, hub_file: "sam2.1_hiera_small.pt" }, measured: { footprintBytes: 4900000000 } });
    expect(videoMaskInstallModels()).toEqual([expect.objectContaining({ id: STACK_VIDEO_MASK_MODEL.id, engine: "mask-gen", approx_bytes: 184416285, starter: false })]);
    expect(STACK_VIDEO_MASK_MODELS).toHaveLength(1);
    expect(MANAGED_RUNTIMES.some((row) => row.name === "mask-gen")).toBe(true);
    expect(TIER_CANDIDATES.find((row) => row.id === STACK_VIDEO_MASK_MODEL.id)).toMatchObject({ category: "video", peaks: [{ peakBytes: 4900000000, status: "measured" }] });
  });
});

const ffmpeg = process.env.STACK_MEDIA_FFMPEG, ffprobe = process.env.STACK_MEDIA_FFPROBE;
const real = ffmpeg && ffprobe ? test : test.skip;
let temp: string | null = null;
afterEach(() => { if (temp) rmSync(temp, { recursive: true, force: true }); temp = null; });

describe("cutout compositing with real ffmpeg", () => {
  real("keeps the foreground, changes the background, retains audio and dimensions for each background", () => {
    temp = mkdtempSync(join(tmpdir(), "stack-cutout-"));
    const masks = join(temp, "masks"); mkdirSync(masks);
    const source = join(temp, "source.mp4");
    const sourceArgs = [ffmpeg!, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=2:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-vf", "drawbox=x=8:y=8:w=24:h=24:color=red:t=fill,drawbox=x=40:y=40:w=8:h=8:color=white:t=fill", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source];
    expect(Bun.spawnSync(sourceArgs).exitCode).toBe(0);
    for (const index of [0, 1]) expect(Bun.spawnSync([ffmpeg!, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x64", "-vf", "drawbox=x=8:y=8:w=24:h=24:color=white:t=fill", "-frames:v", "1", "-update", "1", join(masks, `${String(index).padStart(5, "0")}.png`)]).exitCode).toBe(0);
    const probe: ProbeResult = { has_video: true, has_audio: true, has_cover_art: false, duration_s: 1, width: 64, height: 64, video_codec: "h264", audio_codec: "aac", streams: [{ type: "video", codec: "h264", fps: 2, width: 64, height: 64, cover_art: false }, { type: "audio", codec: "aac" }] } as ProbeResult;
    const backgrounds = ["black", "white", "green", "#ff00ff", "blur", "transparent"];
    for (const background of backgrounds) {
      const output = join(temp, `out-${background === "#ff00ff" ? "hex" : background}.${background === "transparent" ? "webm" : "mp4"}`);
      const args = cutoutCompositeArgs({ ffmpeg: ffmpeg!, input: source, output, masksDir: masks, probe, background, featherPx: 0 });
      const made = Bun.spawnSync(args);
      expect(made.exitCode, made.stderr.toString()).toBe(0);
      const info = JSON.parse(Bun.spawnSync([ffprobe!, "-v", "error", "-show_streams", "-show_format", "-of", "json", output]).stdout.toString()) as { streams: Array<{ codec_type: string; width?: number; height?: number; codec_name: string; tags?: Record<string, string>; pix_fmt?: string }> };
      expect(info.streams.find((s) => s.codec_type === "video")).toMatchObject({ width: 64, height: 64 });
      expect(info.streams.some((s) => s.codec_type === "audio")).toBe(true);
      const pixel = (path: string, x: number, y: number, format = "rgb24") => Bun.spawnSync([ffmpeg!, "-hide_banner", "-loglevel", "error", "-i", path, "-vf", `crop=2:2:${x}:${y},format=${format}`, "-frames:v", "1", "-f", "rawvideo", "pipe:1"]).stdout;
      const kept = pixel(output, 16, 16), changed = pixel(output, 44, 44), original = pixel(source, 44, 44);
      expect(kept[0]).toBeGreaterThan(180); expect(kept[1]).toBeLessThan(100); expect(kept[2]).toBeLessThan(100);
      if (background === "transparent") {
        expect(info.streams.find((s) => s.codec_type === "video")?.tags?.alpha_mode).toBe("1");
      } else if (background === "black") expect([...changed.slice(0, 3)].every((value) => value < 20)).toBe(true);
      else if (background === "white") expect([...changed.slice(0, 3)].every((value) => value > 220)).toBe(true);
      else if (background === "green") expect(changed[1]).toBeGreaterThan(200);
      else if (background === "#ff00ff") { expect(changed[0]).toBeGreaterThan(200); expect(changed[2]).toBeGreaterThan(200); }
      else expect([...changed.slice(0, 3)].some((value, i) => Math.abs(value - original[i]!) > 8)).toBe(true);
    }
  });
});

describe("media.edit cutout contract", () => {
  const base = { inputs: ["/clip.mp4"], output: { name: "cutout.mp4" }, ops: [{ op: "cutout", background: "black" }] };
  test("accepts cutout options and rejects backgrounds, transparent extensions and frame bounds", () => {
    expect(editInputProblem(base)).toBeNull();
    expect(editInputProblem({ ...base, ops: [{ op: "cutout", background: "pink" }] })).toMatch(/background/);
    expect(editInputProblem({ ...base, output: { name: "cutout.mp4" }, ops: [{ op: "cutout", background: "transparent" }] })).toMatch(/transparent cutout/);
    expect(editInputProblem({ ...base, ops: [{ op: "cutout", background: "black", feather_px: 13 }] })).toMatch(/feather_px/);
    expect(cutoutSubjectProblem({ box: [-1, 0, 20, 20] }, 100, 100, 5)).toMatch(/box must fit/);
    expect(cutoutSubjectProblem({ point: { x: 100, y: 3 } }, 100, 100, 5)).toMatch(/point must be inside/);
    expect(cutoutSubjectProblem({ frame: 5 }, 100, 100, 5)).toMatch(/frame must be inside/);
    expect(cutoutSubjectProblem({ box: [0, 0, 100, 100] }, 100, 100, 5)).toBeNull();
    expect(chooseCutoutSubject([{ x: 0, y: 0, w: 1, h: 1, area: 0.9, kind: "object" }, { x: 0, y: 0, w: 1, h: 1, area: 0.2, kind: "person" }])?.kind).toBe("person");
    expect(chooseCutoutSubject([{ x: 0, y: 0, w: 1, h: 1, area: 0.2 }, { x: 0, y: 0, w: 1, h: 1, area: 0.9 }])?.area).toBe(0.9);
    expect(chooseCutoutSubject([])).toBeNull();
    expect(CUTOUT_NO_SUBJECT).toBe("I couldn't find a clear subject to cut out. Say what to keep, or pick a clip where it is easier to see.");
    expect(CUTOUT_MODEL_MISSING).toBe("The subject model is not installed yet. An admin can add it in Settings, Models and storage.");
    expect(CUTOUT_NO_MEMORY).toBe("Home is busy with something larger. Try again in a minute.");
    expect(CUTOUT_FAILED).toBe("Cutting out the subject stopped unexpectedly. Try again, or try a shorter clip.");
  });

  test("a clip over the cutout limit is refused before frame decoding or model access", async () => {
    temp = mkdtempSync(join(tmpdir(), "stack-cutout-limit-"));
    const source = join(temp, "source.mp4"), output = join(temp, "out.mp4"), work = join(temp, "work");
    writeFileSync(source, "synthetic only");
    let calls = 0;
    const run = async () => { calls++; throw new Error("must not decode"); };
    const probe = { has_video: true, has_audio: false, has_cover_art: false, duration_s: 61, width: 64, height: 64, video_codec: "h264", audio_codec: null, streams: [{ type: "video", codec: "h264", fps: 2, width: 64, height: 64, cover_art: false }] } as unknown as ProbeResult;
    await expect(cutoutClip({ run: run as never, ffmpeg: ffmpeg ?? "ffmpeg", input: source, output, work, probe, op: { background: "black", feather_px: 2 }, signal: new AbortController().signal, progress: () => {} })).rejects.toThrow(/limited to clips of 60 seconds/);
    expect(calls).toBe(0);
  });
});
