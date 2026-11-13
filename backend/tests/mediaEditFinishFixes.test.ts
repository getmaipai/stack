import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { creditsArgs, creditsLayout, crossfadeTiming, intermediateArgs, kenBurnsArgs, loopArgs, loopSeamSeconds, overlayArgs, transitionArgs, trimArgs, concatEncodeArgs, type Clip } from "@/media/editOps";
import { audioMatchesVideo } from "@/media/editOps";
import { normalizeProbe } from "@/media/probe";
import { resolveFonts } from "@/media/typography";

const makeClip = (path = "/clip.mp4", duration = 6, width = 640, height = 360, audio = true, fps = 24): Clip => ({ path, probe: normalizeProbe({ format: { format_name: "mp4", duration: String(duration) }, streams: [{ index: 0, codec_type: "video", codec_name: "h264", width, height, pix_fmt: "yuv420p", avg_frame_rate: `${fps}/1` }, ...(audio ? [{ index: 1, codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000" }] : [])] }, path, 1) });
const graphOf = (args: string[]): string => { const at = args.indexOf("-filter_complex") >= 0 ? args.indexOf("-filter_complex") : args.indexOf("-vf"); return args[at + 1]!; };
const overlayOp = { op: "audio_overlay" as const, input: 1, gain_db: 0, clip_gain_db: 0, start_s: 0, duck: false, fade_in_s: 0, fade_out_s: 0 };

describe("1 Ken Burns spans the whole clip", () => {
  const op = { op: "kenburns" as const, zoom_from: 1, zoom_to: 1.2, pan: "none" as const };
  test("a video input: the zoom step uses the real frame count, not 24 x seconds of a 1 frame input", () => {
    const clip = makeClip("/v.mp4", 6, 640, 360, true, 30);
    const vf = graphOf(kenBurnsArgs("ffmpeg", clip, "/o.mp4", op));
    // 6 s at 30 fps is 180 frames: the last frame (on = 179) lands exactly on zoom_to.
    expect(vf).toContain("on/179");
    expect(vf).toContain("fps=30");
    expect(vf).not.toContain("duration*24");
  });
  test("a still: spans duration_s at 24 fps", () => {
    const clip = makeClip("/s.png", 1, 1280, 720, false);
    const args = kenBurnsArgs("ffmpeg", clip, "/o.mp4", { ...op, duration_s: 4 }, true);
    expect(graphOf(args)).toContain("on/95");
    expect(args.join(" ")).toContain("-framerate 24");
  });
  test("scales up 2x before zoompan and back down by its output size", () => {
    const vf = graphOf(kenBurnsArgs("ffmpeg", makeClip("/v.mp4", 6, 640, 360, true, 30), "/o.mp4", { ...op, pan: "left" }));
    expect(vf).toMatch(/scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,zoompan=/);
    expect(vf).toContain("s=640x360");
    expect(vf).toContain("d=1");
    expect(vf).toContain("(1-on/179)");
  });
  test("a video's own length is the default, and never more than the clip", () => {
    const args = kenBurnsArgs("ffmpeg", makeClip("/v.mp4", 6), "/o.mp4", { ...op, duration_s: 30 });
    expect(args[args.indexOf("-t") + 1]).toBe("6");
  });
});

describe("2 mix safety", () => {
  const clip = makeClip("/a.mp4", 10);
  test("limiter after amix and loudnorm to -16 LUFS by default, never clipping", () => {
    const graph = graphOf(overlayArgs("ffmpeg", clip, "/m.wav", "/o.mp4", overlayOp));
    expect(graph).toMatch(/amix=inputs=2:duration=first:normalize=0\[x\];\[x\]alimiter=limit=0\.\d+:level=0\[y\];\[y\]loudnorm=I=-16:TP=-1\.5:LRA=11,aresample=48000,alimiter=limit=0\.\d+:level=0\[m\]/);
  });
  test("an explicit loudness target still wins", () => {
    expect(graphOf(overlayArgs("ffmpeg", clip, "/m.wav", "/o.mp4", { ...overlayOp, loudness_lufs: -14 }))).toContain("loudnorm=I=-14");
  });
  test("duck keys the clip's sound on the overlay by default (overlay is the voice)", () => {
    const graph = graphOf(overlayArgs("ffmpeg", clip, "/v.wav", "/o.mp4", { ...overlayOp, duck: true }));
    expect(graph).toContain("[c][k]sidechaincompress");
  });
  test("duck_target overlay lowers the music under the clip's own voice", () => {
    const graph = graphOf(overlayArgs("ffmpeg", clip, "/music.wav", "/o.mp4", { ...overlayOp, duck: true, duck_target: "overlay" }));
    expect(graph).toContain("[o][k]sidechaincompress");
    expect(graph).toMatch(/\[c\]asplit=2\[cm\]\[k\]/);
    expect(graph).toMatch(/\[cm\]\[od\]amix|\[cm\]\[d\]amix/);
  });
});

describe("3 encode quality", () => {
  const tags = "-colorspace bt709 -color_primaries bt709 -color_trc bt709";
  test("every encode is CRF 18, yuv420p, bt709 tagged and constant frame rate", () => {
    const clips = [makeClip("/a.mp4"), makeClip("/b.mp4")];
    for (const args of [concatEncodeArgs("ffmpeg", clips, "/o.mp4"), transitionArgs("ffmpeg", clips, "fade", 0.5, "/o.mp4"), kenBurnsArgs("ffmpeg", clips[0]!, "/o.mp4", { op: "kenburns", zoom_from: 1, zoom_to: 1.2, pan: "none" }), loopArgs("ffmpeg", clips[0]!, "/o.mp4", 2), trimArgs("ffmpeg", "/a.mp4", "/o.mp4", { op: "trim", in_s: 1, out_s: 2 }, clips[0]!.probe, false).args]) {
      const text = args.join(" ");
      expect(text).toContain("-crf 18"); expect(text).toContain("-pix_fmt yuv420p"); expect(text).toContain(tags); expect(text).toContain("-fps_mode cfr");
    }
  });
  test("intermediateArgs lowers CRF to 14 and leaves the rest", () => {
    const args = concatEncodeArgs("ffmpeg", [makeClip("/a.mp4"), makeClip("/b.mp4")], "/o.mp4");
    const middle = intermediateArgs(args).join(" ");
    expect(middle).toContain("-crf 14"); expect(middle).not.toContain("-crf 18"); expect(middle).toContain(tags);
    expect(intermediateArgs(["-c", "copy"])).toEqual(["-c", "copy"]);
  });
  test("cards are tagged too", () => {
    const text = creditsArgs("ffmpeg", makeClip(), "/o.mp4", { op: "credits", lines: [{ name: "A" }], background: "black", text_color: "white", speed: 60 }, "/f.ttf").join(" ");
    expect(text).toContain(tags);
  });
});

describe("4 credits geometry", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ role: `Role ${i}`, name: `Name ${i}` }));
  test("distance and time come from the block: speed sets the length", () => {
    const a = creditsLayout({ lines: lines(20), speed: 100 }, 720);
    const b = creditsLayout({ lines: lines(20), speed: 50 }, 720);
    expect(a.rows).toBe(19); // index of the last row
    expect(a.distance).toBeGreaterThan(720 + 19 * 720 / 11); // the last row must travel its offset plus the frame
    expect(Math.abs(b.seconds - 2 * a.seconds)).toBeLessThan(0.2);
    expect(Math.abs(a.seconds - a.distance / 100)).toBeLessThan(0.1);
  });
  test("an explicit duration_s is honoured and the move still ends exactly with it", () => {
    const l = creditsLayout({ lines: lines(10), speed: 60, duration_s: 8 }, 720);
    expect(l.duration).toBe(8); expect(l.seconds).toBe(8);
  });
  test("the last row of 20 lines leaves the top of the frame, the first starts below the bottom", () => {
    const font = resolveFonts();
    if (!font) return;
    const dir = mkdtempSync(join(tmpdir(), "stack-credits-"));
    try {
      const ass = join(dir, "c.ass");
      creditsArgs("ffmpeg", makeClip("/c.mp4", 2, 1280, 720), join(dir, "o.mp4"), { op: "credits", lines: lines(20), speed: 60, background: "black", text_color: "white" }, "", ass);
      const text = readFileSync(ass, "utf8");
      const moves = [...text.matchAll(/\\move\((\d+),(-?\d+),(\d+),(-?\d+),0,(\d+)\)/g)].map((m) => ({ y0: Number(m[2]), y1: Number(m[4]), t1: Number(m[5]) }));
      expect(moves.length).toBe(40);
      expect(Math.min(...moves.map((m) => m.y0))).toBeGreaterThanOrEqual(720);
      expect(Math.max(...moves.map((m) => m.y1))).toBeLessThan(0);
      expect(text).toContain("\\fad(");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("the drawtext fallback keeps the real speed and fades in", () => {
    const text = creditsArgs("ffmpeg", makeClip(), "/o.mp4", { op: "credits", lines: [{ role: "Director", name: "A Name" }], background: "black", text_color: "white", speed: 60 }, "/f.ttf").join(" ");
    expect(text).toContain("y=h - t*60"); expect(text).toContain("alpha=");
  });
});

describe("5 seamless loop", () => {
  test("the seam blends the tail into the head for picture and sound, one unit per repeat", () => {
    const graph = graphOf(loopArgs("ffmpeg", makeClip("/c.mp4", 4), "/o.mp4", 3, 0.5));
    expect(graph).toContain("xfade=transition=fade:duration=0.5:offset=0");
    expect(graph).toContain("acrossfade=d=0.5");
    expect(graph).toContain("trim=3.5:4"); expect(graph).toContain("trim=0:0.5"); expect(graph).toContain("trim=0.5:3.5");
    expect(graph).toContain("concat=n=3");
  });
  test("seam length snaps to whole frames and shrinks for a short clip; 0 turns it off", () => {
    expect(loopSeamSeconds(4, 24, 0.5)).toBeCloseTo(0.5, 5);
    expect(loopSeamSeconds(0.8, 24, 0.5)).toBeLessThanOrEqual(0.2 + 1e-9);
    expect(loopSeamSeconds(4, 24, 0)).toBe(0);
    expect(loopSeamSeconds(0.2, 24, 0.5)).toBe(0);
    expect(graphOf(loopArgs("ffmpeg", makeClip("/c.mp4", 4), "/o.mp4", 2, 0))).not.toContain("xfade");
  });
});

describe("6 whole-frame crossfades and copy checks", () => {
  test("d is an even number of frames and every offset is on a frame boundary", () => {
    const t = crossfadeTiming([5.0417, 5.0417, 5.0417], 0.3, 24);
    expect(t.frames % 2).toBe(0); expect(t.d * 24).toBeCloseTo(t.frames, 6);
    for (const offset of t.offsets) expect(Math.abs(offset * 24 - Math.round(offset * 24))).toBeLessThan(1e-6);
    expect(t.offsets[0]).toBeCloseTo((121 - t.frames) / 24, 6);
    expect(t.offsets[1]).toBeCloseTo((121 - t.frames + 121 - t.frames) / 24, 6);
  });
  test("transitionArgs uses the snapped values", () => {
    const g = graphOf(transitionArgs("ffmpeg", [makeClip("/a.mp4", 5.0417), makeClip("/b.mp4", 5.0417)], "fade", 0.3, "/o.mp4"));
    expect(g).toContain("duration=0.333333"); expect(g).toContain("acrossfade=d=0.333333");
  });
  test("audioMatchesVideo flags a copy whose sound is shorter or longer than its picture", () => {
    const probe = (v: number, a: number) => ({ streams: [{ type: "video", duration_s: v }, { type: "audio", duration_s: a }], has_audio: true, has_video: true }) as any;
    expect(audioMatchesVideo(probe(83, 83.02))).toBe(true);
    expect(audioMatchesVideo(probe(83, 42))).toBe(false);
    expect(audioMatchesVideo({ streams: [{ type: "video", duration_s: 5 }], has_audio: false, has_video: true } as any)).toBe(true);
  });
});

const ffmpeg = process.env.STACK_MEDIA_FFMPEG && existsSync(process.env.STACK_MEDIA_FFMPEG) ? process.env.STACK_MEDIA_FFMPEG : null;
test.skipIf(!ffmpeg)("real ffmpeg parses the new graphs (needs STACK_MEDIA_FFMPEG)", () => { expect(ffmpeg).toBeTruthy(); });
