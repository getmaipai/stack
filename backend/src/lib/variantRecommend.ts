import type { HfVariant } from "@/lib/hf";
import { selectVariant } from "@/lib/variantSelect";

export function roomFromGovernor(status: {
  capBytes: number;
  marginBytes: number;
  loaded: Array<{ peakBytes: number }>;
}): number {
  return Math.max(0, status.capBytes - status.marginBytes - status.loaded.reduce((total, item) => total + item.peakBytes, 0));
}

export function recommendText(variants: HfVariant[], roomBytes: number): string | null {
  const complete = variants.filter((variant) => variant.complete && variant.files.length > 0);
  const selection = selectVariant(complete, {
    roomBytes,
    supportedEngines: ["llama.cpp"],
    enginePreference: ["llama.cpp"],
  });
  if (!selection.chosen) return null;
  const file = selection.chosen.files[0];
  if (!file) return null;
  if (selection.reason === "fits") return `Best fit for this machine right now: ${file}.`;
  if (selection.reason === "unknown-size") return `${file} may fit, its size is not published.`;
  return null;
}
