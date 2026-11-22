// What a voice pick means to the Stack: the engine the model's row names is saved in `stack.voice.engine` and starts at the next voice engine
// restart (VOICE-VOXCPM2-01). Shared by `PUT /stack/v1/tiers/choice` and `PUT /stack/v1/choices/voice/standard`.
import { updateSettings } from "@/settings";
import { TTS_ENGINE_SETTING } from "@/speech/ttsEngines";

export function applyVoiceEngine(engine: string): { applied: true; pending_restart: boolean } {
  const setting = updateSettings({ [TTS_ENGINE_SETTING]: engine }).find((item) => item.key === TTS_ENGINE_SETTING);
  return { applied: true, pending_restart: setting?.pending !== null && setting?.pending !== undefined };
}
