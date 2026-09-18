import type { HardwareInfo } from "@/lib/hardware";
import { primaryBudgetBytes } from "@/lib/hardware";
import type { RoleId } from "@/roles";

export type { RoleId } from "@/roles";

export interface ProfileTier {
  id: "p16" | "p32" | "p64" | "p128";
  label: string;
  minUnifiedGb: number;
  minVramGb: number;
  resident: RoleId[];
  onDemand: RoleId[];
  installedOnly: RoleId[];
  notAvailable: RoleId[];
}

export const PROFILE_TIERS: ProfileTier[] = [
  {
    id: "p16",
    label: "This computer can run chat and voice, with embeddings when needed. Images, video, and music are not available.",
    minUnifiedGb: 16,
    minVramGb: 8,
    resident: ["chat", "judge", "router", "stt", "tts"],
    onDemand: ["embed"],
    installedOnly: ["wakeword"],
    notAvailable: ["coding", "rerank", "vision", "image", "video", "music"],
  },
  {
    id: "p32",
    label: "This computer can run chat, voice, and embeddings, with the judge when needed. Generators are not available.",
    minUnifiedGb: 32,
    minVramGb: 16,
    resident: ["chat", "judge", "router", "embed", "stt", "tts"],
    onDemand: ["rerank"],
    installedOnly: ["wakeword"],
    notAvailable: ["coding", "vision", "image", "video", "music"],
  },
  {
    id: "p64",
    label: "This computer can run chat, voice, and embeddings, plus one image job at a time. Video and music are not available.",
    minUnifiedGb: 64,
    minVramGb: 24,
    resident: ["chat", "judge", "router", "embed", "rerank", "stt", "tts"],
    onDemand: ["image"],
    installedOnly: ["wakeword"],
    notAvailable: ["coding", "vision", "video", "music"],
  },
  {
    id: "p128",
    label: "This computer can run chat, voice, embeddings, coding, and one image, video, or music job at a time.",
    minUnifiedGb: 128,
    minVramGb: 48,
    resident: ["chat", "judge", "router", "embed", "rerank", "stt", "tts"],
    onDemand: ["coding", "vision", "image", "video", "music"],
    installedOnly: ["wakeword"],
    notAvailable: [],
  },
];

export function proposeProfile(hw: HardwareInfo): ProfileTier | null {
  const availableGb = primaryBudgetBytes(hw) / 1_073_741_824;
  if (availableGb <= 0) return null;
  for (let index = PROFILE_TIERS.length - 1; index >= 0; index -= 1) {
    const tier = PROFILE_TIERS[index];
    if (tier && availableGb >= (hw.isAppleSilicon ? tier.minUnifiedGb : tier.minVramGb)) return tier;
  }
  return null;
}
