import { createRoute, z } from "@hono/zod-openapi";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { admissionCaller } from "@/lib/admissionCaller";
import { getJob, hasJobRunner, listJobs, submitJob } from "@/lib/jobs";
import { getGovernorStatus } from "@/lib/governor";
import { dataDir } from "@/lib/paths";
import { SCORE_JOB_KIND, scoreFailure, stashScore, unstashScore } from "@/score/jobs";
import { STACK_SCORE_MODEL_BUNDLE } from "@/lib/modelCatalog";
import { getScoreDeps, readScoreNotes, scoreFile, scoreGenEnvironmentReady, scoreRequirementsFileFor, SCORE_MAX_SECONDS, SCORE_PEAK_BYTES, SCORE_QUEUE_MAX } from "@/score/scoreGen";

const ErrorSchema = z.object({ error: z.string(), code: z.string(), job: z.string().optional() });
const statusSchema = z.object({ score: z.object({ installed: z.boolean(), ready: z.boolean(), available: z.boolean(), engine: z.string(), model: z.object({ id: z.string(), bundled: z.boolean(), licence: z.string() }), limits: z.object({ max_seconds: z.number(), max_notes: z.number() }), memory: z.object({ peak_gb: z.number(), basis: z.literal("estimate") }), queue_max: z.number().int() }) });
const post = createRoute({ method: "post", path: "/", tags: ["Score"], summary: "Transcribe an audio file or Stack host path into MIDI and notes", request: { body: { required: false, content: { "multipart/form-data": { schema: z.object({ file: z.custom<File>((value) => value instanceof File, "Send an audio file in the file field.").openapi({ type: "string", format: "binary" }) }) }, "application/json": { schema: z.object({ path: z.string().min(1) }) } } } }, responses: { 200: { content: { "application/json": { schema: z.object({ id: z.string() }) } }, description: "Score job created." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "Audio was missing or unreadable." }, 413: { content: { "application/json": { schema: ErrorSchema } }, description: "Audio is too large." }, 415: { content: { "application/json": { schema: ErrorSchema } }, description: "Send multipart form data with a file, or JSON with a Stack host path." }, 429: { content: { "application/json": { schema: ErrorSchema } }, description: "The queue is full." }, 503: { content: { "application/json": { schema: ErrorSchema } }, description: "Engine unavailable or memory unavailable." } } });
const get = createRoute({ method: "get", path: "/{id}", tags: ["Score"], summary: "Read score job state", request: { params: z.object({ id: z.string() }) }, responses: { 200: { content: { "application/json": { schema: z.any() } }, description: "Job status and available result links." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "No such job." } } });
const file = createRoute({ method: "get", path: "/{id}/file", tags: ["Score"], summary: "Fetch the MIDI or JSON notes", request: { params: z.object({ id: z.string() }), query: z.object({ kind: z.enum(["midi", "notes"]) }) }, responses: { 200: { content: { "audio/midi": { schema: z.any() }, "application/json": { schema: z.any() } }, description: "The requested score file." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "The result expired or does not exist." } } });
const statusRoute = createRoute({ method: "get", path: "/", tags: ["Score"], summary: "Score engine readiness", responses: { 200: { content: { "application/json": { schema: statusSchema } }, description: "Engine and bundled model state." } } });
const fail = (c: any, status: number, code: string, error: string, job?: string) => c.json({ error, code, ...(job ? { job } : {}) }, status);
const isScoreId = (id: string) => /^job-[0-9a-f-]{36}$/i.test(id);
const active = () => listJobs().filter((job) => job.kind === SCORE_JOB_KIND && ["queued", "running", "stalled"].includes(job.state)).length;
export const scoreV1Routes = apiRouter<AppEnv>();
scoreV1Routes.openapi(post, async (c) => {
  const deps = getScoreDeps();
  if (!deps.supported()) return fail(c, 503, "unsupported", `Score transcription is not available on ${process.platform} ${process.arch} yet.`);
  if (!hasJobRunner(SCORE_JOB_KIND)) return fail(c, 503, "unsupported", "The score worker is not available on this machine. Restart the Stack and try again.");
  if (!deps.ready()) return fail(c, 503, "not_installed", "The score engine is not installed. Install Score transcription from Home's Engines page, then try again.");
  if (active() >= SCORE_QUEUE_MAX) return fail(c, 429, "queue_full", "The score queue is full. Try again when a score finishes.");
  const memory = getGovernorStatus(); const resident = memory.loaded.filter((item) => item.kind === "resident").reduce((sum, item) => sum + item.peakBytes, 0);
  if (resident + SCORE_PEAK_BYTES > memory.capBytes) return fail(c, 503, "no_memory", "There is not enough free memory for score transcription right now. Close another large task, then try again.");
  const id = crypto.randomUUID(); let input = ""; let owned = false;
  if ((c.req.header("content-type") ?? "").includes("multipart/form-data")) {
    const form = c.req.valid("form") as { file: File }; const blob = form.file;
    if (!(blob instanceof Blob) || blob.size === 0) return fail(c, 400, "bad_request", "Send an audio file in the file field.");
    if (blob.size > 100 * 1024 * 1024) return fail(c, 413, "too_large", "Audio files must be no larger than 100 MB. Cut the clip or choose a smaller file.");
    const dir = join(dataDir, "score", "inputs"); mkdirSync(dir, { recursive: true, mode: 0o700 }); input = join(dir, `${id}.audio`); writeFileSync(input, new Uint8Array(await blob.arrayBuffer()), { mode: 0o600 }); owned = true;
  } else if ((c.req.header("content-type") ?? "").includes("application/json")) {
    const body = c.req.valid("json") as { path: string };
    if (!body.path.trim()) return fail(c, 400, "bad_request", "Send a path naming an existing audio file on the Stack host.");
    input = body.path;
    if (!existsSync(input) || !statSync(input).isFile()) return fail(c, 400, "bad_request", "The audio path does not name a readable file on the Stack host. Choose an existing audio file.");
  } else return fail(c, 415, "bad_request", "Send multipart form data with a file field, or JSON with a path on the Stack host.");
  const token = crypto.randomUUID(); stashScore(token, input, owned);
  const submitted = submitJob({ caller: admissionCaller(c), kind: SCORE_JOB_KIND, role: "music", input: { token } });
  if ("refused" in submitted) { const held = unstashScore(token); if (held?.owned) { try { await Bun.file(held.input).delete(); } catch {} } return fail(c, 503, submitted.code ?? "no_memory", submitted.reason); }
  return c.json({ id: submitted.job.id }, 200);
});
scoreV1Routes.openapi(get, (c) => {
  const id = c.req.valid("param").id, job = getJob(id); if (!job || job.kind !== SCORE_JOB_KIND) return fail(c, 404, "unknown_job", "No score job with that id was found.");
  const notes = job.state === "done" ? readScoreNotes(id) : null;
  return c.json({ id, state: job.state, phase: job.status, progress: job.percent, error: job.state === "failed" ? scoreFailure(id)?.message ?? job.reason ?? "The score failed. Check the audio file and try again." : null, code: job.state === "failed" ? scoreFailure(id)?.code ?? "failed" : null, result: job.result, data: notes === null ? null : { midi: `/v1/audio/score/${id}/file?kind=midi`, notes: `/v1/audio/score/${id}/file?kind=notes` } }, 200);
});
scoreV1Routes.openapi(file, (c) => {
  const { id } = c.req.valid("param"), { kind } = c.req.valid("query"); if (!isScoreId(id)) return fail(c, 404, "expired", "That score file is missing or expired. Make the score again."); const path = scoreFile(id, kind);
  if (!existsSync(path)) return fail(c, 404, "expired", "That score file is missing or expired. Make the score again.");
  return c.body(readFileSync(path), 200, { "content-type": kind === "midi" ? "audio/midi" : "application/json" });
});
export const scoreRoutes = apiRouter<AppEnv>();
scoreRoutes.openapi(statusRoute, (c) => c.json({ score: { installed: scoreGenEnvironmentReady(), ready: scoreGenEnvironmentReady(), available: !!scoreRequirementsFileFor(), engine: "score-gen", model: { id: STACK_SCORE_MODEL_BUNDLE.id, bundled: STACK_SCORE_MODEL_BUNDLE.bundled, licence: STACK_SCORE_MODEL_BUNDLE.license }, limits: { max_seconds: SCORE_MAX_SECONDS, max_notes: 20_000 }, memory: { peak_gb: Math.round(SCORE_PEAK_BYTES / 1e8) / 10, basis: "estimate" as const }, queue_max: SCORE_QUEUE_MAX } }, 200));
