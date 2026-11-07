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
export function missingDiarizationFiles(dir = diarizationDir()): string[] { return Object.values(DIARIZATION_FILES).filter((file) => !existsSync(join(dir, file))); }
export const DIARIZATION_UNAVAILABLE_NOTE = "Speaker detection is not installed on this computer, so the transcript has no speaker names. Install the speaker detection models from Home's Engines page and run it again.";

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
