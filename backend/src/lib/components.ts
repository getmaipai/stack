// COMPONENTS-01: every installable part of the Stack as one list a person
// can read, with an install and an uninstall that go through the parts' own
// mechanisms (the model store, the picture, video and voice environments,
// the LoRA libraries). A component is what a household member would name
// (a picture model, a wake word, a chat model), not a
// file: it groups the pinned model records that install together with the
// managed environment they run in. Nothing here is stored except when a
// component was last used (`meta`); state is derived from the disk, the
// model records and the job list, so it cannot drift.
import { existsSync, lstatSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { lastUsedOf } from "@/lib/componentUse";
import { partDef, partLabel, registerPartUnits } from "@/lib/parts";
import { detectHardware, knownAppleChip, type HardwareInfo } from "@/lib/hardware";
import { createJob, finishJob, getJob, jobSignal, listJobs, updateJob } from "@/lib/jobs";
import { emit } from "@/lib/events";
import { raise, resolve as resolveHealth } from "@/lib/health";
import { getModel, installCatalogModel, removeModel, removeModelsAtomically, type CatalogModelLike, type DownloadModelOptions } from "@/lib/modelStore";
import { H3_LICENCE_NOTICE, KLEIN3_LICENCE_NOTICE, STACK_IMAGE_KLEIN3_ID, STACK_IMAGE_KLEIN3_MODELS, STACK_IMAGE_H3_ID, STACK_IMAGE_H3_MODELS, STACK_IMAGE_ERNIE_MODELS, STACK_IMAGE_KLEIN_MODELS, STACK_IMAGE_QWEN_MODELS, STACK_IMAGE_RESTORE_MODELS, STACK_IMAGE_RESTORE_ID, STACK_IMAGE_TOOL_MODELS, STACK_IMAGE_ZIMAGE_MODELS, STACK_LIVEPORTRAIT_MODELS, LTX_LICENCE_NOTICE, H3_VIDEO_LICENSE_NOTICE, STACK_VIDEO_H3_MODEL, STACK_VIDEO_H3_MODEL_ID, SFX_LICENCE_NOTICE, STACK_SFX_MODELS, STACK_MODELS, STACK_MUSIC_MODELS, STACK_MUSIC_WHISPER, STACK_MUSIC_MAX_MODELS, STACK_MUSIC_SFT_ID, STACK_MUSIC_XL_ID, STACK_MUSIC_XL_MODELS, STACK_ALIGN_MODELS, STACK_STEMS_MODELS, STACK_RECORDED_SPEECH_MODELS, STACK_VIDEO_LTX25_MAX_MODELS, STACK_VIDEO_LTX25_MAX_MODEL_ID, STACK_VIDEO_LTX25_MODELS, STACK_VIDEO_LTX25_MODEL_ID, STACK_VIDEO_MASK_MODELS, STACK_VIDEO_MASK_MODEL_ID, STACK_VIDEO_MODELS } from "@/lib/modelCatalog";
import { licenceAcceptance, recordLicenceAcceptance, type LicenceNotice } from "@/lib/licenceAcceptance";
import { buildInstallPlan } from "@/lib/installPlan";
import { diskPlanForTier, diskTotalsFor, engineDownloadBytes, type DiskPlan } from "@/lib/diskPlan";
import { modelsDir } from "@/lib/paths";
import { bumpStackGeneration } from "@/lib/stackGeneration";
import { releaseHfFile } from "@/lib/store/hfCache";
import { engineCurrentPath, engineTagRoot } from "@/lib/store/layout";
import { selectEngineBinary } from "@/lib/engineCatalog";
import { splashDraftPossible } from "@/lib/splash";
import { ensureEngine, engineDir, engineToolPath } from "@/lib/engineInstall";
import { ENGINE_READY_MARKER } from "@/lib/engineCatalog";
import { FFMPEG_NAME, FFMPEG_TAG, FPCALC_NAME, FPCALC_TAG, MEDIA_COMPONENTS, SHAZAM_SIGNATURE_NAME, SHAZAM_SIGNATURE_VERSION, ffmpegPinFor, fpcalcPinFor, shazamSignatureRequirementsFileFor } from "@/media/pins";
import { ensureUvEnvironment, uvEnvironmentReady, uvVenvPath } from "@/lib/uvEnvironment";
import { loadedRoleForModel, selectedModel } from "@/lib/supervisor";
import { ensureImageGenEnvironment, imageGen, imageGenEnvironmentReady, imageGenRoot } from "@/images/imageEngine";
import { imageLoras } from "@/images/loras";
import { ensureH3GenEnvironment, H3_GEN_NAME, h3GenEnvironmentReady, h3GenRoot } from "@/images/h3Engine";
import { ensureLtx25Environment, ensureLtx25MaxEnvironment, ltx25EnvironmentReady, ltx25GenRoot, ltx25MaxEnvironmentReady, ltx25MaxGenRoot, LTX25_GEN_NAME, LTX25_MAX_GEN_NAME } from "@/video/ltx25";
import { ensureVideoGenEnvironment, tierAvailability as videoAvailability, videoGen, videoGenEnvironmentReady, videoGenRoot, VIDEO_GEN_NAME } from "@/video/videoGen";
import { ensureMusicGenEnvironment, tierAvailability as musicAvailability, musicGen, musicGenEnvironmentReady, musicGenRoot, MUSIC_GEN_NAME } from "@/music/musicGen";
import { ensureSfxGenEnvironment, sfxGen, sfxGenEnvironmentReady, sfxGenRoot, sfxTierAvailability, SFX_GEN_NAME } from "@/sound/sfxGen";
import { SOUND_JOB_KIND } from "@/sound/jobs";
import { SCORE_JOB_KIND } from "@/score/jobs";
import { ensureScoreGenEnvironment, scoreGenEnvironmentReady, scoreGenRoot, scoreRequirementsFileFor, SCORE_GEN_NAME } from "@/score/scoreGen";
import { align, ALIGN_NAME, ensureAlignEnvironment, alignRoot, alignEnvironmentReady } from "@/align/align";
import { BEATS_JOB_KIND } from "@/beats/jobs";
import { beats, BEATS_NAME, ensureBeatsEnvironment, beatsRoot, beatsEnvironmentReady } from "@/beats/beats";
import { stems, STEMS_NAME, ensureStemsEnvironment, stemsRoot, stemsEnvironmentReady } from "@/stems/stems";
import { voiceConvert, VOICE_CONVERT_NAME, ensureVoiceConvertEnvironment, voiceConvertRoot, voiceConvertEnvironmentReady } from "@/voiceConvert/voiceConvert";
import { listLoras as listVideoLoras, removeLora as removeVideoLora } from "@/video/loras";
import { imageTools, imageToolsProof, imageToolsRoot } from "@/imagetools/imageTools";
import { livePortrait, livePortraitEnvironmentReady, livePortraitRoot } from "@/liveportrait/liveportrait";
import { ensurePocketTtsEnvironment, pocketTtsInstalled, pocketTtsRoot } from "@/speech/pocketTts";
import { ensureMlxAudioEnvironment, mlxAudioInstalled, mlxAudioRoot } from "@/speech/mlxAudio";
import { RECORDED_SPEECH_NAME, ensureRecordedSpeechEnvironment, recordedSpeech, recordedSpeechEnvironmentReady, recordedSpeechRoot } from "@/recordedSpeech/recordedSpeech";
import { ensureMaskEnvironment, maskEnvironmentReady, maskGenRoot, maskRequirementsFileFor, MASK_GEN_NAME } from "@/video/mask";

export const COMPONENT_JOB_KIND = "component.install";
export const COMPONENT_FAILED_CODE = (id: string): string => `component-install-failed.${id}`;
export const COMPONENT_FAILED_PREFIX = "component-install-failed.";
/** Room kept free on the data volume beyond a download, so a fit never leaves the computer full. */
export const DISK_MARGIN_BYTES = 5_000_000_000;

export type ComponentGroup = "chat" | "voice" | "pictures" | "video" | "music" | "stems" | "tools" | "loras";
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
  /** The licence the part ships under, in plain words, shown beside its size (a part with no extra terms to accept). */
  licenceName?: string;
  /** Set when Home cannot run without the part and there is no model pin to say so: the reason shown, and removal is refused. */
  alwaysRequired?: string;
  /** A licence with terms beyond the open ones: the install waits for an admin to accept it once (Home sends the notice id). */
  licenceNotice?: LicenceNotice;
}

const GB = 1_000_000_000;
/** Environment downloads come from the disk plan's measured table (one definition with the wizard); the figures are a fallback only. */
const ENV_BYTES = { align: engineDownloadBytes("align") ?? 0.3 * GB, beats: engineDownloadBytes("beats") ?? 0.5 * GB, stems: engineDownloadBytes("stems") ?? 0.25 * GB, voiceConvert: engineDownloadBytes("voice-convert") ?? 4 * GB, recordedSpeech: engineDownloadBytes("recorded-speech") ?? 1.7 * GB, image: engineDownloadBytes("image-gen") ?? 1.1 * GB, h3: engineDownloadBytes("h3-image-gen") ?? 0.08 * GB, video: engineDownloadBytes("video-gen") ?? 1.0 * GB, ltx25: engineDownloadBytes("ltx25-gen") ?? 0.25 * GB, ltx25max: engineDownloadBytes("ltx25-max-gen") ?? 0.25 * GB, mask: engineDownloadBytes("mask-gen") ?? 0.6 * GB, music: engineDownloadBytes("music-gen") ?? 0.8 * GB, tools: engineDownloadBytes("image-tools") ?? 0.4 * GB, pocket: engineDownloadBytes("pocket-tts") ?? 0.72 * GB, mlxAudio: engineDownloadBytes("mlx-audio") ?? 0.47 * GB };
/** The disk plan's row for a component, where the plan has one (its optional rows are the wizard's unchecked extras). */
/** The install-plan row each component stands for (the size and need shown beside it). A test keeps every plan row covered. */
export const DISK_ROW: Record<string, string> = { "qwen3.8-27b-ud-q4-k-m": "coding", "flux2-klein-4b": "pictures", "flux3-image-klein": "pictures-klein3", "z-image-turbo": "pictures-zimage", "ernie-image-turbo": "pictures-ernie", "qwen-image-2512-q8": "pictures-qwen", "minimax-h3-image": "pictures-h3", "seedvr2-3b": "pictures-clearer", "image-tools": "image-tools", ffmpeg: "ffmpeg", "shazam-signature": "shazam-signature", "pocket-tts-english": "voice", "chatterbox-turbo-fp16": "voice-better", "fish-audio-drama-3-4bit": "recorded-speech", "fastwan2-2-ti2v-5b-mlx-bf16": "video", "sam2.1-hiera-small": "video-mask", "ace-step-1-5-turbo": "music", "ace-step-1-5-xl-turbo-bf16": "music-boost", "ace-step-1-5-xl-sft-bf16": "music-max", "htdemucs": "stems", "htdemucs_ft": "stems-ft", "htdemucs_6s": "stems-6s", "mms-fa-align": "align", "soulx-singer-svc": "voice-convert", "soulx-singer-rmvpe": "voice-convert", "soulx-singer-whisper-base": "voice-convert", "ltx-2-5-q8-distilled-mlx": "video-ltx25", "ltx-2-5-bf16-distilled-mlx-max": "video-ltx25-max", "stable-audio-3-small-sfx": "sound-effects", "score-gen": "score-transcription" };

const envImage: EnvDef = { name: "image-gen", approxBytes: ENV_BYTES.image, root: imageGenRoot, ready: imageGenEnvironmentReady, build: (onPhase, signal) => ensureImageGenEnvironment(onPhase, { signal }), stop: () => imageGen.stop() };
// The high-detail picture model's own environment (h3-image-gen). It has no warm worker, so nothing needs stopping before it is rebuilt.
const envH3: EnvDef = { name: H3_GEN_NAME, approxBytes: ENV_BYTES.h3, root: h3GenRoot, ready: h3GenEnvironmentReady, build: (onPhase, signal) => ensureH3GenEnvironment(onPhase, { signal }), stop: () => {} };
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
const envLtx25: EnvDef = {
  name: LTX25_GEN_NAME, approxBytes: ENV_BYTES.ltx25, root: ltx25GenRoot, ready: ltx25EnvironmentReady, link: engineCurrentPath(LTX25_GEN_NAME), stop: () => videoGen.stop(),
  build: async (onPhase, signal) => {
    const pin = selectEngineBinary(await detectHardware(), LTX25_GEN_NAME);
    if (!pin) throw new Error("No pinned LTX-2.5 video engine build exists for this computer.");
    onPhase("the LTX-2.5 video engine");
    await ensureEngine(pin, () => {}, { signal });
    await ensureLtx25Environment(onPhase, { signal });
  },
};
const envLtx25Max: EnvDef = {
  name: LTX25_MAX_GEN_NAME, approxBytes: ENV_BYTES.ltx25max, root: ltx25MaxGenRoot, ready: ltx25MaxEnvironmentReady, link: engineCurrentPath(LTX25_MAX_GEN_NAME), stop: () => videoGen.stop(),
  build: async (onPhase, signal) => {
    const pin = selectEngineBinary(await detectHardware(), LTX25_MAX_GEN_NAME);
    if (!pin) throw new Error("No pinned LTX-2.5 Max video engine build exists for this computer.");
    onPhase("the LTX-2.5 Max video engine");
    await ensureEngine(pin, () => {}, { signal });
    await ensureLtx25MaxEnvironment(onPhase, { signal });
  },
};
const envMask: EnvDef = { name: MASK_GEN_NAME, approxBytes: ENV_BYTES.mask, root: maskGenRoot, ready: maskEnvironmentReady, link: engineCurrentPath(MASK_GEN_NAME), build: (onPhase, signal) => ensureMaskEnvironment(onPhase, signal) };
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
const envSfx: EnvDef = {
  name: SFX_GEN_NAME, approxBytes: engineDownloadBytes(SFX_GEN_NAME) ?? 0.6 * GB, root: sfxGenRoot, ready: sfxGenEnvironmentReady, link: engineCurrentPath(SFX_GEN_NAME), stop: () => sfxGen.stop(),
  build: async (onPhase, signal) => {
    const pin = selectEngineBinary(await detectHardware(), SFX_GEN_NAME);
    if (!pin) throw new Error("No pinned sound effects engine build exists for this computer.");
    onPhase("the sound effects engine");
    await ensureEngine(pin, () => {}, { signal });
    await ensureSfxGenEnvironment(onPhase, { signal });
  },
};
const envScore: EnvDef = { name: SCORE_GEN_NAME, approxBytes: engineDownloadBytes(SCORE_GEN_NAME) ?? 180 * 1024 * 1024, root: scoreGenRoot, ready: scoreGenEnvironmentReady, build: (onPhase, signal) => ensureScoreGenEnvironment(onPhase, signal) };
const envAlign: EnvDef = { name: ALIGN_NAME, approxBytes: ENV_BYTES.align, root: alignRoot, ready: alignEnvironmentReady, build: (onPhase, signal) => ensureAlignEnvironment(onPhase, signal), stop: () => align.stop() };
const envBeats: EnvDef = { name: BEATS_NAME, approxBytes: ENV_BYTES.beats, root: beatsRoot, ready: beatsEnvironmentReady, build: (onPhase, signal) => ensureBeatsEnvironment(onPhase, signal), stop: () => beats.stop() };
const envStems: EnvDef = { name: STEMS_NAME, approxBytes: ENV_BYTES.stems, root: stemsRoot, ready: stemsEnvironmentReady, build: (onPhase, signal) => ensureStemsEnvironment(onPhase, signal), stop: () => stems.stop() };
const envVoiceConvert: EnvDef = { name: VOICE_CONVERT_NAME, approxBytes: ENV_BYTES.voiceConvert, root: voiceConvertRoot, ready: voiceConvertEnvironmentReady, build: (onPhase, signal) => ensureVoiceConvertEnvironment(onPhase, signal), stop: () => voiceConvert.stop() };
const envTools: EnvDef = { name: "image-tools", approxBytes: ENV_BYTES.tools, root: imageToolsRoot, ready: () => uvEnvironmentReady({ root: imageToolsRoot(), proof: imageToolsProof() }), lazy: true, build: async () => {}, stop: () => imageTools.stop() };
const envAvatarMotion: EnvDef = { name: "liveportrait", approxBytes: 1_500_000_000, root: livePortraitRoot, ready: () => livePortrait.status().installed && livePortraitEnvironmentReady(), lazy: true, build: async () => {}, stop: () => livePortrait.stop() };
/** ffmpeg and ffprobe, one pinned archive (media/pins.ts) the media service already fetches on first use; listing it lets the wizard install it up front. */
const ffmpegRoot = (): string => { const pin = ffmpegPinFor(); return pin ? engineDir(pin) : engineTagRoot(FFMPEG_NAME, FFMPEG_TAG); };
const ffmpegReady = (): boolean => { const pin = ffmpegPinFor(); return !!pin && existsSync(join(engineDir(pin), ENGINE_READY_MARKER)) && existsSync(engineToolPath(pin, "ffmpeg")); };
const envFfmpeg: EnvDef = {
  name: FFMPEG_NAME, approxBytes: engineDownloadBytes("ffmpeg") ?? 32_902_204, root: ffmpegRoot, ready: ffmpegReady, link: engineCurrentPath(FFMPEG_NAME),
  build: async (onPhase, signal) => {
    const pin = ffmpegPinFor();
    if (!pin) throw new Error(`Audio and video tools are not available on ${process.platform} ${process.arch} yet.`);
    onPhase("the audio and video tools");
    await ensureEngine(pin, () => {}, { signal, activate: true });
  },
};
const fpcalcRoot = (): string => { const pin = fpcalcPinFor(); return pin ? engineDir(pin) : engineTagRoot(FPCALC_NAME, FPCALC_TAG); };
const fpcalcReady = (): boolean => { const pin = fpcalcPinFor(); return !!pin && existsSync(join(engineDir(pin), ENGINE_READY_MARKER)) && existsSync(engineToolPath(pin, "fpcalc")); };
const envFpcalc: EnvDef = {
  name: FPCALC_NAME, approxBytes: engineDownloadBytes(FPCALC_NAME) ?? 1_322_220, root: fpcalcRoot, ready: fpcalcReady, link: engineCurrentPath(FPCALC_NAME),
  build: async (onPhase, signal) => {
    const pin = fpcalcPinFor();
    if (!pin) throw new Error(`The song naming tool is not available on ${process.platform} ${process.arch} yet.`);
    onPhase("the song naming tool");
    await ensureEngine(pin, () => {}, { signal, activate: true });
  },
};
const shazamSignatureRoot = (): string => engineTagRoot(SHAZAM_SIGNATURE_NAME, SHAZAM_SIGNATURE_VERSION);
const shazamSignatureSpec = () => { const root = shazamSignatureRoot(); return { name: SHAZAM_SIGNATURE_NAME, version: SHAZAM_SIGNATURE_VERSION, root, requirements: shazamSignatureRequirementsFileFor(), proof: join(uvVenvPath(root), "bin", "python") }; };
const envShazamSignature: EnvDef = {
  name: SHAZAM_SIGNATURE_NAME, approxBytes: 1_700_000, root: shazamSignatureRoot,
  ready: () => uvEnvironmentReady(shazamSignatureSpec()),
  build: async (onPhase, signal) => { onPhase("the song signature tool"); await ensureUvEnvironment(shazamSignatureSpec(), onPhase, { signal }); },
};
const envPocket: EnvDef = { name: "pocket-tts", approxBytes: ENV_BYTES.pocket, root: pocketTtsRoot, ready: pocketTtsInstalled, build: (onPhase, signal) => ensurePocketTtsEnvironment(onPhase, { signal }) };
const envMlxAudio: EnvDef = { name: "mlx-audio", approxBytes: ENV_BYTES.mlxAudio, root: mlxAudioRoot, ready: mlxAudioInstalled, build: (onPhase, signal) => ensureMlxAudioEnvironment(onPhase, { signal }) };
const envRecordedSpeech: EnvDef = { name: RECORDED_SPEECH_NAME, approxBytes: ENV_BYTES.recordedSpeech, root: recordedSpeechRoot, ready: recordedSpeechEnvironmentReady, build: (onPhase, signal) => ensureRecordedSpeechEnvironment(onPhase, signal), stop: () => recordedSpeech.stop() };

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
    const text = partDef(primary.id) ?? { label: primary.id, description: "" };
    return {
      id: primary.id, label: partLabel(primary.id), summary: text.description, group, role: primary.role, pins: dedupe([primary, ...(projector ? [projector] : []), ...(primary.role === "chat" || primary.role === "judge" || primary.role === "vision" || primary.role === "embed" ? [] : parts)], (pin) => pin.id),
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
  if (wake.length) units.push({ id: "wakeword", label: partLabel("wakeword"), summary: partDef("wakeword")!.description, group: "voice", role: "wakeword", pins: wake, envs: [], usedBy: () => ["Wake activation on speakers and robots"], busy: () => null });
  const pictureBusy = (): string | null => {
    const state = imageGen.status().state;
    if (state === "running" || state === "building") return "A picture is being made right now.";
    return activeJobFor((kind) => kind === "image_generation" || kind === "image" || kind.startsWith("image")) ? "A picture is waiting or being made right now." : null;
  };
  const familyUnit = (id: "flux2-klein-4b" | "flux3-image-klein" | "z-image-turbo" | "ernie-image-turbo" | "qwen-image-2512-q8" | "minimax-h3-image", pins: CatalogModelLike[], tiers: Tier[], usedBy: string, extra: Partial<UnitDef> = {}): UnitDef => ({
    id, label: partLabel(id), summary: partDef(id)!.description, group: "pictures", role: "image", pins, envs: [envImage], tiers, ...extra,
    platformBlock: () => imageGen.supported() ? null : "Pictures are not available on this kind of computer yet.",
    usedBy: () => { const count = imageLoras.list().filter((lora) => lora.base_model === id).length; return [usedBy, ...(count ? [`${count} picture style${count === 1 ? "" : "s"} (LoRAs)`] : [])]; },
    busy: pictureBusy,
  });
  units.push(familyUnit("flux2-klein-4b", STACK_IMAGE_KLEIN_MODELS, ["p32", "p64", "p128"], "Pictures in chat and the Pictures app"));
  units.push(familyUnit(STACK_IMAGE_KLEIN3_ID, STACK_IMAGE_KLEIN3_MODELS, ["p64", "p128"], "Pictures, when chosen as the model", { licenceNotice: KLEIN3_LICENCE_NOTICE }));
  units.push(familyUnit("z-image-turbo", STACK_IMAGE_ZIMAGE_MODELS, ["p128"], "Pictures, when chosen as the model"));
  units.push(familyUnit("ernie-image-turbo", STACK_IMAGE_ERNIE_MODELS, ["p64", "p128"], "Pictures, when chosen as the model"));
  units.push(familyUnit("qwen-image-2512-q8", STACK_IMAGE_QWEN_MODELS, ["p128"], "Max pictures"));
  // H3-IMAGE-STACK-01: its own environment, and the maker's licence accepted once before the download.
  units.push(familyUnit(STACK_IMAGE_H3_ID, STACK_IMAGE_H3_MODELS, ["p16", "p32", "p64", "p128"], "Pictures in chat and the Pictures app", { envs: [envH3], licenceNotice: H3_LICENCE_NOTICE }));
  // MAKE-CLEARER-2026-11-13: the Best level of Make clearer. Optional, and recommended only where a 12 GB peak fits beside chat (the 64 GB tier and up).
  units.push({
    id: STACK_IMAGE_RESTORE_ID, label: partLabel(STACK_IMAGE_RESTORE_ID), summary: partDef(STACK_IMAGE_RESTORE_ID)!.description, group: "tools", role: "image", pins: STACK_IMAGE_RESTORE_MODELS, envs: [envImage], tiers: ["p64", "p128"],
    platformBlock: () => imageGen.supported() ? null : "Pictures are not available on this kind of computer yet.",
    usedBy: () => ["Make clearer, Best level, in the Studio and in chat"],
    busy: pictureBusy,
  });
  units.push({
    id: "image-tools", label: partLabel("image-tools"), summary: partDef("image-tools")!.description, group: "tools", role: "image", pins: STACK_IMAGE_TOOL_MODELS, envs: [envTools],
    platformBlock: () => { const status = imageTools.status(); return status.state === "unsupported" ? status.reason ?? "Image editing is not available on this computer yet." : null; },
    usedBy: () => ["The picture editor"],
    busy: () => { const state = imageTools.status().state; return state === "running" || state === "building" ? "A picture edit is running right now." : null; },
  });
  units.push({
    id: "ffmpeg", label: partLabel("ffmpeg"), summary: partDef("ffmpeg")!.description, group: "tools", role: "media", pins: [], envs: [envFfmpeg],
    licenceName: MEDIA_COMPONENTS.find((component) => component.name === "ffmpeg")!.licence,
    alwaysRequired: "Home uses this to mix songs, shift voices and cut clips, so it is always installed.",
    platformBlock: () => ffmpegPinFor() ? null : `Audio and video tools are not available on ${process.platform} ${process.arch} yet.`,
    usedBy: () => ["Songs and sound effects", "Changing a voice", "Video and picture clips"],
    busy: () => activeJobFor((kind) => kind.startsWith("media") || kind === "music_edit") ? "A clip or a song edit is running right now." : null,
  });
  units.push({
    id: "fpcalc", label: partLabel("fpcalc"), summary: partDef("fpcalc")!.description, group: "tools", role: "media", pins: [], envs: [envFpcalc],
    licenceName: MEDIA_COMPONENTS.find((component) => component.name === "fpcalc (chromaprint)")!.licence,
    platformBlock: () => fpcalcPinFor() ? null : `The song naming tool is not available on ${process.platform} ${process.arch} yet.`,
    usedBy: () => ["Name a song from a recording"], busy: () => null,
  });
  units.push({
    id: SHAZAM_SIGNATURE_NAME, label: partLabel(SHAZAM_SIGNATURE_NAME), summary: partDef(SHAZAM_SIGNATURE_NAME)!.description, group: "tools", role: "media", pins: [], envs: [envShazamSignature],
    licenceName: MEDIA_COMPONENTS.find((component) => component.name === "shazam-signature (shazamio-core)")!.licence,
    platformBlock: () => shazamSignatureRequirementsFileFor() ? null : `The song signature tool is not available on ${process.platform} ${process.arch} yet.`,
    usedBy: () => ["Name a song from a recording"], busy: () => null,
  });
  units.push({
    id: "liveportrait", label: partLabel("liveportrait"), summary: partDef("liveportrait")!.description, group: "tools", role: "image", pins: STACK_LIVEPORTRAIT_MODELS, envs: [envAvatarMotion],
    platformBlock: () => { const status = livePortrait.status(); return status.state === "unsupported" ? status.reason ?? "Companion animation is not available on this computer yet." : null; },
    usedBy: () => ["Talking companions"],
    busy: () => { const state = livePortrait.status().state; return state === "running" || state === "building" ? "Talking frames are being made right now." : null; },
  });
  const lookPins = STACK_IMAGE_TOOL_MODELS.filter((pin) => pin.component === "tool-look");
  if (lookPins.length) units.push({ id: "tool-look", label: partLabel("tool-look"), summary: partDef("tool-look")!.description, group: "tools", role: "image", pins: lookPins, envs: [envTools], usedBy: () => ["Look at a picture"], busy: () => null });
  units.push({
    id: STACK_VIDEO_MODELS[0]!.id, label: partLabel(STACK_VIDEO_MODELS[0]!.id), summary: partDef(STACK_VIDEO_MODELS[0]!.id)!.description, group: "video", role: "video", pins: STACK_VIDEO_MODELS, envs: [envVideo], tiers: ["p128"],
    platformBlock: () => videoAvailability().code === "unsupported" ? videoAvailability().reason : null,
    usedBy: () => { const count = listVideoLoras().filter((lora) => lora.base_model === "wan2.2-ti2v-5b" || lora.base_model === "ltx-2.5").length; return ["The Video app", ...(count ? [`${count} video style${count === 1 ? "" : "s"} (LoRAs)`] : [])]; },
    busy: () => {
      const state = videoGen.status().state;
      if (state === "running" || state === "building") return "A video clip is being made right now.";
      return activeJobFor((kind) => kind.startsWith("video")) ? "A video clip is waiting or being made right now." : null;
    },
  });
  units.push({
    id: STACK_VIDEO_LTX25_MODEL_ID, label: partLabel(STACK_VIDEO_LTX25_MODEL_ID), summary: partDef(STACK_VIDEO_LTX25_MODEL_ID)!.description, group: "video", role: "video", pins: STACK_VIDEO_LTX25_MODELS, envs: [envLtx25], tiers: ["p128"], licenceNotice: LTX_LICENCE_NOTICE,
    platformBlock: () => videoAvailability().code === "unsupported" ? videoAvailability().reason : null,
    usedBy: () => ["LTX-2.5 videos with sound in chat and the Video app"],
    busy: () => {
      const state = videoGen.status().state;
      if (state === "running" || state === "building") return "A video clip is being made right now.";
      return activeJobFor((kind) => kind.startsWith("video")) ? "A video clip is waiting or being made right now." : null;
    },
  });
  units.push({ id: STACK_VIDEO_H3_MODEL_ID, label: partLabel(STACK_VIDEO_H3_MODEL_ID), summary: partDef(STACK_VIDEO_H3_MODEL_ID)!.description, group: "video", role: "video", pins: [STACK_VIDEO_H3_MODEL], envs: [], tiers: ["p16", "p32", "p64", "p128"], licenceNotice: H3_VIDEO_LICENSE_NOTICE, usedBy: () => ["Videos with sound in chat and the Video app"], busy: () => activeJobFor((kind) => kind.startsWith("video")) ? "A video clip is waiting or being made right now." : null });
  units.push({
    id: STACK_VIDEO_LTX25_MAX_MODEL_ID, label: partLabel(STACK_VIDEO_LTX25_MAX_MODEL_ID), summary: partDef(STACK_VIDEO_LTX25_MAX_MODEL_ID)!.description, group: "video", role: "video", pins: STACK_VIDEO_LTX25_MAX_MODELS, envs: [envLtx25Max], tiers: ["p128"], licenceNotice: LTX_LICENCE_NOTICE,
    platformBlock: () => videoAvailability().code === "unsupported" ? videoAvailability().reason : null,
    usedBy: () => ["LTX-2.5 Max videos with sound in chat and the Video app"],
    busy: () => {
      const state = videoGen.status().state;
      if (state === "running" || state === "building") return "A video clip is being made right now.";
      return activeJobFor((kind) => kind.startsWith("video")) ? "A video clip is waiting or being made right now." : null;
    },
  });
  units.push({ id: STACK_VIDEO_MASK_MODEL_ID, label: partLabel(STACK_VIDEO_MASK_MODEL_ID), summary: partDef(STACK_VIDEO_MASK_MODEL_ID)!.description, group: "video", role: "video", pins: STACK_VIDEO_MASK_MODELS, envs: [envMask], tiers: ["p64", "p128"], platformBlock: () => maskRequirementsFileFor() ? null : `SAM 2.1 masks are not available on ${process.platform} ${process.arch} yet.`, usedBy: () => ["Cutouts and background removal on clips", "Still-picture masks on image edits"], busy: () => activeJobFor((kind, input) => kind === "media.edit" && JSON.stringify(input ?? {}).includes('"cutout"')) ? "A clip cutout is running right now." : null });
  units.push({ id: "htdemucs", label: partLabel("htdemucs"), summary: partDef("htdemucs")!.description, group: "stems", role: "music", pins: [STACK_STEMS_MODELS[0]!], envs: [envStems], usedBy: () => ["Stem splitting in chat"], busy: () => activeJobFor((kind) => kind === "stems_generation") ? "A song is being split right now." : null });
  units.push({ id: "htdemucs-ft", label: partLabel("htdemucs-ft"), summary: partDef("htdemucs-ft")!.description, group: "stems", role: "music", pins: [STACK_STEMS_MODELS[1]!], envs: [envStems], usedBy: () => ["Stem splitting in chat"], busy: () => activeJobFor((kind) => kind === "stems_generation") ? "A song is being split right now." : null });
  units.push({ id: "mms-fa-align", label: partLabel("mms-fa-align"), summary: partDef("mms-fa-align")!.description, group: "stems", role: "music", pins: STACK_ALIGN_MODELS, envs: [envAlign], usedBy: () => ["Word-by-word lyrics on a song card"], busy: () => activeJobFor((kind) => kind === "align_generation") ? "A song's lyrics are being timed right now." : null });
  units.push({ id: "beats-analysis", label: partLabel("beats-analysis"), summary: partDef("beats-analysis")!.description, group: "stems", role: "music", pins: [], envs: [envBeats], usedBy: () => ["Cut to the beat in a video edit"], busy: () => activeJobFor((kind) => kind === BEATS_JOB_KIND) ? "A song is being analysed for its beats right now." : null });
  units.push({ id: "soulx-singer-svc", label: partLabel("soulx-singer-svc"), summary: partDef("soulx-singer-svc")!.description, group: "stems", role: "music", pins: STACK_MODELS.filter((pin) => pin.component === "voice-convert"), envs: [envVoiceConvert], usedBy: () => ["Voice conversion in music remix"], busy: () => activeJobFor((kind) => kind === "voice_convert_generation") ? "A vocal is being converted right now." : null });
  units.push({ id: "mossformer2-se-48k", label: partLabel("mossformer2-se-48k"), summary: partDef("mossformer2-se-48k")!.description, group: "voice", role: "tts", pins: STACK_MODELS.filter((pin) => pin.id === "mossformer2-se-48k"), envs: [], usedBy: () => ["Clean up speech audio"] , busy: () => null });
  units.push({ id: "fish-audio-drama-3-4bit", label: partLabel("fish-audio-drama-3-4bit"), summary: partDef("fish-audio-drama-3-4bit")!.description, group: "voice", role: "tts", pins: STACK_RECORDED_SPEECH_MODELS, envs: [envRecordedSpeech], tiers: ["p64", "p128"], platformBlock: () => recordedSpeech.depsAvailable ? null : "Recorded speech is available on macOS with Apple silicon.", usedBy: () => ["Recorded speech jobs in Home"], busy: () => activeJobFor((kind) => kind === "recorded_speech_generation") ? "A recorded speech job is waiting or rendering right now." : null });
  units.push({ id: "htdemucs-6s", label: partLabel("htdemucs-6s"), summary: partDef("htdemucs-6s")!.description, group: "stems", role: "music", pins: [STACK_STEMS_MODELS[2]!], envs: [envStems], usedBy: () => ["Stem splitting in chat"], busy: () => activeJobFor((kind) => kind === "stems_generation") ? "A song is being split right now." : null });
  units.push({
    id: STACK_MUSIC_MODELS[0]!.id, label: partLabel(STACK_MUSIC_MODELS[0]!.id), summary: partDef(STACK_MUSIC_MODELS[0]!.id)!.description, group: "music", role: "music", pins: STACK_MUSIC_MODELS, envs: [envMusic], tiers: ["p64", "p128"],
    platformBlock: () => musicAvailability().code === "unsupported" ? musicAvailability().reason : null,
    usedBy: () => ["Songs in chat"],
    busy: () => {
      const state = musicGen.status().state;
      if (state === "running" || state === "building") return "A song is being made right now.";
      return activeJobFor((kind) => kind.startsWith("music")) ? "A song is waiting or being made right now." : null;
    },
  });
  units.push({
    id: STACK_SFX_MODELS[0]!.id, label: partLabel(STACK_SFX_MODELS[0]!.id), summary: partDef(STACK_SFX_MODELS[0]!.id)!.description, group: "music", role: "music", pins: STACK_SFX_MODELS, envs: [envSfx], tiers: ["p32", "p64", "p128"], licenceNotice: SFX_LICENCE_NOTICE,
    platformBlock: () => sfxTierAvailability().code === "unsupported" ? sfxTierAvailability().reason : null,
    usedBy: () => ["Sound effects in the Music app and chat"],
    busy: () => {
      const state = sfxGen.status().state;
      if (state === "running" || state === "building") return "A sound is being made right now.";
      return activeJobFor((kind) => kind === SOUND_JOB_KIND) ? "A sound is waiting or being made right now." : null;
    },
  });
  units.push({ id: "score-gen", label: partLabel("score-gen"), summary: partDef("score-gen")!.description, group: "music", role: "music", pins: [], envs: [envScore], tiers: ["p16", "p32", "p64", "p128"], platformBlock: () => scoreRequirementsFileFor() ? null : `Score transcription is not available on ${process.platform} ${process.arch} yet.`, usedBy: () => ["Audio score transcription"], busy: () => activeJobFor((kind) => kind === SCORE_JOB_KIND) ? "A score is waiting or being made right now." : null });
  units.push({ id: STACK_MUSIC_WHISPER.id, label: partLabel(STACK_MUSIC_WHISPER.id), summary: partDef(STACK_MUSIC_WHISPER.id)!.description, group: "music", role: "music", pins: [STACK_MUSIC_WHISPER], envs: [envMusic], tiers: ["p64", "p128"], usedBy: () => ["Checking words in finished songs"], busy: () => activeJobFor((kind) => kind === "music_generation") ? "A song is being made right now." : null });
  units.push({
    id: STACK_MUSIC_XL_ID, label: partLabel(STACK_MUSIC_XL_ID), summary: partDef(STACK_MUSIC_XL_ID)!.description, group: "music", role: "music", pins: STACK_MUSIC_XL_MODELS, envs: [envMusic], tiers: ["p128"],
    platformBlock: () => musicAvailability().code === "unsupported" ? musicAvailability().reason : null,
    usedBy: () => ["Boost songs in chat"],
    busy: () => {
      const state = musicGen.status().state;
      if (state === "running" || state === "building") return "A song is being made right now.";
      return activeJobFor((kind) => kind.startsWith("music")) ? "A song is waiting or being made right now." : null;
    },
  });
  units.push({
    id: STACK_MUSIC_SFT_ID, label: partLabel(STACK_MUSIC_SFT_ID), summary: partDef(STACK_MUSIC_SFT_ID)!.description, group: "music", role: "music", pins: STACK_MUSIC_MAX_MODELS, envs: [envMusic], tiers: ["p128"],
    platformBlock: () => musicAvailability().code === "unsupported" ? musicAvailability().reason : null,
    usedBy: () => ["Max songs in chat"],
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
  superseded_by: string[];
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
  /** The licence the part ships under, when it is one a person should see before installing (ffmpeg: GPL 3 or later); null otherwise. */
  licence_name: string | null;
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
  if (unit.alwaysRequired) return { requirement: "required", reason: unit.alwaysRequired };
  const primary = unit.pins[0];
  if (unit.id === "htdemucs" && tier && TIER_RANK[tier] < TIER_RANK.p64) return { requirement: "unsupported", reason: "Stem splitting needs a computer with 64 GB of memory or more." };
  const profile = (primary?.sizing as { profile?: string } | undefined)?.profile as Tier | undefined;
  const tooBig = tier && ((unit.tiers && !unit.tiers.includes(tier)) || (!unit.tiers && profile && TIER_RANK[profile] > TIER_RANK[tier]));
  if (tooBig) return { requirement: "unsupported", reason: unit.group === "video" ? "Video needs a computer with 128 GB of memory." : unit.id === "htdemucs" ? "Stem splitting needs a computer with 64 GB of memory or more." : unit.group === "music" ? "Music needs a computer with 64 GB of memory or more." : unit.tiers ? "This needs a computer with more memory than this one." : "This model needs more memory than this computer has." };
  if (primary && planned.has(primary.id)) return { requirement: "required", reason: "Home installs this on a computer of this size." };
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
      superseded_by: unit.pins.flatMap((pin) => pin.superseded_by ?? []),
      size_bytes: present ? unitDiskBytes(unit, defs) : null, download_bytes: remaining, full_bytes: totals ? totals.download_bytes : totalDownload(unit), required_free_bytes: requiredFree, plan_need: row ? row.need : null,
      requirement, requirement_reason: reason, last_used_at: lastUsedOf([unit.id, ...unit.pins.map((pin) => pin.id)]), used_by: unit.usedBy(), depends_on: [], licence_name: unit.licenceName ?? null,
      job: job?.id ?? null, percent: job ? job.percent : null, failure: state === "failed" ? failure : null,
      licence: unit.licenceNotice ? { ...unit.licenceNotice, accepted_at: licenceAcceptance(unit.licenceNotice.id)?.accepted_at ?? null } : null,
      can_install: installBlock === null, install_block: installBlock,
      can_uninstall: present && !guard && !job, uninstall_block: !present ? "It is not installed." : job ? "It is still installing." : guard?.message ?? null,
    };
  });
  // The household's LoRA files: removable items, never installable here (they are added from the Pictures and Video pages).
  const loraView = (kindLabel: "picture" | "video", id: string, name: string, bytes: number, lastBase: string, group: ComponentGroup): ComponentView => ({
    id: `lora.${kindLabel}.${id}`, label: `Style: ${name}`, summary: `A ${kindLabel} style (LoRA) the household added.`, group: "loras", kind: "lora", superseded_by: [], state: "installed",
    size_bytes: bytes, download_bytes: 0, full_bytes: bytes, required_free_bytes: 0, plan_need: null, requirement: "optional", requirement_reason: null, last_used_at: null, used_by: [group === "pictures" ? "Pictures" : "The Video app"], depends_on: [lastBase], licence_name: null,
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
  const modelIds = unit.pins.filter((pin) => !!getModel(pin.id)).map((pin) => pin.id);
  for (const pin of unit.pins) {
    const hub = pin.download?.hub_file && pin.repo && pin.revision;
    if (hub) freed += releaseHfFile(pin.repo!, pin.revision!, pin.download!.hub_file!);
  }
  removeModelsAtomically(modelIds);
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

registerPartUnits(componentDefs);
