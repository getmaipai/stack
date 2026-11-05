import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerJobRunner, type Job, type JobProgress } from "@/lib/jobs";
import { GenTracker, recordRun } from "@/lib/genProgress";
import { dataDir } from "@/lib/paths";
import { sha256Hex } from "@/music/provenance";
import { recordedSpeech, RECORDED_SPEECH_PEAK_BYTES, type RecordedSpeaker } from "./recordedSpeech";

export const RECORDED_SPEECH_JOB_KIND = "recorded_speech_generation";
const failures = new Map<string, { code: string; message: string }>();
const stages = new Map<string, string>();
const trackers = new Map<string, GenTracker>();
export const recordedSpeechFailure = (id: string) => failures.get(id) ?? null;
export const recordedSpeechStage = (id: string) => stages.get(id) ?? null;
export const recordedSpeechTracker = (id: string) => trackers.get(id) ?? null;
const remember = <T>(map: Map<string, T>, key: string, value: T) => { map.set(key, value); if (map.size > 200) map.delete(map.keys().next().value as string); };
const stash = new Map<string, { text: string; references: Array<{ audio: Uint8Array; text: string }>; format: "m4a" | "wav"; at: number }>();
export function stashRecordedSpeech(token: string, text: string, references: Array<{ audio: Uint8Array; text: string }>, format: "m4a" | "wav"): void { const now = Date.now(); for (const [key, value] of stash) if (now - value.at > 30 * 60_000) stash.delete(key); stash.set(token, { text, references, format, at: now }); }
export function unstashRecordedSpeech(token: string): void { stash.delete(token); }

const resultDir = (id: string) => join(dataDir, "speech-recorded", "results", id);
const workDir = (id: string) => join(dataDir, "tmp", "speech-recorded", id);

async function run(job: Job, signal: AbortSignal, update: JobProgress) {
  const input = job.input as { token?: string } | null;
  const payload = stash.get(input?.token ?? ""); stash.delete(input?.token ?? "");
  if (!payload) throw new Error("The request was not received. Send it again.");
  const work = workDir(job.id); rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true, mode: 0o700 });
  try {
    const references: RecordedSpeaker[] = payload.references.map((reference, index) => { const path = join(work, `reference-${index}.audio`); writeFileSync(path, reference.audio, { mode: 0o600 }); return { audio: path, text: reference.text }; });
    const format = payload.format; const output = join(work, `speech.${format}`); const outputWav = join(work, "speech.wav");
    const tracker = new GenTracker("speech", "recorded-speech:fish-audio-drama-3"); remember(trackers, job.id, tracker); const started = Date.now();
    const result = await recordedSpeech.run({ id: job.id, text: payload.text, references, format, output, outputWav, work_dir: work }, (stage, fraction) => { remember(stages, job.id, stage); tracker.enter(stage === "loading" ? "load" : stage === "saving" ? "save" : "render"); update({ status: stage, percent: Math.round(fraction * 100) }); }, signal);
    recordRun(tracker.key, tracker.finish());
    const bytes = new Uint8Array(readFileSync(output)); const digest = sha256Hex(bytes); const target = resultDir(job.id); mkdirSync(join(dataDir, "speech-recorded", "results"), { recursive: true, mode: 0o700 }); rmSync(target, { recursive: true, force: true }); mkdirSync(target, { mode: 0o700 });
    renameSync(output, join(target, `speech.${format}`)); writeFileSync(join(target, "speech.json"), JSON.stringify({ job: job.id, created: Math.floor(Date.now() / 1000), format, duration: result.duration, sample_rate: result.sample_rate, bytes: bytes.length, sha256: digest }), { mode: 0o600 });
    const root = join(dataDir, "speech-recorded", "results"), newest = Number(process.env.RECORDED_SPEECH_RESULT_KEEP ?? 6), ttl = Number(process.env.RECORDED_SPEECH_RESULT_TTL_MS ?? 10 * 60_000);
    readdirSync(root).filter((id) => /^job-[0-9a-f-]{36}$/.test(id)).map((id) => ({ id, at: statSync(join(root, id)).mtimeMs })).sort((a, b) => b.at - a.at).forEach((entry, index) => { if (index >= newest || Date.now() - entry.at > ttl) rmSync(join(root, entry.id), { recursive: true, force: true }); });
    update({ status: "ready", percent: 100 }); return { job: job.id, ms: Date.now() - started, worker_ms: result.ms, duration: result.duration, sample_rate: result.sample_rate, bytes: bytes.length, sha256: digest, url: `/v1/audio/speech/recorded/${job.id}/file`, content_type: format === "m4a" ? "audio/mp4" : "audio/wav" };
  } catch (error) {
    if (!signal.aborted) remember(failures, job.id, { code: "failed", message: error instanceof Error ? error.message : "Recorded speech could not be rendered." });
    throw error;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

export function registerRecordedSpeechJobs(): void { registerJobRunner(RECORDED_SPEECH_JOB_KIND, run, { generator: { role: "tts", queueBehind: ["image", "video"], memory: () => ({ requestedBytes: RECORDED_SPEECH_PEAK_BYTES, measuredPeakBytes: RECORDED_SPEECH_PEAK_BYTES, engine: "recorded-speech" }) } }); }
