import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { creditsArgs, crossfadeArgs, editInputProblem, titleCardArgs, transitionArgs, TRANSITION_KINDS, type Clip } from "@/media/editOps";
import { normalizeProbe } from "@/media/probe";
import { spawnRunner } from "@/media/run";
import { probeFile } from "@/media/probe";

const probe = normalizeProbe({ format: { format_name: "mp4", duration: "2" }, streams: [{ index: 0, codec_type: "video", codec_name: "h264", width: 320, height: 180, pix_fmt: "yuv420p", avg_frame_rate: "24/1" }, { index: 1, codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000" }] }, "/clip.mp4", 1);
const clip: Clip = { path: "/clip.mp4", probe };
const font = "/System/Library/Fonts/Helvetica.ttc";
const base = { inputs: ["/clip.mp4", "/second.mp4"], output: { name: "out.mp4" } };
const findTool = (name: string) => { const configured = process.env[name === "ffmpeg" ? "STACK_MEDIA_FFMPEG" : "STACK_MEDIA_FFPROBE"]; if (configured && existsSync(configured)) return configured; return [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`].find(existsSync) ?? null; };

describe("media.edit film operation builders", () => {
  test("all transition kinds use xfade and bad kinds are refused", () => {
    for (const kind of TRANSITION_KINDS) expect(transitionArgs("ffmpeg", [clip, clip], kind, 0.5, "/o.mp4").join(" ")).toContain(`xfade=transition=${kind}:duration=0.5`);
    expect(crossfadeArgs("ffmpeg", [clip, clip], 0.5, "/o.mp4").join(" ")).toContain("xfade=transition=fade");
    expect(editInputProblem({ ...base, ops: [{ op: "transition", kind: "inject", duration_s: 0.5 }] })).toMatch(/fade.*dissolve.*pixelize/);
  });
  test("title card and credits builders create matching silent lavfi clips", () => {
    const title = titleCardArgs("ffmpeg", clip, "/o.mp4", { op: "title_card", text: "Hello", subtitle: "World", duration_s: 2, position: "center", background: "#112233", text_color: "white", place: "start" }, font).join(" ");
    expect(title).toContain("color=c=0x112233:s=320x180:r=24:d=2"); expect(title).toContain("anullsrc=r=48000:cl=stereo"); expect(title).toContain("text='World'");
    const credits = creditsArgs("ffmpeg", clip, "/o.mp4", { op: "credits", lines: [{ role: "Director", name: "A Name" }], background: "black", text_color: "white", speed: 60 }, font).join(" ");
    expect(credits).toContain("y=h - t*60"); expect(credits).toContain("text='Director'"); expect(credits).toContain("text='A Name'");
  });
  test("validation rejects overlong text and too many credit lines", () => {
    expect(editInputProblem({ inputs: ["/clip.mp4"], output: base.output, ops: [{ op: "title_card", text: "x".repeat(121), duration_s: 2, position: "center", background: "black", text_color: "white", place: "start" }] })).toMatch(/120/);
    expect(editInputProblem({ inputs: ["/clip.mp4"], output: base.output, ops: [{ op: "credits", lines: Array.from({ length: 61 }, () => ({ name: "Name" })), background: "black", text_color: "white" }] })).toMatch(/60/);
  });
  test("drawtext injection punctuation stays escaped", () => {
    const hostile = "quote' colon: slash\\ percent% %{x}\nnext";
    const title = titleCardArgs("ffmpeg", clip, "/o.mp4", { op: "title_card", text: hostile, duration_s: 2, position: "top", background: "white", text_color: "black", place: "end" }, font).join(" ");
    const credits = creditsArgs("ffmpeg", clip, "/o.mp4", { op: "credits", lines: [{ role: hostile, name: hostile }], background: "white", text_color: "black", speed: 60 }, font).join(" ");
    for (const args of [title, credits]) { expect(args).toContain("\\'"); expect(args).toContain("\\:"); expect(args).toContain("\\\\"); expect(args).toContain("\\%"); expect(args).toContain("\\{"); expect(args).toContain("\\n"); }
  });
});

const ffmpeg = findTool("ffmpeg"); const ffprobe = findTool("ffprobe");
const real = ffmpeg && ffprobe ? test : test.skip;
real("real ffmpeg transition, title card and rolling credits produce the expected duration", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "media-edit-film-")));
  try {
    const out = join(dir, "film.mp4");
    const made = await spawnRunner([ffmpeg!, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=24:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "a.mp4")]);
    expect(made.code).toBe(0);
    const second = await spawnRunner([ffmpeg!, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "b.mp4")]);
    expect(second.code).toBe(0);
    const signal = new AbortController().signal;
    const aProbe = await probeFile(spawnRunner, ffprobe!, join(dir, "a.mp4"), signal); const bProbe = await probeFile(spawnRunner, ffprobe!, join(dir, "b.mp4"), signal);
    const transition = await spawnRunner(transitionArgs(ffmpeg!, [{ path: join(dir, "a.mp4"), probe: aProbe }, { path: join(dir, "b.mp4"), probe: bProbe }], "slideleft", 0.5, join(dir, "joined.mp4")));
    expect(transition.code).toBe(0);
    const joinedProbe = await probeFile(spawnRunner, ffprobe!, join(dir, "joined.mp4"), signal);
    const final = await spawnRunner(titleCardArgs(ffmpeg!, { path: join(dir, "joined.mp4"), probe: joinedProbe }, out, { op: "title_card", text: "Film", duration_s: 2, position: "center", background: "black", text_color: "white", place: "start" }, font));
    expect(final.code).toBe(0);
    const titleProbe = await probeFile(spawnRunner, ffprobe!, out, signal);
    const withCredits = await spawnRunner(creditsArgs(ffmpeg!, { path: out, probe: titleProbe }, join(dir, "final.mp4"), { op: "credits", lines: [{ role: "Director", name: "Test" }], duration_s: 3, background: "black", text_color: "white", speed: 60 }, font));
    expect(withCredits.code).toBe(0);
    const finalProbe = await probeFile(spawnRunner, ffprobe!, join(dir, "final.mp4"), signal);
    // Each card builder renders the card alone; the job runner joins it to the clip. So: the slideleft join of two 2 s clips with a 0.5 s overlap is 3.5 s, the title card is 2 s and the credits card is 3 s, each with picture and sound.
    expect(joinedProbe.duration_s!).toBeGreaterThan(3.3); expect(joinedProbe.duration_s!).toBeLessThan(3.7);
    expect(titleProbe.duration_s!).toBeGreaterThan(1.8); expect(titleProbe.duration_s!).toBeLessThan(2.2);
    expect(finalProbe.duration_s!).toBeGreaterThan(2.8); expect(finalProbe.duration_s!).toBeLessThan(3.2);
    expect(finalProbe.has_audio).toBe(true); expect(finalProbe.has_video).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000);
