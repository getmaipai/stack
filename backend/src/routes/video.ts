// The video role's state, install pieces and LoRA library (VIDEO-GEN-01,
// VIDEO-GEN-03). The clips themselves are POST /v1/videos/generations. Home
// enables its video control from GET /stack/v1/video, installs the pieces it
// lists (the engine build through POST /stack/v1/engines/video-gen/install,
// the pinned models through POST /stack/v1/models), and manages the household
// LoRA library here. Who may use which LoRA is Home's rule; this route stores
// the facts (hash, licence, base model, classification) and refuses a file
// that cannot work or must not be added.
import { createRoute, z } from "@hono/zod-openapi";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { dataDir } from "@/lib/paths";
import { installedEnginePin } from "@/lib/engineCatalog";
import { listModels } from "@/lib/modelStore";
import { videoDetailedInstallModels, videoInstallModels } from "@/lib/installPlan";
import { modelView } from "@/routes/models";
import { importLora, listLoras, LORA_BASE_MODEL, LORA_BASE_MODELS, LORA_CLASSES, LoraError, MAX_LORA_BYTES, MAX_LORAS_PER_JOB, MAX_LORA_STRENGTH, removeLora, updateLora, isLoraId } from "@/video/loras";
import { LTX_LICENCE_NOTICE } from "@/lib/modelCatalog";
import { memoryVerdict, tierAvailability, videoGen, VIDEO_SPECS, VIDEO_DEFAULT_SIZE, VIDEO_FPS, VIDEO_GEN_NAME, VIDEO_GEN_VERSION, VIDEO_MAX_FRAMES, VIDEO_MAX_PIXELS, VIDEO_MAX_PROMPT_CHARS, VIDEO_MAX_REFERENCE_BYTES, VIDEO_MAX_SECONDS, VIDEO_MIN_SIDE, VIDEO_PEAK_BYTES, VIDEO_QUEUE_MAX, VIDEO_SIZE_STEP, videoGenEnvironmentReady, videoGenSourceInstalled } from "@/video/videoGen";

const PlanModelSchema = z.object({
  id: z.string(), role: z.string(), repo: z.string().optional(), url: z.string(), sha256: z.string(), approx_bytes: z.number().int(), licence: z.string(), revision: z.string(),
  engine: z.string().optional(), archive: z.boolean().optional(), hub_file: z.string().optional(), component: z.string().optional(), starter: z.boolean(), installed: z.boolean(),
});
const LoraSchema = z.object({
  id: z.string(), name: z.string(), file: z.string(), sha256: z.string(), bytes: z.number().int(), rank: z.number().int(), modules: z.number().int(), base_model: z.enum(LORA_BASE_MODELS).openapi({ description: "The video model the LoRA was made for, read from its tensors: wan2.2-ti2v-5b is Quick, ltx-2.3 is Detailed. A clip applies only LoRAs of its own model." }),
  licence: z.string(), licence_class: z.enum(["free", "acknowledged"]), source_url: z.string().nullable(),
  classification: z.enum(LORA_CLASSES), classification_note: z.string().nullable(), strength_default: z.number(), trigger_words: z.array(z.string()), added_by: z.string().nullable(), added_at: z.string(), likeness_subject: z.string().nullable().openapi({ description: "The household adult this LoRA looks like (an opaque id Home gave), or null. A LoRA that looks like a person is always adult-only and every request that applies it needs Home's signed proof." }),
});
const ErrorBody = z.object({ error: z.string(), code: z.string().optional() });
const QualitySchema = z.object({
  id: z.string(), installed: z.boolean(), available: z.boolean(), audio: z.boolean(), image_to_video: z.boolean().openapi({ description: "A picture can start a clip of this model (Quick and Detailed both)." }),
  limits: z.record(z.string(), z.union([z.number(), z.string()])),
  memory: z.object({ fits: z.boolean(), reason: z.string().nullable(), peak_gb: z.number() }),
  install: z.object({ models: z.array(PlanModelSchema), remaining_bytes: z.number().int(), download_bytes: z.number().int() }),
  licence: z.object({ id: z.string(), name: z.string(), url: z.string() }).nullable().openapi({ description: "Detailed only: the model licence. Home shows its summary (GET /stack/v1/components, the component's `licence`) and an admin accepts it once before this installs." }),
  lora_base_model: z.string(),
});
const StatusSchema = z.object({
  state: z.enum(["unsupported", "off", "not-installed", "needs-setup", "building", "idle", "running"]).openapi({ description: "off: this computer's tier does not run video. not-installed: the model files are missing. needs-setup: installed; the first clip builds the environment (first time only) and starts the worker. idle: the worker is up and waits ten minutes for the next clip, then exits. running: a clip is in progress." }),
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
  qualities: z.object({ quick: QualitySchema, detailed: QualitySchema }).openapi({ description: "VIDEO-LTX-01: the two models. `quick` is the silent clip (the fields above describe it); `detailed` makes a sound track with speech in the same pass, longer clips, and takes LoRAs made for LTX-2.3. Each lists its own limits, install pieces and whether a clip of it could be admitted now." }),
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
  likeness_subject: z.string().max(200).optional().openapi({ description: "LIKENESS-01: the household adult this style looks like (an opaque id), sent with `likeness_proof`. A file whose description names a real person is refused without both." }),
  likeness_proof: z.string().max(4096).optional().openapi({ description: "Home's signed, short-lived proof (purpose style_import) that the subject is a household adult who agreed." }),
});
const importRoute = createRoute({ method: "post", path: "/loras", tags: ["Video"], summary: "Add a LoRA to the library", request: { body: { content: { "multipart/form-data": { schema: importForm } } } }, responses: {
  200: { content: { "application/json": { schema: LoraSchema } }, description: "Added; the id is `lora-` and the first 16 hex of the sha256." },
  409: { content: { "application/json": { schema: ErrorBody } }, description: "Already in the library (already_added)." },
  413: { content: { "application/json": { schema: ErrorBody } }, description: "Larger than 2 GB." },
  403: { content: { "application/json": { schema: ErrorBody } }, description: "A style that looks like a person was sent without a valid proof from Home: likeness_proof_required, likeness_proof_invalid, likeness_proof_expired, likeness_proof_mismatch, likeness_not_trusted." },
  422: { content: { "application/json": { schema: ErrorBody } }, description: "Not usable: not_safetensors, not_a_lora, wrong_base_model, licence_acknowledgement_required, lora_refused (a minor in a sexual context: never allowed), bad_name, bad_strength." },
} });
const patchRoute = createRoute({ method: "patch", path: "/loras/{id}", tags: ["Video"], summary: "Edit a LoRA's name, class, default strength or trigger words", request: { params: z.object({ id: z.string() }), body: { content: { "application/json": { schema: z.object({ name: z.string().optional(), classification: z.enum(LORA_CLASSES).optional(), strength_default: z.number().min(0).max(MAX_LORA_STRENGTH).optional(), trigger_words: z.array(z.string()).optional(), source_url: z.string().nullable().optional() }) } } } }, responses: {
  200: { content: { "application/json": { schema: LoraSchema } }, description: "Updated." },
  404: { content: { "application/json": { schema: ErrorBody } }, description: "No such LoRA." },
  409: { content: { "application/json": { schema: ErrorBody } }, description: "classification_locked: the file's own description names adult content, so it cannot be all-ages." },
  422: { content: { "application/json": { schema: ErrorBody } }, description: "A value is out of range." },
} });
const removeRoute = createRoute({ method: "delete", path: "/loras/{id}", tags: ["Video"], summary: "Remove a LoRA and its file", request: { params: z.object({ id: z.string() }) }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Removed." }, 404: { content: { "application/json": { schema: ErrorBody } }, description: "No such LoRA." } } });

export const videoRoutes = apiRouter<AppEnv>();

type PlanModel = ReturnType<typeof videoInstallModels>[number];
function qualityView(quality: "quick" | "detailed", models: PlanModel[], _installed: string[], available: boolean) {
  const spec = VIDEO_SPECS[quality];
  const verdict = memoryVerdict(quality);
  const remaining = models.filter((model) => !model.installed).reduce((sum, model) => sum + model.approx_bytes, 0);
  return {
    id: spec.modelId, installed: models.every((model) => model.installed), available, audio: spec.audio, image_to_video: spec.imageToVideo,
    limits: { max_seconds: available ? spec.maxSeconds : 0, fps: VIDEO_FPS, default_size: spec.defaultSize, max_pixels: spec.maxPixels, size_step: spec.sizeStep, min_side: spec.minSide, max_frames: spec.maxSeconds * VIDEO_FPS + 1 },
    memory: { fits: verdict.ok, reason: verdict.ok ? null : verdict.reason, peak_gb: Math.round(spec.peakBytes / 1e8) / 10 },
    install: { models, remaining_bytes: remaining, download_bytes: models.reduce((sum, model) => sum + model.approx_bytes, 0) },
    licence: quality === "detailed" ? { id: LTX_LICENCE_NOTICE.id, name: LTX_LICENCE_NOTICE.name, url: LTX_LICENCE_NOTICE.url } : null,
    lora_base_model: spec.loraBase,
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
    reference_images: { generated: true, uploaded: false, household_photo: true, reason: "A picture this computer's image generator made can start a clip, and so can a photo of a household adult when Home sends its signed proof that they agreed. Any other uploaded picture or photo of a person is refused for everyone (VIDEO-GEN-12, LIKENESS-01)." },
    worker: { alive: videoGen.workerAlive, idle_exit_seconds: Math.round(Number(process.env.VIDEO_IDLE_MS ?? 600_000) / 1000) },
    environment: { engine: pin ? `${pin.name} ${pin.tag}` : VIDEO_GEN_NAME, version: VIDEO_GEN_VERSION, source: videoGenSourceInstalled(), ready: videoGenEnvironmentReady() },
    install: { models, remaining_bytes: models.filter((model) => !model.installed).reduce((sum, model) => sum + model.approx_bytes, 0) },
    qualities: {
      quick: qualityView("quick", models, installed, availability.available),
      detailed: qualityView("detailed", videoDetailedInstallModels(installed), installed, availability.available),
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
    if (!!form.likeness_subject !== !!form.likeness_proof) return c.json({ error: "A style that looks like a person needs both the person and Home's proof that they agreed.", code: "likeness_proof_required" }, 403);
    const record = await importLora({ path: source, name: form.name, licence: form.licence, licenceAcknowledged: form.licence_acknowledged === "true", sourceUrl: form.source_url ?? null, classification: form.classification, strengthDefault: form.strength_default, triggerWords: triggerWords(form.trigger_words), addedBy: form.added_by ?? null, ...(form.likeness_subject && form.likeness_proof ? { likeness: { subject: form.likeness_subject, proof: form.likeness_proof } } : {}) });
    return c.json(record, 200);
  } catch (error) {
    if (error instanceof LoraError) return c.json({ error: error.message, code: error.code }, error.status as 403 | 409 | 413 | 422);
    throw error;
  } finally { if (temp) rmSync(temp, { force: true }); }
});

videoRoutes.openapi(patchRoute, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  if (!isLoraId(id)) return c.json({ error: "No such LoRA in the library.", code: "unknown_lora" }, 404);
  try {
    return c.json(await updateLora(id, { name: body.name, classification: body.classification, strengthDefault: body.strength_default, triggerWords: body.trigger_words, sourceUrl: body.source_url }), 200);
  } catch (error) {
    if (error instanceof LoraError) return c.json({ error: error.message, code: error.code }, error.status as 404 | 409 | 422);
    throw error;
  }
});

videoRoutes.openapi(removeRoute, async (c) => {
  const { id } = c.req.valid("param");
  return isLoraId(id) && await removeLora(id) ? c.json({ ok: true as const }, 200) : c.json({ error: "No such LoRA in the library.", code: "unknown_lora" }, 404);
});

