// Find the audio inserted into a stitched copy of an episode, given the clean copy.
// 1. Block cross-correlation (6 s blocks of the stitched file against the clean file, FFT
//    overlap-save) gives a (stitched time, clean time) pair per block.
// 2. The pairs' time differences (deltas) are histogrammed to discover the offset levels.
// 3. Each level is tracked frame by frame; frames are labelled by the best level or NO MATCH,
//    majority smoothed, and NO MATCH runs of at least minInsertSec are the inserted ranges.

import { BANDS, HOP_SEC, type Features } from "./features";
import { fft, splitPair } from "./fft";

export interface AlignOptions {
  blockFrames?: number;      // default 120 (6 s)
  blockStepFrames?: number;  // default 60 (3 s)
  fftSize?: number;          // overlap-save size, default 4096
  minBlockScore?: number;    // block match worth a histogram vote, default 0.4
  minSupport?: number;       // blocks needed to keep a delta level, default 3
  jitterFrames?: number;     // +-search around each level, default 10
  smoothFrames?: number;     // similarity smoothing, default 40 (2 s)
  matchThreshold?: number;   // label threshold, default 0.45
  majorityFrames?: number;   // majority window, default 100 (5 s each side: 10 s)
  minInsertSec?: number;     // default 4
  maxLevels?: number;        // default 24
}
export interface Inserted { startSec: number; endSec: number; confidence: number }
export interface Level { deltaSec: number; fromSec: number; toSec: number }
export interface AlignResult { inserted: Inserted[]; levels: Level[]; candidateDeltasSec: number[] }

interface BlockMatch { start: number; offset: number; score: number }

/** Best clean-file position for each block of the stitched file (cross-correlation via FFT). */
export function blockMatches(ref: Features, st: Features, o: Required<Pick<AlignOptions, "blockFrames" | "blockStepFrames" | "fftSize">>): BlockMatch[] {
  const W = o.blockFrames, N = o.fftSize, H = N / 2 + 1, step = N - W + 1;
  if (ref.n < W || st.n < W) return [];
  const nChunks = Math.ceil((ref.n - W + 1) / step);
  // Reference chunk spectra, per band (half spectra).
  const fRe = new Float64Array(nChunks * BANDS * H), fIm = new Float64Array(nChunks * BANDS * H);
  const zr = new Float64Array(N), zi = new Float64Array(N);
  const aR = new Float64Array(H), aI = new Float64Array(H), bR = new Float64Array(H), bI = new Float64Array(H);
  for (let c = 0; c < nChunks; c++) {
    const s0 = c * step;
    for (let p = 0; p < BANDS / 2; p++) {
      zr.fill(0); zi.fill(0);
      for (let t = 0; t < N && s0 + t < ref.n; t++) { zr[t] = ref.data[(s0 + t) * BANDS + 2 * p]!; zi[t] = ref.data[(s0 + t) * BANDS + 2 * p + 1]!; }
      fft(zr, zi);
      splitPair(zr, zi, aR, aI, bR, bI);
      let off = (c * BANDS + 2 * p) * H; fRe.set(aR, off); fIm.set(aI, off);
      off += H; fRe.set(bR, off); fIm.set(bI, off);
    }
  }
  const starts: number[] = [];
  for (let s = 0; s + W <= st.n; s += o.blockStepFrames) starts.push(s);
  const out: BlockMatch[] = [];
  const bRe = new Float64Array(2 * BANDS * H), bIm = new Float64Array(2 * BANDS * H); // [block][band]
  const c1r = new Float64Array(H), c1i = new Float64Array(H), c2r = new Float64Array(H), c2i = new Float64Array(H);
  const norm = 1 / (BANDS * W);
  for (let i = 0; i < starts.length; i += 2) {
    const pair = [starts[i]!, i + 1 < starts.length ? starts[i + 1]! : -1];
    for (let q = 0; q < 2; q++) {
      for (let p = 0; p < BANDS / 2; p++) {
        zr.fill(0); zi.fill(0);
        if (pair[q]! >= 0) for (let t = 0; t < W; t++) { zr[t] = st.data[(pair[q]! + t) * BANDS + 2 * p]!; zi[t] = st.data[(pair[q]! + t) * BANDS + 2 * p + 1]!; }
        fft(zr, zi);
        splitPair(zr, zi, aR, aI, bR, bI);
        let off = (q * BANDS + 2 * p) * H; bRe.set(aR, off); bIm.set(aI, off);
        off += H; bRe.set(bR, off); bIm.set(bI, off);
      }
    }
    const best = [{ v: -Infinity, g: 0 }, { v: -Infinity, g: 0 }];
    for (let c = 0; c < nChunks; c++) {
      c1r.fill(0); c1i.fill(0); c2r.fill(0); c2i.fill(0);
      for (let k = 0; k < BANDS; k++) {
        const fo = (c * BANDS + k) * H, b1 = k * H, b2 = (BANDS + k) * H;
        for (let m = 0; m < H; m++) {
          const ar = fRe[fo + m]!, ai = fIm[fo + m]!;
          // A * conj(B)
          c1r[m] = c1r[m]! + ar * bRe[b1 + m]! + ai * bIm[b1 + m]!;
          c1i[m] = c1i[m]! + ai * bRe[b1 + m]! - ar * bIm[b1 + m]!;
          c2r[m] = c2r[m]! + ar * bRe[b2 + m]! + ai * bIm[b2 + m]!;
          c2i[m] = c2i[m]! + ai * bRe[b2 + m]! - ar * bIm[b2 + m]!;
        }
      }
      // Z = C1 + i*C2 with Hermitian fill, inverse gives c1 in re and c2 in im.
      for (let m = 0; m < H; m++) {
        zr[m] = c1r[m]! - c2i[m]!; zi[m] = c1i[m]! + c2r[m]!;
        if (m > 0 && m < N / 2) { zr[N - m] = c1r[m]! + c2i[m]!; zi[N - m] = -c1i[m]! + c2r[m]!; }
      }
      fft(zr, zi, true);
      const s0 = c * step;
      const maxO = Math.min(N - W, ref.n - W - s0);
      for (let o2 = 0; o2 <= maxO; o2++) {
        const g = s0 + o2;
        const v1 = zr[o2]!, v2 = zi[o2]!;
        if (v1 > best[0]!.v) { best[0]!.v = v1; best[0]!.g = g; }
        if (v2 > best[1]!.v) { best[1]!.v = v2; best[1]!.g = g; }
      }
    }
    for (let q = 0; q < 2; q++) if (pair[q]! >= 0) out.push({ start: pair[q]!, offset: best[q]!.g, score: best[q]!.v * norm });
  }
  return out;
}

/** Candidate deltas (frames, stitched minus clean), from block votes plus the length difference. */
export function discoverDeltas(blocks: BlockMatch[], refN: number, stN: number, minScore: number, minSupport: number, maxLevels: number): number[] {
  const perSec = Math.round(1 / HOP_SEC);
  const bins = new Map<number, number[]>();
  for (const b of blocks) {
    if (b.score < minScore) continue;
    const d = b.start - b.offset;
    const key = Math.round(d / perSec);
    (bins.get(key) ?? bins.set(key, []).get(key)!).push(d);
  }
  const ranked = [...bins.entries()].sort((a, b) => b[1].length - a[1].length);
  const taken: number[] = []; // bin keys
  const out: number[] = [];
  for (const [key, ds] of ranked) {
    if (ds.length < minSupport || out.length >= maxLevels) continue;
    if (taken.some((t) => Math.abs(t - key) <= 1)) continue;
    const near = [...(bins.get(key - 1) ?? []), ...ds, ...(bins.get(key + 1) ?? [])].sort((a, b) => a - b);
    taken.push(key);
    out.push(near[near.length >> 1]!);
  }
  const total = stN - refN; // implied by total length: all insertions stacked
  for (const d of [0, total]) if (d >= 0 && !out.some((x) => Math.abs(x - d) <= perSec)) out.push(d);
  return out.sort((a, b) => a - b);
}

/** Smoothed best similarity of the stitched frames against the clean file shifted by `delta` frames (+-jitter). */
function trackLevel(ref: Features, st: Features, delta: number, jitter: number, smooth: number): Float32Array {
  const nB = st.n, nA = ref.n;
  const best = new Float32Array(nB).fill(-1);
  const raw = new Float32Array(nB);
  const pre = new Float64Array(nB + 1);
  const half = smooth >> 1;
  for (let jit = -jitter; jit <= jitter; jit++) {
    const sh = delta + jit;
    for (let i = 0; i < nB; i++) {
      const j = i - sh;
      if (j < 0 || j >= nA) { raw[i] = -1; continue; }
      let s = 0; const bo = i * BANDS, ao = j * BANDS;
      for (let k = 0; k < BANDS; k++) s += st.data[bo + k]! * ref.data[ao + k]!;
      raw[i] = s / BANDS;
    }
    for (let i = 0; i < nB; i++) pre[i + 1] = pre[i]! + raw[i]!;
    // moving average, window `smooth` centred (zero padded past the ends, like numpy 'same')
    for (let i = 0; i < nB; i++) {
      const lo = Math.max(0, i - half + (smooth % 2 === 0 ? 1 : 0)), hi = Math.min(nB, i + half + 1);
      const v = (pre[hi]! - pre[lo]!) / smooth;
      if (v > best[i]!) best[i] = v;
    }
  }
  return best;
}

export function alignClean(ref: Features, st: Features, opts: AlignOptions = {}): AlignResult {
  const o = {
    blockFrames: 120, blockStepFrames: 60, fftSize: 4096, minBlockScore: 0.4, minSupport: 3, jitterFrames: 10,
    smoothFrames: 40, matchThreshold: 0.45, majorityFrames: 100, minInsertSec: 4, maxLevels: 24, ...opts,
  };
  const empty: AlignResult = { inserted: [], levels: [], candidateDeltasSec: [] };
  if (ref.n < o.blockFrames || st.n < 1) return empty;
  const blocks = blockMatches(ref, st, o);
  const deltas = discoverDeltas(blocks, ref.n, st.n, o.minBlockScore, o.minSupport, o.maxLevels);
  const nB = st.n, D = deltas.length;
  const tracks = deltas.map((d) => trackLevel(ref, st, d, o.jitterFrames, o.smoothFrames));
  const lab = new Int16Array(nB), top = new Float32Array(nB);
  for (let i = 0; i < nB; i++) {
    let bi = -1, bv = -Infinity;
    for (let d = 0; d < D; d++) { const v = tracks[d]![i]!; if (v > bv) { bv = v; bi = d; } }
    top[i] = bv;
    lab[i] = bv < o.matchThreshold ? -1 : bi;
  }
  // Sliding-window majority over labels (-1 is label index D).
  const w = o.majorityFrames, sm = new Int16Array(nB), cnt = new Int32Array(D + 1);
  const idx = (l: number) => (l < 0 ? D : l);
  let lo = 0, hi = 0; // window [lo, hi)
  for (let i = 0; i < nB; i++) {
    const wl = Math.max(0, i - (w >> 1)), wh = Math.min(nB, i + (w >> 1));
    while (hi < wh) cnt[idx(lab[hi++]!)]!++;
    while (lo < wl) cnt[idx(lab[lo++]!)]!--;
    let bi = idx(lab[i]!), bv = cnt[bi]!;
    for (let d = 0; d <= D; d++) if (cnt[d]! > bv) { bv = cnt[d]!; bi = d; }
    sm[i] = bi === D ? -1 : bi;
  }
  const inserted: Inserted[] = [], levels: Level[] = [];
  let s = 0;
  for (let i = 1; i <= nB; i++) {
    if (i < nB && sm[i] === sm[s]) continue;
    const label = sm[s]!, from = s * HOP_SEC, to = i * HOP_SEC;
    if (label >= 0) levels.push({ deltaSec: deltas[label]! * HOP_SEC, fromSec: from, toSec: to });
    else if (to - from >= o.minInsertSec) {
      let m = 0; for (let k = s; k < i; k++) m += top[k]!;
      m /= i - s;
      inserted.push({ startSec: from, endSec: to, confidence: Math.max(0, Math.min(1, 1 - m / o.matchThreshold)) });
    }
    s = i;
  }
  return { inserted, levels, candidateDeltasSec: deltas.map((d) => d * HOP_SEC) };
}
