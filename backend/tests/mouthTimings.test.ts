import { expect, test } from "bun:test";
import { decodeMouthWave, mouthWords } from "@/speech/mouthTimings";

function wave({ channels = 1, rate = 24_000, bits = 16, encoding = 1, seconds = 0.01 }: { channels?: number; rate?: number; bits?: number; encoding?: number; seconds?: number } = {}) {
  const frames = Math.round(rate * seconds), width = bits / 8, dataSize = frames * channels * width;
  const bytes = new Uint8Array(44 + dataSize), view = new DataView(bytes.buffer);
  const tag = (at: number, value: string) => { for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i); };
  tag(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); tag(8, "WAVE"); tag(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, encoding, true); view.setUint16(22, channels, true); view.setUint32(24, rate, true); view.setUint32(28, rate * channels * width, true); view.setUint16(32, channels * width, true); view.setUint16(34, bits, true); tag(36, "data"); view.setUint32(40, dataSize, true);
  for (let i = 0; i < frames * channels; i++) {
    const at = 44 + i * width;
    if (encoding === 3) view.setFloat32(at, i % 2 ? -0.5 : 0.5, true);
    else if (bits === 16) view.setInt16(at, i % 2 ? -16384 : 16384, true);
    else if (bits === 24) { const n = i % 2 ? -4194304 : 4194304; bytes[at] = n & 255; bytes[at + 1] = (n >> 8) & 255; bytes[at + 2] = (n >> 16) & 255; }
    else view.setInt32(at, i % 2 ? -1073741824 : 1073741824, true);
  }
  return bytes;
}

test("decodes 16-bit mono 24 kHz and averages 32-bit float stereo 44.1 kHz", () => {
  const pcm = decodeMouthWave(wave());
  expect(pcm.sampleRate).toBe(24_000); expect(pcm.samples.length).toBe(240); expect(pcm.samples[0]).toBe(0.5);
  const floating = decodeMouthWave(wave({ channels: 2, rate: 44_100, bits: 32, encoding: 3 }));
  expect(floating.sampleRate).toBe(44_100); expect(floating.samples.length).toBe(441); expect(floating.samples[0]).toBe(0);
});

test("turns recognizer token timestamps into rounded word spans", () => {
  expect(mouthWords({ tokens: ["▁hello", " world"], timestamps: [0.1234, 0.4567] }, 0.9)).toEqual([
    { text: "hello", start: 0.123, end: 0.457 }, { text: "world", start: 0.457, end: 0.9 },
  ]);
});

test("missing token timestamps trigger level fallback", () => {
  expect(mouthWords({ tokens: ["▁hello"] }, 1)).toBeNull();
});
