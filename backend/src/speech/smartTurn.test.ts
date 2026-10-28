import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { smartTurnProbability, whisperFeatures } from "@/speech/smartTurn";

function tone(seconds: number, hz: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * 16000));
  for (let i = 0; i < out.length; i++) out[i] = 0.3 * Math.sin((2 * Math.PI * hz * i) / 16000);
  return out;
}

describe("whisperFeatures", () => {
  test("gives 80 mel rows by 800 frames, all finite, inside Whisper's range", () => {
    const f = whisperFeatures(tone(1.5, 440));
    expect(f.length).toBe(80 * 800);
    let min = Infinity;
    let max = -Infinity;
    for (const v of f) {
      expect(Number.isFinite(v)).toBe(true);
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    // (log10 power clamped to max-8, plus 4) / 4 spans at most 2 units.
    expect(max - min).toBeLessThanOrEqual(2 + 1e-6);
  });

  test("keeps only the last 8 s of a longer clip", () => {
    const long = new Float32Array(10 * 16000);
    long.set(tone(2, 300), 0); // the first 2 s fall outside the window
    long.set(tone(8, 1000), 2 * 16000);
    const a = whisperFeatures(long);
    const b = whisperFeatures(tone(8, 1000));
    expect(a.length).toBe(b.length);
    let worst = 0;
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
    expect(worst).toBeLessThan(1e-4);
  });

  test("an empty clip does not throw", () => {
    expect(whisperFeatures(new Float32Array(0)).length).toBe(80 * 800);
  });
});

// The 8 MB model is downloaded, never vendored: set SMART_TURN_MODEL to a local copy of smart-turn-v3.2-cpu.onnx.
const MODEL = process.env.SMART_TURN_MODEL;
describe.skipIf(!MODEL || !existsSync(MODEL))("smartTurnProbability with the real model", () => {
  test("returns a probability between 0 and 1", async () => {
    const p = await smartTurnProbability(MODEL!, tone(1.5, 220));
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  });
});
