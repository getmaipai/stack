// SPATIAL-02: where the speaker is on screen while he talks. Frames are sampled at 4 a second and handed to the Look worker (person boxes only),
// the speech spans come from the Stack's own Silero detector, and the answer is a short list of { start_s, end_s, position } with position
// -1 (left edge) .. 0 (middle) .. +1 (right edge). Bench verdict SPATIAL-01 (NARROW): one visible person is placed by his box centre; two or
// more people in a frame centre the dialog (no motion tie-break); nobody found (a cartoon, an empty room) is a plain "unchanged stereo".
// Retention (Robot vision R1, look once and drop): the frames and the audio live in a private folder that is emptied as it is read and deleted
// when the track is done, on every path. No box, label or position is logged; callers log counts and milliseconds.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { decodeWave, toRecognizerRate } from "@/speech/audio";
import type { Runner } from "./run";

export const SPATIAL_FPS = 4;
export const SPATIAL_FRAME_WIDTH = 416;
export const SPATIAL_MAX_SEGMENTS = 64;
/** Frames read into memory at a time; each is deleted from disk as it is read. */
export const SPATIAL_BATCH = 60;
const MEDIAN_WINDOW = 5;
const MAX_SLEW_PER_S = 0.6;
const HOLD_S = 1.5;
const GLIDE_S = 0.5;
const LONG_SPAN_S = 4;
const RESPLIT_MOVE = 0.25;
const CENTERED_BELOW = 0.02;

export interface SpatialSegment { start_s: number; end_s: number; position: number; }
/** Why a clip gets no direction. null means a position was found. */
export type SpatialReason = "no_person" | "no_speech" | "several_people" | "centered" | "already_spatial";
/** What the track saw, kept in memory for the effects pan (SPATIAL-07): person boxes per sampled frame, the speech spans in seconds, the smoothed person position per frame. Never logged, never returned to a caller. */
export interface SpatialTrackDetail { people: number[][][]; spans_s: Array<{ start_s: number; end_s: number }>; smoothed: number[]; }
/** `detail` is a non-enumerable property set by computeSpatialTrack, so a track compares and serializes as before. */
export interface SpatialTrack { segments: SpatialSegment[]; reason: SpatialReason | null; frames: number; people_frames: number; speech_spans: number; detail?: SpatialTrackDetail; }
export interface SpeechSampleSpan { startSample: number; endSample: number; }
/** A Look detection as the track reads it: only the label and the [x, y, w, h] box (0..1 of the frame) matter. */
export interface TrackDetection { label: string; box: number[]; }

/** The failure a caller reports: the code is stable, the message is the plain line. */
export class SpatialError extends Error {
  constructor(readonly code: string, message: string, readonly detail?: string) { super(message); }
}

export interface SpatialTrackDeps {
  /** Person boxes for each JPEG, in order (the Look worker's lookFrames). */
  look(frames: Uint8Array[], signal: AbortSignal): Promise<TrackDetection[][]>;
  /** Speech spans of a mono 16 kHz signal (the speech worker's Silero detector). */
  speech(samples: Float32Array, signal: AbortSignal): Promise<SpeechSampleSpan[]>;
  /** SPATIAL-07: every Look detection (the `all` vocabulary: trains, cars, boats) for each JPEG. Absent in a test double that only gives `look`; then `look` answers. */
  lookAll?(frames: Uint8Array[], signal: AbortSignal): Promise<TrackDetection[][]>;
}

// ---- pure functions ----

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const median = (values: number[]): number => { const sorted = [...values].sort((a, b) => a - b); const mid = sorted.length >> 1; return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2; };

/** `2x - 1` for the box centre x (a Look box is [x, y, width, height] as a share of the frame). */
export function boxPosition(box: number[]): number {
  return clamp(2 * ((box[0] ?? 0) + (box[2] ?? 0) / 2) - 1, -1, 1);
}

/** One frame: nobody is null, one person is his box centre, two or more are 0 (centre on doubt; the bench's motion tie-break reached 71%, under the 80% bar). */
export function framePosition(people: number[][]): number | null {
  if (people.length === 0) return null;
  if (people.length > 1) return 0;
  return boxPosition(people[0]!);
}

/** Holds the last position for 1.5 s without a person, then glides to the middle over 0.5 s; median of 5; then at most 0.6 units a second. */
export function smoothPositions(raw: Array<number | null>, dt: number = 1 / SPATIAL_FPS): number[] {
  const held: number[] = [];
  let last: number | null = null; let lastAt = -Infinity;
  raw.forEach((value, i) => {
    if (value !== null) { last = value; lastAt = i * dt; held.push(value); return; }
    if (last === null) { held.push(0); return; }
    const gap = i * dt - lastAt;
    held.push(gap <= HOLD_S + 1e-9 ? last : last * Math.max(0, 1 - (gap - HOLD_S) / GLIDE_S));
  });
  const half = MEDIAN_WINDOW >> 1;
  const med = held.map((_, i) => median(held.slice(Math.max(0, i - half), i + half + 1)));
  const out: number[] = [];
  med.forEach((value, i) => {
    if (i === 0) { out.push(value); return; }
    const limit = MAX_SLEW_PER_S * dt;
    out.push(out[i - 1]! + clamp(value - out[i - 1]!, -limit, limit));
  });
  return out;
}

/** One value per speech span (median of the smoothed samples inside it); a span over 4 s starts a new segment when the median moves by more than 0.25. */
export function speechSegments(spans: Array<{ start_s: number; end_s: number }>, smoothed: number[], dt: number = 1 / SPATIAL_FPS): SpatialSegment[] {
  const segments: SpatialSegment[] = [];
  const fallback = smoothed.at(-1) ?? 0;
  for (const { start_s: a, end_s: b } of spans) {
    if (!(b > a)) continue;
    const first = Math.floor(a / dt + 1e-9);
    const values = smoothed.slice(first, Math.max(first + 1, Math.ceil(b / dt - 1e-9)));
    if (values.length === 0) { segments.push({ start_s: a, end_s: b, position: fallback }); continue; }
    if (b - a <= LONG_SPAN_S) { segments.push({ start_s: a, end_s: b, position: median(values) }); continue; }
    let from = a; let current = median(values.slice(0, 8)); let window: number[] = [];
    values.forEach((value, j) => {
      window.push(value);
      if (window.length >= 8 && Math.abs(median(window.slice(-8)) - current) > RESPLIT_MOVE) {
        const at = a + j * dt;
        segments.push({ start_s: from, end_s: at, position: current });
        from = at; current = median(window.slice(-8)); window = [];
      }
    });
    segments.push({ start_s: from, end_s: b, position: current });
  }
  return segments;
}

/** At most `max` segments: the two neighbours with the nearest positions merge (the merged one covers both and takes their length-weighted position). */
export function limitSegments(segments: SpatialSegment[], max: number = SPATIAL_MAX_SEGMENTS): SpatialSegment[] {
  const list = segments.map((segment) => ({ ...segment }));
  while (list.length > max) {
    let best = 0; let bestGap = Infinity;
    for (let i = 0; i + 1 < list.length; i++) {
      const gap = Math.abs(list[i]!.position - list[i + 1]!.position);
      if (gap < bestGap) { bestGap = gap; best = i; }
    }
    const a = list[best]!; const b = list[best + 1]!;
    const wa = Math.max(1e-6, a.end_s - a.start_s); const wb = Math.max(1e-6, b.end_s - b.start_s);
    list.splice(best, 2, { start_s: a.start_s, end_s: b.end_s, position: (a.position * wa + b.position * wb) / (wa + wb) });
  }
  return list;
}

/** The whole answer from the person boxes of each sampled frame and the speech spans in seconds. */
export function buildTrack(frames: number[][][], spans: Array<{ start_s: number; end_s: number }>, dt: number = 1 / SPATIAL_FPS): SpatialTrack {
  const raw = frames.map(framePosition);
  const peopleFrames = frames.filter((people) => people.length > 0).length;
  const severalFrames = frames.filter((people) => people.length > 1).length;
  const base = { frames: frames.length, people_frames: peopleFrames, speech_spans: spans.length };
  if (peopleFrames === 0) return { ...base, segments: [], reason: "no_person" };
  if (spans.length === 0) return { ...base, segments: [], reason: "no_speech" };
  const segments = limitSegments(speechSegments(spans, smoothPositions(raw, dt), dt), SPATIAL_MAX_SEGMENTS);
  if (segments.every((segment) => Math.abs(segment.position) < CENTERED_BELOW)) return { ...base, segments, reason: severalFrames * 2 >= peopleFrames ? "several_people" : "centered" };
  return { ...base, segments, reason: null };
}

// ---- command lines ----

export function sampleFramesArgs(ffmpeg: string, source: string, dir: string): string[] {
  return [ffmpeg, "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-i", source, "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", `fps=${SPATIAL_FPS},scale=${SPATIAL_FRAME_WIDTH}:-2`, "-q:v", "3", join(dir, "f%05d.jpg")];
}
export function speechAudioArgs(ffmpeg: string, source: string, out: string): string[] {
  return [ffmpeg, "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-i", source, "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", out];
}

// ---- the track ----

export const SPATIAL_PICTURE_UNREADABLE = "The picture of this clip could not be read, so nobody could be placed. Try another clip.";
export const SPATIAL_SOUND_UNREADABLE = "The sound of this clip could not be read, so nobody's speech could be found. Try another clip.";

let depsOverride: SpatialTrackDeps | null = null;
export function setSpatialTrackDepsForTests(deps: Partial<SpatialTrackDeps> | null): void { depsOverride = deps ? { ...defaultSpatialTrackDeps, ...deps } : null; }

/** The real parts, loaded on first use (a dynamic import keeps the speech jobs, which import the media jobs, out of a load cycle). */
export const defaultSpatialTrackDeps: SpatialTrackDeps = {
  look: async (frames, signal) => (await import("@/look/look")).lookService.lookFrames(frames, signal),
  lookAll: async (frames, signal) => (await import("@/look/look")).lookService.lookFrames(frames, signal, "all"),
  speech: async (samples, signal) => {
    const [{ openRoleSession }, { transcriptionDeps }] = await Promise.all([import("@/lib/supervisor"), import("@/speech/transcriptionJobs")]);
    let session;
    try { session = await openRoleSession("stt"); }
    catch (error) { throw new SpatialError("speech_unavailable", `Spatial sound needs the speech part to find when someone talks. An admin can start it in Settings, Models and storage, then try again. (${error instanceof Error ? error.message : "it did not start"})`); }
    try {
      const spans: SpeechSampleSpan[] = [];
      const chunk = 30 * 16_000;
      for (let offset = 0; offset < samples.length; offset += chunk) {
        if (signal.aborted) throw new Error("Cancelled.");
        for (const span of await transcriptionDeps.detect(session.baseUrl, samples.subarray(offset, Math.min(samples.length, offset + chunk)), signal)) spans.push({ startSample: span.startSample + offset, endSample: span.endSample + offset });
      }
      return spans;
    } finally { session.release(); }
  },
};

/** The deps of a run: the test override (if any) over the real parts, then the caller's own. `lookAll` falls back to a double's `look`, never to the real model behind its back. */
export function resolveSpatialTrackDeps(own?: Partial<SpatialTrackDeps>): SpatialTrackDeps & { lookAll: NonNullable<SpatialTrackDeps["lookAll"]> } {
  const merged: SpatialTrackDeps = { ...(depsOverride ?? defaultSpatialTrackDeps), ...(own ?? {}) };
  const explicit = own?.lookAll ?? (depsOverride && depsOverride.lookAll !== defaultSpatialTrackDeps.lookAll ? depsOverride.lookAll : undefined);
  return { ...merged, lookAll: explicit ?? (merged.look !== defaultSpatialTrackDeps.look ? merged.look : defaultSpatialTrackDeps.lookAll!) };
}

function withDetail(track: SpatialTrack, people: number[][][], spans: Array<{ start_s: number; end_s: number }>): SpatialTrack {
  Object.defineProperty(track, "detail", { value: { people, spans_s: spans, smoothed: smoothPositions(people.map(framePosition)) } satisfies SpatialTrackDetail, enumerable: false });
  return track;
}

export interface SpatialTrackOptions {
  ffmpeg: string; source: string;
  /** A folder the job owns; the track makes its own subfolder in it and removes that before it returns. */
  work: string;
  run: Runner; signal: AbortSignal;
  deps?: SpatialTrackDeps | Partial<SpatialTrackDeps>;
  progress?: (percent: number, status: string) => void;
}

export async function computeSpatialTrack(options: SpatialTrackOptions): Promise<SpatialTrack> {
  const deps: SpatialTrackDeps = resolveSpatialTrackDeps(options.deps);
  const { run, signal, progress } = options;
  mkdirSync(options.work, { recursive: true });
  const dir = mkdtempSync(join(options.work, "spatial-track-"));
  const cancelled = () => { if (signal.aborted) throw new Error("Cancelled."); };
  try {
    progress?.(5, "looking for who is on screen");
    const sampled = await run(sampleFramesArgs(options.ffmpeg, options.source, dir), { signal });
    if (sampled.aborted || signal.aborted) throw new Error("Cancelled.");
    if (sampled.code !== 0) throw new SpatialError("spatial_failed", SPATIAL_PICTURE_UNREADABLE);
    const names = readdirSync(dir).filter((name) => /^f\d+\.jpg$/.test(name)).sort();
    const people: number[][][] = [];
    for (let at = 0; at < names.length; at += SPATIAL_BATCH) {
      cancelled();
      const batch = names.slice(at, at + SPATIAL_BATCH);
      const jpegs = batch.map((name) => { const path = join(dir, name); const bytes = new Uint8Array(readFileSync(path)); rmSync(path, { force: true }); return bytes; });
      const found = await deps.look(jpegs, signal);
      for (let i = 0; i < jpegs.length; i++) people.push((found[i] ?? []).filter((item) => item.label === "person").map((item) => item.box));
      progress?.(5 + Math.round(((at + batch.length) / Math.max(1, names.length)) * 55), "looking for who is on screen");
    }
    const peopleFrames = people.filter((frame) => frame.length > 0).length;
    // Nobody anywhere: there is no position to find, so the sound is not read at all.
    if (peopleFrames === 0) return withDetail(buildTrack(people, []), people, []);
    cancelled();
    progress?.(65, "finding when someone talks");
    const wav = join(dir, "speech.wav");
    const extracted = await run(speechAudioArgs(options.ffmpeg, options.source, wav), { signal });
    if (extracted.aborted || signal.aborted) throw new Error("Cancelled.");
    if (extracted.code !== 0) throw new SpatialError("spatial_failed", SPATIAL_SOUND_UNREADABLE);
    const samples = toRecognizerRate(decodeWave(new Uint8Array(readFileSync(wav))));
    rmSync(wav, { force: true });
    const spans = (await deps.speech(samples, signal)).map((span) => ({ start_s: span.startSample / 16_000, end_s: span.endSample / 16_000 }));
    return withDetail(buildTrack(people, spans), people, spans);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
