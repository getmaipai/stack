// The one adapter over sherpa-onnx-node (upstream's own binding of the
// prebuilt sherpa-onnx library, pinned exactly in package.json): a
// Moonshine recognizer as a Transcriber and Silero as a VoiceDetector.
// Loaded only inside the speech worker process, never by the daemon,
// so a native fault stays in the role's process.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TARGET_SAMPLE_RATE } from "@/speech/audio";
import type { Transcriber, VoiceDetector } from "@/speech/session";

export const RUNTIME_NAME = "sherpa-onnx-node";

/** The Moonshine package the store extracts: four ONNX files and the
 * tokens, named as upstream ships them. */
export const MOONSHINE_FILES = { preprocessor: "preprocess.onnx", encoder: "encode.int8.onnx", uncachedDecoder: "uncached_decode.int8.onnx", cachedDecoder: "cached_decode.int8.onnx", tokens: "tokens.txt" } as const;

// Silero scores 512-sample windows at 16 kHz; frames from the wire are
// any length, so the detector re-chunks them.
const VAD_WINDOW = 512;

interface SherpaModule {
  OfflineRecognizer: new (config: unknown) => { createStream(): SherpaStream; decodeAsync(stream: SherpaStream): Promise<void>; getResult(stream: SherpaStream): { text: string } };
  Vad: new (config: unknown, bufferSizeInSeconds: number) => { acceptWaveform(samples: Float32Array): void; isDetected(): boolean; reset(): void; clear(): void };
}
interface SherpaStream { acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void; }

function loadModule(): SherpaModule {
  // A require, not an import: the addon and its dylibs load at call time
  // in the worker, and a test that imports this file never touches them.
  return require(RUNTIME_NAME) as SherpaModule;
}

export function runtimeVersion(): string {
  return (require(`${RUNTIME_NAME}/package.json`) as { version: string }).version;
}

export function missingMoonshineFiles(dir: string): string[] {
  return Object.values(MOONSHINE_FILES).filter((file) => !existsSync(join(dir, file)));
}

export function loadMoonshine(dir: string, threads = 2): Transcriber {
  const missing = missingMoonshineFiles(dir);
  if (missing.length) throw new Error(`The Moonshine package at ${dir} is missing ${missing.join(", ")}.`);
  const sherpa = loadModule();
  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: TARGET_SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      moonshine: { preprocessor: join(dir, MOONSHINE_FILES.preprocessor), encoder: join(dir, MOONSHINE_FILES.encoder), uncachedDecoder: join(dir, MOONSHINE_FILES.uncachedDecoder), cachedDecoder: join(dir, MOONSHINE_FILES.cachedDecoder) },
      tokens: join(dir, MOONSHINE_FILES.tokens),
      numThreads: threads,
      provider: "cpu",
      debug: 0,
    },
  });
  // Decodes run one at a time (the recognizer is one native object; the
  // one-shot route while a session runs waits its turn here) and off the
  // event loop through the binding's own async decode, so the worker
  // keeps answering /health and reading frames while a partial decodes.
  let queue: Promise<unknown> = Promise.resolve();
  return {
    transcribe(samples) {
      const run = queue.then(async () => {
        const stream = recognizer.createStream();
        stream.acceptWaveform({ samples, sampleRate: TARGET_SAMPLE_RATE });
        await recognizer.decodeAsync(stream);
        return recognizer.getResult(stream).text.trim();
      });
      queue = run.catch(() => {});
      return run;
    },
  };
}

export function loadSilero(modelPath: string): VoiceDetector {
  if (!existsSync(modelPath)) throw new Error(`The Silero VAD model is missing at ${modelPath}.`);
  const sherpa = loadModule();
  const vad = new sherpa.Vad({
    sileroVad: { model: modelPath, threshold: 0.5, minSilenceDuration: 0.1, minSpeechDuration: 0.1, windowSize: VAD_WINDOW, maxSpeechDuration: 30 },
    sampleRate: TARGET_SAMPLE_RATE,
    numThreads: 1,
    provider: "cpu",
    debug: 0,
  }, 60);
  let pending = new Float32Array(0);
  let voiced = false;
  return {
    push(samples) {
      const joined = new Float32Array(pending.length + samples.length);
      joined.set(pending);
      joined.set(samples, pending.length);
      let offset = 0;
      while (offset + VAD_WINDOW <= joined.length) {
        vad.acceptWaveform(joined.subarray(offset, offset + VAD_WINDOW));
        voiced = vad.isDetected();
        offset += VAD_WINDOW;
      }
      pending = joined.slice(offset);
      // The segments the detector keeps are never read here; dropping
      // them keeps its buffer flat.
      vad.clear();
      return voiced;
    },
    reset() {
      vad.reset();
      pending = new Float32Array(0);
      voiced = false;
    },
  };
}
