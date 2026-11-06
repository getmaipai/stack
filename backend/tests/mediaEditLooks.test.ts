import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editInputProblem, FILM_LOOK_PRESETS, filmLookArgs, LETTERBOX_RATIOS, letterboxArgs, type Clip } from "@/media/editOps";
import { normalizeProbe } from "@/media/probe";
import { probeFile } from "@/media/probe";
import { spawnRunner } from "@/media/run";

const makeClip = (width = 1280, height = 720, audio = true, path = "/clip.mp4"): Clip => ({ path, probe: normalizeProbe({ format: { format_name: "mp4", duration: "2" }, streams: [{ index: 0, codec_type: "video", codec_name: "h264", width, height, pix_fmt: "yuv420p", avg_frame_rate: "24/1" }, ...(audio ? [{ index: 1, codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000" }] : [])] }, path, 1) });
const base = { inputs: ["/clip.mp4"], output: { name: "out.mp4" } };
const findTool = (name: string) => { const configured = process.env[name === "ffmpeg" ? "STACK_MEDIA_FFMPEG" : "STACK_MEDIA_FFPROBE"]; if (configured && existsSync(configured)) return configured; return [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`].find(existsSync) ?? null; };

describe("media.edit film looks and letterbox", () => {
  test("each look is a fixed video graph and copies audio", () => {
    for (const preset of FILM_LOOK_PRESETS) {
      const args = filmLookArgs("ffmpeg", makeClip(), "/o.mp4", { op: "film_look", preset, strength: 0.5 });
      const line = args.join(" ");
      expect(line).toContain("-filter_complex"); expect(line).toContain("A*(1-0.5)+B*0.5"); expect(line).toContain("-c:a copy");
      if (preset === "noir") expect(line).toContain("hue=s=0");
      if (preset === "70s_color") expect(line).toContain("gblur=sigma=12");
    }
    const mute = filmLookArgs("ffmpeg", makeClip(1280, 720, false), "/o.mp4", { op: "film_look", preset: "noir", strength: 1 });
    expect(mute).not.toContain("-c:a");
  });
  test("each ratio crops and pads without changing frame size or sound", () => {
    for (const ratio of LETTERBOX_RATIOS) {
      const args = letterboxArgs("ffmpeg", makeClip(), "/o.mp4", { op: "letterbox", ratio });
      const line = args.join(" ");
      expect(line).toContain("crop="); expect(line).toContain("pad=1280:720"); expect(line).toContain("-c:a copy");
    }
    expect(letterboxArgs("ffmpeg", makeClip(), "/o.mp4", { op: "letterbox", ratio: "1.33:1" }).join(" ")).toContain("crop=956:720");
    expect(() => letterboxArgs("ffmpeg", makeClip(), "/o.mp4", { op: "letterbox", ratio: "2.39:1" })).not.toThrow();
    expect(() => letterboxArgs("ffmpeg", makeClip(1920, 800), "/o.mp4", { op: "letterbox", ratio: "2.39:1" })).toThrow(/already/);
  });
  test("preset and ratio errors list the choices and strength is bounded", () => {
    expect(editInputProblem({ ...base, ops: [{ op: "film_look", preset: "sepia" }] })).toMatch(/70s_color.*cool_thriller/);
    expect(editInputProblem({ ...base, ops: [{ op: "letterbox", ratio: "4:3" }] })).toMatch(/2.39:1.*1.33:1/);
    expect(editInputProblem({ ...base, ops: [{ op: "film_look", preset: "noir", strength: 0.1 }] })).toMatch(/strength/);
    expect(editInputProblem({ ...base, ops: [{ op: "film_look", preset: "noir", strength: 1.1 }] })).toMatch(/strength/);
  });
});

const ffmpeg = findTool("ffmpeg"); const ffprobe = findTool("ffprobe");
const real = ffmpeg && ffprobe ? test : test.skip;
real("real ffmpeg film looks and letterbox preserve dimensions, duration and audio", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "media-edit-looks-")));
  try {
    const source = join(dir, "in.mp4");
    const made = await spawnRunner([ffmpeg!, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source]);
    expect(made.code).toBe(0);
    const signal = new AbortController().signal; const original = await probeFile(spawnRunner, ffprobe!, source, signal);
    for (const preset of FILM_LOOK_PRESETS) {
      const out = join(dir, `${preset}.mp4`);
      const result = await spawnRunner(filmLookArgs(ffmpeg!, { path: source, probe: original }, out, { op: "film_look", preset, strength: 1 }));
      expect(result.code).toBe(0);
      const info = await probeFile(spawnRunner, ffprobe!, out, signal);
      expect(info.width).toBe(1280); expect(info.height).toBe(720); expect(Math.abs((info.duration_s ?? 0) - 2)).toBeLessThan(0.2); expect(info.has_audio).toBe(true);
    }
    // Measured, not assumed: saturation of the frame (SATAVG) on a colourful test clip. Noir must be black and white, the other looks must change the picture.
    const sat = async (path: string): Promise<number> => {
      const r = await spawnRunner([ffmpeg!, "-hide_banner", "-loglevel", "error", "-i", path, "-vf", "signalstats,metadata=print:file=-", "-frames:v", "1", "-f", "null", "-"], { collectStdout: true });
      expect(r.code).toBe(0); return Number(r.stdout.match(/lavfi\.signalstats\.SATAVG=([\d.]+)/)?.[1]);
    };
    const srcSat = await sat(source);
    expect(await sat(join(dir, "noir.mp4"))).toBeLessThan(2);
    expect(Math.abs((await sat(join(dir, "70s_color.mp4"))) - srcSat)).toBeGreaterThan(1);
    expect(Math.abs((await sat(join(dir, "bleach_bypass.mp4"))) - srcSat)).toBeGreaterThan(1);
    expect(Math.abs((await sat(join(dir, "technicolor.mp4"))) - srcSat)).toBeGreaterThan(1);
    // Strength 0.5 sits between no change and the full look.
    const half = join(dir, "noir-half.mp4");
    expect((await spawnRunner(filmLookArgs(ffmpeg!, { path: source, probe: original }, half, { op: "film_look", preset: "noir", strength: 0.5 }))).code).toBe(0);
    const halfSat = await sat(half);
    expect(halfSat).toBeGreaterThan(2); expect(halfSat).toBeLessThan(srcSat);
    const bars = join(dir, "bars.mp4");
    const boxed = await spawnRunner(letterboxArgs(ffmpeg!, { path: source, probe: original }, bars, { op: "letterbox", ratio: "2.39:1" }));
    expect(boxed.code).toBe(0);
    const boxedProbe = await probeFile(spawnRunner, ffprobe!, bars, signal);
    expect(boxedProbe.width).toBe(1280); expect(boxedProbe.height).toBe(720);
    const top = await spawnRunner([ffmpeg!, "-hide_banner", "-loglevel", "error", "-i", bars, "-vf", "crop=iw:ih/10:0:0,signalstats,metadata=print:file=-", "-frames:v", "1", "-f", "null", "-"], { collectStdout: true });
    const yavg = Number(top.stdout.match(/lavfi\.signalstats\.YAVG=([\d.]+)/)?.[1]);
    expect(top.code).toBe(0); expect(yavg).toBeLessThanOrEqual(16);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 180_000);
