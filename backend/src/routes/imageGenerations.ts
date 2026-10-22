// POST /v1/images/generations (the mflux path), the generative operations of
// POST /v1/images/edits, and the job's files (IMGGEN-STACK-02, IMGGEN-EDIT-01).
// The same job API as video: the picture is submitted, the reply waits up to
// timeout_ms, and past the deadline answers 202 with the job id for Home to
// come back to. Progress is by phase; cancel stops the worker between steps;
// the finished pictures (PNG and JPEG thumbnail) are fetched by URL from the
// result store. Home owns who may call this and with what: it applies the age
// band, the surface, the prompt floor and the LoRA rules, then passes down the
// audience and the allowed LoRA list; the Stack applies the hard limits and
// the locks it can check (see images/imageEngine.ts and lib/media/loraLibrary.ts).
import { PAUSED_LOW_MEMORY } from "@/lib/memoryState";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { existsSync, readFileSync, statSync } from "node:fs";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { identityHeaders } from "@/lib/identity";
import { RoleReplyHeaders } from "@maipai/spec/stack/ts/role-reply-headers.js";
import { cancelJob, getJob, hasJobRunner, isJobPaused, listJobs, submitJob, waitForJob, type Job } from "@/lib/jobs";
import { PAUSED_LABEL } from "@/lib/genProgress";
import { LoraError, type LoraRequest } from "@/lib/media/loraLibrary";
import { LikenessError, photoBind, verifyProof, type LikenessCheck } from "@/lib/likeness";
import { wasGeneratedHere } from "@/video/provenance";
import { imageLoras, MAX_LORAS_PER_IMAGE } from "@/images/loras";
import { deleteResult, isJobId, pngPath, readResult, thumbPath, type ImageResultMeta } from "@/images/results";
import { imageGen, memoryVerdict } from "@/images/imageEngine";
import {
  DEFAULT_FAMILY, familyInstalled, IMAGE_DEFAULT_SIZE, IMAGE_FAMILIES, IMAGE_FEATHER_DEFAULT, IMAGE_FEATHER_MAX, IMAGE_REFERENCES_MAX, IMAGE_MAX_COUNT, IMAGE_MAX_INPUT_BYTES, IMAGE_MAX_PROMPT_CHARS, IMAGE_QUEUE_MAX, imageAvailability, installedFamilies,
  isFamilyId, parseSize, peakBytes, quantizeFor, type ImageFamilyId,
} from "@/images/models";
import { IMAGE_EDIT_JOB_KIND, IMAGE_JOB_KIND, imageFailure, imagePreviewPath, imageProgress, imageTracker, stashImage, unstashImage } from "@/images/jobs";
import { getGovernorStatus } from "@/lib/governor";

const DEFAULT_WAIT_MS = 120_000;
const MAX_WAIT_MS = 30 * 60_000;

const LoraEntry = z.object({
  id: z.string().max(40).optional().openapi({ description: "The library id (`lora-` and the first 16 hex of the sha256)." }),
  sha256: z.string().length(64).optional().openapi({ description: "Or the file's full sha256." }),
  scale: z.number().min(0).max(2).optional().openapi({ description: "Strength, 0 to 2; the record's default when left out." }),
  likeness_proof: z.string().max(4096).optional().openapi({ description: "Needed when the LoRA looks like a person (its record has a likeness_subject): Home's signed, short-lived proof that the person agreed, bound to this LoRA." }),
  strength: z.number().min(0).max(2).optional().openapi({ description: "Alias of `scale`." }),
});
export const ImageGenerationBodySchema = z.object({
  model: z.string().optional().openapi({ description: "`image` (the default), or a picture model id from GET /stack/v1/image (`flux2-klein-4b`, `z-image-turbo`). Choosing a LoRA selects the base model it was made for." }),
  prompt: z.string().trim().min(1).max(IMAGE_MAX_PROMPT_CHARS),
  negative_prompt: z.string().max(IMAGE_MAX_PROMPT_CHARS).optional().openapi({ description: "Accepted. The distilled models run without guidance, so it has no effect on the picture." }),
  size: z.string().regex(/^\d{3,4}x\d{3,4}$/).optional().openapi({ description: `<width>x<height>, each 256 to 2048 and a multiple of 16. Default ${IMAGE_DEFAULT_SIZE}.`, example: IMAGE_DEFAULT_SIZE }),
  n: z.number().int().min(1).max(IMAGE_MAX_COUNT).optional().openapi({ description: `Pictures to make, 1 to ${IMAGE_MAX_COUNT}, seeds seed, seed+1, and so on. Default 1.` }),
  seed: z.number().int().min(0).max(4_294_967_295).optional(),
  steps: z.number().int().min(1).max(30).optional().openapi({ description: "Denoising steps. Default 4 for Klein, 9 for Z-Image-Turbo (the distilled models need no more)." }),
  loras: z.array(LoraEntry).max(MAX_LORAS_PER_IMAGE).optional().openapi({ description: "LoRAs from the household library (GET /stack/v1/image/loras), by id or sha256, with a scale. Home decides which ids this caller may name." }),
  audience: z.enum(["all-ages", "adult"]).optional().openapi({ description: "Who the picture is for, set by Home from the person's age band and the surface. Default all-ages. An adult-only LoRA in the list with audience all-ages is refused (422 lora_not_allowed)." }),
  init_image: z.string().optional().openapi({ description: "Image to image: the starting picture, base64 (a data: URL is fine), PNG, JPEG or WebP, at most 40 MB." }),
  image_source: z.enum(["generated", "uploaded", "household_photo"]).optional().openapi({ description: "Needed with `init_image`: where the starting picture came from, as Home knows it. `generated`: a picture this Stack made (its hash is checked). `household_photo`: a photo of a consenting household adult, accepted only with `consent_proof`. `uploaded`: a photo Home checked and found to show no person. Anything else is refused." }),
  consent_proof: z.string().max(4096).optional().openapi({ description: "With `image_source: household_photo`: Home's signed proof that the person in the photo is a household adult who agreed, bound to this exact picture and valid for at most 30 minutes. Checked when the request arrives and again when the job starts." }),
  strength: z.number().min(0.05).max(1).optional().openapi({ description: "Image to image only: how far the result may move from `init_image` (1 is a new picture). Default 0.6." }),
  preview: z.boolean().optional().openapi({ description: "Default true. While the job runs, the status carries `preview_url`: a small JPEG (about 256 px on the long side) of where the picture is heading, redrawn after every denoising step. Pass false to skip it. Edits never make previews." }),
  timeout_ms: z.number().int().positive().max(MAX_WAIT_MS).optional().openapi({ description: `How long this request waits for the picture before answering 202 with the job id. Default ${DEFAULT_WAIT_MS}.` }),
}).passthrough();
export type ImageGenerationBody = z.infer<typeof ImageGenerationBodySchema>;

const PicSchema = z.object({
  url: z.string().openapi({ description: "GET this for the PNG (no metadata)." }),
  thumbnail_url: z.string().openapi({ description: "GET this for the 384 px JPEG." }),
  b64_json: z.string().optional().openapi({ description: "The PNG, base64, on the reply that waited for it." }),
  content_type: z.literal("image/png"),
  seed: z.number().int(), width: z.number().int(), height: z.number().int(), model: z.string(), steps: z.number().int(), ms: z.number().int(), lora_ids: z.array(z.string()),
  mode: z.enum(["generate", "image-to-image", "edit", "edit-masked"]),
});
export const ImageResponseSchema = z.object({ created: z.number().int(), job: z.string(), data: z.array(PicSchema) });
export const ImageErrorBody = z.object({ error: z.string(), code: z.string(), job: z.string().optional() });
const JobStatusSchema = z.object({
  job: z.string(),
  state: z.enum(["queued", "running", "done", "failed", "cancelled"]),
  phase: z.string().openapi({ description: "queued, waiting for memory, starting, setting up (first picture only), loading, rendering, decoding, ready; failed or cancelled when it ended so." }),
  progress: z.number().int().openapi({ description: "0 to 100 over the whole job." }),
  phase_progress: z.number().int().nullable(),
  progress_fraction: z.number().nullable().openapi({ description: "0 to 1 over the whole job, weighted by where the time goes. Moves smoothly inside a stage." }),
  stage: z.string().nullable().openapi({ description: "load, plan, steps or decode while running; null otherwise." }),
  stage_label: z.string().nullable().openapi({ description: "The stage in words a person reads (\"Drawing, step 2 of 4\")." }),
  step: z.number().int().nullable().openapi({ description: "Denoising steps finished for the picture being made." }),
  steps: z.number().int().nullable().openapi({ description: "Denoising steps in all." }),
  eta_seconds: z.number().int().nullable().openapi({ description: "Whole seconds left, from the medians of earlier pictures of the same size; null until a stage is known." }),
  preview_url: z.string().nullable().openapi({ description: "GET this for the latest preview JPEG while running (the `v` query changes with every new one); null when none exists yet, the request asked for none, or the job ended." }),
  preview_step: z.number().int().nullable().openapi({ description: "The step the preview shows." }),
  position: z.number().int().nullable().openapi({ description: "Place in line while queued (1 is next)." }),
  error: z.string().nullable(), code: z.string().nullable(),
  data: z.array(PicSchema),
});

const getRoute = createRoute({ method: "get", path: "/generations/{job}", tags: ["Images"], summary: "A picture job's state, progress and files", request: { params: z.object({ job: z.string() }) }, responses: {
  200: { content: { "application/json": { schema: JobStatusSchema } }, description: "Poll this every second or two while state is queued or running." },
  404: { content: { "application/json": { schema: ImageErrorBody } }, description: "No such job (it expired or never existed)." },
} });
const pngRoute = createRoute({ method: "get", path: "/generations/{job}/{file}", tags: ["Images"], summary: "A finished picture (`0.png`), its thumbnail (`0.thumb.jpg`) or, while the job runs, its latest preview (`preview.jpg`)", request: { params: z.object({ job: z.string(), file: z.string() }) }, responses: {
  200: { content: { "image/png": { schema: z.string().openapi({ format: "binary" }) }, "image/jpeg": { schema: z.string().openapi({ format: "binary" }) } }, description: "The picture." },
  404: { content: { "application/json": { schema: ImageErrorBody } }, description: "The picture is gone: results are kept for a day, or Home deleted them." },
} });
const deleteRoute = createRoute({ method: "delete", path: "/generations/{job}", tags: ["Images"], summary: "Cancel a picture job, or delete a finished one's files", request: { params: z.object({ job: z.string() }) }, responses: {
  200: { content: { "application/json": { schema: z.object({ job: z.string(), state: z.enum(["cancelled", "deleted", "failed"]) }) } }, description: "A queued or running job is cancelled (the worker stops between steps and its memory returns); a finished job's files are deleted (Home calls this once it has stored them)." },
  404: { content: { "application/json": { schema: ImageErrorBody } }, description: "No such job." },
} });

function reply<T extends Context>(c: T, body: unknown, status: number) {
  for (const [name, value] of Object.entries(RoleReplyHeaders.parse(identityHeaders(null)))) c.header(name, value);
  return c.json(body as never, status as never);
}
const fail = <T extends Context>(c: T, status: number, code: string, error: string, job?: string) => reply(c, { error, code, ...(job ? { job } : {}) }, status);

function entries(meta: ImageResultMeta, withBytes: boolean) {
  return meta.images.map((item) => ({
    url: `/v1/images/generations/${meta.job}/${item.index}.png`, thumbnail_url: `/v1/images/generations/${meta.job}/${item.index}.thumb.jpg`,
    ...(withBytes ? { b64_json: readFileSync(pngPath(meta.job, item.index)).toString("base64") } : {}),
    content_type: "image/png" as const, seed: item.seed, width: item.width, height: item.height, model: meta.model, steps: meta.steps, ms: meta.ms, lora_ids: meta.lora_ids, mode: meta.mode,
  }));
}

/** Bytes of a base64 or data: URL picture, or null when it is not valid base64. */
function decodeImage(value: string): Uint8Array | null {
  const raw = value.startsWith("data:") ? value.slice(value.indexOf(",") + 1) : value;
  if (raw.length === 0 || raw.length % 4 === 1 || /[^A-Za-z0-9+/=\s]/.test(raw)) return null;
  try { const bytes = Buffer.from(raw, "base64"); return bytes.length > 0 ? new Uint8Array(bytes) : null; } catch { return null; }
}
export function looksLikePicture(bytes: Uint8Array): boolean {
  const png = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  return png || jpeg || webp;
}

function activeJobs(): number { return listJobs().filter((job) => (job.kind === IMAGE_JOB_KIND || job.kind === IMAGE_EDIT_JOB_KIND) && (job.state === "queued" || job.state === "running" || job.state === "stalled")).length; }
const isImageKind = (job: Job): boolean => job.kind === IMAGE_JOB_KIND || job.kind === IMAGE_EDIT_JOB_KIND;

/** The stage, step, ETA and preview of a running job; all null otherwise. */
function liveFields(id: string, running: boolean) {
  const tracker = running ? imageTracker(id) : null;
  const snap = tracker?.snapshot();
  const preview = tracker?.preview && imagePreviewPath(id) ? tracker.preview : null;
  return {
    progress_fraction: snap && tracker!.started ? Math.round(snap.fraction * 1000) / 1000 : null,
    stage: snap?.stage ?? null, stage_label: running && isJobPaused(id) ? PAUSED_LABEL : snap?.stage_label ?? null, step: snap?.step ?? null, steps: snap?.steps ?? null, eta_seconds: running && isJobPaused(id) ? null : snap?.eta_seconds ?? null,
    preview_url: preview ? `/v1/images/generations/${id}/preview.jpg?v=${preview.version}` : null, preview_step: preview?.step ?? null,
  };
}

function statusOf(job: Job) {
  const detail = imageProgress(job.id);
  const failure = imageFailure(job.id);
  const state = job.state === "stalled" ? "running" : job.state;
  const phase = state === "queued" ? "queued" : state === "done" ? "ready" : state === "cancelled" && job.status === PAUSED_LOW_MEMORY ? PAUSED_LOW_MEMORY : state === "failed" || state === "cancelled" ? state : detail?.phase ?? (job.status.startsWith("waiting for memory") ? "waiting for memory" : job.status);
  const result = job.state === "done" ? readResult(job.id) : null;
  return {
    job: job.id, state, phase, progress: Math.round(job.percent), phase_progress: state === "running" && detail ? Math.round(detail.phasePercent) : null, position: job.state === "queued" ? job.position : null,
    ...liveFields(job.id, state === "running"),
    error: job.state === "failed" ? failure?.message ?? job.reason ?? "The picture failed." : job.state === "cancelled" ? (job.status === PAUSED_LOW_MEMORY ? job.reason ?? "Paused: this computer is low on memory." : "The picture was cancelled.") : null,
    code: job.state === "failed" ? (job.status === "no_memory" ? "no_memory" : failure?.code ?? "failed") : job.state === "cancelled" ? (job.status === PAUSED_LOW_MEMORY ? "no_memory" : "cancelled") : null,
    data: result ? entries(result, false) : [],
  };
}

/** Picks the base model: the one named, else the one the LoRAs were made for, else the default, else whatever is installed. */
function chooseFamily(model: string | undefined, loraRequests: LoraRequest[]): { family: ImageFamilyId } | { error: { status: number; code: string; message: string } } {
  const installed = installedFamilies();
  if (installed.length === 0) return { error: { status: 503, code: "not_installed", message: "No picture model is installed yet. Install FLUX.2 Klein 4B from Home's Engines page, then try again." } };
  if (model && model !== "image") {
    if (!isFamilyId(model)) return { error: { status: 422, code: "unknown_model", message: `Unknown picture model "${model.slice(0, 60)}". Use image, ${Object.keys(IMAGE_FAMILIES).join(" or ")}.` } };
    if (!familyInstalled(model)) return { error: { status: 503, code: "not_installed", message: `${IMAGE_FAMILIES[model].label} is not installed yet. Install it from Home's Engines page, then try again.` } };
    return { family: model };
  }
  const bases = new Set<string>();
  for (const request of loraRequests) {
    const record = request.id !== undefined ? imageLoras.get(request.id) : request.sha256 !== undefined ? imageLoras.bySha(request.sha256) : null;
    if (record) bases.add(record.base_model);
  }
  if (bases.size > 1) return { error: { status: 422, code: "wrong_base_model", message: "These LoRAs were made for different picture models and cannot be used together. Pick LoRAs made for the same model." } };
  if (bases.size === 1) {
    const base = [...bases][0]! as ImageFamilyId;
    if (!familyInstalled(base)) return { error: { status: 503, code: "not_installed", message: `This LoRA needs ${IMAGE_FAMILIES[base].label}, which is not installed yet. Install it from Home's Engines page, then try again.` } };
    return { family: base };
  }
  return { family: familyInstalled(DEFAULT_FAMILY) ? DEFAULT_FAMILY : installed[0]! };
}

function loraRequests(list: ImageGenerationBody["loras"]): LoraRequest[] {
  return (list ?? []).map((entry) => ({ ...(entry.id !== undefined ? { id: entry.id } : {}), ...(entry.sha256 !== undefined ? { sha256: entry.sha256 } : {}), ...(entry.scale !== undefined ? { strength: entry.scale } : entry.strength !== undefined ? { strength: entry.strength } : {}), ...(entry.likeness_proof !== undefined ? { likenessProof: entry.likeness_proof } : {}) }));
}

type Source = "generated" | "uploaded" | "household_photo" | undefined;
/** The checks on a starting picture: the source must be declared; a generated picture must be in the ledger; a household photo needs Home's proof bound to these bytes. Returns the response to send, or the proof to re-check when the job starts. */
function checkSource<T extends Context>(c: T, bytes: Uint8Array, source: Source, proof: string | undefined, what: string): Response | LikenessCheck | null {
  if (!source) return fail(c, 422, "reference_source_required", `Say where the ${what} came from (image_source): a picture this computer made, a photo of a household adult who agreed, or a photo Home checked shows no person.`) as unknown as Response;
  if (source === "generated") {
    return wasGeneratedHere(bytes) ? null : fail(c, 422, "reference_not_generated", `That ${what} was not made by this computer's image generator, so it cannot be used as a generated picture. Send it as a photo instead.`) as unknown as Response;
  }
  if (source === "uploaded") return null;
  try { verifyProof(proof, { purpose: "photo", bind: photoBind(bytes), consume: true }); } catch (error) {
    if (error instanceof LikenessError) return fail(c, error.status, error.code, error.message) as unknown as Response;
    throw error;
  }
  return { purpose: "photo", bind: photoBind(bytes), token: proof! };
}

async function waitAndReply<T extends Context>(c: T, jobId: string, createdAt: string, timeoutMs: number) {
  const settled = await waitForJob(jobId, timeoutMs);
  const created = Math.floor(new Date(createdAt).getTime() / 1000);
  if (!settled || settled.state === "queued" || settled.state === "running" || settled.state === "stalled") return reply(c, { created, job: jobId, data: [] }, 202);
  if (settled.state === "cancelled" && settled.status === PAUSED_LOW_MEMORY) return fail(c, 503, "no_memory", settled.reason ?? "Paused: this computer is low on memory.", settled.id);
  if (settled.state === "cancelled") return fail(c, 499, "cancelled", "The picture was cancelled.", settled.id);
  if (settled.state === "failed" && settled.status === "no_memory") return fail(c, 503, "no_memory", settled.reason ?? "There was not enough free memory.", settled.id);
  if (settled.state !== "done") {
    const failure = imageFailure(settled.id);
    return fail(c, failure?.status ?? 500, failure?.code ?? "failed", failure?.message ?? settled.reason ?? "The picture failed.", settled.id);
  }
  const meta = readResult(settled.id);
  if (!meta) return fail(c, 500, "expired", "The picture is no longer held. Make it again.", settled.id);
  return reply(c, { created, job: settled.id, data: entries(meta, true) }, 200);
}

function precheck<T extends Context>(c: T, kind: string): Response | null {
  const availability = imageAvailability(imageGen.supported());
  if (!availability.available) return fail(c, 503, availability.code ?? "unsupported", availability.reason ?? "Pictures are not available on this computer.");
  if (!hasJobRunner(kind)) return fail(c, 503, "unsupported", "Pictures are not available on this machine.");
  return null;
}

/** The mflux path of POST /v1/images/generations. */
export async function generateImages<T extends Context>(c: T, body: ImageGenerationBody) {
  const blocked = precheck(c, IMAGE_JOB_KIND);
  if (blocked) return blocked;
  const size = parseSize(body.size);
  if (typeof size === "string") return fail(c, 422, "bad_size", size);
  const count = body.n ?? 1;
  const requests = loraRequests(body.loras);
  const chosen = chooseFamily(body.model, requests);
  if ("error" in chosen) return fail(c, chosen.error.status, chosen.error.code, chosen.error.message);
  const family = chosen.family;
  const info = IMAGE_FAMILIES[family];
  const tier = getGovernorStatus().tier;
  if (!(info.tiers as string[]).includes(tier)) return fail(c, 503, "not_available_on_this_computer", `${info.label} needs a computer with more memory than this one. Use FLUX.2 Klein 4B instead.`);
  const steps = body.steps ?? info.stepsDefault;
  if (steps > info.stepsMax) return fail(c, 422, "bad_steps", `${info.label} needs at most ${info.stepsMax} steps; ${info.stepsDefault} is the default.`);
  let initImage: Uint8Array | null = null;
  const checks: LikenessCheck[] = [];
  let derived = false;
  if (body.init_image !== undefined) {
    initImage = decodeImage(body.init_image);
    if (!initImage || !looksLikePicture(initImage)) return fail(c, 422, "bad_image", "The starting picture could not be read. Send a PNG, JPEG or WebP as base64.");
    if (initImage.length > IMAGE_MAX_INPUT_BYTES) return fail(c, 413, "too_large", `The starting picture is larger than ${IMAGE_MAX_INPUT_BYTES / 1024 / 1024} MB.`);
    if (body.image_source === "household_photo" && (body.audience ?? "all-ages") !== "adult") return fail(c, 403, "likeness_adult_only", "A picture that looks like a person is only made for an adult on their own screen. Ask Home to make it from a signed-in adult's chat.");
    const checked = checkSource(c, initImage, body.image_source, body.consent_proof, "starting picture");
    if (checked instanceof Response) return checked;
    if (checked) checks.push(checked);
    if (body.image_source !== "generated") derived = true;
  }
  let loras;
  try { loras = await imageLoras.resolve(requests, body.audience ?? "all-ages", family); } catch (error) {
    if (error instanceof LoraError) return fail(c, error.status === 404 ? 422 : error.status, error.code, error.message);
    throw error;
  }
  for (const lora of loras) if (lora.likeness) checks.push(lora.likeness);
  // The age and surface gate outranks a consent: a picture that looks like a person is for an adult audience only.
  if (checks.length > 0 && (body.audience ?? "all-ages") !== "adult") return fail(c, 403, "likeness_adult_only", "A picture that looks like a person is only made for an adult on their own screen. Ask Home to make it from a signed-in adult's chat.");
  if (activeJobs() >= IMAGE_QUEUE_MAX) return fail(c, 429, "queue_full", `${IMAGE_QUEUE_MAX} pictures are already waiting. Try again when one finishes.`);
  const quantize = quantizeFor(family, "generate", tier);
  const verdict = memoryVerdict(peakBytes(family, "generate", quantize, loras.length));
  if (!verdict.ok) return fail(c, 503, "no_memory", verdict.reason);
  const seed = body.seed ?? Math.floor(Math.random() * 2 ** 32);
  const token = crypto.randomUUID();
  const loraIds = loras.map((lora) => lora.record.id);
  stashImage(token, {
    op: "generate", prompt: body.prompt, negativePrompt: body.negative_prompt ?? null, family, quantize, width: size.width, height: size.height, steps, seed, count,
    loras: loras.map((lora) => [lora.path, lora.strength]), loraIds, initImage, strength: body.strength ?? 0.6, image: null, mask: null, region: null, feather: 0, likeness: checks, derived, preview: body.preview !== false,
  });
  const submitted = submitJob({ kind: IMAGE_JOB_KIND, role: "image", input: { token, family, mode: "generate", quantize, size: `${size.width}x${size.height}`, steps, seed, count, lora_ids: loraIds, image_to_image: initImage !== null, likeness: checks.length > 0 } });
  if ("refused" in submitted) return fail(c, 503, submitted.code ?? "unsupported", submitted.reason);
  return waitAndReply(c, submitted.job.id, submitted.job.createdAt, body.timeout_ms ?? DEFAULT_WAIT_MS);
}

export interface EditForm {
  image: File; mask?: File; operation: "edit" | "edit_masked"; instruction?: string; prompt?: string; region?: string; feather?: number; seed?: number; steps?: number; timeout_ms?: number; image_source?: Source; consent_proof?: string; audience?: "all-ages" | "adult"; /** IMGEDIT-01: up to two more pictures the edit may draw on (a person to add, an object to copy). Each is declared like the main picture. */ references?: Array<{ file: File; source?: Source; proof?: string }>;
}

/** Normalized x,y,w,h from "0.1,0.2,0.3,0.3", or the sentence to return. */
export function parseRegion(value: string | undefined): [number, number, number, number] | null | string {
  if (value === undefined || value.trim() === "") return null;
  const parts = value.replace(/^\[|\]$/g, "").split(",").map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return "The region must be four numbers between 0 and 1: x, y, width, height.";
  const [x, y, w, h] = parts as [number, number, number, number];
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.0001 || y + h > 1.0001) return "The region must lie inside the picture: x, y, width and height as fractions of its size.";
  return [x, y, w, h];
}

/** The generative operations of POST /v1/images/edits: `edit` changes a picture by an instruction; `edit_masked` changes only the painted mask or the region. Only the masked area (plus a feathered edge) can differ from the original. */
export async function editImages<T extends Context>(c: T, form: EditForm) {
  const blocked = precheck(c, IMAGE_EDIT_JOB_KIND);
  if (blocked) return blocked;
  const instruction = (form.instruction ?? form.prompt ?? "").trim();
  if (!instruction) return fail(c, 422, "instruction_required", "Say what to change in the picture (the `instruction` field).");
  if (instruction.length > IMAGE_MAX_PROMPT_CHARS) return fail(c, 422, "instruction_too_long", `The instruction is longer than ${IMAGE_MAX_PROMPT_CHARS} characters.`);
  const region = parseRegion(form.region);
  if (typeof region === "string") return fail(c, 422, "bad_region", region);
  if (form.operation === "edit_masked" && !form.mask && !region) return fail(c, 422, "mask_required", "Paint the part of the picture to change (the `mask` field, white is changeable) or give a `region`.");
  const feather = form.feather ?? IMAGE_FEATHER_DEFAULT;
  if (!(feather >= 0 && feather <= IMAGE_FEATHER_MAX)) return fail(c, 422, "bad_feather", `The feather is 0 to ${IMAGE_FEATHER_MAX} pixels.`);
  const image = new Uint8Array(await form.image.arrayBuffer());
  if (!looksLikePicture(image)) return fail(c, 422, "bad_image", "The picture could not be read. Send a PNG, JPEG or WebP.");
  if (form.image_source === "household_photo" && form.audience !== "adult") return fail(c, 403, "likeness_adult_only", "A picture that looks like a person is only made for an adult on their own screen. Ask Home to make it from a signed-in adult's chat.");
  const checked = checkSource(c, image, form.image_source, form.consent_proof, "picture");
  if (checked instanceof Response) return checked;
  if (checked && form.audience !== "adult") return fail(c, 403, "likeness_adult_only", "A picture that looks like a person is only made for an adult on their own screen. Ask Home to make it from a signed-in adult's chat.");
  // IMGEDIT-01: reference pictures ride beside the main one. Each is checked the way the main picture is (where it came from; a photo of a
  // household adult needs Home's proof bound to those bytes), and a photo that looks like a person is only for an adult's own screen.
  const refs: Uint8Array[] = [];
  const checks: LikenessCheck[] = checked ? [checked] : [];
  let derived = form.image_source !== "generated";
  for (const ref of (form.references ?? []).slice(0, IMAGE_REFERENCES_MAX)) {
    const bytes = new Uint8Array(await ref.file.arrayBuffer());
    if (!looksLikePicture(bytes)) return fail(c, 422, "bad_image", "A reference picture could not be read. Send a PNG, JPEG or WebP.");
    if (ref.source === "household_photo" && form.audience !== "adult") return fail(c, 403, "likeness_adult_only", "A picture that looks like a person is only made for an adult on their own screen. Ask Home to make it from a signed-in adult's chat.");
    const refChecked = checkSource(c, bytes, ref.source, ref.proof, "reference picture");
    if (refChecked instanceof Response) return refChecked;
    if (refChecked) { if (form.audience !== "adult") return fail(c, 403, "likeness_adult_only", "A picture that looks like a person is only made for an adult on their own screen. Ask Home to make it from a signed-in adult's chat."); checks.push(refChecked); }
    if (ref.source !== "generated") derived = true;
    refs.push(bytes);
  }
  const mask = form.mask ? new Uint8Array(await form.mask.arrayBuffer()) : null;
  if (mask && !looksLikePicture(mask)) return fail(c, 422, "bad_image", "The mask could not be read. Send a PNG, JPEG or WebP.");
  const family: ImageFamilyId = "flux2-klein-4b";
  if (!familyInstalled(family)) return fail(c, 503, "not_installed", `${IMAGE_FAMILIES[family].label} is not installed yet. Install it from Home's Engines page, then try again.`);
  const tier = getGovernorStatus().tier;
  if (!(IMAGE_FAMILIES[family].tiers as string[]).includes(tier)) return fail(c, 503, "not_available_on_this_computer", "Editing needs a computer with 32 GB of memory or more.");
  if (activeJobs() >= IMAGE_QUEUE_MAX) return fail(c, 429, "queue_full", `${IMAGE_QUEUE_MAX} pictures are already waiting. Try again when one finishes.`);
  const verdict = memoryVerdict(peakBytes(family, "edit", null, 0));
  if (!verdict.ok) return fail(c, 503, "no_memory", verdict.reason);
  const steps = form.steps ?? IMAGE_FAMILIES[family].stepsDefault;
  const seed = form.seed ?? Math.floor(Math.random() * 2 ** 32);
  const token = crypto.randomUUID();
  stashImage(token, { op: "edit", prompt: instruction, negativePrompt: null, family, quantize: null, width: 0, height: 0, steps, seed, count: 1, loras: [], loraIds: [], initImage: null, strength: 0, image, mask, region: region ?? null, feather, references: refs, likeness: checks, derived });
  const submitted = submitJob({ kind: IMAGE_EDIT_JOB_KIND, role: "image", input: { token, family, mode: "edit", quantize: null, steps, seed, count: 1, lora_ids: [], masked: mask !== null || region !== null, likeness: checks.length > 0, references: refs.length } });
  if ("refused" in submitted) return fail(c, 503, submitted.code ?? "unsupported", submitted.reason);
  return waitAndReply(c, submitted.job.id, submitted.job.createdAt, form.timeout_ms ?? DEFAULT_WAIT_MS);
}

export const imageV1Routes = apiRouter<AppEnv>();

imageV1Routes.openapi(getRoute, (c) => {
  const id = c.req.valid("param").job;
  const job = getJob(id);
  // A finished job whose files are gone (Home deleted them, or a day passed) is gone, not "done with nothing".
  if (job && isImageKind(job) && !(job.state === "done" && !readResult(id))) return reply(c, statusOf(job), 200);
  // After a restart the job record is gone but a finished job is still on disk.
  const meta = readResult(id);
  if (meta) return reply(c, { job: id, state: "done", phase: "ready", progress: 100, phase_progress: null, ...liveFields(id, false), position: null, error: null, code: null, data: entries(meta, false) }, 200);
  return fail(c, 404, "unknown_job", "No such picture job: it expired after a day, was deleted, or never existed.");
});

imageV1Routes.openapi(pngRoute, (c) => {
  const { job, file } = c.req.valid("param");
  if (file === "preview.jpg") {
    const preview = isJobId(job) ? imagePreviewPath(job) : null;
    if (!preview || !existsSync(preview)) return fail(c, 404, "no_preview", "There is no preview for that picture: it has finished, was never asked for one, or no step has finished yet.") as never;
    return new Response(Bun.file(preview), { status: 200, headers: { "content-type": "image/jpeg", "cache-control": "no-store", "content-length": String(statSync(preview).size) } }) as never;
  }
  const match = /^(\d{1,2})\.(png|thumb\.jpg)$/.exec(file);
  if (!match || !isJobId(job)) return fail(c, 404, "expired", "That picture is gone: results are kept for a day, or Home deleted them. Make it again.") as never;
  const index = Number(match[1]);
  const path = match[2] === "png" ? pngPath(job, index) : thumbPath(job, index);
  if (!existsSync(path)) return fail(c, 404, "expired", "That picture is gone: results are kept for a day, or Home deleted them. Make it again.") as never;
  return new Response(Bun.file(path), { status: 200, headers: { "content-type": match[2] === "png" ? "image/png" : "image/jpeg", "cache-control": "no-store", "content-length": String(statSync(path).size) } }) as never;
});

imageV1Routes.openapi(deleteRoute, (c) => {
  const id = c.req.valid("param").job;
  const job = getJob(id);
  if (job && isImageKind(job) && (job.state === "queued" || job.state === "running" || job.state === "stalled")) { cancelJob(id); unstashImage(String((job.input as { token?: string } | null)?.token ?? "")); return reply(c, { job: id, state: "cancelled" }, 200); }
  if (deleteResult(id)) return reply(c, { job: id, state: "deleted" }, 200);
  if (job && isImageKind(job)) return reply(c, { job: id, state: job.state === "failed" ? "failed" : "deleted" }, 200);
  return fail(c, 404, "unknown_job", "No such picture job.");
});
