// The little audio arithmetic the speech worker needs and nothing more:
// a WAV decoder for what the wire accepts (PCM, 16-bit, mono or stereo,
// any rate), a linear resampler to the recognizer's 16 kHz, and RMS.
// Everything heavier (the recognizer, the detector) is the runtime's.

export const TARGET_SAMPLE_RATE = 16_000;

export interface DecodedWave { samples: Float32Array; sampleRate: number; }

export class WaveFormatError extends Error {
  constructor(message: string) { super(message); this.name = "WaveFormatError"; }
}

/** Decodes a RIFF WAV with 16-bit PCM samples into mono float samples
 * in -1..1. Chunks are walked, not assumed at fixed offsets, because a
 * WAV written by a browser or a converter often carries LIST or fact
 * chunks before `data`. */
export function decodeWave(bytes: Uint8Array): DecodedWave {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
  if (bytes.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new WaveFormatError("Not a RIFF WAV file.");
  let offset = 12;
  let format: { channels: number; sampleRate: number; bits: number; audioFormat: number } | null = null;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      format = { audioFormat: view.getUint16(body, true), channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    } else if (id === "data") {
      if (!format) throw new WaveFormatError("The WAV data chunk comes before its format chunk.");
      if (format.audioFormat !== 1 || format.bits !== 16) throw new WaveFormatError(`Only 16-bit PCM WAV is accepted (got format ${format.audioFormat}, ${format.bits} bits).`);
      if (format.channels < 1 || format.channels > 2) throw new WaveFormatError(`Only mono or stereo WAV is accepted (got ${format.channels} channels).`);
      // A streamed or truncated file may declare more data than it holds.
      const available = Math.min(size, bytes.byteLength - body);
      const frames = Math.floor(available / (2 * format.channels));
      const samples = new Float32Array(frames);
      for (let frame = 0; frame < frames; frame += 1) {
        let sum = 0;
        for (let channel = 0; channel < format.channels; channel += 1) sum += view.getInt16(body + (frame * format.channels + channel) * 2, true);
        samples[frame] = sum / format.channels / 32768;
      }
      return { samples, sampleRate: format.sampleRate };
    }
    offset = body + size + (size % 2);
  }
  throw new WaveFormatError("The WAV file has no data chunk.");
}

/** Linear interpolation is enough for speech going into a recognizer
 * that was trained on 16 kHz; a higher-order filter would be a second
 * copy of what the runtime's own resampler does. */
export function resampleLinear(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to || samples.length === 0) return samples;
  const ratio = from / to;
  const length = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const weight = position - left;
    out[index] = samples[left]! * (1 - weight) + samples[right]! * weight;
  }
  return out;
}

export function toRecognizerRate(wave: DecodedWave): Float32Array {
  return resampleLinear(wave.samples, wave.sampleRate, TARGET_SAMPLE_RATE);
}

export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) sum += samples[index]! * samples[index]!;
  return Math.sqrt(sum / samples.length);
}

/** A binary frame from the streaming session: little-endian float32
 * samples with no envelope, as spec/voice's SttWireEvent contract says. */
export function frameToSamples(frame: ArrayBuffer | Uint8Array): Float32Array {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  const usable = bytes.byteLength - (bytes.byteLength % 4);
  if (usable === 0) return new Float32Array(0);
  // A copy, so the view is aligned whatever the socket handed us.
  const aligned = new Uint8Array(usable);
  aligned.set(bytes.subarray(0, usable));
  return new Float32Array(aligned.buffer);
}
