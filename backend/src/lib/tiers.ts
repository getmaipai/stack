// Ids are literals, not imports from modelCatalog: the governor imports this file, and the catalog reaches the governor through settings (an import cycle). tests/tiers.test.ts checks each literal against the catalog constant.
const STACK_IMAGE_ERNIE_ID = "ernie-image-turbo";
const STACK_IMAGE_KLEIN_ID = "flux2-klein-4b";
const STACK_IMAGE_ZIMAGE_ID = "z-image-turbo";
const STACK_MUSIC_MODEL_ID = "ace-step-1-5-turbo";
const STACK_VIDEO_DETAILED_MODEL_ID = "ltx-2-3-distilled-mlx";
const STACK_VIDEO_MODEL_ID = "fastwan2-2-ti2v-5b-mlx-bf16";

export type TierId = "reduced" | "standard" | "boost" | "max";
export type TierCategory = "chat" | "pictures" | "video" | "music" | "voice";
export type ProfileId = "p16" | "p32" | "p64" | "p128";
export type SwitchCost = "option" | "family" | "cross";
export type OptionSet = Record<string, string | number | boolean>;
export type PeakStatus = "measured" | "unverified";

export interface TierCandidate {
  id: string;
  category: TierCategory;
  family: string;
  label: string;
  profiles: ProfileId[];
  peaks: Array<{ options: OptionSet; peakBytes: number; status: PeakStatus; note?: string }>;
  tiers: TierId[];
}

export const TIER_CANDIDATES: TierCandidate[] = [
  { id: "muse-glimmer-30b-q4-k-xl", category: "chat", family: "muse", label: "Muse Glimmer 30B Q4_K_XL", profiles: ["p64", "p128"], peaks: [{ options: { thinking: false }, peakBytes: 21_000_000_000, status: "unverified" }, { options: { thinking: true, reasoningBudget: 4096 }, peakBytes: 22_500_000_000, status: "unverified" }], tiers: ["standard", "boost"] },
  { id: "muse-glimmer-30b-q4-k-m", category: "chat", family: "muse", label: "Muse Glimmer 30B Q4_K_M", profiles: ["p32"], peaks: [{ options: {}, peakBytes: 17_000_000_000, status: "unverified" }], tiers: ["standard"] },
  { id: "qwen3-8b-instruct-q4-k-m", category: "chat", family: "qwen3", label: "Qwen3 8B", profiles: ["p16"], peaks: [{ options: {}, peakBytes: 7_000_000_000, status: "unverified" }], tiers: ["standard"] },
  { id: "qwen3-4b-q4-k-m", category: "chat", family: "qwen3", label: "Qwen3 4B", profiles: ["p16", "p32", "p64", "p128"], peaks: [{ options: {}, peakBytes: 4_000_000_000, status: "unverified" }], tiers: ["reduced"] },
  { id: "qwen3.8-27b-ud-q4-k-m", category: "chat", family: "qwen3.8", label: "Qwen3.8 27B", profiles: ["p64", "p128"], peaks: [{ options: { thinking: true }, peakBytes: 16_000_000_000, status: "unverified" }], tiers: ["boost"] },
  { id: "ornith-1-5-122b-mlx-4bit", category: "chat", family: "ornith", label: "Ornith 122B", profiles: ["p128"], peaks: [{ options: {}, peakBytes: 68_700_000_000, status: "measured", note: "Measured design note peak." }], tiers: ["max"] },
  { id: STACK_IMAGE_ERNIE_ID, category: "pictures", family: "ernie", label: "ERNIE Image Turbo", profiles: ["p64", "p128"], peaks: [{ options: {}, peakBytes: 18_800_000_000, status: "measured" }], tiers: ["standard"] },
  { id: STACK_IMAGE_KLEIN_ID, category: "pictures", family: "klein", label: "FLUX.2 Klein 4B", profiles: ["p32", "p64", "p128"], peaks: [{ options: {}, peakBytes: 10_200_000_000, status: "measured" }], tiers: ["standard"] },
  { id: STACK_IMAGE_ZIMAGE_ID, category: "pictures", family: "z-image", label: "Z-Image Turbo", profiles: ["p32", "p64", "p128"], peaks: [{ options: {}, peakBytes: 25_800_000_000, status: "measured" }], tiers: ["boost"] },
  { id: "ernie-image-base", category: "pictures", family: "ernie", label: "ERNIE Image Base", profiles: ["p128"], peaks: [{ options: { steps: 50, guidance: true }, peakBytes: 30_000_000_000, status: "unverified" }], tiers: ["max"] },
  { id: STACK_VIDEO_MODEL_ID, category: "video", family: "wan", label: "Wan Video", profiles: ["p128"], peaks: [{ options: {}, peakBytes: 44_000_000_000, status: "measured" }], tiers: ["standard"] },
  { id: STACK_VIDEO_DETAILED_MODEL_ID, category: "video", family: "ltx", label: "LTX Detailed Video", profiles: ["p128"], peaks: [{ options: {}, peakBytes: 46_000_000_000, status: "measured" }], tiers: ["boost"] },
  { id: "ltx-2-3-dev-two-stage", category: "video", family: "ltx", label: "LTX 2.3 Two Stage", profiles: ["p128"], peaks: [{ options: {}, peakBytes: 66_000_000_000, status: "unverified" }], tiers: ["max"] },
  { id: STACK_MUSIC_MODEL_ID, category: "music", family: "ace-step", label: "ACE-Step 1.5 Turbo", profiles: ["p64", "p128"], peaks: [{ options: {}, peakBytes: 33_000_000_000, status: "measured" }], tiers: ["standard"] },
  { id: "ace-step-1-5-xl-turbo", category: "music", family: "ace-step", label: "ACE-Step XL Turbo", profiles: ["p64", "p128"], peaks: [{ options: {}, peakBytes: 35_000_000_000, status: "unverified" }], tiers: ["boost"] },
  { id: "ace-step-1-5-xl-base", category: "music", family: "ace-step", label: "ACE-Step XL Base", profiles: ["p64", "p128"], peaks: [{ options: {}, peakBytes: 40_000_000_000, status: "unverified" }], tiers: ["max"] },
  { id: "chatterbox-turbo-fp16", category: "voice", family: "chatterbox", label: "Chatterbox Turbo", profiles: ["p64", "p128"], peaks: [{ options: {}, peakBytes: 4_800_000_000, status: "measured" }], tiers: ["standard"] },
  { id: "chatterbox-nano", category: "voice", family: "chatterbox", label: "Chatterbox Nano", profiles: ["p64", "p128"], peaks: [{ options: {}, peakBytes: 1_500_000_000, status: "unverified" }], tiers: ["reduced"] },
  { id: "pocket-tts-english", category: "voice", family: "pocket", label: "Pocket TTS", profiles: ["p16", "p32", "p64", "p128"], peaks: [{ options: {}, peakBytes: 1_000_000_000, status: "unverified" }], tiers: ["reduced", "standard"] },
];

export const TIER_CAP_FRACTIONS = { standard: 0.6, boost: 0.85, max: 1 } as const;
const GB = 1_000_000_000;
export function tierCapBytes(tier: TierId, roomBytes: number, reducedFreedBytes = 0): number {
  if (tier === "reduced") return 0;
  if (tier === "max") return roomBytes + reducedFreedBytes;
  return TIER_CAP_FRACTIONS[tier] * roomBytes;
}

export interface Resolved { tier: TierId; model: string; options: OptionSet; switchCost: SwitchCost; peakBytes: number; verified: boolean; family: string; }
export interface ResolveInput { category: TierCategory; tier: TierId; profile: ProfileId; roomBytes: number; reducedFreedBytes?: number; slot?: { model: string | "recommended" | "off"; options?: OptionSet }; below?: Resolved | null; }
const reducedModels: Partial<Record<TierCategory, string>> = { chat: "qwen3-4b-q4-k-m", voice: "pocket-tts-english" };
const equalOptions = (a: OptionSet, b: OptionSet): boolean => JSON.stringify(Object.entries(a).sort(([x], [y]) => x.localeCompare(y))) === JSON.stringify(Object.entries(b).sort(([x], [y]) => x.localeCompare(y)));
const candidatesFor = (category: TierCategory, tier: TierId, profile: ProfileId): TierCandidate[] => TIER_CANDIDATES.filter((candidate) => candidate.category === category && candidate.profiles.includes(profile) && candidate.tiers.includes(tier));
function cost(candidate: TierCandidate, options: OptionSet, below?: Resolved | null): SwitchCost {
  if (!below) return "cross";
  if (below.model === candidate.id) return "option";
  return below.family === candidate.family ? "family" : "cross";
}
function toResolved(candidate: TierCandidate, tier: TierId, peak: TierCandidate["peaks"][number], below?: Resolved | null): Resolved {
  return { tier, model: candidate.id, options: { ...peak.options }, switchCost: cost(candidate, peak.options, below), peakBytes: peak.peakBytes, verified: peak.status === "measured", family: candidate.family };
}
export function resolveTier(input: ResolveInput): Resolved | null {
  const { category, tier, profile, roomBytes, slot, below } = input;
  if (slot?.model === "off") return null;
  const cap = tierCapBytes(tier, roomBytes, input.reducedFreedBytes);
  if (tier === "reduced") {
    const id = reducedModels[category];
    if (!id) return null;
    const candidate = TIER_CANDIDATES.find((item) => item.category === category && item.id === id && item.profiles.includes(profile));
    const peak = candidate?.peaks.find((item) => !slot?.options || equalOptions(item.options, slot.options));
    return candidate && peak && peak.peakBytes <= roomBytes + (input.reducedFreedBytes ?? 0) ? toResolved(candidate, tier, peak, below) : null;
  }
  const available = candidatesFor(category, tier, profile);
  if (slot && slot.model !== "recommended") {
    const candidate = available.find((item) => item.id === slot.model);
    const peak = candidate?.peaks.find((item) => !slot.options || equalOptions(item.options, slot.options));
    return candidate && peak && peak.peakBytes <= cap ? toResolved(candidate, tier, peak, below) : null;
  }
  const ordered = tier === "boost" && category === "chat"
    ? [...available].sort((a, b) => Number(b.id === "muse-glimmer-30b-q4-k-xl") - Number(a.id === "muse-glimmer-30b-q4-k-xl"))
    : available;
  for (const candidate of ordered) {
    const peak = candidate.peaks.find((item) => item.peakBytes <= cap && (tier !== "boost" || category !== "chat" || item.options.thinking === true));
    if (peak) return toResolved(candidate, tier, peak, below);
  }
  return null;
}

const tierOrder = ["standard", "boost", "max"] as const;
export function resolveLadder(category: TierCategory, profile: ProfileId, roomBytes: number, slots?: Partial<Record<TierId, { model: string | "recommended" | "off"; options?: OptionSet }>>, reducedFreedBytes = 0): Array<{ tier: "standard" | "boost" | "max"; resolved: Resolved | null; hidden: boolean; hiddenReason: "unavailable" | "same_as_below" | "off" | null }> {
  let below: Resolved | null = null;
  return tierOrder.map((tier, index) => {
    const slot = slots?.[tier];
    const resolved = resolveTier({ category, tier, profile, roomBytes, reducedFreedBytes, slot, below });
    const hiddenReason: "unavailable" | "same_as_below" | "off" | null = slot?.model === "off" ? "off" : !resolved ? "unavailable" : index > 0 && below?.model === resolved.model && equalOptions(below.options, resolved.options) ? "same_as_below" : null;
    const row = { tier, resolved, hidden: hiddenReason === "same_as_below", hiddenReason };
    if (resolved) below = resolved;
    return row;
  });
}

export function customPickRefusal(input: ResolveInput & { model: string; options?: OptionSet }): string | null {
  const selected = TIER_CANDIDATES.find((candidate) => candidate.category === input.category && candidate.id === input.model && candidate.profiles.includes(input.profile) && candidate.tiers.some((tier) => tier !== "reduced"));
  const peak = selected?.peaks.find((item) => !input.options || equalOptions(item.options, input.options));
  if (!selected || !peak || peak.peakBytes <= tierCapBytes(input.tier, input.roomBytes, input.reducedFreedBytes)) return null;
  if (peak.peakBytes > tierCapBytes("max", input.roomBytes, input.reducedFreedBytes)) return `This needs ${Math.round(peak.peakBytes / GB)} GB and this computer can never hold it.`;
  const name = input.tier[0]!.toUpperCase() + input.tier.slice(1);
  const next = input.tier === "standard" ? "Boost or Max" : input.tier === "boost" ? "Max" : "Max";
  return `This needs ${Math.round(peak.peakBytes / GB)} GB. ${name} keeps Home free, so it can't hold it. Use ${next}.`;
}

export function minorTierClamp(tier: TierId): TierId { return tier === "boost" || tier === "max" ? "standard" : tier; }
export function thinkingAllowedFor(band: "child" | "teen" | "adult"): boolean { return band === "adult"; }
