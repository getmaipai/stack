// The voice inventory (STACK-101a): one row per voice the tts role can
// render, with its metadata declared, never guessed. Presets come from
// the engine's preset table; community and cloned voices come from a
// manifest the Stack has fetched, if one exists.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hfBlobsRoot } from "@/lib/store/layout";
import { POCKET_TTS_PRESET_VOICES, POCKET_TTS_VOICES_REVISION, presetVoiceModel, voiceLicence } from "@/speech/voices";
import { POCKET_TTS_UNGATED_REPO } from "@/speech/pocketTts";
import { ttsEngineInEffect, ttsEngineInstalled } from "@/lib/supervisor";
import { STACK_TTS_CHATTERBOX_MODEL } from "@/lib/modelCatalog";
import { TTS_ENGINES, type TtsEngineId } from "@/speech/ttsEngines";
import type { Voice } from "@/wire/voice";

export const CHATTERBOX_DEFAULT_VOICE_ID = "chatterbox-turbo-voice-default";

function presetName(name: string): string {
  return name.split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

function presetOnDisk(name: string): boolean {
  const pin = POCKET_TTS_PRESET_VOICES[name]!;
  return existsSync(join(hfBlobsRoot(POCKET_TTS_UNGATED_REPO), pin.sha256));
}

/** The voice list for the engine in effect: Pocket TTS's presets, or the
 * MLX engine's one built-in voice (reference-clip voices come with the
 * cloning slice). Each entry carries the engine's tag capability. */
export function listVoices(engine: TtsEngineId = ttsEngineInEffect()): Voice[] {
  if (engine === "chatterbox-turbo") {
    const definition = TTS_ENGINES[engine];
    const pin = STACK_TTS_CHATTERBOX_MODEL;
    return [{
      id: CHATTERBOX_DEFAULT_VOICE_ID, name: "Chatterbox default", description: "unknown", language: "en", country: "unknown", gender: "unknown", source: "preset",
      onDisk: ttsEngineInstalled(engine), licence: pin.license ?? null, revision: pin.revision ?? "unknown",
      engine: definition.catalogEngine, tts: { engine: definition.catalogEngine, tags: [...definition.tags] },
    }];
  }
  const voices: Voice[] = [];
  for (const name of Object.keys(POCKET_TTS_PRESET_VOICES)) {
    const model = presetVoiceModel(name);
    const path = model.download?.hub_file ?? "";
    const repo = model.repo ?? POCKET_TTS_UNGATED_REPO;
    voices.push({
      id: model.id,
      name: presetName(name),
      description: "unknown",
      language: "en",
      country: "unknown",
      gender: "unknown",
      source: "preset",
      onDisk: presetOnDisk(name),
      licence: voiceLicence(repo, path, model.license ?? null),
      revision: model.revision ?? POCKET_TTS_VOICES_REVISION,
      engine: TTS_ENGINES.pocket.catalogEngine,
      tts: { engine: TTS_ENGINES.pocket.catalogEngine, tags: [...TTS_ENGINES.pocket.tags] },
    });
  }
  return voices;
}
