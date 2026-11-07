// LTXD-E1: night film look, Sharpen+ (amount up to 1.5), denoise deblock flag, ripple op, and metadata kept.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { denoiseArgs, EDIT_OPS, editInputProblem, filmLookArgs, FILM_LOOK_PRESETS, rippleArgs, sharpenArgs, type Clip } from "@/media/editOps";
import { normalizeProbe, probeFile } from "@/media/probe";
import { spawnRunner } from "@/media/run";

const makeClip = (path = "/clip.mp4", audio = true): Clip => ({ path, probe: normalizeProbe({ format: { format_name: "mp4", duration: "3" }, streams: [{ index: 0, codec_type: "video", codec_name: "h264", width: 640, height: 360, pix_fmt: "yuv420p", avg_frame_rate: "24/1" }, ...(audio ? [{ index: 1, codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 }] : [])] }, path, 1) });
const base = { inputs: ["/clip.mp4"], output: { name: "out.mp4" } };
const bad = (op: unknown) => editInputProblem({ ...base, ops: [op] });
const ffmpeg = process.env.STACK_MEDIA_FFMPEG && existsSync(process.env.STACK_MEDIA_FFMPEG) ? process.env.STACK_MEDIA_FFMPEG : null;
const ffprobe = process.env.STACK_MEDIA_FFPROBE && existsSync(process.env.STACK_MEDIA_FFPROBE) ? process.env.STACK_MEDIA_FFPROBE : null;

describe("LTXD-E1 plans", () => {
  const c = makeClip();
  test("night is the 8th film look and the seven before it are unchanged", () => {
    expect(FILM_LOOK_PRESETS.length).toBe(8);
    expect(FILM_LOOK_PRESETS.slice(0, 7)).toEqual(["70s_color", "noir", "teal_orange", "bleach_bypass", "technicolor", "faded_vintage", "cool_thriller"]);
    expect(FILM_LOOK_PRESETS[7]).toBe("night");
    expect(editInputProblem({ ...base, ops: [{ op: "film_look", preset: "night" }] })).toBeNull();
    expect(bad({ op: "film_look", preset: "dusk" })).toMatch(/night/);
    expect(filmLookArgs("ffmpeg", c, "/o.mp4", { op: "film_look", preset: "night", strength: 1 }).join(" ")).toContain("colorbalance");
  });
  test("sharpen takes amount up to 1.5 and 1.5 is stronger than 1", () => {
    expect(bad({ op: "sharpen", amount: 1 })).toBeNull();
    expect(bad({ op: "sharpen", amount: 1.5 })).toBeNull();
    expect(bad({ op: "sharpen", amount: 1.6 })).toMatch(/amount/);
    expect(bad({ op: "sharpen", amount: 2 })).toMatch(/amount/);
    expect(sharpenArgs("ffmpeg", c, "/o.mp4", 1).join(" ")).toContain("unsharp=5:5:2:5:5:0");
    expect(sharpenArgs("ffmpeg", c, "/o.mp4", 1.5).join(" ")).toContain("unsharp=5:5:3:5:5:0");
  });
  test("denoise deblock is optional, boolean and runs before hqdn3d", () => {
    expect(bad({ op: "denoise", amount: 0.5 })).toBeNull();
    expect(bad({ op: "denoise", amount: 0.5, deblock: true })).toBeNull();
    expect(bad({ op: "denoise", amount: 0.5, deblock: "yes" })).toMatch(/deblock/);
    const plain = denoiseArgs("ffmpeg", c, "/o.mp4", 0.5).join(" ");
    expect(plain).not.toContain("deblock");
    const vf = denoiseArgs("ffmpeg", c, "/o.mp4", 0.5, true).join(" ");
    expect(vf).toContain("deblock=");
    expect(vf.indexOf("deblock")).toBeLessThan(vf.indexOf("hqdn3d"));
  });
  test("ripple is in EDIT_OPS, amount scaled, audio copied", () => {
    expect(EDIT_OPS).toContain("ripple");
    expect(bad({ op: "ripple", amount: 0.5 })).toBeNull();
    expect(bad({ op: "ripple", amount: 2 })).toMatch(/amount/);
    const low = rippleArgs("ffmpeg", c, "/o.mp4", 0.2).join(" ");
    const high = rippleArgs("ffmpeg", c, "/o.mp4", 1).join(" ");
    expect(low).toContain("geq=");
    expect(low).not.toBe(high);
    expect(high).toContain("-c:a copy");
    expect(rippleArgs("ffmpeg", makeClip("/c.mp4", false), "/o.mp4", 1).join(" ")).not.toContain("-c:a");
  });
  test("every edit keeps the source container metadata", () => {
    for (const args of [sharpenArgs("ffmpeg", c, "/o.mp4", 1), denoiseArgs("ffmpeg", c, "/o.mp4", 1, true), rippleArgs("ffmpeg", c, "/o.mp4", 1), filmLookArgs("ffmpeg", c, "/o.mp4", { op: "film_look", preset: "night", strength: 1 })]) {
      const at = args.indexOf("-map_metadata"); expect(at).toBeGreaterThan(-1); expect(args[at + 1]).toBe("0");
    }
  });
});

describe.skipIf(!ffmpeg || !ffprobe)("LTXD-E1 real ffmpeg", () => {
  test("each new look runs, keeps size and audio, and keeps the comment tag", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ltxd-e1-"));
    try {
      const source = join(dir, "in.mp4");
      const made = await spawnRunner([ffmpeg!, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest", "-metadata", "comment=ai-generated-test", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source]);
      expect(made.code).toBe(0);
      const signal = new AbortController().signal; const clip = { path: source, probe: await probeFile(spawnRunner, ffprobe!, source, signal) };
      const cases: Array<[string, string[]]> = [
        ["night.mp4", filmLookArgs(ffmpeg!, clip, join(dir, "night.mp4"), { op: "film_look", preset: "night", strength: 1 })],
        ["sharp.mp4", sharpenArgs(ffmpeg!, clip, join(dir, "sharp.mp4"), 1.5)],
        ["deblock.mp4", denoiseArgs(ffmpeg!, clip, join(dir, "deblock.mp4"), 0.5, true)],
        ["ripple.mp4", rippleArgs(ffmpeg!, clip, join(dir, "ripple.mp4"), 0.6)],
      ];
      for (const [name, args] of cases) {
        const run = await spawnRunner(args); expect(run.code, `${name}: ${run.stderr}`).toBe(0);
        const out = await probeFile(spawnRunner, ffprobe!, join(dir, name), signal);
        expect(out.width).toBe(640); expect(out.height).toBe(360); expect(out.has_audio).toBe(true);
        const tags = await spawnRunner([ffprobe!, "-v", "error", "-show_entries", "format_tags=comment", "-of", "default=nw=1:nk=1", join(dir, name)], { collectStdout: true });
        expect(tags.stdout.trim(), name).toBe("ai-generated-test");
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120_000);
});
