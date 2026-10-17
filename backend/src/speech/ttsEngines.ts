// The registry of voice engines behind the `tts` role (VOICE-STUDIO-01):
// which engines exist, which tags each honors, which one a tier runs by
// default, and the one function that decides which engine is in effect.
// The choice is the setting `stack.voice.engine` (`auto`, the default,
// means the tier's own default). A requested engine that is not built,
// not installed, or that failed to start this run falls back to Pocket
// TTS with the reason said: a failed voice engine never kills chat or
// the Stack. Pure except for the failure memory, which a restart of the
// voice engine clears.
import type { GovernorTier } from "@/lib/governor";
import { CHATTERBOX_ENGINE } from "@/lib/modelCatalog";

export type TtsEngineId = "chatterbox-turbo" | "orpheus" | "pocket";
export const TTS_ENGINE_SETTING = "stack.voice.engine";

export interface TtsEngineDefinition {
  id: TtsEngineId;
  label: string;
  /** The `engine` field on this engine's catalog records (what `selectedModel` filters by). */
  catalogEngine: string;
  /** The managed runtime whose environment runs it. */
  runtime: "pocket-tts" | "mlx-audio";
  /** Built in this Stack; an engine that is only a slot (Orpheus) is not offered. */
  built: boolean;
  /** The tags the engine renders as sounds, measured; written into `reply.speech` by Home's composer (REG-02). */
  tags: string[];
  /** Resident memory planned until a measurement replaces it. */
  estimatedFootprintBytes: number;
  /** The Hugging Face repository the engine loads (offline, from the hub cache). */
  repo: string | null;
}

export const TTS_ENGINES: Record<TtsEngineId, TtsEngineDefinition> = {
  pocket: { id: "pocket", label: "Pocket TTS", catalogEngine: "pocket-tts", runtime: "pocket-tts", built: true, tags: [], estimatedFootprintBytes: 1_073_741_824, repo: null },
  "chatterbox-turbo": {
    id: "chatterbox-turbo", label: "Chatterbox Turbo", catalogEngine: CHATTERBOX_ENGINE, runtime: "mlx-audio", built: true,
    // Verified 2026-10-17 by synthesizing each tag alone and measuring
    // voicing and spectral flatness against spoken words (design note,
    // "Tags the engine honors"). The model's tokenizer knows 19 bracket
    // tokens; these six are the ones asked for and measured as sound.
    tags: ["[laugh]", "[chuckle]", "[cough]", "[sigh]", "[clear throat]", "[gasp]"],
    estimatedFootprintBytes: 5_200_000_000, repo: "mlx-community/chatterbox-turbo-fp16",
  },
  // The slot for the alternate (Orpheus 3B, MLX 4-bit, 0.75 s to first audio,
  // 3.2 GB): a class in mlx_tts_server.py, its pins in the catalog, then `built: true`.
  orpheus: { id: "orpheus", label: "Orpheus 3B", catalogEngine: "orpheus", runtime: "mlx-audio", built: false, tags: [], estimatedFootprintBytes: 3_600_000_000, repo: null },
};

/** The engines a person can choose today. */
export const TTS_ENGINE_CHOICES: TtsEngineId[] = (Object.keys(TTS_ENGINES) as TtsEngineId[]).filter((id) => TTS_ENGINES[id].built);

/** Tiers with room for a 4.8 GB voice beside the tier's chat, judge and
 * embed models (p64, p128). p32 keeps Pocket: its model budget is 24 GB
 * less the 8 GB working margin (governor tiers), and the 17 GB Muse 30B
 * pin alone leaves no room beside it for the judge, embeddings and a voice. The
 * voice can still be chosen by hand there; the governor refuses a load
 * that does not fit and the voice falls back to Pocket. */
export const TTS_DEFAULT_BY_TIER: Record<GovernorTier, TtsEngineId> = { p16: "pocket", p32: "pocket", p64: "chatterbox-turbo", p128: "chatterbox-turbo" };

export function tierDefaultTtsEngine(tier: GovernorTier | undefined | null): TtsEngineId {
  return tier ? TTS_DEFAULT_BY_TIER[tier] ?? "pocket" : "pocket";
}

/** What the setting asks for: a named engine, or the tier's default for `auto` (and for any unknown value). */
export function requestedTtsEngine(setting: unknown, tier: GovernorTier | undefined | null): TtsEngineId {
  return typeof setting === "string" && setting in TTS_ENGINES ? setting as TtsEngineId : tierDefaultTtsEngine(tier);
}

const failed = new Map<TtsEngineId, string>();
export function markTtsEngineFailed(id: TtsEngineId, reason: string): void { if (id !== "pocket") failed.set(id, reason); }
export function clearTtsEngineFailures(): void { failed.clear(); }
export function ttsEngineFailure(id: TtsEngineId): string | null { return failed.get(id) ?? null; }

export interface TtsEngineChoice {
  /** The engine in effect. */
  engine: TtsEngineId;
  /** The engine the setting or the tier asked for. */
  requested: TtsEngineId;
  /** Why `engine` is not `requested`, in words a person can act on; null when it is. */
  reason: string | null;
}

export function resolveTtsEngine(options: { setting: unknown; tier: GovernorTier | undefined | null; installed: (id: TtsEngineId) => boolean }): TtsEngineChoice {
  const requested = requestedTtsEngine(options.setting, options.tier);
  if (requested === "pocket") return { engine: "pocket", requested, reason: null };
  const definition = TTS_ENGINES[requested];
  if (!definition.built) return { engine: "pocket", requested, reason: `${definition.label} is not available in this Stack yet, so the voice stays on Pocket TTS.` };
  const failure = failed.get(requested);
  if (failure) return { engine: "pocket", requested, reason: `${definition.label} did not start (${failure}), so the voice fell back to Pocket TTS. Restart the voice engine to try again.` };
  if (!options.installed(requested)) return { engine: "pocket", requested, reason: `${definition.label} is not installed on this computer, so the voice stays on Pocket TTS. Install it from the engines page.` };
  return { engine: requested, requested, reason: null };
}
