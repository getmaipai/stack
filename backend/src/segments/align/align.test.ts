import { describe, expect, test } from "bun:test";
import { alignClean } from "./align";
import { BANDS, featuresFromSamples, type Features } from "./features";
import { fft } from "./fft";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
function gauss(r: () => number) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

/** Smooth-ish random feature frames, like speech band energies. */
function randomFeatures(n: number, seed: number): Features {
  const r = rng(seed), data = new Float32Array(n * BANDS), prev = new Float64Array(BANDS);
  for (let i = 0; i < n; i++) for (let b = 0; b < BANDS; b++) {
    prev[b] = 0.8 * prev[b]! + gauss(r);
    data[i * BANDS + b] = prev[b]! * 0.6;
  }
  return { n, data };
}
const slice = (f: Features, a: number, b: number) => f.data.subarray(a * BANDS, b * BANDS);
function concat(parts: Float32Array[]): Features {
  const len = parts.reduce((s, p) => s + p.length, 0), data = new Float32Array(len);
  let o = 0; for (const p of parts) { data.set(p, o); o += p.length; }
  return { n: len / BANDS, data };
}
const sec = (s: number) => Math.round(s / 0.05);

describe("fft", () => {
  test("round trip", () => {
    const re = Float64Array.from({ length: 64 }, (_, i) => Math.sin(i)), im = new Float64Array(64);
    const r0 = re.slice();
    fft(re, im); fft(re, im, true);
    for (let i = 0; i < 64; i++) expect(re[i]!).toBeCloseTo(r0[i]!, 9);
  });
});

describe("features", () => {
  test("frame count and z-score", () => {
    const x = new Float32Array(8000 * 5);
    const r = rng(1); for (let i = 0; i < x.length; i++) x[i] = gauss(r) * (1 + Math.sin(i / 3000));
    const f = featuresFromSamples(x);
    expect(f.n).toBe(100);
    let m = 0; for (let i = 0; i < f.n; i++) m += f.data[i * BANDS + 3]!;
    expect(Math.abs(m / f.n)).toBeLessThan(1e-4);
  });
});

describe("alignClean", () => {
  const ref = randomFeatures(sec(600), 7);
  // inserts: 20 s at 100 s, 35 s at 300 s, 12 s at 450 s (clean times)
  const ins = [{ at: 100, len: 20 }, { at: 300, len: 35 }, { at: 450, len: 12 }];
  function stitch(): Features {
    const parts: Float32Array[] = []; let pos = 0;
    ins.forEach((x, i) => {
      parts.push(slice(ref, pos, sec(x.at)));
      parts.push(slice(randomFeatures(sec(x.len), 100 + i), 0, sec(x.len)));
      pos = sec(x.at);
    });
    parts.push(slice(ref, pos, ref.n));
    return concat(parts);
  }
  const expected = [{ s: 100, e: 120, d: 20 }, { s: 320, e: 355, d: 55 }, { s: 505, e: 517, d: 67 }];

  test("finds three insertions and their deltas", () => {
    const res = alignClean(ref, stitch());
    expect(res.inserted.length).toBe(3);
    res.inserted.forEach((r, i) => {
      expect(Math.abs(r.startSec - expected[i]!.s)).toBeLessThan(2);
      expect(Math.abs(r.endSec - expected[i]!.e)).toBeLessThan(2);
      expect(r.confidence).toBeGreaterThan(0.5);
    });
    const ds = res.levels.map((l) => Math.round(l.deltaSec));
    expect(ds).toEqual([0, 20, 55, 67]);
  });

  test("noisy re-encode-like copy", () => {
    const st = stitch(), r = rng(99);
    for (let i = 0; i < st.data.length; i++) st.data[i] = st.data[i]! + gauss(r) * 0.4;
    const res = alignClean(ref, st);
    expect(res.inserted.length).toBe(3);
    res.inserted.forEach((x, i) => expect(Math.abs(x.startSec - expected[i]!.s)).toBeLessThan(2));
  });

  test("identical files have no insertions", () => {
    const res = alignClean(ref, { n: ref.n, data: ref.data.slice() });
    expect(res.inserted).toEqual([]);
    expect(res.levels.length).toBe(1);
    expect(res.levels[0]!.deltaSec).toBe(0);
  });

  test("speed, 72 minute equivalent", () => {
    const big = randomFeatures(sec(72 * 60), 3);
    const st = concat([slice(big, 0, sec(1000)), slice(randomFeatures(sec(60), 5), 0, sec(60)), slice(big, sec(1000), sec(3000)), slice(randomFeatures(sec(45), 6), 0, sec(45)), slice(big, sec(3000), big.n)]);
    const t0 = performance.now();
    const res = alignClean(big, st);
    const ms = performance.now() - t0;
    console.log(`align 72 min: ${ms.toFixed(0)} ms, ${big.n} frames`);
    expect(res.inserted.length).toBe(2);
    expect(Math.abs(res.inserted[0]!.startSec - 1000)).toBeLessThan(2);
  }, 120000);
});
