// The video role's state, install pieces and LoRA library (VIDEO-GEN-01,
// VIDEO-GEN-03). The clips themselves are POST /v1/videos/generations. Home
// enables its video control from GET /stack/v1/video, installs the pieces it
// lists (the engine build through POST /stack/v1/engines/video-gen/install,
// the pinned models through POST /stack/v1/models), and manages the household
// LoRA library here. Who may use which LoRA is Home's rule; this route stores
// the facts (hash, licence, base model, classification) and refuses a file
// that cannot work or must not be added.
import { engineIdleMs } from "@/lib/engineIdle";
import { createRoute, z } from "@hono/zod-openapi";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { dataDir } from "@/lib/paths";
import { installedEnginePin } from "@/lib/engineCatalog";
import { listModels } from "@/lib/modelStore";
import { videoInstallModels, videoLtx25InstallModels, videoLtx25MaxInstallModels } from "@/lib/installPlan";
import { modelView } from "@/routes/models";
import { LORA_INSTALL_SITES, startVideoLoraInstall } from "@/video/loraInstall";
import { importLora, listLoras, LORA_BASE_MODEL, LORA_BASE_MODELS, LORA_CLASSES, LoraError, MAX_LORA_BYTES, MAX_LORAS_PER_JOB, MAX_LORA_STRENGTH, removeLora, updateLora, isLoraId } from "@/video/loras";
import { LTX_LICENCE_NOTICE } from "@/lib/modelCatalog";
import { ltx25EnvironmentReady, ltx25LoraProfile, LTX25_UNFUSED_ADMIT_FACTOR, LTX25_DEFAULT_SIZE, LTX25_MEASURED, LTX25_STANDARD_5S_PEAK_BYTES, LTX25_STANDARD_5S_PICTURE_PEAK_BYTES, LTX25_FPS } from "@/video/ltx25";
import { ltx25EditAdmitBytes, ltx25EditPeakBytes, ltx25MaxEditSupported, LTX25_EDIT_EXTEND_MAX_SECONDS, LTX25_EDIT_EXTEND_MIN_SECONDS, LTX25_EDIT_MAX_SOURCE_FRAMES, LTX25_EDIT_MIN_SOURCE_FRAMES, LTX25_EDIT_RETAKE_MAX_SECONDS, LTX25_EDIT_RETAKE_MIN_SECONDS, LTX25_MAX_EDIT_MEASURED } from "@/video/ltx25Edit";
import { LTX25_GEN_NAME, LTX25_GEN_VERSION, LTX25_MAX_GEN_NAME, LTX25_MAX_GEN_VERSION, LTX25_MAX_MEASURED, ltx25MaxEnvironmentReady, ltx25MaxPeakBytes, LTX25_MAX_PICTURE_PEAK_MEASURED_BYTES } from "@/video/ltx25";
import { memoryVerdict, tierAvailability, videoGen, VIDEO_SPECS, VIDEO_DEFAULT_SIZE, VIDEO_FPS, VIDEO_GEN_NAME, VIDEO_GEN_VERSION, VIDEO_MAX_FRAMES, VIDEO_MAX_PIXELS, VIDEO_MAX_PROMPT_CHARS, VIDEO_MAX_REFERENCE_BYTES, VIDEO_MAX_SECONDS, VIDEO_MIN_SIDE, VIDEO_PEAK_BYTES, VIDEO_QUEUE_MAX, VIDEO_SIZE_STEP, videoGenEnvironmentReady, videoGenSourceInstalled } from "@/video/videoGen";

const PlanModelSchema = z.object({
  id: z.string(), role: z.string(), repo: z.string().optional(), url: z.string(), sha256: z.string(), approx_bytes: z.number().int(), licence: z.string(), revision: z.string(),
  engine: z.string().optional(), archive: z.boolean().optional(), hub_file: z.string().optional(), component: z.string().optional(), starter: z.boolean(), installed: z.boolean(),
});
const LoraSchema = z.object({
  id: z.string(), name: z.string(), file: z.string(), sha256: z.string(), bytes: z.number().int(), rank: z.number().int(), modules: z.number().int(), base_model: z.enum(LORA_BASE_MODELS).openapi({ description: "The video model the LoRA was made for. `ltx-2.3` is retained for old records, but new styles for that retired model are refused." }),
  licence: z.string(), licence_class: z.enum(["free", "acknowledged"]), source_url: z.string().nullable(),
  classification: z.enum(LORA_CLASSES), classification_note: z.string().nullable(), strength_default: z.number(), trigger_words: z.array(z.string()), added_by: z.string().nullable(), added_at: z.string(),
});
const ErrorBody = z.object({ error: z.string(), code: z.string().optional() });
const QualitySchema = z.object({
  id: z.string(), installed: z.boolean(), available: z.boolean(), audio: z.boolean(), image_to_video: z.boolean().openapi({ description: "A picture can start a clip of this model." }),
  end_image: z.boolean().openapi({ description: "A second picture can end the clip (`end_image` on the generation request; start and end together). True only on LTX-2.5 Standard, Boost and Max." }),
  limits: z.record(z.string(), z.union([z.number(), z.string()])),
  memory: z.object({ fits: z.boolean(), reason: z.string().nullable(), peak_gb: z.number() }),
  install: z.object({ models: z.array(PlanModelSchema), remaining_bytes: z.number().int(), download_bytes: z.number().int() }),
  licence: z.object({ id: z.string(), name: z.string(), url: z.string() }).nullable().openapi({ description: "The model maker's licence. Home shows its summary and an admin accepts it before install." }),
  lora_base_model: z.string(),
});
const Ltx25LorasSchema = z.object({
  supported: z.boolean().openapi({ description: "VIDEO-LORA-05: a clip of this profile may carry LoRAs (`loras` on the request, ids from GET /stack/v1/video/loras whose `base_model` is `ltx-2.5`). Standard and Boost report false until a clip with a LoRA has been measured on their runtime; `reason` says so." }),
  max: z.number().int().openapi({ description: "Most LoRAs on one clip (0 when not supported)." }), max_strength: z.number(),
  mode: z.enum(["fused", "unfused"]).openapi({ description: "How the runtime applies them. Fused changes the weights once when the clip's pipeline is built (Max, bf16: no extra memory and no requantization loss); unfused keeps run-time adapters (needs runtime 0.18.0)." }),
  admit_factor: z.number().openapi({ description: "Extra memory admission reserves per byte of LoRA file: 0 when fused, 1.1 when unfused. The request is admitted at the clip's figure plus file bytes x this." }),
  runtime: z.string(), base_models: z.array(z.string()).openapi({ description: "The LoRA bases this profile takes: `ltx-2.5` only. An LTX-2.3 file is refused here (wrong_base_model) and an LTX file's version cannot be read from its tensors, so Home declares it when adding the file (`base_model` on POST /stack/v1/video/loras, or PATCH)." }),
  reason: z.string().nullable(),
});
const Ltx25QualitySchema = QualitySchema.extend({
  loras: Ltx25LorasSchema,
  negative_prompt: z.enum(["none", "nag"]).openapi({ description: "VIDEO-LORA-05: `none`: the distilled path has no guidance, so `negative_prompt` is accepted and has no effect (the runtime refuses one without NAG). Home sends negative text only to a profile that says `nag`; none does yet." }),
  ready: z.boolean().openapi({ description: "A clip of this model can start now: the tier runs video, the pack is installed and verified, and the runtime environment is built. False while any of those is missing (`installed`, `environment.ready` and `available` say which)." }),
  environment: z.object({ engine: z.string(), version: z.string(), ready: z.boolean() }),
  profiles: z.array(z.object({ name: z.enum(["standard", "boost"]), size: z.string(), width: z.number().int(), height: z.number().int(), max_seconds: z.number().int(), max_frames: z.number().int(), peak_gb: z.number(), short_peak_gb: z.number().nullable(), peak_gb_picture: z.number(), short_peak_gb_picture: z.number().nullable() })).openapi({ description: "The measured table, one row per size the Stack runs (anything else is refused). `peak_gb` is the OS footprint of the longest clip at that size, the figure admission uses; `short_peak_gb` is the 5 s figure where it was measured separately. `peak_gb_picture` and `short_peak_gb_picture` are the same two figures for a clip that starts from a picture, with or without an end picture (VIDEO-PICTURE-ADMIT-01): admission uses them when the request carries `image`. Home maps its Standard and Boost slots to these rows; Max has no row until a run passes the 64 GB cap." }),
});
const EditFootprint = z.object({ peak_gb: z.number(), admit_gb: z.number() });
const Ltx25MaxQualitySchema = Ltx25QualitySchema.extend({
  extend: z.boolean().openapi({ description: "LTX25-EDIT-01: the Max runtime has the extend pipeline (`extend_distilled.py`), so `POST /v1/videos/generations` with `source_video` and `extend_seconds` can run. False when the installed runtime lacks it." }),
  retake: z.boolean().openapi({ description: "LTX25-EDIT-01: the Max runtime has the retake pipeline (`retake.py`), so `source_video` with `retake_from_seconds` can run." }),
  edit: z.object({
    extend_seconds: z.object({ min: z.number(), max: z.number() }), retake_from_seconds: z.object({ min: z.number(), max: z.number() }),
    source: z.object({ min_frames: z.number().int(), max_frames: z.number().int(), fps: z.number().int(), min_size: z.string() }).openapi({ description: "What a source clip may be: frames at 24 a second (a clip at another rate is re-made first), and the smallest size (a larger one is fitted down to the largest `profiles` size inside it)." }),
    profiles: z.array(z.object({ size: z.string(), width: z.number().int(), height: z.number().int(), extend: EditFootprint, retake: EditFootprint })).openapi({ description: "One row per source size the Stack edits, measured with a 10 s source: `peak_gb` is the OS footprint and `admit_gb` what admission reserves (the footprint plus 5 percent), under the 64 GB per-clip cap." }),
  }),
  profiles: z.array(z.object({ name: z.literal("max"), size: z.string(), width: z.number().int(), height: z.number().int(), max_seconds: z.number().int(), max_frames: z.number().int(), peak_gb: z.number(), admit_gb: z.number(), short_peak_gb: z.null(), peak_gb_picture: z.number(), admit_gb_picture: z.number(), short_peak_gb_picture: z.null(), extend: EditFootprint.nullable().openapi({ description: "The extend footprint at this size, or null when an extend was not measured here." }), retake: EditFootprint.nullable().openapi({ description: "The retake footprint at this size, or null when a retake was not measured here." }) })).openapi({ description: "One row: `max`, 1024x576, up to 10 s (241 frames). `peak_gb` is the measured OS footprint of that clip (48.6 GB, `footprint`; the MLX peak reads lower and is not the figure); `admit_gb` is what admission reserves (the measured footprint plus 5 percent headroom), under the 64 GB per-clip cap. `peak_gb_picture` (58.6) and `admit_gb_picture` (61.5, the same 5 percent) are the figures for a clip that starts from a picture, with or without an end picture: the picture encoder adds about 10 GB, and admission uses them when the request carries `image` (VIDEO-PICTURE-ADMIT-01). Home maps its Max slot to this row." }),
});
const StatusSchema = z.object({
  state: z.enum(["unsupported", "off", "not-installed", "needs-setup", "building", "idle", "running"]).openapi({ description: "off: this computer's tier does not run video. not-installed: the model files are missing. needs-setup: installed; the first clip builds the environment (first time only) and starts the worker. idle: the worker is up and waits for the next clip (two minutes unless an admin changes it), then exits. running: a clip is in progress." }),
  phase: z.string().nullable(),
  available: z.boolean(), code: z.string().nullable(), reason: z.string().nullable(), tier: z.string(),
  memory: z.object({ fits: z.boolean(), reason: z.string().nullable(), peak_gb: z.number() }).openapi({ description: "Whether a clip could be admitted next to what is resident now." }),
  model: z.object({ id: z.string(), installed: z.boolean() }),
  limits: z.record(z.string(), z.union([z.number(), z.string()])),
  loras_supported: z.boolean(), lora_count: z.number().int(), audio: z.boolean(),
  negative_prompt: z.string(),
  reference_images: z.object({ generated: z.boolean(), uploaded: z.boolean(), household_photo: z.boolean().optional(), reason: z.string() }),
  worker: z.object({ alive: z.boolean(), idle_exit_seconds: z.number().int() }),
  environment: z.object({ engine: z.string(), version: z.string(), source: z.boolean(), ready: z.boolean() }),
  install: z.object({ models: z.array(PlanModelSchema), remaining_bytes: z.number().int() }).openapi({ description: "The pinned models to pull (POST /stack/v1/models, shaped as an install-plan model) and how many bytes are still to come." }),
  qualities: z.object({ quick: QualitySchema, detailed: QualitySchema.openapi({ description: "Deprecated compatibility entry. The Detailed video model was retired. Use ltx25 or ltx25max." }), ltx25: Ltx25QualitySchema, ltx25max: Ltx25MaxQualitySchema }).openapi({ description: "`quick` is Wan Quick. `detailed` is deprecated and retained for older Home versions; the model was retired. Use `ltx25` (LTX-2.5 Standard and Boost) or `ltx25max` (LTX-2.5 Max)." }),
});
const statusRoute = createRoute({ method: "get", path: "/", tags: ["Video"], summary: "The video role's state, limits, and what to install", responses: { 200: { content: { "application/json": { schema: z.object({ video: StatusSchema }) } }, description: "Additive. Home enables the video control from `available` and `state`." } } });

const listRoute = createRoute({ method: "get", path: "/loras", tags: ["Video"], summary: "The household LoRA library", responses: { 200: { content: { "application/json": { schema: z.object({ loras: z.array(LoraSchema), base_model: z.string(), base_models: z.array(z.string()), max_per_clip: z.number().int() }) } }, description: "Every LoRA with its hash, licence, classification and default strength." } } });
const importForm = z.object({
  file: z.custom<File>((value) => value instanceof File, "The .safetensors file in the `file` field.").openapi({ type: "string", format: "binary" }).optional(),
  path: z.string().optional().openapi({ description: "Instead of `file`: a .safetensors file already on the Stack's own computer." }),
  name: z.string(),
  licence: z.string().openapi({ description: "The licence as the source states it (apache-2.0, mit, cc0-1.0 import freely; any other needs licence_acknowledged)." }),
  licence_acknowledged: z.enum(["true", "false"]).optional(),
  source_url: z.string().optional(),
  classification: z.enum(LORA_CLASSES).optional().openapi({ description: "Default adult-only (uncertain means adult-only). A file whose own metadata names adult content is adult-only whatever is asked." }),
  strength_default: z.coerce.number().min(0).max(MAX_LORA_STRENGTH).optional(),
  trigger_words: z.string().optional().openapi({ description: "Comma separated, or a JSON array." }),
  added_by: z.string().optional().openapi({ description: "An opaque label Home keeps for who added it." }),
  base_model: z.enum(LORA_BASE_MODELS).optional().openapi({ description: "The base the file was made for. Use `ltx-2.5` for LTX-2.5. New files with retired base `ltx-2.3` are refused with wrong_base_model; when omitted, an LTX file must identify itself as LTX-2.5." }),
});
const importRoute = createRoute({ method: "post", path: "/loras", tags: ["Video"], summary: "Add a LoRA to the library", request: { body: { content: { "multipart/form-data": { schema: importForm } } } }, responses: {
  200: { content: { "application/json": { schema: LoraSchema } }, description: "Added; the id is `lora-` and the first 16 hex of the sha256." },
  409: { content: { "application/json": { schema: ErrorBody } }, description: "Already in the library (already_added)." },
  413: { content: { "application/json": { schema: ErrorBody } }, description: "Larger than 2 GB." },
  422: { content: { "application/json": { schema: ErrorBody } }, description: "Not usable: not_safetensors, not_a_lora, wrong_base_model, lora_keys_unsupported (an ltx-2.5 file with no lora_A/lora_B tensors the runtime reads, such as a kohya file), licence_acknowledgement_required, lora_refused (a minor in a sexual context: never allowed), bad_name, bad_strength." },
} });
const installBody = z.object({
  source: z.enum(LORA_INSTALL_SITES).openapi({ description: "Which site the file comes from. The address must belong to it: a Hugging Face file link (resolve or blob) or `https://civitai.com/api/download/models/<version id>`; any other host is refused (host_not_allowed)." }),
  url: z.string().max(2048),
  name: z.string(),
  licence: z.string().openapi({ description: "The licence as the source states it (the same rule as POST /loras)." }),
  licence_acknowledged: z.boolean().optional(),
  audience: z.enum(["all-ages", "adult"]).optional().openapi({ description: "Home's decision. Default adult (uncertain means adult-only); a file whose own metadata names adult content is adult-only whatever is asked. Stored as the record's classification." }),
  strength_default: z.number().min(0).max(MAX_LORA_STRENGTH).optional(),
  trigger_words: z.array(z.string()).optional(),
  added_by: z.string().optional(),
  base_model: z.enum(LORA_BASE_MODELS).optional().openapi({ description: "What the source says the file was made for; the tensors still decide the family (wrong_base_model on a conflict)." }),
  sha256_expected: z.string().optional().openapi({ description: "The source's published sha256. Checked on the bytes received (hash_mismatch); when a library record already has that hash, no download starts (409 duplicate_lora with existing_id)." }),
  token: z.string().max(512).optional().openapi({ description: "The admin's key or token for that site. Used for one call, only sent to the site's own host (never to a CDN or another host a redirect names), never stored, logged, or shown in the job." }),
  source_url: z.string().max(2000).optional().openapi({ description: "The page the admin chose, kept on the record. Never put a token in it." }),
});
const installRoute = createRoute({ method: "post", path: "/loras/install", tags: ["Video"], summary: "Download a LoRA from Hugging Face or Civitai into the library (video.lora.install job)", request: { body: { content: { "application/json": { schema: installBody } } } }, responses: {
  202: { content: { "application/json": { schema: z.object({ job: z.string() }) } }, description: "A `video.lora.install` job started (`GET /stack/v1/jobs/{id}`). It reports bytes only and is named \"a style\". Done: `result.lora` is the library record. Failed: `reason` is `code: sentence` and `result` is `{ code, existing_id? }`; codes: host_not_allowed, token_needed, token_refused, source_missing, source_busy, too_large, hash_mismatch, not_safetensors, download_cut_short, download_failed, duplicate_lora, plus the POST /loras codes (wrong_base_model, lora_keys_unsupported, lora_refused, licence_acknowledgement_required)." },
  409: { content: { "application/json": { schema: z.object({ error: z.string(), code: z.string(), existing_id: z.string().optional() }) } }, description: "duplicate_lora: a library record already has the expected hash; nothing was downloaded." },
  422: { content: { "application/json": { schema: ErrorBody } }, description: "The request cannot be used: bad_url, host_not_allowed, bad_source, bad_hash, bad_classification." },
  503: { content: { "application/json": { schema: ErrorBody } }, description: "install_busy: one download at a time." },
} });
const patchRoute = createRoute({ method: "patch", path: "/loras/{id}", tags: ["Video"], summary: "Edit a LoRA's name, class, default strength or trigger words", request: { params: z.object({ id: z.string() }), body: { content: { "application/json": { schema: z.object({ name: z.string().optional(), classification: z.enum(LORA_CLASSES).optional(), strength_default: z.number().min(0).max(MAX_LORA_STRENGTH).optional(), trigger_words: z.array(z.string()).optional(), source_url: z.string().nullable().optional(), base_model: z.enum(LORA_BASE_MODELS).optional().openapi({ description: "Moves an LTX file to `ltx-2.5`. The retired `ltx-2.3` base is recognized for old records but refused for edits." }) }) } } } }, responses: {
  200: { content: { "application/json": { schema: LoraSchema } }, description: "Updated." },
  404: { content: { "application/json": { schema: ErrorBody } }, description: "No such LoRA." },
  409: { content: { "application/json": { schema: ErrorBody } }, description: "classification_locked: the file's own description names adult content, so it cannot be all-ages." },
  422: { content: { "application/json": { schema: ErrorBody } }, description: "A value is out of range." },
} });
const removeRoute = createRoute({ method: "delete", path: "/loras/{id}", tags: ["Video"], summary: "Remove a LoRA and its file", request: { params: z.object({ id: z.string() }) }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Removed." }, 404: { content: { "application/json": { schema: ErrorBody } }, description: "No such LoRA." } } });

export const videoRoutes = apiRouter<AppEnv>();

type PlanModel = ReturnType<typeof videoInstallModels>[number];
function qualityView(quality: "quick" | "ltx25" | "ltx25max", models: PlanModel[], _installed: string[], available: boolean) {
  const spec = VIDEO_SPECS[quality];
  const verdict = memoryVerdict(quality);
  const remaining = models.filter((model) => !model.installed).reduce((sum, model) => sum + model.approx_bytes, 0);
  return {
    id: spec.modelId, installed: models.every((model) => model.installed), available, audio: spec.audio, image_to_video: spec.imageToVideo, end_image: spec.endImage,
    limits: { max_seconds: available ? spec.maxSeconds : 0, fps: VIDEO_FPS, default_size: spec.defaultSize, max_pixels: spec.maxPixels, size_step: spec.sizeStep, min_side: spec.minSide, max_frames: spec.maxSeconds * VIDEO_FPS + 1 },
    memory: { fits: verdict.ok, reason: verdict.ok ? null : verdict.reason, peak_gb: Math.round(spec.peakBytes / 1e8) / 10 },
    install: { models, remaining_bytes: remaining, download_bytes: models.reduce((sum, model) => sum + model.approx_bytes, 0) },
    licence: quality === "ltx25" || quality === "ltx25max" ? { id: LTX_LICENCE_NOTICE.id, name: LTX_LICENCE_NOTICE.name, url: LTX_LICENCE_NOTICE.url } : null,
    lora_base_model: spec.loraBase,
  };
}

/** `qualities.<ltx25|ltx25max>.loras`: what Home may send and what admission will add. */
function ltx25LorasView(quality: "ltx25" | "ltx25max") {
  const profile = ltx25LoraProfile(quality);
  return { supported: profile.supported, max: profile.max, max_strength: profile.max_strength, mode: profile.mode, admit_factor: profile.mode === "unfused" ? LTX25_UNFUSED_ADMIT_FACTOR : 0, runtime: profile.runtime, base_models: profile.base_models, reason: profile.reason };
}

function ltx25View(models: PlanModel[], installed: string[], available: boolean) {
  const base = qualityView("ltx25", models, installed, available);
  const pin = installedEnginePin(LTX25_GEN_NAME);
  const environment = { engine: pin ? `${pin.name} ${pin.tag}` : LTX25_GEN_NAME, version: LTX25_GEN_VERSION, ready: ltx25EnvironmentReady() };
  return {
    ...base,
    loras: ltx25LorasView("ltx25"), negative_prompt: "none" as const,
    limits: { ...base.limits, default_size: LTX25_DEFAULT_SIZE, size_step: 32 },
    ready: available && base.installed && environment.ready,
    environment,
    profiles: LTX25_MEASURED.map((row) => ({ name: row.profile, size: row.size, width: row.width, height: row.height, max_seconds: available ? row.maxSeconds : 0, max_frames: row.maxSeconds * LTX25_FPS + 1, peak_gb: Math.round(row.peakBytes / 1e8) / 10, short_peak_gb: row.size === "512x256" ? Math.round(LTX25_STANDARD_5S_PEAK_BYTES / 1e8) / 10 : null, peak_gb_picture: Math.round(row.picturePeakBytes / 1e8) / 10, short_peak_gb_picture: row.size === "512x256" ? Math.round(LTX25_STANDARD_5S_PICTURE_PEAK_BYTES / 1e8) / 10 : null })),
  };
}

/** The measured footprint and the admitted one (footprint plus 5 percent) of an extend or a retake at a size, in GB. */
function editFootprint(kind: "extend" | "retake", size: string): { peak_gb: number; admit_gb: number } {
  const row = LTX25_MAX_EDIT_MEASURED.find((item) => item.size === size)!;
  return { peak_gb: Math.round(ltx25EditPeakBytes(row, kind) / 1e8) / 10, admit_gb: Math.round(ltx25EditAdmitBytes(kind, size) / 1e8) / 10 };
}

function ltx25MaxView(models: PlanModel[], installed: string[], available: boolean) {
  const base = qualityView("ltx25max", models, installed, available);
  const pin = installedEnginePin(LTX25_MAX_GEN_NAME);
  const environment = { engine: pin ? `${pin.name} ${pin.tag}` : LTX25_MAX_GEN_NAME, version: LTX25_MAX_GEN_VERSION, ready: ltx25MaxEnvironmentReady() };
  return {
    ...base,
    loras: ltx25LorasView("ltx25max"), negative_prompt: "none" as const,
    limits: { ...base.limits, default_size: LTX25_MAX_MEASURED[0]!.size, size_step: 64 },
    ready: available && base.installed && environment.ready,
    environment,
    extend: ltx25MaxEditSupported(),
    retake: ltx25MaxEditSupported(),
    edit: {
      extend_seconds: { min: LTX25_EDIT_EXTEND_MIN_SECONDS, max: LTX25_EDIT_EXTEND_MAX_SECONDS }, retake_from_seconds: { min: LTX25_EDIT_RETAKE_MIN_SECONDS, max: LTX25_EDIT_RETAKE_MAX_SECONDS },
      source: { min_frames: LTX25_EDIT_MIN_SOURCE_FRAMES, max_frames: LTX25_EDIT_MAX_SOURCE_FRAMES, fps: LTX25_FPS, min_size: [...LTX25_MAX_EDIT_MEASURED].sort((a, b) => a.width * a.height - b.width * b.height)[0]!.size },
      profiles: LTX25_MAX_EDIT_MEASURED.map((row) => ({ size: row.size, width: row.width, height: row.height, extend: editFootprint("extend", row.size), retake: editFootprint("retake", row.size) })),
    },
    profiles: LTX25_MAX_MEASURED.map((row) => ({ name: row.profile, size: row.size, width: row.width, height: row.height, max_seconds: available ? row.maxSeconds : 0, max_frames: row.maxSeconds * LTX25_FPS + 1, peak_gb: Math.round(row.peakBytes / 1e8) / 10, admit_gb: Math.round(VIDEO_SPECS.ltx25max.peakBytes / 1e8) / 10, short_peak_gb: null, peak_gb_picture: Math.round(LTX25_MAX_PICTURE_PEAK_MEASURED_BYTES / 1e8) / 10, admit_gb_picture: Math.round(ltx25MaxPeakBytes(true) / 1e8) / 10, short_peak_gb_picture: null, extend: LTX25_MAX_EDIT_MEASURED.some((edit) => edit.size === row.size) ? editFootprint("extend", row.size) : null, retake: LTX25_MAX_EDIT_MEASURED.some((edit) => edit.size === row.size) ? editFootprint("retake", row.size) : null })),
  };
}

videoRoutes.openapi(statusRoute, (c) => {
  const availability = tierAvailability();
  const status = videoGen.status();
  const installed = listModels().map(modelView).filter((model) => model.state === "installed").map((model) => model.id);
  const models = videoInstallModels(installed);
  const verdict = memoryVerdict();
  const pin = installedEnginePin(VIDEO_GEN_NAME);
  return c.json({ video: {
    state: status.state, phase: status.phase, available: availability.available, code: availability.code, reason: availability.reason, tier: availability.tier,
    memory: { fits: verdict.ok, reason: verdict.ok ? null : verdict.reason, peak_gb: Math.round(VIDEO_PEAK_BYTES / 1e8) / 10 },
    model: { id: models.find((model) => !model.component)?.id ?? "", installed: models.every((model) => model.installed) },
    limits: { max_seconds: availability.available ? VIDEO_MAX_SECONDS : 0, fps: VIDEO_FPS, default_size: VIDEO_DEFAULT_SIZE, max_pixels: VIDEO_MAX_PIXELS, size_step: VIDEO_SIZE_STEP, min_side: VIDEO_MIN_SIDE, max_frames: VIDEO_MAX_FRAMES, max_loras: MAX_LORAS_PER_JOB, max_lora_strength: MAX_LORA_STRENGTH, max_prompt_chars: VIDEO_MAX_PROMPT_CHARS, max_reference_image_mb: VIDEO_MAX_REFERENCE_BYTES / 1024 / 1024, queue_max: VIDEO_QUEUE_MAX },
    loras_supported: true, lora_count: listLoras().length, audio: false,
    negative_prompt: "accepted, no effect: the distilled model runs without guidance",
    reference_images: { generated: true, uploaded: true, household_photo: true, reason: "Any picture can start a clip. The Stack does not judge where it came from; the caller decides who may ask." },
    worker: { alive: videoGen.workerAlive, idle_exit_seconds: Math.round(engineIdleMs("video") / 1000) },
    environment: { engine: pin ? `${pin.name} ${pin.tag}` : VIDEO_GEN_NAME, version: VIDEO_GEN_VERSION, source: videoGenSourceInstalled(), ready: videoGenEnvironmentReady() },
    install: { models, remaining_bytes: models.filter((model) => !model.installed).reduce((sum, model) => sum + model.approx_bytes, 0) },
    qualities: {
      quick: qualityView("quick", models, installed, availability.available),
      detailed: { id: "ltx-2-3-distilled-mlx", installed: false, available: false, audio: true, image_to_video: false, end_image: false, reason: "The Detailed video model was retired. Use ltx25 or ltx25max.", limits: { max_seconds: 0, fps: VIDEO_FPS, default_size: "768x448", max_pixels: 768 * 448, size_step: 64, min_side: 256, max_frames: 0 }, memory: { fits: false, reason: "The Detailed video model was retired.", peak_gb: 0 }, install: { models: [], remaining_bytes: 0, download_bytes: 0 }, licence: null, lora_base_model: "ltx-2.3" },
      ltx25: ltx25View(videoLtx25InstallModels(installed), installed, availability.available),
      ltx25max: ltx25MaxView(videoLtx25MaxInstallModels(installed), installed, availability.available),
    },
  } }, 200 as const);
});

videoRoutes.openapi(listRoute, (c) => c.json({ loras: listLoras(), base_model: LORA_BASE_MODEL, base_models: [...LORA_BASE_MODELS], max_per_clip: MAX_LORAS_PER_JOB }, 200));

function triggerWords(value: string | undefined): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) { try { const parsed = JSON.parse(trimmed); if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string"); } catch { /* fall through to commas */ } }
  return trimmed.split(",");
}

videoRoutes.openapi(importRoute, async (c) => {
  const form = c.req.valid("form");
  const staging = join(dataDir, "tmp", "video-lora");
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  let source: string;
  let temp: string | null = null;
  try {
    if (form.file) {
      if (form.file.size > MAX_LORA_BYTES) return c.json({ error: `That file is larger than ${MAX_LORA_BYTES / 1_073_741_824} GB, the most a LoRA can be here.`, code: "too_large" }, 413);
      temp = join(staging, `${crypto.randomUUID()}.safetensors`);
      await Bun.write(temp, form.file);
      source = temp;
    } else if (form.path) {
      if (!form.path.startsWith("/") || !existsSync(form.path) || !statSync(form.path).isFile()) return c.json({ error: "That path is not a file on this computer.", code: "not_safetensors" }, 422);
      source = form.path;
    } else return c.json({ error: "Send the LoRA as the `file` field.", code: "not_safetensors" }, 422);
    const record = await importLora({ path: source, name: form.name, licence: form.licence, licenceAcknowledged: form.licence_acknowledged === "true", sourceUrl: form.source_url ?? null, classification: form.classification, strengthDefault: form.strength_default, triggerWords: triggerWords(form.trigger_words), addedBy: form.added_by ?? null, declaredBase: form.base_model ?? null });
    return c.json(record, 200);
  } catch (error) {
    if (error instanceof LoraError) return c.json({ error: error.message, code: error.code }, error.status as 409 | 413 | 422);
    throw error;
  } finally { if (temp) rmSync(temp, { force: true }); }
});

videoRoutes.openapi(installRoute, (c) => {
  const body = c.req.valid("json");
  try {
    const job = startVideoLoraInstall({ site: body.source, url: body.url, name: body.name, licence: body.licence, licenceAcknowledged: body.licence_acknowledged, classification: body.audience === undefined ? undefined : body.audience === "adult" ? "adult-only" : "all-ages", strengthDefault: body.strength_default, triggerWords: body.trigger_words, addedBy: body.added_by ?? null, baseModel: body.base_model ?? null, sha256Expected: body.sha256_expected ?? null, token: body.token ?? null, sourceUrl: body.source_url ?? null });
    return c.json({ job: job.id }, 202);
  } catch (error) {
    if (error instanceof LoraError) {
      const existing = (error as { existingId?: string }).existingId;
      if (error.status === 409) return c.json({ error: error.message, code: error.code, ...(existing ? { existing_id: existing } : {}) }, 409);
      if (error.status === 503) return c.json({ error: error.message, code: error.code }, 503);
      return c.json({ error: error.message, code: error.code }, 422);
    }
    throw error;
  }
});

videoRoutes.openapi(patchRoute, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  if (!isLoraId(id)) return c.json({ error: "No such LoRA in the library.", code: "unknown_lora" }, 404);
  try {
    return c.json(await updateLora(id, { name: body.name, classification: body.classification, strengthDefault: body.strength_default, triggerWords: body.trigger_words, sourceUrl: body.source_url, baseModel: body.base_model }), 200);
  } catch (error) {
    if (error instanceof LoraError) return c.json({ error: error.message, code: error.code }, error.status as 404 | 409 | 422);
    throw error;
  }
});

videoRoutes.openapi(removeRoute, async (c) => {
  const { id } = c.req.valid("param");
  return isLoraId(id) && await removeLora(id) ? c.json({ ok: true as const }, 200) : c.json({ error: "No such LoRA in the library.", code: "unknown_lora" }, 404);
});

