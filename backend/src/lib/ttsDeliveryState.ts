// The one governor for the voice role, fed by the stack.voice.delivery.* settings.
import { settingValues } from "@/settings";
import { DeliveryGovernor, type DeliveryConfig } from "@/lib/ttsDelivery";

export function ttsDeliveryConfig(): DeliveryConfig {
  const v = settingValues();
  const num = (key: string, fallback: number) => typeof v[`stack.voice.delivery.${key}`] === "number" ? v[`stack.voice.delivery.${key}`] as number : fallback;
  return { adaptive: v["stack.voice.delivery.adaptive"] !== false, rtfHigh: num("rtf_high", 0.7), rtfLow: num("rtf_low", 0.5), loadHigh: num("load_high", 0.8), loadLow: num("load_low", 0.6), calmUtterances: num("calm_utterances", 3), prerollMs: num("preroll_ms", 300) };
}

export const ttsDelivery = new DeliveryGovernor(ttsDeliveryConfig);
