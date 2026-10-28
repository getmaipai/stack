// COMPONENTS-01: every installable part of the Stack as one list a person
// can read, with an install and an uninstall that go through the parts' own
// mechanisms (the model store, the picture, video and voice environments,
// the LoRA libraries). A component is what a household member would name
// ("Z-Image-Turbo", "Wake word", "Chat model: Muse Glimmer 30B"), not a
// file: it groups the pinned model records that install together with the
// managed environment they run in. Nothing here is stored except when a
// component was last used (`meta`); state is derived from the disk, the
// model records and the job list, so it cannot drift.
import { existsSync, lstatSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { lastUsedOf } from "@/lib/componentUse";
import { detectHardware, knownAppleChip, type HardwareInfo } from "@/lib/hardware";
import { createJob, finishJob, getJob, jobSignal, listJobs, updateJob } from "@/lib/jobs";
import { emit } from "@/lib/events";
import { raise, resolve as resolveHealth } from "@/lib/health";
import { getModel, installCatalogModel, removeModel, type CatalogModelLike, type DownloadModelOptions } from "@/lib/modelStore";
import { STACK_IMAGE_KLEIN_MODELS, STACK_IMAGE_TOOL_MODELS, STACK_IMAGE_ZIMAGE_MODELS, LTX_LICENCE_NOTICE, STACK_MODELS, STACK_MUSIC_MODELS, STACK_VIDEO_DETAILED_MODELS, STACK_VIDEO_DETAILED_MODEL_ID, STACK_VIDEO_MODELS } from "@/lib/modelCatalog";
import { licenceAcceptance, recordLicenceAcceptance, type LicenceNotice } from "@/lib/licenceAcceptance";
import { buildInstallPlan } from "@/lib/installPlan";
import { diskPlanForTier, diskTotalsFor, engineDownloadBytes, type DiskPlan } from "@/lib/diskPlan";
import { modelsDir } from "@/lib/paths";
import { bumpStackGeneration } from "@/lib/stackGeneration";
import { releaseHfFile } from "@/lib/store/hfCache";
import { engineCurrentPath } from "@/lib/store/layout";
import { selectEngineBinary } from "@/lib/engineCatalog";
import { splashDraftPossible } from "@/lib/splash";
import { ensureEngine } from "@/lib/engineInstall";
import { uvEnvironmentReady } from "@/lib/uvEnvironment";
import { loadedRoleForModel, selectedModel } from "@/lib/supervisor";
import { ensureImageGenEnvironment, imageGen, imageGenEnvironmentReady, imageGenRoot } from "@/images/imageEngine";
import { imageLoras } from "@/images/loras";
import { ensureVideoGenEnvironment, tierAvailability as videoAvailability, videoGen, videoGenEnvironmentReady, videoGenRoot, VIDEO_GEN_NAME } from "@/video/videoGen";
import { ensureMusicGenEnvironment, tierAvailability as musicAvailability, musicGen, musicGenEnvironmentReady, musicGenRoot, MUSIC_GEN_NAME } from "@/music/musicGen";
import { listLoras as listVideoLoras, removeLora as removeVideoLora } from "@/video/loras";
import { imageTools, imageToolsProof, imageToolsRoot } from "@/imagetools/imageTools";
import { ensurePocketTtsEnvironment, pocketTtsInstalled, pocketTtsRoot } from "@/speech/pocketTts";
import { ensureMlxAudioEnvironment, mlxAudioInstalled, mlxAudioRoot } from "@/speech/mlxAudio";

export const COMPONENT_JOB_KIND = "component.install";
export const COMPONENT_FAILED_CODE = (id: string): string => `component-install-failed.${id}`;
export const COMPONENT_FAILED_PREFIX = "component-install-failed.";
/** Room kept free on the data volume beyond a download, so a fit never leaves the computer full. */
export const DISK_MARGIN_BYTES = 5_000_000_000;

export type ComponentGroup = "chat" | "voice" | "pictures" | "video" | "music" | "tools" | "loras";
export type ComponentState = "installed" | "installing" | "notInstalled" | "failed";
export type ComponentRequirement = "required" | "optional" | "unsupported";
type Tier = "p16" | "p32" | "p64" | "p128";
const TIER_RANK: Record<Tier, number> = { p16: 0, p32: 1, p64: 2, p128: 3 };

export class ComponentError extends Error {
  constructor(readonly code: "unknown_component" | "not_available" | "not_enough_space" | "in_use" | "required" | "only_chat_model" | "chat_model_in_use" | "shared_by_others" | "licence_required", message: string, readonly status: 404 | 409) { super(message); }
}

export interface EnvDef {
  name: string;
  /** Roughly what building it downloads, for the estimate before it exists (measured on the Studio 2026-10-17). */
  approxBytes: number;
  root: () => string;
  ready: () => boolean;
  /** Built on the first use rather than at install (the picture tools' environment). */
  lazy?: boolean;
  build: (onPhase: (phase: string) => void, signal?: AbortSignal) => Promise<void>;
  /** Also removed with the environment: the engine's `current` link. */
  link?: string;
  stop?: () => void;
}

export interface UnitDef {
  id: string;
  label: string;
  summary: string;
  group: ComponentGroup;
  role: string;
  pins: CatalogModelLike[];
  envs: EnvDef[];
  /** Tiers that run it; absent means any tier its model profile fits. */
  tiers?: Tier[];
  /** Why this computer cannot run it at all (the platform), or null. */
  platformBlock?: () => string | null;
  /** The role this unit's primary model can serve, when it is a selectable model. */
  serves?: string;
  usedBy: () => string[];
  busy: () => string | null;
  /** A licence with terms beyond the open ones: the install waits for an admin to accept it once (Home sends the notice id). */
  licenceNotice?: LicenceNotice;
}

const GB = 1_000_000_000;
/** Environment downloads come from the disk plan's measured table (one definition with the wizard); the figures are a fallback only. */
const ENV_BYTES = { image: engineDownloadBytes("image-gen") ?? 1.1 * GB, video: engineDownloadBytes("video-gen") ?? 1.0 * GB, music: engineDownloadBytes("music-gen") ?? 0.8 * GB, tools: engineDownloadBytes("image-tools") ?? 0.4 * GB, pocket: engineDownloadBytes("pocket-tts") ?? 0.72 * GB, mlxAudio: engineDownloadBytes("mlx-audio") ?? 0.47 * GB };
/** The disk plan's row for a component, where the plan has one (its optional rows are the wizard's unchecked extras). */
const DISK_ROW: Record<string, string> = { "qwen3.8-27b-ud-q4-k-m": "coding", "flux2-klein-4b": "pictures", "z-image-turbo": "pictures-zimage", "image-tools": "image-tools", "pocket-tts-english": "voice", "chatterbox-turbo-fp16": "voice-better", "fastwan2-2-ti2v-5b-mlx-bf16": "video", "ace-step-1-5-turbo": "music", "ltx-2-3-distilled-mlx": "video-detailed" };

const envImage: EnvDef = { name: "image-gen", approxBytes: ENV_BYTES.image, root: imageGenRoot, ready: imageGenEnvironmentReady, build: (onPhase, signal) => ensureImageGenEnvironment(onPhase, { signal }), stop: () => imageGen.stop() };
const envVideo: EnvDef = {
  name: VIDEO_GEN_NAME, approxBytes: ENV_BYTES.video, root: videoGenRoot, ready: videoGenEnvironmentReady, link: engineCurrentPath(VIDEO_GEN_NAME), stop: () => videoGen.stop(),
  build: async (onPhase, signal) => {
    const pin = selectEngineBinary(await detectHardware(), VIDEO_GEN_NAME);
    if (!pin) throw new Error("No pinned video engine build exists for this computer.");
    onPhase("the video engine");
    await ensureEngine(pin, () => {}, { signal });
    await ensureVideoGenEnvironment(onPhase, { signal });
  },
};
const envMusic: EnvDef = {
  name: MUSIC_GEN_NAME, approxBytes: ENV_BYTES.music, root: musicGenRoot, ready: musicGenEnvironmentReady, link: engineCurrentPath(MUSIC_GEN_NAME), stop: () => musicGen.stop(),
  build: async (onPhase, signal) => {
    const pin = selectEngineBinary(await detectHardware(), MUSIC_GEN_NAME);
    if (!pin) throw new Error("No pinned music engine build exists for this computer.");
    onPhase("the music engine");
    await ensureEngine(pin, () => {}, { signal });
    await ensureMusicGenEnvironment(onPhase, { signal });
  },
};
const envTools: EnvDef = { name: "image-tools", approxBytes: ENV_BYTES.tools, root: imageToolsRoot, ready: () => uvEnvironmentReady({ root: imageToolsRoot(), proof: imageToolsProof() }), lazy: true, build: async () => {}, stop: () => imageTools.stop() };
const envPocket: EnvDef = { name: "pocket-tts", approxBytes: ENV_BYTES.pocket, root: pocketTtsRoot, ready: pocketTtsInstalled, build: (onPhase, signal) => ensurePocketTtsEnvironment(onPhase, { signal }) };
const envMlxAudio: EnvDef = { name: "mlx-audio", approxBytes: ENV_BYTES.mlxAudio, root: mlxAudioRoot, ready: mlxAudioInstalled, build: (onPhase, signal) => ensureMlxAudioEnvironment(onPhase, { signal }) };

const LABELS: Record<string, { label: string; summary: string }> = {
  "qwen3-1.7b-q8-0": { label: "Chat model: Qwen3 1.7B", summary: "A small, quick chat model. Home starts with it so you can talk while a bigger one downloads." },
  "qwen3-8b-instruct-q4-k-m": { label: "Chat model: Qwen3 8B", summary: "A mid-size chat model for computers with less memory." },
  "muse-glimmer-30b-q4-k-xl": { label: "Chat model: Muse Glimmer 30B (best quality)", summary: "The household chat model on larger computers. It reads pictures too." },
  "muse-glimmer-30b-q4-k-m": { label: "Chat model: Muse Glimmer 30B (compact)", summary: "The same chat model in a smaller file for computers with 32 GB of memory." },
  "qwen3-1.7b-mlx-4bit": { label: "Chat model: Qwen3 1.7B (Apple format)", summary: "A small chat model in the format the second chat engine runs." },
  "qwen3-vl-8b-instruct-q4-k-m": { label: "Chat model: Qwen3-VL 8B (reads pictures)", summary: "A chat model that can look at pictures you share." },
  "qwen3-vl-4b-instruct-q4-k-m": { label: "Picture reader: Qwen3-VL 4B", summary: "Describes pictures for the parts of Home that need to look at one." },
  "qwen3.8-27b-ud-q4-k-m": { label: "Coding model: Qwen3.8 27B", summary: "The model that writes code for the coding tools you connect. It loads only while someone is coding. Remove it if your household does not want coding." },
  "qwen3-4b-q4-k-m": { label: "Quick checks: Qwen3 4B", summary: "A small model for fast side tasks like titles and safety checks." },
  "nomic-embed-text-v1-5-q4-k-m": { label: "Memory and search model", summary: "Lets Home find the right memory or page by meaning." },
  "moonshine-tiny-en-int8": { label: "Listening: speech to text", summary: "Turns what you say into text. Runs on this computer." },
  "parakeet-tdt-0.6b-v2-int8": { label: "Listening: speech to text, more accurate", summary: "A larger listening model that makes about three times fewer mistakes with names and background noise. Runs on this computer." },
  "pocket-tts-english": { label: "Voice: Pocket TTS", summary: "The standard speaking voice." },
  "chatterbox-turbo-fp16": { label: "Voice: Chatterbox Turbo", summary: "A more expressive speaking voice for larger computers." },
  wakeword: { label: "Wake word (Hey MaiPai)", summary: "Lets a speaker or robot wake up when someone says the wake word." },
  "image-tools": { label: "Picture tools", summary: "Remove a background, erase an object, upscale or resize a picture." },
  "tool-look": { label: "Look", summary: "Names household objects, wall colour and light in a picture." },
  "flux2-klein-4b": { label: "Pictures: FLUX.2 Klein 4B", summary: "The everyday picture model. Makes and edits pictures in a few seconds." },
  "z-image-turbo": { label: "Pictures: Z-Image-Turbo", summary: "A higher-detail picture model for the largest computers. A big download." },
  "ace-step-1-5-turbo": { label: "Music: ACE-Step 1.5", summary: "Makes and changes songs in chat" },
  "fastwan2-2-ti2v-5b-mlx-bf16": { label: "Video: Quick (Wan 2.2 FastWan 5B)", summary: "Makes short silent video clips from words or a picture." },
  "ltx-2-3-distilled-mlx": { label: "Video: Detailed (LTX-2.3)", summary: "Makes longer clips with sound and spoken words. A very large download, and the maker's licence applies." },
};

function dedupe<T>(items: T[], key: (item: T) => string): T[] { const seen = new Set<string>(); return items.filter((item) => { const k = key(item); if (seen.has(k)) return false; seen.add(k); return true; }); }

const activeJobFor = (matches: (kind: string, input: Record<string, unknown> | null) => boolean): boolean =>
  listJobs().some((job) => (job.state === "queued" || job.state === "running" || job.state === "stalled") && matches(job.kind, job.input ?? null));

function modelBusy(id: string): string | null { return loadedRoleForModel(id) ? "It is loaded in memory for a request right now." : null; }

let unitsOverride: UnitDef[] | null = null;
/** The suite swaps in small units with pins whose bytes it can make; null puts the real list back. */
export function __setComponentUnitsForTests(units: UnitDef[] | null): void { unitsOverride = units; }

/** Every component, built from the pins on each call (cheap: no disk reads). */
export function componentDefs(): UnitDef[] {
  if (unitsOverride) return unitsOverride;
  const projectorIds = new Set(STACK_MODELS.flatMap((pin) => pin.imageInput ? [pin.imageInput.projector] : []));
  const units: UnitDef[] = [];
  const generic = (primary: CatalogModelLike, group: ComponentGroup, serves: string, usedBy: string[], env?: EnvDef): UnitDef => {
    const projector = primary.imageInput ? STACK_MODELS.find((pin) => pin.id === primary.imageInput!.projector) : undefined;
    // Parts of the same engine, and the companions the model names (the coding model's Splash draft, CODE-STACK-01 S5a; the speech model's end-of-turn model, DUPLEX-02), install and remove together.
    const parts = STACK_MODELS.filter((pin) => pin.component && pin.role === primary.role && (pin.engine === primary.engine || ((primary.companions ?? []).includes(pin.id) && (primary.role !== "coding" || splashDraftPossible({ platform: process.platform, arch: process.arch }, knownAppleChip())))) && !projectorIds.has(pin.id));
    const text = LABELS[primary.id] ?? { label: primary.id, summary: "" };
    return {
      id: primary.id, label: text.label, summary: text.summary, group, role: primary.role, pins: dedupe([primary, ...(projector ? [projector] : []), ...(primary.role === "chat" || primary.role === "judge" || primary.role === "vision" || primary.role === "embed" ? [] : parts)], (pin) => pin.id),
      envs: env ? [env] : [], serves, usedBy: () => (selectedModel(serves as never)?.id === primary.id ? usedBy : []), busy: () => modelBusy(primary.id),
    };
  };
  for (const pin of STACK_MODELS) {
    if (pin.component || projectorIds.has(pin.id)) continue;
    if (pin.role === "chat") units.push(generic(pin, "chat", "chat", ["Chat"]));
    else if (pin.role === "judge") units.push(generic(pin, "chat", "judge", ["Quick checks"]));
    else if (pin.role === "coding") units.push(generic(pin, "chat", "coding", ["Coding"]));
    else if (pin.role === "vision") units.push(generic(pin, "chat", "vision", ["Describing pictures"]));
    else if (pin.role === "embed") units.push(generic(pin, "chat", "embed", ["Memory and search"]));
    else if (pin.role === "stt") units.push(generic(pin, "voice", "stt", ["Listening"]));
    else if (pin.role === "tts") units.push(generic(pin, "voice", "tts", ["Speaking"], pin.engine === "pocket-tts" ? envPocket : pin.engine === "chatterbox-turbo" ? envMlxAudio : undefined));
  }
  // The wake word is three small assets that only work together.
  const wake = STACK_MODELS.filter((pin) => pin.role === "wakeword");
  if (wake.length) units.push({ id: "wakeword", ...LABELS.wakeword!, group: "voice", role: "wakeword", pins: wake, envs: [], usedBy: () => ["Wake word on speakers and robots"], busy: () => null });
  const pictureBusy = (): string | null => {
    const state = imageGen.status().state;
    if (state === "running" || state === "building") return "A picture is being made right now.";
    return activeJobFor((kind) => kind === "image_generation" || kind === "image" || kind.startsWith("image")) ? "A picture is waiting or being made right now." : null;
  };
  const familyUnit = (id: "flux2-klein-4b" | "z-image-turbo", pins: CatalogModelLike[], tiers: Tier[], usedBy: string): UnitDef => ({
    id, ...LABELS[id]!, group: "pictures", role: "image", pins, envs: [envImage], tiers,
    platformBlock: () => imageGen.supported() ? null : "Pictures are not available on this kind of computer yet.",
    usedBy: () => { const count = imageLoras.list().filter((lora) => lora.base_model === id).length; return [usedBy, ...(count ? [`${count} picture style${count === 1 ? "" : "s"} (LoRAs)`] : [])]; },
    busy: pictureBusy,
  });
  units.push(familyUnit("flux2-klein-4b", STACK_IMAGE_KLEIN_MODELS, ["p32", "p64", "p128"], "Pictures in chat and the Pictures app"));
  units.push(familyUnit("z-image-turbo", STACK_IMAGE_ZIMAGE_MODELS, ["p128"], "Pictures, when chosen as the model"));
  units.push({
    id: "image-tools", ...LABELS["image-tools"]!, group: "tools", role: "image", pins: STACK_IMAGE_TOOL_MODELS, envs: [envTools],
    platformBlock: () => { const status = imageTools.status(); return status.state === "unsupported" ? status.reason ?? "Picture tools are not available on this computer yet." : null; },
    usedBy: () => ["The picture editor"],
    busy: () => { const state = imageTools.status().state; return state === "running" || state === "building" ? "A picture edit is running right now." : null; },
  });
  const lookPin = STACK_IMAGE_TOOL_MODELS.find((pin) => pin.component === "tool-look");
  if (lookPin) units.push({ id: "tool-look", ...LABELS["tool-look"]!, group: "tools", role: "image", pins: [lookPin], envs: [envTools], usedBy: () => ["Look at a picture"], busy: () => null });
  units.push({
    id: STACK_VIDEO_MODELS[0]!.id, ...LABELS[STACK_VIDEO_MODELS[0]!.id]!, group: "video", role: "video", pins: STACK_VIDEO_MODELS, envs: [envVideo], tiers: ["p128"],
    platformBlock: () => videoAvailability().code === "unsupported" ? videoAvailability().reason : null,
    usedBy: () => { const count = listVideoLoras().filter((lora) => lora.base_model !== "ltx-2.3").length; return ["The Video app", ...(count ? [`${count} video style${count === 1 ? "" : "s"} (LoRAs)`] : [])]; },
    busy: () => {
      const state = videoGen.status().state;
      if (state === "running" || state === "building") return "A video clip is being made right now.";
      return activeJobFor((kind) => kind.startsWith("video")) ? "A video clip is waiting or being made right now." : null;
    },
  });
  units.push({
    id: STACK_VIDEO_DETAILED_MODEL_ID, ...LABELS[STACK_VIDEO_DETAILED_MODEL_ID]!, group: "video", role: "video", pins: STACK_VIDEO_DETAILED_MODELS, envs: [envVideo], tiers: ["p128"], licenceNotice: LTX_LICENCE_NOTICE,
    platformBlock: () => videoAvailability().code === "unsupported" ? videoAvailability().reason : null,
    usedBy: () => { const count = listVideoLoras().filter((lora) => lora.base_model === "ltx-2.3").length; return ["Detailed videos in chat and the Video app", ...(count ? [`${count} Detailed video style${count === 1 ? "" : "s"} (LoRAs)`] : [])]; },
    busy: () => {
      const state = videoGen.status().state;
      if (state === "running" || state === "building") return "A video clip is being made right now.";
      return activeJobFor((kind) => kind.startsWith("video")) ? "A video clip is waiting or being made right now." : null;
    },
  });
  units.push({
    id: STACK_MUSIC_MODELS[0]!.id, ...LABELS[STACK_MUSIC_MODELS[0]!.id]!, group: "music", role: "music", pins: STACK_MUSIC_MODELS, envs: [envMusic], tiers: ["p64", "p128"],
    platformBlock: () => musicAvailability().code === "unsupported" ? musicAvailability().reason : null,
    usedBy: () => ["Songs in chat"],
    busy: () => {
      const state = musicGen.status().state;
      if (state === "running" || state === "building") return "A song is being made right now.";
      return activeJobFor((kind) => kind.startsWith("music")) ? "A song is waiting or being made right now." : null;
    },
  });
  return units;
}

// ---- disk -----------------------------------------------------------------

const sizeCache = new Map<string, { at: number; bytes: number }>();
function treeBytes(path: string): number {
  let info;
  try { info = lstatSync(path); } catch { return 0; }
  if (info.isSymbolicLink()) { try { return statSync(path).size; } catch { return 0; } }
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of readdirSync(path)) total += treeBytes(join(path, entry));
  return total;
}
function cachedBytes(path: string): number {
  const hit = sizeCache.get(path);
  if (hit && Date.now() - hit.at < 30_000) return hit.bytes;
  const bytes = treeBytes(path);
  sizeCache.set(path, { at: Date.now(), bytes });
  return bytes;
}
export function forgetSizes(): void { sizeCache.clear(); }

const pinInstalled = (pin: CatalogModelLike): boolean => { const record = getModel(pin.id); return !!record?.modelPath && !!record.verifiedAt && existsSync(record.modelPath); };
const pinBytes = (pin: CatalogModelLike): number => { const record = getModel(pin.id); if (!record?.modelPath) return 0; return record.sizeBytes ?? cachedBytes(record.modelPath); };
const pinDownload = (pin: CatalogModelLike): number => pin.download?.approx_bytes ?? 0;

function unitInstalled(unit: UnitDef): boolean { return unit.pins.every(pinInstalled) && unit.envs.every((env) => env.lazy || env.ready()); }
function unitPartlyInstalled(unit: UnitDef): boolean { return unit.pins.some(pinInstalled) || unit.envs.some((env) => env.ready()); }
function unitDiskBytes(unit: UnitDef, others: UnitDef[]): number {
  return unit.pins.reduce((sum, pin) => sum + pinBytes(pin), 0) + unit.envs.reduce((sum, env) => sum + (env.ready() || existsSync(env.root()) ? cachedBytes(env.root()) / sharers(env, unit, others) : 0), 0);
}
/** An environment shared by two installed units is counted half in each, so the sum never counts it twice. */
function sharers(env: EnvDef, unit: UnitDef, others: UnitDef[]): number { return Math.max(1, others.filter((other) => other.envs.includes(env) && unitPartlyInstalled(other) && other !== unit).length + 1); }
/** What an install would still download: pins not on disk plus an environment not built. */
function remainingDownload(unit: UnitDef): number {
  return unit.pins.filter((pin) => !pinInstalled(pin)).reduce((sum, pin) => sum + pinDownload(pin), 0) + unit.envs.filter((env) => !env.ready()).reduce((sum, env) => sum + env.approxBytes, 0);
}
const totalDownload = (unit: UnitDef): number => unit.pins.reduce((sum, pin) => sum + pinDownload(pin), 0) + unit.envs.reduce((sum, env) => sum + env.approxBytes, 0);

// ---- jobs and last use ----------------------------------------------------

const inFlight = new Map<string, string>();
const failures = new Map<string, string>();

function jobFor(id: string) {
  const running = inFlight.get(id);
  const job = running ? getJob(running) : null;
  return job && (job.state === "running" || job.state === "queued" || job.state === "stalled") ? job : null;
}

// ---- the view -------------------------------------------------------------

export interface ComponentView {
  id: string; label: string; summary: string; group: ComponentGroup; kind: "model" | "lora";
  state: ComponentState;
  /** Bytes on disk now; null when nothing is installed. */
  size_bytes: number | null;
  /** What an install would still download (0 when installed). */
  download_bytes: number;
  /** The full size of a fresh install, for the setup estimate. */
  full_bytes: number;
  /** The free space the data volume needs before an install starts: the installed size plus the disk plan's margin plus its peak temporary space. */
  required_free_bytes: number;
  /** What the setup wizard's plan calls it on this tier (recommended parts are on by default), or null when the plan has no row. */
  plan_need: "required" | "recommended" | "optional" | null;
  requirement: ComponentRequirement;
  /** Plain words when requirement is unsupported, or the reason it is required. */
  requirement_reason: string | null;
  last_used_at: string | null;
  used_by: string[];
  depends_on: string[];
  job: string | null;
  percent: number | null;
  failure: string | null;
  /** A licence the admin accepts once before this installs (null for every part without one). */
  licence: { id: string; name: string; url: string; summary: string[]; accepted_at: string | null } | null;
  can_install: boolean;
  install_block: string | null;
  can_uninstall: boolean;
  uninstall_block: string | null;
}

export interface ComponentList {
  tier: Tier | null;
  free_disk_bytes: number | null;
  disk_margin_bytes: number;
  installed_bytes: number;
  components: ComponentView[];
}

/** The tier and the pins Home installs there come from the install plan, the one sizing function the setup wizard uses. */
function planOf(hardware: HardwareInfo): { tier: Tier | null; planned: Set<string> } {
  const plan = buildInstallPlan(hardware, { installedIds: [] });
  // A removable part (the coding model) is in the plan but is not required: an admin may take it off.
  return { tier: plan.tier, planned: new Set(plan.models.filter((model) => !model.removable).map((model) => model.id)) };
}

function requirementFor(unit: UnitDef, tier: Tier | null, planned: Set<string>): { requirement: ComponentRequirement; reason: string | null } {
  const platform = unit.platformBlock?.() ?? null;
  if (platform) return { requirement: "unsupported", reason: platform };
  const primary = unit.pins[0]!;
  const profile = (primary.sizing as { profile?: string } | undefined)?.profile as Tier | undefined;
  const tooBig = tier && ((unit.tiers && !unit.tiers.includes(tier)) || (!unit.tiers && profile && TIER_RANK[profile] > TIER_RANK[tier]));
  if (tooBig) return { requirement: "unsupported", reason: unit.group === "video" ? "Video needs a computer with 128 GB of memory." : unit.group === "music" ? "Music needs a computer with 64 GB of memory or more." : unit.tiers ? "This needs a computer with more memory than this one." : "This model needs more memory than this computer has." };
  if (planned.has(primary.id)) return { requirement: "required", reason: "Home installs this on a computer of this size." };
  return { requirement: "optional", reason: null };
}

function guardUninstall(unit: UnitDef, requirement: ComponentRequirement): ComponentError | null {
  if (jobFor(unit.id)) return new ComponentError("in_use", "It is still installing. Cancel the install first, then remove it.", 409);
  const busy = unit.busy();
  if (busy) return new ComponentError("in_use", `${busy} Try again when it finishes.`, 409);
  if (unit.serves === "chat") {
    const chosen = selectedModel("chat");
    if (chosen?.id === unit.id) return new ComponentError("chat_model_in_use", "Chat is using this model. Pick another chat model first, then remove this one.", 409);
    const others = componentDefs().filter((other) => other.serves === "chat" && other.id !== unit.id && unitInstalled(other));
    if (others.length === 0) return new ComponentError("only_chat_model", "This is the only chat model installed. Install another one first so chat keeps working.", 409);
    return null;
  }
  if (requirement === "required") return new ComponentError("required", "Home needs this to run on a computer of this size. It cannot be removed.", 409);
  if (unit.serves && selectedModel(unit.serves as never)?.id === unit.id && (unit.serves === "stt" || unit.serves === "tts" || unit.serves === "embed" || unit.serves === "judge")) {
    return new ComponentError("required", "Home is using this right now. It cannot be removed.", 409);
  }
  return null;
}

export async function listComponents(hw?: HardwareInfo): Promise<ComponentList> {
  const hardware = hw ?? await detectHardware();
  const { tier, planned } = planOf(hardware);
  const disk: DiskPlan | null = tier ? diskPlanForTier(tier) : null;
  const free = hardware.freeDiskBytes ?? null;
  const defs = componentDefs();
  const views: ComponentView[] = defs.map((unit) => {
    const installed = unitInstalled(unit);
    const job = jobFor(unit.id);
    const failure = failures.get(unit.id) ?? null;
    const state: ComponentState = job ? "installing" : installed ? "installed" : failure ? "failed" : "notInstalled";
    const { requirement, reason } = requirementFor(unit, tier, planned);
    const remaining = installed ? 0 : remainingDownload(unit);
    const row = disk?.rows.find((candidate) => candidate.id === DISK_ROW[unit.id]) ?? null;
    const totals = row && disk ? diskTotalsFor(disk, [row.id]) : null;
    // The plan's own sums (margin and peak temporary space included) decide the fit; a part the plan has no row for falls back to its download plus a fixed margin.
    const requiredFree = installed ? 0 : totals ? totals.required_free_bytes : remaining + DISK_MARGIN_BYTES;
    let installBlock: string | null = null;
    if (installed) installBlock = "It is already installed.";
    else if (job) installBlock = "It is installing now.";
    else if (requirement === "unsupported") installBlock = reason;
    else if (free !== null && requiredFree > free) installBlock = `Not enough room: it needs about ${gbWords(requiredFree)} and this computer has ${gbWords(free)} free. Free some space first.`;
    const guard = installed || unitPartlyInstalled(unit) ? guardUninstall(unit, requirement) : null;
    const present = installed || unitPartlyInstalled(unit);
    return {
      id: unit.id, label: unit.label, summary: unit.summary, group: unit.group, kind: "model" as const, state,
      size_bytes: present ? unitDiskBytes(unit, defs) : null, download_bytes: remaining, full_bytes: totals ? totals.download_bytes : totalDownload(unit), required_free_bytes: requiredFree, plan_need: row ? row.need : null,
      requirement, requirement_reason: reason, last_used_at: lastUsedOf([unit.id, ...unit.pins.map((pin) => pin.id)]), used_by: unit.usedBy(), depends_on: [],
      job: job?.id ?? null, percent: job ? job.percent : null, failure: state === "failed" ? failure : null,
      licence: unit.licenceNotice ? { ...unit.licenceNotice, accepted_at: licenceAcceptance(unit.licenceNotice.id)?.accepted_at ?? null } : null,
      can_install: installBlock === null, install_block: installBlock,
      can_uninstall: present && !guard && !job, uninstall_block: !present ? "It is not installed." : job ? "It is still installing." : guard?.message ?? null,
    };
  });
  // The household's LoRA files: removable items, never installable here (they are added from the Pictures and Video pages).
  const loraView = (kindLabel: "picture" | "video", id: string, name: string, bytes: number, lastBase: string, group: ComponentGroup): ComponentView => ({
    id: `lora.${kindLabel}.${id}`, label: `Style: ${name}`, summary: `A ${kindLabel} style (LoRA) the household added.`, group: "loras", kind: "lora", state: "installed",
    size_bytes: bytes, download_bytes: 0, full_bytes: bytes, required_free_bytes: 0, plan_need: null, requirement: "optional", requirement_reason: null, last_used_at: null, used_by: [group === "pictures" ? "Pictures" : "The Video app"], depends_on: [lastBase],
    job: null, percent: null, failure: null, licence: null, can_install: false, install_block: `Add it again from the ${kindLabel === "picture" ? "Pictures" : "Video"} page.`, can_uninstall: true, uninstall_block: null,
  });
  const loras = [
    ...imageLoras.list().map((lora) => loraView("picture", lora.id, lora.name, lora.bytes, lora.base_model, "pictures")),
    ...listVideoLoras().map((lora) => loraView("video", lora.id, lora.name, lora.bytes, "video", "video")),
  ];
  const components = [...views, ...loras];
  return { tier, free_disk_bytes: free, disk_margin_bytes: DISK_MARGIN_BYTES, installed_bytes: components.reduce((sum, c) => sum + (c.size_bytes ?? 0), 0), components };
}

function gbWords(bytes: number): string { return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`; }

// ---- install --------------------------------------------------------------

/** The suite hands in a scripted download and environment build; null puts the real ones back. */
export interface ComponentDeps { download?: DownloadModelOptions["download"]; buildEnv?: (env: { name: string }, onPhase: (phase: string) => void) => Promise<void>; }
let deps: ComponentDeps = {};
export function __setComponentDepsForTests(next: ComponentDeps | null): void { deps = next ?? {}; }
export async function __settleComponentInstallsForTests(): Promise<void> { await Promise.all(settling); }
const settling = new Set<Promise<void>>();

export async function startComponentInstall(id: string, hw?: HardwareInfo, consent: { licence?: string; by?: string | null } = {}): Promise<{ job: string | null; component: string; joined: boolean; already: boolean }> {
  const unit = componentDefs().find((candidate) => candidate.id === id);
  if (!unit) throw new ComponentError("unknown_component", `There is no component called ${id.slice(0, 60)}.`, 404);
  const running = jobFor(id);
  if (running) return { job: running.id, component: id, joined: true, already: false };
  if (unitInstalled(unit)) return { job: null, component: id, joined: false, already: true };
  const list = await listComponents(hw);
  const view = list.components.find((candidate) => candidate.id === id)!;
  // A licence with its own terms is accepted once, by an admin, before the first byte comes down.
  if (unit.licenceNotice && !licenceAcceptance(unit.licenceNotice.id)) {
    if (consent.licence !== unit.licenceNotice.id) throw new ComponentError("licence_required", `${unit.label} comes with the maker's licence (${unit.licenceNotice.name}). Read it and accept it, then install.`, 409);
    recordLicenceAcceptance(unit.licenceNotice.id, consent.by ?? null);
  }
  if (view.install_block) throw new ComponentError(view.requirement === "unsupported" ? "not_available" : view.install_block.startsWith("Not enough room") ? "not_enough_space" : "not_available", view.install_block, 409);

  const pins = unit.pins.filter((pin): pin is CatalogModelLike & { download: NonNullable<CatalogModelLike["download"]> } => !!pin.download);
  const items = [
    ...pins.map((pin) => ({ id: pin.id, label: pin.download!.hub_file ?? pin.id, completedBytes: pinInstalled(pin) ? pin.download!.approx_bytes : 0, totalBytes: pin.download!.approx_bytes, state: pinInstalled(pin) ? "done" as const : "queued" as const })),
    ...unit.envs.filter((env) => !env.lazy && !env.ready()).map((env) => ({ id: `env:${env.name}`, label: `${env.name} engine`, completedBytes: 0, totalBytes: env.approxBytes, state: "queued" as const })),
  ];
  const totalBytes = items.reduce((sum, item) => sum + item.totalBytes, 0);
  const job = createJob({ kind: COMPONENT_JOB_KIND, role: unit.role, totalBytes, items, status: "downloading", input: { component: id, model: id, label: unit.label } });
  inFlight.set(id, job.id);
  failures.delete(id);
  const run = (async () => {
    try {
      let done = items.reduce((sum, item) => sum + (item.state === "done" ? item.completedBytes : 0), 0);
      updateJob(job.id, { completedBytes: done });
      for (const pin of pins) {
        if (pinInstalled(pin)) continue;
        const destination = join(modelsDir, pin.id, basename(new URL(pin.download.url).pathname) || `${pin.id}.bin`);
        const base = done;
        await installCatalogModel(pin, {
          destination, signal: jobSignal(job.id), ...(deps.download ? { download: deps.download } : {}),
          onProgress: (progress) => {
            const itemDone = progress.itemCompletedBytes ?? progress.completedBytes;
            const nextItems = getJob(job.id)?.items?.map((item) => item.id !== pin.id ? item : { ...item, completedBytes: itemDone, state: "running" as const });
            updateJob(job.id, { completedBytes: Math.min(totalBytes, base + itemDone), ...(progress.bytesPerSecond === undefined ? {} : { bytesPerSecond: progress.bytesPerSecond }), ...(nextItems ? { items: nextItems } : {}) });
          },
        });
        done += pin.download.approx_bytes;
        const nextItems = getJob(job.id)?.items?.map((item) => item.id !== pin.id ? item : { ...item, completedBytes: item.totalBytes, state: "done" as const });
        updateJob(job.id, { completedBytes: done, ...(nextItems ? { items: nextItems } : {}) });
      }
      for (const env of unit.envs) {
        if (env.lazy || env.ready()) continue;
        updateJob(job.id, { status: `building the ${env.name} engine` });
        const phase = (text: string) => updateJob(job.id, { status: `building ${text}` });
        if (deps.buildEnv) await deps.buildEnv(env, phase); else await env.build(phase, jobSignal(job.id));
        done += env.approxBytes;
        const nextItems = getJob(job.id)?.items?.map((item) => item.id !== `env:${env.name}` ? item : { ...item, completedBytes: item.totalBytes, state: "done" as const });
        updateJob(job.id, { completedBytes: done, ...(nextItems ? { items: nextItems } : {}) });
      }
      forgetSizes();
      resolveHealth(COMPONENT_FAILED_CODE(id));
      finishJob(job.id, { ok: true, result: { component: id } });
      emit({ id: "engine.state", data: { engine: unit.envs[0]?.name ?? id, state: "installed" } });
      bumpStackGeneration(`component ${id} installed`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const cancelled = jobSignal(job.id)?.aborted === true;
      finishJob(job.id, { ok: false, reason });
      if (!cancelled) {
        failures.set(id, reason);
        raise({ code: COMPONENT_FAILED_CODE(id), severity: "warning", title: `${unit.label} could not be installed`, text: `The download or setup of ${unit.label} did not finish.`, cause: reason, fix: { label: "Try again", action: "retry_download" } });
      }
    } finally { inFlight.delete(id); }
  })();
  settling.add(run);
  void run.finally(() => settling.delete(run));
  return { job: job.id, component: id, joined: false, already: false };
}

// ---- uninstall ------------------------------------------------------------

export interface UninstallResult { component: string; freed_bytes: number; removed: boolean; }

export async function uninstallComponent(id: string, hw?: HardwareInfo): Promise<UninstallResult> {
  if (id.startsWith("lora.")) return uninstallLora(id);
  const defs = componentDefs();
  const unit = defs.find((candidate) => candidate.id === id);
  if (!unit) throw new ComponentError("unknown_component", `There is no component called ${id.slice(0, 60)}.`, 404);
  if (jobFor(id)) throw new ComponentError("in_use", "It is still installing. Cancel the install first, then remove it.", 409);
  if (!unitPartlyInstalled(unit)) return { component: id, freed_bytes: 0, removed: false };
  const hardware = hw ?? await detectHardware();
  const { tier, planned } = planOf(hardware);
  const guard = guardUninstall(unit, requirementFor(unit, tier, planned).requirement);
  if (guard) throw guard;
  const before = unitDiskBytes(unit, defs);
  let freed = 0;
  for (const pin of unit.pins) {
    const record = getModel(pin.id);
    if (!record) continue;
    const hub = pin.download?.hub_file && pin.repo && pin.revision;
    if (hub) freed += releaseHfFile(pin.repo!, pin.revision!, pin.download!.hub_file!);
    removeModel(pin.id);
  }
  for (const env of unit.envs) {
    // An environment another installed component still runs in stays.
    const shared = defs.some((other) => other !== unit && other.envs.includes(env) && other.pins.some(pinInstalled));
    if (shared) continue;
    env.stop?.();
    if (existsSync(env.root())) { freed += cachedBytes(env.root()); rmSync(env.root(), { recursive: true, force: true }); }
    if (env.link) { try { unlinkSync(env.link); } catch { /* no link */ } }
  }
  forgetSizes();
  resolveHealth(COMPONENT_FAILED_CODE(id));
  failures.delete(id);
  bumpStackGeneration(`component ${id} removed`);
  return { component: id, freed_bytes: Math.max(freed, before > 0 ? freed : 0), removed: true };
}

async function uninstallLora(id: string): Promise<UninstallResult> {
  const [, kind, loraId] = id.split(".") as [string, string, string];
  const bytes = kind === "video" ? listVideoLoras().find((lora) => lora.id === loraId)?.bytes ?? 0 : imageLoras.list().find((lora) => lora.id === loraId)?.bytes ?? 0;
  const removed = kind === "video" ? await removeVideoLora(loraId) : kind === "picture" ? await imageLoras.remove(loraId) : false;
  if (!removed) return { component: id, freed_bytes: 0, removed: false };
  return { component: id, freed_bytes: bytes, removed: true };
}

/** The component an install Repairs item names, for its Try again. */
export function componentIdOfFailureCode(code: string): string | null { return code.startsWith(COMPONENT_FAILED_PREFIX) ? code.slice(COMPONENT_FAILED_PREFIX.length) : null; }
