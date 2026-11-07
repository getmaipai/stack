// Speaker detection helpers that never touch the native runtime, so the
// daemon and the test suite can import them. The model files are read by
// the speech worker (sherpa.ts loadDiarizer); here we only say where they
// live, whether they are all there, and how turns map onto transcript
// segments. Everything stays on this computer.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { modelsDir } from "@/lib/paths";

/** pyannote segmentation 3.0 (MIT, int8 export by k2-fsa) and NVIDIA
 * nemo_en_titanet_small (CC-BY-4.0) speaker embedding. */
export const DIARIZATION_FILES = { segmentation: "segmentation.int8.onnx", embedding: "embedding.onnx" } as const;
export const DIARIZATION_MAX_SPEAKERS = 20;
export interface SpeakerTurn { start: number; end: number; speaker: number; }
export interface Speaker { id: string; label: string; }

/** The speech models directory's `diarization` folder; `MAIPAI_DIARIZATION_DIR` overrides it (dev and tests). */
export function diarizationDir(): string { return process.env.MAIPAI_DIARIZATION_DIR || join(modelsDir, "diarization"); }
/** The two files the clusterer reads, by absolute path. */
export interface DiarizationFiles { segmentation: string; embedding: string; }
/** The segmentation archive extracts to a folder holding this file. */
export const SEGMENTATION_FILE_IN_PACKAGE = "model.int8.onnx";
export const DIARIZATION_COMPONENTS = { segmentation: "diarization-segmentation", embedding: "diarization-embedding" } as const;
/** The files of an override folder (dev and tests), or null when no override is set. */
export function overrideDiarizationFiles(): DiarizationFiles | null {
  const dir = process.env.MAIPAI_DIARIZATION_DIR;
  return dir ? { segmentation: join(dir, DIARIZATION_FILES.segmentation), embedding: join(dir, DIARIZATION_FILES.embedding) } : null;
}
/** The files of the installed components (`modelPath` of each record), or null until both are installed and present on disk. */
export function installedDiarizationFiles(records: ReadonlyArray<{ modelPath: string | null; engineRequirements: { component?: unknown } }>): DiarizationFiles | null {
  const pathOf = (component: string) => records.find((record) => record.engineRequirements.component === component && record.modelPath)?.modelPath ?? null;
  const packageDir = pathOf(DIARIZATION_COMPONENTS.segmentation), embedding = pathOf(DIARIZATION_COMPONENTS.embedding);
  if (!packageDir || !embedding) return null;
  const files = { segmentation: join(packageDir, SEGMENTATION_FILE_IN_PACKAGE), embedding };
  return existsSync(files.segmentation) && existsSync(files.embedding) ? files : null;
}
/** Where speaker detection reads its models: an override folder when set, else the installed components. */
export function diarizationFilesFor(records: Parameters<typeof installedDiarizationFiles>[0]): DiarizationFiles | null {
  const override = overrideDiarizationFiles();
  if (override) return Object.values(override).every((file) => existsSync(file)) ? override : null;
  return installedDiarizationFiles(records);
}
export function missingDiarizationFiles(dir = diarizationDir()): string[] { return Object.values(DIARIZATION_FILES).filter((file) => !existsSync(join(dir, file))); }
export const DIARIZATION_UNAVAILABLE_NOTE = "Speaker detection is not installed on this computer, so the transcript has no speaker names. Install pyannote-segmentation-3.0-int8 and titanet-small-en from Home's Engines page and run it again.";

/** Validate the `diarize` / `num_speakers` pair; returns a plain-language problem or null. */
export function validateDiarizeOptions(diarize?: boolean, numSpeakers?: number): string | null {
  if (numSpeakers === undefined) return null;
  if (!diarize) return "num_speakers only applies when diarize is true. Set diarize to true, or leave num_speakers out.";
  if (!Number.isInteger(numSpeakers) || numSpeakers < 1 || numSpeakers > DIARIZATION_MAX_SPEAKERS) return `num_speakers must be a whole number from 1 to ${DIARIZATION_MAX_SPEAKERS}. Leave it out to let the Stack count the speakers.`;
  return null;
}

/** Give each segment the speaker whose turns overlap it most. Speakers are
 * numbered spk-1, spk-2 in order of first appearance in the transcript; a
 * segment no turn touches gets no speaker. Turn times are on the same clock
 * as the segments. */
export function assignSpeakers<T extends { start: number; end: number }>(segments: T[], turns: SpeakerTurn[]): { segments: Array<T & { speaker?: string }>; speakers: Speaker[] } {
  const order = new Map<number, string>();
  const out = segments.map((segment) => {
    const overlap = new Map<number, number>();
    for (const turn of turns) { const amount = Math.min(segment.end, turn.end) - Math.max(segment.start, turn.start); if (amount > 0) overlap.set(turn.speaker, (overlap.get(turn.speaker) ?? 0) + amount); }
    let best: number | null = null, bestAmount = 0;
    for (const [speaker, amount] of overlap) if (amount > bestAmount + 1e-9 || (Math.abs(amount - bestAmount) <= 1e-9 && best !== null && speaker < best)) { best = speaker; bestAmount = amount; }
    if (best === null) return { ...segment };
    if (!order.has(best)) order.set(best, `spk-${order.size + 1}`);
    return { ...segment, speaker: order.get(best)! };
  });
  return { segments: out, speakers: [...order.values()].map((id) => ({ id, label: `Speaker ${id.slice(4)}` })) };
}
