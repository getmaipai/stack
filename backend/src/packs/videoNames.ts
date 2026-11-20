// Rule E8: a model's name belongs in its pack folder and the part table, not in routes or shared libraries. The plain names a video refusal or an
// operation row reads to a person live here, beside the packs, so video/caps.ts (the one contract for video operations) names no model itself.
/** INGREDIENTS-01: the installed adapter is found by its published file name, kept in the library record's name or source address. */
export const INGREDIENTS_ADAPTER_FILE = "ltx-2.5-22b-ic-lora-ingredients-0.9.safetensors";

/** `subject` starts a refusal sentence; `requires` is what an admin installs for the model to run. */
export const VIDEO_ENGINE_NAMES = {
  ltx25: { subject: "This video model", requires: "LTX-2.5 video model" },
  ltx25max: { subject: "The Max video model", requires: "LTX-2.5 Max video model" },
  h3: { subject: "MiniMax H3", requires: "MiniMax H3 video model" },
} as const;
