// The Stack's model choices (owner decision 2026-11-21, docs/dev/choices.md): the one read the shared AI and models page renders from,
// and the writes behind it. Home and the Stack's own admin page are two views over this. Nothing here knows a person: who may use a
// level stays in Home. The stores are the ones that already exist (choicesStore.ts beside partChoices.ts and the settings); the
// candidates, fit decisions and recommended picks are the tier table's (tiers.ts) and the profile planner's.
import type { StackPartView } from "@maipai/spec/stack/ts/stack-part-view.js";
import { detectHardware, type HardwareInfo } from "@/lib/hardware";
import { PROFILE_MODEL_BINDINGS, PROFILE_TIERS, sizeMachine, type ProfileTier } from "@/profiles";
import { reducedRoomBytes, tierRoomBytes } from "@/lib/governor";
import { resolveTier, TIER_CANDIDATES, tierCandidateLists, tierCapBytes, type TierCandidate, type TierCategory } from "@/lib/tiers";
import { effectivePriority, readPartChoices, writePartChoices, choicesRefusal, type Choices } from "@/lib/partChoices";
import { partDef } from "@/lib/partDefs";
import { listParts } from "@/lib/partsList";
import { recommend, type ProfilePlan } from "@/lib/profilePlanner";
import { isRoleDisabled, rolePriorityOf } from "@/lib/roleSwitches";
import { ROLE_IDS, type RoleId, type RoleState } from "@/roles";
import { getRoleStatus } from "@/lib/supervisor";
import { stepsFromState } from "@/lib/choiceRequires";
import { settingValues, updateSettings } from "@/settings";
import { startModelInstall } from "@/lib/installJobs";
import { ComponentError, componentDefs, startComponentInstall, uninstallComponent } from "@/lib/components";
import type { CatalogModelLike } from "@/lib/modelStore";
import { NOT_YET_PARTS, minProfile, plainQuantization, quantizationFromName, searchText, versionOf } from "@/lib/candidateInfo";
import { getModel, removeModel } from "@/lib/modelStore";
import { listJobs } from "@/lib/jobs";
import { modelView } from "@/routes/models";
import { InspectRefusal, inspectModel } from "@/lib/modelInspect";
import { STACK_CHAT_QWEN38_FLASH_NEXT_MODEL, STACK_CODING_MODEL, STACK_MODELS } from "@/lib/modelCatalog";
import { DiskRefusalError } from "@/lib/diskState";
import { planTidy, runTidy } from "@/lib/tidy";
import { applyProfile, type ApplyOutcome } from "@/lib/profileApply";
import { applyVoiceEngine } from "@/lib/tierPick";
import { TTS_ENGINE_SETTING } from "@/speech/ttsEngines";
import { auditAction, type ActionSource } from "@/lib/adminActions";
import {
  CHOICE_PROFILES, CHOICE_TIERS, dropPicksFor, pickFor, readAddedModels, readMigration, readPicks, withPick, writeAddedModels, writeMigration, writePicks,
  type AddedModel, type ChoiceProfile, type ChoiceTier, type Pick, type Picks,
} from "@/lib/choicesStore";
import type { Candidate, Category, CategoryId, ChoicesView, TierRow, UnusedItem } from "@/lib/choicesSchema";
import { CATEGORY_IDS } from "@/lib/choicesSchema";
import { addedFits, decide, liveSettings, notifyChoicesChanged, type ResolverEnv } from "@/lib/choiceResolver";
import { runningFor } from "@/lib/choiceRuntime";
import { CATEGORY_DEFS, defOf, levelName, resolveCategoryId, type CategoryDef } from "@/lib/choiceCategories";
export { CATEGORY_DEFS, levelName, resolveCategoryId };

const GB = 1_000_000_000;
const gb = (bytes: number): string => { const value = bytes / GB; return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} GB`; };

/** Seams a test replaces: the hardware probe, the part install, the pinned install of an added model and the link reader. */
export interface ChoicesDeps {
  probe: () => Promise<HardwareInfo>;
  installPart: (id: string) => Promise<{ job: string | null }>;
  installPin: typeof startModelInstall;
  inspect: typeof inspectModel;
  parts: (hardware: HardwareInfo) => Promise<StackPartView[]>;
  uninstallPart: typeof uninstallComponent;
  roleStatus: (role: RoleId) => { state: RoleState; reason: string | null };
}
/** The supervisor's engine state narrowed to the role states the steps use (loading and stopped are not loaded yet; busy is answering, which is ready). */
const roleStatusDefault = (role: RoleId): { state: RoleState; reason: string | null } => {
  const status = getRoleStatus(role);
  const state: RoleState = status.state === "busy" ? "ready" : status.state === "loading" || status.state === "stopped" ? "installed" : status.state;
  return { state, reason: status.reason ?? null };
};
export const choicesDeps: ChoicesDeps = {
  probe: detectHardware,
  installPart: async (id) => { const started = await startComponentInstall(id); return { job: started.job }; },
  installPin: startModelInstall,
  inspect: inspectModel,
  parts: async (hardware) => (await listParts({ audience: "adult" }, hardware)).parts,
  uninstallPart: uninstallComponent,
  roleStatus: roleStatusDefault,
};
export function __setChoicesDepsForTests(next: Partial<ChoicesDeps> | null): void {
  choicesDeps.probe = next?.probe ?? detectHardware;
  choicesDeps.installPart = next?.installPart ?? (async (id) => { const started = await startComponentInstall(id); return { job: started.job }; });
  choicesDeps.installPin = next?.installPin ?? startModelInstall;
  choicesDeps.inspect = next?.inspect ?? inspectModel;
  choicesDeps.parts = next?.parts ?? (async (hardware) => (await listParts({ audience: "adult" }, hardware)).parts);
  choicesDeps.uninstallPart = next?.uninstallPart ?? uninstallComponent;
  choicesDeps.roleStatus = next?.roleStatus ?? roleStatusDefault;
}

interface PoolEntry { id: string; kind: "shipped" | "added"; family: string | null; vetting: string | null; row: TierCandidate | null; added: AddedModel | null }
interface State {
  hardware: HardwareInfo; profile: ProfileTier | null; memoryGb: number; room: number; reducedFreed: number;
  parts: Map<string, StackPartView>; pins: Map<string, { pin: CatalogModelLike | undefined; summary: string | null }>; picks: Picks; partChoices: Choices; added: Record<string, AddedModel>;
  lists: Map<TierCategory, ReturnType<typeof tierCandidateLists>>;
}

export async function loadState(): Promise<State> {
  const hardware = await choicesDeps.probe();
  const sized = sizeMachine(hardware);
  const profile = sized.tier;
  const parts = new Map((await choicesDeps.parts(hardware)).map((part) => [part.id, part] as const));
  const pins = new Map<string, { pin: CatalogModelLike | undefined; summary: string | null }>();
  for (const unit of componentDefs()) { const primary = unit.pins.find((pin) => pin.id === unit.id) ?? unit.pins[0]; pins.set(unit.id, { pin: primary, summary: unit.summary }); for (const pin of unit.pins) if (!pins.has(pin.id)) pins.set(pin.id, { pin, summary: null }); }
  const room = tierRoomBytes();
  const reducedFreed = reducedRoomBytes();
  const lists = new Map<TierCategory, ReturnType<typeof tierCandidateLists>>();
  if (profile) for (const def of CATEGORY_DEFS) if (def.tierCategory) lists.set(def.tierCategory, tierCandidateLists(def.tierCategory, profile.id, room, reducedFreed));
  return { hardware, profile, memoryGb: sized.memoryGb, room, reducedFreed, parts, pins, picks: readPicks(), partChoices: readPartChoices(), added: readAddedModels(), lists };
}

/** The resolver's inputs from a read's own state, so the page and the role view decide from the same stores. */
function resolverEnv(state: State): ResolverEnv {
  return { profile: state.profile!.id, room: state.room, reducedFreed: state.reducedFreed, picks: state.picks, partChoices: state.partChoices, added: state.added, settings: liveSettings() };
}

function poolOf(state: State, def: CategoryDef): PoolEntry[] {
  const out: PoolEntry[] = [];
  const seen = new Set<string>();
  if (def.tierCategory) {
    for (const row of TIER_CANDIDATES.filter((candidate) => candidate.category === def.tierCategory)) {
      if (seen.has(row.id) || (!state.parts.has(row.id) && !NOT_YET_PARTS[row.id])) continue;
      seen.add(row.id);
      out.push({ id: row.id, kind: "shipped", family: row.family, vetting: row.vetting ?? null, row, added: null });
    }
  } else for (const id of def.partIds ?? []) if (state.parts.has(id)) out.push({ id, kind: "shipped", family: null, vetting: null, row: null, added: null });
  if (def.id === "chat") for (const added of Object.values(state.added)) out.push({ id: added.id, kind: "added", family: null, vetting: null, row: null, added });
  // A level that follows another category lists that category's installed models too, so its row shows a size and a state. They are options for that level only: offeredAt uses def.partIds for the other levels.
  for (const from of Object.values(def.follows ?? {})) {
    const source = defOf(from!);
    if (source) for (const entry of poolOf(state, source)) if (!out.some((item) => item.id === entry.id) && entry.kind === "shipped" && state.parts.has(entry.id)) out.push(entry);
  }
  return out;
}

function addedModelState(added: AddedModel): { state: Candidate["state"]; percent: number | null } {
  const record = getModel(added.id);
  if (record && modelView(record).state === "installed") return { state: "installed", percent: null };
  const job = listJobs().find((item) => item.kind === "model.install" && (item.input as { model?: string } | null)?.model === added.id && ["queued", "running", "paused", "stalled"].includes(item.state));
  return job ? { state: "installing", percent: job.percent } : { state: "notInstalled", percent: null };
}

function statePlain(part: StackPartView): { state: Candidate["state"]; reason: string | null } {
  switch (part.state) {
    case "ready": return { state: "installed", reason: null };
    case "installing": case "updating": return { state: "installing", reason: part.percent === null ? "Installing." : `Installing, ${Math.round(part.percent)} percent done.` };
    case "failed": return { state: "failed", reason: "The last install did not finish. Install it again." };
    case "unsupported": return { state: "unsupported", reason: part.fits.reason ?? "This computer cannot run it." };
    default: return { state: "notInstalled", reason: part.install_block ?? (part.download_bytes > 0 ? `Not installed. Installing downloads ${gb(part.download_bytes)}.` : "Not installed.") };
  }
}

function peakOf(row: TierCandidate): { bytes: number; verified: boolean } {
  const shown = row.peaks.filter((item) => item.options.size !== "1920x1088");
  const peak = shown.reduce((largest, item) => (item.peakBytes > largest.peakBytes ? item : largest), shown[0] ?? row.peaks[0]!);
  return { bytes: peak.peakBytes, verified: row.peaks.every((item) => item.status === "measured") };
}

function labelOf(state: State, id: string): string { return state.parts.get(id)?.label ?? state.added[id]?.label ?? partDef(id)?.label ?? NOT_YET_PARTS[id]?.label ?? id; }
/** The state of a pool entry in the words the page uses: an added model from its own record, a part from the parts list, a tier-table model with no part yet as unsupported. */
function viewState(state: State, entry: PoolEntry): { state: Candidate["state"]; reason: string | null } {
  if (entry.kind === "added") { const view = addedModelState(entry.added!); return { state: view.state, reason: view.state === "installed" ? null : view.state === "installing" ? "Installing." : `Not installed. Installing downloads ${gb(entry.added!.size_bytes)}.` }; }
  const part = state.parts.get(entry.id);
  return part ? statePlain(part) : { state: "unsupported", reason: "It cannot be installed yet." };
}

function candidateViews(state: State, def: CategoryDef, pool: PoolEntry[], pickableIds: Set<string>): Candidate[] {
  const choices = state.partChoices;
  const ranked = pool.map((entry, index) => {
    const definition = partDef(entry.id);
    const explicit = (choices[def.partCategory]?.order ?? []).indexOf(entry.id);
    const key = entry.kind === "shipped" && definition ? effectivePriority(definition, choices) : explicit >= 0 ? explicit + 1 : 1000 + index;
    return { entry, key };
  }).sort((a, b) => a.key - b.key || a.entry.id.localeCompare(b.entry.id));
  return ranked.map(({ entry }, index): Candidate => {
    const off = (choices[def.partCategory]?.off ?? []).includes(entry.id);
    const pickable = entry.kind === "added" || pickableIds.has(entry.id);
    const added = entry.added;
    const part = state.parts.get(entry.id);
    const known = state.pins.get(entry.id);
    const pin = known?.pin;
    const label = added?.label ?? part?.label ?? NOT_YET_PARTS[entry.id]?.label ?? entry.id;
    const summary = added ? `A chat model added from a link${added.licence ? ` (${added.licence} licence)` : ""}; MaiPai has not tested it.` : part?.description || known?.summary || NOT_YET_PARTS[entry.id]?.summary || "";
    const raw = added ? quantizationFromName(added.file) : typeof pin?.sizing === "object" && pin.sizing !== null && typeof (pin.sizing as { quantization?: unknown }).quantization === "string" ? (pin.sizing as { quantization: string }).quantization : quantizationFromName(entry.id);
    const quantization = plainQuantization(raw);
    const sizedProfile = typeof pin?.sizing === "object" && pin.sizing !== null ? (pin.sizing as { profile?: string }).profile : undefined;
    const lowest = minProfile(entry.row?.profiles ?? (sizedProfile ? [sizedProfile] : []));
    const version = versionOf(label, entry.family);
    const license = added?.licence ?? pin?.license ?? null;
    const repo = added?.repo ?? pin?.repo ?? null;
    const engine = added ? "llama-server" : pin?.engine ?? entry.row?.engine ?? null;
    const view = viewState(state, entry);
    const peak = entry.row ? peakOf(entry.row) : null;
    const size = added ? added.size_bytes : part ? (part.size_bytes > 0 ? part.size_bytes : part.download_bytes) : 0;
    return {
      id: entry.id, label, summary, family: entry.family, version, quantization, quantization_raw: raw, license, repo, engine, role: def.role,
      min_profile: lowest?.plain ?? null, min_profile_id: lowest?.id ?? null,
      search_text: searchText({ label, id: entry.id, repo, family: entry.family, version, quantization, quantization_raw: raw, license, summary, engine, role: def.role }),
      kind: entry.kind, pickable, state: view.state,
      reason: !pickable && view.reason === null && entry.vetting ? "Not offered as a pick yet; it is still being checked." : view.reason,
      size_bytes: size, download_bytes: added ? (view.state === "installed" ? 0 : added.size_bytes) : part?.download_bytes ?? 0,
      peak_bytes: added ? (added.ram_bytes > 0 ? added.ram_bytes : null) : peak?.bytes ?? null, peak_verified: added ? (added.ram_bytes > 0 ? added.verified : null) : peak?.verified ?? null,
      percent: added ? addedModelState(added).percent : part?.percent ?? null,
      can_install: added ? view.state === "notInstalled" : part?.can_install ?? false, can_uninstall: added ? view.state === "installed" : part?.can_uninstall ?? false, licence_needed: part?.licence_needed ?? false,
      enabled: !off, rank: index + 1,
    };
  });
}

interface LevelOptions { options: TierRow["options"]; capBytes: number | null; recommended: string | null; peaks: Map<string, number> }

const addedFit = (added: AddedModel, tier: ChoiceTier, state: State): { fits: boolean; refusal: string | null } => addedFits(added, tier, state);

function levelOptions(state: State, def: CategoryDef, pool: PoolEntry[], tier: ChoiceTier): LevelOptions {
  // A level that follows another category offers exactly what that category does (choiceResolver.ts decides the same).
  const source = def.follows?.[tier] ? defOf(def.follows[tier]!) : undefined;
  if (source) return levelOptions(state, source, poolOf(state, source), tier);
  const profile = state.profile!;
  const ids = new Set(pool.map((entry) => entry.id));
  const peaks = new Map<string, number>();
  let options: TierRow["options"] = [];
  let capBytes: number | null = null;
  let recommended: string | null = null;
  if (def.tierCategory && tier === "reduced") {
    const cap = state.room + state.reducedFreed;
    capBytes = null;
    for (const row of TIER_CANDIDATES.filter((candidate) => candidate.category === def.tierCategory && candidate.profiles.includes(profile.id) && candidate.tiers.includes("reduced") && ids.has(candidate.id))) {
      const peak = peakOf(row).bytes;
      peaks.set(row.id, peak);
      const fits = peak <= cap;
      options.push({ model: row.id, fits, refusal: fits ? null : `${labelOf(state, row.id)} needs about ${gb(peak)} and this computer has ${gb(cap)} to spare.` });
    }
    recommended = resolveTier({ category: def.tierCategory, tier: "reduced", profile: profile.id, roomBytes: state.room, reducedFreedBytes: state.reducedFreed })?.model ?? null;
  } else if (def.tierCategory) {
    const list = state.lists.get(def.tierCategory)?.find((level) => level.tier === tier);
    capBytes = list?.capBytes ?? null;
    options = (list?.candidates ?? []).filter((row) => ids.has(row.id)).map((row) => { peaks.set(row.id, row.peakBytes); return { model: row.id, fits: row.fits, refusal: row.refusal }; });
    recommended = list?.recommended ?? null;
    // A model this list does not carry for the person (a minors-only part) is never the recommendation: the next one that fits is.
    if (recommended && !ids.has(recommended)) recommended = TIER_CANDIDATES.find((candidate) => candidate.category === def.tierCategory && candidate.profiles.includes(profile.id) && candidate.tiers.includes(tier) && ids.has(candidate.id) && options.some((option) => option.model === candidate.id && option.fits))?.id ?? null;
  } else {
    // A single-model category: the parts it names, judged by the part's own fit.
    const unavailable = def.role !== null && profile.notAvailable.includes(def.role);
    for (const entry of pool) {
      const part = state.parts.get(entry.id)!;
      const fits = !unavailable && part.fits.standard;
      options.push({ model: entry.id, fits, refusal: fits ? null : unavailable ? `${def.label} is not available on a ${profile.minUnifiedGb} GB computer.` : part.fits.reason });
    }
    const bound = def.role ? PROFILE_MODEL_BINDINGS[profile.id]?.[def.role] : undefined;
    const choices = state.partChoices;
    recommended = bound && options.some((option) => option.model === bound && option.fits) ? bound : options.filter((option) => option.fits && !(choices[def.partCategory]?.off ?? []).includes(option.model)).sort((a, b) => (partDef(a.model)?.priority ?? 99) - (partDef(b.model)?.priority ?? 99))[0]?.model ?? null;
  }
  if (def.id === "chat") for (const added of Object.values(state.added)) { const fit = addedFit(added, tier, state); options.push({ model: added.id, fits: fit.fits, refusal: fit.refusal }); if (added.ram_bytes > 0) peaks.set(added.id, added.ram_bytes); }
  return { options, capBytes, recommended, peaks };
}

function whyRecommended(state: State, def: CategoryDef, tier: ChoiceTier, level: LevelOptions): string {
  const id = level.recommended;
  if (!id) return `No model in the Stack's list fits ${levelName(tier)} for ${def.label.toLowerCase()} on this computer.`;
  const name = labelOf(state, id);
  const peak = level.peaks.get(id);
  if (tier === "reduced") return `${name} is the smaller model the Stack swaps in to free memory${peak ? ` (about ${gb(peak)})` : ""}.`;
  if (!def.tierCategory) {
    const bound = def.role ? PROFILE_MODEL_BINDINGS[state.profile!.id]?.[def.role] : undefined;
    return bound === id ? `${name} is what a ${state.profile!.minUnifiedGb} GB computer is set up with for ${def.label.toLowerCase()}.` : `${name} is the first ${def.label.toLowerCase()} model in the order that this computer can run.`;
  }
  return `${name} is the first model in the Stack's list for ${levelName(tier)} that fits this computer${peak && level.capBytes ? ` (about ${gb(peak)} of the ${gb(level.capBytes)} this level allows)` : ""}.`;
}

function tierRows(state: State, def: CategoryDef, pool: PoolEntry[], candidates: Candidate[]): TierRow[] {
  const profile = state.profile;
  if (!profile) return [];
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate] as const));
  const rows: TierRow[] = [];
  for (const tier of def.levels) {
    if (tier === "reduced" && !TIER_CANDIDATES.some((candidate) => candidate.category === def.tierCategory && candidate.profiles.includes(profile.id) && candidate.tiers.includes("reduced"))) continue;
    const level = levelOptions(state, def, pool, tier);
    if (level.options.length === 0 && level.recommended === null && tier !== "standard") continue;
    const stored = pickFor(state.picks, profile.id, def.id, tier);
    // One definition of what a level uses (choiceResolver.ts); the role view asks the same function.
    const env = resolverEnv(state);
    const intended = decide(env, def.id, tier);
    const chosen = intended.model;
    const chosenBy: TierRow["chosen_by"] = intended.by === "off" ? "off" : intended.by === "none" ? "none" : intended.by === "recommended" ? "recommended" : "household";
    const problem = intended.problem ?? (chosenBy === "household" && !intended.fits ? intended.refusal : null);
    const running = runningFor(env, def, tier, intended);
    rows.push({
      tier, cap_bytes: level.capBytes, chosen, chosen_by: chosenBy, chosen_state: chosen ? byId.get(chosen)?.state ?? null : null,
      customization: chosenBy === "household" && stored?.options ? stored.options : null, problem, options: level.options, running,
      recommended: { model: level.recommended, why: whyRecommended(state, def, tier, level) },
    });
  }
  return rows;
}

function rolePlanFor(plan: ProfilePlan | null, role: RoleId | null): Category["role_plan"] {
  const row = role ? plan?.roles.find((item) => item.role === role) : undefined;
  return row ? { state: row.state, fit: row.fit, reason: row.reason } : null;
}

/** The category's readiness steps from the role's live state (the same supervisor the role view reads). */
function stepsForRole(role: RoleId): ReturnType<typeof stepsFromState> {
  const status = choicesDeps.roleStatus(role);
  return stepsFromState(status.state, status.reason);
}

function buildCategories(state: State): Category[] {
  const planned = recommend({ hardware: state.hardware, disabled: ROLE_IDS.filter((role) => isRoleDisabled(role)), priority: Object.fromEntries(ROLE_IDS.map((role) => [role, rolePriorityOf(role)])) }).custom_recommended?.plan ?? null;
  return CATEGORY_DEFS.map((def): Category => {
    const pool = poolOf(state, def);
    // First pass: which candidates a level offers at all (a candidate no level offers is ordered and switched off here but never chosen).
    const pickable = new Set<string>();
    if (state.profile) for (const tier of def.levels) for (const option of levelOptions(state, def, pool, tier).options) pickable.add(option.model);
    const candidates = candidateViews(state, def, pool, pickable);
    const tiers = tierRows(state, def, pool, candidates);
    const unavailable = !state.profile ? "This computer's memory is below 16 GB, the least the Stack can run chat and voice on." : def.role && state.profile.notAvailable.includes(def.role) && !def.tierCategory ? `${def.label} is not available on a ${state.profile.minUnifiedGb} GB computer.` : def.tierCategory && tiers.every((row) => row.options.length === 0) ? `${def.label} has no model for a ${state.profile.minUnifiedGb} GB computer.` : null;
    const profiles = CHOICE_PROFILES.flatMap((profile) => {
      const assigned = CHOICE_TIERS.flatMap((tier) => { const pick = pickFor(state.picks, profile, def.id, tier); return pick ? [{ tier, model: pick.model, customization: pick.options ?? null }] : []; });
      const current = state.profile?.id === profile;
      if (!assigned.length && !current) return [];
      return [{ profile, memory_gb: PROFILE_TIERS.find((item) => item.id === profile)!.minUnifiedGb, current, assignments: assigned }];
    });
    const off = state.partChoices[def.partCategory]?.off ?? [];
    return {
      id: def.id, label: def.label, icon: def.icon, description: def.description, role: def.role, role_enabled: def.role ? !isRoleDisabled(def.role) : null, role_priority: def.role ? rolePriorityOf(def.role) : null,
      role_plan: rolePlanFor(planned, def.role), steps: def.role ? stepsForRole(def.role) : [],
      available: unavailable === null, unavailable_reason: unavailable, tiered: def.levels.length > 1,
      order: candidates.map((candidate) => candidate.id), disabled: off.filter((id) => candidates.some((candidate) => candidate.id === id)),
      candidates, tiers: unavailable ? [] : tiers, profiles,
    };
  });
}

// ---- Unused: what no choice, order or fallback uses ----

function usageOf(state: State, categories: Category[]): Map<string, string[]> {
  const used = new Map<string, string[]>();
  const add = (id: string, why: string): void => { used.set(id, [...(used.get(id) ?? []), why]); };
  for (const category of categories) {
    const def = defOf(category.id)!;
    for (const row of category.tiers) if (row.chosen) add(row.chosen, `${category.label} ${levelName(row.tier)} uses it.`);
    const explicit = state.partChoices[def.partCategory]?.order ?? [];
    for (const id of explicit) if (category.candidates.some((candidate) => candidate.id === id) && !(state.partChoices[def.partCategory]?.off ?? []).includes(id)) add(id, `It is in the ${category.label} order. Turn it off or take it out of the order first.`);
  }
  const bound = state.profile ? PROFILE_MODEL_BINDINGS[state.profile.id] ?? {} : {};
  for (const [role, id] of Object.entries(bound)) if (id) add(id, `This computer's setup runs it for ${role}.`);
  const chatModel = settingValues()["stack.engines.chat.model"];
  if (typeof chatModel === "string" && chatModel) add(chatModel, "Chat runs on it now.");
  return used;
}

function unusedItems(state: State, categories: Category[]): UnusedItem[] {
  const used = usageOf(state, categories);
  const items: UnusedItem[] = [];
  const seen = new Set<string>();
  for (const category of categories) for (const candidate of category.candidates) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    if (candidate.state !== "installed" || used.has(candidate.id) || !candidate.can_uninstall || candidate.size_bytes <= 0) continue;
    const part = state.parts.get(candidate.id);
    if (part && part.required_by.length > 0) continue;
    items.push({ id: candidate.id, label: candidate.label, category: category.id, kind: candidate.kind, size_bytes: candidate.size_bytes, reason: `No ${category.label.toLowerCase()} level or order uses it.` });
  }
  return items.sort((a, b) => b.size_bytes - a.size_bytes || a.id.localeCompare(b.id));
}

/** Why an id is not on the unused list right now, in plain words. */
function keptReason(state: State, categories: Category[], id: string): string {
  const candidate = categories.flatMap((category) => category.candidates).find((item) => item.id === id);
  if (!candidate) return `The Stack has no ${id.slice(0, 60)} among its choices.`;
  if (candidate.state !== "installed") return `${candidate.label} is not installed, so there is nothing to remove.`;
  const why = usageOf(state, categories).get(id)?.[0];
  if (why) return `${candidate.label} was kept. ${why}`;
  const part = state.parts.get(id);
  if (part && part.required_by.length > 0) return `${candidate.label} was kept. Another part needs it.`;
  if (!candidate.can_uninstall) return `${candidate.label} was kept. ${part?.uninstall_block ?? "It cannot be removed right now."}`;
  return `${candidate.label} cannot be removed right now, so it was kept.`;
}

// ---- Reads ----

export async function readChoices(): Promise<ChoicesView> {
  const state = await loadState();
  const categories = buildCategories(state);
  const unused = unusedItems(state, categories);
  const migration = readMigration();
  return {
    profile: state.profile?.id ?? null, memory_gb: state.memoryGb, room_bytes: state.room, free_disk_bytes: state.hardware.freeDiskBytes ?? 0, categories,
    unused: { count: unused.length, total_bytes: unused.reduce((sum, item) => sum + item.size_bytes, 0) },
    migration: { done: migration !== null, done_at: migration?.done_at ?? null, accepted: migration?.accepted ?? 0, refused: migration?.refused ?? 0 },
  };
}

export async function readUnused() {
  const state = await loadState();
  const items = unusedItems(state, buildCategories(state));
  const tidy = await planTidy();
  return { items, total_bytes: items.reduce((sum, item) => sum + item.size_bytes, 0), tidy: { reclaimable_bytes: tidy.reclaimable_bytes, items: tidy.items } };
}

// ---- Writes ----

export interface Refusal { ok: false; status: 400 | 404 | 409; code: string; error: string }
export const isRefusal = (value: unknown): value is Refusal => typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
const refuse = (status: Refusal["status"], code: string, error: string): Refusal => ({ ok: false, status, code, error });

export interface PickInput { category: string; tier: string; model: string; options?: Record<string, string | number | boolean>; profile?: ChoiceProfile; install?: boolean }
export interface PickDone { ok: true; category: CategoryId; tier: ChoiceTier; profile: ChoiceProfile; model: string | null; changed: boolean; applied: boolean; pending_restart: boolean; install_job: string | null; note: string | null }
type Judged = { ok: true; def: CategoryDef; tier: ChoiceTier; profile: ChoiceProfile; state: State; pool: PoolEntry[]; entry: PoolEntry | null; own: boolean } | Refusal;

/** The checks a pick passes before anything is stored: known category and level, a candidate of the category, offered for the level on the profile, fits (this computer's own profile), and not unsupported. */
function judgePick(state: State, input: PickInput, system: boolean): Judged {
  // A level that follows another category has no pick of its own: it is judged and stored as that category's pick (one choice, two doors; choiceResolver.ts decides the same).
  { const followed = defOf(resolveCategoryId(input.category) ?? "")?.follows?.[input.tier as ChoiceTier]; if (followed) input = { ...input, category: followed }; }
  const category = resolveCategoryId(input.category);
  const def = category ? defOf(category) : undefined;
  if (!def) return refuse(404, "unknown_category", `The Stack has no category called ${input.category.slice(0, 40)}. Use one of: ${CATEGORY_IDS.join(", ")}.`);
  if (!(CHOICE_TIERS as readonly string[]).includes(input.tier)) return refuse(404, "unknown_level", `${input.tier.slice(0, 40)} is not a level. Use reduced, standard, boost or max.`);
  const tier = input.tier as ChoiceTier;
  if (!def.levels.includes(tier)) return refuse(404, "no_such_level", `${def.label} has no ${levelName(tier)} level.${def.levels.length === 1 ? " It has one model choice, at standard." : ""}`);
  const own = input.profile === undefined || input.profile === state.profile?.id;
  const profile = input.profile ?? state.profile?.id;
  if (!profile) return refuse(409, "computer_too_small", "This computer's memory is below 16 GB, the least the Stack can run chat and voice on, so there is no profile to save a choice for. Name a profile to save one for another computer.");
  if (input.model === "off" && tier === "standard") return refuse(400, "standard_cannot_be_off", `${def.label} always has its Standard level; choose another model for it instead.`);
  if (input.model === "off" || input.model === "recommended") return { ok: true, def, tier, profile, state, pool: [], entry: null, own };
  const pool = poolOf(state, def);
  const entry = pool.find((item) => item.id === input.model) ?? null;
  if (!entry) return refuse(404, "unknown_model", `${input.model.slice(0, 60)} is not a model the Stack offers for ${def.label.toLowerCase()}. Pick one from the list.`);
  const profileTier = PROFILE_TIERS.find((item) => item.id === profile)!;
  const candidateRow = entry.row;
  const offeredElsewhere = entry.kind === "added" || (candidateRow ? candidateRow.profiles.includes(profile) && (tier === "reduced" ? candidateRow.tiers.includes("reduced") : candidateRow.tiers.some((item) => item !== "reduced")) : def.role === null || !profileTier.notAvailable.includes(def.role));
  if (!offeredElsewhere) return refuse(409, "not_offered_here", `${labelOf(state, entry.id)} is not offered for ${levelName(tier)} on a ${profileTier.minUnifiedGb} GB computer.`);
  // Boost and Max chat run through the coding role (Max through coding mode, which starts Qwen3.8 27B or Flash Next): a model the Stack cannot start there is refused, never saved as a choice that changes nothing.
  const runnable = def.heavyAt?.[tier];
  if (runnable && !runnable.includes(entry.id)) {
    const names = runnable.map((id) => labelOf(state, id));
    return refuse(409, "not_runnable_at_level", `${levelName(tier)} ${def.label.toLowerCase()} runs through coding mode, which starts ${names.join(" or ")}. ${labelOf(state, entry.id)} cannot run there. Choose ${runnable.length > 1 ? "one of those" : "that model"} for ${levelName(tier)}, or use Standard for this one.`);
  }
  if (input.options) {
    const known = new Set(candidateRow?.peaks.flatMap((peak) => Object.keys(peak.options)) ?? []);
    const bad = Object.keys(input.options).find((key) => !known.has(key));
    if (bad) return refuse(400, "unknown_option", `${labelOf(state, entry.id)} has no option called ${bad.slice(0, 40)}.${known.size ? ` Its options are: ${[...known].join(", ")}.` : " It has no options."}`);
  }
  if (own && !system) {
    const option = levelOptions(state, def, pool, tier).options.find((item) => item.model === entry.id);
    if (option && !option.fits) return refuse(409, "does_not_fit", option.refusal ?? `${labelOf(state, entry.id)} does not fit ${levelName(tier)} on this computer.`);
    const view = viewState(state, entry);
    if (view.state === "unsupported") return refuse(409, "unsupported", view.reason ?? `${labelOf(state, entry.id)} cannot run on this computer.`);
  }
  return { ok: true, def, tier, profile, state, pool, entry, own };
}

type Effect = { applied: boolean; pending_restart: boolean; note: string | null };
const SAVED_FOR_LATER: Record<string, string> = { reduced: "Reduced chat or voice starts", boost: "Boost chat runs through the coding model, which starts", max: "Max chat runs through coding mode, which starts" };

/**
 * Makes a stored pick the model that answers (docs/dev/choices.md, "What runs"). The pick is already stored, so every start picks it. This
 * swaps a role that is already running: chat, coding, speech to text, embeddings and vision through the existing model load (it keeps the
 * earlier model when the new one will not start), voice through the engine restart (a voice that fails to start falls back to the
 * standard voice and says so). A model that is not installed is saved and waits: the model that answers keeps answering until it is
 * installed and verified. A reply or a request in flight is never cut: the swap waits and the note says so.
 */
async function applyPick(def: CategoryDef, tier: ChoiceTier, entry: PoolEntry, installed: boolean): Promise<Effect> {
  if (tier !== "standard") return { applied: false, pending_restart: false, note: `Saved. It takes effect the next time ${SAVED_FOR_LATER[tier] ?? "that level starts"}.` };
  if (def.id === "voice" && entry.row?.engine) {
    const written = applyVoiceEngine(entry.row.engine);
    const { restartRole, ttsEngineInEffect, activeRequestsOf, activeTtsChoice } = await import("@/lib/supervisor");
    const wanted = entry.row.engine;
    // The running Stack has not learned this computer's profile (or the engine is not offered): the setting is saved and the voice starts with it at the next restart.
    if (activeTtsChoice().requested !== wanted) return { ...written, note: null };
    if (ttsEngineInEffect() === wanted) return { applied: true, pending_restart: false, note: null };
    if (activeRequestsOf("tts") > 0) return { applied: false, pending_restart: true, note: "The voice is speaking now. The new voice starts the next time the voice engine restarts." };
    await restartRole("tts", "model-load");
    return { applied: true, pending_restart: false, note: null };
  }
  if (!installed) return { applied: false, pending_restart: false, note: `The choice is saved. ${def.label} switches to it once it is installed and checked; ${def.id === "chat" ? "chat" : "the model that answers now"} keeps answering until then.` };
  if (def.process) {
    const role = def.role!;
    if (def.id === "chat") updateSettings({ "stack.engines.chat.model": entry.id });
    const supervisor = await import("@/lib/supervisor");
    const loaded = supervisor.loadedModelId(role);
    if (loaded === null || loaded === entry.id) return { applied: true, pending_restart: false, note: null };
    if (supervisor.activeRequestsOf(role) > 0) return { applied: false, pending_restart: true, note: `${def.label} is answering a request now. The new model starts the next time ${def.label.toLowerCase()} restarts.` };
    if (role === "chat" && (await import("@/lib/reducedChat")).reducedChatForcesLight()) return { applied: false, pending_restart: true, note: "Chat is in Reduced now. The new model starts when Reduced ends." };
    if (role === "chat" && (await import("@/lib/homeMode")).currentHomeMode() === "coding") return { applied: false, pending_restart: true, note: "Coding mode is on. The new chat model starts when coding mode ends." };
    // The pick holds the choice from here on: the load's session preference is dropped so a later change to the pick or the order is not shadowed by it.
    try { await supervisor.loadModelForRole(role, entry.id); supervisor.preferModel(role, null); return { applied: true, pending_restart: false, note: null }; }
    catch (error) {
      // The load put the earlier choice back, but the stored pick would start the new model again on this restart: hold the model that was answering until the pick is made again.
      supervisor.preferModel(role, loaded);
      await supervisor.restartRole(role, "model-load").then(() => supervisor.getProcess(role)).catch(() => undefined);
      return { applied: false, pending_restart: false, note: `${labelOfEntry(entry)} could not start, so ${labelOfLoaded(loaded)} keeps answering. Choose it again to try again. ${error instanceof Error ? error.message : ""}`.trim() };
    }
  }
  return { applied: true, pending_restart: false, note: null };
}
const labelOfEntry = (entry: PoolEntry): string => entry.added?.label ?? partDef(entry.id)?.label ?? entry.id;
const labelOfLoaded = (id: string): string => partDef(id)?.label ?? id;

export async function setPick(input: PickInput, source: ActionSource, remote: string): Promise<PickDone | Refusal> {
  const state = await loadState();
  const judged = judgePick(state, input, false);
  if (!judged.ok) return judged;
  const { def, tier, profile, entry, own } = judged;
  const before = pickFor(state.picks, profile, def.id, tier);
  let next: Pick | null;
  if (input.model === "recommended") next = null;
  else if (input.model === "off") next = { model: "off" };
  else next = { model: input.model, ...(input.options ? { options: input.options } : {}) };
  // A download comes first: a level is never set to something that is missing and cannot be had (licence, disk).
  let job: string | null = null;
  let installed = true;
  if (entry && own) {
    const view = viewState(state, entry).state;
    installed = view === "installed";
    if (view === "notInstalled" && (input.install ?? true)) {
      if (entry.kind === "added") return refuse(409, "added_not_installed", `${labelOf(state, entry.id)} was added but is not downloaded. Add it again from its link to download it.`);
      try { job = (await choicesDeps.installPart(entry.id)).job; }
      catch (error) {
        if (error instanceof ComponentError) return refuse(409, error.code, error.message);
        throw error;
      }
    }
  }
  const changed = JSON.stringify(before) !== JSON.stringify(next);
  // The legacy setting and the pick are one value (choiceResolver.ts): clearing the pick back to "recommended" clears the setting too, or the setting would keep the old model running.
  if (next === null && tier === "standard" && own && (def.id === "chat" || def.id === "voice")) updateSettings({ [def.id === "chat" ? "stack.engines.chat.model" : TTS_ENGINE_SETTING]: def.id === "voice" ? "auto" : "" });
  if (changed) writePicks(withPick(state.picks, profile, def.id, tier, next));
  notifyChoicesChanged();
  const effect: Effect = next && next.model !== "off" && own && entry ? await applyPick(def, tier, entry, installed) : { applied: false, pending_restart: false, note: null };
  if (changed) auditAction("choices.pick", source, remote, { category: def.id, level: tier, profile, model: next?.model ?? "recommended" });
  return { ok: true, category: def.id, tier, profile, model: next?.model ?? null, changed, applied: effect.applied, pending_restart: effect.pending_restart, install_job: job, note: effect.note };
}

export interface OrderDone { ok: true; category: CategoryId; order: string[]; disabled: string[] }
export async function setOrder(categoryName: string, body: { order: string[]; off?: string[] }, source: ActionSource, remote: string): Promise<OrderDone | Refusal> {
  const category = resolveCategoryId(categoryName);
  const def = category ? defOf(category) : undefined;
  if (!def) return refuse(404, "unknown_category", `The Stack has no category called ${categoryName.slice(0, 40)}. Use one of: ${CATEGORY_IDS.join(", ")}.`);
  const state = await loadState();
  const poolIds = new Set(poolOf(state, def).map((entry) => entry.id));
  const unknown = [...body.order, ...(body.off ?? [])].find((id) => !poolIds.has(id));
  if (unknown) return refuse(400, "unknown_model", `${unknown.slice(0, 60)} is not a ${def.label.toLowerCase()} model the Stack knows. Use the ids from the category's candidates.`);
  if (new Set(body.order).size !== body.order.length || new Set(body.off ?? []).size !== (body.off ?? []).length) return refuse(400, "duplicate_ids", "A model id appears twice in the list. List each model once.");
  const current = state.partChoices[def.partCategory] ?? { order: [], off: [] };
  const merged: Choices = { ...state.partChoices, [def.partCategory]: { order: [...body.order, ...current.order.filter((id) => !poolIds.has(id))], off: body.off ? [...current.off.filter((id) => !poolIds.has(id)), ...body.off] : current.off } };
  const refusal = choicesRefusal(merged);
  if (refusal) return refuse(refusal.status, refusal.code, refusal.error);
  writePartChoices(merged);
  notifyChoicesChanged();
  auditAction("choices.order", source, remote, { category: def.id, order: body.order.join(","), ...(body.off ? { off: body.off.join(",") } : {}) });
  const after = buildCategories(await loadState()).find((item) => item.id === def.id)!;
  return { ok: true, category: def.id, order: after.order, disabled: after.disabled };
}

export interface RecommendedDone {
  dry_run: boolean; changed: Array<{ category: CategoryId; tier: ChoiceTier; from: string | null; to: string }>; unchanged: number;
  roles: Record<string, boolean | number | string>; installs: Array<{ model: string; job: string }>; skipped: Array<{ model: string; reason: string }>; needs_licence: Array<{ id: string; label: string }>;
}
/** Writes the recommended pick for every level this computer has one for (and, outside a dry run, the recommended role switches as `profiles/apply` does), starting the downloads of the Standard and Reduced picks that are missing. Never removes anything. */
export async function applyRecommended(dryRun: boolean, source: ActionSource, remote: string): Promise<RecommendedDone | Refusal> {
  const state = await loadState();
  if (!state.profile) return refuse(409, "computer_too_small", "This computer's memory is below 16 GB, the least the Stack can run chat and voice on. Nothing was changed.");
  const profile = state.profile.id;
  let roles: Record<string, boolean | number | string> = {};
  let installs: RecommendedDone["installs"] = [];
  let skipped: RecommendedDone["skipped"] = [];
  if (!dryRun) {
    const outcome: ApplyOutcome = await applyProfile({ mode: "custom_recommended" }, { probe: async () => state.hardware, install: choicesDeps.installPin }, source, remote);
    if (!outcome.ok) return refuse(outcome.status === 400 ? 400 : 409, "profile_apply_refused", outcome.error);
    roles = outcome.body.settings; installs = [...outcome.body.installs]; skipped = [...outcome.body.skipped];
  }
  // The role switches just written change what the categories offer, so the picks are judged on the state after them.
  const judged = dryRun ? state : await loadState();
  const categories = buildCategories(judged);
  const changed: RecommendedDone["changed"] = [];
  const needsLicence: RecommendedDone["needs_licence"] = [];
  let picks = judged.picks;
  let unchanged = 0;
  const toInstall = new Set<string>();
  for (const category of categories) for (const row of category.tiers) {
    const model = row.recommended.model;
    if (!model) continue;
    const stored = pickFor(picks, profile, category.id, row.tier);
    if (stored?.model === model && !stored.options) { unchanged += 1; continue; }
    changed.push({ category: category.id, tier: row.tier, from: stored?.model ?? null, to: model });
    picks = withPick(picks, profile, category.id, row.tier, { model });
    if (row.tier === "standard" || row.tier === "reduced") toInstall.add(model);
  }
  if (dryRun) return { dry_run: true, changed, unchanged, roles, installs, skipped, needs_licence: needsLicence };
  writePicks(picks);
  notifyChoicesChanged();
  for (const id of toInstall) {
    const part = judged.parts.get(id);
    if (!part || statePlain(part).state !== "notInstalled" || installs.some((item) => item.model === id)) continue;
    try { const started = await choicesDeps.installPart(id); if (started.job) installs.push({ model: id, job: started.job }); }
    catch (error) {
      if (error instanceof ComponentError && error.code === "licence_required") needsLicence.push({ id, label: part.label });
      else skipped.push({ model: id, reason: error instanceof DiskRefusalError ? error.reason : error instanceof Error ? error.message : "The install could not start." });
    }
  }
  // The recommended Standard voice and chat model take effect the way a pick does.
  for (const change of changed) {
    const def = defOf(change.category)!;
    const entry = poolOf(judged, def).find((item) => item.id === change.to);
    if (entry && change.tier === "standard") await applyPick(def, change.tier, entry, statePlain(judged.parts.get(entry.id) ?? ({ state: "missing", download_bytes: 0, percent: null, fits: { reason: null }, install_block: null } as unknown as StackPartView)).state === "installed");
  }
  auditAction("choices.recommended", source, remote, { changed: String(changed.length), installs: String(installs.length) });
  return { dry_run: false, changed, unchanged, roles, installs, skipped, needs_licence: needsLicence };
}

export interface RemoveDone { results: Array<{ id: string; status: "removed" | "kept" | "failed"; freed_bytes: number; message: string }>; tidy_removed: Array<{ id: string; bytes: number }>; freed_bytes: number; kept: number; failed: number }
/** Removes the chosen unused models. The unused test runs again for every id on fresh state, so a model that became used since the list was read is kept and said so. */
export async function removeUnused(ids: string[], tidy: boolean, source: ActionSource, remote: string): Promise<RemoveDone> {
  const results: RemoveDone["results"] = [];
  let freed = 0; let kept = 0; let failed = 0;
  for (const id of [...new Set(ids)]) {
    const state = await loadState();
    const categories = buildCategories(state);
    const item = unusedItems(state, categories).find((row) => row.id === id);
    if (!item) { results.push({ id, status: "kept", freed_bytes: 0, message: keptReason(state, categories, id) }); kept += 1; continue; }
    try {
      if (item.kind === "added") {
        const bytes = item.size_bytes;
        removeModel(id);
        const added = readAddedModels(); delete added[id]; writeAddedModels(added);
        writePicks(dropPicksFor(readPicks(), id));
        freed += bytes; results.push({ id, status: "removed", freed_bytes: bytes, message: "" });
      } else {
        const removed = await choicesDeps.uninstallPart(id);
        if (removed.removed) freed += removed.freed_bytes;
        results.push({ id, status: "removed", freed_bytes: removed.freed_bytes, message: "" });
      }
    } catch (error) {
      if (error instanceof ComponentError) { results.push({ id, status: "failed", freed_bytes: 0, message: error.message }); failed += 1; continue; }
      throw error;
    }
  }
  const tidyRemoved: RemoveDone["tidy_removed"] = [];
  if (tidy) { const run = await runTidy(false); for (const item of run.removed) { tidyRemoved.push({ id: item.id, bytes: item.bytes }); freed += item.bytes; } }
  if (results.some((row) => row.status === "removed") || tidyRemoved.length) auditAction("choices.unused.remove", source, remote, { removed: String(results.filter((row) => row.status === "removed").length), tidy: String(tidyRemoved.length), freed_bytes: String(freed) });
  return { results, tidy_removed: tidyRemoved, freed_bytes: freed, kept, failed };
}

// ---- Add a model by link and use it ----

const slug = (text: string): string => text.toLowerCase().replace(/\.gguf$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
export function addedModelId(repo: string, file: string, sha256: string): string { return `added-${slug(`${repo}-${file}`).slice(0, 90)}-${sha256.slice(0, 8)}`; }

export interface AddDone { ok: true; id: string; label: string; category: "chat"; tier: ChoiceTier; chosen: boolean; state: Candidate["state"]; install_job: string | null; size_bytes: number; licence: string }
export async function addModel(input: { source: string; file?: string; tier: ChoiceTier; use: boolean }, source: ActionSource, remote: string): Promise<AddDone | Refusal> {
  const state = await loadState();
  if (!state.profile) return refuse(409, "computer_too_small", "This computer's memory is below 16 GB, the least the Stack can run chat and voice on, so a model cannot be added for it.");
  let found: Awaited<ReturnType<typeof inspectModel>>;
  try { found = await choicesDeps.inspect({ source: input.source, ...(input.file ? { file: input.file } : {}) }); }
  catch (error) {
    if (error instanceof InspectRefusal) return refuse(400, "cannot_read_model", error.message);
    return refuse(400, "cannot_read_model", "The model could not be read. Check the link, then try again.");
  }
  const missing = (what: string): Refusal => refuse(400, "model_facts_missing", `The repository does not state ${what}, so the Stack cannot check or size this file. Pick another file.`);
  if (!found.sizeBytes || found.sizeBytes <= 0) return missing("the file size");
  if (!found.sha256 || !/^[a-f0-9]{64}$/.test(found.sha256)) return missing("a checksum for the file");
  if (!found.architecture) return missing("the model's architecture");
  if (!found.licence) return missing("a licence");
  const shipped = STACK_MODELS.find((pin) => pin.download?.sha256.toLowerCase() === found.sha256);
  if (shipped) return refuse(409, "already_shipped", "The Stack already ships that model. Pick it from the list instead.");
  const id = addedModelId(found.repo, found.file, found.sha256);
  const label = `${found.repo.split("/").at(-1) ?? found.repo} (${found.file.replace(/\.gguf$/i, "")})`.slice(0, 200);
  const record: AddedModel = {
    id, label, category: "chat", repo: found.repo, file: found.file, url: found.url, revision: found.revision, sha256: found.sha256, size_bytes: found.sizeBytes, licence: found.licence,
    architecture: found.architecture.name, verified: found.architecture.verified, ram_bytes: Math.round(found.architecture.ramBytes) || 0, added_at: new Date().toISOString(), added_by: source,
  };
  const fit = addedFit(record, input.tier, state);
  if (!fit.fits) return refuse(409, "does_not_fit", fit.refusal ?? `${label} does not fit ${levelName(input.tier)} on this computer.`);
  const existing = state.added[id];
  const added = { ...readAddedModels(), [id]: existing ?? record };
  let job: string | null = null;
  const view = existing ? addedModelState(existing).state : getModel(id) && modelView(getModel(id)!).state === "installed" ? "installed" as const : "notInstalled" as const;
  if (view === "notInstalled") {
    try {
      const pin = { id, role: "chat" as const, repo: found.repo, license: found.licence, revision: found.revision, engine: "llama-server", download: { url: found.url, sha256: found.sha256, approx_bytes: found.sizeBytes } };
      job = (await choicesDeps.installPin(pin, "chat")).job;
    } catch (error) {
      if (error instanceof DiskRefusalError) return refuse(409, "not_enough_space", error.reason);
      return refuse(409, "install_failed", error instanceof Error ? error.message : "The download could not start. Try again.");
    }
  }
  writeAddedModels(added);
  if (input.use) writePicks(withPick(readPicks(), state.profile.id, "chat", input.tier, { model: id }));
  const installed = view === "installed";
  if (input.use) notifyChoicesChanged();
  if (input.use && installed && input.tier === "standard") await applyPick(defOf("chat")!, "standard", { id, kind: "added", family: null, vetting: null, row: null, added: record }, true);
  auditAction("choices.add-model", source, remote, { id, level: input.tier, use: String(input.use) });
  return { ok: true, id, label, category: "chat", tier: input.tier, chosen: input.use, state: installed ? "installed" : "installing", install_job: job, size_bytes: found.sizeBytes, licence: found.licence };
}

// ---- One-time import of Home's old values ----

type MigratedValue = { kind: "slot" | "order" | "feature" | "added_model"; key: string; status: "accepted" | "unchanged" | "refused"; reason: string | null };
export interface MigrateInput {
  dry_run: boolean;
  slots: Array<{ role: string; tier: ChoiceTier; model: string; options?: Record<string, string | number | boolean> }>;
  orders: Array<{ category: string; order: string[] }>;
  features: Array<{ role: string; enabled: boolean }>;
  added_models: Array<{ id: string; label: string; repo: string; file: string; url: string; revision: string; sha256: string; size_bytes: number; licence: string | null; architecture: string; verified: boolean; ram_bytes: number }>;
}
export interface MigrateDone { dry_run: boolean; already_done: boolean; results: MigratedValue[]; accepted: number; refused: MigratedValue[]; done_at: string | null }

/**
 * Imports Home's values once. Each value is accepted or refused on its own with a plain reason; a refused value is returned so Home keeps it and shows it.
 * Marks the migration done unless it is a dry run; a second call after that reads and writes nothing, so Home may repeat it safely.
 */
export async function migrate(input: MigrateInput, source: ActionSource, remote: string): Promise<MigrateDone | Refusal> {
  const done = readMigration();
  if (done) return { dry_run: input.dry_run, already_done: true, results: [], accepted: 0, refused: [], done_at: done.done_at };
  const state = await loadState();
  const results: MigratedValue[] = [];
  const write = !input.dry_run;
  // Added models first, so a slot may name one.
  let added = state.added;
  for (const record of input.added_models) {
    const key = record.id;
    if (record.licence === null) { results.push({ kind: "added_model", key, status: "refused", reason: "The record names no licence, and the Stack installs nothing without one. Add the model again from its link." }); continue; }
    if (added[key]) { results.push({ kind: "added_model", key, status: "unchanged", reason: null }); continue; }
    added = { ...added, [key]: { ...record, licence: record.licence, category: "chat", added_at: new Date().toISOString(), added_by: `migration:${source}` } };
    results.push({ kind: "added_model", key, status: "accepted", reason: null });
  }
  if (write) writeAddedModels(added);
  const afterAdded: State = { ...state, added };
  let picks = state.picks;
  for (const slot of input.slots) {
    const key = `${slot.role}.${slot.tier}`;
    if (!state.profile) { results.push({ kind: "slot", key, status: "refused", reason: "This computer's memory is below 16 GB, so it has no profile to save a choice for." }); continue; }
    if (slot.model === "recommended") {
      const had = pickFor(picks, state.profile.id, resolveCategoryId(slot.role) ?? "", slot.tier);
      if (resolveCategoryId(slot.role) === null) { results.push({ kind: "slot", key, status: "refused", reason: `The Stack has no category called ${slot.role.slice(0, 40)}.` }); continue; }
      if (had) picks = withPick(picks, state.profile.id, resolveCategoryId(slot.role)!, slot.tier, null);
      results.push({ kind: "slot", key, status: had ? "accepted" : "unchanged", reason: null });
      continue;
    }
    // A migrated value is judged like a pick, except that nothing is downloaded and an installed check is not required.
    const judged = judgePick(afterAdded, { category: slot.role, tier: slot.tier, model: slot.model, ...(slot.options ? { options: slot.options } : {}) }, false);
    if (!judged.ok) { results.push({ kind: "slot", key, status: "refused", reason: judged.error }); continue; }
    const next: Pick = slot.model === "off" ? { model: "off" } : { model: slot.model, ...(slot.options ? { options: slot.options } : {}) };
    if (JSON.stringify(pickFor(picks, judged.profile, judged.def.id, judged.tier)) === JSON.stringify(next)) { results.push({ kind: "slot", key, status: "unchanged", reason: null }); continue; }
    picks = withPick(picks, judged.profile, judged.def.id, judged.tier, next);
    results.push({ kind: "slot", key, status: "accepted", reason: null });
  }
  if (write) { writePicks(picks); notifyChoicesChanged(); }
  let partChoices = state.partChoices;
  for (const order of input.orders) {
    const category = resolveCategoryId(order.category);
    const def = category ? defOf(category) : undefined;
    const key = order.category;
    if (!def) { results.push({ kind: "order", key, status: "refused", reason: `The Stack has no category called ${order.category.slice(0, 40)}.` }); continue; }
    const poolIds = new Set(poolOf(afterAdded, def).map((entry) => entry.id));
    const unknown = order.order.find((id) => !poolIds.has(id));
    if (unknown) { results.push({ kind: "order", key, status: "refused", reason: `${unknown.slice(0, 60)} is not a ${def.label.toLowerCase()} model the Stack knows.` }); continue; }
    if (new Set(order.order).size !== order.order.length) { results.push({ kind: "order", key, status: "refused", reason: "A model appears twice in the list." }); continue; }
    const current = partChoices[def.partCategory] ?? { order: [], off: [] };
    const nextChoices: Choices = { ...partChoices, [def.partCategory]: { order: [...order.order, ...current.order.filter((id) => !poolIds.has(id))], off: current.off } };
    if (JSON.stringify(nextChoices[def.partCategory]) === JSON.stringify(current)) { results.push({ kind: "order", key, status: "unchanged", reason: null }); continue; }
    const refusal = choicesRefusal(nextChoices);
    if (refusal) { results.push({ kind: "order", key, status: "refused", reason: refusal.error }); continue; }
    partChoices = nextChoices;
    results.push({ kind: "order", key, status: "accepted", reason: null });
  }
  if (write && partChoices !== state.partChoices) writePartChoices(partChoices);
  const roleWrites: Record<string, boolean> = {};
  for (const feature of input.features) {
    const category = resolveCategoryId(feature.role);
    const role = (ROLE_IDS as readonly string[]).includes(feature.role) ? feature.role as RoleId : category ? defOf(category)?.role ?? null : null;
    const key = feature.role;
    if (!role) { results.push({ kind: "feature", key, status: "refused", reason: `${feature.role.slice(0, 40)} is not a feature the Stack has a switch for.` }); continue; }
    const on = !isRoleDisabled(role);
    if (on === feature.enabled) { results.push({ kind: "feature", key, status: "unchanged", reason: null }); continue; }
    roleWrites[`stack.roles.${role}.enabled`] = feature.enabled;
    results.push({ kind: "feature", key, status: "accepted", reason: null });
  }
  if (write && Object.keys(roleWrites).length) {
    const { updateSettingsAudited } = await import("@/lib/roleSettingsApply");
    await updateSettingsAudited(roleWrites, source, remote, "choices.migrate");
  }
  const accepted = results.filter((row) => row.status !== "refused").length;
  const refused = results.filter((row) => row.status === "refused");
  const doneAt = write ? new Date().toISOString() : null;
  if (write) {
    writeMigration({ done_at: doneAt!, accepted, refused: refused.length });
    auditAction("choices.migrate", source, remote, { accepted: String(accepted), refused: String(refused.length) });
  }
  return { dry_run: input.dry_run, already_done: false, results, accepted, refused, done_at: doneAt };
}
