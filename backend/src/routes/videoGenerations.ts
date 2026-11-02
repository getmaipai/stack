// POST /v1/videos/generations and the job it makes (VIDEO-GEN-02). The same
// job API as images: the clip is submitted, the reply waits up to timeout_ms,
// and past the deadline answers 202 with the job id for Home to come back to.
// Progress is by phase; cancel stops the worker and frees its memory; the
// finished clip (H.264 mp4 and a JPEG poster) is fetched by URL from the
// result store. Home owns who may call this and with what: it applies the age
// band, the surface, the household-name gate and the LoRA rules, then passes
// down the audience and the allowed LoRA list; the Stack applies the hard
// limits and the locks it can check (see video/videoGen.ts).
import { PAUSED_LOW_MEMORY } from "@/lib/memoryState";
import { adultInput, fullViewAllowed, isAdultJobId } from "@/lib/adultView";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";
import { MessagesError, makeMessagesCopy } from "@/video/messages";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { identityHeaders } from "@/lib/identity";
import { RoleReplyHeaders } from "@maipai/spec/stack/ts/role-reply-headers.js";
import { MAX_DRAIN_STATUS, MAX_WAIT_STATUS, cancelJob, getJob, hasJobRunner, isJobPaused, listJobs, submitJob, waitForJob, type Job } from "@/lib/jobs";
import { TierFieldSchema, TierStatusSchema, governorDecides, tierInput, tierOf } from "@/routes/tierField";
import { PAUSED_LABEL } from "@/lib/genProgress";
import { LoraError, resolveLoras } from "@/video/loras";
import { deleteResult, isJobId, messagesPath, posterPath, readResult, videoPath, type VideoResultMeta } from "@/video/results";
import { memoryVerdict, qualityOfModelName, tierAvailability, VIDEO_DEFAULT_SIZE, VIDEO_FPS, VIDEO_MAX_PIXELS, VIDEO_MAX_PROMPT_CHARS, VIDEO_MAX_REFERENCE_BYTES, VIDEO_MAX_SECONDS, VIDEO_MIN_SIDE, VIDEO_QUEUE_MAX, VIDEO_SIZE_STEP, VIDEO_SPECS, videoGen, videoGenRoot, type VideoQuality } from "@/video/videoGen";
import { ltx25MaxPeakBytes, ltx25MaxRefusal, ltx25MaxRow, ltx25PeakBytes, ltx25Refusal, ltx25Row, ltx25TrueSize, LTX25_MAX_MEASURED, LTX25_MEASURED } from "@/video/ltx25";
import { checkEdit, EditSourceError, editRuntime, ltx25EditAdmitBytes, ltx25MaxEditSupported, LTX25_EDIT_EXTEND_MAX_SECONDS, LTX25_EDIT_EXTEND_MIN_SECONDS, LTX25_EDIT_RETAKE_MAX_SECONDS, LTX25_EDIT_RETAKE_MIN_SECONDS, LTX25_MAX_EDIT_MEASURED, planSource, probeSource, type Ltx25EditKind } from "@/video/ltx25Edit";
import { MediaPathError, resolveReadable } from "@/media/paths";
import { stashClip, unstashClip, videoFailure, videoPreviewPath, videoProgress, videoTracker, VIDEO_JOB_KIND, type StashedClip } from "@/video/jobs";

const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 30 * 60_000;

const LoraEntry = z.object({ id: z.string().max(40), strength: z.number().min(0).max(2).optional() });
const VideoRequestSchema = z.object({
  model: z.string().optional().openapi({ description: "Which video model: `video` or `quick` (the default, a silent clip of up to 5 s, which can start from a picture) or `detailed` (LTX-2.3: a sound track with speech made in the same pass, up to 10 s, which can start from a picture too) or `ltx25-q8` (LTX-2.5 distilled q8: a sound track with speech made in the same pass, from words or a first picture and an optional last one (`image`, `end_image`), only the measured sizes and lengths of GET /stack/v1/video qualities.ltx25.profiles). or `ltx25-max` (LTX-2.5 Max: the dgrauet runtime and the bf16 distilled pack, 1024x576 up to 10 s with a sound track and speech, from words or a first picture and an optional last one; see GET /stack/v1/video qualities.ltx25max.profiles). A model's own id names it too. An unknown name is refused (unknown_model); a model that is not installed answers 503 not_installed.", example: "quick" }),
  prompt: z.string().trim().min(1).max(VIDEO_MAX_PROMPT_CHARS),
  negative_prompt: z.string().max(VIDEO_MAX_PROMPT_CHARS).optional().openapi({ description: "Accepted. The distilled FastWan model runs without guidance, so it has no effect on the clip." }),
  image: z.string().optional().openapi({ description: "Image to video: the first frame, base64 (a data: URL is fine), PNG, JPEG or WebP, at most 20 MB. image_source is optional. On `ltx25-q8` and `ltx25-max` the picture is the first frame: it is fitted to the clip's true size (scaled to fill, centre-cropped, never stretched) by the Stack." }),
  end_image: z.string().optional().openapi({ description: "Image to video, last frame: a second picture the clip ends on, same encoding, types and 20 MB limit as `image`. Needs `image` (422 bad_image without it). Only `ltx25-q8` and `ltx25-max` take one; Quick and Detailed answer 422 reference_unsupported." }),
  size: z.string().regex(/^\d{3,4}x\d{3,4}$/).optional().openapi({ description: `<width>x<height>. Quick: multiples of ${VIDEO_SIZE_STEP}, area at most ${VIDEO_MAX_PIXELS} pixels (832x480; 480x832 also fits), default ${VIDEO_DEFAULT_SIZE}. Detailed: multiples of 64, area at most 768 x 448 (448x768 also fits), default 768x448. ltx25-q8: only 512x256 (up to 10 s), 640x320 and 768x448 (up to 5 s); the nominal 512x288 and 640x352 are accepted and made at the true size, which the reply reports; anything else is refused (bad_size). ltx25-max: only 1024x576 (up to 10 s). Each side at least ${VIDEO_MIN_SIDE}.`, example: VIDEO_DEFAULT_SIZE }),
  source_video: z.string().min(1).max(4096).optional().openapi({ description: "LTX25-EDIT-01, `ltx25-max` only: an absolute path to the clip to edit, a file inside a media folder Home declared (or the Stack's media job folder), the same rule `media.edit` uses for its inputs, so a clip of 100s of MB is never sent as base64. Needs exactly one of `extend_seconds` and `retake_from_seconds`. The Stack reads it, never changes it, and keeps no copy past the job. The source must have a picture and a sound track, be 25 to 241 frames (about 1 to 10 seconds), and be at least 768x448: a source that is not on the measured size table or not at 24 a second is re-made by the Stack's ffmpeg first (scaled to fill and centre-cropped, never stretched), and the result carries the true size. Refusals are 422 `bad_source`, `bad_source_audio`, `source_not_found` and the media path codes." }),
  extend_seconds: z.number().min(LTX25_EDIT_EXTEND_MIN_SECONDS).max(LTX25_EDIT_EXTEND_MAX_SECONDS).optional().openapi({ description: `LTX25-EDIT-01: add this many seconds after the source (${LTX25_EDIT_EXTEND_MIN_SECONDS} to ${LTX25_EDIT_EXTEND_MAX_SECONDS}), continuing its picture and speech from \`prompt\`. Mapped to ceil(seconds x 24 / 8) latent frames of 8 pixel frames each, so a whole number of seconds adds exactly that many (1 s is 3 latent frames, 6 s is 18). The source is kept as it is (re-decoded, about 39.5 dB PSNR against the source) and the new part follows it with no visible seam. Needs \`source_video\` and \`model\` \`ltx25-max\`; excludes \`retake_from_seconds\`.` }),
  retake_from_seconds: z.number().min(LTX25_EDIT_RETAKE_MIN_SECONDS).max(LTX25_EDIT_RETAKE_MAX_SECONDS).optional().openapi({ description: `LTX25-EDIT-01: regenerate the source from this second to its end (${LTX25_EDIT_RETAKE_MIN_SECONDS} to ${LTX25_EDIT_RETAKE_MAX_SECONDS}), picture and speech, from \`prompt\`; the part before it is kept (about 39.7 dB PSNR). The first latent frame at floor(seconds x 24 / 8) is where the new part starts; the end is always the clip end. A start at or past the clip end is 422 \`bad_retake\`. Needs \`source_video\` and \`model\` \`ltx25-max\`; excludes \`extend_seconds\`.` }),
  preview: z.boolean().optional().openapi({ description: "Default true. While the clip runs, the status carries `preview_url`: the first frame of the clip (JPEG, up to 480 px on the long side), drawn from the finished motion the moment the long frame-building stage starts. Pass false to skip it (it costs about a second)." }),
  seconds: z.number().int().min(1).max(VIDEO_SPECS.detailed.maxSeconds).optional().openapi({ description: `Whole seconds (24 frames a second plus the first frame). Quick: 1 to ${VIDEO_MAX_SECONDS}, default ${VIDEO_MAX_SECONDS}. Detailed: 1 to ${VIDEO_SPECS.detailed.maxSeconds}, default 5. A number past the chosen model ceiling is refused (bad_seconds).` }),
  seed: z.number().int().min(0).max(4_294_967_295).optional(),
  loras: z.array(LoraEntry).max(4).optional().openapi({ description: "LoRAs from the household library (GET /stack/v1/video/loras) to apply, by id, with a strength of 0 to 2 (the record's default when left out). Home decides which ids this caller may name." }),
  audience: z.enum(["all-ages", "adult"]).optional().openapi({ description: "Who the clip is for, set by Home from the person's age band and the surface. Default all-ages. An adult-only LoRA in the list with audience all-ages is refused (422 lora_not_allowed)." }),
  timeout_ms: z.number().int().positive().max(MAX_WAIT_MS).optional().openapi({ description: `How long this request waits for the clip before answering 202 with the job id. Default ${DEFAULT_WAIT_MS}. A clip takes about two to three minutes.` }),
  tier: TierFieldSchema,
  quiet_seconds: z.number().int().min(20).max(3600).optional(),
  quiet_max_wait_seconds: z.number().int().min(0).max(86400).nullable().optional(),
});
const VideoDataSchema = z.object({
  url: z.string().openapi({ description: "GET this for the mp4 (H.264, yuv420p, 24 fps; a Detailed clip has an AAC sound track the model made, a Quick clip a silent one). Supports Range requests." }),
  poster_url: z.string().openapi({ description: "GET this for the JPEG of frame 0." }),
  content_type: z.literal("video/mp4"),
  width: z.number().int(), height: z.number().int(), frames: z.number().int(), fps: z.number().int(), seconds: z.number().int(), seed: z.number().int(),
  model: z.string(), quality: z.enum(["quick", "detailed", "ltx25", "ltx25max"]), audio: z.boolean().openapi({ description: "The clip has a sound track the model made (Detailed). A Quick clip carries a silent track and answers false." }), mode: z.enum(["text-to-video", "image-to-video", "extend", "retake"]), lora_ids: z.array(z.string()), ms: z.number().int(), bytes: z.number().int(), poster_bytes: z.number().int(),
});
const VideoResponseSchema = z.object({ created: z.number().int(), job: z.string(), data: z.array(VideoDataSchema) });
const ErrorBody = z.object({ error: z.string(), code: z.string(), job: z.string().optional() });
const JobStatusSchema = z.object({
  job: z.string(),
  state: z.enum(["queued", "running", "done", "failed", "cancelled"]),
  phase: z.string().openapi({ description: "queued, waiting for memory, waiting for running jobs (a Max job waits for the running ones to end), waiting for the computer (a Max job waits for the computer to be free enough), starting, setting up (first clip only), loading, rendering, decoding, encoding, ready; failed or cancelled when it ended so." }),
  progress: z.number().int().openapi({ description: "0 to 100 over the whole clip, weighted by where the time goes (decoding is most of it)." }),
  phase_progress: z.number().int().nullable().openapi({ description: "0 to 100 inside the current phase, when the phase has one." }),
  progress_fraction: z.number().nullable().openapi({ description: "0 to 1 over the whole clip, weighted by measured stage times; it moves inside a stage even when the engine reports no count." }),
  stage: z.string().nullable().openapi({ description: "load_text, plan, load_model, motion, frames or save while running; null otherwise." }),
  stage_label: z.string().nullable().openapi({ description: "The stage in words a person reads (\"Putting the frames together, part 5 of 12\")." }),
  step: z.number().int().nullable().openapi({ description: "Motion steps finished, while the stage is `motion`." }),
  steps: z.number().int().nullable().openapi({ description: "Motion steps in all, while the stage is `motion`." }),
  eta_seconds: z.number().int().nullable().openapi({ description: "Whole seconds left, from the medians of earlier clips of the same size and length (a built-in 130 s total until there are some); null until a stage is known." }),
  preview_url: z.string().nullable().openapi({ description: "GET this for the first-frame preview JPEG while running; null until the motion is done, when the request asked for none, or after the job ended (the finished clip has `poster_url`)." }),
  position: z.number().int().nullable().openapi({ description: "Place in line while queued (1 is next)." }),
  tier: TierStatusSchema,
  error: z.string().nullable(), code: z.string().nullable(),
  data: z.array(VideoDataSchema),
});

const postRoute = createRoute({ method: "post", path: "/generations", tags: ["Video"], summary: "Make a clip (the job API with a wait)", request: { body: { content: { "application/json": { schema: VideoRequestSchema } } } }, responses: {
  200: { content: { "application/json": { schema: VideoResponseSchema } }, description: "The clip is ready; `data[0].url` is where to fetch it." },
  202: { content: { "application/json": { schema: VideoResponseSchema } }, description: "Still going past timeout_ms (`data` is empty); poll GET /v1/videos/generations/{job}." },
  413: { content: { "application/json": { schema: ErrorBody } }, description: "The reference picture is larger than 20 MB." },
  422: { content: { "application/json": { schema: ErrorBody } }, description: "The request cannot be done: bad_size, bad_image, unknown_lora, wrong_base_model, lora_not_allowed, too_many_loras, bad_strength; `error` says what to change." },
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
const previewFileRoute = createRoute({ method: "get", path: "/generations/{job}/preview.jpg", tags: ["Video"], summary: "The first-frame preview while a clip is being made", request: { params: z.object({ job: z.string() }) }, responses: {
  200: { content: { "image/jpeg": { schema: z.string().openapi({ format: "binary" }) } }, description: "The preview." },
  404: { content: { "application/json": { schema: ErrorBody } }, description: "No preview: the motion is not done yet, none was asked for, or the clip finished." },
} });
const posterFileRoute = createRoute({ method: "get", path: "/generations/{job}/poster.jpg", tags: ["Video"], summary: "The poster frame", request: { params: z.object({ job: z.string() }) }, responses: {
  200: { content: { "image/jpeg": { schema: z.string().openapi({ format: "binary" }) } }, description: "The JPEG of frame 0." },
  404: { content: { "application/json": { schema: ErrorBody } }, description: "The poster is gone." },
} });
const MessagesTitle = z.object({ title: z.string().max(120).optional().openapi({ description: "The title written into the file (the clip's name in a share sheet). Default: MaiPai video." }) });
const messagesFileRoute = createRoute({ method: "get", path: "/generations/{job}/messages.mp4", tags: ["Video"], summary: "The clip prepared for messaging apps (made on first request, then kept)", request: { params: z.object({ job: z.string() }), query: MessagesTitle }, responses: {
  200: { content: { "video/mp4": { schema: z.string().openapi({ format: "binary" }) } }, description: "H.264 yuv420p mp4 with a silent AAC track, the moov box first, a title, at most 20 MB. New clips are already in this form; this makes it for a clip made before." },
  404: { content: { "application/json": { schema: ErrorBody } }, description: "The clip is gone." },
  422: { content: { "application/json": { schema: ErrorBody } }, description: "The clip cannot be prepared (too_large)." },
  503: { content: { "application/json": { schema: ErrorBody } }, description: "The video tools are not installed (no_ffmpeg)." },
} });
const messagesConvertRoute = createRoute({ method: "post", path: "/messages", tags: ["Video"], summary: "Prepare any mp4 for messaging apps (stateless; nothing is kept)", request: { headers: z.object({ "x-title": z.string().max(400).optional().openapi({ description: "The title written into the file, percent-encoded (default: MaiPai video). A header, never the URL: it comes from a prompt." }) }), body: { content: { "video/mp4": { schema: z.string().openapi({ format: "binary" }) } }, required: true } }, responses: {
  200: { content: { "video/mp4": { schema: z.string().openapi({ format: "binary" }) } }, description: "The same picture as an H.264 yuv420p mp4 with a silent AAC track (kept when it has one), the moov box first, a title, at most 20 MB. For a clip Home stored before the Stack made them this way." },
  413: { content: { "application/json": { schema: ErrorBody } }, description: "The upload is larger than 100 MB." },
  422: { content: { "application/json": { schema: ErrorBody } }, description: "Not a video (bad_clip) or still over 20 MB (too_large)." },
  503: { content: { "application/json": { schema: ErrorBody } }, description: "The video tools are not installed (no_ffmpeg)." },
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
  return { url: `/v1/videos/generations/${meta.job}/video.mp4`, poster_url: `/v1/videos/generations/${meta.job}/poster.jpg`, content_type: "video/mp4" as const, width: meta.width, height: meta.height, frames: meta.frames, fps: meta.fps, seconds: meta.seconds, seed: meta.seed, model: meta.model, quality: meta.quality ?? "quick", audio: meta.audio === true, mode: meta.mode, lora_ids: meta.lora_ids, ms: meta.ms, bytes: meta.bytes, poster_bytes: meta.poster_bytes };
}

/** "832x480" to width and height, or the sentence to return. */
export function parseVideoSize(size: string | undefined, quality: VideoQuality = "quick"): { width: number; height: number } | string {
  const spec = VIDEO_SPECS[quality];
  if (quality === "ltx25max") {
    // Max: the one measured size (video/ltx25.ts, LTX25_MAX_MEASURED).
    const found = /^(\d{3,4})x(\d{3,4})$/.exec(size ?? spec.defaultSize);
    if (!found || !ltx25MaxRow(Number(found[1]), Number(found[2])) || Number(found[1]) % 64 || Number(found[2]) % 64) return `The Max video model makes ${LTX25_MAX_MEASURED.map((row) => row.size).join(", ")} only. Pick that size.`;
    return { width: Number(found[1]), height: Number(found[2]) };
  }
  if (quality === "ltx25") {
    // Only the measured sizes (video/ltx25.ts); anything else is refused with the list.
    const found = /^(\d{3,4})x(\d{3,4})$/.exec(size ?? spec.defaultSize);
    if (!found || Number(found[1]) % 32 || Number(found[2]) % 32 || !ltx25Row(Number(found[1]), Number(found[2]))) return `This video model makes ${LTX25_MEASURED.map((row) => row.size).join(", ")}; a height between is rounded down to a multiple of 64 (512x288 gives 512x256). Pick one of those sizes.`;
    // The clip is made, kept and reported at its true size.
    return ltx25TrueSize(Number(found[1]), Number(found[2]));
  }
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(size ?? spec.defaultSize);
  if (!match) return `The size must look like ${spec.defaultSize}.`;
  const width = Number(match[1]); const height = Number(match[2]);
  if (width % spec.sizeStep || height % spec.sizeStep) return `Width and height must be multiples of ${spec.sizeStep} (${spec.defaultSize} is the default).`;
  if (width < spec.minSide || height < spec.minSide) return `Each side must be at least ${spec.minSide} pixels.`;
  if (width * height > spec.maxPixels) { const [w, h] = spec.defaultSize.split("x"); return `That size is larger than this computer makes. The most is ${spec.defaultSize} (or ${h}x${w}): ${spec.maxPixels} pixels.`; }
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

/** The stage, ETA and preview of a running clip; all null otherwise. */
function liveFields(id: string, running: boolean) {
  const tracker = running ? videoTracker(id) : null;
  const snap = tracker?.snapshot();
  const preview = tracker?.preview && videoPreviewPath(id) ? tracker.preview : null;
  return {
    progress_fraction: snap && tracker!.started ? Math.round(snap.fraction * 1000) / 1000 : null,
    stage: snap?.stage ?? null, stage_label: running && isJobPaused(id) ? PAUSED_LABEL : snap?.stage_label ?? null, step: snap?.step ?? null, steps: snap?.steps ?? null, eta_seconds: running && isJobPaused(id) ? null : snap?.eta_seconds ?? null,
    preview_url: preview ? `/v1/videos/generations/${id}/preview.jpg?v=${preview.version}` : null,
  };
}

/** ADULT-LOCK-04: an adult job's status without the content: state, phase, progress, estimate and place in line stay; the stage words, step counts, preview, failure text and result go. */
function redactStatus<T extends { state: string; error: string | null; data: unknown[]; preview_url: string | null; stage_label: string | null; step: number | null; steps: number | null }>(status: T): T {
  return { ...status, preview_url: null, stage_label: null, step: null, steps: null, data: [], error: status.error === null ? null : status.state === "failed" ? "This job failed." : status.error };
}
function statusOf(job: Job) {
  const detail = videoProgress(job.id);
  const failure = videoFailure(job.id);
  const state = job.state === "stalled" ? "running" : job.state;
  const phase = state === "queued" ? "queued" : state === "done" ? "ready" : state === "cancelled" && job.status === PAUSED_LOW_MEMORY ? PAUSED_LOW_MEMORY : state === "failed" || state === "cancelled" ? state : detail?.phase ?? (job.status.startsWith("waiting for memory") ? "waiting for memory" : job.status === MAX_DRAIN_STATUS ? "waiting for running jobs" : job.status === MAX_WAIT_STATUS ? "waiting for the computer" : job.status);
  const result = job.state === "done" ? readResult(job.id) : null;
  return {
    job: job.id, tier: tierOf(job), state, phase, progress: Math.round(job.percent), phase_progress: state === "running" && detail ? Math.round(detail.phasePercent) : null, position: job.state === "queued" ? job.position : null,
    ...liveFields(job.id, state === "running"),
    error: job.state === "failed" ? failure?.message ?? job.reason ?? "The clip failed." : job.state === "cancelled" ? (job.status === PAUSED_LOW_MEMORY ? job.reason ?? "Paused: this computer is low on memory." : "The clip was cancelled.") : null,
    code: job.state === "failed" ? (job.status === "no_memory" ? "no_memory" : failure?.code ?? "failed") : job.state === "cancelled" ? (job.status === PAUSED_LOW_MEMORY ? "no_memory" : "cancelled") : null,
    data: result ? [entry(result)] : [],
  };
}

/** The clip was made for an adult audience (the job record, or the result it left on disk). */
function isAdultClip(id: string, input?: unknown): boolean { return isAdultJobId(id) || (input as { audience?: unknown } | null)?.audience === "adult" || readResult(id)?.audience === "adult"; }
/** A file of an adult clip is answered as if it were not there unless the caller has the full view. */
const hiddenFromCaller = (c: Context, id: string): boolean => isAdultClip(id) && !fullViewAllowed((n) => c.req.header(n));

export const videoV1Routes = apiRouter<AppEnv>();

videoV1Routes.openapi(postRoute, async (c) => {
  const body = c.req.valid("json");
  const availability = tierAvailability();
  if (!availability.available) return fail(c, 503, availability.code ?? "unsupported", availability.reason ?? "Video is not available on this computer.");
  if (!hasJobRunner(VIDEO_JOB_KIND)) return fail(c, 503, "unsupported", "Video is not available on this machine.");
  const quality = qualityOfModelName(body.model);
  if (!quality) return fail(c, 422, "unknown_model", "That video model is not one this computer has. Use quick (silent, up to 5 seconds) or detailed (with sound and speech, up to 10 seconds).");
  const spec = VIDEO_SPECS[quality];
  const editKind: Ltx25EditKind | null = body.extend_seconds !== undefined ? "extend" : body.retake_from_seconds !== undefined ? "retake" : null;
  if (editKind !== null || body.source_video !== undefined) return await submitEdit(c, body, quality, editKind);
  if (body.image !== undefined && !spec.imageToVideo) return fail(c, 422, "reference_unsupported", "A Detailed video cannot start from a picture yet. Ask for a Quick video to animate a picture, or describe the Detailed video in words.");
  if (body.end_image !== undefined && !spec.endImage) return fail(c, 422, "reference_unsupported", "This video model cannot end on a picture. Ask for an LTX-2.5 video to give both a first and a last picture, or send only the first picture.");
  if (body.end_image !== undefined && body.image === undefined) return fail(c, 422, "bad_image", "A last picture needs a first picture. Send image as well, or leave end_image out.");
  if ((quality === "ltx25" || quality === "ltx25max") && (body.loras ?? []).length > 0) return fail(c, 422, "lora_unsupported", "This video model takes no style files yet. Leave the styles out, or ask for a Detailed video to use one.");
  const size = parseVideoSize(body.size, quality);
  if (typeof size === "string") return fail(c, 422, "bad_size", size);
  const seconds = body.seconds ?? (quality === "quick" ? VIDEO_MAX_SECONDS : 5);
  if (quality === "ltx25max") { const refusal = ltx25MaxRefusal(size.width, size.height, seconds * VIDEO_FPS + 1); if (refusal) return fail(c, 422, "bad_seconds", refusal); }
  if (quality === "ltx25") { const refusal = ltx25Refusal(size.width, size.height, seconds * VIDEO_FPS + 1); if (refusal) return fail(c, 422, "bad_seconds", refusal); }
  if (seconds > spec.maxSeconds) return fail(c, 422, "bad_seconds", `A ${quality === "quick" ? "Quick" : "Detailed"} clip is at most ${spec.maxSeconds} seconds on this computer.${quality === "quick" ? " Detailed clips run up to " + VIDEO_SPECS.detailed.maxSeconds + " seconds." : ""}`);
  let image: Uint8Array | null = null;
  let endImage: Uint8Array | null = null;
  // Any picture can start (or end) a clip: the Stack does not judge where it came from. The age and surface gate is the caller's (Home) and stays outside this file.
  for (const [name, value] of [["image", body.image], ["end_image", body.end_image]] as const) {
    if (value === undefined) continue;
    const bytes = decodeImage(value);
    if (!bytes) return fail(c, 422, "bad_image", `The ${name === "image" ? "picture" : "last picture"} could not be read. Send a PNG, JPEG or WebP as base64.`);
    if (bytes.length > VIDEO_MAX_REFERENCE_BYTES) return fail(c, 413, "too_large", `The ${name === "image" ? "picture" : "last picture"} is larger than ${VIDEO_MAX_REFERENCE_BYTES / 1024 / 1024} MB.`);
    if (!looksLikePicture(bytes)) return fail(c, 422, "bad_image", `The ${name === "image" ? "picture" : "last picture"} could not be read. Send a PNG, JPEG or WebP as base64.`);
    if (name === "image") image = bytes; else endImage = bytes;
  }
  let loras;
  try { loras = await resolveLoras((body.loras ?? []).map((entry) => ({ id: entry.id, ...(entry.strength !== undefined ? { strength: entry.strength } : {}) })), body.audience ?? "all-ages", spec.loraBase as "wan2.2-ti2v-5b" | "ltx-2.3"); } catch (error) {
    if (error instanceof LoraError) return fail(c, error.status === 404 ? 422 : error.status, error.code, error.message);
    throw error;
  }
  const seed = body.seed ?? Math.floor(Math.random() * 2 ** 32);
  const frames = seconds * VIDEO_FPS + 1;
  const loraIds = loras.map((lora) => lora.record.id);
  const peak = quality === "ltx25max" ? ltx25MaxPeakBytes(image !== null) : quality === "ltx25" ? ltx25PeakBytes(size.width, size.height, seconds * VIDEO_FPS + 1, image !== null) : undefined;
  return await runClip(c, body, quality, { prompt: body.prompt, negativePrompt: body.negative_prompt ?? null, image, endImage, width: size.width, height: size.height, frames, seed, loras: loras.map((lora) => [lora.path, lora.strength]), loraIds, quality, preview: body.preview !== false }, { size: `${size.width}x${size.height}`, seconds, mode: image ? "image-to-video" : "text-to-video" }, peak);
});

/** The queue check, the memory verdict, the stash, the job and the wait: one definition for a made clip and for an edit of one. */
async function runClip(c: Context, body: z.infer<typeof VideoRequestSchema>, quality: VideoQuality, clip: StashedClip, jobFields: Record<string, unknown>, peakBytes: number | undefined) {
  if (!videoGen.hasModels(quality)) return fail(c, 503, "not_installed", quality === "detailed" ? "The Detailed video model is not installed yet. An admin can install it in Settings, Models and storage, then try again." : quality === "ltx25max" ? "The LTX-2.5 Max video model is not installed yet. An admin can install it in Settings, Models and storage, then try again." : quality === "ltx25" ? "The LTX-2.5 video model is not installed yet. An admin can install it in Settings, Models and storage, then try again." : "The video model is not installed yet. Install it from Home's Engines page, then try again.");
  if (activeClips() >= VIDEO_QUEUE_MAX) return fail(c, 429, "queue_full", `${VIDEO_QUEUE_MAX} clips are already waiting. Try again when one finishes.`);
  const verdict = governorDecides(body.tier) ? { ok: true as const } : memoryVerdict(quality, peakBytes);
  if (!verdict.ok) return fail(c, 503, "no_memory", verdict.reason);
  const token = crypto.randomUUID();
  stashClip(token, clip);
  const submitted = submitJob({ kind: VIDEO_JOB_KIND, role: "video", input: { token, ...jobFields, ...adultInput(body.audience), seed: clip.seed, quality, lora_ids: clip.loraIds, ...tierInput(body.tier), ...(body.quiet_seconds !== undefined ? { quiet_seconds: body.quiet_seconds } : {}), ...(body.quiet_max_wait_seconds !== undefined ? { quiet_max_wait_seconds: body.quiet_max_wait_seconds } : {}) } });
  if ("refused" in submitted) { unstashClip(token); return fail(c, 503, submitted.code ?? "unsupported", submitted.reason); }
  const settled = await waitForJob(submitted.job.id, body.timeout_ms ?? DEFAULT_WAIT_MS);
  const created = Math.floor(new Date(submitted.job.createdAt).getTime() / 1000);
  if (!settled || settled.state === "queued" || settled.state === "running" || settled.state === "stalled") return reply(c, { created, job: submitted.job.id, data: [] }, 202);
  if (settled.state === "cancelled" && settled.status === PAUSED_LOW_MEMORY) return fail(c, 503, "no_memory", settled.reason ?? "Paused: this computer is low on memory.", settled.id);
  if (settled.state === "cancelled") return fail(c, 499, "cancelled", "The clip was cancelled.", settled.id);
  if (settled.state === "failed" && settled.status === "no_memory") return fail(c, 503, "no_memory", settled.reason ?? "There was not enough free memory.", settled.id);
  if (settled.state !== "done") {
    const failure = videoFailure(settled.id);
    return fail(c, failure?.status ?? 500, failure?.code ?? "failed", failure?.message ?? settled.reason ?? "The clip failed.", settled.id);
  }
  const meta = readResult(settled.id);
  if (!meta) return fail(c, 500, "expired", "The clip is no longer held. Make it again.", settled.id);
  return reply(c, { created, job: settled.id, data: [entry(meta)] }, 200);
}

/**
 * LTX25-EDIT-01: extend or retake a source clip. Every refusal is a plain 422 before anything is stashed or queued; the source is probed here
 * when the media service's ffprobe is already on this computer (else the job probes it, and a refusal then is the job's `code`).
 */
async function submitEdit(c: Context, body: z.infer<typeof VideoRequestSchema>, quality: VideoQuality, kind: Ltx25EditKind | null) {
  const availabilityProblem = (): ReturnType<typeof fail> | null => {
    if (body.extend_seconds !== undefined && body.retake_from_seconds !== undefined) return fail(c, 422, "bad_edit", "Ask for one edit at a time: extend_seconds adds time after the clip, retake_from_seconds regenerates it from a second on. Send only one.");
    if (body.source_video === undefined || kind === null) return fail(c, 422, "bad_edit", "An edit needs the clip and what to do with it: send source_video with either extend_seconds or retake_from_seconds.");
    if (quality !== "ltx25max") return fail(c, 422, "edit_unsupported", "Only the Max video model extends or retakes a clip. Send model ltx25-max, or make a new clip.");
    if (!ltx25MaxEditSupported()) return fail(c, 422, "edit_unsupported", "This computer's Max video engine cannot extend or retake a clip yet. Update Home and the Stack, then try again.");
    if (body.image !== undefined || body.end_image !== undefined || body.size !== undefined || body.seconds !== undefined) return fail(c, 422, "bad_edit", "An extend or a retake takes the clip's own picture and size: leave out image, end_image, size and seconds (use extend_seconds or retake_from_seconds for the length).");
    if ((body.loras ?? []).length > 0) return fail(c, 422, "lora_unsupported", "This video model takes no style files yet. Leave the styles out.");
    return null;
  };
  const problem = availabilityProblem();
  if (problem) return problem;
  const editKind = kind!;
  let sourcePath: string;
  try { sourcePath = resolveReadable(body.source_video, "The source clip"); } catch (error) {
    if (error instanceof MediaPathError) return fail(c, 422, error.code === "path_not_found" ? "source_not_found" : error.code, error.message);
    throw error;
  }
  const seconds = (editKind === "extend" ? body.extend_seconds : body.retake_from_seconds)!;
  let size: string | null = null;
  let sourceFrames = 0;
  try {
    if (editRuntime.toolbox.installed("ffprobe")) {
      const ffprobe = await editRuntime.toolbox.path("ffprobe", () => {});
      const plan = planSource(await probeSource(ffprobe, sourcePath, editRuntime.run));
      checkEdit(editKind, plan, seconds);
      size = plan.size; sourceFrames = plan.frames;
    }
  } catch (error) {
    if (error instanceof EditSourceError) return fail(c, error.status, error.code, error.message);
    throw error;
  }
  const seed = body.seed ?? Math.floor(Math.random() * 2 ** 32);
  const [width, height] = (size ?? LTX25_MAX_EDIT_MEASURED[0]!.size).split("x").map(Number) as [number, number];
  return await runClip(c, body, quality, { prompt: body.prompt, negativePrompt: body.negative_prompt ?? null, image: null, endImage: null, width, height, frames: sourceFrames, seed, loras: [], loraIds: [], quality, preview: body.preview !== false, edit: { kind: editKind, sourcePath, seconds } }, { size: size ?? "", seconds: Math.round(seconds), mode: editKind, edit: editKind }, ltx25EditAdmitBytes(editKind, size));
}

videoV1Routes.openapi(getRoute, (c) => {
  const id = c.req.valid("param").job;
  const job = getJob(id);
  // A finished clip whose files are gone (Home deleted them, or a day passed) is gone, not "done with nothing".
  if (job && job.kind === VIDEO_JOB_KIND && !(job.state === "done" && !readResult(id))) return reply(c, isAdultClip(id, job.input) && !fullViewAllowed((n) => c.req.header(n)) ? redactStatus(statusOf(job)) : statusOf(job), 200);
  // After a restart the job record is gone but a finished clip is still on disk.
  const meta = readResult(id);
  if (meta) { const status = { job: id, state: "done", phase: "ready", progress: 100, phase_progress: null, ...liveFields(id, false), position: null, error: null, code: null, data: [entry(meta)] }; return reply(c, meta.audience === "adult" && !fullViewAllowed((n) => c.req.header(n)) ? redactStatus(status) : status, 200); }
  return fail(c, 404, "unknown_job", "No such clip: it expired after a day, was deleted, or never existed.");
});

export function fileResponse(c: Context, path: string, type: string, range: string | undefined): Response {
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
  if (!isJobId(id) || !existsSync(videoPath(id)) || hiddenFromCaller(c, id)) return fail(c, 404, "expired", "That clip is gone: results are kept for a day, or Home deleted it. Make it again.") as never;
  return fileResponse(c, videoPath(id), "video/mp4", c.req.header("range")) as never;
});
videoV1Routes.openapi(previewFileRoute, (c) => {
  const id = c.req.valid("param").job;
  const path = isJobId(id) ? videoPreviewPath(id) : null;
  if (!path || !existsSync(path) || hiddenFromCaller(c, id)) return fail(c, 404, "no_preview", "There is no preview for that clip: the motion is not finished yet, none was asked for, or the clip is done.") as never;
  return fileResponse(c, path, "image/jpeg", undefined) as never;
});
videoV1Routes.openapi(posterFileRoute, (c) => {
  const id = c.req.valid("param").job;
  if (!isJobId(id) || !existsSync(posterPath(id)) || hiddenFromCaller(c, id)) return fail(c, 404, "expired", "That poster is gone: results are kept for a day, or Home deleted it.") as never;
  return fileResponse(c, posterPath(id), "image/jpeg", undefined) as never;
});

function messagesFailure<T extends Context>(c: T, error: unknown) {
  if (error instanceof MessagesError) return fail(c, error.code === "no_ffmpeg" ? 503 : error.code === "failed" ? 500 : 422, error.code, error.message);
  throw error;
}
function safeDecode(value: string | undefined): string | undefined { try { return value === undefined ? undefined : decodeURIComponent(value); } catch { return value; } }
const cleanTitle = (title: string | undefined): string => (title ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 120) || "MaiPai video";
const MESSAGES_UPLOAD_MAX = 100 * 1024 * 1024;
const messagesInFlight = new Map<string, Promise<unknown>>();

videoV1Routes.openapi(messagesFileRoute, async (c) => {
  const id = c.req.valid("param").job;
  if (!isJobId(id) || !existsSync(videoPath(id)) || hiddenFromCaller(c, id)) return fail(c, 404, "expired", "That clip is gone: results are kept for a day, or Home deleted it. Make it again.") as never;
  if (!existsSync(messagesPath(id))) {
    try {
      const running = messagesInFlight.get(id) ?? makeMessagesCopy(videoPath(id), messagesPath(id), cleanTitle(c.req.valid("query").title), videoGenRoot()).finally(() => messagesInFlight.delete(id));
      messagesInFlight.set(id, running);
      await running;
    } catch (error) { return messagesFailure(c, error) as never; }
  }
  return fileResponse(c, messagesPath(id), "video/mp4", c.req.header("range")) as never;
});

videoV1Routes.openapi(messagesConvertRoute, async (c) => {
  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > MESSAGES_UPLOAD_MAX) return fail(c, 413, "too_large", "The clip is larger than 100 MB.") as never;
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length > MESSAGES_UPLOAD_MAX) return fail(c, 413, "too_large", "The clip is larger than 100 MB.") as never;
  const work = join(dataDir, "tmp", "video", `messages-${crypto.randomUUID()}`);
  mkdirSync(work, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(join(work, "in.mp4"), bytes);
    await makeMessagesCopy(join(work, "in.mp4"), join(work, "out.mp4"), cleanTitle(safeDecode(c.req.valid("header")["x-title"])), videoGenRoot());
    const out = new Uint8Array(await Bun.file(join(work, "out.mp4")).arrayBuffer());
    for (const [name, value] of Object.entries(RoleReplyHeaders.parse(identityHeaders(null)))) c.header(name, value);
    return c.body(out, 200, { "content-type": "video/mp4", "cache-control": "no-store" }) as never;
  } catch (error) { return messagesFailure(c, error) as never; } finally { rmSync(work, { recursive: true, force: true }); }
});

videoV1Routes.openapi(deleteRoute, (c) => {
  const id = c.req.valid("param").job;
  const job = getJob(id);
  if (job && job.kind === VIDEO_JOB_KIND && (job.state === "queued" || job.state === "running" || job.state === "stalled")) { cancelJob(id); unstashClip(String((job.input as { token?: string } | null)?.token ?? "")); return reply(c, { job: id, state: "cancelled" }, 200); }
  if (deleteResult(id)) return reply(c, { job: id, state: "deleted" }, 200);
  if (job && job.kind === VIDEO_JOB_KIND) return reply(c, { job: id, state: job.state === "failed" ? "failed" : "deleted" }, 200);
  return fail(c, 404, "unknown_job", "No such clip.");
});
