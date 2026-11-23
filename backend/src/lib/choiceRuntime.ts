// What actually answers for a level of a category, next to what the household chose (docs/dev/choices.md, "What runs"). The role view
// (`GET /stack/v1/roles`) and the choices read (`GET /stack/v1/choices`) both call `runningFor`, so they cannot disagree.
// A model that is chosen but not installed, or does not fit, is never loaded silently: the model that was answering keeps answering and
// `reason` says why in plain words.
import type { RoleId } from "@/roles";
import { TIER_CANDIDATES } from "@/lib/tiers";
import { partDef } from "@/lib/partDefs";
import { categoryOfRole, defOf, levelName, type CategoryDef } from "@/lib/choiceCategories";
import { decide, liveEnv, type Intended, type ResolverEnv } from "@/lib/choiceResolver";
import type { ChoiceTier } from "@/lib/choicesStore";
import { currentHomeMode } from "@/lib/homeMode";
import { reducedChatForcesLight } from "@/lib/reducedChat";
import { activeTtsChoice, loadedModelId, selectableModel, selectedModel, ttsEngineInEffect } from "@/lib/supervisor";
import { TTS_ENGINES } from "@/speech/ttsEngines";
import { codingModeHeavy } from "@/lib/splashStore";
import { componentInstalledNow } from "@/lib/components";
import { DEFAULT_FAMILY, familyInstalled, installedFamilies, isFamilyId } from "@/images/models";
import { qualityOfModelName, videoGen, VIDEO_SPECS } from "@/video/videoGen";

export interface RunningView {
  /** True when this level is the one in use now (chat is Standard unless Reduced or coding mode is on; a job level is always live). */
  active: boolean;
  /** The model answering this level, or the one the next request would start; null when none. */
  model: string | null;
  /** True when the chosen model is the one answering. */
  answering: boolean;
  /** Plain words for why a chosen model is not answering (not installed, does not fit, waits for a restart), or null. */
  reason: string | null;
}

const name = (id: string | null | undefined, env: ResolverEnv): string => !id ? "no model" : partDef(id)?.label ?? env.added[id]?.label ?? id;

/** Whether a job category's model is on disk. */
function jobInstalled(def: CategoryDef, id: string): boolean {
  if (def.id === "pictures") return isFamilyId(id) && familyInstalled(id);
  if (def.id === "video") { const quality = qualityOfModelName(id); return quality !== null && videoGen.hasModels(quality); }
  return componentInstalledNow(id) === true;
}

/** The model a job asked for without naming one runs: the level's chosen model when it is installed and fits, else the old default (the model that ran before a choice existed). */
export function jobModelFor(def: CategoryDef, tier: ChoiceTier, intended: Intended): { model: string | null; chosenInstalled: boolean } {
  const chosenInstalled = intended.model !== null && jobInstalled(def, intended.model);
  if (intended.model && chosenInstalled && intended.fits) return { model: intended.model, chosenInstalled };
  if (def.id === "pictures") return { model: familyInstalled(DEFAULT_FAMILY) ? DEFAULT_FAMILY : installedFamilies()[0] ?? null, chosenInstalled };
  if (def.id === "video") return { model: videoGen.hasModels("quick") ? VIDEO_SPECS.quick.modelId : null, chosenInstalled };
  return { model: null, chosenInstalled };
}

export function runningFor(env: ResolverEnv, def: CategoryDef, tier: ChoiceTier, intended: Intended): RunningView {
  const wanted = intended.model;
  const none = (active: boolean, reason: string | null): RunningView => ({ active, model: null, answering: false, reason });
  if (intended.by === "off") return none(false, `${def.label} is switched off at this level.`);
  if (def.tierCategory === "voice" || def.id === "voice") {
    if (tier === "reduced") return none(false, "The Stack does not switch to a smaller voice for Reduced; the voice you chose for Standard keeps speaking.");
    return voiceRunning(env, wanted);
  }
  if (def.process) return processRunning(env, def, tier, intended);
  if (def.tierCategory || def.id === "stems") {
    const { model, chosenInstalled } = jobModelFor(def, tier, intended);
    if (!wanted) return { active: true, model, answering: false, reason: null };
    if (model === wanted) return { active: true, model, answering: true, reason: null };
    const reason = !chosenInstalled ? `${name(wanted, env)} is chosen but not installed yet, so ${model ? name(model, env) : "no model"} answers until it is installed.` : !intended.fits ? `${intended.refusal ?? `${name(wanted, env)} does not fit ${tier} on this computer.`} ${model ? `${name(model, env)} answers meanwhile.` : ""}`.trim() : null;
    return { active: true, model, answering: false, reason };
  }
  return { active: true, model: wanted, answering: wanted !== null, reason: null };
}

/** The level a process role is serving right now: chat is Standard, Reduced while the swap is on, Max while coding mode is on. */
export function activeLevelOf(role: RoleId): ChoiceTier {
  if (role === "chat" || role === "judge" || role === "router") return reducedChatForcesLight() ? "reduced" : currentHomeMode() === "coding" ? "max" : "standard";
  const own = categoryOfRole(role);
  if (own?.follows?.max || own?.heavyAt?.max) return currentHomeMode() === "coding" ? "max" : "standard";
  return "standard";
}

function processRunning(env: ResolverEnv, def: CategoryDef, tier: ChoiceTier, intended: Intended): RunningView {
  const role = def.role!;
  const active = activeLevelOf(role) === tier;
  const wanted = intended.model;
  if (!active) return { active: false, model: null, answering: false, reason: null };
  const loaded = loadedModelId(role);
  const next = selectedModel(role)?.id ?? null;
  const serving = loaded ?? next;
  if (!wanted) return { active, model: serving, answering: false, reason: null };
  if (def.heavyAt?.[tier] || def.follows?.[tier]) {
    const heavy = codingModeHeavy().pin.id;
    const answering = heavy === wanted;
    return { active, model: heavy, answering, reason: answering ? null : `Coding mode runs ${name(heavy, env)}: ${name(wanted, env)} is chosen for Max but cannot start (it is not installed with its draft, or coding mode cannot run it).` };
  }
  if (serving === wanted) return { active, model: serving, answering: true, reason: null };
  // Why the chosen model is not the one answering.
  const startable = selectableModel(role, wanted) !== null;
  const meanwhile = serving ? `${name(serving, env)} keeps answering` : "nothing answers";
  if (!startable) return { active, model: serving, answering: false, reason: `${name(wanted, env)} is chosen but not installed yet, so ${meanwhile} until it is installed.` };
  if (!intended.fits) return { active, model: serving, answering: false, reason: `${intended.refusal ?? `${name(wanted, env)} does not fit this computer.`} ${serving ? `${name(serving, env)} keeps answering.` : ""}`.trim() };
  if (next === wanted && loaded !== null) return { active, model: serving, answering: false, reason: `${name(wanted, env)} starts the next time ${def.label.toLowerCase()} restarts; ${name(serving, env)} answers until then.` };
  if (next !== wanted) return { active, model: serving, answering: false, reason: `${name(wanted, env)} did not start the last time it was tried, so ${meanwhile}. Choose it again to try again.` };
  return { active, model: serving, answering: false, reason: intended.problem };
}

function voiceRunning(env: ResolverEnv, wanted: string | null): RunningView {
  const effective = ttsEngineInEffect();
  const serving = TIER_CANDIDATES.find((row) => row.category === "voice" && row.engine === effective && row.profiles.includes(env.profile))?.id ?? null;
  const wantedEngine = wanted ? TIER_CANDIDATES.find((row) => row.category === "voice" && row.id === wanted)?.engine ?? null : null;
  if (!wanted) return { active: true, model: serving, answering: false, reason: null };
  if (wantedEngine === effective) return { active: true, model: serving, answering: true, reason: null };
  const choice = activeTtsChoice();
  if (wantedEngine && choice.requested === wantedEngine && choice.engine !== wantedEngine) return { active: true, model: serving, answering: false, reason: choice.reason };
  const label = wantedEngine ? TTS_ENGINES[wantedEngine as keyof typeof TTS_ENGINES]?.label ?? wanted : wanted;
  return { active: true, model: serving, answering: false, reason: `${label} starts the next time the voice engine restarts; ${serving ? name(serving, env) : "the current voice"} speaks until then.` };
}

/** The role's own view: the category it answers for, the level in use, what was chosen and what answers. Null for a role with no category (judge, router, rerank, helper). */
export function roleChoice(role: RoleId): { category: string; level: ChoiceTier; chosen: string | null; chosen_by: "household" | "recommended" | "off" | "none"; model: string | null; answering: boolean; active: boolean; reason: string | null } | null {
  const def = categoryOfRole(role);
  const env = liveEnv();
  if (!def || !env) return null;
  const level = def.tierCategory && !def.levels.includes("standard") ? def.levels[0]! : activeLevelOf(role);
  const intended = decide(env, def.id, level);
  const running = runningFor(env, def, level, intended);
  return { category: def.id, level, chosen: intended.model, chosen_by: intended.by === "setting" || intended.by === "order" ? "household" : intended.by, model: running.model, answering: running.answering, active: running.active, reason: running.reason ?? intended.problem };
}

export { defOf };

/**
 * The model a job runs when its request names none (a picture, a clip): what the level's choices say, when that model is installed and
 * fits, else null so the caller keeps its old default (the model that ran before a choice existed). `levelOff` is the plain sentence
 * when the household switched this level off: nothing is chosen to run, and the route says so instead of guessing.
 */
export function unnamedJobModel(categoryId: "pictures" | "video", tier: ChoiceTier): { model: string | null; levelOff: string | null } {
  const def = defOf(categoryId);
  const env = liveEnv();
  if (!def || !env) return { model: null, levelOff: null };
  const intended = decide(env, categoryId, tier);
  if (intended.by === "off") return { model: null, levelOff: `${def.label} ${levelName(tier)} is switched off. Switch it on in the AI and models page, or choose another level.` };
  const { model, chosenInstalled } = jobModelFor(def, tier, intended);
  return { model: chosenInstalled && model === intended.model ? model : null, levelOff: null };
}
