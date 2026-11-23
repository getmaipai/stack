// The one definition of "which model does this level of this category use" (docs/dev/choices.md, "What runs"). The choices read, the role
// view and every place the Stack starts a model all ask this module, so a choice made on the page and the model that answers cannot
// disagree. Precedence, in one place:
//   1. the household's stored pick for this computer's profile, category and level (`choices.picks`), when it is still offered here and
//      not switched off;
//   2. the legacy setting Home's older builds write (`stack.engines.chat.model`, `stack.voice.engine`):
//      it is mirrored into the Standard pick the moment it is written (`mirrorSettingToPick`), so the two hold the same value and this
//      step only matters on a profile the mirror could not name;
//   3. the first model in the category's order (`parts.choices`) that is offered, fits and is not switched off, when an order is stored;
//   4. the Stack's own recommended model (the tier table's, or the profile binding for a single-model category).
// Pure: it reads the stores and the settings, starts nothing and probes nothing, so the supervisor may call it on every selection and
// the Stack still listens first at start-up (STACK-START-01). Whether a model is installed or loaded is the caller's question
// (`choiceRuntime.ts`); here a pick that is not installed simply never gets chosen by the callers' own installed checks.
import { PROFILE_MODEL_BINDINGS, PROFILE_TIERS } from "@/profiles";
import { reducedRoomBytes, tierRoomBytes } from "@/lib/governor";
import { TIER_CANDIDATES, tierCandidateLists, tierCapBytes, type ProfileId } from "@/lib/tiers";
import { readPartChoices, type Choices } from "@/lib/partChoices";
import { partDef } from "@/lib/partDefs";
import { pickFor, readAddedModels, readPicks, withPick, writePicks, type AddedModel, type ChoiceTier, type Pick as StoredPick, type Picks } from "@/lib/choicesStore";
import { CATEGORY_DEFS, defOf, levelName, type CategoryDef } from "@/lib/choiceCategories";
import { onSettingWritten, settingIntent } from "@/settings";

const GB = 1_000_000_000;
const gb = (bytes: number): string => { const value = bytes / GB; return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} GB`; };

export type ChosenBy = "household" | "setting" | "order" | "recommended" | "off" | "none";
export interface Offered { id: string; fits: boolean; refusal: string | null; kind: "shipped" | "added" }
export interface ResolverEnv { profile: ProfileId; room: number; reducedFreed: number; picks: Picks; partChoices: Choices; added: Record<string, AddedModel>; settings: Record<string, unknown> }
export interface Intended {
  category: string; tier: ChoiceTier;
  /** The model this level uses; null when the level is off or nothing is offered. */
  model: string | null; options: StoredPick["options"] | null; by: ChosenBy;
  /** True when the household's pick (or the legacy setting) is a model that fits; false when it names one that no longer fits. */
  fits: boolean; refusal: string | null;
  /** A plain sentence when a stored pick could not be used (not offered here any more, or switched off), null otherwise. */
  problem: string | null;
}

let profileProvider: () => ProfileId | undefined = () => undefined;
/** The supervisor says which profile this computer is (it learns it at start); the resolver never probes hardware. */
export function setProfileProvider(provider: () => ProfileId | undefined): void { profileProvider = provider; }
const changeListeners: Array<() => void> = [];
/** A module that holds a session-only copy of a choice (the supervisor's "load this model") hears every write to the choices, so the stored choice is never shadowed by a stale preference. */
export function onChoicesChanged(listener: () => void): void { changeListeners.push(listener); }
export function notifyChoicesChanged(): void { for (const listener of changeListeners) listener(); }
export function machineProfile(): ProfileId | undefined { return profileProvider(); }

/** The settings Home's older builds write, as last set (a voice engine change waits for a restart, but the choice is made). */
export function liveSettings(): Record<string, unknown> { const keys = CATEGORY_DEFS.flatMap((def) => def.legacySetting ? [def.legacySetting.key] : []); return Object.fromEntries(keys.map((key) => [key, settingIntent(key)])); }

export function liveEnv(profile: ProfileId | undefined = profileProvider()): ResolverEnv | null {
  if (!profile) return null;
  return { profile, room: tierRoomBytes(), reducedFreed: reducedRoomBytes(), picks: readPicks(), partChoices: readPartChoices(), added: readAddedModels(), settings: liveSettings() };
}

export function addedFits(added: AddedModel, tier: ChoiceTier, env: { room: number; reducedFreed: number }): { fits: boolean; refusal: string | null } {
  const cap = tier === "reduced" ? env.room + env.reducedFreed : tierCapBytes(tier, env.room, env.reducedFreed);
  if (added.ram_bytes <= 0 || added.ram_bytes <= cap) return { fits: true, refusal: null };
  return { fits: false, refusal: `${added.label} needs about ${gb(added.ram_bytes)} and ${levelName(tier)} allows ${gb(cap)} on this computer. Choose a higher level, or a smaller file.` };
}

/** Every model a level may offer on this profile, tier-table order first, with whether it fits (the tier table's decision). */
export function offeredAt(env: ResolverEnv, def: CategoryDef, tier: ChoiceTier): Offered[] {
  const source = def.follows?.[tier] ? defOf(def.follows[tier]!) : undefined;
  if (source) return offeredAt(env, source, tier);
  const out: Offered[] = [];
  if (def.tierCategory && tier === "reduced") {
    const cap = env.room + env.reducedFreed;
    for (const row of TIER_CANDIDATES.filter((candidate) => candidate.category === def.tierCategory && candidate.profiles.includes(env.profile) && candidate.tiers.includes("reduced"))) {
      const peak = row.peaks.reduce((largest, item) => (item.peakBytes > largest ? item.peakBytes : largest), 0);
      out.push({ id: row.id, fits: peak <= cap, refusal: peak <= cap ? null : `${partDef(row.id)?.label ?? row.id} needs about ${gb(peak)} and this computer has ${gb(cap)} to spare.`, kind: "shipped" });
    }
  } else if (def.tierCategory) {
    const level = tierCandidateLists(def.tierCategory, env.profile, env.room, env.reducedFreed).find((item) => item.tier === tier);
    // A part made for minors only (Wan's neutral clips) is never the household's default or pick: the choices list for adults does not carry it either.
    for (const row of level?.candidates ?? []) if (!partDef(row.id)?.minorOnly) out.push({ id: row.id, fits: row.fits, refusal: row.refusal, kind: "shipped" });
  } else {
    const profile = PROFILE_TIERS.find((item) => item.id === env.profile);
    const unavailable = def.role !== null && !!profile?.notAvailable.includes(def.role);
    for (const id of def.partIds ?? []) out.push({ id, fits: !unavailable, refusal: unavailable ? `${def.label} is not available on a ${profile!.minUnifiedGb} GB computer.` : null, kind: "shipped" });
  }
  if (def.addedModels) for (const added of Object.values(env.added)) { const fit = addedFits(added, tier, env); out.push({ id: added.id, fits: fit.fits, refusal: fit.refusal, kind: "added" }); }
  return out;
}

/** The model a legacy setting names for a category's Standard level, or null (`auto`, empty, or not a candidate). */
function legacySettingModel(env: ResolverEnv, def: CategoryDef): string | null {
  if (!def.legacySetting) return null;
  if (def.legacySetting.by === "model") { const value = env.settings[def.legacySetting.key]; return typeof value === "string" && value ? value : null; }
  const value = env.settings[def.legacySetting.key];
  if (typeof value !== "string" || value === "auto" || !value) return null;
  return TIER_CANDIDATES.find((row) => row.category === def.tierCategory && row.engine === value && row.profiles.includes(env.profile))?.id ?? null;
}

const none = (def: CategoryDef, tier: ChoiceTier): Intended => ({ category: def.id, tier, model: null, options: null, by: "none", fits: true, refusal: null, problem: null });

export function decide(env: ResolverEnv, categoryId: string, tier: ChoiceTier): Intended {
  const def = defOf(categoryId);
  if (!def || !def.levels.includes(tier)) return { category: categoryId, tier, model: null, options: null, by: "none", fits: true, refusal: null, problem: null };
  const followed = def.follows?.[tier];
  if (followed) return { ...decide(env, followed, tier), category: def.id, tier };
  const offered = offeredAt(env, def, tier);
  const disabled = env.partChoices[def.partCategory]?.off ?? [];
  const live = (id: string): Offered | undefined => offered.find((item) => item.id === id && !disabled.includes(id));
  const stored = pickFor(env.picks, env.profile, def.id, tier);
  let problem: string | null = null;
  if (stored?.model === "off") return { ...none(def, tier), by: "off" };
  if (stored) {
    const found = live(stored.model);
    if (found) return { category: def.id, tier, model: stored.model, options: stored.options ?? null, by: "household", fits: found.fits, refusal: found.refusal, problem: null };
    const name = partDef(stored.model)?.label ?? env.added[stored.model]?.label ?? stored.model;
    problem = disabled.includes(stored.model) ? `Your saved choice, ${name}, is switched off, so another model runs.` : `Your saved choice, ${name}, is not offered for ${levelName(tier)} any more, so another model runs.`;
  }
  if (tier === "standard") {
    const legacy = legacySettingModel(env, def);
    if (legacy && !disabled.includes(legacy)) return { category: def.id, tier, model: legacy, options: null, by: "setting", fits: live(legacy)?.fits ?? true, refusal: live(legacy)?.refusal ?? null, problem };
  }
  // The order: models the household ranked come first, in that order; the rest keep the Stack's own order. Switched-off and oversized models never lead.
  const explicit = env.partChoices[def.partCategory]?.order ?? [];
  const usable = offered.filter((item) => !disabled.includes(item.id) && item.fits);
  const ranked = [...usable].sort((a, b) => { const x = explicit.indexOf(a.id); const y = explicit.indexOf(b.id); return (x < 0 ? 1e6 : x) - (y < 0 ? 1e6 : y); });
  const ordered = ranked.find((item) => explicit.includes(item.id));
  if (ordered) return { category: def.id, tier, model: ordered.id, options: null, by: "order", fits: true, refusal: null, problem };
  const recommended = recommendedFor(env, def, tier, usable);
  return recommended ? { category: def.id, tier, model: recommended, options: null, by: "recommended", fits: true, refusal: null, problem } : { ...none(def, tier), problem };
}

/** The Stack's own pick when the household has none: the tier table's first fitting model, or the profile's binding for a single-model category. */
export function recommendedFor(env: ResolverEnv, def: CategoryDef, tier: ChoiceTier, usable: Offered[]): string | null {
  const ids = new Set(usable.map((item) => item.id));
  if (def.tierCategory && tier === "reduced") return TIER_CANDIDATES.find((row) => row.category === def.tierCategory && row.profiles.includes(env.profile) && row.tiers.includes("reduced") && ids.has(row.id))?.id ?? null;
  if (def.tierCategory) {
    const list = tierCandidateLists(def.tierCategory, env.profile, env.room, env.reducedFreed).find((item) => item.tier === tier);
    if (list?.recommended && ids.has(list.recommended)) return list.recommended;
    return TIER_CANDIDATES.find((row) => row.category === def.tierCategory && row.profiles.includes(env.profile) && row.tiers.includes(tier) && ids.has(row.id))?.id ?? null;
  }
  const bound = def.role ? PROFILE_MODEL_BINDINGS[env.profile]?.[def.role] : undefined;
  if (bound && ids.has(bound)) return bound;
  return [...usable].sort((a, b) => (partDef(a.id)?.priority ?? 99) - (partDef(b.id)?.priority ?? 99))[0]?.id ?? null;
}

/** The model a start must use because the household chose it (a stored pick, the legacy setting, or the order), or null to leave the choice to the old rules (the profile's binding). A pick that no longer fits is not returned: it is never loaded without a word. */
export function chosenToRun(categoryId: string, tier: ChoiceTier, options: { ignoreFit?: boolean; profile?: ProfileId } = {}): Intended | null {
  const env = liveEnv(options.profile);
  if (!env) return null;
  const intended = decide(env, categoryId, tier);
  if (!intended.model || !["household", "setting", "order"].includes(intended.by)) return null;
  return intended.fits || options.ignoreFit ? intended : null;
}

/** The models switched off for a category (they are never started when another model can answer). */
export function disabledIn(partCategory: string): string[] { return readPartChoices()[partCategory]?.off ?? []; }

// ---- the legacy settings and the pick are one value ----

/**
 * Home's older builds push a choice by writing a setting (`PUT /settings`, a chat model load, `profiles/apply`). The same moment, the
 * Standard pick takes that value, so there is one choice and the page shows what Home chose. A value that names no candidate here, or
 * an empty one (`auto`, "the recommended model"), clears the pick instead, so an older pick never shadows what Home just chose.
 */
export function mirrorSettingToPick(key: string, value: unknown): void {
  const def = CATEGORY_DEFS.find((d) => d.legacySetting?.key === key);
  const profile = profileProvider();
  if (!def?.legacySetting || !profile) return;
  const text = typeof value === "string" ? value : "";
  let model: string | null = null;
  if (text && text !== "auto") {
    if (def.legacySetting.by === "engine") model = TIER_CANDIDATES.find((row) => row.category === def.tierCategory && row.engine === text && row.profiles.includes(profile) && row.tiers.includes("standard"))?.id ?? null;
    else if (def.legacySetting.by === "model") model = TIER_CANDIDATES.some((row) => row.category === def.tierCategory && row.id === text && row.profiles.includes(profile)) || readAddedModels()[text] ? text : null;
    else model = def.partIds?.includes(text) ? text : null;
  }
  const picks = readPicks();
  const current = pickFor(picks, profile, def.id, "standard");
  if (model === null) { if (current && current.model !== "off") writePicks(withPick(picks, profile, def.id, "standard", null)); return; }
  if (current?.model === model) return;
  writePicks(withPick(picks, profile, def.id, "standard", { model }));
}
onSettingWritten((key, value) => { if (CATEGORY_DEFS.some((def) => def.legacySetting?.key === key)) { mirrorSettingToPick(key, value); notifyChoicesChanged(); } });
