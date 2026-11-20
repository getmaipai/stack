import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { precheck } from "./jobs";
import { spawnRunner } from "./run";
import { correlation, countOccurrences, normalizeWords, parseBlack, parseFreeze, parseIntegratedLufs, parseSilence, verifyFile, VERIFY_RULES, wordSimilarity, type Listener, type VerifyInput } from "./verify";

const ffmpeg = process.env.STACK_MEDIA_FFMPEG ?? "ffmpeg";
const ffprobe = process.env.STACK_MEDIA_FFPROBE ?? "ffprobe";
const have = spawnSync(ffmpeg, ["-version"], { stdio: "ignore" }).status === 0;
if (!have) console.info(`media.verify fixture tests skipped: ffmpeg is unavailable at ${ffmpeg}`);

describe("media.verify pure parts", () => {
  it("uses Home's one rule table numbers", () => { expect(VERIFY_RULES).toEqual({ blackLuma: 12, blackSeconds: 0.3, frozenDiff: 0.35, frozenSeconds: 1 }); });
  it("reads ffmpeg's detector lines, closing a run that reaches the end", () => {
    expect(parseBlack("[blackdetect @ 0x1] black_start:1.5 black_end:2.25 black_duration:0.75")).toEqual([{ start: 1.5, end: 2.25 }]);
    expect(parseFreeze("lavfi.freezedetect.freeze_start: 2\nlavfi.freezedetect.freeze_duration: 1\nlavfi.freezedetect.freeze_end: 3\nlavfi.freezedetect.freeze_start: 5", 6)).toEqual([{ start: 2, end: 3 }, { start: 5, end: 6 }]);
    expect(parseSilence("silence_start: 1.2\nsilence_end: 3.4 | silence_duration: 2.2\nsilence_start: 4.0", 5)).toEqual([{ start: 1.2, end: 3.4 }, { start: 4, end: 5 }]);
    expect(parseIntegratedLufs("  Integrated loudness:\n    I:         -23.4 LUFS\n    Threshold:  -33.4 LUFS")).toBe(-23.4);
  });
  it("matches lines by words, counts repeats, and ignores case and punctuation", () => {
    const want = normalizeWords("Hello, there! It's me.");
    expect(wordSimilarity(want, normalizeWords("hello there its me"))).toBe(1);
    expect(wordSimilarity(want, normalizeWords("goodbye for now my friend"))).toBeLessThan(0.3);
    expect(countOccurrences(want, normalizeWords("hello there its me hello there its me"), 0.8)).toBe(2);
    expect(countOccurrences(want, normalizeWords("hello there its me"), 0.8)).toBe(1);
  });
  it("correlates a copy at 1 and unlike sounds near 0", () => {
    const a = Float32Array.from({ length: 4000 }, (_, i) => Math.sin(i / 7)); const b = Float32Array.from({ length: 4000 }, (_, i) => Math.sin(i / 3.1));
    expect(correlation(a, a)).toBeCloseTo(1, 5); expect(Math.abs(correlation(a, b))).toBeLessThan(0.2);
  });
  it("is checked at admission", () => { expect(precheck("media.verify")({ path: "/nowhere/x.mp4", expect: { shots: [{ id: "a", start_s: 2, end_s: 1 }] } })).not.toBeNull(); });
});

const dir = mkdtempSync(join(tmpdir(), "verify-fixtures-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
type V = "move" | "still" | "black"; type A = number | "mute" | { f: number; vol: number };
/** Three 2 s shots at 320x240, 24 fps, built from synthetic test patterns and tones, then joined. */
function build(name: string, video: V[], audio: A[], size = "320x240"): string {
  const out = join(dir, name); const inputs: string[] = []; const chains: string[] = [];
  video.forEach((v, i) => { inputs.push("-f", "lavfi", "-i", v === "move" ? `testsrc2=size=${size}:rate=24:duration=2` : `color=c=${v === "black" ? "black" : "0x4060c0"}:size=${size}:rate=24:duration=2`); chains.push(`[${i}:v]setsar=1[v${i}]`); });
  audio.forEach((a, i) => { const k = video.length + i; inputs.push("-f", "lavfi", "-i", a === "mute" ? "anullsrc=r=16000:cl=mono:d=2" : typeof a === "number" ? `sine=f=${a}:r=16000:d=2` : `sine=f=${a.f}:r=16000:d=2`); chains.push(`[${k}:a]aformat=sample_rates=16000:channel_layouts=mono${typeof a === "object" ? `,volume=${a.vol}` : ""}[a${i}]`); });
  const join_ = video.map((_, i) => `[v${i}][a${i}]`).join("") + `concat=n=${video.length}:v=1:a=1[v][a]`;
  const r = spawnSync(ffmpeg, ["-y", "-v", "error", ...inputs, "-filter_complex", [...chains, join_].join(";"), "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", out], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return out;
}
const shot = (i: number, extra: Record<string, unknown> = {}) => ({ id: `s${i + 1}`, start_s: i * 2, end_s: i * 2 + 2, ...extra });
const run = (path: string, shots: unknown[], more: Record<string, unknown> = {}, listen: Listener | null = null) =>
  verifyFile({ path, expect: { shots, ...(more.expect as object | undefined) }, rules: {}, speech_tolerance: 0.8 } as unknown as VerifyInput, { run: spawnRunner, ffmpeg, ffprobe, listen, signal: new AbortController().signal });
const fails = (r: Awaited<ReturnType<typeof run>>, check: string) => r.checks.filter((c) => c.status === "fail" && c.check === check);
const TONES = [440, 660, 880];
const scripted = (lines: string[]): Listener => { let i = 0; return async () => lines[i++ % lines.length]!; };

describe.skipIf(!have)("media.verify on fixtures built with ffmpeg", () => {
  it("passes a good film, an intentional held still included", async () => {
    const file = build("good.mp4", ["move", "still", "move"], TONES);
    const r = await run(file, [shot(0), shot(1, { kind: "held_still" }), shot(2)], { expect: { width: 320, height: 240, fps: 24, duration_s: 6, has_audio: true } });
    expect(r.checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(r.verdict).toBe("pass");
    expect(r.checks.some((c) => c.check === "picture.frozen" && c.shot_id === "s2" && c.status === "pass")).toBe(true);
    expect(r.shots.every((s) => s.loudness_lufs !== null)).toBe(true);
  }, 60_000);
  it("catches a frozen moving shot", async () => {
    const file = build("frozen.mp4", ["move", "still", "move"], TONES);
    const r = await run(file, [shot(0), shot(1), shot(2)]);
    expect(fails(r, "picture.frozen").map((c) => c.shot_id)).toEqual(["s2"]); expect(r.verdict).toBe("fail");
  }, 60_000);
  it("catches a black shot", async () => {
    const r = await run(build("black.mp4", ["move", "black", "move"], TONES), [shot(0), shot(1), shot(2)]);
    expect(fails(r, "picture.black")[0]?.shot_id).toBe("s2");
  }, 60_000);
  it("catches a muted line", async () => {
    const r = await run(build("mute.mp4", ["move", "move", "move"], [440, "mute", 880]), [shot(0, { sound: true }), shot(1, { sound: true }), shot(2, { sound: true })]);
    expect(fails(r, "sound.silent").map((c) => c.shot_id)).toEqual(["s2"]); expect(r.verdict).toBe("fail");
  }, 60_000);
  it("catches one shot's sound copied onto another, and not the distinct ones", async () => {
    const copied = await run(build("copy.mp4", ["move", "move", "move"], [440, 660, 440]), [shot(0, { sound: true }), shot(1, { sound: true }), shot(2, { sound: true })]);
    expect(fails(copied, "sound.copied").map((c) => [c.shot_id, c.other_shot_id])).toEqual([["s1", "s3"]]);
    const fine = await run(build("distinct.mp4", ["move", "move", "move"], TONES), [shot(0, { sound: true }), shot(1, { sound: true }), shot(2, { sound: true })]);
    expect(fails(fine, "sound.copied")).toEqual([]);
  }, 60_000);
  it("flags a shot far quieter than the rest", async () => {
    const r = await run(build("quiet.mp4", ["move", "move", "move"], [440, { f: 660, vol: 0.01 }, 880]), [shot(0, { sound: true }), shot(1, { sound: true }), shot(2, { sound: true })]);
    expect(fails(r, "sound.quiet").map((c) => c.shot_id)).toEqual(["s2"]);
  }, 60_000);
  it("reports a size, frame rate, length or stream that is not what was asked", async () => {
    const r = await run(build("shape.mp4", ["move", "move", "move"], TONES), [], { expect: { width: 640, fps: 30, duration_s: 9, audio_channels: 2 } });
    expect(fails(r, "shape.width").length + fails(r, "shape.fps").length + fails(r, "shape.duration").length + fails(r, "shape.audio_channels").length).toBe(4);
  }, 60_000);
  it("checks each spoken line with the listener: heard, twice, missing, and in the wrong shot", async () => {
    const file = build("speech.mp4", ["move", "move", "move"], TONES);
    const shots = [shot(0, { line: "Hello there, it is me." }), shot(1, { line: "Good bye for now." }), shot(2, { line: "See you soon friend." })];
    const ok = await run(file, shots, {}, scripted(["hello there it is me", "good bye for now", "see you soon friend"]));
    expect(ok.verdict).toBe("pass");
    const twice = await run(file, shots, {}, scripted(["hello there it is me", "good bye for now good bye for now", "see you soon friend"]));
    expect(fails(twice, "speech.line").map((c) => c.shot_id)).toEqual(["s2"]); expect(fails(twice, "speech.line")[0]!.message).toContain("2 times");
    const missing = await run(file, shots, {}, scripted(["hello there it is me", "", "see you soon friend"]));
    expect(fails(missing, "speech.line").map((c) => c.shot_id)).toEqual(["s2"]);
    const wrong = await run(file, shots, {}, scripted(["good bye for now", "hello there it is me", "see you soon friend"]));
    expect(fails(wrong, "speech.line").map((c) => [c.shot_id, c.other_shot_id])).toEqual([["s1", "s2"], ["s2", "s1"]]);
  }, 120_000);
  it("is incomplete, never a pass, when lines are expected and no listening engine exists", async () => {
    const r = await run(build("nolisten.mp4", ["move", "move", "move"], TONES), [shot(0, { line: "Hello there." })], {}, null);
    expect(r.verdict).toBe("incomplete"); expect(r.checks.find((c) => c.check === "speech")?.status).toBe("skipped");
  }, 60_000);
});
