// The install plan: the models a first-run wizard installs so this
// computer runs its tier's resident roles, each carrying exactly the
// fields of a pull (`POST /stack/v1/models`), straight from the shipped
// pins. Pure: the route supplies the hardware and the installed set.
import { PROFILE_MODEL_BINDINGS, sizeMachine, type ProfileTier } from "@/profiles";
import { knownAppleChip, type HardwareInfo, type MemorySource } from "@/lib/hardware";
import { splashDraftWanted } from "@/lib/splash";
import { SPLASH_LOCAL_CHAT_MODELS, STACK_SFX_MODELS, STACK_IMAGE_ERNIE_MODELS, STACK_IMAGE_H3_MODELS, STACK_IMAGE_KLEIN3_MODELS, STACK_IMAGE_KLEIN_MODELS, STACK_IMAGE_QWEN_MODELS, STACK_IMAGE_RESTORE_MODELS, STACK_IMAGE_TOOL_MODELS, STACK_IMAGE_ZIMAGE_MODELS, STACK_LIVEPORTRAIT_MODELS, STACK_MODELS, STACK_MUSIC_MODELS, STACK_MUSIC_WHISPER, STACK_MUSIC_MAX_MODELS, STACK_MUSIC_XL_MODELS, STACK_STEMS_MODELS, STACK_VIDEO_LTX25_MAX_MODELS, STACK_VIDEO_LTX25_MODELS, STACK_VIDEO_MASK_MODELS, STACK_VIDEO_MODELS, STACK_TTS_CHATTERBOX_MODEL, STACK_TTS_CHATTERBOX_PARTS, STACK_DEREVERB_MODEL } from "@/lib/modelCatalog";
import { tierDefaultTtsEngine } from "@/speech/ttsEngines";
import { STACK_TTS_MODEL, STACK_TTS_TOKENIZER, STACK_TTS_VOICE, STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_DRAFT, STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_MODEL, VOXCPM2_ENGINE, voxcpm2PackFor } from "@/lib/modelCatalog";
import type { CatalogModelLike } from "@/lib/modelStore";
import type { RoleId } from "@/roles";
import { ROLES, HEAVY_ROLE, PICTURE_READER_ROLE, PRIMARY_ROLE } from "@/roles";
import { IMAGE_FAMILIES, type ImageFamilyId } from "@/images/models";

export interface PlanModel {
  id: string; role: RoleId; repo?: string; url: string; sha256: string; approx_bytes: number; licence: string; revision: string;
  engine?: string; archive?: boolean; hub_file?: string; component?: string; starter: boolean; installed: boolean;
  /** True for a part the recommended setup installs but an admin may remove later (the coding model); absent otherwise. */
  removable?: boolean;
}
export interface InstallPlan {
  level: ProfileTier["level"] | null;
  tier: ProfileTier["id"] | null;
  label: string;
  memory_gb: number;
  memory_source: MemorySource;
  models: PlanModel[];
  total_bytes: number;
  remaining_bytes: number;
  free_disk_bytes: number | null;
  fits_disk: boolean | null;
}

/** Role importance for ordering: chat first, then speech in, speech out,
 * embeddings, the judge, the router, anything else. */
const ROLE_ORDER: RoleId[] = [PRIMARY_ROLE, "stt", "tts", "embed", "judge", "router", HEAVY_ROLE];
/** Roles whose bound model is in the recommended setup but removable afterwards: the coding model (CODE-STACK-01), which only p64 and p128 bind. */
const REMOVABLE_ROLES: RoleId[] = [HEAVY_ROLE, PICTURE_READER_ROLE];
const rank = (role: RoleId): number => { const index = ROLE_ORDER.indexOf(role); return index === -1 ? ROLE_ORDER.length : index; };

const NO_TIER_LABEL = "This computer has less than 16 GB of memory for AI, which is the least the Stack can run chat and voice on.";
const UNKNOWN_LABEL = "The Stack could not read this computer's graphics memory. Say how much you have and the plan will be sized from it.";

function pinFor(role: RoleId, tier: ProfileTier): CatalogModelLike | null {
  const bound = PROFILE_MODEL_BINDINGS[tier.id]?.[role];
  const own = bound ? STACK_MODELS.find((pin) => pin.id === bound) : undefined;
  // Without a binding: the shipped pin for the role, the engine the role
  // runs by default (llama-server for the chat wire), not a component.
  return own ?? STACK_MODELS.find((pin) => pin.role === role && !pin.component && pin.engine !== "mlx-serve" && pin.engine !== "omlx" && (role !== HEAVY_ROLE || pin.id === "qwen3.8-27b-ud-q4-k-m")) ?? null;
}

function view(pin: CatalogModelLike, installed: Set<string>, starter: boolean, removable = false): PlanModel | null {
  const download = pin.download;
  if (!download || !pin.license || !pin.revision) return null;
  return {
    id: pin.id, role: pin.role, ...(pin.repo ? { repo: pin.repo } : {}), url: download.url, sha256: download.sha256, approx_bytes: download.approx_bytes,
    licence: pin.license, revision: pin.revision, ...(pin.engine ? { engine: pin.engine } : {}),
    ...(download.archive ? { archive: true } : {}), ...(download.hub_file ? { hub_file: download.hub_file } : {}), ...(pin.component ? { component: pin.component } : {}),
    starter, installed: installed.has(pin.id), ...(removable ? { removable: true } : {}),
  };
}

/** The pins the video role needs (the weights and the tokenizer), in the shape of a pull, for the video status route: Home installs them when the person turns the Quick video row on. Not in the first-run plan: the row is recommended, not required. */
export function videoInstallModels(installedIds: Iterable<string> = []): PlanModel[] {
  const installed = new Set(installedIds);
  return STACK_VIDEO_MODELS.flatMap((pin) => view(pin, installed, false) ?? []);
}
/** The optional Splash chat models and their required speculative drafts, offered as an admin's choice (no Standard tier binds them) on the machines each one names: the 35B on p64 and p128, Flash Next (the Max chat model) on p128. No tier lists them all. */
export function splashChatInstallModels(installedIds: Iterable<string> = [], tier?: ProfileTier["id"]): PlanModel[] {
  const installed = new Set(installedIds);
  return SPLASH_LOCAL_CHAT_MODELS.filter((entry) => !tier || entry.profiles.includes(tier)).flatMap((entry) => [entry.pin, entry.draftPin].flatMap((pin) => view(pin, installed, false, true) ?? []));
}
/** LTX25-ENGINE-01: the LTX-2.5 pack (one pin: weights, text encoder and VAEs together), in the shape of a pull. */
export function videoLtx25InstallModels(installedIds: Iterable<string> = []): PlanModel[] {
  const installed = new Set(installedIds);
  return STACK_VIDEO_LTX25_MODELS.flatMap((pin) => view(pin, installed, false) ?? []);
}

/** LTX25-MAX-01: the LTX-2.5 Max pack (the bf16 distilled set with its Gemma 4 text encoder), in the shape of a pull. */
export function videoLtx25MaxInstallModels(installedIds: Iterable<string> = []): PlanModel[] {
  const installed = new Set(installedIds);
  return STACK_VIDEO_LTX25_MAX_MODELS.flatMap((pin) => view(pin, installed, false) ?? []);
}

/** The optional SAM 2.1 component's pinned weights, installed separately from the first-run role plan. */
export function videoMaskInstallModels(installedIds: Iterable<string> = []): PlanModel[] {
  const installed = new Set(installedIds);
  return STACK_VIDEO_MASK_MODELS.flatMap((pin) => view(pin, installed, false) ?? []);
}

/** The pins the music role needs (the shared pieces with the 1.7B planning LM, and the 0.6B planning LM), in the shape of a pull, for the music status route: Home installs them when the person turns music on. Not in the first-run plan: the row is optional. */
export function musicInstallModels(installedIds: Iterable<string> = []): PlanModel[] {
  const installed = new Set(installedIds);
  return [...STACK_MUSIC_MODELS, STACK_MUSIC_WHISPER].flatMap((pin) => view(pin, installed, false) ?? []);
}

/** MUSIC-XL-01: the Boost song model's pins (the XL Turbo bf16 weights and its config), in the shape of a pull. */
export function musicXlInstallModels(installedIds: Iterable<string> = []): PlanModel[] {
  const installed = new Set(installedIds);
  return STACK_MUSIC_XL_MODELS.flatMap((pin) => view(pin, installed, false) ?? []);
}

/** MUSIC-MAX-01: the Max song model's pins (XL SFT weights, its config, and the 4B planning model), in the shape of a pull. */
export function musicMaxInstallModels(installedIds: Iterable<string> = []): PlanModel[] {
  const installed = new Set(installedIds);
  return STACK_MUSIC_MAX_MODELS.flatMap((pin) => view(pin, installed, false) ?? []);
}

/** SCORE-STACK-01: Basic Pitch is distributed with its model bundled in the package, so it has no separate model download. */
export function scoreInstallModels(_installedIds: Iterable<string> = []): PlanModel[] { return []; }

export function stemsInstallModels(installedIds: Iterable<string> = []): PlanModel[] {
  const installed = new Set(installedIds);
  return STACK_STEMS_MODELS.flatMap((pin) => view(pin, installed, false) ?? []);
}

/** MP-07: the sound effects model's pins (one folder: the DiT, its config, the T5Gemma text encoder, the licence files), in the shape of a pull. */
export function sfxInstallModels(installedIds: Iterable<string> = []): PlanModel[] {
  const installed = new Set(installedIds);
  return STACK_SFX_MODELS.flatMap((pin) => view(pin, installed, false) ?? []);
}

export function beatsInstallModels(installedIds: Iterable<string> = []): PlanModel[] { return []; }

export function voiceConvertInstallModels(installedIds: Iterable<string> = []): PlanModel[] {
  const installed = new Set(installedIds);
  return STACK_MODELS.filter((pin) => pin.component === "voice-convert").flatMap((pin) => view(pin, installed, false) ?? []);
}

export function recordedSpeechInstallModels(installedIds: Iterable<string> = []): PlanModel[] {
  const installed = new Set(installedIds);
  return STACK_MODELS.filter((pin) => pin.component === "recorded-speech").flatMap((pin) => view(pin, installed, false) ?? []);
}

/** The pins the picture generator needs, in the shape of a pull, for the image status route: Home installs a family when the person turns pictures on (the standard family by default; a higher-detail option is offered on the biggest computers). Klein is in the first-run plan on every tier that has image (AIMODELS-DATA-01); the other families are not. */
export function imageInstallModels(family: ImageFamilyId, installedIds: Iterable<string> = []): PlanModel[] {
  const installed = new Set(installedIds);
  const pins = IMAGE_FAMILIES[family].pins;
  return pins.flatMap((pin) => view(pin, installed, false) ?? []);
}

/** MAKE-CLEARER-2026-11-13: the two picture repair weight files (Best level of Make clearer) in the shape of a pull. Nothing here downloads. */
export function restoreInstallModels(installedIds: Iterable<string> = []): PlanModel[] {
  const installed = new Set(installedIds);
  return STACK_IMAGE_RESTORE_MODELS.flatMap((pin) => view(pin, installed, false) ?? []);
}

/** The six companion animation weights in the shape of a pull. Installation stays an explicit action: nothing here downloads. */
export function talkingPicturesInstallModels(installedIds: Iterable<string> = []): PlanModel[] {
  const installed = new Set(installedIds);
  return STACK_LIVEPORTRAIT_MODELS.flatMap((pin) => view(pin, installed, false) ?? []);
}

/** The pins a tier's first-run plan installs, in plan order, the starter chat first: the one list both the install plan and the disk plan read. */
export function plannedPinsFor(tier: ProfileTier, target: { platform: string; arch: string } = { platform: "darwin", arch: "arm64" }): Array<{ pin: CatalogModelLike; starter: boolean; removable?: boolean }> {
  const projectors = new Set(STACK_MODELS.flatMap((pin) => pin.imageInput ? [pin.imageInput.projector] : []));
  // Resident roles, plus embeddings where the tier loads them on demand:
  // search and memory need the model on disk either way. Coding is on
  // demand but has its own bound model, so the recommended setup brings
  // it (removable). A role that shares another's model (router, an
  // unbound judge) adds nothing.
  const roles = [...new Set<RoleId>([...tier.resident, ...tier.onDemand.filter((role) => role === "embed" || (role === HEAVY_ROLE && PROFILE_MODEL_BINDINGS[tier.id]?.coding) || role === PICTURE_READER_ROLE)])]
    .filter((role) => !(ROLES[role] as { sharesModelWith?: RoleId }).sharesModelWith || PROFILE_MODEL_BINDINGS[tier.id]?.[role])
    .sort((a, b) => rank(a) - rank(b));
  const planned: Array<{ pin: CatalogModelLike; starter: boolean; removable?: boolean }> = [];
  const add = (pin: CatalogModelLike | null, starter = false, removable = false) => { if (pin && !planned.some((entry) => entry.pin.id === pin.id)) planned.push({ pin, starter, ...(removable ? { removable: true } : {}) }); };
  for (const role of roles) {
    const pin = pinFor(role, tier);
    if (!pin) continue;
    if (role === PRIMARY_ROLE) {
      // The tier's chat model is the starter: no smaller chat model ships ahead of it.
      add(pin, true);
    } else add(pin, false, REMOVABLE_ROLES.includes(role));
    // A model's companions install and remove with it (the coding model's Splash draft, CODE-STACK-01 S5a), where the engine that reads them can run.
    if (role === HEAVY_ROLE) for (const id of pin.companions ?? []) { const part = STACK_MODELS.find((candidate) => candidate.id === id); if (part && splashDraftWanted(target, tier.id, knownAppleChip())) add(part, false, true); }
    // A bound model that reads pictures brings its projector (VISION-03a).
    const projector = pin.imageInput ? STACK_MODELS.find((candidate) => candidate.id === pin.imageInput!.projector) : undefined;
    for (const part of STACK_MODELS.filter((candidate) => candidate.role === role && candidate.component && (candidate.engine === pin.engine || (role === "stt" && (pin.companions ?? []).includes(candidate.id))) && !projectors.has(candidate.id) && (role !== HEAVY_ROLE || (pin.companions ?? []).includes(candidate.id)))) add(part);
    add(projector ?? null);
    // oMLX's MLX build of the model is not in the first-run plan: llama-server
    // is the default on every tier (ENGINE-MLX-02), and the 19 GB MLX weights
    // are fetched only when the admin chooses oMLX (an optional disk-plan row,
    // or the engine setting set to `omlx`).
    // The tier's expressive voice rides beside the standard speech model, which stays as
    // the fallback (VOICE-STUDIO-01): only where the tier runs it by default.
    if (role === "tts" && tierDefaultTtsEngine(tier.id) === "chatterbox-turbo") { add(STACK_TTS_CHATTERBOX_MODEL); for (const part of STACK_TTS_CHATTERBOX_PARTS) add(part); add(STACK_DEREVERB_MODEL); }
  }
  // The image tools (remove background, erase, upscale; about 390 MB, one worker that loads on demand) are small enough for every tier
  // that has a plan; the governor decides at the first edit whether memory allows it (IMAGETOOLS-01).
  for (const pin of STACK_IMAGE_TOOL_MODELS.filter((candidate) => candidate.component !== "tool-look")) add(pin);
  // The everyday picture model (FLUX.2 Klein) is a required disk-plan row on every tier that has
  // image (AIMODELS-DATA-01), so the first run installs it: the one generator that is in the plan.
  if (!tier.notAvailable.includes("image")) for (const pin of STACK_IMAGE_KLEIN_MODELS) add(pin);
  return tier.id === LINEUP_TIER ? lineupPlan(planned) : planned;
}

/** The 128 GB recommended preset is the owner's lineup (2026-11-27). Chat is Qwen3.6 35B A3B (Huihui) with its draft, the voice is
 * VoxCPM2, pictures are FLUX 3 Image Klein. Qwen3 8B, Pocket TTS, Chatterbox Turbo (and its parts and de-reverb) and FLUX.2 Klein 4B
 * are LEFT OUT of the preset only: they stay in the catalog, Custom still lists them, nothing installed is removed, and an admin can
 * now remove them because they are no longer part of the plan. */
const LINEUP_TIER = "p128";
const LINEUP_LEFT_OUT = new Set<string>(["qwen3-8b-instruct-q4-k-m", ...[STACK_TTS_CHATTERBOX_MODEL, ...STACK_TTS_CHATTERBOX_PARTS, STACK_DEREVERB_MODEL, STACK_TTS_MODEL, STACK_TTS_TOKENIZER, STACK_TTS_VOICE, ...STACK_IMAGE_KLEIN_MODELS].map((pin) => pin.id)]);
function lineupPlan(planned: Array<{ pin: CatalogModelLike; starter: boolean; removable?: boolean }>): Array<{ pin: CatalogModelLike; starter: boolean; removable?: boolean }> {
  const kept = planned.filter((entry) => !LINEUP_LEFT_OUT.has(entry.pin.id));
  const have = new Set(kept.map((entry) => entry.pin.id));
  const added: Array<{ pin: CatalogModelLike; starter: boolean; removable?: boolean }> = [
    { pin: STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_MODEL, starter: true },
    { pin: STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_DRAFT, starter: false },
    ...voxcpm2PackFor(VOXCPM2_ENGINE).map((pin) => ({ pin, starter: false })),
    ...STACK_IMAGE_KLEIN3_MODELS.map((pin) => ({ pin, starter: false })),
  ].filter((entry) => !have.has(entry.pin.id));
  return [...added.filter((entry) => entry.starter), ...kept.map((entry) => ({ ...entry, starter: false })), ...added.filter((entry) => !entry.starter)];
}

export function buildInstallPlan(hw: HardwareInfo, options: { vramOverrideGb?: number | null; installedIds?: Iterable<string> } = {}): InstallPlan {
  const { tier, memoryGb, source } = sizeMachine(hw, options.vramOverrideGb);
  const free = hw.freeDiskBytes ?? null;
  const base = { memory_gb: memoryGb, memory_source: source, free_disk_bytes: free };
  if (!tier) return { level: null, tier: null, label: source === "unknown" ? UNKNOWN_LABEL : NO_TIER_LABEL, ...base, models: [], total_bytes: 0, remaining_bytes: 0, fits_disk: null };
  const installed = new Set(options.installedIds ?? []);
  const planned = plannedPinsFor(tier, hw);
  const models = planned.flatMap(({ pin, starter, removable }) => view(pin, installed, starter, removable) ?? []);
  const total = models.reduce((sum, model) => sum + model.approx_bytes, 0);
  const remaining = models.filter((model) => !model.installed).reduce((sum, model) => sum + model.approx_bytes, 0);
  return { level: tier.level, tier: tier.id, label: tier.label, ...base, models, total_bytes: total, remaining_bytes: remaining, fits_disk: free === null ? null : free >= remaining };
}
