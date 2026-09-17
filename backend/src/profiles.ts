import type { HardwareInfo } from "@/lib/hardware";
import { primaryBudgetBytes } from "@/lib/hardware";

// codexhigh-03 moves this union to roles.ts when the role declaration lands.
export type RoleId = "chat" | "coding" | "judge" | "router" | "embed" | "rerank" | "vision" | "stt" | "tts" | "wakeword" | "image" | "video" | "music";

export interface ProfileTier {
  id: "p16" | "p32" | "p64" | "p128";
  label: string;
  minUnifiedGb: number;
  minVramGb: number;
  resident: RoleId[];
  onDemand: RoleId[];
  notAvailable: RoleId[];
}

export const PROFILE_TIERS: ProfileTier[] = [
  {
    id: "p16",
    label: "This computer can run chat and voice, with embeddings when needed. Pictures, video, and music are not available.",
    minUnifiedGb: 16,
    minVramGb: 8,
    resident: ["chat", "stt", "tts"],
    onDemand: ["embed"],
    notAvailable: ["coding", "judge", "router", "rerank", "vision", "wakeword", "image", "video", "music"],
  },
  {
    id: "p32",
    label: "This computer can run chat, voice, and embeddings, with the judge when needed. Generators are not available.",
    minUnifiedGb: 32,
    minVramGb: 16,
    resident: ["chat", "embed", "stt", "tts"],
    onDemand: ["judge"],
    notAvailable: ["coding", "router", "rerank", "vision", "wakeword", "image", "video", "music"],
  },
  {
    id: "p64",
    label: "This computer can run chat, voice, and embeddings, plus one picture job at a time. Video and music are not available.",
    minUnifiedGb: 64,
    minVramGb: 24,
    resident: ["chat", "judge", "embed", "stt", "tts"],
    onDemand: ["image"],
    notAvailable: ["coding", "router", "rerank", "vision", "wakeword", "video", "music"],
  },
  {
    id: "p128",
    label: "This computer can run chat, voice, embeddings, coding, and one picture, video, or music job at a time.",
    minUnifiedGb: 128,
    minVramGb: 48,
    resident: ["chat", "judge", "embed", "stt", "tts"],
    onDemand: ["coding", "vision", "image", "video", "music"],
    notAvailable: ["router", "rerank", "wakeword"],
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
