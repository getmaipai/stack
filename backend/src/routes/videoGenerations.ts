// POST /v1/videos/generations and the job it makes (VIDEO-GEN-02). The same
// job API as images: the clip is submitted, the reply waits up to timeout_ms,
// and past the deadline answers 202 with the job id for Home to come back to.
// Progress is by phase; cancel stops the worker and frees its memory; the
// finished clip (H.264 mp4 and a JPEG poster) is fetched by URL from the
// result store. Home owns who may call this and with what: it applies the age
// band, the surface, the household-name gate and the LoRA rules, then passes
// down the audience and the allowed LoRA list; the Stack applies the hard
// limits and the locks it can check (see video/videoGen.ts).
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { existsSync, statSync } from "node:fs";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { identityHeaders } from "@/lib/identity";
import { RoleReplyHeaders } from "@maipai/spec/stack/ts/role-reply-headers.js";
import { cancelJob, getJob, hasJobRunner, listJobs, submitJob, waitForJob, type Job } from "@/lib/jobs";
import { LoraError, resolveLoras } from "@/video/loras";
import { wasGeneratedHere } from "@/video/provenance";
import { deleteResult, isJobId, posterPath, readResult, videoPath, type VideoResultMeta } from "@/video/results";
import { memoryVerdict, tierAvailability, VIDEO_DEFAULT_SIZE, VIDEO_FPS, VIDEO_MAX_PIXELS, VIDEO_MAX_PROMPT_CHARS, VIDEO_MAX_REFERENCE_BYTES, VIDEO_MAX_SECONDS, VIDEO_MIN_SIDE, VIDEO_QUEUE_MAX, VIDEO_SIZE_STEP, videoGen } from "@/video/videoGen";
import { stashClip, unstashClip, videoFailure, videoProgress, VIDEO_JOB_KIND } from "@/video/jobs";

const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 30 * 60_000;

const LoraEntry = z.object({ id: z.string().max(40), strength: z.number().min(0).max(2).optional() });
const VideoRequestSchema = z.object({
  model: z.string().optional().openapi({ description: "Accepted for symmetry with the other job routes; this route always serves the video role.", example: "video" }),
  prompt: z.string().trim().min(1).max(VIDEO_MAX_PROMPT_CHARS),
  negative_prompt: z.string().max(VIDEO_MAX_PROMPT_CHARS).optional().openapi({ description: "Accepted. The distilled FastWan model runs without guidance, so it has no effect on the clip." }),
  image: z.string().optional().openapi({ description: "Image to video: the first frame, base64 (a data: URL is fine), PNG, JPEG or WebP, at most 20 MB. Needs image_source." }),
  image_source: z.enum(["generated", "uploaded"]).optional().openapi({ description: "Where the picture came from, as Home knows it. Only `generated` is accepted, and only for a picture this Stack's own image generator produced (or the poster of one of its clips): the Stack checks the picture's hash. `uploaded` is refused for everyone until a check for \"no identifiable real person\" exists (VIDEO-GEN-12)." }),
  size: z.string().regex(/^\d{3,4}x\d{3,4}$/).optional().openapi({ description: `<width>x<height>, multiples of ${VIDEO_SIZE_STEP}, each side at least ${VIDEO_MIN_SIDE}, area at most ${VIDEO_MAX_PIXELS} pixels (832x480; 480x832 also fits). Default ${VIDEO_DEFAULT_SIZE}.`, example: VIDEO_DEFAULT_SIZE }),
  seconds: z.number().int().min(1).max(VIDEO_MAX_SECONDS).optional().openapi({ description: `Whole seconds, 1 to ${VIDEO_MAX_SECONDS} per tier (24 frames a second plus the first frame). Default ${VIDEO_MAX_SECONDS}.` }),
  seed: z.number().int().min(0).max(4_294_967_295).optional(),
  loras: z.array(LoraEntry).max(4).optional().openapi({ description: "LoRAs from the household library (GET /stack/v1/video/loras) to apply, by id, with a strength of 0 to 2 (the record's default when left out). Home decides which ids this caller may name." }),
  audience: z.enum(["all-ages", "adult"]).optional().openapi({ description: "Who the clip is for, set by Home from the person's age band and the surface. Default all-ages. An adult-only LoRA in the list with audience all-ages is refused (422 lora_not_allowed)." }),
  timeout_ms: z.number().int().positive().max(MAX_WAIT_MS).optional().openapi({ description: `How long this request waits for the clip before answering 202 with the job id. Default ${DEFAULT_WAIT_MS}. A clip takes about two to three minutes.` }),
});
const VideoDataSchema = z.object({
  url: z.string().openapi({ description: "GET this for the mp4 (H.264, yuv420p, 24 fps, no sound). Supports Range requests." }),
  poster_url: z.string().openapi({ description: "GET this for the JPEG of frame 0." }),
  content_type: z.literal("video/mp4"),
  width: z.number().int(), height: z.number().int(), frames: z.number().int(), fps: z.number().int(), seconds: z.number().int(), seed: z.number().int(),
  model: z.string(), mode: z.enum(["text-to-video", "image-to-video"]), lora_ids: z.array(z.string()), ms: z.number().int(), bytes: z.number().int(), poster_bytes: z.number().int(),
});
const VideoResponseSchema = z.object({ created: z.number().int(), job: z.string(), data: z.array(VideoDataSchema) });
const ErrorBody = z.object({ error: z.string(), code: z.string(), job: z.string().optional() });
const JobStatusSchema = z.object({
  job: z.string(),
  state: z.enum(["queued", "running", "done", "failed", "cancelled"]),
  phase: z.string().openapi({ description: "queued, waiting for memory, starting, setting up (first clip only), loading, rendering, decoding, encoding, ready; failed or cancelled when it ended so." }),
  progress: z.number().int().openapi({ description: "0 to 100 over the whole clip, weighted by where the time goes (decoding is most of it)." }),
  phase_progress: z.number().int().nullable().openapi({ description: "0 to 100 inside the current phase, when the phase has one." }),
  position: z.number().int().nullable().openapi({ description: "Place in line while queued (1 is next)." }),
  error: z.string().nullable(), code: z.string().nullable(),
  data: z.array(VideoDataSchema),
});

const postRoute = createRoute({ method: "post", path: "/generations", tags: ["Video"], summary: "Make a clip (the job API with a wait)", request: { body: { content: { "application/json": { schema: VideoRequestSchema } } } }, responses: {
  200: { content: { "application/json": { schema: VideoResponseSchema } }, description: "The clip is ready; `data[0].url` is where to fetch it." },
  202: { content: { "application/json": { schema: VideoResponseSchema } }, description: "Still going past timeout_ms (`data` is empty); poll GET /v1/videos/generations/{job}." },
  413: { content: { "application/json": { schema: ErrorBody } }, description: "The reference picture is larger than 20 MB." },
  422: { content: { "application/json": { schema: ErrorBody } }, description: "The request cannot be done: bad_size, bad_image, reference_source_required, reference_image_refused, reference_not_generated, unknown_lora, wrong_base_model, lora_not_allowed, too_many_loras, bad_strength; `error` says what to change." },
  429: { content: { "application/json": { schema: ErrorBody } }, description: "Four clips are already waiting; try again when one finishes." },
  499: { content: { "application/json": { schema: ErrorBody } }, description: "The job was cancelled." },
  500: { content: { "application/json": { schema: ErrorBody } }, description: "The clip failed (failed, worker_stopped)." },
  503: { content: { "application/json": { schema: ErrorBody } }, description: "Video is off on this computer (not_available_on_this_computer, unsupported), not installed (not_installed), or there is no free memory for it (no_memory)." },
  504: { content: { "application/json": { schema: ErrorBody } }, description: "The clip took longer than 15 minutes and was stopped." },
} });
const getRoute = createRoute({ method: "get", path: "/generations/{job}", tags: ["Video"], summary: "A clip's state, progress and files", request: { params: z.object({ job: z.string() }) }, responses: {
  200: { content: { "application/json": { schema: JobStatusSchema } }, description: "Poll this every second or two while state is queued or running." },
  404: { content: { "application/json": { schema: ErrorBody } }, description: "No such job (it expired or never existed)." },
} });
const videoFileRoute = createRoute({ method: "get", path: "/generations/{job}/video.mp4", tags: ["Video"], summary: "The finished clip (Range requests supported)", request: { params: z.object({ job: z.string() }) }, responses: {
  200: { content: { "video/mp4": { schema: z.string().openapi({ format: "binary" }) } }, description: "The mp4." },
  206: { content: { "video/mp4": { schema: z.string().openapi({ format: "binary" }) } }, description: "A byte range of the mp4." },
  404: { content: { "application/json": { schema: ErrorBody } }, description: "The clip is gone: results are kept for a day, or Home deleted it." },
} });
const posterFileRoute = createRoute({ method: "get", path: "/generations/{job}/poster.jpg", tags: ["Video"], summary: "The poster frame", request: { params: z.object({ job: z.string() }) }, responses: {
  200: { content: { "image/jpeg": { schema: z.string().openapi({ format: "binary" }) } }, description: "The JPEG of frame 0." },
  404: { content: { "application/json": { schema: ErrorBody } }, description: "The poster is gone." },
} });
const deleteRoute = createRoute({ method: "delete", path: "/generations/{job}", tags: ["Video"], summary: "Cancel a clip, or delete a finished one's files", request: { params: z.object({ job: z.string() }) }, responses: {
  200: { content: { "application/json": { schema: z.object({ job: z.string(), state: z.enum(["cancelled", "deleted", "failed"]) }) } }, description: "A queued or running clip is cancelled (the worker stops and its memory returns); a finished clip's files are deleted (Home calls this once it has stored the file)." },
  404: { content: { "application/json": { schema: ErrorBody } }, description: "No such job." },
} });

function reply<T extends Context>(c: T, body: unknown, status: number) {
  for (const [name, value] of Object.entries(RoleReplyHeaders.parse(identityHeaders(null)))) c.header(name, value);
  return c.json(body as never, status as never);
}
const fail = <T extends Context>(c: T, status: number, code: string, error: string, job?: string) => reply(c, { error, code, ...(job ? { job } : {}) }, status);

function entry(meta: VideoResultMeta) {
  return { url: `/v1/videos/generations/${meta.job}/video.mp4`, poster_url: `/v1/videos/generations/${meta.job}/poster.jpg`, content_type: "video/mp4" as const, width: meta.width, height: meta.height, frames: meta.frames, fps: meta.fps, seconds: meta.seconds, seed: meta.seed, model: meta.model, mode: meta.mode, lora_ids: meta.lora_ids, ms: meta.ms, bytes: meta.bytes, poster_bytes: meta.poster_bytes };
}

/** "832x480" to width and height, or the sentence to return. */
export function parseVideoSize(size: string | undefined): { width: number; height: number } | string {
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(size ?? VIDEO_DEFAULT_SIZE);
  if (!match) return `The size must look like ${VIDEO_DEFAULT_SIZE}.`;
  const width = Number(match[1]); const height = Number(match[2]);
  if (width % VIDEO_SIZE_STEP || height % VIDEO_SIZE_STEP) return `Width and height must be multiples of ${VIDEO_SIZE_STEP} (832x480 is the default).`;
  if (width < VIDEO_MIN_SIDE || height < VIDEO_MIN_SIDE) return `Each side must be at least ${VIDEO_MIN_SIDE} pixels.`;
  if (width * height > VIDEO_MAX_PIXELS) return `That size is larger than this computer makes. The most is 832x480 (or 480x832): ${VIDEO_MAX_PIXELS} pixels.`;
  return { width, height };
}

/** Bytes of a base64 or data: URL picture, or null when it is not valid base64. */
function decodeImage(value: string): Uint8Array | null {
  const raw = value.startsWith("data:") ? value.slice(value.indexOf(",") + 1) : value;
  if (raw.length === 0 || raw.length % 4 === 1 || /[^A-Za-z0-9+/=\s]/.test(raw)) return null;
  try { const bytes = Buffer.from(raw, "base64"); return bytes.length > 0 ? new Uint8Array(bytes) : null; } catch { return null; }
}
function looksLikePicture(bytes: Uint8Array): boolean {
  const png = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  return png || jpeg || webp;
}

function activeClips(): number { return listJobs().filter((job) => job.kind === VIDEO_JOB_KIND && (job.state === "queued" || job.state === "running" || job.state === "stalled")).length; }

function statusOf(job: Job) {
  const detail = videoProgress(job.id);
  const failure = videoFailure(job.id);
  const state = job.state === "stalled" ? "running" : job.state;
  const phase = state === "queued" ? "queued" : state === "done" ? "ready" : state === "failed" || state === "cancelled" ? state : detail?.phase ?? (job.status.startsWith("waiting for memory") ? "waiting for memory" : job.status);
  const result = job.state === "done" ? readResult(job.id) : null;
  return {
    job: job.id, state, phase, progress: Math.round(job.percent), phase_progress: state === "running" && detail ? Math.round(detail.phasePercent) : null, position: job.state === "queued" ? job.position : null,
    error: job.state === "failed" ? failure?.message ?? job.reason ?? "The clip failed." : job.state === "cancelled" ? "The clip was cancelled." : null,
    code: job.state === "failed" ? failure?.code ?? "failed" : job.state === "cancelled" ? "cancelled" : null,
    data: result ? [entry(result)] : [],
  };
}

export const videoV1Routes = apiRouter<AppEnv>();

videoV1Routes.openapi(postRoute, async (c) => {
  const body = c.req.valid("json");
  const availability = tierAvailability();
  if (!availability.available) return fail(c, 503, availability.code ?? "unsupported", availability.reason ?? "Video is not available on this computer.");
  if (!hasJobRunner(VIDEO_JOB_KIND)) return fail(c, 503, "unsupported", "Video is not available on this machine.");
  const size = parseVideoSize(body.size);
  if (typeof size === "string") return fail(c, 422, "bad_size", size);
  const seconds = body.seconds ?? VIDEO_MAX_SECONDS;
  let image: Uint8Array | null = null;
  if (body.image !== undefined) {
    if (!body.image_source) return fail(c, 422, "reference_source_required", "Say where the picture came from (image_source). Only a picture the Stack's image generator made can start a clip.");
    if (body.image_source !== "generated") return fail(c, 422, "reference_image_refused", "A clip cannot start from an uploaded picture or a photo of a person yet. Make a picture with the image generator and start the clip from that.");
    image = decodeImage(body.image);
    if (!image) return fail(c, 422, "bad_image", "The picture could not be read. Send a PNG, JPEG or WebP as base64.");
    if (image.length > VIDEO_MAX_REFERENCE_BYTES) return fail(c, 413, "too_large", `The picture is larger than ${VIDEO_MAX_REFERENCE_BYTES / 1024 / 1024} MB.`);
    if (!looksLikePicture(image)) return fail(c, 422, "bad_image", "The picture could not be read. Send a PNG, JPEG or WebP as base64.");
    if (!wasGeneratedHere(image)) return fail(c, 422, "reference_not_generated", "That picture was not made by this computer's image generator, so it cannot start a clip. Make a picture with the image generator and start the clip from that, unchanged.");
  }
  let loras;
  try { loras = await resolveLoras(body.loras, body.audience ?? "all-ages"); } catch (error) {
    if (error instanceof LoraError) return fail(c, error.status === 404 ? 422 : error.status, error.code, error.message);
    throw error;
  }
  if (!videoGen.hasModels()) return fail(c, 503, "not_installed", "The video model is not installed yet. Install it from Home's Engines page, then try again.");
  if (activeClips() >= VIDEO_QUEUE_MAX) return fail(c, 429, "queue_full", `${VIDEO_QUEUE_MAX} clips are already waiting. Try again when one finishes.`);
  const verdict = memoryVerdict();
  if (!verdict.ok) return fail(c, 503, "no_memory", verdict.reason);
  const seed = body.seed ?? Math.floor(Math.random() * 2 ** 32);
  const frames = seconds * VIDEO_FPS + 1;
  const token = crypto.randomUUID();
  const loraIds = loras.map((lora) => lora.record.id);
  stashClip(token, { prompt: body.prompt, negativePrompt: body.negative_prompt ?? null, image, width: size.width, height: size.height, frames, seed, loras: loras.map((lora) => [lora.path, lora.strength]), loraIds });
  const submitted = submitJob({ kind: VIDEO_JOB_KIND, role: "video", input: { token, size: `${size.width}x${size.height}`, seconds, seed, mode: image ? "image-to-video" : "text-to-video", lora_ids: loraIds } });
  if ("refused" in submitted) return fail(c, 503, "unsupported", submitted.reason);
  const settled = await waitForJob(submitted.job.id, body.timeout_ms ?? DEFAULT_WAIT_MS);
  const created = Math.floor(new Date(submitted.job.createdAt).getTime() / 1000);
  if (!settled || settled.state === "queued" || settled.state === "running" || settled.state === "stalled") return reply(c, { created, job: submitted.job.id, data: [] }, 202);
  if (settled.state === "cancelled") return fail(c, 499, "cancelled", "The clip was cancelled.", settled.id);
  if (settled.state !== "done") {
    const failure = videoFailure(settled.id);
    return fail(c, failure?.status ?? 500, failure?.code ?? "failed", failure?.message ?? settled.reason ?? "The clip failed.", settled.id);
  }
  const meta = readResult(settled.id);
  if (!meta) return fail(c, 500, "expired", "The clip is no longer held. Make it again.", settled.id);
  return reply(c, { created, job: settled.id, data: [entry(meta)] }, 200);
});

videoV1Routes.openapi(getRoute, (c) => {
  const id = c.req.valid("param").job;
  const job = getJob(id);
  // A finished clip whose files are gone (Home deleted them, or a day passed) is gone, not "done with nothing".
  if (job && job.kind === VIDEO_JOB_KIND && !(job.state === "done" && !readResult(id))) return reply(c, statusOf(job), 200);
  // After a restart the job record is gone but a finished clip is still on disk.
  const meta = readResult(id);
  if (meta) return reply(c, { job: id, state: "done", phase: "ready", progress: 100, phase_progress: null, position: null, error: null, code: null, data: [entry(meta)] }, 200);
  return fail(c, 404, "unknown_job", "No such clip: it expired after a day, was deleted, or never existed.");
});

function fileResponse(c: Context, path: string, type: string, range: string | undefined): Response {
  const size = statSync(path).size;
  const headers: Record<string, string> = { "content-type": type, "cache-control": "no-store", "accept-ranges": "bytes" };
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (match && (match[1] !== "" || match[2] !== "")) {
    let start = match[1] === "" ? size - Number(match[2]) : Number(match[1]);
    let end = match[1] === "" || match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
    start = Math.max(0, start); end = Math.max(start, end);
    if (start >= size) return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
    return new Response(Bun.file(path).slice(start, end + 1), { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) } });
  }
  void c;
  return new Response(Bun.file(path), { status: 200, headers: { ...headers, "content-length": String(size) } });
}

videoV1Routes.openapi(videoFileRoute, (c) => {
  const id = c.req.valid("param").job;
  if (!isJobId(id) || !existsSync(videoPath(id))) return fail(c, 404, "expired", "That clip is gone: results are kept for a day, or Home deleted it. Make it again.") as never;
  return fileResponse(c, videoPath(id), "video/mp4", c.req.header("range")) as never;
});
videoV1Routes.openapi(posterFileRoute, (c) => {
  const id = c.req.valid("param").job;
  if (!isJobId(id) || !existsSync(posterPath(id))) return fail(c, 404, "expired", "That poster is gone: results are kept for a day, or Home deleted it.") as never;
  return fileResponse(c, posterPath(id), "image/jpeg", undefined) as never;
});

videoV1Routes.openapi(deleteRoute, (c) => {
  const id = c.req.valid("param").job;
  const job = getJob(id);
  if (job && job.kind === VIDEO_JOB_KIND && (job.state === "queued" || job.state === "running" || job.state === "stalled")) { cancelJob(id); unstashClip(String((job.input as { token?: string } | null)?.token ?? "")); return reply(c, { job: id, state: "cancelled" }, 200); }
  if (deleteResult(id)) return reply(c, { job: id, state: "deleted" }, 200);
  if (job && job.kind === VIDEO_JOB_KIND) return reply(c, { job: id, state: job.state === "failed" ? "failed" : "deleted" }, 200);
  return fail(c, 404, "unknown_job", "No such clip.");
});
