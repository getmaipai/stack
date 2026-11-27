// Audio features for clean-reference alignment: 8 kHz mono, 50 ms hop, 16 log-energy
// bands (about 40 Hz to 4 kHz), z-scored per band over the whole file.

import { fft } from "./fft";

export const SAMPLE_RATE = 8000;
export const HOP = 400; // 50 ms
export const HOP_SEC = HOP / SAMPLE_RATE;
export const BANDS = 16;
const NFFT = 512; // 400-sample frame zero-padded; band edges mapped by frequency

export interface Features {
  /** Number of frames. */
  n: number;
  /** n * BANDS values, frame-major, z-scored per band. */
  data: Float32Array;
}

const edges = (() => {
  // Prototype edges: linspace(2, 200, 17) on a 400-point grid (20 Hz per bin), mapped to 512 points.
  const e: number[] = [];
  for (let i = 0; i <= BANDS; i++) e.push(Math.round(Math.floor(2 + (198 * i) / BANDS) * (NFFT / HOP)));
  return e;
})();
const hann = (() => {
  const w = new Float64Array(HOP);
  for (let i = 0; i < HOP; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (HOP - 1));
  return w;
})();

/** Incremental extractor so a long file never has to sit in memory as samples. */
export function createExtractor() {
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  let raw = new Float32Array(1 << 16);
  let n = 0;
  let carry = new Float32Array(HOP);
  let carryLen = 0;
  function frame(x: Float32Array, off: number) {
    re.fill(0); im.fill(0);
    for (let i = 0; i < HOP; i++) re[i] = x[off + i]! * hann[i]!;
    fft(re, im);
    if ((n + 1) * BANDS > raw.length) {
      const g = new Float32Array(raw.length * 2); g.set(raw); raw = g;
    }
    for (let b = 0; b < BANDS; b++) {
      let s = 0;
      for (let k = edges[b]!; k < edges[b + 1]!; k++) s += re[k]! * re[k]! + im[k]! * im[k]!;
      raw[n * BANDS + b] = Math.log(s + 1e-8);
    }
    n++;
  }
  return {
    push(samples: Float32Array) {
      let off = 0;
      if (carryLen > 0) {
        const need = HOP - carryLen;
        if (samples.length < need) { carry.set(samples, carryLen); carryLen += samples.length; return; }
        carry.set(samples.subarray(0, need), carryLen);
        frame(carry, 0); carryLen = 0; off = need;
      }
      while (off + HOP <= samples.length) { frame(samples, off); off += HOP; }
      if (off < samples.length) { carry.set(samples.subarray(off), 0); carryLen = samples.length - off; }
    },
    finish(): Features {
      const data = raw.slice(0, n * BANDS);
      for (let b = 0; b < BANDS; b++) {
        let mean = 0;
        for (let i = 0; i < n; i++) mean += data[i * BANDS + b]!;
        mean /= Math.max(1, n);
        let v = 0;
        for (let i = 0; i < n; i++) { const d = data[i * BANDS + b]! - mean; v += d * d; }
        const sd = Math.sqrt(v / Math.max(1, n)) + 1e-6;
        for (let i = 0; i < n; i++) data[i * BANDS + b] = (data[i * BANDS + b]! - mean) / sd;
      }
      return { n, data };
    },
  };
}

/** Pure: features of 8 kHz mono float samples. */
export function featuresFromSamples(samples: Float32Array): Features {
  const ex = createExtractor();
  ex.push(samples);
  return ex.finish();
}

export interface DecodeOptions {
  /** ffmpeg executable; default "ffmpeg". */
  ffmpegPath?: string;
}

/** Decode a media file with ffmpeg (streamed, never the whole PCM in memory) and extract features. */
export async function featuresFromFile(path: string, opts: DecodeOptions = {}): Promise<Features> {
  const proc = Bun.spawn(
    [opts.ffmpegPath ?? "ffmpeg", "-nostdin", "-v", "error", "-i", path, "-f", "f32le", "-ar", String(SAMPLE_RATE), "-ac", "1", "-"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const errText = new Response(proc.stderr).text();
  const ex = createExtractor();
  let rest = new Uint8Array(0);
  for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
    let bytes: Uint8Array = chunk;
    if (rest.length) { const m = new Uint8Array(rest.length + chunk.length); m.set(rest); m.set(chunk, rest.length); bytes = m; }
    const usable = bytes.length - (bytes.length % 4);
    const copy = bytes.slice(0, usable); // aligned copy
    ex.push(new Float32Array(copy.buffer, 0, usable / 4));
    rest = bytes.slice(usable);
  }
  const code = await proc.exited;
  if (code !== 0) throw new Error(`ffmpeg failed decoding ${path} (exit ${code}): ${(await errText).slice(0, 300)}`);
  const f = ex.finish();
  if (f.n === 0) throw new Error(`no audio decoded from ${path}`);
  return f;
}
