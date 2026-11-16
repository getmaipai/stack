// Ids are literals, not imports from modelCatalog: the governor imports this file, and the catalog reaches the governor through settings (an import cycle). tests/tiers.test.ts checks each literal against the catalog constant.
const STACK_IMAGE_ERNIE_ID = "ernie-image-turbo";
const STACK_IMAGE_H3_ID = "minimax-h3-image";
const STACK_IMAGE_KLEIN_ID = "flux2-klein-4b";
const STACK_IMAGE_ZIMAGE_ID = "z-image-turbo";
const STACK_MUSIC_MODEL_ID = "ace-step-1-5-turbo";
const STACK_VIDEO_MODEL_ID = "fastwan2-2-ti2v-5b-mlx-bf16";
const STACK_VIDEO_LTX25_MODEL_ID = "ltx-2-5-q8-distilled-mlx";
const STACK_VIDEO_LTX25_MAX_MODEL_ID = "ltx-2-5-bf16-distilled-mlx-max";
const STACK_VIDEO_H3_ID = "minimax-h3";
const STACK_VIDEO_MASK_MODEL_ID = "sam2.1-hiera-small";

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

// Peaks marked "measured" come from docs/design/tier-evaluations-2026-10-30.md in getmaipai/home (Mac Studio, Apple M5 Max, 128 GB). Max video is LTX-2.5 Video Max on p128 (LTX25-MAX-01); Max music has no candidate on purpose: a Max slot is catalogued only with a measured, heard gain over the slot below.
export const TIER_CANDIDATES: TierCandidate[] = [
  { id: "muse-glimmer-30b-q4-k-xl", category: "chat", family: "muse", label: "Muse Glimmer 30B Q4_K_XL", profiles: ["p64", "p128"], peaks: [{ options: { thinking: false }, peakBytes: 19_000_000_000, status: "measured", note: "Tier eval 2026-10-30, 18.6 GB resident, 19.0 GB peak." }, { options: { thinking: true, reasoningBudget: 4096 }, peakBytes: 22_500_000_000, status: "unverified" }], tiers: ["standard", "boost"] },
  { id: "muse-glimmer-30b-q4-k-m", category: "chat", family: "muse", label: "Muse Glimmer 30B Q4_K_M", profiles: ["p32"], peaks: [{ options: {}, peakBytes: 17_000_000_000, status: "unverified" }], tiers: ["standard"] },
  { id: "qwen3-8b-instruct-q4-k-m", category: "chat", family: "qwen3", label: "Qwen3 8B", profiles: ["p16"], peaks: [{ options: {}, peakBytes: 7_000_000_000, status: "unverified", note: "Tier eval 2026-10-30 measured 8.06 GB after eight turns, above this figure: at 0.6 of a 12 GB room Standard would not fit, so the figure stays until the p16 room is decided." }], tiers: ["standard"] },
  { id: "qwen3-4b-q4-k-m", category: "chat", family: "qwen3", label: "Qwen3 4B", profiles: ["p16", "p32", "p64", "p128"], peaks: [{ options: {}, peakBytes: 5_700_000_000, status: "measured", note: "Tier eval 2026-10-30, the judge profile flags, 5.70 GB after eight turns." }], tiers: ["reduced"] },
  { id: "qwen3.8-27b-ud-q4-k-m", category: "chat", family: "qwen3.8", label: "Qwen3.8 27B", profiles: ["p64", "p128"], peaks: [{ options: { thinking: true }, peakBytes: 22_200_000_000, status: "unverified", note: "22.2 GB peak measured with thinking off and no MTP draft; the thinking figure and the MTP run are still open." }], tiers: ["boost"] },
  { id: "qwen3-6-35b-a3b-ud-q4-k-xl", category: "chat", family: "qwen3.6", label: "Qwen3.6 35B A3B", profiles: ["p64", "p128"], peaks: [{ options: { thinking: false }, peakBytes: 23_600_000_000, status: "measured", note: "Tier eval 2026-10-30: 70 tok/s, 9 of 9 searches." }], tiers: [], vetting: "MODEL-VET-01: replacement candidate for Muse at Standard; CHAT-AB-01, KS-BENCH-01 and a licence read come first." },
  { id: "ornith-1-5-122b-mlx-4bit", category: "chat", family: "ornith", label: "Ornith 122B", profiles: ["p128"], peaks: [{ options: {}, peakBytes: 68_700_000_000, status: "measured", note: "Measured design note peak." }], tiers: ["max"] },
  // H3-IMAGE-STACK-01: MiniMax H3-Image goes first, so it is the recommended Standard and Boost picture model wherever it fits; the others stay as candidates. Resident (22 GB held, 19.7 GB measured) on p64 and p128; a streaming Standard candidate (2.5 GB held, 1.8 GB measured) on p16 and p32. Max stays on Qwen-Image: the 2048 and 4096 px Max numbers are an open bench (H3-MAX-01).
  { id: STACK_IMAGE_H3_ID, category: "pictures", family: "minimax-h3", label: "MiniMax H3-Image", profiles: ["p64", "p128"], peaks: [{ options: {}, peakBytes: 22_000_000_000, status: "measured", note: "Studio bakeoff 2026-11-15, 1024 x 1024, 6 steps: resident 11 to 15 s, 19.7 GB whole-process-tree peak (22 GB held); streaming from disk 27 to 33 s at 1.8 GB." }], tiers: ["standard", "boost"] },
  { id: STACK_IMAGE_H3_ID, category: "pictures", family: "minimax-h3", label: "MiniMax H3-Image (streaming)", profiles: ["p16", "p32"], peaks: [{ options: { ditMode: "stream" }, peakBytes: 2_500_000_000, status: "measured", note: "Studio bakeoff 2026-11-15, 1024 x 1024, 6 steps: streaming from disk 27 to 33 s at 1.8 GB (2.5 GB held)." }], tiers: ["standard"] },
  { id: STACK_IMAGE_ERNIE_ID, category: "pictures", family: "ernie", label: "ERNIE Image Turbo", profiles: ["p64", "p128"], peaks: [{ options: {}, peakBytes: 18_800_000_000, status: "measured" }], tiers: ["standard"] },
  { id: STACK_IMAGE_KLEIN_ID, category: "pictures", family: "klein", label: "FLUX.2 Klein 4B", profiles: ["p32", "p64", "p128"], peaks: [{ options: {}, peakBytes: 10_200_000_000, status: "measured" }], tiers: ["standard"] },
  { id: STACK_IMAGE_ZIMAGE_ID, category: "pictures", family: "z-image", label: "Z-Image Turbo", profiles: ["p32", "p64", "p128"], peaks: [{ options: {}, peakBytes: 25_800_000_000, status: "measured" }], tiers: ["boost"] },
  { id: "qwen-image-2512-q8", category: "pictures", family: "qwen-image", label: "Qwen-Image 20B", profiles: ["p128"], peaks: [{ options: { steps: 30 }, peakBytes: 37_400_000_000, status: "measured", note: "Tier eval 2026-10-30, 1024 x 1024, 181 to 212 s. Nine of 22 prompts; the Max picture slot is the owner's decision of 2026-10-30." }], tiers: ["max"] },
  { id: STACK_VIDEO_MODEL_ID, category: "video", family: "wan", label: "Wan Video", profiles: ["p128"], peaks: [{ options: {}, peakBytes: 25_400_000_000, status: "measured", note: "Tier eval 2026-10-30, 832 x 480, 49 frames. Known artifact: a head can appear behind an umbrella." }], tiers: ["standard"] },
  { id: STACK_VIDEO_MASK_MODEL_ID, category: "video", family: "sam2", label: "SAM 2.1 subject masks", profiles: ["p64", "p128"], peaks: [{ options: {}, peakBytes: 4_900_000_000, status: "measured", note: "LOCAL-BENCH-01, 2026-11-06, 4.9 GB peak; tracking at about 5.5 fps on MPS." }], tiers: [] },
  { id: STACK_VIDEO_LTX25_MODEL_ID, category: "video", family: "ltx", label: "LTX-2.5 Video with sound", profiles: ["p128"], peaks: [
    { options: { size: "512x256", seconds: 5 }, peakBytes: 25_300_000_000, status: "measured", note: "VIDEO-TIERS-01, M5 Max OS footprint, 2026-11-02." },
    { options: { size: "512x256", seconds: 10 }, peakBytes: 39_400_000_000, status: "measured", note: "Standard slot: 241 frames, 43 s." },
    { options: { size: "640x320", seconds: 5 }, peakBytes: 32_400_000_000, status: "measured", note: "Boost slot." },
    { options: { size: "768x448", seconds: 5 }, peakBytes: 45_800_000_000, status: "measured", note: "Boost slot." },
  ], tiers: [], vetting: "VIDEO-TIERS-01: the Stack runs it (LTX25-ENGINE-01); Home's design step moves the Standard and Boost video slots here while the Wan Quick lane remains available for minors. The Max profile (1024x576, 10 s, 48.6 GB, LTX25-MAX-01) is the separate model ltx-2-5-bf16-distilled-mlx-max on the dgrauet runtime; its slot is Home's to enable." },
  { id: STACK_VIDEO_LTX25_MAX_MODEL_ID, category: "video", family: "ltx", label: "LTX-2.5 Video Max", profiles: ["p128"], peaks: [{ options: { input: "words" }, peakBytes: 51_000_000_000, status: "measured", note: "LTX25 Max words peak from video/ltx25.ts." }, { options: { input: "picture" }, peakBytes: 61_500_000_000, status: "measured", note: "LTX25 Max picture peak from video/ltx25.ts." }], tiers: ["max"] },
  { id: STACK_VIDEO_H3_ID, category: "video", family: "minimax-h3", label: "MiniMax H3 Video (8-bit)", profiles: ["p128"], peaks: [{ options: { build: "8bit", size: "864x480", seconds: 5 }, peakBytes: 42_100_000_000, status: "measured", note: "Home H3 eval 2026-11-15: 8-bit, 25 steps, 864x480, 5 s, stereo sound; 641 s and 42.1 GB." }], tiers: ["boost"] },
  { id: STACK_VIDEO_H3_ID, category: "video", family: "minimax-h3", label: "MiniMax H3 Video (streaming)", profiles: ["p16", "p32", "p64", "p128"], peaks: [{ options: { build: "streaming", size: "864x480", seconds: 5 }, peakBytes: 14_800_000_000, status: "measured", note: "Home H3 eval 2026-11-16: Core4 stream2, 5 steps, 864x480, 5 s; 170 s and 14.8 GB." }], tiers: ["reduced", "standard"] },
  { id: STACK_MUSIC_MODEL_ID, category: "music", family: "ace-step", label: "ACE-Step 1.5 Turbo", profiles: ["p64", "p128"], peaks: [{ options: {}, peakBytes: 16_400_000_000, status: "measured", note: "Tier eval 2026-10-30, MLX peak." }], tiers: ["standard"] },
  { id: "chatterbox-turbo-fp16", category: "voice", family: "chatterbox", label: "Chatterbox Turbo", profiles: ["p64", "p128"], peaks: [{ options: {}, peakBytes: 4_580_000_000, status: "measured", note: "Tier eval 2026-10-30, MLX peak." }], tiers: ["standard"] },
  { id: "chatterbox-nano", category: "voice", family: "chatterbox", label: "Chatterbox Nano", profiles: ["p64", "p128"], peaks: [{ options: {}, peakBytes: 2_770_000_000, status: "measured", note: "Tier eval 2026-10-30, MLX peak with cloning; needs a pinned mlx-audio or a config-reading patch before it ships." }], tiers: ["reduced"] },
  { id: "pocket-tts-english", category: "voice", family: "pocket", label: "Pocket TTS", profiles: ["p16", "p32", "p64", "p128"], peaks: [{ options: {}, peakBytes: 1_600_000_000, status: "measured", note: "Tier eval 2026-10-30, whole process peak." }], tiers: ["reduced", "standard"] },
  { id: "htdemucs", category: "stems", family: "demucs", label: "Demucs 4 stems", profiles: ["p16", "p32", "p64", "p128"], peaks: [{ options: {}, peakBytes: 1_210_000_000, status: "measured", note: "Tier eval 2026-10-30, 40 s song in 2 to 5 s. Boost htdemucs_ft stays out until a listen finds it cleaner." }], tiers: ["standard"] },
];

export const TIER_CAP_FRACTIONS = { standard: 0.6, boost: 0.85, max: 1 } as const;
const GB = 1_000_000_000;
/** A level's cap. Standard and Boost are fractions of the resident room; Max is the resident room plus what Reduced frees (the Max room, TIER-ROOM-01). This is the one place that arithmetic lives: the governor's tierRoomBytes("max") and every route go through it. */
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

export interface BudgetSlot { category: TierCategory; tier: TierId; model: string | null; peak_bytes: number | null; basis: "measured" | "estimated" | null; verified: boolean; resident_bytes: number | null; fits_ever: boolean }
const BUDGET_CATEGORIES: TierCategory[] = ["chat", "pictures", "video", "music", "voice", "stems"];
const BUDGET_TIERS: TierId[] = ["reduced", "standard", "boost", "max"];
/**
 * TIER-BUDGET-01: what each level of each category needs on this profile, from the tier room (what the machine can ever hold), never from memory free now; fit-now is the governor's call at admission. A category appears when the profile has a candidate for it; inside it every level is listed, with nulls when no model is catalogued. Resolution ignores the cap so an oversized model still shows its peak; `fits_ever` compares it with the level's cap. `resident_bytes` is null: no design footprint is catalogued yet. TIER-ROOM-01 (the "max" mode of tierRoomBytes) is where the Max cells would use the Max room.
 */
export function budgetSlots(profile: ProfileId | null | undefined, roomBytes = 0): BudgetSlot[] {
  if (!profile) return [];
  const rows: BudgetSlot[] = [];
  for (const category of BUDGET_CATEGORIES) {
    if (!TIER_CANDIDATES.some((candidate) => candidate.category === category && candidate.profiles.includes(profile) && !candidate.vetting && candidate.tiers.length > 0)) continue;
    const ladder = resolveLadder(category, profile, Number.MAX_SAFE_INTEGER);
    for (const tier of BUDGET_TIERS) {
      const resolved = tier === "reduced" ? resolveTier({ category, tier, profile, roomBytes: Number.MAX_SAFE_INTEGER }) : ladder.find((row) => row.tier === tier)?.resolved ?? null;
      if (tier === "reduced" && !resolved && category !== "chat" && category !== "voice") continue;
      rows.push({ category, tier, model: resolved?.model ?? null, peak_bytes: resolved?.peakBytes ?? null, basis: resolved ? (resolved.verified ? "measured" : "estimated") : null, verified: resolved?.verified ?? false, resident_bytes: null, fits_ever: resolved ? resolved.peakBytes <= (tier === "reduced" ? roomBytes : tierCapBytes(tier, roomBytes)) : false });
    }
  }
  return rows;
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
export function reducedFreedBytes(profile: ProfileId, roomBytes: number, loadedChatPeakBytes?: number | null): number {
  return (["chat", "voice"] as const).reduce((sum, category) => {
    const standard = resolveTier({ category, tier: "standard", profile, roomBytes });
    const reduced = resolveTier({ category, tier: "reduced", profile, roomBytes });
    const standardPeak = category === "chat" && loadedChatPeakBytes != null ? loadedChatPeakBytes : standard?.peakBytes;
    return sum + (standardPeak !== undefined && reduced ? Math.max(0, standardPeak - reduced.peakBytes) : 0);
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
