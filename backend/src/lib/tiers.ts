// Ids are literals, not imports from modelCatalog: the governor imports this file, and the catalog reaches the governor through settings (an import cycle). tests/tiers.test.ts checks each literal against the catalog constant.
const STACK_IMAGE_ERNIE_ID = "ernie-image-turbo";
const STACK_IMAGE_KLEIN_ID = "flux2-klein-4b";
const STACK_IMAGE_ZIMAGE_ID = "z-image-turbo";
const STACK_MUSIC_MODEL_ID = "ace-step-1-5-turbo";
const STACK_VIDEO_DETAILED_MODEL_ID = "ltx-2-3-distilled-mlx";
const STACK_VIDEO_MODEL_ID = "fastwan2-2-ti2v-5b-mlx-bf16";

export type TierId = "reduced" | "standard" | "boost" | "max";
export type TierCategory = "chat" | "pictures" | "video" | "music" | "voice" | "stems";
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
  /** Measured but not on any tier: waiting on MODEL-VET-01. Never resolved, never offered as a pick. */
  vetting?: string;
}

// Peaks marked "measured" come from docs/design/tier-evaluations-2026-10-30.md in getmaipai/home (Mac Studio, Apple M5 Max, 128 GB). Max video and Max music have no candidate on purpose: a Max slot is catalogued only with a measured, heard gain over the slot below.
export const TIER_CANDIDATES: TierCandidate[] = [
  { id: "muse-glimmer-30b-q4-k-xl", category: "chat", family: "muse", label: "Muse Glimmer 30B Q4_K_XL", profiles: ["p64", "p128"], peaks: [{ options: { thinking: false }, peakBytes: 19_000_000_000, status: "measured", note: "Tier eval 2026-10-30, 18.6 GB resident, 19.0 GB peak." }, { options: { thinking: true, reasoningBudget: 4096 }, peakBytes: 22_500_000_000, status: "unverified" }], tiers: ["standard", "boost"] },
  { id: "muse-glimmer-30b-q4-k-m", category: "chat", family: "muse", label: "Muse Glimmer 30B Q4_K_M", profiles: ["p32"], peaks: [{ options: {}, peakBytes: 17_000_000_000, status: "unverified" }], tiers: ["standard"] },
  { id: "qwen3-8b-instruct-q4-k-m", category: "chat", family: "qwen3", label: "Qwen3 8B", profiles: ["p16"], peaks: [{ options: {}, peakBytes: 7_000_000_000, status: "unverified" }], tiers: ["standard"] },
  { id: "qwen3-4b-q4-k-m", category: "chat", family: "qwen3", label: "Qwen3 4B", profiles: ["p16", "p32", "p64", "p128"], peaks: [{ options: {}, peakBytes: 5_700_000_000, status: "measured", note: "Tier eval 2026-10-30, the judge profile flags, 5.70 GB after eight turns." }], tiers: ["reduced"] },
  { id: "qwen3.8-27b-ud-q4-k-m", category: "chat", family: "qwen3.8", label: "Qwen3.8 27B", profiles: ["p64", "p128"], peaks: [{ options: { thinking: true }, peakBytes: 22_200_000_000, status: "unverified", note: "22.2 GB peak measured with thinking off and no MTP draft; the thinking figure and the MTP run are still open." }], tiers: ["boost"] },
  { id: "qwen3-6-35b-a3b-ud-q4-k-xl", category: "chat", family: "qwen3.6", label: "Qwen3.6 35B A3B", profiles: ["p64", "p128"], peaks: [{ options: { thinking: false }, peakBytes: 23_600_000_000, status: "measured", note: "Tier eval 2026-10-30: 70 tok/s, 9 of 9 searches." }], tiers: [], vetting: "MODEL-VET-01: replacement candidate for Muse at Standard; CHAT-AB-01, KS-BENCH-01 and a licence read come first." },
  { id: "ornith-1-5-122b-mlx-4bit", category: "chat", family: "ornith", label: "Ornith 122B", profiles: ["p128"], peaks: [{ options: {}, peakBytes: 68_700_000_000, status: "measured", note: "Measured design note peak." }], tiers: ["max"] },
  { id: STACK_IMAGE_ERNIE_ID, category: "pictures", family: "ernie", label: "ERNIE Image Turbo", profiles: ["p64", "p128"], peaks: [{ options: {}, peakBytes: 18_800_000_000, status: "measured" }], tiers: ["standard"] },
  { id: STACK_IMAGE_KLEIN_ID, category: "pictures", family: "klein", label: "FLUX.2 Klein 4B", profiles: ["p32", "p64", "p128"], peaks: [{ options: {}, peakBytes: 10_200_000_000, status: "measured" }], tiers: ["standard"] },
  { id: STACK_IMAGE_ZIMAGE_ID, category: "pictures", family: "z-image", label: "Z-Image Turbo", profiles: ["p32", "p64", "p128"], peaks: [{ options: {}, peakBytes: 25_800_000_000, status: "measured" }], tiers: ["boost"] },
  { id: "qwen-image-2512-q8", category: "pictures", family: "qwen-image", label: "Qwen-Image 20B", profiles: ["p128"], peaks: [{ options: { steps: 30 }, peakBytes: 37_400_000_000, status: "measured", note: "Tier eval 2026-10-30, 1024 x 1024, 181 to 212 s. Nine of 22 prompts; Jesse has not yet judged the pictures." }], tiers: ["max"] },
  { id: STACK_VIDEO_MODEL_ID, category: "video", family: "wan", label: "Wan Video", profiles: ["p128"], peaks: [{ options: {}, peakBytes: 25_400_000_000, status: "measured", note: "Tier eval 2026-10-30, 832 x 480, 49 frames. Known artifact: a head can appear behind an umbrella." }], tiers: ["standard"] },
  { id: STACK_VIDEO_DETAILED_MODEL_ID, category: "video", family: "ltx", label: "LTX Detailed Video", profiles: ["p128"], peaks: [{ options: {}, peakBytes: 39_900_000_000, status: "measured", note: "Tier eval 2026-10-30, 768 x 448 with sound." }], tiers: ["boost"] },
  { id: STACK_MUSIC_MODEL_ID, category: "music", family: "ace-step", label: "ACE-Step 1.5 Turbo", profiles: ["p64", "p128"], peaks: [{ options: {}, peakBytes: 16_400_000_000, status: "measured", note: "Tier eval 2026-10-30, MLX peak." }], tiers: ["standard"] },
  { id: "chatterbox-turbo-fp16", category: "voice", family: "chatterbox", label: "Chatterbox Turbo", profiles: ["p64", "p128"], peaks: [{ options: {}, peakBytes: 4_580_000_000, status: "measured", note: "Tier eval 2026-10-30, MLX peak." }], tiers: ["standard"] },
  { id: "chatterbox-nano", category: "voice", family: "chatterbox", label: "Chatterbox Nano", profiles: ["p64", "p128"], peaks: [{ options: {}, peakBytes: 2_770_000_000, status: "measured", note: "Tier eval 2026-10-30, MLX peak with cloning; needs a pinned mlx-audio or a config-reading patch before it ships." }], tiers: ["reduced"] },
  { id: "pocket-tts-english", category: "voice", family: "pocket", label: "Pocket TTS", profiles: ["p16", "p32", "p64", "p128"], peaks: [{ options: {}, peakBytes: 1_600_000_000, status: "measured", note: "Tier eval 2026-10-30, whole process peak." }], tiers: ["reduced", "standard"] },
  { id: "htdemucs", category: "stems", family: "demucs", label: "Demucs 4 stems", profiles: ["p16", "p32", "p64", "p128"], peaks: [{ options: {}, peakBytes: 1_210_000_000, status: "measured", note: "Tier eval 2026-10-30, 40 s song in 2 to 5 s. Boost htdemucs_ft stays out until a listen finds it cleaner." }], tiers: ["standard"] },
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
/** Reduced chat is the judge model everywhere; Reduced voice is Chatterbox Nano on p64 and p128 (same family as Standard) and Pocket TTS on p16 and p32 (owner ruling 2026-10-30; Pocket stays the fallback). */
const reducedModelFor = (category: TierCategory, profile: ProfileId): string | undefined => category === "chat" ? "qwen3-4b-q4-k-m" : category === "voice" ? (profile === "p64" || profile === "p128" ? "chatterbox-nano" : "pocket-tts-english") : undefined;
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
    const id = reducedModelFor(category, profile);
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

/** What the Reduced swap of chat and voice frees on this profile: each category's Standard peak minus its Reduced peak (zero when either is missing). Max may use it (TIER-STACK-02). */
export function reducedFreedBytes(profile: ProfileId, roomBytes: number): number {
  return (["chat", "voice"] as const).reduce((sum, category) => {
    const standard = resolveTier({ category, tier: "standard", profile, roomBytes });
    const reduced = resolveTier({ category, tier: "reduced", profile, roomBytes });
    return sum + (standard && reduced ? Math.max(0, standard.peakBytes - reduced.peakBytes) : 0);
  }, 0);
}

export function minorTierClamp(tier: TierId): TierId { return tier === "boost" || tier === "max" ? "standard" : tier; }
export function thinkingAllowedFor(band: "child" | "teen" | "adult"): boolean { return band === "adult"; }

export interface TierCandidateRow { id: string; label: string; family: string; peakBytes: number; verified: boolean; fits: boolean; refusal: string | null }
export interface TierCandidateList { tier: "standard" | "boost" | "max"; capBytes: number; recommended: string | null; candidates: TierCandidateRow[] }

/** TIER-HOME-04: what a slot dialog may offer for one category on this profile. Every non-Reduced candidate is listed under every level, with whether it fits that level's cap and, when it does not, the plain refusal (resolver rule 1 of resource-tiers section 3a). `recommended` is the resolver's own pick with no custom slot. Pure: the route supplies the profile and the room. */
export function tierCandidateLists(category: TierCategory, profile: ProfileId, roomBytes: number, reducedFreedBytes = 0): TierCandidateList[] {
  const pickable = TIER_CANDIDATES.filter((candidate) => candidate.category === category && candidate.profiles.includes(profile) && candidate.tiers.some((tier) => tier !== "reduced"));
  const ladder = resolveLadder(category, profile, roomBytes, undefined, reducedFreedBytes);
  return tierOrder.map((tier) => ({
    tier,
    capBytes: tierCapBytes(tier, roomBytes, reducedFreedBytes),
    recommended: ladder.find((row) => row.tier === tier)?.resolved?.model ?? null,
    candidates: pickable.map((candidate) => {
      const peak = candidate.peaks.reduce((largest, item) => (item.peakBytes > largest.peakBytes ? item : largest), candidate.peaks[0]!);
      const refusal = customPickRefusal({ category, tier, profile, roomBytes, reducedFreedBytes, model: candidate.id, options: peak.options });
      return { id: candidate.id, label: candidate.label, family: candidate.family, peakBytes: peak.peakBytes, verified: candidate.peaks.every((item) => item.status === "measured"), fits: refusal === null, refusal };
    }),
  }));
}
