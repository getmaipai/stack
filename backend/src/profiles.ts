import type { HardwareInfo } from "@/lib/hardware";
import { sizingMemory, type MemorySource } from "@/lib/hardware";
import type { RoleId } from "@/roles";

export type { RoleId } from "@/roles";

export interface ProfileTier {
  id: "p16" | "p32" | "p64" | "p128";
  level: "minimal" | "moderate" | "recommended";
  label: string;
  minUnifiedGb: number;
  minVramGb: number;
  resident: RoleId[];
  onDemand: RoleId[];
  installedOnly: RoleId[];
  notAvailable: RoleId[];
  speedRange: { min: number; max: number };
}

export const PROFILE_TIERS: ProfileTier[] = [
  {
    id: "p16",
    level: "minimal",
    label: "This computer can run chat and voice, with embeddings when needed. Images, video, and music are not available.",
    minUnifiedGb: 16,
    minVramGb: 16,
    resident: ["chat", "coding", "judge", "router", "stt", "tts"],
    onDemand: ["embed"],
    installedOnly: ["wakeword"],
    // vision stays here: measured 2026-10-06 on a 24 GB machine, it does
    // not fit beside the 8B chat under the governor's margin (docs/dev.md,
    // "The vision role").
    notAvailable: ["rerank", "vision", "image", "video", "music"],
    speedRange: { min: 15, max: 80 },
  },
  {
    id: "p32",
    level: "moderate",
    label: "This computer can run chat, voice, and embeddings, with the judge when needed. Generators are not available.",
    minUnifiedGb: 32,
    minVramGb: 32,
    resident: ["chat", "coding", "judge", "router", "embed", "stt", "tts"],
    onDemand: ["rerank"],
    installedOnly: ["wakeword"],
    notAvailable: ["vision", "image", "video", "music"],
    speedRange: { min: 25, max: 140 },
  },
  {
    id: "p64",
    level: "recommended",
    label: "This computer can run chat, voice, and embeddings, plus one image job at a time. Video and music are not available.",
    minUnifiedGb: 64,
    minVramGb: 64,
    resident: ["chat", "coding", "judge", "router", "embed", "rerank", "stt", "tts"],
    onDemand: ["image"],
    installedOnly: ["wakeword"],
    notAvailable: ["vision", "video", "music"],
    speedRange: { min: 35, max: 220 },
  },
  {
    id: "p128",
    level: "recommended",
    label: "This computer can run chat, voice, embeddings, coding, and one image, video, or music job at a time.",
    minUnifiedGb: 128,
    minVramGb: 128,
    resident: ["chat", "judge", "router", "embed", "rerank", "stt", "tts"],
    onDemand: ["coding", "vision", "image", "video", "music"],
    installedOnly: ["wakeword"],
    notAvailable: [],
    speedRange: { min: 45, max: 320 },
  },
];

/** Household chat pin by tier (STACK-MUSE-01, the owner's rule of
 * 2026-10-16): Qwen3 8B on p16, which is every Mac of 24 GB or less;
 * Muse Glimmer 30B above that, the 17 GB Q4_K_M on p32 and the
 * KQuant-Dynamic Q4_K_XL from p64. The judge shares chat through p16;
 * from p32 it has its own 4B pin and process. */
export const PROFILE_MODEL_BINDINGS: Partial<Record<ProfileTier["id"], Partial<Record<RoleId, string>>>> = {
  p16: { chat: "qwen3-8b-instruct-q4-k-m" },
  p32: { chat: "muse-glimmer-30b-q4-k-m", judge: "qwen3-4b-q4-k-m" },
  p64: { chat: "muse-glimmer-30b-q4-k-xl", judge: "qwen3-4b-q4-k-m" },
  p128: { chat: "muse-glimmer-30b-q4-k-xl", judge: "qwen3-4b-q4-k-m" },
};

/** The tier this machine's sizing memory (see `sizingMemory`) clears, and
 * the memory it was judged on. The figure is rounded to a whole GB first,
 * so a "16 GB" card that reports 15.99 GiB is a 16 GB card. */
export function sizeMachine(hw: HardwareInfo, overrideGb?: number | null): { tier: ProfileTier | null; memoryGb: number; source: MemorySource } {
  const { bytes, source } = sizingMemory(hw, overrideGb);
  const memoryGb = Math.round((bytes / 1_073_741_824) * 10) / 10;
  const wholeGb = Math.round(memoryGb);
  const unified = source === "unified";
  for (let index = PROFILE_TIERS.length - 1; index >= 0; index -= 1) {
    const tier = PROFILE_TIERS[index];
    if (tier && wholeGb > 0 && wholeGb >= (unified ? tier.minUnifiedGb : tier.minVramGb)) return { tier, memoryGb, source };
  }
  return { tier: null, memoryGb, source };
}

export function proposeProfile(hw: HardwareInfo, overrideGb?: number | null): ProfileTier | null {
  return sizeMachine(hw, overrideGb).tier;
}
