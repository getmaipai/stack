import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POCKET_TTS_PRESET_VOICES } from "@/speech/voices";
import { precheck } from "./jobs";
import { buildRoughCut, checkRoughCutRequest, LINE_LEAD_S, motionOp, RoughCutRefusal, waveOf, type RoughCutDeps, type RoughCutInput } from "./roughCut";
import { spawnRunner } from "./run";

const ffmpeg = process.env.STACK_MEDIA_FFMPEG ?? "ffmpeg";
const ffprobe = process.env.STACK_MEDIA_FFPROBE ?? "ffprobe";
const have = spawnSync(ffmpeg, ["-version"], { stdio: "ignore" }).status === 0;
const dir = mkdtempSync(join(tmpdir(), "rough-cut-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sine = (hz: number, seconds: number): Uint8Array => { const out = join(dir, `s${hz}-${seconds}.wav`); spawnSync(ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", `sine=f=${hz}:r=24000:d=${seconds}`, "-c:a", "pcm_s16le", out]); return new Uint8Array(readFileSync(out)); };
const picture = (n: number): string => { const out = join(dir, `still-${n}.png`); spawnSync(ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=1:duration=1`, "-frames:v", "1", out]); return out; };
const shots = (count: number, seconds = 3) => Array.from({ length: count }, (_, i) => ({ id: `shot-${i + 1}`, picture: picture(i + 1), seconds }));
const line = (shot: number, text = "Please put the blue mug back.") => ({ shot_id: `shot-${shot}`, line: { speaker: "iris", text } });
const spoken: Array<{ text: string; voice: string | undefined }> = [];
const deps = (over: Partial<RoughCutDeps> = {}): RoughCutDeps => ({
  run: spawnRunner, ffmpeg, ffprobe, signal: new AbortController().signal,
  speak: async (text, voice) => { spoken.push({ text, voice }); return sine(440, 1); }, ...over,
});
const probeSeconds = (path: string): number => Number(spawnSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { encoding: "utf8" }).stdout);
const hasAudio = (path: string): boolean => spawnSync(ffprobe, ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", path], { encoding: "utf8" }).stdout.includes("audio");
const silent = (path: string, from: number, len: number): boolean => spawnSync(ffmpeg, ["-hide_banner", "-ss", String(from), "-t", String(len), "-i", path, "-vn", "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr.match(/max_volume: (-?[\d.]+|-inf) dB/)?.[1] === "-inf" || Number(spawnSync(ffmpeg, ["-hide_banner", "-ss", String(from), "-t", String(len), "-i", path, "-vn", "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr.match(/max_volume: (-?[\d.]+) dB/)?.[1] ?? "0") < -50;

describe("media.rough_cut: the line's waveform", () => {
  it.skipIf(!have)("is loudness from 0 to 1, loudest at 1, and 0 where the line is silent", () => {
    const out = join(dir, "half.wav"); spawnSync(ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=f=440:r=24000:d=1", "-af", "apad=pad_dur=1", "-c:a", "pcm_s16le", out]);
    const wave = waveOf(new Uint8Array(readFileSync(out)))!;
    expect(wave.length).toBe(40); expect(Math.max(...wave)).toBe(1); expect(wave.every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(wave.slice(0, 15).every((v) => v > 0.9)).toBe(true); expect(wave.slice(25).every((v) => v < 0.05)).toBe(true);
  });
  it("gives nothing for bytes that are not audio", () => { expect(waveOf(new Uint8Array([1, 2, 3]))).toBeUndefined(); });
});

describe("media.rough_cut: rules that need no file", () => {
  it("maps the plan's motion words, holding still for anything else", () => {
    expect(motionOp("zoom in", 5)).toMatchObject({ zoom_from: 1, zoom_to: 1.2, pan: "none", duration_s: 5 });
    expect(motionOp("Zoom Out", 5)).toMatchObject({ zoom_from: 1.2, zoom_to: 1 });
    expect(motionOp("pan left", 4)).toMatchObject({ pan: "left" }); expect(motionOp("pan right", 4)).toMatchObject({ pan: "right" });
    expect(motionOp("wobbles", 4)).toMatchObject({ zoom_from: 1, zoom_to: 1, pan: "none" });
  });
  it("refuses a line that names no shot, two lines in one shot, and a repeated shot name, in plain words", () => {
    const base: RoughCutInput = { audience: "adult", shots: [{ id: "a", picture: "/p.png", seconds: 3 }, { id: "b", picture: "/p.png", seconds: 3 }] };
    expect(() => checkRoughCutRequest({ ...base, lines: [{ shot_id: "zzz", line: { speaker: "iris", text: "Hi." } }] })).toThrow(/not in the film/);
    expect(() => checkRoughCutRequest({ ...base, lines: [{ shot_id: "a", line: { speaker: "iris", text: "Hi." } }, { shot_id: "a", line: { speaker: "iris", text: "Again." } }] })).toThrow(/more than one line/);
    expect(() => checkRoughCutRequest({ ...base, shots: [base.shots[0]!, base.shots[0]!] })).toThrow(/share a name/);
  });
  it("refuses a cloned voice for a speaker flagged minor, and for every speaker when the audience is minor, but allows a starter voice or none", () => {
    const base: RoughCutInput = { audience: "adult", shots: [{ id: "a", picture: "/p.png", seconds: 3 }], lines: [{ shot_id: "a", line: { speaker: "nova", text: "Hi." } }] };
    const starter = Object.keys(POCKET_TTS_PRESET_VOICES)[0]!;
    expect(() => checkRoughCutRequest({ ...base, voices: [{ speaker: "nova", minor: true, voice_address: "/media/voices/nova-clone.wav" }] })).toThrow(RoughCutRefusal);
    expect(() => checkRoughCutRequest({ ...base, voices: [{ speaker: "nova", minor: true, voice_address: "https://voices.example.com/nova.wav" }] })).toThrow(/starter voice/);
    expect(() => checkRoughCutRequest({ ...base, audience: "minor", voices: [{ speaker: "nova", voice_address: "/media/voices/nova-clone.wav" }] })).toThrow(RoughCutRefusal);
    expect(() => checkRoughCutRequest({ ...base, voices: [{ speaker: "nova", minor: true, voice_address: starter }] })).not.toThrow();
    expect(() => checkRoughCutRequest({ ...base, voices: [{ speaker: "nova", minor: true }] })).not.toThrow();
    expect(() => checkRoughCutRequest({ ...base, voices: [{ speaker: "iris", voice_address: "/media/voices/iris-home.wav" }] })).not.toThrow();
  });
  it("is checked at admission: bad shape, estimate field, clone for a minor", () => {
    const ok = { audience: "adult", shots: [{ id: "a", picture: "/nowhere/p.png", seconds: 3 }] };
    expect(precheck("media.rough_cut")({ audience: "adult", shots: [] })?.status).toBe(422);
    expect(precheck("media.rough_cut")({ ...ok, estimate: { level: "standard" } })?.code).toBe("bad_input");
    expect(precheck("media.rough_cut")({ ...ok, model: "ltx" })?.code).toBe("bad_input");
    expect(precheck("media.rough_cut")({ ...ok, lines: [{ shot_id: "a", line: { speaker: "nova", text: "Hi." } }], voices: [{ speaker: "nova", minor: true, voice_address: "/x/clone.wav" }] })?.code).toBe("clone_refused");
  });
});

describe.skipIf(!have)("media.rough_cut on fixtures built with ffmpeg", () => {
  it("is the silent animatic with no lines: contiguous timings, the real length, no voiced lines", async () => {
    const out = join(dir, "silent");
    const result = await buildRoughCut({ audience: "adult", shots: shots(3, 2) }, out, deps());
    expect(result.total_s).toBe(6); expect(result.lines).toEqual([]);
    expect(result.shots).toEqual([{ id: "shot-1", start_s: 0, end_s: 2 }, { id: "shot-2", start_s: 2, end_s: 4 }, { id: "shot-3", start_s: 4, end_s: 6 }]);
    expect(Math.abs(probeSeconds(result.file) - 6)).toBeLessThan(0.3);
    expect(Object.keys(result).sort()).toEqual(["file", "lines", "shots", "total_s"]);
  }, 120_000);
  it("voices a line at its shot, with the voice of its speaker, and nowhere else", async () => {
    spoken.length = 0;
    const out = join(dir, "voiced");
    const result = await buildRoughCut({ audience: "adult", shots: shots(3, 3), lines: [line(2), line(3, "It was my grandmother's.")], voices: [{ speaker: "iris", voice_address: "/media/voices/iris-home.wav" }] }, out, deps());
    expect(spoken.map((s) => s.voice)).toEqual(["/media/voices/iris-home.wav", "/media/voices/iris-home.wav"]);
    expect(result.lines.map((l) => [l.shot_id, l.speaker, l.start_s])).toEqual([["shot-2", "iris", 3 + LINE_LEAD_S], ["shot-3", "iris", 6 + LINE_LEAD_S]]);
    for (const l of result.lines) { expect(l.length_s).toBeGreaterThan(0.9); expect(l.length_s).toBeLessThan(1.1); expect(l.wave!.length).toBeGreaterThan(5); expect(Math.max(...l.wave!)).toBe(1); }
    expect(hasAudio(result.file)).toBe(true);
    expect(silent(result.file, 0, 2.8)).toBe(true);                 // shot 1 has no line
    expect(silent(result.file, 3.3, 0.8)).toBe(false);              // shot 2 carries its line
    expect(silent(result.file, 4.6, 1.2)).toBe(true);               // quiet after the line, before shot 3
    expect(silent(result.file, 6.3, 0.8)).toBe(false);              // shot 3 carries its line
    expect(Math.abs(probeSeconds(result.file) - 9)).toBeLessThan(0.3);
  }, 180_000);
  it("uses the household default voice when no address is sent", async () => {
    spoken.length = 0;
    await buildRoughCut({ audience: "adult", shots: shots(2, 3), lines: [line(1)] }, join(dir, "default"), deps());
    expect(spoken[0]!.voice).toBeUndefined();
  }, 120_000);
  it("refuses a line longer than its shot before any picture work, and says what to do", async () => {
    await expect(buildRoughCut({ audience: "adult", shots: shots(2, 1), lines: [line(1)] }, join(dir, "toolong"), deps({ speak: async () => sine(440, 2) }))).rejects.toThrow(/longer or the line shorter/);
  }, 60_000);
  it("refuses a clone for a flagged minor before the speech engine is called", async () => {
    spoken.length = 0;
    await expect(buildRoughCut({ audience: "adult", shots: shots(1, 3), lines: [line(1)], voices: [{ speaker: "iris", minor: true, voice_address: "/media/voices/clone.wav" }] }, join(dir, "minor"), deps())).rejects.toThrow(RoughCutRefusal);
    expect(spoken).toEqual([]);
  }, 60_000);
});
