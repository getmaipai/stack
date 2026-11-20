// VF-CHECK-01: the finished-file checker (media.verify). It looks at the FINISHED clip or film, never at the separate shots, and
// compares it with what was asked: black or frozen pictures, silence or very quiet shots, one shot's sound copied onto another,
// each spoken line heard in its own shot, and the file's size, frame rate, duration and streams. No model runs here except the
// Stack's own listening engine (the `stt` role), and only for shots that carry an expected line.
//
// The black and frozen thresholds are Home's one rule table (CLIP_RULES in home/backend/src/lib/videos/frameCheck.ts, IVY-QC-01):
// blackLuma 12, blackSeconds 0.3, frozenDiff 0.35, frozenSeconds 1. They are copied here as VERIFY_RULES only because the Stack
// cannot import Home; Home passes its own table in `rules` so there is still one source of truth, and these defaults are only
// what a caller that sends nothing gets. Never change a number here without changing Home's table.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Job, JobProgress } from "@/lib/jobs";
import { JobFailure } from "@/lib/jobs";
import { decodeWave } from "@/speech/audio";
import { resolveReadable } from "./paths";
import { probeFile, type ProbeResult } from "./probe";
import type { Runner } from "./run";

const Id = z.string().min(1).max(60).regex(/^[A-Za-z0-9._-]+$/);
export const VerifyShot = z.object({
  id: Id,
  start_s: z.number().min(0).max(86_400),
  end_s: z.number().min(0).max(86_400),
  /** moving (default): must not freeze. held_still: an intentional still, exempt from the frozen check. */
  kind: z.enum(["moving", "held_still"]).default("moving"),
  /** The exact line spoken in this shot. Its presence means the shot must have sound and the line must be heard in this shot. */
  line: z.string().min(1).max(2000).optional(),
  /** Sound expected in this shot. Default: true when there is a line, false otherwise. */
  sound: z.boolean().optional(),
}).strict().refine((shot) => shot.end_s > shot.start_s, "A shot's end must be after its start.");
export const VerifyInput = z.object({
  path: z.string().min(1).max(4096),
  expect: z.object({
    shots: z.array(VerifyShot).max(400).default([]),
    width: z.number().int().min(1).optional(),
    height: z.number().int().min(1).optional(),
    fps: z.number().min(1).max(240).optional(),
    duration_s: z.number().min(0).optional(),
    duration_tolerance_s: z.number().min(0).max(60).optional(),
    has_video: z.boolean().optional(),
    has_audio: z.boolean().optional(),
    audio_channels: z.number().int().min(1).max(8).optional(),
  }).strict().default({ shots: [] }),
  /** Home's CLIP_RULES numbers for the black and frozen checks; absent keys take the defaults below. */
  rules: z.object({ blackLuma: z.number().min(0).max(255), blackSeconds: z.number().min(0.04).max(30), frozenDiff: z.number().min(0).max(255), frozenSeconds: z.number().min(0.04).max(60) }).partial().strict().default({}),
  /** Words-level match a heard line needs (1 minus the word edit distance over the longer text). */
  speech_tolerance: z.number().min(0.3).max(1).default(0.8),
}).strict();
export type VerifyInput = z.infer<typeof VerifyInput>;

/** Home's CLIP_RULES, same numbers. See the header. */
export const VERIFY_RULES = { blackLuma: 12, blackSeconds: 0.3, frozenDiff: 0.35, frozenSeconds: 1 } as const;
/** Audio thresholds of this checker alone. */
export const VERIFY_AUDIO = {
  /** silencedetect noise floor and the shortest silence it reports. */
  silenceDb: -50, silenceSeconds: 0.5,
  /** A shot that should have sound fails when silence covers at least this share of it. */
  silentShare: 0.9,
  /** A shot this many LU below the median of the other shots' loudness is flagged as far quieter. */
  quietLu: 10,
  /** Two shots whose sound correlates at or above this (waveform at lag zero, from the shots' own starts) are copies. */
  copyCorrelation: 0.9,
  /** A shifted copy: the loudness shape (10 ms frames) of two shots matches at or above this at some shift up to copyShiftSeconds. Found on the real first cut of the test film, where each shot carried shot 1's sound moved by 10 to 120 ms and the lag-zero waveform test saw nothing. */
  copyEnvelopeCorrelation: 0.9,
  copyShiftSeconds: 0.3,
  /** The loudness shape only counts when it varies (standard deviation over mean at least this); a steady tone or hiss carries no shape to match. */
  envelopeVariation: 0.25,
  /** A shot quieter than this RMS (0 to 1) carries no sound worth comparing. */
  rmsFloor: 0.001,
  /** The sound compared is cut to this many seconds per shot. */
  compareSeconds: 10,
  /** The listener hears each shot with this much extra on both sides, so a line that starts at the cut is not clipped. */
  speechPadSeconds: 0.15,
} as const;

export type CheckStatus = "pass" | "fail" | "skipped" | "info";
export interface VerifyCheck { check: string; status: CheckStatus; shot_id?: string; other_shot_id?: string; at_s?: number; end_s?: number; value?: number | string; message: string; }
export interface VerifyShotReport { id: string; start_s: number; end_s: number; kind: "moving" | "held_still"; loudness_lufs: number | null; heard?: string; }
export interface VerifyResult {
  verdict: "pass" | "fail" | "incomplete";
  /** Why the verdict is incomplete: checks that could not run (the listening engine is missing, a tool failed). */
  incomplete_reasons: string[];
  checks: VerifyCheck[];
  shots: VerifyShotReport[];
  overall_loudness_lufs: number | null;
  file: { duration_s: number | null; width: number | null; height: number | null; fps: number | null; has_video: boolean; has_audio: boolean; channels: number | null };
  rules: { blackLuma: number; blackSeconds: number; frozenDiff: number; frozenSeconds: number };
  elapsed_ms: number;
}

/** Hears the audio (mono, 16 kHz) and returns what was said, or null when no listening engine is available. */
export type Listener = (samples: Float32Array, signal: AbortSignal) => Promise<string>;
export interface VerifyDeps { run: Runner; ffmpeg: string; ffprobe: string; listen: Listener | null; signal: AbortSignal; progress?: (percent: number, status: string) => void; now?: () => number; }

// ---- pure helpers (tested directly) ----
export interface Interval { start: number; end: number; }
export function parseBlack(stderr: string): Interval[] {
  return [...stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)].map((m) => ({ start: Number(m[1]), end: Number(m[2]) }));
}
export function parseFreeze(stderr: string, duration: number): Interval[] {
  const out: Interval[] = []; let open: number | null = null;
  for (const m of stderr.matchAll(/freeze_(start|end):\s*([\d.]+)/g)) {
    if (m[1] === "start") open = Number(m[2]); else if (open !== null) { out.push({ start: open, end: Number(m[2]) }); open = null; }
  }
  if (open !== null) out.push({ start: open, end: duration });
  return out;
}
export function parseSilence(stderr: string, duration: number): Interval[] {
  const out: Interval[] = []; let open: number | null = null;
  for (const m of stderr.matchAll(/silence_(start|end):\s*(-?[\d.]+)/g)) {
    if (m[1] === "start") open = Math.max(0, Number(m[2])); else if (open !== null) { out.push({ start: open, end: Number(m[2]) }); open = null; }
  }
  if (open !== null) out.push({ start: open, end: duration });
  return out;
}
/** The integrated loudness of ebur128's closing summary; null when it printed none. */
export function parseIntegratedLufs(stderr: string): number | null {
  const at = stderr.lastIndexOf("Integrated loudness");
  if (at < 0) return null;
  const m = /I:\s*(-?[\d.]+|-inf)\s*LUFS/.exec(stderr.slice(at));
  if (!m) return null;
  return m[1] === "-inf" ? -70 : Number(m[1]);
}
export const overlap = (a: Interval, b: Interval): number => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
export function normalizeWords(text: string): string[] {
  return text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
}
function editDistance(a: string[], b: string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length]!;
}
/** 1 means the same words, 0 nothing in common. */
export function wordSimilarity(a: string[], b: string[]): number {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - editDistance(a, b) / longest;
}
/** How many separate times the expected words are heard in the heard words. */
export function countOccurrences(expected: string[], heard: string[], tolerance: number): number {
  const n = expected.length; if (!n) return 0;
  let count = 0;
  for (let i = 0; i + n <= heard.length;) {
    if (wordSimilarity(expected, heard.slice(i, i + n)) >= tolerance) { count++; i += n; } else i++;
  }
  return count;
}
/** Normalized correlation at lag zero over the shorter of the two. */
export function correlation(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length); if (!n) return 0;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < n; i++) { ab += a[i]! * b[i]!; aa += a[i]! * a[i]!; bb += b[i]! * b[i]!; }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}
export const rmsOf = (a: Float32Array): number => { if (!a.length) return 0; let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * a[i]!; return Math.sqrt(s / a.length); };
/** The loudness shape: RMS per 10 ms of 4 kHz audio. */
export function envelope(samples: Float32Array): number[] { const out: number[] = []; for (let i = 0; i + 40 <= samples.length; i += 40) { let e = 0; for (let k = 0; k < 40; k++) e += samples[i + k]! ** 2; out.push(Math.sqrt(e / 40)); } return out; }
function pearson(xs: number[], ys: number[]): number { const n = xs.length; if (n < 20) return 0; const mx = xs.reduce((p, c) => p + c, 0) / n, my = ys.reduce((p, c) => p + c, 0) / n; let nu = 0, dx = 0, dy = 0; for (let i = 0; i < n; i++) { nu += (xs[i]! - mx) * (ys[i]! - my); dx += (xs[i]! - mx) ** 2; dy += (ys[i]! - my) ** 2; } return dx > 0 && dy > 0 ? nu / Math.sqrt(dx * dy) : 0; }
const variation = (e: number[]): number => { const m = e.reduce((p, c) => p + c, 0) / (e.length || 1); if (!m) return 0; return Math.sqrt(e.reduce((p, c) => p + (c - m) ** 2, 0) / e.length) / m; };
/** A shifted copy of one shot's sound in another, by the loudness shape. Null when none, or when either shape is too flat to tell. */
export function shiftedCopy(a: Float32Array, b: Float32Array): { score: number; shift_s: number } | null {
  const ea = envelope(a), eb = envelope(b);
  if (variation(ea) < VERIFY_AUDIO.envelopeVariation || variation(eb) < VERIFY_AUDIO.envelopeVariation) return null;
  const max = Math.round(VERIFY_AUDIO.copyShiftSeconds * 100); let best = { score: -1, lag: 0 };
  for (let lag = -max; lag <= max; lag++) {
    const from = Math.max(0, -lag), to = Math.min(ea.length, eb.length - lag);
    const score = pearson(ea.slice(from, to), eb.slice(from + lag, to + lag));
    if (score > best.score) best = { score, lag };
  }
  return best.score >= VERIFY_AUDIO.copyEnvelopeCorrelation ? { score: best.score, shift_s: best.lag / 100 } : null;
}
const median = (values: number[]): number => { const s = [...values].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const fmt = (s: number): string => `${Math.round(s * 10) / 10}s`;

// ---- ffmpeg runs ----
async function ff(deps: VerifyDeps, argv: string[]): Promise<{ code: number | null; stderr: string; stdout: string }> {
  const r = await deps.run([deps.ffmpeg, "-hide_banner", "-nostdin", "-nostats", "-v", "info", ...argv], { signal: deps.signal, collectStdout: true });
  if (r.aborted || deps.signal.aborted) throw new Error("Cancelled.");
  return r;
}
async function shotAudio(deps: VerifyDeps, path: string, start: number, end: number, rate: number, work: string, name: string): Promise<Float32Array | null> {
  const out = join(work, `${name}.wav`);
  const r = await deps.run([deps.ffmpeg, "-hide_banner", "-nostdin", "-v", "error", "-y", "-ss", String(start), "-i", path, "-t", String(end - start), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", String(rate), "-c:a", "pcm_s16le", out], { signal: deps.signal });
  if (r.aborted || deps.signal.aborted) throw new Error("Cancelled.");
  if (r.code !== 0) return null;
  return decodeWave(new Uint8Array(await Bun.file(out).arrayBuffer())).samples;
}
const decimate = (samples: Float32Array, by: number): Float32Array => { const out = new Float32Array(Math.floor(samples.length / by)); for (let i = 0; i < out.length; i++) { let s = 0; for (let k = 0; k < by; k++) s += samples[i * by + k]!; out[i] = s / by; } return out; };

export async function verifyFile(rawInput: VerifyInput, deps: VerifyDeps): Promise<VerifyResult> {
  const started = (deps.now ?? Date.now)();
  const input = VerifyInput.parse(rawInput);
  const path = input.path; const exp = input.expect;
  const rules = { ...VERIFY_RULES, ...input.rules };
  const checks: VerifyCheck[] = []; const incomplete: string[] = [];
  const add = (c: VerifyCheck) => { checks.push(c); };
  const tick = (percent: number, status: string) => deps.progress?.(percent, status);

  tick(1, "reading the file");
  let probe: ProbeResult;
  try { probe = await probeFile(deps.run, deps.ffprobe, path, deps.signal); } catch (error) { if (deps.signal.aborted) throw error; throw new JobFailure("The file could not be read. Choose another file and try again.", { failure: { code: "unreadable", message: error instanceof Error ? error.message : String(error) } }); }
  const duration = probe.duration_s ?? 0;
  const videoStream = probe.streams.find((s) => s.type === "video" && s.codec !== "mjpeg");
  const fps = videoStream?.fps ?? null;
  const file = { duration_s: probe.duration_s, width: probe.width, height: probe.height, fps, has_video: probe.has_video, has_audio: probe.has_audio, channels: probe.channels };

  // 5. Shape.
  const shape = (name: string, ok: boolean, asked: string | number, got: string | number | null, say: string) => add({ check: `shape.${name}`, status: ok ? "pass" : "fail", value: got ?? "none", message: ok ? `The ${say} is ${asked}, as asked.` : `The ${say} is ${got ?? "missing"} but ${asked} was asked. Make the file again with the right setting.` });
  if (exp.has_video !== undefined) shape("has_video", probe.has_video === exp.has_video, exp.has_video ? "present" : "absent", probe.has_video ? "present" : "absent", "picture");
  if (exp.has_audio !== undefined) shape("has_audio", probe.has_audio === exp.has_audio, exp.has_audio ? "present" : "absent", probe.has_audio ? "present" : "absent", "sound track");
  if (exp.width !== undefined) shape("width", probe.width === exp.width, exp.width, probe.width, "width");
  if (exp.height !== undefined) shape("height", probe.height === exp.height, exp.height, probe.height, "height");
  if (exp.fps !== undefined) shape("fps", fps !== null && Math.abs(fps - exp.fps) <= 0.05, exp.fps, fps, "frame rate");
  if (exp.audio_channels !== undefined) shape("audio_channels", probe.channels === exp.audio_channels, exp.audio_channels, probe.channels, "number of sound channels");
  if (exp.duration_s !== undefined) {
    const tol = exp.duration_tolerance_s ?? Math.max(0.15, fps ? 2 / fps : 0.15);
    shape("duration", probe.duration_s !== null && Math.abs(probe.duration_s - exp.duration_s) <= tol, `${exp.duration_s}s (within ${Math.round(tol * 100) / 100}s)`, probe.duration_s === null ? null : `${Math.round(probe.duration_s * 100) / 100}s`, "length");
  }
  const shots = exp.shots;
  for (const shot of shots) if (duration && shot.end_s > duration + 0.2) add({ check: "shape.shot_in_file", status: "fail", shot_id: shot.id, at_s: shot.start_s, end_s: shot.end_s, message: `Shot ${shot.id} ends at ${fmt(shot.end_s)} but the file is only ${fmt(duration)} long. The shot list and the file do not match.` });
  const hasSound = (shot: z.infer<typeof VerifyShot>): boolean => shot.sound ?? shot.line !== undefined;
  const windows = shots.length ? shots.map((s) => ({ start: s.start_s, end: Math.min(s.end_s, duration || s.end_s) })) : [];

  // 1. Black and frozen pictures (ffmpeg blackdetect, freezedetect), measured the way Home's rule table was: 12 fps, 256 px wide, grey.
  if (probe.has_video && duration > 0) {
    tick(8, "looking for black and frozen pictures");
    const vf = `blackdetect=d=${rules.blackSeconds}:pic_th=0.98:pix_th=${(rules.blackLuma / 255).toFixed(5)},fps=12,scale=256:-2,format=gray,freezedetect=n=${(rules.frozenDiff / 255).toFixed(6)}:d=${rules.frozenSeconds}`;
    const r = await ff(deps, ["-i", path, "-map", "0:v:0", "-an", "-vf", vf, "-f", "null", "-"]);
    if (r.code !== 0) { incomplete.push("The picture checks could not run."); add({ check: "picture", status: "skipped", message: "The picture could not be decoded, so black and frozen checks did not run." }); }
    else {
      const black = parseBlack(r.stderr); const freeze = parseFreeze(r.stderr, duration);
      const where = (iv: Interval) => { const s = shots.find((sh) => overlap(iv, { start: sh.start_s, end: sh.end_s }) > 0); return s?.id; };
      if (!black.length) add({ check: "picture.black", status: "pass", message: "No black picture." });
      for (const iv of black) add({ check: "picture.black", status: "fail", ...(where(iv) ? { shot_id: where(iv)! } : {}), at_s: iv.start, end_s: iv.end, message: `The picture is black from ${fmt(iv.start)} to ${fmt(iv.end)}${where(iv) ? ` (shot ${where(iv)})` : ""}. Make that part again.` });
      let frozenFound = false;
      if (!shots.length) { for (const iv of freeze) { frozenFound = true; add({ check: "picture.frozen", status: "fail", at_s: iv.start, end_s: iv.end, message: `Nothing moves from ${fmt(iv.start)} to ${fmt(iv.end)}. Make that part again, or mark it as a held still.` }); } }
      else for (const shot of shots) {
        const hit = freeze.map((iv) => ({ iv, ov: overlap(iv, { start: shot.start_s, end: shot.end_s }) })).filter((x) => x.ov >= rules.frozenSeconds);
        if (shot.kind === "held_still") { add({ check: "picture.frozen", status: "pass", shot_id: shot.id, message: `Shot ${shot.id} is a held still, so a still picture is expected.` }); continue; }
        for (const { iv } of hit) { frozenFound = true; add({ check: "picture.frozen", status: "fail", shot_id: shot.id, at_s: Math.max(iv.start, shot.start_s), end_s: Math.min(iv.end, shot.end_s), message: `Shot ${shot.id} stops moving from ${fmt(Math.max(iv.start, shot.start_s))} to ${fmt(Math.min(iv.end, shot.end_s))}. Make the shot again.` }); }
      }
      if (!frozenFound && !shots.length) add({ check: "picture.frozen", status: "pass", message: "The picture keeps moving." });
    }
  }

  // 2. Silence and loudness.
  const shotReports: VerifyShotReport[] = shots.map((s) => ({ id: s.id, start_s: s.start_s, end_s: s.end_s, kind: s.kind, loudness_lufs: null }));
  let overall: number | null = null;
  if (probe.has_audio && duration > 0) {
    tick(25, "listening for silence and loudness");
    const r = await ff(deps, ["-i", path, "-map", "0:a:0", "-vn", "-af", `silencedetect=n=${VERIFY_AUDIO.silenceDb}dB:d=${VERIFY_AUDIO.silenceSeconds},ebur128=framelog=quiet`, "-f", "null", "-"]);
    if (r.code !== 0) { incomplete.push("The sound checks could not run."); add({ check: "sound", status: "skipped", message: "The sound could not be decoded, so the silence and loudness checks did not run." }); }
    else {
      const silence = parseSilence(r.stderr, duration); overall = parseIntegratedLufs(r.stderr);
      add({ check: "sound.loudness", status: "info", value: overall ?? "unknown", message: overall === null ? "Overall loudness could not be measured." : `Overall loudness ${overall} LUFS.` });
      for (let i = 0; i < shots.length; i++) {
        const shot = shots[i]!; const w = windows[i]!;
        if (w.end <= w.start) continue;
        const sr = await ff(deps, ["-ss", String(w.start), "-i", path, "-t", String(w.end - w.start), "-map", "0:a:0", "-vn", "-af", "ebur128=framelog=quiet", "-f", "null", "-"]);
        shotReports[i]!.loudness_lufs = sr.code === 0 ? parseIntegratedLufs(sr.stderr) : null;
        if (hasSound(shot)) {
          const covered = silence.reduce((sum, iv) => sum + overlap(iv, w), 0);
          const share = covered / (w.end - w.start);
          add(share >= VERIFY_AUDIO.silentShare
            ? { check: "sound.silent", status: "fail", shot_id: shot.id, at_s: w.start, end_s: w.end, value: Math.round(share * 100) / 100, message: `Shot ${shot.id} should have sound but is silent from ${fmt(w.start)} to ${fmt(w.end)}. Make its sound again.` }
            : { check: "sound.silent", status: "pass", shot_id: shot.id, message: `Shot ${shot.id} has sound.` });
        }
      }
      const levels = shotReports.map((s, i) => ({ s, i })).filter(({ s, i }) => s.loudness_lufs !== null && hasSound(shots[i]!) && s.loudness_lufs > -69);
      if (levels.length >= 3) {
        for (const { s, i } of levels) {
          const others = median(levels.filter((x) => x.i !== i).map((x) => x.s.loudness_lufs!));
          if (s.loudness_lufs! < others - VERIFY_AUDIO.quietLu) add({ check: "sound.quiet", status: "fail", shot_id: s.id, at_s: s.start_s, end_s: s.end_s, value: s.loudness_lufs!, message: `Shot ${s.id} is much quieter (${s.loudness_lufs} LUFS) than the other shots (about ${Math.round(others)} LUFS). Raise its level or make its sound again.` });
        }
      }
    }
  } else if (shots.some(hasSound)) {
    for (const shot of shots.filter(hasSound)) add({ check: "sound.silent", status: "fail", shot_id: shot.id, at_s: shot.start_s, end_s: shot.end_s, message: `The file has no sound track, but shot ${shot.id} needs sound. Make the file again with its sound.` });
  }

  // 3 and 4 need each shot's own audio. 16 kHz mono once; the correlation uses a 4 kHz copy.
  const work = mkdtempSync(join(tmpdir(), "stack-verify-"));
  try {
    const audio = new Map<string, Float32Array>();
    if (probe.has_audio && shots.length) {
      tick(45, "reading each shot's sound");
      for (let i = 0; i < shots.length; i++) {
        const w = windows[i]!; if (w.end <= w.start) continue;
        const padded = shots[i]!.line !== undefined ? { start: Math.max(0, w.start - VERIFY_AUDIO.speechPadSeconds), end: Math.min(duration || w.end + 1, w.end + VERIFY_AUDIO.speechPadSeconds) } : w;
        const samples = await shotAudio(deps, path, padded.start, padded.end, 16_000, work, `s${i}`);
        if (samples) audio.set(shots[i]!.id, samples);
      }
    }

    // 3. Copied sound.
    if (audio.size >= 2) {
      tick(60, "comparing the shots' sound");
      const small = new Map<string, Float32Array>();
      for (const shot of shots) { const a = audio.get(shot.id); if (a) small.set(shot.id, decimate(a.subarray(0, 16_000 * (VERIFY_AUDIO.compareSeconds + 0.3)), 4)); }
      const ids = shots.map((s) => s.id).filter((id) => small.has(id) && rmsOf(small.get(id)!) >= VERIFY_AUDIO.rmsFloor);
      let copies = 0;
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        // A line shot's audio is padded at its start, a plain one is not, so align from the shot's own start on both.
        const a = alignedStart(shots.find((s) => s.id === ids[i])!, small.get(ids[i]!)!); const b = alignedStart(shots.find((s) => s.id === ids[j])!, small.get(ids[j]!)!);
        const c = correlation(a, b);
        const shifted = c >= VERIFY_AUDIO.copyCorrelation ? null : shiftedCopy(a, b);
        if (c >= VERIFY_AUDIO.copyCorrelation || shifted) {
          copies++;
          const score = shifted ? shifted.score : c;
          add({ check: "sound.copied", status: "fail", shot_id: ids[i]!, other_shot_id: ids[j]!, value: Math.round(score * 1000) / 1000, ...(shifted ? { at_s: shifted.shift_s } : {}), message: `Shots ${ids[i]} and ${ids[j]} carry the same sound (match ${Math.round(score * 100)}%${shifted ? `, one moved ${Math.abs(Math.round(shifted.shift_s * 1000))} ms against the other` : ""}). One was copied onto the other. Make the sound again for each shot.` });
        }
      }
      if (!copies) add({ check: "sound.copied", status: "pass", message: "No two shots carry the same sound." });
    }

    // 4. Speech.
    const spoken = shots.filter((s) => s.line !== undefined);
    if (spoken.length) {
      if (!deps.listen) {
        incomplete.push("The listening engine is not available, so the spoken lines were not checked.");
        for (const s of spoken) add({ check: "speech", status: "skipped", shot_id: s.id, message: `Shot ${s.id}: the listening engine is not available, so its line was not checked.` });
      } else if (!probe.has_audio) {
        for (const s of spoken) add({ check: "speech.line", status: "fail", shot_id: s.id, message: `Shot ${s.id} should say a line but the file has no sound.` });
      } else {
        tick(70, "listening to each line");
        const heard = new Map<string, string[]>();
        for (let i = 0; i < spoken.length; i++) {
          const shot = spoken[i]!; const samples = audio.get(shot.id);
          let text = "";
          if (samples && samples.length) {
            for (let off = 0; off < samples.length; off += 30 * 16_000) text += " " + await deps.listen(samples.subarray(off, Math.min(samples.length, off + 30 * 16_000)), deps.signal);
          }
          heard.set(shot.id, normalizeWords(text));
          const rep = shotReports.find((r) => r.id === shot.id); if (rep) rep.heard = text.trim();
          tick(70 + Math.round(((i + 1) / spoken.length) * 28), "listening to each line");
        }
        for (const shot of spoken) {
          const want = normalizeWords(shot.line!); const got = heard.get(shot.id) ?? [];
          const times = countOccurrences(want, got, input.speech_tolerance);
          const sim = wordSimilarity(want, got.length > want.length * 1.6 ? got.slice(0, want.length) : got);
          if (times >= 2) add({ check: "speech.line", status: "fail", shot_id: shot.id, value: times, at_s: shot.start_s, end_s: shot.end_s, message: `The line in shot ${shot.id} is heard ${times} times. It should be heard once. Make the speech for this shot again.` });
          else if (times === 1 || sim >= input.speech_tolerance) add({ check: "speech.line", status: "pass", shot_id: shot.id, value: Math.round(Math.max(sim, times ? 1 : 0) * 100) / 100, message: `Shot ${shot.id}: the line is heard.` });
          else {
            const elsewhere = spoken.find((o) => o.id !== shot.id && countOccurrences(want, heard.get(o.id) ?? [], input.speech_tolerance) >= 1);
            if (elsewhere) add({ check: "speech.line", status: "fail", shot_id: shot.id, other_shot_id: elsewhere.id, at_s: shot.start_s, end_s: shot.end_s, message: `The line for shot ${shot.id} is heard in shot ${elsewhere.id} instead. Put each line's speech under its own shot.` });
            else if (!got.length) add({ check: "speech.line", status: "fail", shot_id: shot.id, at_s: shot.start_s, end_s: shot.end_s, value: 0, message: `No speech is heard in shot ${shot.id}, where a line is expected. Make its speech again.` });
            else add({ check: "speech.line", status: "fail", shot_id: shot.id, at_s: shot.start_s, end_s: shot.end_s, value: Math.round(sim * 100) / 100, message: `Shot ${shot.id}: what is heard ("${got.join(" ").slice(0, 120)}") does not match the line (match ${Math.round(sim * 100)}%, needs ${Math.round(input.speech_tolerance * 100)}%). Make its speech again.` });
          }
        }
      }
    }
  } finally { rmSync(work, { recursive: true, force: true }); }

  const failed = checks.some((c) => c.status === "fail");
  return { verdict: failed ? "fail" : incomplete.length ? "incomplete" : "pass", incomplete_reasons: incomplete, checks, shots: shotReports, overall_loudness_lufs: overall, file, rules, elapsed_ms: (deps.now ?? Date.now)() - started };
}

/** Drops the listener's lead-in padding so both clips start at their shot's own start. */
function alignedStart(shot: z.infer<typeof VerifyShot>, samples: Float32Array): Float32Array {
  if (shot.line === undefined) return samples;
  const skip = Math.min(samples.length, Math.round(Math.min(shot.start_s, VERIFY_AUDIO.speechPadSeconds) * 4000));
  return samples.subarray(skip);
}

// ---- the job ----
export async function runVerify(job: Job, signal: AbortSignal, progress: JobProgress, deps: { run: Runner; toolbox: { path(tool: "ffmpeg" | "ffprobe", onStatus: (s: string) => void, signal?: AbortSignal): Promise<string> }; listen?: Listener | null }): Promise<VerifyResult> {
  const input = VerifyInput.parse(job.input ?? {});
  const path = resolveReadable(input.path);
  const ffmpeg = await deps.toolbox.path("ffmpeg", (status) => progress({ status }), signal);
  const ffprobe = await deps.toolbox.path("ffprobe", (status) => progress({ status }), signal);
  const needsListener = input.expect.shots.some((s) => s.line !== undefined);
  const held = deps.listen !== undefined || !needsListener ? { listen: deps.listen ?? null, release: () => {} } : await defaultListener();
  try { return await verifyFile({ ...input, path }, { run: deps.run, ffmpeg, ffprobe, listen: held.listen, signal, progress: (percent, status) => progress({ percent, status }) }); } finally { held.release(); }
}

/** The Stack's own listening engine (the stt role), or null when it is not installed. The session is held for the whole job and released after. */
async function defaultListener(): Promise<{ listen: Listener | null; release: () => void }> {
  const { transcriptionAvailable, transcriptionDeps } = await import("@/speech/transcriptionJobs");
  if (!transcriptionAvailable()) return { listen: null, release: () => {} };
  const { openRoleSession } = await import("@/lib/supervisor");
  const session = await openRoleSession("stt");
  return { release: () => session.release(), listen: async (samples, s) => (await transcriptionDeps.transcribe(session.baseUrl, samples, undefined, s, session.engineHeaders)).text ?? "" };
}
