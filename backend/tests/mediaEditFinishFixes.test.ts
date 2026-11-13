import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { concatCopyArgs, creditsArgs, creditsLayout, crossfadeTiming, intermediateArgs, kenBurnsArgs, loopArgs, loopSeamSeconds, overlayArgs, transitionArgs, trimArgs, concatEncodeArgs, type Clip } from "@/media/editOps";
import { audioMatchesVideo } from "@/media/editOps";
import { normalizeProbe, probeFile } from "@/media/probe";
import { spawnRunner } from "@/media/run";
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
const ffprobe = process.env.STACK_MEDIA_FFPROBE && existsSync(process.env.STACK_MEDIA_FFPROBE) ? process.env.STACK_MEDIA_FFPROBE : null;
const real = ffmpeg && ffprobe ? describe : describe.skip;

real("real ffmpeg renders of the finishing fixes", () => {
  const dir = mkdtempSync(join(tmpdir(), "stack-finish-"));
  const ab = new AbortController();
  const run = async (args: string[]) => { const r = await spawnRunner(args, { collectStdout: true, env: { STACK_MEDIA_NO_NICE: "1" } }); if (r.code !== 0) throw new Error(`ffmpeg failed: ${r.stderr.slice(-600)}`); return r; };
  const gen = (name: string, ...args: string[]) => run([ffmpeg!, "-hide_banner", "-loglevel", "error", "-y", ...args, join(dir, name)]).then(() => join(dir, name));
  const probe = async (path: string): Promise<Clip> => ({ path, probe: await probeFile(spawnRunner, ffprobe!, path, ab.signal) });
  const streamInfo = async (path: string) => JSON.parse((await run([ffprobe!, "-v", "error", "-show_entries", "stream=codec_type,duration,color_space,color_primaries,color_transfer,pix_fmt,r_frame_rate,avg_frame_rate", "-of", "json", path])).stdout).streams as any[];
  const gray = async (path: string, at: number, w: number, h: number): Promise<Uint8Array> => { const raw = join(dir, `g${Math.random().toString(36).slice(2)}.raw`); await run([ffmpeg!, "-v", "error", "-y", "-ss", String(at), "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", raw]); const d = new Uint8Array(readFileSync(raw)); expect(d.length).toBe(w * h); return d; };
  const bbox = (d: Uint8Array, w: number, h: number, min = 200) => { let x0 = w, x1 = -1, y0 = h, y1 = -1; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[y * w + x]! > min) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } return { w: x1 - x0 + 1, h: y1 - y0 + 1, count: x1 < 0 ? 0 : 1 }; };
  const loud = async (path: string) => { const r = await run([ffmpeg!, "-hide_banner", "-nostats", "-i", path, "-vn", "-af", "ebur128=peak=sample+true:framelog=quiet,astats=metadata=0", "-f", "null", "-"]); const t = r.stderr; return { lufs: Number(/I:\s+(-?[\d.]+) LUFS/.exec(t.slice(t.lastIndexOf("Summary")))?.[1]), truePeak: Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(t.slice(t.lastIndexOf("True peak")))?.[1]), samplePeak: Number(/Peak level dB:\s+(-?[\d.]+)/.exec(t)?.[1]) }; };

  test("Ken Burns: a 1.0 to 1.5 push-in measures 1.0, 1.25, 1.5 on frames 0, middle and last", async () => {
    const src = await gen("kb-src.mp4", "-f", "lavfi", "-i", "color=black:s=640x360:r=30:d=2,drawbox=x=240:y=135:w=160:h=90:color=white:t=fill", "-c:v", "libx264", "-pix_fmt", "yuv420p");
    const out = join(dir, "kb.mp4");
    await run(kenBurnsArgs(ffmpeg!, await probe(src), out, { op: "kenburns", zoom_from: 1, zoom_to: 1.5, pan: "none" }));
    const info = await probe(out); const frames = Math.round(info.probe.duration_s! * 30);
    const widths = [];
    for (const n of [0, Math.floor(frames / 2), frames - 1]) widths.push(bbox(await gray(out, n / 30, 640, 360), 640, 360).w / 160);
    console.log("kenburns zoom measured", widths.map((v) => Math.round(v * 1000) / 1000), "frames", frames);
    expect(widths[0]).toBeGreaterThan(0.97); expect(widths[0]).toBeLessThan(1.03);
    expect(Math.abs(widths[1]! - 1.25)).toBeLessThan(0.06);
    expect(Math.abs(widths[2]! - 1.5)).toBeLessThan(0.06);
  }, 60000);

  test("loop seam: durations from ffprobe, and the pass end meets its start", async () => {
    const src = await gen("loop-src.mp4", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=4", "-f", "lavfi", "-i", "sine=f=440:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest");
    const clip = await probe(src);
    const out3 = join(dir, "loop3.mp4"); await run(loopArgs(ffmpeg!, clip, out3, 3));
    const streams = await streamInfo(out3);
    const v = Number(streams.find((s) => s.codec_type === "video").duration), a = Number(streams.find((s) => s.codec_type === "audio").duration);
    console.log("loop 3x4s seam 0.5: video", v, "audio", a, "expected 10.5");
    expect(Math.abs(v - 10.5)).toBeLessThan(0.1); expect(Math.abs(a - 10.5)).toBeLessThan(0.15);
    const one = join(dir, "loop1.mp4"); await run(loopArgs(ffmpeg!, clip, one, 1));
    const oneLen = (await probe(one)).probe.duration_s!;
    const diff = async (p: string, t1: number, t2: number) => { const x = await gray(p, t1, 640, 360), y = await gray(p, t2, 640, 360); let sum = 0; for (let i = 0; i < x.length; i++) sum += Math.abs(x[i]! - y[i]!); return sum / x.length; };
    const seamJump = await diff(one, oneLen - 1 / 24, 0), plainJump = await diff(src, 4 - 1 / 24, 0), normal = await diff(src, 3.5 - 1 / 24, 3.5);
    console.log("last-to-first frame mean abs diff: seamed", Math.round(seamJump * 100) / 100, "plain", Math.round(plainJump * 100) / 100, "normal adjacent", Math.round(normal * 100) / 100);
    expect(seamJump).toBeLessThan(normal * 1.6); expect(seamJump).toBeLessThan(plainJump);
  }, 90000);

  test("mix: -16 LUFS target, no clipping, music over voice", async () => {
    const clipFile = await gen("mix-clip.mp4", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=6", "-f", "lavfi", "-i", "sine=f=300:d=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest");
    const music = await gen("mix-music.wav", "-f", "lavfi", "-i", "sine=f=880:d=6");
    const clip = await probe(clipFile);
    const op = { op: "audio_overlay" as const, input: 1, gain_db: 12, clip_gain_db: 6, start_s: 0, duck: false, fade_in_s: 0, fade_out_s: 0 };
    const hot = join(dir, "mix-hot.mp4"); await run(overlayArgs(ffmpeg!, clip, music, hot, op));
    const m = await loud(hot);
    console.log("mix (+12 dB and +6 dB inputs) measured", m);
    expect(Math.abs(m.lufs - -16)).toBeLessThan(1.5); expect(m.samplePeak).toBeLessThan(-0.5);
    const ducked = join(dir, "mix-duck.mp4"); await run(overlayArgs(ffmpeg!, clip, music, ducked, { ...op, gain_db: 0, clip_gain_db: 0, duck: true, duck_target: "overlay" }));
    const d = await loud(ducked); console.log("mix with music ducked under the clip's voice", d);
    expect(Math.abs(d.lufs - -16)).toBeLessThan(1.5); expect(d.samplePeak).toBeLessThan(-0.5);
  }, 120000);

  test("every encode carries bt709, yuv420p and a constant frame rate, accepted by ffmpeg 8", async () => {
    const mk = (n: string, f: number) => gen(n, "-f", "lavfi", "-i", `testsrc2=s=640x360:r=24:d=${f}`, "-f", "lavfi", "-i", `sine=f=${f * 100}:d=${f}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest");
    const clips = [await probe(await mk("t1.mp4", 3)), await probe(await mk("t2.mp4", 3))];
    const outs: [string, string[]][] = [["tr.mp4", transitionArgs(ffmpeg!, clips, "fade", 0.5, join(dir, "tr.mp4"))], ["cat.mp4", concatEncodeArgs(ffmpeg!, clips, join(dir, "cat.mp4"))], ["trim.mp4", trimArgs(ffmpeg!, clips[0]!.path, join(dir, "trim.mp4"), { op: "trim", in_s: 0.5, out_s: 2 }, clips[0]!.probe, false).args]];
    for (const [name, args] of outs) {
      await run(args); const v = (await streamInfo(join(dir, name))).find((s) => s.codec_type === "video");
      console.log(name, v.pix_fmt, v.color_space, v.color_primaries, v.color_transfer, v.r_frame_rate, v.avg_frame_rate);
      expect([v.pix_fmt, v.color_space, v.color_primaries, v.color_transfer, v.r_frame_rate, v.avg_frame_rate]).toEqual(["yuv420p", "bt709", "bt709", "bt709", "24/1", "24/1"]);
    }
  }, 90000);

  test("credits: 20 lines, the first appears and the last rolls through and off", async () => {
    const fonts = resolveFonts(); if (!fonts) return;
    const src = await gen("cr-src.mp4", "-f", "lavfi", "-i", "color=black:s=640x360:r=24:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p");
    const clip = await probe(src);
    const out = join(dir, "credits.mp4");
    const lines = Array.from({ length: 20 }, (_, i) => ({ role: `ROLE ${i}`, name: `Name ${i}` }));
    const args = [...creditsArgs(ffmpeg!, clip, out, { op: "credits", lines, speed: 90, background: "black", text_color: "white" }, "", join(dir, "c.ass"))]; args[args.indexOf("-filter_complex") + 1] = args[args.indexOf("-filter_complex") + 1]!.replaceAll("\\'", "'");
    await run(args);
    const length = (await probe(out)).probe.duration_s!;
    const layout = creditsLayout({ lines, speed: 90 }, 360);
    const lit = async (t: number) => bbox(await gray(out, t, 640, 360), 640, 360, 170).count;
    const first = []; for (let t = 0; t < 4; t += 0.25) first.push(await lit(t));
    const tail = []; for (let t = length - 0.4; t < length - 0.05; t += 0.1) tail.push(await lit(t));
    // The last line: find when the final row is last visible, then it must be gone before the end.
    let lastVisible = 0; for (let t = 0; t < length; t += 0.5) if (await lit(t)) lastVisible = t;
    console.log("credits length", length, "planned", layout.duration, "first 4 s lit", first.join(""), "last second lit", tail.join(""), "last lit at", lastVisible);
    expect(Math.abs(length - layout.duration)).toBeLessThan(0.2);
    expect(first.some((n) => n === 0)).toBe(true); expect(first.some((n) => n === 1)).toBe(true);
    expect(tail.every((n) => n === 0)).toBe(true);
    expect(lastVisible).toBeGreaterThan(length / 2);
  }, 120000);

  test("six-clip crossfade keeps picture and sound within one frame", async () => {
    const mk = (n: number) => gen(`s${n}.mp4`, "-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=5.0417", "-f", "lavfi", "-i", `sine=f=${300 + n * 50}:d=5.0417`, "-frames:v", "121", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac");
    const clips: Clip[] = []; for (let n = 0; n < 6; n++) clips.push(await probe(await mk(n)));
    const out = join(dir, "six.mp4"); await run(transitionArgs(ffmpeg!, clips, "fade", 0.3, out));
    const s = await streamInfo(out);
    const v = Number(s.find((x) => x.codec_type === "video").duration), a = Number(s.find((x) => x.codec_type === "audio").duration);
    const t = crossfadeTiming(clips.map((c) => c.probe.duration_s!), 0.3, 24); const expected = (121 * 6 - 5 * t.frames) / 24;
    console.log("six clips d", t.d, "expected", expected, "video", v, "audio", a, "diff ms", Math.round((v - a) * 1000));
    expect(Math.abs(v - a)).toBeLessThan(1 / 24); expect(Math.abs(v - expected)).toBeLessThan(1 / 24 + 0.01);
  }, 120000);

  test("a copy join whose sound is a different length is caught", async () => {
    const mk = (n: string) => gen(n, "-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=3", "-f", "lavfi", "-i", "sine=d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac");
    const clips = [await probe(await mk("c1.mp4")), await probe(await mk("c2.mp4")), await probe(await mk("c3.mp4"))];
    const list = join(dir, "l.txt"); writeFileSync(list, clips.map((c) => `file '${c.path}'`).join("\n") + "\n");
    const out = join(dir, "copy.mp4"); await run(concatCopyArgs(ffmpeg!, list, out));
    const s = await streamInfo(out); const v = Number(s.find((x) => x.codec_type === "video").duration), a = Number(s.find((x) => x.codec_type === "audio").duration);
    console.log("3-clip stream-copy join: video", v, "audio", a, "match", audioMatchesVideo((await probe(out)).probe));
  }, 60000);

  test("cleanup", () => { rmSync(dir, { recursive: true, force: true }); });
});
