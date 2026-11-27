// Adaptive voice delivery. Audio sent as it is made plays smoothly while the
// computer keeps ahead of the speaker, and stutters when it is busy. This
// watches how fast replies are made (real-time factor, RTF: seconds of work per
// second of audio, averaged over the last 5 replies) and how busy the processor
// is (load per core). When either runs high it switches to BUFFERED delivery:
// the whole reply is made first, then sent with a short silence in front. It
// returns to STREAMING only after a run of calm replies, so one slow reply
// never flips the mode.
import os from "node:os";
import { logger } from "@/lib/log";

export type DeliveryMode = "streaming" | "buffered";

export interface DeliveryConfig {
  adaptive: boolean;
  rtfHigh: number;
  rtfLow: number;
  loadHigh: number;
  loadLow: number;
  calmUtterances: number;
  prerollMs: number;
}

export const DELIVERY_WINDOW = 5;
/** The average needs this many replies before it can flip the mode, so a first slow reply cannot. */
export const DELIVERY_MIN_SAMPLES = 3;

export const loadPerCore = (): number => os.loadavg()[0]! / Math.max(1, os.cpus().length);

export class DeliveryGovernor {
  private samples: number[] = [];
  private calm = 0;
  private current: DeliveryMode = "streaming";
  constructor(private readonly config: () => DeliveryConfig, private readonly load: () => number = loadPerCore, private readonly log: (line: string) => void = (line) => logger.appendLine(line)) {}

  get mode(): DeliveryMode { return this.current; }
  get rtf(): number | null { return this.samples.length ? this.samples.reduce((a, b) => a + b, 0) / this.samples.length : null; }

  /** The mode for a reply about to start. Adaptive off is always streaming. */
  begin(): DeliveryMode {
    const config = this.config();
    if (!config.adaptive) { this.switchTo("streaming", "adaptive delivery is off"); return "streaming"; }
    if (this.current === "streaming" && this.load() >= config.loadHigh) this.switchTo("buffered", `load per core ${this.load().toFixed(2)} is at or above ${config.loadHigh}`);
    return this.current;
  }

  /** Report a finished reply: seconds spent making it and seconds of audio it holds. */
  finish(synthesisSeconds: number, audioSeconds: number): void {
    if (!(audioSeconds > 0) || !(synthesisSeconds >= 0)) return;
    const config = this.config();
    const rtf = synthesisSeconds / audioSeconds;
    this.samples.push(rtf);
    if (this.samples.length > DELIVERY_WINDOW) this.samples.shift();
    if (!config.adaptive) { this.switchTo("streaming", "adaptive delivery is off"); return; }
    const load = this.load();
    const average = this.rtf!;
    if (this.current === "streaming") {
      this.calm = 0;
      if (this.samples.length >= DELIVERY_MIN_SAMPLES && average >= config.rtfHigh) this.switchTo("buffered", `real-time factor ${average.toFixed(2)} is at or above ${config.rtfHigh}`);
      else if (load >= config.loadHigh) this.switchTo("buffered", `load per core ${load.toFixed(2)} is at or above ${config.loadHigh}`);
      return;
    }
    this.calm = rtf < config.rtfLow && load < config.loadLow ? this.calm + 1 : 0;
    if (this.calm >= config.calmUtterances) this.switchTo("streaming", `${this.calm} calm replies in a row`);
  }

  private switchTo(mode: DeliveryMode, why: string): void {
    if (mode === this.current) return;
    this.current = mode;
    this.calm = 0;
    this.log(JSON.stringify({ event: "tts.delivery", mode, why }));
  }
}

/** Format of a streamed WAV: its header is 44 bytes with a placeholder data size. */
export function wavFormat(header: Uint8Array): { bytesPerSecond: number } | null {
  if (header.byteLength < 44) return null;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const rate = view.getUint32(24, true), channels = view.getUint16(22, true), bits = view.getUint16(34, true);
  const bytesPerSecond = rate * channels * (bits / 8);
  return bytesPerSecond > 0 ? { bytesPerSecond } : null;
}

/** Wrap the engine's WAV body. Streaming passes chunks through; buffered holds
 * them all, then sends the header, the silence and the audio. Either way the
 * reply's RTF is reported to the governor when the body ends. */
export function deliverSpeech(body: ReadableStream<Uint8Array>, governor: DeliveryGovernor, prerollMs: number, now: () => number = () => performance.now()): ReadableStream<Uint8Array> {
  const mode = governor.begin();
  const started = now();
  const reader = body.getReader();
  const held: Uint8Array[] = [];
  let total = 0;
  let head: Uint8Array | null = null;
  const take = (chunk: Uint8Array) => {
    total += chunk.byteLength;
    if (!head) {
      head = chunk.byteLength >= 44 ? chunk.slice(0, 44) : null;
      if (!head) { held.push(chunk); const all = concat(held); if (all.byteLength >= 44) { head = all.slice(0, 44); held.length = 0; held.push(all); } }
    }
  };
  const done = () => {
    const format = head ? wavFormat(head) : null;
    if (format) governor.finish((now() - started) / 1000, Math.max(0, total - 44) / format.bytesPerSecond);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (mode === "streaming") {
          const { value, done: end } = await reader.read();
          if (end) { done(); controller.close(); return; }
          if (value) { take(value); controller.enqueue(value); }
          return;
        }
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          if (value) { if (!head) take(value); else total += value.byteLength; held.push(value); }
        }
        done();
        const all = concat(held);
        const format = head ? wavFormat(head) : null;
        if (format && all.byteLength >= 44 && prerollMs > 0) {
          const silence = new Uint8Array(Math.round(format.bytesPerSecond * prerollMs / 1000 / 2) * 2);
          controller.enqueue(all.slice(0, 44));
          controller.enqueue(silence);
          controller.enqueue(all.slice(44));
        } else controller.enqueue(all);
        controller.close();
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.byteLength; }
  return out;
}
