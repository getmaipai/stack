// SPATIAL-07: sound-source follow. The speech op (SPATIAL-02/03) puts a talker's voice where he stands; this puts the other sound of a clip where its
// visible source is, and only when the clip's own audio did not already do it. Measured 2026-11-07 (spatial-07-effects-bench): LTX-2.5 pans a moving
// source by itself (a walker, a train) and gives dual-mono for a fixed one (a knock), so the first thing here is a GATE on the audio, and the pan is
// the exception. Position sources, all from the picture, nothing typed by default:
//   walker  - the tracked person box centre (a person who travels across the frame);
//   vehicle - Look with the `all` vocabulary, train/car/bus/truck/boat, the LEADING box edge in the direction of travel (a train wider than the frame
//             has a flat centre);
//   impact  - the dominant-motion region (column centroid of frame differences) at each energy onset, for fixed things such as a knock;
//   side    - an explicit left or right from the request, an override only (the picture and the prompt do not always agree).
// Music, a source nobody can see, a moving camera (impact only: a pan moves every source) and doubt (several of one class, no clear region) stay centred.
// Retention (Robot vision R1): frames are read and deleted, the audio and the grey frames live in a private folder removed before this returns. No
// box, label or position is logged. No model is added; CPU only.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Runner } from "./run";
import { boxPosition, framePosition, sampleFramesArgs, SPATIAL_BATCH, SPATIAL_FPS, smoothPositions, type TrackDetection } from "./spatialTrack";

export const EFFECTS_DUAL_MONO_CORRELATION = 0.98;
export const EFFECTS_SPATIAL_RANGE = 0.5;
/** A dual-mono clip (correlation 0.98+) whose level already sits to one side is a static pan, not a centred source: not re-panned. */
export const EFFECTS_STATIC_PAN = 0.25;
/** Native balance must correlate with the person track at least this much for the speech op to leave a clip alone. */
export const PERSON_TRACK_CORRELATION = 0.6;
/** The position of a user-given side. */
export const SIDE_POSITION = 0.6;
export const ANALYSIS_RATE = 16_000;
const BALANCE_WINDOW_S = 0.5;
/** Windows more than this far under the loudest one are silence for the balance measures. */
const AUDIBLE_DB = 35;
const MIN_COVERAGE = 0.3;
const WALK_RANGE = 0.4;
const CENTERED_BELOW = 0.05;
const MAX_KNOTS = 64;
const EVENT_HOLD_S = 0.45;
const EVENT_LEAD_S = 0.05;
const EVENT_WINDOW_S = 0.5;
export const VEHICLE_LABELS = ["train", "car", "bus", "truck", "boat"] as const;

export const MOTION_W = 104;
export const MOTION_H = 60;
const MOTION_DIFF = 12;
const MOTION_MIN_PIXELS = 12;

// ---- the audio: gate numbers ----

export interface AudioWindow { t: number; balance: number; db: number; audible: boolean; }
export interface AudioStats {
  /** Pearson correlation of the left and right channels over the clip (1 for silence). */
  correlation: number;
  /** Per half second: (R - L) / (R + L) of the RMS levels, -1 left .. +1 right. */
  windows: AudioWindow[];
  /** Largest minus smallest balance over the audible windows. */
  balance_range: number;
  /** Energy onsets: +10 dB in 30 ms, at least 0.25 s apart. */
  onsets: Array<{ t: number; rise_db: number }>;
  duration_s: number;
}

export function analyzeStereo(samples: Float32Array, rate: number = ANALYSIS_RATE): AudioStats {
  const n = Math.floor(samples.length / 2);
  let sl = 0, sr = 0;
  for (let i = 0; i < n; i++) { sl += samples[2 * i]!; sr += samples[2 * i + 1]!; }
  const ml = n ? sl / n : 0, mr = n ? sr / n : 0;
  let cov = 0, vl = 0, vr = 0;
  for (let i = 0; i < n; i++) { const a = samples[2 * i]! - ml, b = samples[2 * i + 1]! - mr; cov += a * b; vl += a * a; vr += b * b; }
  const correlation = vl > 1e-12 && vr > 1e-12 ? Math.max(-1, Math.min(1, cov / Math.sqrt(vl * vr))) : 1;

  const win = Math.round(BALANCE_WINDOW_S * rate);
  const windows: AudioWindow[] = [];
  const spans: Array<[number, number]> = [];
  for (let a = 0; a + win <= n; a += win) spans.push([a, a + win]);
  if (spans.length === 0 && n > 0) spans.push([0, n]);
  for (const [a, b] of spans) {
    let el = 0, er = 0;
    for (let i = a; i < b; i++) { el += samples[2 * i]! ** 2; er += samples[2 * i + 1]! ** 2; }
    const l = Math.sqrt(el / (b - a) + 1e-12), r = Math.sqrt(er / (b - a) + 1e-12);
    windows.push({ t: a / rate, balance: (r - l) / (r + l), db: 20 * Math.log10((l + r) / 2), audible: false });
  }
  const peak = Math.max(-Infinity, ...windows.map((w) => w.db));
  for (const w of windows) w.audible = w.db >= peak - AUDIBLE_DB;
  const audible = windows.filter((w) => w.audible).map((w) => w.balance);
  const balance_range = audible.length > 1 ? Math.max(...audible) - Math.min(...audible) : 0;
  return { correlation, windows, balance_range, onsets: onsetsOf(samples, n, rate), duration_s: n / rate };
}

/** A line-for-line port of the bench's onset detector (effects_analyze.py `onsets`). */
function onsetsOf(samples: Float32Array, n: number, rate: number): Array<{ t: number; rise_db: number }> {
  const hop = Math.round(0.01 * rate), w = Math.round(0.03 * rate);
  const db: number[] = [];
  for (let i = 0; i < n - w; i += hop) {
    let e = 0;
    for (let j = i; j < i + w; j++) { const m = (samples[2 * j]! + samples[2 * j + 1]!) / 2; e += m * m; }
    db.push(20 * Math.log10(Math.sqrt(e / w + 1e-12) + 1e-9));
  }
  if (db.length < 10) return [];
  const peak = Math.max(...db);
  const out: Array<{ t: number; rise_db: number }> = [];
  for (let i = 6; i < db.length - 3; i++) {
    const base = Math.min(db[i - 6]!, db[i - 5]!, db[i - 4]!);
    const here = db[i + 2]!;
    let local = -Infinity; for (let j = i - 1; j < Math.min(db.length, i + 6); j++) local = Math.max(local, db[j]!);
    if (here - base >= 10 && here > peak - 45 && here >= local - 0.5) {
      const t = (i + 1) * 0.01;
      if (out.length === 0 || t - out[out.length - 1]!.t >= 0.25) out.push({ t: Math.round(t * 100) / 100, rise_db: Math.round((here - base) * 10) / 10 });
    }
  }
  return out;
}

export type EffectsGate = "dual_mono" | "already_spatial" | "between";
/**
 * The gate of the effects pan. Dual mono (correlation 0.98 or more, and not already leaning to one side): the sound has no direction, pan it.
 * Correlation under 0.98 with a balance range of 0.5 or more: the engine already placed it, leave it alone. In between: leave it alone.
 */
export function effectsGate(stats: Pick<AudioStats, "correlation" | "balance_range"> & { windows?: AudioWindow[] }): EffectsGate {
  if (stats.correlation >= EFFECTS_DUAL_MONO_CORRELATION) {
    const audible = (stats.windows ?? []).filter((w) => w.audible);
    const lean = audible.length ? Math.abs(audible.reduce((sum, w) => sum + w.balance, 0) / audible.length) : 0;
    return lean >= EFFECTS_STATIC_PAN || stats.balance_range >= EFFECTS_SPATIAL_RANGE ? "already_spatial" : "dual_mono";
  }
  return stats.balance_range >= EFFECTS_SPATIAL_RANGE ? "already_spatial" : "between";
}

const pearson = (a: number[], b: number[]): number => {
  const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / b.length;
  let c = 0, va = 0, vb = 0;
  a.forEach((x, i) => { c += (x - ma) * (b[i]! - mb); va += (x - ma) ** 2; vb += (b[i]! - mb) ** 2; });
  return va > 1e-9 && vb > 1e-9 ? c / Math.sqrt(va * vb) : NaN;
};
const interp = (series: number[], t: number, dt: number): number => {
  if (series.length === 0) return 0;
  const x = t / dt - 0.5; const i = Math.floor(x); const f = x - i;
  const a = series[Math.max(0, Math.min(series.length - 1, i))]!, b = series[Math.max(0, Math.min(series.length - 1, i + 1))]!;
  return a + (b - a) * f;
};

/**
 * The speech op's skip: the clip's own balance already ranges by 0.5 or more AND correlates with where the person is. `smoothed` is the smoothed
 * person position per sampled frame. A still speaker has nothing to correlate with, so a native swing that does not follow him does not skip.
 */
export function nativeTracksPerson(stats: AudioStats, smoothed: number[], dt: number = 1 / SPATIAL_FPS): boolean {
  if (stats.balance_range < EFFECTS_SPATIAL_RANGE) return false;
  const rows = stats.windows.filter((w) => w.audible).map((w) => [w.balance, interp(smoothed, w.t + BALANCE_WINDOW_S / 2, dt)] as const);
  if (rows.length < 4) return false;
  const r = pearson(rows.map((x) => x[0]), rows.map((x) => x[1]));
  return Number.isFinite(r) && r >= PERSON_TRACK_CORRELATION;
}

// ---- position sources ----

const area = (box: number[]): number => (box[2] ?? 0) * (box[3] ?? 0);

/** A person who is found in enough frames: raw positions per frame (2+ people centre on doubt), smoothed, and whether he travels across the frame. */
export function walkerPositions(people: number[][][]): { positions: number[]; coverage: number; walking: boolean } | null {
  const raw = people.map(framePosition);
  const seen = raw.filter((p) => p !== null) as number[];
  if (seen.length === 0) return null;
  const positions = smoothPositions(raw);
  const coverage = seen.length / people.length;
  const lo = Math.min(...positions), hi = Math.max(...positions);
  return { positions, coverage, walking: coverage >= MIN_COVERAGE && hi - lo >= WALK_RANGE };
}

const slope = (xs: number[], ys: number[]): number => {
  const n = xs.length; const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let c = 0, v = 0; xs.forEach((x, i) => { c += (x - mx) * (ys[i]! - my); v += (x - mx) ** 2; });
  return v > 0 ? c / v : 0;
};
const median = (values: number[]): number => { const s = [...values].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

/**
 * Vehicle boxes (Look with the `all` vocabulary): per frame the leading edge in the direction of travel. A box wider than half the frame has a flat
 * centre, so the centre is used only when no direction can be read. An edge that sits on the frame border (a train entering, or one that filled the frame) is not evidence of travel; the edge that moves most while off the border decides.
 * Several of the class that matters in one frame is doubt: no position.
 */
export function vehiclePositions(frames: TrackDetection[][], dt: number = 1 / SPATIAL_FPS): { positions: Array<number | null>; direction: -1 | 0 | 1 } {
  const chosen: Array<number[] | null> = frames.map((detections) => {
    const vehicles = detections.filter((d) => (VEHICLE_LABELS as readonly string[]).includes(d.label));
    if (vehicles.length === 0) return null;
    const best = vehicles.reduce((a, b) => (area(b.box) > area(a.box) ? b : a));
    return vehicles.filter((d) => d.label === best.label).length > 1 ? null : best.box;
  });
  const idx = chosen.flatMap((box, i) => (box ? [i] : []));
  let direction: -1 | 0 | 1 = 0;
  if (idx.length >= 4) {
    // Each edge is read only while it is off the frame border (a train entering has its far edge pinned, a train that filled the frame has both);
    // the edge that moved most decides the direction of travel.
    const edgeSlope = (edge: (box: number[]) => number, pinned: (x: number) => boolean): number => {
      const pts = idx.map((i) => [i * dt, edge(chosen[i]!)] as const).filter(([, x]) => !pinned(x));
      return pts.length >= 4 ? slope(pts.map((p) => p[0]), pts.map((p) => p[1])) : 0;
    };
    const sl = edgeSlope((b) => b[0]!, (x) => x <= 0.03), sr = edgeSlope((b) => b[0]! + b[2]!, (x) => x >= 0.97);
    const strongest = Math.abs(sl) >= Math.abs(sr) ? sl : sr;
    if (Math.abs(strongest) >= 0.02) direction = strongest > 0 ? 1 : -1;
  }
  const positions = chosen.map((box) => {
    if (!box) return null;
    if (direction === 0) return boxPosition(box);
    const edge = direction < 0 ? box[0]! : box[0]! + box[2]!;
    return Math.max(-1, Math.min(1, 2 * edge - 1));
  });
  return { positions, direction };
}

// ---- the picture: motion ----

export interface MotionPair { columns: Float32Array; changed: number; }
/** Per adjacent pair of grey frames (w x h bytes): the number of changed pixels per column (a difference over 12 grey levels) and the total. */
export function motionPairs(frames: Uint8Array[], w: number = MOTION_W, h: number = MOTION_H): MotionPair[] {
  const out: MotionPair[] = [];
  for (let k = 0; k + 1 < frames.length; k++) {
    const a = frames[k]!, b = frames[k + 1]!;
    const columns = new Float32Array(w); let changed = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { if (Math.abs(b[y * w + x]! - a[y * w + x]!) > MOTION_DIFF) { columns[x]! += 1; changed++; } }
    out.push({ columns, changed });
  }
  return out;
}

/**
 * The dominant-motion region of one pair as a position, -1 (left) to +1 (right): the centroid of the columns around the strongest bump. Nothing
 * moving, or a second bump of similar size well apart from the first (two regions), is doubt: null.
 */
export function motionPosition(pair: MotionPair, w: number = MOTION_W): number | null {
  if (pair.changed < MOTION_MIN_PIXELS) return null;
  const box = 4;
  const sm = new Float32Array(w);
  for (let x = 0; x < w; x++) { let s = 0; for (let j = -box; j <= box; j++) s += pair.columns[Math.max(0, Math.min(w - 1, x + j))]!; sm[x] = s / (2 * box + 1); }
  let p1 = 0; for (let x = 1; x < w; x++) if (sm[x]! > sm[p1]!) p1 = x;
  const reach = Math.round(w * 0.17);
  let second = 0;
  for (let x = 0; x < w; x++) if (Math.abs(x - p1) > 2 * reach) second = Math.max(second, sm[x]!);
  if (second >= 0.6 * sm[p1]!) return null;
  let mass = 0, moment = 0;
  for (let x = Math.max(0, p1 - reach); x <= Math.min(w - 1, p1 + reach); x++) { mass += sm[x]!; moment += sm[x]! * ((x + 0.5) / w); }
  return mass > 0 ? Math.max(-1, Math.min(1, 2 * (moment / mass) - 1)) : null;
}

/** True when the whole picture slides, shakes or zooms (a moving camera): most pairs match far better after a small global shift. */
export function cameraMoving(frames: Uint8Array[], w: number = MOTION_W, h: number = MOTION_H): boolean {
  const pairs = frames.length - 1;
  if (pairs < 2) return false;
  const step = Math.max(1, Math.floor(pairs / 200));
  const mx = 6, my = 3, margin = 8;
  let tested = 0, moved = 0;
  for (let k = 0; k < pairs; k += step) {
    const a = frames[k]!, b = frames[k + 1]!;
    const sad = (dx: number, dy: number): number => {
      let s = 0;
      for (let y = margin; y < h - margin; y++) for (let x = margin; x < w - margin; x++) s += Math.abs(b[(y + dy) * w + x + dx]! - a[y * w + x]!);
      return s;
    };
    const base = sad(0, 0); const px = (w - 2 * margin) * (h - 2 * margin);
    tested++;
    if (base / px < 1) continue;
    let best = base;
    for (let dy = -my; dy <= my; dy++) for (let dx = -mx; dx <= mx; dx++) { if (dx || dy) best = Math.min(best, sad(dx, dy)); }
    if (best < 0.7 * base) moved++;
  }
  return tested > 0 && moved >= 0.5 * tested;
}

// ---- impacts, knots ----

export interface ImpactEvent { start_s: number; end_s: number; position: number; }
/**
 * One event per energy onset: the middle of the dominant-motion positions within half a second either side (pair i is centred at (i + 0.5) dt). An
 * onset with no motion near it, or doubt, is left out. Events do not overlap; each holds 0.45 s or until the next one starts.
 */
export function impactEvents(onsets: Array<{ t: number; rise_db: number }>, motion: Array<number | null>, dt: number = 1 / SPATIAL_FPS): ImpactEvent[] {
  const found: Array<{ t: number; position: number }> = [];
  for (const { t } of onsets) {
    const near = motion.flatMap((p, i) => (p !== null && Math.abs((i + 0.5) * dt - t) <= EVENT_WINDOW_S ? [p] : []));
    if (near.length) found.push({ t, position: median(near) });
  }
  return found.map((e, i) => ({ start_s: Math.max(0, e.t - EVENT_LEAD_S), end_s: Math.min(e.t + EVENT_HOLD_S, (found[i + 1]?.t ?? Infinity) - EVENT_LEAD_S - 0.01), position: e.position }));
}

export type Knot = [number, number];
/** Strictly increasing times (at least 1 ms apart), values clamped to -1..1. */
export function tidyKnots(knots: Knot[]): Knot[] {
  const out: Knot[] = [];
  for (const [t, v] of [...knots].sort((a, b) => a[0] - b[0])) {
    const time = out.length && t <= out[out.length - 1]![0] ? out[out.length - 1]![0] + 1e-3 : t;
    out.push([Math.round(time * 1e4) / 1e4, Math.max(-1, Math.min(1, v))]);
  }
  return out;
}
const valueAt = (knots: Knot[], t: number): number => {
  if (knots.length === 0) return 0;
  if (t <= knots[0]![0]) return knots[0]![1];
  for (let i = 0; i + 1 < knots.length; i++) { const [t0, v0] = knots[i]!, [t1, v1] = knots[i + 1]!; if (t <= t1) return t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0); }
  return knots[knots.length - 1]![1];
};

/** Knots for impact events: a position held over each event, a glide to the middle between events that are far apart, a straight line between near ones. */
export function eventKnots(events: ImpactEvent[], durationS: number, glide: number = 0.15): Knot[] {
  const knots: Knot[] = [[0, 0]];
  let prev: ImpactEvent | null = null;
  for (const e of events) {
    if (prev && e.start_s - prev.end_s < 0.3) knots.push([prev.end_s, prev.position], [e.start_s, e.position]);
    else { if (prev) knots.push([prev.end_s, prev.position], [prev.end_s + glide, 0]); knots.push([Math.max(0, e.start_s - glide), 0], [e.start_s, e.position]); }
    prev = e;
  }
  if (prev) knots.push([prev.end_s, prev.position], [prev.end_s + glide, 0]);
  knots.push([Math.max(durationS + glide, (knots.at(-1)?.[0] ?? 0) + 1e-3), 0]);
  return tidyKnots(knots);
}

/** Drops knots a straight line already explains (to within 0.03) and, past `max`, thins evenly; the ends stay. */
export function decimateKnots(knots: Knot[], max: number = MAX_KNOTS, tolerance: number = 0.03): Knot[] {
  if (knots.length <= 2) return knots;
  const keep = new Set<number>([0, knots.length - 1]);
  const walk = (a: number, b: number): void => {
    let worst = -1, at = -1;
    for (let i = a + 1; i < b; i++) { const [t0, v0] = knots[a]!, [t1, v1] = knots[b]!; const err = Math.abs(knots[i]![1] - (v0 + ((v1 - v0) * (knots[i]![0] - t0)) / (t1 - t0))); if (err > worst) { worst = err; at = i; } }
    if (at >= 0 && worst > tolerance) { keep.add(at); walk(a, at); walk(at, b); }
  };
  walk(0, knots.length - 1);
  let out = [...keep].sort((a, b) => a - b).map((i) => knots[i]!);
  if (out.length > max) out = Array.from({ length: max }, (_, i) => out[Math.round((i * (out.length - 1)) / (max - 1))]!);
  return out;
}

/**
 * The position curve of the effects pan outside speech, added to the speech curve. The effect is faded to nothing inside each speech window (and for
 * `glide` seconds either side), so a spoken line keeps the speaker's side and nothing stacks.
 */
export function mergeKnots(speech: Knot[], effect: Knot[], speechWindows: Array<{ start_s: number; end_s: number }>, glide: number = 0.15): Knot[] {
  const mask = (t: number): number => { let m = 1; for (const w of speechWindows) { const d = t < w.start_s ? w.start_s - t : t > w.end_s ? t - w.end_s : 0; m = Math.min(m, Math.min(1, d / glide)); } return m; };
  const times = new Set<number>();
  for (const [t] of speech) times.add(t);
  for (const [t] of effect) times.add(t);
  for (const w of speechWindows) { times.add(w.start_s - glide); times.add(w.start_s); times.add(w.end_s); times.add(w.end_s + glide); }
  const last = Math.max(speech.at(-1)?.[0] ?? 0, effect.at(-1)?.[0] ?? 0);
  return tidyKnots([...times].filter((t) => t >= 0 && t <= last).sort((a, b) => a - b).map((t) => [t, valueAt(speech, t) + valueAt(effect, t) * mask(t)] as Knot));
}

// ---- the track ----

export interface EffectsTrack { kind: "walker" | "vehicle" | "impact" | "side"; knots: Knot[]; events: number; }
export interface EffectsOptions {
  ffmpeg: string; source: string; work: string; run: Runner; signal: AbortSignal; durationS: number;
  stats: AudioStats;
  /** Person boxes of each sampled frame, from the speech track (household vocabulary). */
  people: number[][][];
  /** Every Look detection of each JPEG with the `all` vocabulary, in order. */
  lookAll: (frames: Uint8Array[], signal: AbortSignal) => Promise<TrackDetection[][]>;
  side?: "left" | "right";
  progress?: (percent: number, status: string) => void;
}

export function grayFramesArgs(ffmpeg: string, source: string, out: string): string[] {
  return [ffmpeg, "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-i", source, "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", `fps=${SPATIAL_FPS},scale=${MOTION_W}:${MOTION_H}:flags=area,format=gray`, "-f", "rawvideo", out];
}
export function stereoAnalysisArgs(ffmpeg: string, source: string, out: string): string[] {
  return [ffmpeg, "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-i", source, "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "2", "-ar", String(ANALYSIS_RATE), "-c:a", "pcm_f32le", "-f", "f32le", out];
}

/** The audio numbers of a clip (correlation, balance per half second, onsets), or null when the sound cannot be read (the clip is then treated as before). */
export async function analyzeClipAudio(options: { ffmpeg: string; source: string; work: string; run: Runner; signal: AbortSignal }): Promise<AudioStats | null> {
  mkdirSync(options.work, { recursive: true });
  const dir = mkdtempSync(join(options.work, "spatial-audio-"));
  try {
    const file = join(dir, "audio.f32");
    const made = await options.run(stereoAnalysisArgs(options.ffmpeg, options.source, file), { signal: options.signal });
    if (made.aborted || options.signal.aborted) throw new Error("Cancelled.");
    if (made.code !== 0) return null;
    const raw = readFileSync(file);
    return analyzeStereo(new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength - (raw.byteLength % 8))), ANALYSIS_RATE);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const continuous = (positions: Array<number | null>, durationS: number, dt: number): Knot[] => {
  const smooth = smoothPositions(positions, dt);
  const points: Knot[] = smooth.map((p, i) => [(i + 0.5) * dt, p]);
  return tidyKnots(decimateKnots([[0, smooth[0] ?? 0], ...points, [Math.max(durationS, (points.at(-1)?.[0] ?? 0) + dt), smooth.at(-1) ?? 0]]));
};
const centered = (knots: Knot[]): boolean => knots.every(([, v]) => Math.abs(v) < CENTERED_BELOW);

/**
 * The effects pan for a dual-mono clip (the caller has applied the gate): where the visible source of the non-speech sound is over time, or null
 * when there is none to trust (music, nothing visible, a moving camera on an impact clip, doubt).
 */
export async function computeEffectsTrack(options: EffectsOptions): Promise<EffectsTrack | null> {
  const { stats, durationS, signal } = options;
  const dt = 1 / SPATIAL_FPS;
  const cancelled = () => { if (signal.aborted) throw new Error("Cancelled."); };

  if (options.side) {
    const position = options.side === "left" ? -SIDE_POSITION : SIDE_POSITION;
    if (stats.onsets.length) {
      const events = stats.onsets.map((o, i) => ({ start_s: Math.max(0, o.t - EVENT_LEAD_S), end_s: Math.min(o.t + EVENT_HOLD_S, (stats.onsets[i + 1]?.t ?? Infinity) - EVENT_LEAD_S - 0.01), position }));
      return { kind: "side", knots: decimateKnots(eventKnots(events, durationS)), events: events.length };
    }
    return { kind: "side", knots: tidyKnots([[0, position], [Math.max(durationS, 0.01), position]]), events: 0 };
  }

  const walker = walkerPositions(options.people);
  if (walker?.walking) {
    const raw = options.people.map(framePosition);
    const knots = continuous(raw, durationS, dt);
    return centered(knots) ? null : { kind: "walker", knots, events: 0 };
  }

  mkdirSync(options.work, { recursive: true });
  const dir = mkdtempSync(join(options.work, "spatial-effects-"));
  try {
    // vehicles: Look with the all vocabulary
    options.progress?.(10, "looking for what makes the sound");
    const sampled = await options.run(sampleFramesArgs(options.ffmpeg, options.source, dir), { signal });
    if (sampled.aborted || signal.aborted) throw new Error("Cancelled.");
    if (sampled.code === 0) {
      const names = readdirSync(dir).filter((name) => /^f\d+\.jpg$/.test(name)).sort();
      const detections: TrackDetection[][] = [];
      for (let at = 0; at < names.length; at += SPATIAL_BATCH) {
        cancelled();
        const jpegs = names.slice(at, at + SPATIAL_BATCH).map((name) => { const path = join(dir, name); const bytes = new Uint8Array(readFileSync(path)); rmSync(path, { force: true }); return bytes; });
        const found = await options.lookAll(jpegs, signal);
        for (let i = 0; i < jpegs.length; i++) detections.push(found[i] ?? []);
      }
      const vehicle = vehiclePositions(detections, dt);
      if (vehicle.positions.filter((p) => p !== null).length >= MIN_COVERAGE * Math.max(1, detections.length)) {
        const knots = continuous(vehicle.positions, durationS, dt);
        return centered(knots) ? null : { kind: "vehicle", knots, events: 0 };
      }
    }

    // fixed impacts: the dominant-motion region at each onset, only for a still or slow camera
    if (stats.onsets.length === 0) return null;
    cancelled();
    options.progress?.(60, "finding what moves");
    const gray = join(dir, "frames.gray");
    const grey = await options.run(grayFramesArgs(options.ffmpeg, options.source, gray), { signal });
    if (grey.aborted || signal.aborted) throw new Error("Cancelled.");
    if (grey.code !== 0) return null;
    const bytes = readFileSync(gray);
    const size = MOTION_W * MOTION_H; const count = Math.floor(bytes.length / size);
    const frames = Array.from({ length: count }, (_, i) => new Uint8Array(bytes.buffer, bytes.byteOffset + i * size, size));
    if (frames.length < 2 || cameraMoving(frames)) return null;
    const motion = motionPairs(frames).map((pair) => motionPosition(pair));
    const events = impactEvents(stats.onsets, motion, dt);
    if (events.length === 0 || events.every((e) => Math.abs(e.position) < CENTERED_BELOW)) return null;
    return { kind: "impact", knots: decimateKnots(eventKnots(events, durationS)), events: events.length };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
