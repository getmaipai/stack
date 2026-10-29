// Smart Turn v3.2 end-of-turn classifier (pipecat-ai/smart-turn, BSD-2-Clause).
// Reads the last 8 s of 16 kHz speech and answers whether the speaker is done.
// Input is Whisper-style log-mel features [1, 80, 800]; output is one sigmoid
// probability. Runs through onnxruntime-web (WASM) for the same reason the
// Silero loader in Home does: the native addon segfaults under Bun.
// @ts-ignore - no resolvable .d.ts for the ort-web ESM bundle under Bun
import * as ort from "onnxruntime-web";
import type { InferenceSession } from "onnxruntime-web";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isCompiledBinary } from "@/lib/paths";

export const SMART_TURN_SAMPLE_RATE = 16000;
const N_FFT = 400;
const HOP = 160;
const N_MELS = 80;
const WINDOW_SAMPLES = 8 * SMART_TURN_SAMPLE_RATE;
const N_FRAMES = WINDOW_SAMPLES / HOP; // 800
const N_BINS = N_FFT / 2 + 1;

const hann = new Float64Array(N_FFT).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT));

// Slaney-scale mel filterbank with Slaney area normalisation (what Whisper uses).
function hzToMel(hz: number): number {
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / fSp;
  const logStep = Math.log(6.4) / 27;
  return hz >= minLogHz ? minLogMel + Math.log(hz / minLogHz) / logStep : hz / fSp;
}
function melToHz(mel: number): number {
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / fSp;
  const logStep = Math.log(6.4) / 27;
  return mel >= minLogMel ? minLogHz * Math.exp(logStep * (mel - minLogMel)) : fSp * mel;
}
function buildMelFilters(): Float64Array[] {
  const fftFreqs = Array.from({ length: N_BINS }, (_, i) => (i * SMART_TURN_SAMPLE_RATE) / N_FFT);
  const lo = hzToMel(0);
  const hi = hzToMel(SMART_TURN_SAMPLE_RATE / 2);
  const points = Array.from({ length: N_MELS + 2 }, (_, i) => melToHz(lo + ((hi - lo) * i) / (N_MELS + 1)));
  const filters: Float64Array[] = [];
  for (let m = 0; m < N_MELS; m++) {
    const f = new Float64Array(N_BINS);
    const left = points[m]!;
    const centre = points[m + 1]!;
    const right = points[m + 2]!;
    const norm = 2 / (right - left);
    for (let k = 0; k < N_BINS; k++) {
      const hz = fftFreqs[k]!;
      const up = (hz - left) / (centre - left);
      const down = (right - hz) / (right - centre);
      f[k] = Math.max(0, Math.min(up, down)) * norm;
    }
    filters.push(f);
  }
  return filters;
}
const MEL_FILTERS = buildMelFilters();

// Direct DFT against precomputed twiddles: 800 frames x 201 bins x 400 samples
// is 64M multiply-adds, about 60 ms in Bun, inside the endpointer's 250 ms budget.
const COS = new Float64Array(N_BINS * N_FFT);
const SIN = new Float64Array(N_BINS * N_FFT);
for (let k = 0; k < N_BINS; k++) {
  for (let n = 0; n < N_FFT; n++) {
    const angle = (2 * Math.PI * k * n) / N_FFT;
    COS[k * N_FFT + n] = Math.cos(angle);
    SIN[k * N_FFT + n] = Math.sin(angle);
  }
}

function reflectIndex(i: number, n: number): number {
  if (i < 0) return -i;
  if (i >= n) return 2 * (n - 1) - i;
  return i;
}

/** Whisper log-mel for one 8 s window, flattened to [80 * 800] (mel-major). */
export function whisperFeatures(audio: Float32Array): Float32Array {
  // Keep the last 8 s, normalise the real audio to zero mean and unit variance, then zero-pad on the right.
  const tail = audio.length > WINDOW_SAMPLES ? audio.subarray(audio.length - WINDOW_SAMPLES) : audio;
  let mean = 0;
  for (const v of tail) mean += v;
  mean /= Math.max(1, tail.length);
  let variance = 0;
  for (const v of tail) variance += (v - mean) * (v - mean);
  variance /= Math.max(1, tail.length);
  const scale = 1 / Math.sqrt(variance + 1e-7);
  const x = new Float64Array(WINDOW_SAMPLES);
  for (let i = 0; i < tail.length; i++) x[i] = (tail[i]! - mean) * scale;

  const logMel = new Float64Array(N_MELS * N_FRAMES);
  const frame = new Float64Array(N_FFT);
  const power = new Float64Array(N_BINS);
  for (let t = 0; t < N_FRAMES; t++) {
    const start = t * HOP - N_FFT / 2; // center=True with reflect padding
    for (let n = 0; n < N_FFT; n++) frame[n] = x[reflectIndex(start + n, WINDOW_SAMPLES)]! * hann[n]!;
    for (let k = 0; k < N_BINS; k++) {
      let re = 0;
      let im = 0;
      const base = k * N_FFT;
      for (let n = 0; n < N_FFT; n++) {
        re += frame[n]! * COS[base + n]!;
        im -= frame[n]! * SIN[base + n]!;
      }
      power[k] = re * re + im * im;
    }
    for (let m = 0; m < N_MELS; m++) {
      const f = MEL_FILTERS[m]!;
      let sum = 0;
      for (let k = 0; k < N_BINS; k++) sum += f[k]! * power[k]!;
      logMel[m * N_FRAMES + t] = Math.log10(Math.max(sum, 1e-10));
    }
  }
  let max = -Infinity;
  for (const v of logMel) if (v > max) max = v;
  const out = new Float32Array(N_MELS * N_FRAMES);
  for (let i = 0; i < out.length; i++) out[i] = (Math.max(logMel[i]!, max - 8) + 4) / 4;
  return out;
}

let sessionPromise: Promise<InferenceSession> | null = null;

/** Load the model once per process; a failed load is retried on the next call. */
export function loadSmartTurn(modelPath: string): Promise<InferenceSession> {
  if (!sessionPromise) {
    // A compiled binary cannot embed the .mjs/.wasm ort-web loads at runtime;
    // scripts/build-binary.sh ships them in ort-wasm/ beside the binary.
    if (isCompiledBinary) ort.env.wasm.wasmPaths = join(dirname(process.execPath), "ort-wasm") + "/";
    ort.env.wasm.numThreads = 4; // measured on an M-series Mac: 113 ms total at 4 threads, 218 ms at 1
    ort.env.logLevel = "fatal";
    sessionPromise = ort.InferenceSession.create(new Uint8Array(readFileSync(modelPath)), {
      executionProviders: ["wasm"],
    }).catch((err: unknown) => {
      sessionPromise = null;
      throw err;
    });
  }
  return sessionPromise;
}

/** Probability that the speaker has finished their turn, 0 to 1. */
export async function smartTurnProbability(modelPath: string, audio: Float32Array): Promise<number> {
  const session = await loadSmartTurn(modelPath);
  const input = new ort.Tensor("float32", whisperFeatures(audio), [1, N_MELS, N_FRAMES]);
  const result = await session.run({ input_features: input });
  const first = Object.values(result)[0] as { data: Float32Array };
  return first.data[0]!;
}

export function __resetSmartTurnForTests(): void {
  sessionPromise = null;
}
