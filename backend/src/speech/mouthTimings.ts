import { WaveFormatError } from "@/speech/audio";
import { wordsFromTokenTimes, type TimedWord } from "@/speech/transcriptSpans";

export const MOUTH_TIMINGS_MAX_SECONDS = 30;
export interface MouthTimingResult { words: TimedWord[]; recognizer: string; duration_s: number; }

/** Decode common little-endian RIFF/WAVE PCM and IEEE float files to mono. */
export function decodeMouthWave(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new WaveFormatError("Send a readable WAV file.");
  let fmt: { encoding: number; channels: number; rate: number; bits: number } | null = null;
  for (let at = 12; at + 8 <= bytes.length;) {
    const name = tag(at), size = view.getUint32(at + 4, true), body = at + 8;
    if (body + size > bytes.length) throw new WaveFormatError("The WAV file is incomplete.");
    if (name === "fmt ") {
      if (size < 16) throw new WaveFormatError("The WAV format is unreadable.");
      fmt = { encoding: view.getUint16(body, true), channels: view.getUint16(body + 2, true), rate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    }
    if (name === "data") {
      if (!fmt || ![1, 3].includes(fmt.encoding) || ![16, 24, 32].includes(fmt.bits) || (fmt.encoding === 3 && fmt.bits !== 32) || fmt.channels < 1 || fmt.channels > 2 || !fmt.rate) throw new WaveFormatError("Use mono or stereo 16, 24 or 32-bit PCM, or 32-bit float WAV.");
      const step = fmt.bits / 8, frames = Math.floor(size / (step * fmt.channels)), samples = new Float32Array(frames);
      for (let frame = 0; frame < frames; frame++) {
        let sum = 0;
        for (let ch = 0; ch < fmt.channels; ch++) {
          const pos = body + (frame * fmt.channels + ch) * step;
          let value: number;
          if (fmt.encoding === 3) value = view.getFloat32(pos, true);
          else if (fmt.bits === 16) value = view.getInt16(pos, true) / 32768;
          else if (fmt.bits === 24) { let n = bytes[pos]! | (bytes[pos + 1]! << 8) | (bytes[pos + 2]! << 16); if (n & 0x800000) n |= 0xff000000; value = n / 8388608; }
          else value = view.getInt32(pos, true) / 2147483648;
          sum += Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
        }
        samples[frame] = sum / fmt.channels;
      }
      return { samples, sampleRate: fmt.rate };
    }
    at = body + size + (size & 1);
  }
  throw new WaveFormatError("The WAV file has no audio data.");
}

export function mouthWords(result: { tokens?: string[]; timestamps?: number[] }, duration: number): TimedWord[] | null {
  if (!result.tokens?.length || !result.timestamps?.length) return null;
  return wordsFromTokenTimes(result.tokens, result.timestamps, duration);
}
