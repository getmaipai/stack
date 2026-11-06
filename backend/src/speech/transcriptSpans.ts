import type { VoiceDetector } from "@/speech/session";

export interface SpeechSpan { startSample: number; endSample: number; }

/** Split a mono 16 kHz signal using the already-loaded Silero detector. */
export function splitSpeechSpans(samples: Float32Array, detector: VoiceDetector, options: { sampleRate?: number; frameSamples?: number; hangoverFrames?: number; paddingSeconds?: number } = {}): SpeechSpan[] {
  const rate = options.sampleRate ?? 16_000;
  const frame = options.frameSamples ?? 512;
  const hangover = options.hangoverFrames ?? 10;
  const padding = Math.round((options.paddingSeconds ?? 0.12) * rate);
  const spans: SpeechSpan[] = [];
  let start = -1;
  let lastVoiced = -1;
  for (let offset = 0; offset < samples.length; offset += frame) {
    const end = Math.min(samples.length, offset + frame);
    const voiced = detector.push(samples.subarray(offset, end));
    if (voiced) {
      if (start < 0) start = offset;
      lastVoiced = end;
    } else if (start >= 0 && offset - lastVoiced >= frame * hangover) {
      spans.push({ startSample: Math.max(0, start - padding), endSample: Math.min(samples.length, lastVoiced + padding) });
      start = -1;
    }
  }
  if (start >= 0) spans.push({ startSample: Math.max(0, start - padding), endSample: Math.min(samples.length, lastVoiced + padding) });
  return spans.filter((span) => span.endSample > span.startSample);
}

export interface TimedToken { token: string; start: number; }
export interface TimedWord { text: string; start: number; end: number; }

/** Sherpa timestamps are token starts relative to the submitted span. */
export function wordsFromTokenTimes(tokens: string[], timestamps: number[], durationSeconds: number, offsetSeconds = 0): TimedWord[] {
  const count = Math.min(tokens.length, timestamps.length);
  const words: TimedWord[] = [];
  let current = "";
  let start = 0;
  let last = 0;
  const flush = (end: number) => {
    const text = current.trim();
    if (text) words.push({ text, start: Math.round((offsetSeconds + start) * 1000) / 1000, end: Math.round((offsetSeconds + Math.max(start, end)) * 1000) / 1000 });
    current = "";
  };
  for (let index = 0; index < count; index += 1) {
    const token = tokens[index] ?? "";
    const at = Math.max(0, Math.min(durationSeconds, timestamps[index] ?? 0));
    const beginsWord = /^(?:▁|\s)/u.test(token);
    const piece = token.replace(/^▁/u, "");
    if (beginsWord && current) flush(at);
    if (!current) start = at;
    current += piece;
    last = at;
  }
  if (current) flush(durationSeconds);
  return words;
}

export function validateRange(fromS?: number, toS?: number): { fromS: number; toS?: number } {
  if ((fromS === undefined) !== (toS === undefined)) throw new Error("Send from_s and to_s together.");
  if (fromS !== undefined && (fromS < 0 || toS! <= fromS)) throw new Error("to_s must be after from_s and from_s cannot be negative.");
  return { fromS: fromS ?? 0, ...(toS === undefined ? {} : { toS }) };
}
