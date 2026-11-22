// ADMIN-05: the profile planner. One deterministic, pure function that says
// what this computer should run, in three modes (docs/plans/
// admin-and-standalone-2026-11-21.md, "Profiles"): Matched (a shipped tier
// that fits well), Custom recommended (computed for this exact memory) and
// the fit check Custom uses. It builds on what exists and keeps no second
// copy: tiers and bindings from profiles.ts, model footprints and the slot
// ladder from tiers.ts, the OS reserve and working margins from the
// governor's rules. The hardware probe is an argument, so tests inject it.
import { GovernorRules } from "@/lib/governor";
import { sizeMachine, PROFILE_MODEL_BINDINGS, PROFILE_TIERS, type ProfileTier } from "@/profiles";
import type { HardwareInfo, MemorySource } from "@/lib/hardware";
import { STACK_MODELS } from "@/lib/modelCatalog";
import { defaultRolePriority } from "@/lib/roleSwitches";
import { reducedFreedBytes, resolveLadder, resolveTier, TIER_CANDIDATES, type ProfileId, type TierCategory } from "@/lib/tiers";
import { ROLE_IDS, ROLES, type RoleId } from "@/roles";

const GIB = 1_073_741_824;
const GB = 1_000_000_000;

export type ProfileMode = "matched" | "custom_recommended" | "custom";
export type PlanState = "resident" | "on_demand" | "installed" | "shared" | "off" | "unavailable";
export type PlanFit = "fits" | "queues" | "refused" | "n/a";
export type Basis = "measured" | "estimated";

/** A tier is a good match while the computer is no more than 25 percent above its floor (plan, 2026-11-21). The plan's own example puts a 24 GB computer on p16, which the 25 percent rule alone (20 GB) would not, so p16 carries an explicit ceiling: its design target includes 24 GB machines (the vision note in profiles.ts measured on one). Chosen default, written in the plan. */
export const MATCH_PERCENT = 25;
export const MATCH_CEILING_GB: Record<ProfileTier["id"], number> = { p16: 24, p32: 40, p64: 80, p128: 160 };

/** A custom upgrade (a larger chat model) must leave at least this much room after the resident set. Chosen default, written in the plan. */
export const UPGRADE_HEADROOM_BYTES = 4 * GIB;

/** Sizes of the small roles that no catalog candidate describes: estimates, flagged "estimated" until measured on the machine. */
const SMALL_ROLE_BYTES: Partial<Record<RoleId, number>> = { embed: 0.7 * GB, rerank: 1.2 * GB, wakeword: 0.05 * GB, vision: 6 * GB };
const STT_BYTES = { small: 0.2 * GB, large: 0.9 * GB };

/** Uncensored builds are never chosen automatically; a person picks one by hand in Custom. */
export const PLANNER_EXCLUDED_CHAT: readonly string[] = ["qwen3-8-27b-huihui-abliterated-iq4-xs", "qwen3-6-35b-a3b-huihui-abliterated-q4-k-m", "qwen3-8-flash-next-177b-huihui-abliterated-iq4-xs"];

export interface PlanRole {
  role: RoleId;
  enabled: boolean;
  priority: number;
  state: PlanState;
  model: string | null;
  peak_bytes: number | null;
  basis: Basis | null;
  /** The level a generator or on-demand slot runs at, null for resident roles. */
  slot: "standard" | "boost" | "max" | null;
  fit: PlanFit;
  reason: string;
}
export interface PlanBudget {
  total_bytes: number;
  os_reserve_bytes: number;
  working_margin_bytes: number;
  /** What resident models may fill: total minus the OS reserve. */
  resident_cap_bytes: number;
  resident_bytes: number;
  /** What is left for on-demand work after the resident set (the governor's room). */
  room_bytes: number;
  /** True when the estimated resident set is over the cap: the tier template is kept, and the numbers are estimates. */
  tight: boolean;
}
export interface ProfilePlan {
  tier: ProfileId;
  chat_model: string;
  budget: PlanBudget;
  roles: PlanRole[];
  /** Plain-words notes on choices the planner declined (for example an upgrade it skipped). */
  notes: string[];
}
export interface PlannerInput {
  hardware: HardwareInfo;
  overrideGb?: number | null;
  /** Roles the person turned off; every other role is on. */
  disabled?: Iterable<RoleId>;
  priority?: Partial<Record<RoleId, number>>;
  /** Measured peaks on this machine by model id; wins over the pinned estimate. */
  measuredPeaks?: Record<string, number>;
  /** Chat models the planner may upgrade to, smallest first; defaults to the catalog's non-excluded chat pins. */
  chatLadder?: Array<{ id: string; peakBytes: number; verified: boolean }>;
}
export interface TemplateRow { tier: ProfileTier["id"]; label: string; min_gb: number; cleared: boolean; match: boolean; resident: RoleId[]; on_demand: RoleId[]; not_available: RoleId[] }
export interface Recommendation {
  memory: { gb: number; source: MemorySource; bytes: number };
  matched: { tier: ProfileTier["id"]; quality: "good"; reason: string } | null;
  custom_recommended: { plan: ProfilePlan; why: string[] } | null;
  templates: TemplateRow[];
}

const gb1 = (bytes: number): string => String(Math.round(bytes / GB * 10) / 10);
const upProfile = (tier: ProfileTier): ProfileId | null => PROFILE_TIERS[PROFILE_TIERS.findIndex((item) => item.id === tier.id) + 1]?.id ?? null;
const GENERATORS: Array<{ role: RoleId; category: TierCategory }> = [{ role: "image", category: "pictures" }, { role: "video", category: "video" }, { role: "music", category: "music" }];

function candidatePeak(id: string, measured: Record<string, number> | undefined): { bytes: number; basis: Basis } | null {
  const candidate = TIER_CANDIDATES.find((item) => item.id === id);
  const peak = candidate?.peaks[0];
  if (!candidate || !peak) return null;
  const seen = measured?.[id];
  if (seen !== undefined) return { bytes: seen, basis: "measured" };
  return { bytes: peak.peakBytes, basis: peak.status === "measured" ? "measured" : "estimated" };
}

/** The chat models above the tier's own one that the planner may pick: pinned chat models on a standard or boost slot, not under vetting, not excluded, smallest first. The catalog has none today, so chat stays on the tier's model; the code is here for the day it does. */
export function defaultChatLadder(profile: ProfileId): Array<{ id: string; peakBytes: number; verified: boolean }> {
  const pinned = new Set(STACK_MODELS.filter((pin) => pin.role === "chat" && !pin.component).map((pin) => pin.id));
  const base = PROFILE_MODEL_BINDINGS[profile]?.chat;
  return TIER_CANDIDATES
    .filter((item) => item.category === "chat" && item.profiles.includes(profile) && !item.vetting && item.id !== base && pinned.has(item.id) && !PLANNER_EXCLUDED_CHAT.includes(item.id) && item.tiers.some((tier) => tier === "standard" || tier === "boost"))
    .map((item) => ({ id: item.id, peakBytes: item.peaks[0]!.peakBytes, verified: item.peaks[0]!.status === "measured" }))
    .sort((a, b) => a.peakBytes - b.peakBytes);
}

/** The best slot a generator category has at this room, looking at this tier's candidates and the next tier up's, so a 48 GB computer can offer what only a 64 GB template lists when it truly fits. */
function bestSlot(category: TierCategory, tier: ProfileTier, roomBytes: number): { model: string; peakBytes: number; verified: boolean; slot: "standard" | "boost" | "max" } | null {
  const profiles = [upProfile(tier), tier.id].filter((id): id is ProfileId => id !== null);
  const freed = reducedFreedBytes(tier.id, roomBytes);
  let best: { model: string; peakBytes: number; verified: boolean; slot: "standard" | "boost" | "max" } | null = null;
  for (const profile of profiles) {
    for (const row of resolveLadder(category, profile, roomBytes, undefined, freed)) {
      if (!row.resolved) continue;
      const rank = (slot: string): number => slot === "standard" ? 1 : slot === "boost" ? 2 : 3;
      const fitsNow = row.tier !== "max";
      const currentFits = best !== null && best.slot !== "max";
      // A standard or boost slot that fits now beats a Max one that must wait; within the same kind the higher level wins; the first profile (the upper one) wins a tie.
      if (best === null || (fitsNow && !currentFits) || (fitsNow === currentFits && rank(row.tier) > rank(best.slot))) best = { model: row.resolved.model, peakBytes: row.resolved.peakBytes, verified: row.resolved.verified, slot: row.tier };
    }
  }
  return best;
}

export interface PlanOptions { /** False for the fit check Custom uses: nothing is upgraded, only judged. */ upgrade: boolean; /** Judge the computer against this shipped tier instead of the highest one it clears (Matched can apply a smaller tier). */ tier?: ProfileId }

/** Plans this computer. Null when its memory clears no tier. Same inputs, same plan. */
export function planFor(input: PlannerInput, options: PlanOptions = { upgrade: true }): ProfilePlan | null {
  const size = sizeMachine(input.hardware, input.overrideGb);
  const tier = options.tier ? PROFILE_TIERS.find((item) => item.id === options.tier) ?? size.tier : size.tier;
  if (!tier || !size.tier) return null;
  const totalBytes = Math.round(size.memoryGb * GIB);
  const osReserve = GovernorRules.osMarginBytes;
  const margin = GovernorRules.tiers[tier.id].workingMarginBytes;
  const residentCap = Math.max(0, totalBytes - osReserve);
  const disabled = new Set<RoleId>(input.disabled ?? []);
  const priorityOf = (role: RoleId): number => input.priority?.[role] ?? defaultRolePriority(role);
  const bindings = PROFILE_MODEL_BINDINGS[tier.id] ?? {};
  const rows = new Map<RoleId, PlanRole>();
  const row = (role: RoleId, patch: Partial<PlanRole>): void => {
    rows.set(role, { role, enabled: !disabled.has(role), priority: priorityOf(role), state: "unavailable", model: null, peak_bytes: null, basis: null, slot: null, fit: "n/a", reason: "", ...patch });
  };

  // Resident set: the tier's template roles the person left on. The template is the shipped, known-to-run floor, so it is kept even when the estimates read tight.
  let resident = 0;
  const chatId = bindings.chat ?? "qwen3-8b-instruct-q4-k-m";
  let chat = candidatePeak(chatId, input.measuredPeaks) ?? { bytes: 7 * GB, basis: "estimated" as Basis };
  let chosenChat = chatId;
  const need = (role: RoleId): { model: string | null; bytes: number; basis: Basis } => {
    if (role === "chat") return { model: chosenChat, bytes: chat.bytes, basis: chat.basis };
    if (role === "judge") { const id = bindings.judge; const peak = id ? candidatePeak(id, input.measuredPeaks) : null; return peak ? { model: id!, bytes: peak.bytes, basis: peak.basis } : { model: null, bytes: 0, basis: "measured" }; }
    if (role === "tts") { const slot = resolveTier({ category: "voice", tier: "standard", profile: tier.id, roomBytes: Number.MAX_SAFE_INTEGER }); return slot ? { model: slot.model, bytes: input.measuredPeaks?.[slot.model] ?? slot.peakBytes, basis: input.measuredPeaks?.[slot.model] !== undefined || slot.verified ? "measured" : "estimated" } : { model: null, bytes: 1.6 * GB, basis: "estimated" }; }
    if (role === "stt") return { model: bindings.stt ?? null, bytes: tier.id === "p16" || tier.id === "p32" ? STT_BYTES.small : STT_BYTES.large, basis: "estimated" };
    return { model: null, bytes: SMALL_ROLE_BYTES[role] ?? 0, basis: "estimated" };
  };
  const residentRoles = ROLE_IDS.filter((role) => tier.resident.includes(role) && !disabled.has(role));
  const addResident = (role: RoleId): void => {
    const share = (ROLES[role] as { sharesModelWith?: RoleId }).sharesModelWith;
    const own = need(role);
    if (share && own.model === null) { row(role, { state: "shared", fit: "fits", reason: `Shares the ${ROLES[share].label.toLowerCase()} model; no extra memory.` }); return; }
    resident += own.bytes;
    row(role, { state: "resident", model: own.model, peak_bytes: own.bytes, basis: own.basis, fit: "fits", reason: `Stays loaded, about ${gb1(own.bytes)} GB${own.basis === "estimated" ? " (estimated, not measured here)" : ""}.` });
  };
  for (const role of residentRoles) addResident(role);
  // Embeddings load on demand on the small tiers; everywhere the Stack plans them resident when the room allows, as the tier does from p32.
  const roomAfter = (): number => Math.max(0, Math.min(totalBytes - osReserve - resident, totalBytes - resident - margin));

  // Upgrades (Custom recommended only): the chat model, while it leaves headroom and every generator the tier offers still has a slot.
  const generatorRoles = GENERATORS.filter(({ role }) => !disabled.has(role) && (tier.onDemand.includes(role) || tier.resident.includes(role)));
  const upgradeNotes: string[] = [];
  if (options.upgrade && !disabled.has("chat")) {
    const ladder = (input.chatLadder ?? defaultChatLadder(tier.id)).filter((rung) => rung.peakBytes > chat.bytes);
    const outranked = generatorRoles.some(({ role }) => priorityOf(role) < priorityOf("chat"));
    if (outranked && ladder.length > 0) upgradeNotes.push("Chat keeps its model: a picture, video or music role is ranked above it, so its room is kept.");
    else {
      for (const rung of ladder) {
        const before = resident;
        resident = resident - chat.bytes + rung.peakBytes;
        const keepsSlots = generatorRoles.every(({ category }) => bestSlot(category, tier, roomAfter()) !== null);
        if (roomAfter() >= UPGRADE_HEADROOM_BYTES && keepsSlots) {
          chat = { bytes: rung.peakBytes, basis: rung.verified ? "measured" : "estimated" };
          chosenChat = rung.id;
          row("chat", { ...rows.get("chat")!, model: rung.id, peak_bytes: rung.peakBytes, basis: chat.basis, reason: `Uses the ${rung.id} model because ${gb1(roomAfter())} GB stay spare after it.` });
        } else resident = before;
      }
    }
  }

  const room = roomAfter();
  // On-demand and installed-only template roles, then the roles the template lacks that a generator slot can serve.
  for (const role of ROLE_IDS) {
    if (rows.has(role)) continue;
    if (disabled.has(role)) { row(role, { state: "off", reason: "Turned off." }); continue; }
    const gen = GENERATORS.find((item) => item.role === role);
    if (gen) {
      const slot = bestSlot(gen.category, tier, room);
      if (!slot) { row(role, { state: "unavailable", fit: "refused", reason: `Nothing for ${ROLES[role].label.toLowerCase()} fits in the ${gb1(room)} GB left after the resident models.` }); continue; }
      row(role, { state: "on_demand", model: slot.model, peak_bytes: slot.peakBytes, basis: slot.verified ? "measured" : "estimated", slot: slot.slot, fit: slot.slot === "max" ? "queues" : "fits", reason: slot.slot === "max" ? `Fits only when chat steps down to the smaller model; it waits for room (${gb1(slot.peakBytes)} GB).` : `Loads when asked, at the ${slot.slot} level (${gb1(slot.peakBytes)} GB).` });
      continue;
    }
    if (tier.notAvailable.includes(role)) { row(role, { state: "unavailable", reason: `Needs a larger computer than the ${tier.id.slice(1)} GB setup.` }); continue; }
    if (tier.installedOnly.includes(role)) { row(role, { state: "installed", model: null, peak_bytes: SMALL_ROLE_BYTES[role] ?? null, basis: "estimated", fit: "fits", reason: "Kept on disk; loads when a device that listens is paired." }); continue; }
    if (tier.onDemand.includes(role)) {
      const bound = bindings[role];
      const peak = bound ? candidatePeak(bound, input.measuredPeaks) : null;
      const bytes = peak?.bytes ?? SMALL_ROLE_BYTES[role] ?? 0;
      const fits = bytes <= room;
      row(role, { state: "on_demand", model: bound ?? null, peak_bytes: bytes, basis: peak?.basis ?? "estimated", slot: "standard", fit: fits ? "fits" : bytes <= residentCap ? "queues" : "refused", reason: fits ? `Loads when asked (${gb1(bytes)} GB).` : bytes <= residentCap ? `Needs ${gb1(bytes)} GB and ${gb1(room)} GB are free after the resident models, so it waits for room.` : `Needs ${gb1(bytes)} GB, more than this computer can give models.` });
      continue;
    }
    row(role, { state: "unavailable", reason: "Not part of this setup." });
  }

  const roles = ROLE_IDS.map((role) => rows.get(role)!).sort((a, b) => a.priority - b.priority || ROLE_IDS.indexOf(a.role) - ROLE_IDS.indexOf(b.role));
  const budget: PlanBudget = { total_bytes: totalBytes, os_reserve_bytes: osReserve, working_margin_bytes: margin, resident_cap_bytes: residentCap, resident_bytes: Math.round(resident), room_bytes: Math.round(room), tight: resident > residentCap };
  return { tier: tier.id, chat_model: chosenChat, budget, roles, notes: upgradeNotes };
}

/** The plain-words reasons for a plan. */
export function explainPlan(plan: ProfilePlan, memoryGb: number): string[] {
  const why: string[] = [];
  const b = plan.budget;
  why.push(`${memoryGb} GB of memory, less ${gb1(b.os_reserve_bytes)} GB kept for the computer, leaves ${gb1(b.resident_cap_bytes)} GB for models.`);
  why.push(`The resident models (${plan.roles.filter((r) => r.state === "resident").map((r) => r.role).join(", ")}) take about ${gb1(b.resident_bytes)} GB, which leaves ${gb1(b.room_bytes)} GB for pictures, video, music and coding.`);
  if (b.tight) why.push("The resident models are estimated a little over the budget; the shipped setup for this size is kept and the numbers are estimates until measured here.");
  const chat = plan.roles.find((r) => r.role === "chat");
  if (chat?.model) why.push(chat.reason.startsWith("Uses") ? chat.reason : `Chat uses the ${chat.model} model: no larger chat model in the catalog is cleared for automatic choice.`);
  for (const role of plan.roles.filter((r) => r.state === "on_demand" && r.fit !== "n/a" && GENERATORS.some((g) => g.role === r.role))) why.push(`${ROLES[role.role].label} runs at the ${role.slot} level: ${role.reason}`);
  for (const role of plan.roles.filter((r) => r.state === "unavailable" && r.fit === "refused")) why.push(role.reason);
  why.push(...plan.notes);
  return why;
}

export function templateRows(memoryGb: number, source: MemorySource): TemplateRow[] {
  return PROFILE_TIERS.map((tier) => {
    const floor = source === "unified" ? tier.minUnifiedGb : tier.minVramGb;
    return { tier: tier.id, label: tier.label, min_gb: floor, cleared: Math.round(memoryGb) >= floor, match: Math.round(memoryGb) >= floor && Math.round(memoryGb) <= MATCH_CEILING_GB[tier.id], resident: tier.resident, on_demand: tier.onDemand, not_available: tier.notAvailable };
  });
}

/** Matched, Custom recommended and the template list for this computer. */
export function recommend(input: PlannerInput): Recommendation {
  const size = sizeMachine(input.hardware, input.overrideGb);
  const memory = { gb: size.memoryGb, source: size.source, bytes: Math.round(size.memoryGb * GIB) };
  const templates = templateRows(size.memoryGb, size.source);
  const top = size.tier ? templates.find((row) => row.tier === size.tier!.id)! : null;
  const matched = top && top.match ? { tier: top.tier, quality: "good" as const, reason: `Matches the ${top.min_gb} GB setup: ${size.memoryGb} GB is within ${MATCH_PERCENT} percent of its ${top.min_gb} GB floor${top.tier === "p16" && size.memoryGb > 20 ? " (the 16 GB setup is built for computers up to 24 GB)" : ""}.` } : null;
  const plan = planFor(input);
  return { memory, matched, custom_recommended: plan ? { plan, why: explainPlan(plan, size.memoryGb) } : null, templates };
}
