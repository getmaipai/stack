// POST /v1/audio/music and the job it makes (MUSIC-GEN-02). The same job API as
// pictures and clips: the song is submitted, the reply waits up to timeout_ms,
// and past the deadline answers 202 with the job id for Home to come back to.
// Progress is by stage (Getting ready, Planning the song, Making the music,
// Mixing it down, Saving) with a fraction that only rises and a time left from
// the Stack's own history; cancel stops the worker and frees its memory; the
// finished song (AAC in an m4a) is fetched by URL from the result store. Home
// owns who may call this and with what: it applies the age band, the surface,
// the minor line and the no-real-voice line, then sends the request; the Stack
// applies the hard limits and the locks it can check (see music/musicGen.ts):
// the tier, the length, and that a source song is one this Stack made.
// Design: Home docs/design/music-generation-2026-10-17.md, section 12.
import { PAUSED_LOW_MEMORY } from "@/lib/memoryState";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { existsSync } from "node:fs";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { identityHeaders } from "@/lib/identity";
import { RoleReplyHeaders } from "@maipai/spec/stack/ts/role-reply-headers.js";
import { cancelJob, getJob, hasJobRunner, isJobPaused, listJobs, submitJob, waitForJob, type Job } from "@/lib/jobs";
import { PAUSED_LABEL } from "@/lib/genProgress";
import { fileResponse } from "@/routes/videoGenerations";
import { wasMadeHere, sha256Hex } from "@/music/provenance";
import { isJobId, lrcOf, readResult, deleteResult, songPath, type MusicResultMeta } from "@/music/results";
import {
  memoryVerdict, MUSIC_DEFAULT_SECONDS, MUSIC_MAX_BPM, MUSIC_MAX_EXTEND_SECONDS, MUSIC_MAX_SOURCE_BYTES, MUSIC_MAX_TEXT_CHARS, MUSIC_MIN_BPM, MUSIC_MIN_EXTEND_SECONDS, MUSIC_MIN_SECONDS, MUSIC_LM, MUSIC_QUEUE_MAX,
  musicGen, tierAvailability, tierLimits, type MusicRunFields,
} from "@/music/musicGen";
import { musicFailure, musicHistoryKey, musicTracker, MUSIC_EDIT_JOB_KIND, MUSIC_JOB_KIND, isMusicJob, stashSong, unstashSong } from "@/music/jobs";

const DEFAULT_WAIT_MS = 60_000;
const MAX_WAIT_MS = 30 * 60_000;
const MAX_TITLE_CHARS = 200;
const NOT_MADE_HERE = "I can only change a song that was made here.";

const EditSchema = z.object({
  op: z.enum(["trim", "fade", "loudness"]),
  from_s: z.number().optional(), to_s: z.number().optional(),
  seconds: z.number().optional().openapi({ description: "fade: how long the fade lasts." }),
  where: z.enum(["in", "out", "both"]).optional().openapi({ description: "fade: which end (default out)." }),
  lufs: z.number().optional().openapi({ description: "loudness: the target, -30 to -8 (default -14)." }),
});
// The limits are checked in the handler, not here, so that each breach answers 422 with its own code and a sentence that says what to change.
const MusicRequestSchema = z.object({
  task: z.enum(["text2music", "cover", "repaint", "extend", "edit"]).openapi({ description: "text2music: a new song. cover: the same song in another style. repaint: new words or a new feel for one stretch (`from_s` to `to_s`). extend: add `add_s` seconds at the end (or `at: start`). edit: trim, fade or loudness on a song, no model." }),
  caption: z.string().optional().openapi({ description: `Genre, mood, instruments, voice, in words. At most ${MUSIC_MAX_TEXT_CHARS} characters.` }),
  lyrics: z.string().optional().openapi({ description: `The words, in ACE-Step's tagged form ([Verse], [Chorus]). At most ${MUSIC_MAX_TEXT_CHARS} characters. Left out: an instrumental.` }),
  instrumental: z.boolean().optional(),
  duration_s: z.number().optional().openapi({ description: `text2music only: ${MUSIC_MIN_SECONDS} to the tier's longest (240 on p128, 120 on p64), default ${MUSIC_DEFAULT_SECONDS}.` }),
  bpm: z.number().optional(), key: z.string().optional(), language: z.string().optional(),
  seed: z.number().int().min(0).max(4_294_967_295).optional(),
  quality: z.enum(["quick", "detailed"]).optional().openapi({ description: "quick: the 0.6B planning model. detailed: the 1.7B one, on tiers that have it (p128). Default: the tier's own (GET /stack/v1/music)." }),
  source: z.string().optional().openapi({ description: `cover, repaint, extend and edit: the song to start from, base64 of the m4a this Stack made, unchanged (a data: URL is fine), at most ${MUSIC_MAX_SOURCE_BYTES / 1024 / 1024} MB.` }),
  source_sha256: z.string().optional().openapi({ description: "The sha256 of the source bytes; must equal it." }),
  from_s: z.number().optional(), to_s: z.number().optional(),
  add_s: z.number().optional().openapi({ description: `extend: ${MUSIC_MIN_EXTEND_SECONDS} to ${MUSIC_MAX_EXTEND_SECONDS} seconds, default 20; the song may not pass the tier's longest.` }),
  at: z.enum(["start", "end"]).optional(),
  strength: z.number().optional().openapi({ description: "cover: how far to move from the original, 0.1 to 1 (default 0.6)." }),
  edit: EditSchema.optional(),
  title: z.string().optional().openapi({ description: `Written into the file as its title. At most ${MAX_TITLE_CHARS} characters.` }),
  timeout_ms: z.number().int().positive().max(MAX_WAIT_MS).optional().openapi({ description: `How long this request waits for the song before answering 202 with the job id. Default ${DEFAULT_WAIT_MS}. A minute-long song takes about half a minute warm.` }),
});
const MusicDataSchema = z.object({
  url: z.string().openapi({ description: "GET this for the audio (audio/mp4, AAC, 48 kHz stereo). Supports Range requests." }),
  content_type: z.literal("audio/mp4"),
  duration_s: z.number(), seed: z.number().int().nullable(), model: z.string().openapi({ description: "The pinned model id, or `none` for an edit that ran no model." }),
  task: z.string().openapi({ description: "text2music, cover, repaint, extend, or for an edit trim, fade or loudness." }),
  ms: z.number().int(), bytes: z.number().int(),
  lrc: z.string().nullable().openapi({ description: "Lyric timings (LRC) for a sung song, held in memory only for as long as the song is held; null for an instrumental, an edit, or after a restart." }),
});
const MusicResponseSchema = z.object({ created: z.number().int(), job: z.string(), data: z.array(MusicDataSchema) });
const ErrorBody = z.object({ error: z.string(), code: z.string(), job: z.string().optional() });
const JobStatusSchema = z.object({
  job: z.string(),
  state: z.enum(["queued", "running", "done", "failed", "cancelled"]),
  phase: z.string().openapi({ description: "queued, waiting for memory, starting, then the stage while running, ready; failed or cancelled when it ended so." }),
  progress: z.number().int().openapi({ description: "0 to 100, `progress_fraction` as a whole percent." }),
  progress_fraction: z.number().nullable().openapi({ description: "0 to 1 over the whole job, weighted by measured stage times; never goes back." }),
  stage: z.string().nullable().openapi({ description: "load, plan, music, mix or save while running; null otherwise." }),
  stage_label: z.string().nullable().openapi({ description: "The stage in plain words: Getting ready, Planning the song, Making the music, Mixing it down, Saving." }),
  eta_seconds: z.number().int().nullable().openapi({ description: "Whole seconds left, from the medians of earlier jobs of the same task and length (built-in times until there are some); null until a stage is known." }),
  position: z.number().int().nullable().openapi({ description: "Place in line while queued (1 is next)." }),
  error: z.string().nullable(), code: z.string().nullable(),
  data: z.array(MusicDataSchema),
});

const postRoute = createRoute({ method: "post", path: "/", tags: ["Music"], summary: "Make or change a song (the job API with a wait)", request: { body: { content: { "application/json": { schema: MusicRequestSchema } } } }, responses: {
  200: { content: { "application/json": { schema: MusicResponseSchema } }, description: "The song is ready; `data[0].url` is where to fetch it." },
  202: { content: { "application/json": { schema: MusicResponseSchema } }, description: "Still going past timeout_ms (`data` is empty); poll GET /v1/audio/music/{job}." },
  413: { content: { "application/json": { schema: ErrorBody } }, description: "The source song is larger than 40 MB (too_large)." },
  422: { content: { "application/json": { schema: ErrorBody } }, description: "The request cannot be done: bad_request, bad_range, too_long, source_not_made_here; `error` says what to change." },
  429: { content: { "application/json": { schema: ErrorBody } }, description: "Four songs are already waiting (queue_full)." },
  499: { content: { "application/json": { schema: ErrorBody } }, description: "The job was cancelled." },
  500: { content: { "application/json": { schema: ErrorBody } }, description: "The song failed (failed, worker_stopped)." },
  503: { content: { "application/json": { schema: ErrorBody } }, description: "Music is off on this computer (not_available_on_this_computer, unsupported), not installed (not_installed), or there is no free memory for it (no_memory)." },
  504: { content: { "application/json": { schema: ErrorBody } }, description: "The song took longer than 10 minutes and was stopped (timeout)." },
  507: { content: { "application/json": { schema: ErrorBody } }, description: "The computer ran out of memory while making the song (out_of_memory)." },
} });
const getRoute = createRoute({ method: "get", path: "/{job}", tags: ["Music"], summary: "A song's state, stage and file", request: { params: z.object({ job: z.string() }) }, responses: {
  200: { content: { "application/json": { schema: JobStatusSchema } }, description: "Poll this every second or two while state is queued or running." },
  404: { content: { "application/json": { schema: ErrorBody } }, description: "No such job (it expired, was deleted, or never existed)." },
} });
const fileRoute = createRoute({ method: "get", path: "/{job}/file", tags: ["Music"], summary: "The finished song (Range requests supported)", request: { params: z.object({ job: z.string() }) }, responses: {
  200: { content: { "audio/mp4": { schema: z.string().openapi({ format: "binary" }) } }, description: "The audio/mp4 bytes." },
  206: { content: { "audio/mp4": { schema: z.string().openapi({ format: "binary" }) } }, description: "A byte range." },
  404: { content: { "application/json": { schema: ErrorBody } }, description: "The song is gone: results are held about ten minutes, the six newest, or Home deleted it." },
} });
const deleteRoute = createRoute({ method: "delete", path: "/{job}", tags: ["Music"], summary: "Cancel a song, or free a finished one's file", request: { params: z.object({ job: z.string() }) }, responses: {
  200: { content: { "application/json": { schema: z.object({ job: z.string(), state: z.enum(["cancelled", "deleted", "failed"]) }) } }, description: "A queued or running song is cancelled (the worker is stopped and its memory returns); a finished song's file is freed (Home calls this once it has stored the file)." },
  404: { content: { "application/json": { schema: ErrorBody } }, description: "No such job." },
} });

function reply<T extends Context>(c: T, body: unknown, status: number) {
  for (const [name, value] of Object.entries(RoleReplyHeaders.parse(identityHeaders(null)))) c.header(name, value);
  return c.json(body as never, status as never);
}
const fail = <T extends Context>(c: T, status: number, code: string, error: string, job?: string) => reply(c, { error, code, ...(job ? { job } : {}) }, status);

function entry(meta: MusicResultMeta) {
  return { url: `/v1/audio/music/${meta.job}/file`, content_type: "audio/mp4" as const, duration_s: meta.duration_s, seed: meta.seed, model: meta.model, task: meta.task, ms: meta.ms, bytes: meta.bytes, lrc: lrcOf(meta.job) };
}

/** Bytes of a base64 or data: URL song, or null when it is not valid base64. */
function decodeSource(value: string): Uint8Array | null {
  const raw = value.startsWith("data:") ? value.slice(value.indexOf(",") + 1) : value;
  if (raw.length === 0 || raw.length % 4 === 1 || /[^A-Za-z0-9+/=\s]/.test(raw)) return null;
  try { const bytes = Buffer.from(raw, "base64"); return bytes.length > 0 ? new Uint8Array(bytes) : null; } catch { return null; }
}
/** An MP4 family file starts with a box whose type, at byte 4, is `ftyp`. */
const looksLikeM4a = (bytes: Uint8Array): boolean => bytes.length > 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;

type Refusal = { status: 413 | 422; code: string; error: string };
const refuse = (status: 413 | 422, code: string, error: string): Refusal => ({ status, code, error });
const finite = (value: number | undefined): boolean => value === undefined || Number.isFinite(value);

/** Everything the Stack can check about a request without a model: the shape per task and the hard limits. Returns the worker fields, or the refusal to send. */
export function validateMusicRequest(body: z.infer<typeof MusicRequestSchema>, tier: string): { fields: Omit<MusicRunFields, "source">; quality: string | null } | Refusal {
  const limits = tierLimits(tier);
  if (!limits) return refuse(422, "bad_request", "Music is not available on this computer.");
  const numbers = [body.duration_s, body.bpm, body.from_s, body.to_s, body.add_s, body.strength, body.edit?.from_s, body.edit?.to_s, body.edit?.seconds, body.edit?.lufs];
  if (!numbers.every(finite)) return refuse(422, "bad_request", "A number in the request is not a number. Send plain numbers.");
  const caption = (body.caption ?? "").trim();
  const lyrics = (body.lyrics ?? "").trim();
  if (caption.length > MUSIC_MAX_TEXT_CHARS) return refuse(422, "too_long", `The description is longer than ${MUSIC_MAX_TEXT_CHARS} characters. Shorten it.`);
  if (lyrics.length > MUSIC_MAX_TEXT_CHARS) return refuse(422, "too_long", `The lyrics are longer than ${MUSIC_MAX_TEXT_CHARS} characters. Shorten them or cut a verse.`);
  if ((body.title ?? "").length > MAX_TITLE_CHARS || (body.key ?? "").length > 20 || (body.language ?? "").length > 20) return refuse(422, "too_long", "The title, key or language is too long. Shorten it.");
  if (body.bpm !== undefined && (body.bpm < MUSIC_MIN_BPM || body.bpm > MUSIC_MAX_BPM)) return refuse(422, "bad_range", `The tempo must be ${MUSIC_MIN_BPM} to ${MUSIC_MAX_BPM} beats a minute.`);
  const common = {
    task: body.task, ...(caption ? { caption } : {}), ...(lyrics ? { lyrics } : {}), ...(body.instrumental !== undefined ? { instrumental: body.instrumental } : {}),
    ...(body.bpm !== undefined ? { bpm: Math.round(body.bpm) } : {}), ...(body.key ? { key: body.key } : {}), ...(body.language ? { language: body.language } : {}),
    ...(body.seed !== undefined ? { seed: body.seed } : {}), ...(body.title ? { title: body.title } : {}),
  };
  if (body.task === "edit") {
    const edit = body.edit;
    if (!edit) return refuse(422, "bad_request", "Say what to do to the song: edit needs trim, fade or loudness.");
    if (body.source === undefined) return refuse(422, "bad_request", "edit changes a song that was made here: send it as source.");
    if (edit.op === "trim") {
      const from = edit.from_s ?? 0;
      if (from < 0 || (edit.to_s !== undefined && edit.to_s - from < 1)) return refuse(422, "bad_range", "The part to keep must start at 0 or later and be at least one second long.");
    } else if (edit.op === "fade") {
      if (edit.seconds !== undefined && (edit.seconds < 0.1 || edit.seconds > 60)) return refuse(422, "bad_range", "A fade lasts 0.1 to 60 seconds.");
    } else if (edit.lufs !== undefined && (edit.lufs < -30 || edit.lufs > -8)) return refuse(422, "bad_range", "Loudness must be between -30 and -8 LUFS.");
    return { fields: { op: "edit", task: "edit", edit: { op: edit.op, ...(edit.from_s !== undefined ? { from_s: edit.from_s } : {}), ...(edit.to_s !== undefined ? { to_s: edit.to_s } : {}), ...(edit.seconds !== undefined ? { seconds: edit.seconds } : {}), ...(edit.where ? { where: edit.where } : {}), ...(edit.lufs !== undefined ? { lufs: edit.lufs } : {}) }, ...(body.title ? { title: body.title } : {}) }, quality: null };
  }
  const quality = body.quality ?? limits.default_quality;
  if (!limits.quality.includes(quality)) return refuse(422, "bad_request", `This computer makes songs at ${limits.quality.join(" or ")} quality only. Ask for ${limits.quality[0]}.`);
  // A model task needs something to make from: words, or an instrumental described in words (the worker's own rule).
  if (!caption && (body.instrumental || !lyrics)) return refuse(422, "bad_request", "Describe the music (its style and mood), or give the lyrics.");
  const withLm = { ...common, lm: MUSIC_LM[quality as keyof typeof MUSIC_LM], lrc: !!lyrics && !body.instrumental };
  if (body.task === "text2music") {
    if (body.source !== undefined) return refuse(422, "bad_request", "A new song starts from words, not from a song. Use cover, repaint or extend to change one.");
    const duration = body.duration_s ?? Math.min(MUSIC_DEFAULT_SECONDS, limits.max_seconds);
    if (duration < MUSIC_MIN_SECONDS || duration > limits.max_seconds) return refuse(422, "bad_range", `A song here is ${MUSIC_MIN_SECONDS} to ${limits.max_seconds} seconds long. Ask for a length in that range.`);
    return { fields: { ...withLm, duration_s: duration }, quality };
  }
  if (body.source === undefined) return refuse(422, "bad_request", `${body.task} changes a song that was made here: send it as source.`);
  if (body.task === "cover") {
    if (body.strength !== undefined && (body.strength < 0.1 || body.strength > 1)) return refuse(422, "bad_range", "Strength must be between 0.1 and 1.");
    return { fields: { ...withLm, ...(body.strength !== undefined ? { strength: body.strength } : {}) }, quality };
  }
  if (body.task === "repaint") {
    if (body.from_s === undefined || body.to_s === undefined) return refuse(422, "bad_request", "Repaint needs from_s and to_s: the stretch of the song to change.");
    if (body.from_s < 0 || body.to_s - body.from_s < 2) return refuse(422, "bad_range", "The part to change must start at 0 or later and be at least two seconds long.");
    return { fields: { ...withLm, from_s: body.from_s, to_s: body.to_s }, quality };
  }
  const add = body.add_s ?? 20;
  if (add < MUSIC_MIN_EXTEND_SECONDS || add > MUSIC_MAX_EXTEND_SECONDS) return refuse(422, "bad_range", `A song can grow by ${MUSIC_MIN_EXTEND_SECONDS} to ${MUSIC_MAX_EXTEND_SECONDS} seconds at a time.`);
  return { fields: { ...withLm, add_s: add, at: body.at ?? "end" }, quality };
}

const activeSongs = (): number => listJobs().filter((job) => job.kind === MUSIC_JOB_KIND && (job.state === "queued" || job.state === "running" || job.state === "stalled")).length;

/** The stage, fraction and time left of a running job; all null otherwise. A job that is running but has reported no stage yet is getting ready. */
function liveFields(id: string, running: boolean) {
  const tracker = running ? musicTracker(id) : null;
  if (!tracker) return { progress_fraction: null, stage: null, stage_label: null, eta_seconds: null };
  // ISOLATION-01: the worker is stopped while a chat or voice request runs; the stage says so (the existing field) and the countdown waits.
  if (isJobPaused(id)) return { progress_fraction: tracker.started ? Math.round(tracker.snapshot().fraction * 1000) / 1000 : 0, stage: "paused", stage_label: PAUSED_LABEL, eta_seconds: null };
  if (!tracker.started) return { progress_fraction: 0, stage: "load", stage_label: "Getting ready", eta_seconds: null };
  const snap = tracker.snapshot();
  return { progress_fraction: Math.round(snap.fraction * 1000) / 1000, stage: snap.stage, stage_label: snap.stage_label, eta_seconds: snap.eta_seconds };
}

function statusOf(job: Job) {
  const failure = musicFailure(job.id);
  const state = job.state === "stalled" ? "running" : job.state;
  const phase = state === "queued" ? "queued" : state === "done" ? "ready" : state === "cancelled" && job.status === PAUSED_LOW_MEMORY ? PAUSED_LOW_MEMORY : state === "failed" || state === "cancelled" ? state : job.status.startsWith("waiting for memory") ? "waiting for memory" : job.status;
  const result = job.state === "done" ? readResult(job.id) : null;
  return {
    job: job.id, state, phase, progress: Math.round(job.percent), position: job.state === "queued" ? job.position : null,
    ...liveFields(job.id, state === "running"),
    error: job.state === "failed" ? failure?.message ?? job.reason ?? "The song failed." : job.state === "cancelled" ? (job.status === PAUSED_LOW_MEMORY ? job.reason ?? "Paused: this computer is low on memory." : "The song was cancelled.") : null,
    code: job.state === "failed" ? (job.status === "no_memory" ? "no_memory" : failure?.code ?? "failed") : job.state === "cancelled" ? (job.status === PAUSED_LOW_MEMORY ? "no_memory" : "cancelled") : null,
    data: result ? [entry(result)] : [],
  };
}

export const musicV1Routes = apiRouter<AppEnv>();

musicV1Routes.openapi(postRoute, async (c) => {
  const body = c.req.valid("json");
  const availability = tierAvailability();
  if (!availability.available) return fail(c, 503, availability.code ?? "unsupported", availability.reason ?? "Music is not available on this computer.");
  if (!hasJobRunner(MUSIC_JOB_KIND)) return fail(c, 503, "unsupported", "Music is not available on this machine.");
  const checked = validateMusicRequest(body, availability.tier);
  if ("status" in checked) return fail(c, checked.status, checked.code, checked.error);
  // The source: a song this Stack made, sent back unchanged (Home's note, section 9: no uploaded audio, no real voice).
  let source: Uint8Array | null = null;
  if (body.source !== undefined) {
    if (body.source.length > Math.ceil((MUSIC_MAX_SOURCE_BYTES * 4) / 3) + 1024) return fail(c, 413, "too_large", `The song is larger than ${MUSIC_MAX_SOURCE_BYTES / 1024 / 1024} MB.`);
    source = decodeSource(body.source);
    if (!source) return fail(c, 422, "bad_request", "The song could not be read. Send the m4a this Stack made, as base64.");
    if (source.length > MUSIC_MAX_SOURCE_BYTES) return fail(c, 413, "too_large", `The song is larger than ${MUSIC_MAX_SOURCE_BYTES / 1024 / 1024} MB.`);
    if (!looksLikeM4a(source)) return fail(c, 422, "bad_request", "The song could not be read. Send the m4a this Stack made, as base64.");
    if (body.source_sha256 !== undefined && body.source_sha256.toLowerCase() !== sha256Hex(source)) return fail(c, 422, "bad_request", "source_sha256 does not match the song sent. Send the stored bytes unchanged, with their own hash.");
    if (!wasMadeHere(source)) return fail(c, 422, "source_not_made_here", NOT_MADE_HERE);
  }
  if (!musicGen.hasModels()) return fail(c, 503, "not_installed", "The music model is not installed yet. Install it from Home's Engines page, then try again.");
  const edit = body.task === "edit";
  if (!edit) {
    if (activeSongs() >= MUSIC_QUEUE_MAX) return fail(c, 429, "queue_full", `${MUSIC_QUEUE_MAX} songs are already waiting. Try again when one finishes.`);
    const verdict = memoryVerdict();
    if (!verdict.ok) return fail(c, 503, "no_memory", verdict.reason);
  }
  const fields = checked.fields;
  const seed = edit ? undefined : fields.seed ?? Math.floor(Math.random() * 2 ** 32);
  const token = crypto.randomUUID();
  stashSong(token, { fields: { ...fields, ...(seed !== undefined ? { seed } : {}) }, source, historyKey: musicHistoryKey(body.task, fields.duration_s) });
  // The job record holds the task, length, quality and seed, never a word of the request.
  const submitted = submitJob({ kind: edit ? MUSIC_EDIT_JOB_KIND : MUSIC_JOB_KIND, role: "music", input: { token, task: body.task, ...(fields.duration_s !== undefined ? { duration_s: fields.duration_s } : {}), ...(checked.quality ? { quality: checked.quality } : {}), ...(seed !== undefined ? { seed } : {}) } });
  if ("refused" in submitted) { unstashSong(token); return fail(c, 503, "unsupported", submitted.reason); }
  const settled = await waitForJob(submitted.job.id, body.timeout_ms ?? DEFAULT_WAIT_MS);
  const created = Math.floor(new Date(submitted.job.createdAt).getTime() / 1000);
  if (!settled || settled.state === "queued" || settled.state === "running" || settled.state === "stalled") return reply(c, { created, job: submitted.job.id, data: [] }, 202);
  if (settled.state === "cancelled" && settled.status === PAUSED_LOW_MEMORY) return fail(c, 503, "no_memory", settled.reason ?? "Paused: this computer is low on memory.", settled.id);
  if (settled.state === "cancelled") return fail(c, 499, "cancelled", "The song was cancelled.", settled.id);
  if (settled.state === "failed" && settled.status === "no_memory") return fail(c, 503, "no_memory", settled.reason ?? "There was not enough free memory.", settled.id);
  if (settled.state !== "done") {
    const failure = musicFailure(settled.id);
    return fail(c, failure?.status ?? 500, failure?.code ?? "failed", failure?.message ?? settled.reason ?? "The song failed.", settled.id);
  }
  const meta = readResult(settled.id);
  if (!meta) return fail(c, 500, "expired", "The song is no longer held. Make it again.", settled.id);
  return reply(c, { created, job: settled.id, data: [entry(meta)] }, 200);
});

musicV1Routes.openapi(getRoute, (c) => {
  const id = c.req.valid("param").job;
  const job = getJob(id);
  // A finished song whose file is gone (Home deleted it, or ten minutes passed) is gone, not "done with nothing".
  if (job && isMusicJob(job.kind) && !(job.state === "done" && !readResult(id))) return reply(c, statusOf(job), 200);
  // After a restart the job record is gone but a held song is still on disk.
  const meta = readResult(id);
  if (meta) return reply(c, { job: id, state: "done", phase: "ready", progress: 100, ...liveFields(id, false), position: null, error: null, code: null, data: [entry(meta)] }, 200);
  return fail(c, 404, "unknown_job", "No such song: it was held for about ten minutes, was deleted, or never existed.");
});

musicV1Routes.openapi(fileRoute, (c) => {
  const id = c.req.valid("param").job;
  if (!isJobId(id) || !readResult(id) || !existsSync(songPath(id))) return fail(c, 404, "expired", "That song is gone: results are held about ten minutes, or Home deleted it. Make it again.") as never;
  return fileResponse(c, songPath(id), "audio/mp4", c.req.header("range")) as never;
});

musicV1Routes.openapi(deleteRoute, (c) => {
  const id = c.req.valid("param").job;
  const job = getJob(id);
  if (job && isMusicJob(job.kind) && (job.state === "queued" || job.state === "running" || job.state === "stalled")) { cancelJob(id); unstashSong(String((job.input as { token?: string } | null)?.token ?? "")); return reply(c, { job: id, state: "cancelled" }, 200); }
  if (deleteResult(id)) return reply(c, { job: id, state: "deleted" }, 200);
  if (job && isMusicJob(job.kind)) return reply(c, { job: id, state: job.state === "failed" ? "failed" : "deleted" }, 200);
  return fail(c, 404, "unknown_job", "No such song.");
});
