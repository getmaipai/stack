import { partDef } from "@/lib/partDefs";
import rows from "@/rows/tierCandidates.json";
import featureRows from "@/rows/featureRows.json";

export type TierId = "reduced" | "standard" | "boost" | "max";
export type TierCategory = string;
export type { ProfileId } from "@/lib/profileIds";
import type { ProfileId } from "@/lib/profileIds";
export type SwitchCost = "option" | "family" | "cross";
export type OptionSet = Record<string, string | number | boolean>;
export type PeakStatus = "measured" | "unverified";

export interface TierCandidate {
  id: string;
  category: TierCategory;
  family: string;
  profiles: ProfileId[];
  peaks: Array<{ options: OptionSet; peakBytes: number; status: PeakStatus; note?: string }>;
  tiers: TierId[];
  /** Measured but not on any tier: waiting on MODEL-VET-01. Never resolved, never offered as a pick. */
  vetting?: string;
  /** The voice engine id the Stack runs for this model (`stack.voice.engine`); only voice rows carry it. A pick of the row sets that setting (VOICE-VOXCPM2-01). */
  engine?: string;
  /** Why this row exists or sits where it does: the decision note kept with its row in rows/tierCandidates.json. */
  comment?: string;
}

// Peaks marked "measured" come from docs/design/tier-evaluations-2026-10-30.md in getmaipai/home (Mac Studio, Apple M5 Max, 128 GB). Max video is LTX-2.5 Video Max on p128 (LTX25-MAX-01); Max music has no candidate on purpose: a Max slot is catalogued only with a measured, heard gain over the slot below. The rows live in rows/tierCandidates.json: model ids are data, not logic (the governor imports this file, and the catalog reaches the governor through settings, an import cycle). tests/tierCandidatesRows.test.ts checks the file loads and tests/tiers.test.ts checks its ids against the catalog.
export const TIER_CANDIDATES: TierCandidate[] = rows as unknown as TierCandidate[];

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
/** Reduced chat is the judge model everywhere; Reduced voice is Chatterbox Nano on p64 and the 4-bit build of the Standard voice on p128 (same family as Standard; p128 owner lineup 2026-11-25) and the standard speech model on p16 and p32 (owner ruling 2026-10-30; it stays the fallback). The id comes from the first Reduced row of the category that the profile can hold. */
const reducedModelFor = (category: TierCategory, profile: ProfileId): string | undefined => TIER_CANDIDATES.find((candidate) => candidate.category === category && candidate.profiles.includes(profile) && candidate.tiers.includes("reduced"))?.id;
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
  for (const candidate of available) {
    const peak = candidate.peaks.find((item) => item.peakBytes <= cap && (tier !== "boost" || !rowOfCategory(category)?.boostThinking || item.options.thinking === true));
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
interface TierFeatureRow { id: string; tierCategory?: string; levels: string[]; residentHost?: true; boostThinking?: true }
const FEATURE_ROWS = featureRows as unknown as TierFeatureRow[];
const rowOfCategory = (category: string): TierFeatureRow | undefined => FEATURE_ROWS.find((row) => row.tierCategory === category);
const BUDGET_CATEGORIES: TierCategory[] = FEATURE_ROWS.flatMap((row) => row.tierCategory ? [row.tierCategory] : []);
/** The categories that have a Reduced level (chat and voice): the ones the Reduced swap frees memory from. */
const REDUCED_CATEGORIES: TierCategory[] = FEATURE_ROWS.flatMap((row) => row.tierCategory && row.levels.includes("reduced") ? [row.tierCategory] : []);
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
      if (tier === "reduced" && !resolved && !REDUCED_CATEGORIES.includes(category)) continue;
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
  return REDUCED_CATEGORIES.reduce((sum, category) => {
    const standard = resolveTier({ category, tier: "standard", profile, roomBytes });
    const reduced = resolveTier({ category, tier: "reduced", profile, roomBytes });
    const standardPeak = rowOfCategory(category)?.residentHost && loadedChatPeakBytes != null ? loadedChatPeakBytes : standard?.peakBytes;
    return sum + (standardPeak !== undefined && reduced ? Math.max(0, standardPeak - reduced.peakBytes) : 0);
  }, 0);
}

export function minorTierClamp(tier: TierId): TierId { return tier === "boost" || tier === "max" ? "standard" : tier; }
export function thinkingAllowedFor(band: "child" | "teen" | "adult"): boolean { return band === "adult"; }

/** A minor-only part is named by its neutral label; a picture row whose part table offers a streaming peak adds the suffix when the streaming option is picked. */
export function tierCandidateLabel(id: string, options: OptionSet = {}): string {
  const part = partDef(id);
  const label = part?.minorOnly ? part.neutralLabel : part?.label;
  const streaming = options.ditMode === "stream" && TIER_CANDIDATES.some((candidate) => candidate.id === id && candidate.peaks.some((peak) => peak.options.ditMode === "stream"));
  return `${label ?? id}${streaming ? " (streaming)" : ""}`;
}

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
      const displayPeaks = candidate.peaks.filter((item) => item.options.size !== "1920x1088");
      // A row with several sizes fits a level when one of them does (the resolver runs that one): the level shows the largest size it holds, else the largest size (2026-11-27: LTX-2.5 read as not fitting Standard on p128 because only its Boost size was judged).
      const cap = tierCapBytes(tier, roomBytes, reducedFreedBytes);
      const largestOf = (items: typeof displayPeaks) => items.reduce((largest, item) => (item.peakBytes > largest.peakBytes ? item : largest), items[0]!);
      const fitting = displayPeaks.filter((item) => item.peakBytes <= cap);
      const peak = fitting.length > 0 ? largestOf(fitting) : displayPeaks.length > 0 ? largestOf(displayPeaks) : candidate.peaks[0]!;
      const refusal = customPickRefusal({ category, tier, profile, roomBytes, reducedFreedBytes, model: candidate.id, options: peak.options });
      return { id: candidate.id, label: tierCandidateLabel(candidate.id, peak.options), family: candidate.family, peakBytes: peak.peakBytes, verified: candidate.peaks.every((item) => item.status === "measured"), fits: refusal === null, refusal };
    }),
  }));
}
