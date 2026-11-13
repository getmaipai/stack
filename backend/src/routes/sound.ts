// POST /v1/audio/sound and the job it makes (MP-07), and GET /stack/v1/sound,
// the sound role's state. The same job API as songs: the sound is submitted,
// the reply waits up to timeout_ms, and past the deadline answers 202 with the
// job id for Home to poll; cancel stops the worker and frees its memory; the
// finished sound (AAC in an m4a, 44.1 kHz stereo, its silent tail cut and its
// loudness set) is fetched by URL from the music result store. Home owns who
// may call this and with what (the age band, the surface, the minor line on
// the description); the Stack applies the hard limits it can check.
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { existsSync } from "node:fs";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { identityHeaders } from "@/lib/identity";
import { RoleReplyHeaders } from "@maipai/spec/stack/ts/role-reply-headers.js";
import { cancelJob, getJob, hasJobRunner, isJobPaused, listJobs, submitJob, waitForJob, type Job } from "@/lib/jobs";
import { PAUSED_LOW_MEMORY } from "@/lib/memoryState";
import { PAUSED_LABEL } from "@/lib/genProgress";
import { engineIdleMs } from "@/lib/engineIdle";
import { installedEnginePin } from "@/lib/engineCatalog";
import { listModels } from "@/lib/modelStore";
import { sfxInstallModels } from "@/lib/installPlan";
import { SFX_LICENCE, SFX_LICENCE_NOTICE, STACK_SFX_MODEL_ID } from "@/lib/modelCatalog";
import { licenceAcceptance } from "@/lib/licenceAcceptance";
import { TierFieldSchema, governorDecides, tierInput } from "@/routes/tierField";
import { fileResponse } from "@/routes/videoGenerations";
import { modelView } from "@/routes/models";
import { isJobId, readResult, deleteResult, songPath, type MusicResultMeta } from "@/music/results";
import {
  SFX_DEFAULT_SECONDS, SFX_DEFAULT_STEPS, SFX_GEN_NAME, SFX_GEN_VERSION, SFX_MAX_PROMPT_CHARS, SFX_MAX_SECONDS, SFX_MAX_STEPS, SFX_MIN_SECONDS, SFX_MIN_STEPS, SFX_PEAK_BYTES, SFX_QUEUE_MAX, SFX_TARGET_LUFS,
  sfxGen, sfxGenEnvironmentReady, sfxGenSourceInstalled, sfxMemoryVerdict, sfxTierAvailability,
} from "@/sound/sfxGen";
import { SOUND_JOB_KIND, soundFailure, soundTracker, stashSound, unstashSound } from "@/sound/jobs";

const DEFAULT_WAIT_MS = 60_000;
const MAX_WAIT_MS = 30 * 60_000;

// The limits are checked in the handler, not here, so each breach answers 422 with its own code and a sentence that says what to change.
const SoundRequestSchema = z.object({
  prompt: z.string().openapi({ description: `The sound in words ("a heavy wooden door slamming shut", "rain on a tin roof"). At most ${SFX_MAX_PROMPT_CHARS} characters.` }),
  seconds: z.number().optional().openapi({ description: `How long, ${SFX_MIN_SECONDS} to ${SFX_MAX_SECONDS} seconds, default ${SFX_DEFAULT_SECONDS}. A one-shot that ends sooner comes back shorter: the silent tail is cut.` }),
  seed: z.number().int().min(0).max(4_294_967_295).optional().openapi({ description: "The same seed, words, length and steps make the same sound. Left out: a random one, returned in the result." }),
  steps: z.number().int().optional().openapi({ description: `Diffusion steps, ${SFX_MIN_STEPS} to ${SFX_MAX_STEPS}, default ${SFX_DEFAULT_STEPS} (the model is distilled for 8).` }),
  loop: z.boolean().optional().openapi({ description: "A seamless loop. Not made yet: only false (the default) is accepted; true answers 422 unsupported_option." }),
  tier: TierFieldSchema,
  timeout_ms: z.number().int().positive().max(MAX_WAIT_MS).optional().openapi({ description: `How long this request waits for the sound before answering 202 with the job id. Default ${DEFAULT_WAIT_MS}. A warm sound takes 2 to 12 seconds; the first one after a while also loads the model (about 20 seconds).` }),
});
const SoundDataSchema = z.object({
  url: z.string().openapi({ description: "GET this for the audio (audio/mp4, AAC, 44.1 kHz stereo). Supports Range requests." }),
  content_type: z.literal("audio/mp4"),
  duration_s: z.number().openapi({ description: "The length of the file: the asked seconds, or less when the sound ended sooner." }),
  seed: z.number().int().nullable(), model: z.string().openapi({ description: "The pinned model id." }),
  ms: z.number().int(), bytes: z.number().int(),
  licence: z.string().openapi({ description: "The model's licence, for Home's provenance stamp." }),
});
const SoundResponseSchema = z.object({ created: z.number().int(), job: z.string(), data: z.array(SoundDataSchema) });
const ErrorBody = z.object({ error: z.string(), code: z.string(), job: z.string().optional() });
const JobStatusSchema = z.object({
  job: z.string(),
  state: z.enum(["queued", "running", "done", "failed", "cancelled"]),
  phase: z.string().openapi({ description: "queued, waiting for memory, starting, then the stage while running, ready; failed or cancelled when it ended so." }),
  progress: z.number().int(),
  progress_fraction: z.number().nullable(),
  stage: z.string().nullable().openapi({ description: "load, sound or save while running; paused while chat works; null otherwise." }),
  stage_label: z.string().nullable().openapi({ description: "The stage in plain words: Getting ready, Making the sound, Saving." }),
  eta_seconds: z.number().int().nullable(),
  position: z.number().int().nullable().openapi({ description: "Place in line while queued (1 is next). Sounds share the music queue." }),
  error: z.string().nullable(), code: z.string().nullable(),
  data: z.array(SoundDataSchema),
});

const postRoute = createRoute({ method: "post", path: "/", tags: ["Sound"], summary: "Make a sound effect (the job API with a wait)", request: { body: { content: { "application/json": { schema: SoundRequestSchema } } } }, responses: {
  200: { content: { "application/json": { schema: SoundResponseSchema } }, description: "The sound is ready; `data[0].url` is where to fetch it." },
  202: { content: { "application/json": { schema: SoundResponseSchema } }, description: "Still going past timeout_ms (`data` is empty); poll GET /v1/audio/sound/{job}." },
  422: { content: { "application/json": { schema: ErrorBody } }, description: "bad_request, bad_range, too_long, unsupported_option, or silent (the model made silence); `error` says what to change." },
  429: { content: { "application/json": { schema: ErrorBody } }, description: "Four sounds are already waiting (queue_full)." },
  499: { content: { "application/json": { schema: ErrorBody } }, description: "The job was cancelled." },
  500: { content: { "application/json": { schema: ErrorBody } }, description: "The sound failed (failed, worker_stopped)." },
  503: { content: { "application/json": { schema: ErrorBody } }, description: "Sounds are off on this computer (not_available_on_this_computer, unsupported), not installed (not_installed), or there is no free memory for one (no_memory)." },
  504: { content: { "application/json": { schema: ErrorBody } }, description: "The sound took longer than three minutes and was stopped (timeout)." },
  507: { content: { "application/json": { schema: ErrorBody } }, description: "The computer ran out of memory while making the sound (out_of_memory)." },
} });
const getRoute = createRoute({ method: "get", path: "/{job}", tags: ["Sound"], summary: "A sound's state, stage and file", request: { params: z.object({ job: z.string() }) }, responses: {
  200: { content: { "application/json": { schema: JobStatusSchema } }, description: "Poll this every second or two while state is queued or running." },
  404: { content: { "application/json": { schema: ErrorBody } }, description: "No such job (it expired, was deleted, or never existed)." },
} });
const fileRoute = createRoute({ method: "get", path: "/{job}/file", tags: ["Sound"], summary: "The finished sound (Range requests supported)", request: { params: z.object({ job: z.string() }) }, responses: {
  200: { content: { "audio/mp4": { schema: z.string().openapi({ format: "binary" }) } }, description: "The audio/mp4 bytes." },
  206: { content: { "audio/mp4": { schema: z.string().openapi({ format: "binary" }) } }, description: "A byte range." },
  404: { content: { "application/json": { schema: ErrorBody } }, description: "The sound is gone: results are held about ten minutes, the six newest (shared with songs), or Home deleted it." },
} });
const deleteRoute = createRoute({ method: "delete", path: "/{job}", tags: ["Sound"], summary: "Cancel a sound, or free a finished one's file", request: { params: z.object({ job: z.string() }) }, responses: {
  200: { content: { "application/json": { schema: z.object({ job: z.string(), state: z.enum(["cancelled", "deleted", "failed"]) }) } }, description: "A queued or running sound is cancelled (the worker is stopped and its memory returns); a finished sound's file is freed (Home calls this once it has stored the file)." },
  404: { content: { "application/json": { schema: ErrorBody } }, description: "No such job." },
} });

function reply<T extends Context>(c: T, body: unknown, status: number) {
  for (const [name, value] of Object.entries(RoleReplyHeaders.parse(identityHeaders(null)))) c.header(name, value);
  return c.json(body as never, status as never);
}
const fail = <T extends Context>(c: T, status: number, code: string, error: string, job?: string) => reply(c, { error, code, ...(job ? { job } : {}) }, status);

const isSound = (meta: MusicResultMeta | null): meta is MusicResultMeta => !!meta && meta.task === "sound";
function entry(meta: MusicResultMeta) {
  return { url: `/v1/audio/sound/${meta.job}/file`, content_type: "audio/mp4" as const, duration_s: meta.duration_s, seed: meta.seed, model: meta.model, ms: meta.ms, bytes: meta.bytes, licence: SFX_LICENCE };
}

type Refusal = { status: 422; code: string; error: string };
const refuse = (code: string, error: string): Refusal => ({ status: 422, code, error });
/** Everything the Stack can check about a request without a model. Returns the worker fields (seed still open), or the refusal to send. */
export function validateSoundRequest(body: z.infer<typeof SoundRequestSchema>): { prompt: string; seconds: number; steps: number; seed?: number } | Refusal {
  const prompt = body.prompt.trim();
  if (!prompt) return refuse("bad_request", "Describe the sound in words, like \"a heavy wooden door slamming shut\".");
  if (prompt.length > SFX_MAX_PROMPT_CHARS) return refuse("too_long", `The description is longer than ${SFX_MAX_PROMPT_CHARS} characters. Shorten it.`);
  if (body.loop) return refuse("unsupported_option", "Seamless loops are not made yet. Ask for the sound without loop.");
  const seconds = body.seconds ?? SFX_DEFAULT_SECONDS;
  if (!Number.isFinite(seconds) || seconds < SFX_MIN_SECONDS || seconds > SFX_MAX_SECONDS) return refuse("bad_range", `A sound here is ${SFX_MIN_SECONDS} to ${SFX_MAX_SECONDS} seconds long. Ask for a length in that range.`);
  const steps = body.steps ?? SFX_DEFAULT_STEPS;
  if (steps < SFX_MIN_STEPS || steps > SFX_MAX_STEPS) return refuse("bad_range", `Steps must be ${SFX_MIN_STEPS} to ${SFX_MAX_STEPS}; leave them out for the default ${SFX_DEFAULT_STEPS}.`);
  return { prompt, seconds: Math.round(seconds * 100) / 100, steps, ...(body.seed !== undefined ? { seed: body.seed } : {}) };
}

const activeSounds = (): number => listJobs().filter((job) => job.kind === SOUND_JOB_KIND && (job.state === "queued" || job.state === "running" || job.state === "stalled")).length;

function liveFields(id: string, running: boolean) {
  const tracker = running ? soundTracker(id) : null;
  if (!tracker) return { progress_fraction: null, stage: null, stage_label: null, eta_seconds: null };
  if (isJobPaused(id)) return { progress_fraction: tracker.started ? Math.round(tracker.snapshot().fraction * 1000) / 1000 : 0, stage: "paused", stage_label: PAUSED_LABEL, eta_seconds: null };
  if (!tracker.started) return { progress_fraction: 0, stage: "load", stage_label: "Getting ready", eta_seconds: null };
  const snap = tracker.snapshot();
  return { progress_fraction: Math.round(snap.fraction * 1000) / 1000, stage: snap.stage, stage_label: snap.stage_label, eta_seconds: snap.eta_seconds };
}

function statusOf(job: Job) {
  const failure = soundFailure(job.id);
  const state = job.state === "stalled" ? "running" : job.state;
  const phase = state === "queued" ? "queued" : state === "done" ? "ready" : state === "cancelled" && job.status === PAUSED_LOW_MEMORY ? PAUSED_LOW_MEMORY : state === "failed" || state === "cancelled" ? state : job.status.startsWith("waiting for memory") ? "waiting for memory" : job.status;
  const result = job.state === "done" ? readResult(job.id) : null;
  return {
    job: job.id, state, phase, progress: Math.round(job.percent), position: job.state === "queued" ? job.position : null,
    ...liveFields(job.id, state === "running"),
    error: job.state === "failed" ? failure?.message ?? job.reason ?? "The sound failed." : job.state === "cancelled" ? (job.status === PAUSED_LOW_MEMORY ? job.reason ?? "Paused: this computer is low on memory." : "The sound was cancelled.") : null,
    code: job.state === "failed" ? (job.status === "no_memory" ? "no_memory" : failure?.code ?? "failed") : job.state === "cancelled" ? (job.status === PAUSED_LOW_MEMORY ? "no_memory" : "cancelled") : null,
    data: isSound(result) ? [entry(result)] : [],
  };
}

export const soundV1Routes = apiRouter<AppEnv>();

soundV1Routes.openapi(postRoute, async (c) => {
  const body = c.req.valid("json");
  const availability = sfxTierAvailability();
  if (!availability.available) return fail(c, 503, availability.code ?? "unsupported", availability.reason ?? "Sound effects are not available on this computer.");
  if (!hasJobRunner(SOUND_JOB_KIND)) return fail(c, 503, "unsupported", "Sound effects are not available on this machine.");
  const checked = validateSoundRequest(body);
  if ("status" in checked) return fail(c, checked.status, checked.code, checked.error);
  if (!sfxGen.hasModels()) return fail(c, 503, "not_installed", "The sound effects model is not installed yet. Install it in Settings, AI and models, then try again.");
  if (activeSounds() >= SFX_QUEUE_MAX) return fail(c, 429, "queue_full", `${SFX_QUEUE_MAX} sounds are already waiting. Try again when one finishes.`);
  const verdict = governorDecides(body.tier) ? { ok: true as const } : sfxMemoryVerdict();
  if (!verdict.ok) return fail(c, 503, "no_memory", verdict.reason);
  const seed = checked.seed ?? Math.floor(Math.random() * 2 ** 31);
  const token = crypto.randomUUID();
  stashSound(token, { prompt: checked.prompt, seconds: checked.seconds, steps: checked.steps, seed });
  // The job record holds the length, the steps and the seed, never a word of the request.
  const submitted = submitJob({ kind: SOUND_JOB_KIND, role: "music", input: { token, seconds: checked.seconds, steps: checked.steps, seed, model: STACK_SFX_MODEL_ID, ...tierInput(body.tier) } });
  if ("refused" in submitted) { unstashSound(token); return fail(c, 503, submitted.code ?? "unsupported", submitted.reason); }
  const settled = await waitForJob(submitted.job.id, body.timeout_ms ?? DEFAULT_WAIT_MS);
  const created = Math.floor(new Date(submitted.job.createdAt).getTime() / 1000);
  if (!settled || settled.state === "queued" || settled.state === "running" || settled.state === "stalled") return reply(c, { created, job: submitted.job.id, data: [] }, 202);
  if (settled.state === "cancelled" && settled.status === PAUSED_LOW_MEMORY) return fail(c, 503, "no_memory", settled.reason ?? "Paused: this computer is low on memory.", settled.id);
  if (settled.state === "cancelled") return fail(c, 499, "cancelled", "The sound was cancelled.", settled.id);
  if (settled.state === "failed" && settled.status === "no_memory") return fail(c, 503, "no_memory", settled.reason ?? "There was not enough free memory.", settled.id);
  if (settled.state !== "done") {
    const failure = soundFailure(settled.id);
    return fail(c, failure?.status ?? 500, failure?.code ?? "failed", failure?.message ?? settled.reason ?? "The sound failed.", settled.id);
  }
  const meta = readResult(settled.id);
  if (!isSound(meta)) return fail(c, 500, "expired", "The sound is no longer held. Make it again.", settled.id);
  return reply(c, { created, job: settled.id, data: [entry(meta)] }, 200);
});

soundV1Routes.openapi(getRoute, (c) => {
  const id = c.req.valid("param").job;
  const job = getJob(id);
  // A finished sound whose file is gone (Home deleted it, or ten minutes passed) is gone, not "done with nothing".
  if (job && job.kind === SOUND_JOB_KIND && !(job.state === "done" && !readResult(id))) return reply(c, statusOf(job), 200);
  // After a restart the job record is gone but a held sound is still on disk.
  const meta = readResult(id);
  if (isSound(meta)) return reply(c, { job: id, state: "done", phase: "ready", progress: 100, ...liveFields(id, false), position: null, error: null, code: null, data: [entry(meta)] }, 200);
  return fail(c, 404, "unknown_job", "No such sound: it was held for about ten minutes, was deleted, or never existed.");
});

soundV1Routes.openapi(fileRoute, (c) => {
  const id = c.req.valid("param").job;
  if (!isJobId(id) || !isSound(readResult(id)) || !existsSync(songPath(id))) return fail(c, 404, "expired", "That sound is gone: results are held about ten minutes, or Home deleted it. Make it again.") as never;
  return fileResponse(c, songPath(id), "audio/mp4", c.req.header("range")) as never;
});

soundV1Routes.openapi(deleteRoute, (c) => {
  const id = c.req.valid("param").job;
  const job = getJob(id);
  if (job && job.kind === SOUND_JOB_KIND && (job.state === "queued" || job.state === "running" || job.state === "stalled")) { cancelJob(id); unstashSound(String((job.input as { token?: string } | null)?.token ?? "")); return reply(c, { job: id, state: "cancelled" }, 200); }
  if (isSound(readResult(id)) && deleteResult(id)) return reply(c, { job: id, state: "deleted" }, 200);
  if (job && job.kind === SOUND_JOB_KIND) return reply(c, { job: id, state: job.state === "failed" ? "failed" : "deleted" }, 200);
  return fail(c, 404, "unknown_job", "No such sound.");
});

// ---- GET /stack/v1/sound ----

const PlanModelSchema = z.object({
  id: z.string(), role: z.string(), repo: z.string().optional(), url: z.string(), sha256: z.string(), approx_bytes: z.number().int(), licence: z.string(), revision: z.string(),
  engine: z.string().optional(), archive: z.boolean().optional(), hub_file: z.string().optional(), component: z.string().optional(), starter: z.boolean(), installed: z.boolean(),
});
const StatusSchema = z.object({
  state: z.enum(["unsupported", "off", "not-installed", "needs-setup", "building", "idle", "running"]).openapi({ description: "off: this computer's tier makes no sounds. not-installed: the model files are missing. needs-setup: installed; the first sound builds the environment (first time only) and starts the worker. idle: the worker is up and waits for the next sound, then exits. running: a sound is in progress." }),
  available: z.boolean(), code: z.string().nullable(), reason: z.string().nullable(), tier: z.string(),
  memory: z.object({ fits: z.boolean(), reason: z.string().nullable(), peak_gb: z.number() }),
  model: z.object({ id: z.string(), installed: z.boolean(), licence: z.string(), licence_accepted_at: z.string().nullable() }).openapi({ description: "The pinned model. Its licence is accepted once by an admin through the component install (POST /stack/v1/components/{id}/install with accepted_licence); licence_accepted_at says when." }),
  limits: z.object({ min_seconds: z.number(), max_seconds: z.number(), default_seconds: z.number(), min_steps: z.number().int(), max_steps: z.number().int(), default_steps: z.number().int(), max_prompt_chars: z.number().int(), queue_max: z.number().int(), target_lufs: z.number(), loop: z.boolean() }),
  output: z.object({ content_type: z.literal("audio/mp4"), sample_rate: z.number().int(), channels: z.number().int() }),
  worker: z.object({ alive: z.boolean(), idle_exit_seconds: z.number().int() }),
  environment: z.object({ engine: z.string(), version: z.string(), source: z.boolean(), ready: z.boolean() }),
  install: z.object({ component: z.string(), models: z.array(PlanModelSchema), remaining_bytes: z.number().int() }).openapi({ description: "The component to install (POST /stack/v1/components/{component}/install, which also builds the engine) and its pinned models with the bytes still to come." }),
});
const statusRoute = createRoute({ method: "get", path: "/", tags: ["Sound"], summary: "The sound effects role's state, limits, and what to install", responses: { 200: { content: { "application/json": { schema: z.object({ sound: StatusSchema }) } }, description: "Additive. Home enables its sound control from `available` and `state`, the same envelope as GET /stack/v1/music." } } });

export const soundRoutes = apiRouter<AppEnv>();

soundRoutes.openapi(statusRoute, (c) => {
  const availability = sfxTierAvailability();
  const status = sfxGen.status();
  const installed = listModels().map(modelView).filter((model) => model.state === "installed").map((model) => model.id);
  const models = sfxInstallModels(installed);
  const verdict = sfxMemoryVerdict();
  const pin = installedEnginePin(SFX_GEN_NAME);
  return c.json({ sound: {
    state: status.state, available: availability.available, code: availability.code, reason: availability.reason, tier: availability.tier,
    memory: { fits: verdict.ok, reason: verdict.ok ? null : verdict.reason, peak_gb: Math.round(SFX_PEAK_BYTES / 1e8) / 10 },
    model: { id: STACK_SFX_MODEL_ID, installed: status.models, licence: SFX_LICENCE, licence_accepted_at: licenceAcceptance(SFX_LICENCE_NOTICE.id)?.accepted_at ?? null },
    limits: { min_seconds: SFX_MIN_SECONDS, max_seconds: availability.available ? SFX_MAX_SECONDS : 0, default_seconds: SFX_DEFAULT_SECONDS, min_steps: SFX_MIN_STEPS, max_steps: SFX_MAX_STEPS, default_steps: SFX_DEFAULT_STEPS, max_prompt_chars: SFX_MAX_PROMPT_CHARS, queue_max: SFX_QUEUE_MAX, target_lufs: SFX_TARGET_LUFS, loop: false },
    output: { content_type: "audio/mp4" as const, sample_rate: 44_100, channels: 2 },
    worker: { alive: sfxGen.workerAlive, idle_exit_seconds: Math.round(engineIdleMs("music") / 1000) },
    environment: { engine: pin ? `${pin.name} ${pin.tag}` : SFX_GEN_NAME, version: SFX_GEN_VERSION, source: sfxGenSourceInstalled(), ready: sfxGenEnvironmentReady() },
    install: { component: STACK_SFX_MODEL_ID, models, remaining_bytes: models.filter((model) => !model.installed).reduce((sum, model) => sum + model.approx_bytes, 0) },
  } }, 200 as const);
});
