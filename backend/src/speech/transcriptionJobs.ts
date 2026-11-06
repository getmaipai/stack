import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JobFailure, registerJobRunner, type Job, type JobProgress } from "@/lib/jobs";
import { GenTracker, recordRun } from "@/lib/genProgress";
import { dataDir } from "@/lib/paths";
import { mediaDeps } from "@/media/jobs";
import { splitSpeechSpans, wordsFromTokenTimes, validateRange, type TimedWord } from "@/speech/transcriptSpans";
import { decodeWave, toRecognizerRate } from "@/speech/audio";
import { openRoleSession, roleHasEngine, selectedModel } from "@/lib/supervisor";
import { probeFile } from "@/media/probe";
import { listModels } from "@/lib/modelStore";
import { STACK_STT_PARAKEET_V2_MODEL, STACK_VAD_MODEL } from "@/lib/modelCatalog";

export const TRANSCRIPTION_JOB_KIND = "audio_transcription";
export const TRANSCRIPTION_MAX_BYTES = 250 * 1024 * 1024;
export const TRANSCRIPTION_MAX_SECONDS = 3 * 60 * 60;
export const TRANSCRIPTION_PEAK_BYTES = 8_500_000_000;
export interface TranscriptSegment { start: number; end: number; text: string; words: TimedWord[]; confidence?: number; }
export interface TranscriptionOutput { language: string; segments: TranscriptSegment[]; vocabulary_applied: boolean; }
interface Payload { source: Uint8Array; from_s?: number; to_s?: number; language?: string; vocabulary?: string[]; }
const stash = new Map<string, Payload & { at: number }>();
const failures = new Map<string, { code: string; message: string; status?: number }>();
const stages = new Map<string, string>();
const trackers = new Map<string, GenTracker>();
const results = new Map<string, TranscriptionOutput>();
export const transcriptionFailure = (id: string) => failures.get(id) ?? null;
export const transcriptionStage = (id: string) => stages.get(id) ?? null;
export const transcriptionTracker = (id: string) => trackers.get(id) ?? null;
export const transcriptionOutput = (id: string) => results.get(id) ?? null;
export const forgetTranscriptionOutput = (id: string) => { results.delete(id); };
const remember = <T>(map: Map<string, T>, key: string, value: T) => { map.set(key, value); while (map.size > 200) map.delete(map.keys().next().value as string); };
export function stashTranscription(token: string, payload: Payload): void { const now = Date.now(); for (const [key, value] of stash) if (now - value.at > 30 * 60_000) stash.delete(key); stash.set(token, { ...payload, at: now }); }
export function unstashTranscription(token: string): void { stash.delete(token); }
export function transcriptionMemory(job: Pick<Job, "input">) { const input = job.input as { from_s?: number; to_s?: number } | null; const seconds = input?.from_s !== undefined && input.to_s !== undefined ? input.to_s - input.from_s : TRANSCRIPTION_MAX_SECONDS; const bytes = Math.min(TRANSCRIPTION_PEAK_BYTES, Math.max(2_300_000_000, Math.ceil(2_300_000_000 + seconds * 600_000))); return { requestedBytes: bytes, measuredPeakBytes: bytes, engine: "sherpa-onnx-parakeet" }; }

type TimedResult = { text: string; tokens?: string[]; timestamps?: number[]; ys_log_probs?: number[]; lang?: string };
export interface TranscriptionDeps {
  probe: typeof probeFile;
  extract: (ffmpeg: string, source: string, output: string, signal: AbortSignal, progress: (fraction: number) => void) => Promise<void>;
  detect: (baseUrl: string, samples: Float32Array, signal: AbortSignal) => Promise<Array<{ startSample: number; endSample: number }>>;
  transcribe: (baseUrl: string, samples: Float32Array, hotwords: string | undefined, signal: AbortSignal) => Promise<TimedResult>;
}
function waveBytes(samples: Float32Array, rate = 16_000): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2); const view = new DataView(bytes.buffer);
  const tag = (at: number, value: string) => { for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i); };
  tag(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); tag(8, "WAVE"); tag(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32767))), true);
  return bytes;
}
async function fetchJson<T>(url: string, body: unknown, signal: AbortSignal): Promise<T> { const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal }); const result = await response.json() as T & { error?: string }; if (!response.ok) throw new Error(result.error ?? "The speech worker could not finish this request."); return result; }
export const transcriptionDeps: TranscriptionDeps = {
  probe: probeFile,
  extract: async (ffmpeg, source, output, signal, progress) => {
    const child = Bun.spawn([ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", source, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", output], { stdout: "ignore", stderr: "pipe" });
    const stop = () => { try { child.kill("SIGTERM"); } catch {} }; if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
    const stderr = new Response(child.stderr).text().catch(() => ""); const code = await child.exited; signal.removeEventListener("abort", stop); await stderr;
    if (signal.aborted) throw new Error("Cancelled."); if (code !== 0) throw new Error("Audio could not be extracted from this file. Try another audio or video file."); progress(1);
  },
  detect: async (baseUrl, samples, signal) => (await fetchJson<{ spans: Array<{ startSample: number; endSample: number }> }>(`${baseUrl}/v1/audio/transcriptions/detect-spans`, { audio_base64: Buffer.from(waveBytes(samples)).toString("base64") }, signal)).spans,
  transcribe: async (baseUrl, samples, hotwords, signal) => fetchJson<TimedResult>(`${baseUrl}/v1/audio/transcriptions/timed-span`, { audio_base64: Buffer.from(waveBytes(samples)).toString("base64"), ...(hotwords ? { hotwords } : {}) }, signal),
};
let availabilityOverride: (() => boolean) | null = null;
export function setTranscriptionAvailabilityForTests(check: (() => boolean) | null): void { availabilityOverride = check; }

async function run(job: Job, signal: AbortSignal, update: JobProgress) {
  const input = job.input as { token?: string; from_s?: number; to_s?: number; language?: string; vocabulary?: string[] } | null; const payload = stash.get(input?.token ?? ""); stash.delete(input?.token ?? "");
  if (!payload) throw new Error("The request was not received. Send it again.");
  const work = join(dataDir, "tmp", "transcriptions", job.id); rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true, mode: 0o700 });
  try {
    const source = join(work, "source.bin"), wav = join(work, "audio.wav"); writeFileSync(source, payload.source, { mode: 0o600 });
    const tracker = new GenTracker("speech", "transcription:parakeet-tdt-0.6b-v2-int8"); remember(trackers, job.id, tracker); const started = Date.now();
    const ffmpeg = await mediaDeps.toolbox.path("ffmpeg", (status) => update({ status }), signal);
    stages.set(job.id, "checking file"); update({ status: "checking file", percent: 1 });
    const probe = await transcriptionDeps.probe(mediaDeps.run, await mediaDeps.toolbox.path("ffprobe", (status) => update({ status }), signal), source, signal);
    if (!probe.has_audio || probe.duration_s === null) throw new JobFailure("This file has no readable audio track. Send an audio or video file with sound.", { failure: { code: "bad_request", message: "This file has no readable audio track. Send an audio or video file with sound.", status: 422 } });
    if (probe.duration_s > TRANSCRIPTION_MAX_SECONDS) throw new JobFailure("The audio or video is longer than 3 hours.", { failure: { code: "too_long", message: "The audio or video is longer than 3 hours.", status: 413 } });
    stages.set(job.id, "extracting"); update({ status: "extracting", percent: 2 });
    await transcriptionDeps.extract(ffmpeg, source, wav, signal, (fraction) => update({ percent: 2 + Math.round(fraction * 18) }));
    const wave = decodeWave(new Uint8Array(await Bun.file(wav).arrayBuffer())); const samples = toRecognizerRate(wave); const duration = samples.length / 16_000;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("The file has no readable audio track.");
    if (duration > TRANSCRIPTION_MAX_SECONDS + 0.1) throw new Error("The audio or video is longer than 3 hours.");
    const range = validateRange(input?.from_s, input?.to_s); const start = Math.round(range.fromS * 16_000); const end = Math.round(Math.min(range.toS ?? duration, duration) * 16_000);
    if (start >= samples.length || end <= start || (range.toS !== undefined && range.toS > duration + 0.1)) throw new JobFailure("The requested range is outside the file.", { failure: { code: "bad_range", message: "The requested range is outside the file.", status: 422 } });
    const selected = samples.subarray(start, end);
    const session = await openRoleSession("stt");
    try {
      stages.set(job.id, "finding speech"); update({ status: "finding speech", percent: 22 });
      const spans: Array<{ startSample: number; endSample: number }> = [];
      const vadChunkSamples = 30 * 16_000;
      for (let offset = 0; offset < selected.length; offset += vadChunkSamples) {
        if (signal.aborted) throw new Error("Cancelled.");
        const chunk = selected.subarray(offset, Math.min(selected.length, offset + vadChunkSamples));
        for (const span of await transcriptionDeps.detect(session.baseUrl, chunk, signal)) spans.push({ startSample: span.startSample + offset, endSample: span.endSample + offset });
        update({ percent: 22 + Math.round(Math.min(1, (offset + chunk.length) / selected.length) * 3) });
      }
      const segments: TranscriptSegment[] = [];
      for (let index = 0; index < spans.length; index++) {
        if (signal.aborted) throw new Error("Cancelled."); const span = spans[index]!; const clip = selected.subarray(span.startSample, span.endSample); if (!clip.length) continue;
        stages.set(job.id, "transcribing"); const result = await transcriptionDeps.transcribe(session.baseUrl, clip, payload.vocabulary?.join(","), signal);
        const offset = range.fromS + span.startSample / 16_000; const words = result.tokens && result.timestamps ? wordsFromTokenTimes(result.tokens, result.timestamps, clip.length / 16_000, offset) : [];
        const text = result.text.trim(); if (text) segments.push({ start: words[0]?.start ?? offset, end: words.at(-1)?.end ?? offset + clip.length / 16_000, text, words, ...(Array.isArray(result.ys_log_probs) && result.ys_log_probs.length ? { confidence: Math.exp(result.ys_log_probs.reduce((a, b) => a + b, 0) / result.ys_log_probs.length) } : {}) });
        const percent = 25 + Math.round((index + 1) / Math.max(spans.length, 1) * 70); update({ status: "transcribing", percent });
      }
      const output: TranscriptionOutput = { language: "en", segments, vocabulary_applied: false }; results.set(job.id, output); while (results.size > 12) results.delete(results.keys().next().value as string); recordRun(tracker.key, tracker.finish()); update({ status: "ready", percent: 100 });
      // Rule 6a: transcript contents stay in memory, and logs carry counts and milliseconds only.
      const ms = Date.now() - started; console.log(JSON.stringify({ event: "transcription.done", segments: segments.length, words: segments.reduce((sum, item) => sum + item.words.length, 0), ms })); return { job: job.id, ms, segments: segments.length };
    } finally { session.release(); }
  } catch (error) { if (!signal.aborted) { const structured = error instanceof JobFailure ? (error.result as any)?.failure : null; remember(failures, job.id, { code: structured?.code ?? "failed", message: structured?.message ?? (error instanceof Error ? error.message : "Transcription failed."), ...(structured?.status ? { status: structured.status } : {}) }); } throw error; }
  finally { rmSync(work, { recursive: true, force: true }); }
}
export function registerTranscriptionJobs(): void { registerJobRunner(TRANSCRIPTION_JOB_KIND, run, { generator: { role: "stt", queueBehind: ["image", "video"], memory: transcriptionMemory } }); }
export function transcriptionAvailable(): boolean {
  if (availabilityOverride) return availabilityOverride();
  const records = listModels();
  const parakeet = records.find((model) => model.id === STACK_STT_PARAKEET_V2_MODEL.id && model.modelPath && model.verifiedAt);
  const vad = records.find((model) => model.id === STACK_VAD_MODEL.id && model.modelPath && model.verifiedAt);
  return !!parakeet && !!vad && roleHasEngine("stt") && selectedModel("stt")?.id === STACK_STT_PARAKEET_V2_MODEL.id;
}

export function validTranscriptionContainer(bytes: Uint8Array): boolean { if (String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF") { try { decodeWave(bytes); return true; } catch { return false; } } if (String.fromCharCode(...bytes.subarray(4, 8)) === "ftyp" || String.fromCharCode(...bytes.subarray(0, 4)) === "fLaC" || String.fromCharCode(...bytes.subarray(0, 4)) === "OggS" || String.fromCharCode(...bytes.subarray(0, 3)) === "ID3") return true; return bytes.length > 4 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0 && (bytes[2]! & 0xf0) !== 0xf0; }
export function __transcriptionHelpersForTests() { return { splitSpeechSpans, validateRange }; }
