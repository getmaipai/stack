// Small radix-2 FFT (no dependency). Used by the clean-reference aligner.

const twiddles = new Map<number, { cos: Float64Array; sin: Float64Array; rev: Uint32Array }>();

function tables(n: number) {
  let t = twiddles.get(n);
  if (t) return t;
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    rev[i] = r;
  }
  t = { cos, sin, rev };
  twiddles.set(n, t);
  return t;
}

export function isPowerOfTwo(n: number): boolean {
  return n > 1 && (n & (n - 1)) === 0;
}

/** In-place complex FFT. `inverse` applies the 1/n scale. n must be a power of two. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (!isPowerOfTwo(n) || im.length !== n) throw new Error(`fft: length ${n} must be a power of two and re/im equal`);
  if (inverse) {
    const t = re; re = im; im = t; // conjugate trick: swap, forward, swap back
  }
  const { cos, sin, rev } = tables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i]!;
    if (j > i) {
      let t = re[i]!; re[i] = re[j]!; re[j] = t;
      t = im[i]!; im[i] = im[j]!; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0, w = 0; k < half; k++, w += step) {
        const wr = cos[w]!, wi = sin[w]!;
        const a = start + k, b = a + half;
        const xr = re[b]! * wr - im[b]! * wi;
        const xi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - xr; im[b] = im[a]! - xi;
        re[a] = re[a]! + xr; im[a] = im[a]! + xi;
      }
    }
  }
  if (inverse) {
    const s = 1 / n;
    for (let i = 0; i < n; i++) { re[i] = re[i]! * s; im[i] = im[i]! * s; }
  }
}

/**
 * After `fft` of z = a + i*b (a, b real), split into the half spectra (bins 0..n/2)
 * of a and b. Outputs must have length n/2 + 1.
 */
export function splitPair(zr: Float64Array, zi: Float64Array, aRe: Float64Array, aIm: Float64Array, bRe: Float64Array, bIm: Float64Array): void {
  const n = zr.length;
  const mask = n - 1;
  for (let k = 0; k <= n / 2; k++) {
    const m = (n - k) & mask;
    aRe[k] = (zr[k]! + zr[m]!) / 2;
    aIm[k] = (zi[k]! - zi[m]!) / 2;
    bRe[k] = (zi[k]! + zi[m]!) / 2;
    bIm[k] = -(zr[k]! - zr[m]!) / 2;
  }
}
