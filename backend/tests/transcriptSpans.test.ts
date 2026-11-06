import { expect, test } from "bun:test";
import { splitSpeechSpans, validateRange, wordsFromTokenTimes } from "@/speech/transcriptSpans";
import type { VoiceDetector } from "@/speech/session";

function detectorFor(voicedFrames: Set<number>): VoiceDetector {
  let frame = 0;
  return { push: () => voicedFrames.has(frame++), reset: () => { frame = 0; } };
}

test("Silero spans are padded, merged across short gaps, and split after the hangover", () => {
  const signal = new Float32Array(512 * 20);
  const spans = splitSpeechSpans(signal, detectorFor(new Set([2, 3, 4, 6, 7, 16])), { paddingSeconds: 0, hangoverFrames: 2 });
  expect(spans).toEqual([{ startSample: 1024, endSample: 4096 }, { startSample: 8192, endSample: 8704 }]);
});

test("token times group into words and add the source range offset", () => {
  expect(wordsFromTokenTimes(["▁Hello", "▁world", "!"], [0.1, 0.5, 0.8], 1, 12)).toEqual([
    { text: "Hello", start: 12.1, end: 12.5 },
    { text: "world!", start: 12.5, end: 13 },
  ]);
});

test("range windows must be supplied together and ordered", () => {
  expect(validateRange()).toEqual({ fromS: 0 });
  expect(validateRange(20, 45)).toEqual({ fromS: 20, toS: 45 });
  expect(() => validateRange(20)).toThrow("Send from_s and to_s together.");
  expect(() => validateRange(20, 20)).toThrow("to_s must be after from_s and from_s cannot be negative.");
});
