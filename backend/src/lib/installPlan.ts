// The install plan: the models a first-run wizard installs so this
// computer runs its tier's resident roles, each carrying exactly the
// fields of a pull (`POST /stack/v1/models`), straight from the shipped
// pins. Pure: the route supplies the hardware and the installed set.
import { PROFILE_MODEL_BINDINGS, sizeMachine, type ProfileTier } from "@/profiles";
import { knownAppleChip, type HardwareInfo, type MemorySource } from "@/lib/hardware";
import { splashDraftWanted } from "@/lib/splash";
import { STACK_CHAT_MODEL, STACK_STT_MODEL, STACK_STT_PARAKEET_V2_MODEL, STACK_IMAGE_ERNIE_MODELS, STACK_IMAGE_KLEIN_MODELS, STACK_IMAGE_TOOL_MODELS, STACK_IMAGE_ZIMAGE_MODELS, STACK_MODELS, STACK_MUSIC_MODELS, STACK_VIDEO_MODELS, STACK_VIDEO_DETAILED_MODELS, STACK_TTS_CHATTERBOX_MODEL, STACK_TTS_CHATTERBOX_PARTS } from "@/lib/modelCatalog";
import { tierDefaultTtsEngine } from "@/speech/ttsEngines";
import type { CatalogModelLike } from "@/lib/modelStore";
import type { RoleId } from "@/roles";
import { ROLES } from "@/roles";
import type { ImageFamilyId } from "@/images/models";

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
const ROLE_ORDER: RoleId[] = ["chat", "stt", "tts", "embed", "judge", "router", "coding"];
/** Roles whose bound model is in the recommended setup but removable afterwards: the coding model (CODE-STACK-01), which only p64 and p128 bind. */
const REMOVABLE_ROLES: RoleId[] = ["coding"];
const rank = (role: RoleId): number => { const index = ROLE_ORDER.indexOf(role); return index === -1 ? ROLE_ORDER.length : index; };

const NO_TIER_LABEL = "This computer has less than 16 GB of memory for AI, which is the least the Stack can run chat and voice on.";
const UNKNOWN_LABEL = "The Stack could not read this computer's graphics memory. Say how much you have and the plan will be sized from it.";

function pinFor(role: RoleId, tier: ProfileTier): CatalogModelLike | null {
  const bound = PROFILE_MODEL_BINDINGS[tier.id]?.[role];
  const own = bound ? STACK_MODELS.find((pin) => pin.id === bound) : undefined;
  // Without a binding: the shipped pin for the role, the engine the role
  // runs by default (llama-server for the chat wire), not a component.
  return own ?? STACK_MODELS.find((pin) => pin.role === role && !pin.component && pin.engine !== "mlx-serve" && pin.engine !== "omlx" && (role !== "coding" || pin.id === "qwen3.8-27b-ud-q4-k-m")) ?? null;
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

/** The pins the video role needs (the weights and the tokenizer), in the shape of a pull, for the video status route: Home installs them when the person turns video on. They are not in the first-run plan, the way no generator is. */
export function videoInstallModels(installedIds: Iterable<string> = []): PlanModel[] {
  const installed = new Set(installedIds);
  return STACK_VIDEO_MODELS.flatMap((pin) => view(pin, installed, false) ?? []);
}
/** VIDEO-LTX-01: the Detailed model's pins (the LTX weights and the Gemma text encoder), in the shape of a pull. */
export function videoDetailedInstallModels(installedIds: Iterable<string> = []): PlanModel[] {
  const installed = new Set(installedIds);
  return STACK_VIDEO_DETAILED_MODELS.flatMap((pin) => view(pin, installed, false) ?? []);
}

/** The pins the music role needs (the shared pieces with the 1.7B planning LM, and the 0.6B planning LM), in the shape of a pull, for the music status route: Home installs them when the person turns music on. They are not in the first-run plan, the way no generator is. */
export function musicInstallModels(installedIds: Iterable<string> = []): PlanModel[] {
  const installed = new Set(installedIds);
  return STACK_MUSIC_MODELS.flatMap((pin) => view(pin, installed, false) ?? []);
}

/** The pins the picture generator needs, in the shape of a pull, for the image status route: Home installs a family when the person turns pictures on (FLUX.2 Klein 4B by default; Z-Image-Turbo is offered on the biggest computers). Not in the first-run plan, the way no generator is. */
export function imageInstallModels(family: ImageFamilyId, installedIds: Iterable<string> = []): PlanModel[] {
  const installed = new Set(installedIds);
  const pins = family === "flux2-klein-4b" ? STACK_IMAGE_KLEIN_MODELS : family === "z-image-turbo" ? STACK_IMAGE_ZIMAGE_MODELS : STACK_IMAGE_ERNIE_MODELS;
  return pins.flatMap((pin) => view(pin, installed, false) ?? []);
}

/** The pins a tier's first-run plan installs, in plan order, the starter chat first: the one list both the install plan and the disk plan read. */
export function plannedPinsFor(tier: ProfileTier, target: { platform: string; arch: string } = { platform: "darwin", arch: "arm64" }): Array<{ pin: CatalogModelLike; starter: boolean; removable?: boolean }> {
  const projectors = new Set(STACK_MODELS.flatMap((pin) => pin.imageInput ? [pin.imageInput.projector] : []));
  // Resident roles, plus embeddings where the tier loads them on demand:
  // search and memory need the model on disk either way. Coding is on
  // demand but has its own bound model, so the recommended setup brings
  // it (removable). A role that shares another's model (router, an
  // unbound judge) adds nothing.
  const roles = [...new Set<RoleId>([...tier.resident, ...tier.onDemand.filter((role) => role === "embed" || (role === "coding" && PROFILE_MODEL_BINDINGS[tier.id]?.coding))])]
    .filter((role) => !(ROLES[role] as { sharesModelWith?: RoleId }).sharesModelWith || PROFILE_MODEL_BINDINGS[tier.id]?.[role])
    .sort((a, b) => rank(a) - rank(b));
  const planned: Array<{ pin: CatalogModelLike; starter: boolean; removable?: boolean }> = [];
  const add = (pin: CatalogModelLike | null, starter = false, removable = false) => { if (pin && !planned.some((entry) => entry.pin.id === pin.id)) planned.push({ pin, starter, ...(removable ? { removable: true } : {}) }); };
  for (const role of roles) {
    const pin = pinFor(role, tier);
    if (!pin) continue;
    if (role === "chat") {
      // A small chat model first so a conversation can start while the
      // tier's larger one downloads; when chat is already small it is the starter.
      const smaller = (pin.download?.approx_bytes ?? 0) > (STACK_CHAT_MODEL.download?.approx_bytes ?? 0);
      if (smaller) { add(STACK_CHAT_MODEL, true); add(pin); } else add(pin, true);
    } else add(pin, false, REMOVABLE_ROLES.includes(role));
    // A model's companions install and remove with it (the coding model's Splash draft, CODE-STACK-01 S5a), where the engine that reads them can run.
    if (role === "coding") for (const id of pin.companions ?? []) { const part = STACK_MODELS.find((candidate) => candidate.id === id); if (part && splashDraftWanted(target, tier.id, knownAppleChip())) add(part, false, true); }
    // A bound model that reads pictures brings its projector (VISION-03a).
    const projector = pin.imageInput ? STACK_MODELS.find((candidate) => candidate.id === pin.imageInput!.projector) : undefined;
    for (const part of STACK_MODELS.filter((candidate) => candidate.role === role && candidate.component && candidate.engine === pin.engine && !projectors.has(candidate.id) && (role !== "coding" || (pin.companions ?? []).includes(candidate.id)))) add(part);
    add(projector ?? null);
    // The larger tiers' listening model is Parakeet (STT-PARAKEET-03); Moonshine tiny installs beside it as the
    // fallback the Stack restarts the role on when Parakeet is missing or fails its probe.
    if (role === "stt" && pin.id === STACK_STT_PARAKEET_V2_MODEL.id) add(STACK_STT_MODEL);
    // oMLX's MLX build of the model is not in the first-run plan: llama-server
    // is the default on every tier (ENGINE-MLX-02), and the 19 GB MLX weights
    // are fetched only when the admin chooses oMLX (an optional disk-plan row,
    // or the engine setting set to `omlx`).
    // The tier's expressive voice rides beside Pocket TTS, which stays as
    // the fallback (VOICE-STUDIO-01): only where the tier runs it by default.
    if (role === "tts" && tierDefaultTtsEngine(tier.id) === "chatterbox-turbo") { add(STACK_TTS_CHATTERBOX_MODEL); for (const part of STACK_TTS_CHATTERBOX_PARTS) add(part); }
  }
  // The image tools (remove background, erase, upscale; about 390 MB, one worker that loads on demand) are small enough for every tier
  // that has a plan; the governor decides at the first edit whether memory allows it (IMAGETOOLS-01).
  for (const pin of STACK_IMAGE_TOOL_MODELS.filter((candidate) => candidate.component !== "tool-look")) add(pin);
  return planned;
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
