// The picture generator's state, install and LoRA library (IMGGEN-STACK-01,
// IMGGEN-LORA-01). The pictures themselves are POST /v1/images/generations and
// POST /v1/images/edits. Home enables its picture controls from GET
// /stack/v1/image, installs a model family with POST /stack/v1/image/install
// (the pinned files, then the engine environment, one job), and manages the
// household LoRA library here. Who may use which LoRA is Home's rule; this
// route stores the facts (hash, licence, base model, classification) and
// refuses a file that cannot work or must not be added.
import { createRoute, z } from "@hono/zod-openapi";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { dataDir } from "@/lib/paths";
import { listModels } from "@/lib/modelStore";
import { imageInstallModels } from "@/lib/installPlan";
import { modelView } from "@/routes/models";
import { getGovernorStatus } from "@/lib/governor";
import { LORA_CLASSES, LoraError, MAX_LORA_BYTES, MAX_LORA_STRENGTH, isLoraId } from "@/lib/media/loraLibrary";
import { IMAGE_LORA_BASES, imageLoras, MAX_LORAS_PER_IMAGE, startLoraInstall } from "@/images/loras";
import { IMAGE_FAMILIES, IMAGE_FEATHER_DEFAULT, IMAGE_FEATHER_MAX, IMAGE_MAX_COUNT, IMAGE_MAX_EDIT_MEGAPIXELS, IMAGE_MAX_INPUT_BYTES, IMAGE_MAX_PROMPT_CHARS, IMAGE_MAX_SIDE, IMAGE_MIN_SIDE, IMAGE_QUEUE_MAX, IMAGE_SIZE_STEP, DEFAULT_FAMILY, familyInstalled, imageAvailability, isFamilyId, peakBytes, quantizeFor, type ImageFamilyId } from "@/images/models";
import { IMAGE_GEN_NAME, IMAGE_GEN_VERSION, imageGen, imageGenEnvironmentReady, memoryVerdict } from "@/images/imageEngine";
import { startImageInstall } from "@/images/install";

const PlanModelSchema = z.object({
  id: z.string(), role: z.string(), repo: z.string().optional(), url: z.string(), sha256: z.string(), approx_bytes: z.number().int(), licence: z.string(), revision: z.string(),
  engine: z.string().optional(), archive: z.boolean().optional(), hub_file: z.string().optional(), component: z.string().optional(), starter: z.boolean(), installed: z.boolean(),
});
const LoraSchema = z.object({
  id: z.string(), name: z.string(), file: z.string(), sha256: z.string(), bytes: z.number().int(), rank: z.number().int(), modules: z.number().int(), base_model: z.string(),
  licence: z.string(), licence_class: z.enum(["free", "acknowledged"]), source_url: z.string().nullable(),
  classification: z.enum(LORA_CLASSES), classification_note: z.string().nullable(), strength_default: z.number(), trigger_words: z.array(z.string()), added_by: z.string().nullable(), added_at: z.string(), likeness_subject: z.string().nullable().openapi({ description: "The household adult this LoRA looks like (an opaque id Home gave), or null. A LoRA that looks like a person is always adult-only and every request that applies it needs Home's signed proof." }),
});
const ErrorBody = z.object({ error: z.string(), code: z.string().optional() });
const ModelSchema = z.object({
  id: z.string(), family: z.string(), label: z.string(), licence: z.string(), installed: z.boolean(), default: z.boolean(), loras: z.boolean(), edit: z.boolean(), steps_default: z.number().int(), peak_gb: z.number(), warm_seconds: z.number(),
  available: z.boolean().openapi({ description: "Whether this computer's tier runs it." }), quantize: z.number().int().nullable(),
  install: z.object({ models: z.array(PlanModelSchema), remaining_bytes: z.number().int() }).openapi({ description: "The pinned files to pull (POST /stack/v1/models, shaped as an install-plan model), or call POST /stack/v1/image/install once." }),
});
const StatusSchema = z.object({
  state: z.enum(["unsupported", "off", "not-installed", "needs-setup", "building", "idle", "running"]).openapi({ description: "off: this computer's tier does not run pictures. not-installed: no model family is installed. needs-setup: installed; the first picture builds the environment if it is missing and starts the worker. idle: the worker is loaded and exits after idle_unload_s. running: a job is in the worker." }),
  phase: z.string().nullable(),
  available: z.boolean(), code: z.string().nullable(), reason: z.string().nullable(), tier: z.string(),
  default_model: z.string().nullable().openapi({ description: "The family an unspecified request uses (FLUX.2 Klein 4B when installed)." }),
  models: z.array(ModelSchema),
  loras_supported: z.boolean(), lora_count: z.number().int(),
  edit: z.object({ generative: z.boolean(), masked: z.boolean(), model: z.string() }),
  limits: z.record(z.string(), z.union([z.number(), z.string()])),
  negative_prompt: z.string(),
  idle_unload_s: z.number().int(),
  memory: z.object({ fits: z.boolean(), reason: z.string().nullable(), peak_gb: z.number() }).openapi({ description: "Whether a default picture could be admitted next to what is resident now." }),
  worker: z.object({ alive: z.boolean() }),
  environment: z.object({ engine: z.string(), version: z.string(), ready: z.boolean() }),
  install: z.object({ models: z.array(PlanModelSchema), remaining_bytes: z.number().int() }).openapi({ description: "What turning pictures on pulls: the default family's pinned files." }),
});
const statusRoute = createRoute({ method: "get", path: "/", tags: ["Images"], summary: "The picture generator's state, models, limits and what to install", responses: { 200: { content: { "application/json": { schema: z.object({ image: StatusSchema }) } }, description: "Additive. Home enables the picture tools and its settings page from this." } } });
const installRoute = createRoute({ method: "post", path: "/install", tags: ["Images"], summary: "Install a picture model family and the engine (one job)", request: { body: { content: { "application/json": { schema: z.object({ family: z.string().optional().openapi({ description: "flux2-klein-4b (the default) or z-image-turbo." }) }) } } } }, responses: {
  202: { content: { "application/json": { schema: z.object({ job: z.string(), family: z.string(), joined: z.boolean() }) } }, description: "The install job (downloads, then builds the environment). A second call while one runs joins it." },
  404: { content: { "application/json": { schema: ErrorBody } }, description: "Unknown family." },
  503: { content: { "application/json": { schema: ErrorBody } }, description: "Pictures are not available on this computer." },
} });
const listRoute = createRoute({ method: "get", path: "/loras", tags: ["Images"], summary: "The household LoRA library", responses: { 200: { content: { "application/json": { schema: z.object({ loras: z.array(LoraSchema), base_models: z.array(z.string()), max_per_picture: z.number().int() }) } }, description: "Every record. Who may use which is Home's rule; a request names the LoRAs it is allowed to apply." } } });
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
const importRoute = createRoute({ method: "post", path: "/loras", tags: ["Images"], summary: "Add a LoRA to the library (a file)", request: { body: { content: { "multipart/form-data": { schema: importForm } } } }, responses: {
  200: { content: { "application/json": { schema: LoraSchema } }, description: "Added; the id is `lora-` and the first 16 hex of the sha256. `base_model` was read from the tensors." },
  409: { content: { "application/json": { schema: ErrorBody } }, description: "Already in the library (already_added)." },
  413: { content: { "application/json": { schema: ErrorBody } }, description: "Larger than 2 GB." },
  403: { content: { "application/json": { schema: ErrorBody } }, description: "A style that looks like a person was sent without a valid proof from Home: likeness_proof_required, likeness_proof_invalid, likeness_proof_expired, likeness_proof_mismatch, likeness_not_trusted." },
  422: { content: { "application/json": { schema: ErrorBody } }, description: "Not usable: not_safetensors, not_a_lora, wrong_base_model, licence_acknowledgement_required, lora_refused (a minor in a sexual context, or a real person's likeness: never allowed), bad_name, bad_strength." },
} });
const urlRoute = createRoute({ method: "post", path: "/loras/install", tags: ["Images"], summary: "Add a LoRA from a Hugging Face link (an install job)", request: { body: { content: { "application/json": { schema: z.object({
  url: z.string().openapi({ description: "https://huggingface.co/<owner>/<repo>/resolve/<revision>/<file>.safetensors (a /blob/ link works too). No other host is fetched." }),
  name: z.string(), licence: z.string().optional().openapi({ description: "Left out: read from the repository's card; \"unknown\" when it has none." }), licence_acknowledged: z.boolean().optional(),
  classification: z.enum(LORA_CLASSES).optional(), strength_default: z.number().min(0).max(MAX_LORA_STRENGTH).optional(), trigger_words: z.array(z.string()).optional(), added_by: z.string().optional(),
  likeness_subject: z.string().max(200).optional().openapi({ description: "LIKENESS-01: the household adult this style looks like, sent with `likeness_proof` (purpose style_import, bound to `name:<name>` or the link)." }), likeness_proof: z.string().max(4096).optional(),
}) } } } }, responses: {
  202: { content: { "application/json": { schema: z.object({ job: z.string() }) } }, description: "The install job (/stack/v1/jobs/{id}); when done its `result.lora` is the record, when failed its `reason` starts with the code (licence_acknowledgement_required, lora_refused, wrong_base_model, ...)." },
  422: { content: { "application/json": { schema: ErrorBody } }, description: "bad_url: not a huggingface.co file link." },
} });
const patchRoute = createRoute({ method: "patch", path: "/loras/{id}", tags: ["Images"], summary: "Edit a LoRA's name, class, default strength or trigger words", request: { params: z.object({ id: z.string() }), body: { content: { "application/json": { schema: z.object({ name: z.string().optional(), classification: z.enum(LORA_CLASSES).optional(), strength_default: z.number().min(0).max(MAX_LORA_STRENGTH).optional(), trigger_words: z.array(z.string()).optional(), source_url: z.string().nullable().optional() }) } } } }, responses: {
  200: { content: { "application/json": { schema: LoraSchema } }, description: "Updated." },
  404: { content: { "application/json": { schema: ErrorBody } }, description: "No such LoRA." },
  409: { content: { "application/json": { schema: ErrorBody } }, description: "classification_locked: the file's own description names adult content, so it cannot be all-ages." },
  422: { content: { "application/json": { schema: ErrorBody } }, description: "A value is out of range." },
} });
const removeRoute = createRoute({ method: "delete", path: "/loras/{id}", tags: ["Images"], summary: "Remove a LoRA and its file", request: { params: z.object({ id: z.string() }) }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Removed." }, 404: { content: { "application/json": { schema: ErrorBody } }, description: "No such LoRA." } } });

export const imageRoutes = apiRouter<AppEnv>();

imageRoutes.openapi(statusRoute, (c) => {
  const availability = imageAvailability(imageGen.supported());
  const status = imageGen.status();
  const installedIds = listModels().map(modelView).filter((model) => model.state === "installed").map((model) => model.id);
  const tier = getGovernorStatus().tier;
  const installed = imageGen.families();
  const defaultModel = familyInstalled(DEFAULT_FAMILY) ? DEFAULT_FAMILY : installed[0] ?? null;
  const models = (Object.keys(IMAGE_FAMILIES) as ImageFamilyId[]).map((family) => {
    const info = IMAGE_FAMILIES[family];
    const pins = imageInstallModels(family, installedIds);
    return {
      id: info.id, family: info.id, label: info.label, licence: info.licence, installed: familyInstalled(family), default: family === defaultModel, loras: true, edit: info.edit, steps_default: info.stepsDefault,
      peak_gb: Math.round(peakBytes(family, "generate", quantizeFor(family, "generate", tier), 0) / 1e8) / 10, warm_seconds: info.warmSeconds, available: availability.available && (info.tiers as string[]).includes(tier), quantize: quantizeFor(family, "generate", tier),
      install: { models: pins, remaining_bytes: pins.filter((pin) => !pin.installed).reduce((sum, pin) => sum + pin.approx_bytes, 0) },
    };
  });
  const verdict = memoryVerdict(peakBytes(defaultModel ?? DEFAULT_FAMILY, "generate", quantizeFor(defaultModel ?? DEFAULT_FAMILY, "generate", tier), 0));
  const plan = imageInstallModels(DEFAULT_FAMILY, installedIds);
  return c.json({ image: {
    state: status.state, phase: status.phase, available: availability.available, code: availability.code, reason: availability.reason, tier: availability.tier,
    default_model: defaultModel, models, loras_supported: true, lora_count: imageLoras.list().length,
    edit: { generative: installed.includes("flux2-klein-4b") && availability.available, masked: installed.includes("flux2-klein-4b") && availability.available, model: "flux2-klein-4b" },
    limits: { min_side: IMAGE_MIN_SIDE, max_side: IMAGE_MAX_SIDE, size_step: IMAGE_SIZE_STEP, max_n: IMAGE_MAX_COUNT, max_prompt_chars: IMAGE_MAX_PROMPT_CHARS, max_loras: MAX_LORAS_PER_IMAGE, max_input_bytes: IMAGE_MAX_INPUT_BYTES, max_edit_megapixels: IMAGE_MAX_EDIT_MEGAPIXELS, queue_max: IMAGE_QUEUE_MAX, feather_default: IMAGE_FEATHER_DEFAULT, feather_max: IMAGE_FEATHER_MAX, default_size: "1024x1024" },
    negative_prompt: "accepted, no effect: the distilled models run without guidance",
    idle_unload_s: Math.round(Number(process.env.IMAGE_IDLE_MS ?? 600_000) / 1000),
    memory: { fits: verdict.ok, reason: verdict.ok ? null : verdict.reason, peak_gb: Math.round(peakBytes(defaultModel ?? DEFAULT_FAMILY, "generate", quantizeFor(defaultModel ?? DEFAULT_FAMILY, "generate", tier), 0) / 1e8) / 10 },
    worker: { alive: imageGen.workerAlive },
    environment: { engine: IMAGE_GEN_NAME, version: IMAGE_GEN_VERSION, ready: imageGenEnvironmentReady() },
    install: { models: plan, remaining_bytes: plan.filter((pin) => !pin.installed).reduce((sum, pin) => sum + pin.approx_bytes, 0) },
  } }, 200 as const);
});

imageRoutes.openapi(installRoute, (c) => {
  const body = c.req.valid("json");
  const family = body.family ?? DEFAULT_FAMILY;
  if (!isFamilyId(family)) return c.json({ error: `Unknown picture model ${family.slice(0, 60)}. Use ${Object.keys(IMAGE_FAMILIES).join(" or ")}.`, code: "unknown_model" }, 404);
  const availability = imageAvailability(imageGen.supported());
  if (!availability.available) return c.json({ error: availability.reason ?? "Pictures are not available on this computer.", code: availability.code ?? "unsupported" }, 503);
  if (!(IMAGE_FAMILIES[family].tiers as string[]).includes(availability.tier)) return c.json({ error: `${IMAGE_FAMILIES[family].label} needs a computer with more memory than this one.`, code: "not_available_on_this_computer" }, 503);
  const started = startImageInstall(family);
  return c.json({ job: started.job, family, joined: started.joined }, 202);
});

imageRoutes.openapi(listRoute, (c) => c.json({ loras: imageLoras.list(), base_models: [...IMAGE_LORA_BASES], max_per_picture: MAX_LORAS_PER_IMAGE }, 200));

function triggerWords(value: string | undefined): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) { try { const parsed = JSON.parse(trimmed); if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string"); } catch { /* fall through to commas */ } }
  return trimmed.split(",");
}

imageRoutes.openapi(importRoute, async (c) => {
  const form = c.req.valid("form");
  const staging = join(dataDir, "tmp", "image-lora");
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
    const record = await imageLoras.importFile({ path: source, name: form.name, licence: form.licence, licenceAcknowledged: form.licence_acknowledged === "true", sourceUrl: form.source_url ?? null, classification: form.classification, strengthDefault: form.strength_default, triggerWords: triggerWords(form.trigger_words), addedBy: form.added_by ?? null, ...(form.likeness_subject && form.likeness_proof ? { likeness: { subject: form.likeness_subject, proof: form.likeness_proof } } : {}) });
    return c.json(record, 200);
  } catch (error) {
    if (error instanceof LoraError) return c.json({ error: error.message, code: error.code }, error.status as 403 | 409 | 413 | 422);
    throw error;
  } finally { if (temp) rmSync(temp, { force: true }); }
});

imageRoutes.openapi(urlRoute, (c) => {
  const body = c.req.valid("json");
  if (!!body.likeness_subject !== !!body.likeness_proof) return c.json({ error: "A style that looks like a person needs both the person and Home's proof that they agreed.", code: "likeness_proof_required" }, 422);
  try {
    const job = startLoraInstall({ url: body.url, name: body.name, licence: body.licence, licenceAcknowledged: body.licence_acknowledged, classification: body.classification, strengthDefault: body.strength_default, triggerWords: body.trigger_words, addedBy: body.added_by ?? null, ...(body.likeness_subject && body.likeness_proof ? { likeness: { subject: body.likeness_subject, proof: body.likeness_proof } } : {}) });
    return c.json({ job: job.id }, 202);
  } catch (error) {
    if (error instanceof LoraError) return c.json({ error: error.message, code: error.code }, 422);
    throw error;
  }
});

imageRoutes.openapi(patchRoute, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  if (!isLoraId(id)) return c.json({ error: "No such LoRA in the library.", code: "unknown_lora" }, 404);
  try {
    return c.json(await imageLoras.update(id, { name: body.name, classification: body.classification, strengthDefault: body.strength_default, triggerWords: body.trigger_words, sourceUrl: body.source_url }), 200);
  } catch (error) {
    if (error instanceof LoraError) return c.json({ error: error.message, code: error.code }, error.status as 404 | 409 | 422);
    throw error;
  }
});

imageRoutes.openapi(removeRoute, async (c) => {
  const { id } = c.req.valid("param");
  return isLoraId(id) && await imageLoras.remove(id) ? c.json({ ok: true as const }, 200) : c.json({ error: "No such LoRA in the library.", code: "unknown_lora" }, 404);
});
