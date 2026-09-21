// The live speech session behind WS /v1/audio/transcriptions/stream:
// endpointing, partials and the final transcript, speaking spec/voice's
// SttWireEvent contract. The tuned numbers and the two Moonshine rules
// are hard-won logic carried from Home's backend/src/lib/sttSession.ts
// (itself ported from the legacy hub), repointed at an injected
// recognizer and detector so the suite drives it with scripted ones and
// the worker with sherpa-onnx.
//
// The rules that are not obvious: a cheap RMS gate keeps the detector
// from running on a silent room; a short pre-roll is prepended at onset
// so the first phoneme is not clipped; Moonshine tiny returns an empty
// transcript when the buffer starts with dead air, so the final decode
// retries once from the voiced onset with the pre-roll dropped; a
// buffer is force-finalized at thirty seconds so steady noise cannot
// grow it without bound; and bracketed annotations ("[BLANK_AUDIO]",
// "(typing)") are not speech.
import type { SttWireEvent } from "@maipai/spec/stack/ts/stt-wire-event.js";
import { rms } from "@/speech/audio";

export interface Transcriber { transcribe(samples: Float32Array): Promise<string>; }
/** Answers whether the room is voiced after this frame; `reset` between
 * utterances so a detector with internal state starts clean. */
export interface VoiceDetector { push(samples: Float32Array): boolean; reset(): void; }

export interface SttSessionConfig {
  sampleRate: number;
  silenceTimeoutS: number;
  partialIntervalS: number;
}

export const DEFAULT_SESSION_CONFIG: SttSessionConfig = { sampleRate: 16_000, silenceTimeoutS: 0.8, partialIntervalS: 1.0 };

// Below this RMS while not speaking the room is silent: the detector is
// not run at all.
const PRE_GATE_RMS = 0.006;
// The rolling window prepended to the utterance at onset (Home's 0.32 s;
// the robot's finding caps it at about 0.3 s, and the retry below drops
// it when Moonshine reads it as dead air).
const PREROLL_S = 0.32;
const MIN_SPEECH_S = 0.2;
const MAX_SPEECH_S = 30;

function speechContent(text: string): string {
  return text
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\*[^*]*\*/g, " ")
    .replace(/♪[^♪]*♪|♪+/g, " ")
    .replace(/[^\p{L}\p{N}\s'’]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isLikelySpeech(text: string): boolean {
  return /\p{L}/u.test(speechContent(text));
}

export class SttSession {
  private readonly config: SttSessionConfig;
  private readonly send: (event: SttWireEvent) => void;
  private readonly transcriber: Transcriber;
  private readonly detector: VoiceDetector;
  private speech: Float32Array[] = [];
  private speechLen = 0;
  private prerollIncludedLen = 0;
  private speaking = false;
  private silenceSamples = 0;
  private samplesSincePartial = 0;
  private partialInFlight = false;
  private partialPromise: Promise<void> | null = null;
  private finalizing = false;
  private closed = false;
  private preroll: Float32Array[] = [];
  private prerollLen = 0;
  private lastVoicedLen = 0;
  private reusablePartial: { text: string; voicedLen: number } | null = null;
  private redecodeAtEdge = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(options: { transcriber: Transcriber; detector: VoiceDetector; send: (event: SttWireEvent) => void; config?: Partial<SttSessionConfig> }) {
    this.config = { ...DEFAULT_SESSION_CONFIG, ...options.config };
    this.send = options.send;
    this.transcriber = options.transcriber;
    this.detector = options.detector;
  }

  /** Frames are processed in order on one chain, so a flush or a
   * finalize never races a frame still being scored. */
  pushPcm(samples: Float32Array): void {
    if (this.closed || this.finalizing) return;
    this.chain = this.chain.then(() => this.processFrame(samples)).catch(() => {});
  }

  /** The client asked to flush (push-to-talk released): finalize what
   * is buffered without waiting for the silence timeout. */
  end(): void {
    this.chain = this.chain.then(() => { if (!this.closed && this.speaking) void this.finalize(); }).catch(() => {});
  }

  close(): void {
    this.closed = true;
    this.speech = [];
  }

  /** Waits for every queued frame and any partial in flight; the suite
   * uses it, the worker never needs to. */
  async settle(): Promise<void> {
    await this.chain;
    if (this.partialPromise) await this.partialPromise.catch(() => {});
    await this.chain;
  }

  private async processFrame(samples: Float32Array): Promise<void> {
    if (this.closed || this.finalizing) return;
    const level = rms(samples);
    const voiced = !this.speaking && level < PRE_GATE_RMS ? false : this.detector.push(samples);

    if (voiced) {
      if (!this.speaking) {
        this.speaking = true;
        for (const chunk of this.preroll) { this.speech.push(chunk); this.speechLen += chunk.length; }
        this.prerollIncludedLen = this.prerollLen;
        this.preroll = [];
        this.prerollLen = 0;
        this.send({ t: "vad", speaking: true, rms: level });
      }
      this.silenceSamples = 0;
      this.speech.push(samples.slice());
      this.speechLen += samples.length;
      this.lastVoicedLen = this.speechLen;
      this.samplesSincePartial += samples.length;
      if (this.samplesSincePartial >= this.config.partialIntervalS * this.config.sampleRate) {
        this.samplesSincePartial = 0;
        void this.emitPartial();
      }
    } else if (this.speaking) {
      const firstSilenceFrame = this.silenceSamples === 0;
      this.speech.push(samples.slice());
      this.speechLen += samples.length;
      this.silenceSamples += samples.length;
      // A partial at the first silent frame gives the client the whole
      // utterance early; if one is in flight, it is redone at the edge.
      if (firstSilenceFrame) {
        if (this.partialInFlight) this.redecodeAtEdge = true;
        else void this.emitPartial();
      }
      if (this.silenceSamples >= this.config.silenceTimeoutS * this.config.sampleRate) void this.finalize();
    } else {
      this.preroll.push(samples.slice());
      this.prerollLen += samples.length;
      const cap = PREROLL_S * this.config.sampleRate;
      while (this.prerollLen > cap && this.preroll.length > 1) this.prerollLen -= this.preroll.shift()!.length;
    }

    if (this.speaking && this.speechLen >= MAX_SPEECH_S * this.config.sampleRate) void this.finalize();
  }

  private emitPartial(): Promise<void> {
    if (this.partialInFlight || this.speechLen === 0) return Promise.resolve();
    this.partialInFlight = true;
    const run = async () => {
      const capturedVoicedLen = this.lastVoicedLen;
      try {
        const text = await this.transcriber.transcribe(this.flatten());
        if (text && isLikelySpeech(text)) {
          this.reusablePartial = { text, voicedLen: capturedVoicedLen };
          if (!this.closed && !this.finalizing) this.send({ t: "partial", v: text });
        }
      } catch {
        // The recognizer being down surfaces at finalize; partials stay quiet.
      } finally {
        this.partialInFlight = false;
        this.partialPromise = null;
        if (this.redecodeAtEdge && !this.finalizing && !this.closed && this.speaking && this.silenceSamples > 0) {
          this.redecodeAtEdge = false;
          void this.emitPartial();
        } else {
          this.redecodeAtEdge = false;
        }
      }
    };
    this.partialPromise = run();
    return this.partialPromise;
  }

  private async finalize(): Promise<void> {
    if (this.finalizing) return;
    this.finalizing = true;
    this.send({ t: "vad", speaking: false, rms: 0 });
    if (this.partialPromise) await this.partialPromise.catch(() => {});
    if (this.closed) { this.reset(); return; }

    if (this.speechLen < MIN_SPEECH_S * this.config.sampleRate) {
      this.reset();
      this.send({ t: "no_speech" });
      return;
    }

    let text = "";
    const reusable = this.reusablePartial;
    if (reusable && reusable.voicedLen > 0 && reusable.voicedLen === this.lastVoicedLen) {
      // Nothing voiced arrived after that partial; it already covers
      // the whole utterance, so the full re-decode is skipped.
      text = reusable.text;
    } else {
      const full = this.flatten();
      try {
        text = await this.transcriber.transcribe(full);
      } catch (error) {
        this.reset();
        if (!this.closed) this.send({ t: "error", v: (error instanceof Error && error.message.trim()) || "The recognizer failed to decode the utterance." });
        return;
      }
      if (!text && this.prerollIncludedLen > 0) {
        try { text = await this.transcriber.transcribe(full.subarray(this.prerollIncludedLen)); } catch { /* The first empty result stands. */ }
      }
    }

    this.reset();
    if (this.closed) return;
    if (text && isLikelySpeech(text)) this.send({ t: "final", v: text });
    else this.send({ t: "no_speech" });
  }

  private flatten(): Float32Array {
    const out = new Float32Array(this.speechLen);
    let offset = 0;
    for (const chunk of this.speech) { out.set(chunk, offset); offset += chunk.length; }
    return out;
  }

  private reset(): void {
    this.speech = [];
    this.speechLen = 0;
    this.prerollIncludedLen = 0;
    this.speaking = false;
    this.silenceSamples = 0;
    this.samplesSincePartial = 0;
    this.finalizing = false;
    this.preroll = [];
    this.prerollLen = 0;
    this.lastVoicedLen = 0;
    this.reusablePartial = null;
    this.redecodeAtEdge = false;
    this.detector.reset();
  }
}
