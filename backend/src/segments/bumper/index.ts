// Ad-slot bumpers: a show's own stinger, a run of DIGITAL silence (the slot networks drop ads
// into), and the same stinger again. The two slots of a show repeat the same sounds, so the
// audio on each side of a silence is compared with the same side of another slot (or with a
// bumper learned from an earlier episode of the show). The stinger ends where the match stops.
//
// Measured on real episodes (10 ms frames, 24 log-spectrum bands): the stinger is the run of frames next
// to the silence that matches the same side of another slot (frame cosine about 0.9 inside, below 0.6 once
// speech resumes). Lead and tail are measured separately because they differ.
import { createHash } from "node:crypto";
import { fft } from "../align/fft";
import type { Features } from "../align/features";
import type { MediaSegmentT } from "../core/types";

export interface DigitalSilence { startSec: number; endSec: number }
/** What the Stack keeps per show: the stinger audio as spectrum frames (10 ms each, 24 bands). */
export interface LearnedBumper { fingerprint: string; leadFrames: number[][]; tailFrames: number[][] }

export const BUMPER_RATE = 100;          // frames per second
const BANDS = 24;
const MATCH_EDGE = 0.8, MATCH_RUN = 0.7, MAX_EXTENT = 2.5, LONE_CONFIDENCE = 0.4, LONE_LENGTH = 0.7;

export function findDigitalSilences(samples: Float32Array | Int16Array, sampleRate: number, minSec = 0.25): DigitalSilence[] {
  if (!(sampleRate > 0) || !(minSec >= 0)) throw new Error("Invalid sample rate or minimum silence duration.");
  const limit = samples instanceof Int16Array ? 2 : 2 / 32768;
  const min = Math.ceil(sampleRate * minSec), out: DigitalSilence[] = [];
  let start = -1;
  for (let i = 0; i <= samples.length; i++) {
    const silent = i < samples.length && Math.abs(samples[i]!) <= limit;
    if (silent && start < 0) start = i;
    if (!silent && start >= 0) { if (i - start >= min) out.push({ startSec: start / sampleRate, endSec: i / sampleRate }); start = -1; }
  }
  return out;
}

/** 10 ms, 24-band log spectra of a signal, computed lazily and cached per frame. */
class FrameSource {
  private cache = new Map<number, Float64Array>();
  private size: number; private fftN: number; private hann: Float64Array; private bandOf: Int16Array;
  constructor(private samples: Float32Array | Int16Array | null, private features: Features | null, private rate: number) {
    this.size = Math.max(8, Math.round(rate * 0.01));
    let n = 16; while (n < this.size * 1.6) n *= 2;
    this.fftN = n;
    this.hann = Float64Array.from({ length: this.size }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / Math.max(1, this.size - 1)));
    const top = Math.min(8000, rate / 2), lo = 200;
    this.bandOf = new Int16Array(n / 2 + 1).fill(-1);
    for (let k = 0; k <= n / 2; k++) { const f = k * rate / n; if (f >= lo && f < top) this.bandOf[k] = Math.min(BANDS - 1, Math.floor((f - lo) / (top - lo) * BANDS)); }
  }
  get length(): number {
    if (this.features) return this.features.n;
    return Math.floor((this.samples?.length ?? 0) / this.size);
  }
  frame(i: number): Float64Array | null {
    if (i < 0 || i >= this.length) return null;
    const hit = this.cache.get(i); if (hit) return hit;
    const out = new Float64Array(BANDS);
    if (this.features) {
      const per = Math.max(1, Math.floor(this.features.data.length / Math.max(1, this.features.n)));
      for (let b = 0; b < BANDS; b++) out[b] = this.features.data[i * per + Math.min(b, per - 1)] ?? 0;
    } else {
      const s = this.samples!, re = new Float64Array(this.fftN), im = new Float64Array(this.fftN), scale = s instanceof Int16Array ? 1 / 32768 : 1;
      for (let j = 0; j < this.size; j++) re[j] = (s[i * this.size + j] ?? 0) * scale * this.hann[j]!;
      fft(re, im);
      const e = new Float64Array(BANDS);
      for (let k = 0; k <= this.fftN / 2; k++) { const b = this.bandOf[k]!; if (b >= 0) e[b]! += re[k]! * re[k]! + im[k]! * im[k]!; }
      for (let b = 0; b < BANDS; b++) out[b] = Math.log(e[b]! + 1e-9);
    }
    if (this.cache.size > 20000) this.cache.clear();
    this.cache.set(i, out);
    return out;
  }
}

/** Cosine between two frames after removing each frame's own mean (the spectral shape, not the level). */
function frameSim(fa: Float64Array | null, fb: Float64Array | null): number {
  if (!fa || !fb) return 0;
  let ma = 0, mb = 0; for (let j = 0; j < BANDS; j++) { ma += fa[j]!; mb += fb[j]!; } ma /= BANDS; mb /= BANDS;
  let dot = 0, aa = 0, bb = 0; for (let j = 0; j < BANDS; j++) { const p = fa[j]! - ma, q = fb[j]! - mb; dot += p * q; aa += p * p; bb += q * q; }
  return aa > 0 && bb > 0 ? dot / Math.sqrt(aa * bb) : 0;
}

type Side = "lead" | "tail";
/**
 * Per-frame similarity moving away from a silence edge, one point per 10 ms up to MAX_EXTENT.
 * `ref(d)` is the other occurrence's frame at distance d from its own silence edge on the same side.
 */
function profile(side: Side, own: FrameSource, ownEdge: number, ref: (d: number) => Float64Array | null): number[] {
  const out: number[] = [];
  for (let d = 0; d < Math.round(MAX_EXTENT * BUMPER_RATE); d++) {
    const f = side === "lead" ? own.frame(ownEdge - d - 1) : own.frame(ownEdge + d);
    const g = ref(d);
    if (!f || !g) break;
    out.push(frameSim(f, g));
  }
  return out;
}

/**
 * Stinger length in seconds from a per-frame profile, or 0 when the stinger next to the silence does not match.
 * The stinger ends where the next 0.2 s of frames stop matching (mean below 0.7); a 0.2 s margin covers the
 * lag of that forward-looking mean. Measured on two real shows: lead 0.68 and 0.75 s, tail 0.79 and 0.66 s before
 * the margin, against stingers of about 0.8 / 1.0 and 0.8 / 0.8 s heard and measured by loudness.
 */
export function extentFromProfile(p: number[]): { length: number; edge: number } {
  if (p.length < 20) return { length: 0, edge: 0 };
  const edge = p.slice(3, 13).reduce((a, b) => a + b, 0) / 10;
  if (edge < MATCH_EDGE) return { length: 0, edge };
  let exit = p.length;
  for (let d = 10; d + 20 <= p.length; d++) {
    let m = 0; for (let k = 0; k < 20; k++) m += p[d + k]!; m /= 20;
    if (m < MATCH_RUN) { exit = d; break; }
  }
  return { length: Math.min(MAX_EXTENT, exit / BUMPER_RATE + 0.2), edge };
}
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };

function frameRun(src: FrameSource, from: number, count: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < count; i++) { const f = src.frame(from + i); out.push(f ? Array.from(f) : new Array<number>(BANDS).fill(0)); }
  return out;
}

export interface BumperResult { segments: MediaSegmentT[]; learnedBumper: LearnedBumper[] }

export function bumperCandidates(input: Features | Float32Array | Int16Array, silences: DigitalSilence[], learned: LearnedBumper[] = [], sampleRate = 16000): BumperResult {
  const isFeatures = !(input instanceof Float32Array || input instanceof Int16Array);
  const src = new FrameSource(isFeatures ? null : input as Float32Array | Int16Array, isFeatures ? input as Features : null, sampleRate);
  const slots = silences.filter((s) => s.endSec - s.startSec >= 0.25);
  type Cand = { s: DigitalSilence; lead: number; tail: number; sim: number; matched: boolean };
  const cands: Cand[] = [];
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i]!, aStart = Math.round(s.startSec * BUMPER_RATE), aEnd = Math.round(s.endSec * BUMPER_RATE);
    const leads: number[] = [], tails: number[] = [], edges: number[] = [];
    for (let j = 0; j < slots.length; j++) {
      if (j === i) continue;
      const o = slots[j]!, bStart = Math.round(o.startSec * BUMPER_RATE), bEnd = Math.round(o.endSec * BUMPER_RATE);
      const l = extentFromProfile(profile("lead", src, aStart, (d) => src.frame(bStart - d - 1)));
      const t = extentFromProfile(profile("tail", src, aEnd, (d) => src.frame(bEnd + d)));
      if (l.length > 0 && t.length > 0) { leads.push(l.length); tails.push(t.length); edges.push((l.edge + t.edge) / 2); }
    }
    for (const lb of learned) {
      const L = lb.leadFrames.length, T = lb.tailFrames.length; if (!L || !T) continue;
      // Learned frames end at the silence (lead) / start at it (tail); compare through the same profile code.
      const leadRef = (d: number) => { const f = lb.leadFrames[L - 1 - d]; return f ? Float64Array.from(f) : null; };
      const tailRef = (d: number) => { const f = lb.tailFrames[d]; return f ? Float64Array.from(f) : null; };
      const l = extentFromProfile(profile("lead", src, aStart, leadRef)), t = extentFromProfile(profile("tail", src, aEnd, tailRef));
      if (l.length > 0 && t.length > 0) { leads.push(Math.min(l.length, L / BUMPER_RATE)); tails.push(Math.min(t.length, T / BUMPER_RATE)); edges.push((l.edge + t.edge) / 2); }
    }
    if (leads.length) cands.push({ s, lead: median(leads), tail: median(tails), sim: Math.max(...edges), matched: true });
    else if (slots.length === 1 && learned.length === 0) cands.push({ s, lead: LONE_LENGTH, tail: LONE_LENGTH, sim: LONE_CONFIDENCE, matched: false });
  }
  const segments: MediaSegmentT[] = [], learnedBumper: LearnedBumper[] = [];
  for (const c of cands) {
    const groupId = `bumper-${createHash("sha256").update(`${c.s.startSec}:${c.s.endSec}`).digest("hex").slice(0, 16)}`;
    const parts: Array<["lead-stinger" | "slot" | "tail-stinger", number, number]> = [
      ["lead-stinger", Math.max(0, c.s.startSec - c.lead), c.s.startSec], ["slot", c.s.startSec, c.s.endSec], ["tail-stinger", c.s.endSec, c.s.endSec + c.tail],
    ];
    parts.forEach(([slotRole, startSec, endSec], j) => {
      if (endSec > startSec) segments.push({ id: `${groupId}-${j}`, kind: "bumper", startSec, endSec, confidence: c.sim, source: "fingerprint", sources: ["fingerprint"], status: c.matched ? "auto" : "held", slotRole, groupId });
    });
    if (c.matched) {
      const leadN = Math.round(c.lead * BUMPER_RATE), tailN = Math.round(c.tail * BUMPER_RATE);
      const leadFrames = frameRun(src, Math.round(c.s.startSec * BUMPER_RATE) - leadN, leadN), tailFrames = frameRun(src, Math.round(c.s.endSec * BUMPER_RATE), tailN);
      const fingerprint = createHash("sha256").update(JSON.stringify([leadFrames.slice(0, 20), tailFrames.slice(0, 20)])).digest("hex").slice(0, 32);
      if (!learnedBumper.some((x) => x.fingerprint === fingerprint)) learnedBumper.push({ fingerprint, leadFrames, tailFrames });
    }
  }
  return { segments, learnedBumper };
}
