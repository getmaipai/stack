// Pure sound-tagging helpers: keeping model discovery and audio shaping
// separate from sherpa lets the daemon and tests avoid loading the addon.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resampleLinear, rms } from "@/speech/audio";

export const SOUND_TAGGING_COMPONENT = "sound-tagging";
export const SOUND_TAGGING_FILES = { model: "model.int8.onnx", labels: "class_labels_indices.csv" } as const;
export interface SoundTaggingFiles { model: string; labels: string; }
export interface SoundTag { label: string; score: number; }
export interface AudioTagger { sampleRate: number; compute(samples: Float32Array, sampleRate: number): Array<{ label: string; score: number }>; }
export function soundTaggingFilesFor(records: ReadonlyArray<{ modelPath: string | null; engineRequirements: { component?: unknown } }>): SoundTaggingFiles | null {
  const override = process.env.MAIPAI_SOUND_TAGGING_DIR;
  const record = records.find((item) => item.engineRequirements.component === SOUND_TAGGING_COMPONENT && item.modelPath);
  const dir = override || record?.modelPath;
  if (!dir) return null;
  const files = { model: join(dir, SOUND_TAGGING_FILES.model), labels: join(dir, SOUND_TAGGING_FILES.labels) };
  return existsSync(files.model) && existsSync(files.labels) ? files : null;
}
export function tagSounds(pcm: Float32Array, sampleRate: number, tagger: AudioTagger): SoundTag[] {
  if (!pcm.length || !Number.isFinite(sampleRate) || sampleRate <= 0 || rms(pcm) < 0.0001) return [];
  const samples = resampleLinear(pcm, sampleRate, tagger.sampleRate);
  return tagger.compute(samples, tagger.sampleRate).filter((tag) => Number.isFinite(tag.score) && tag.score >= 0.1)
    .sort((a, b) => b.score - a.score).slice(0, 5).map(({ label, score }) => ({ label, score }));
}
