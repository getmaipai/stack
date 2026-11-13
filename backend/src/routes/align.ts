import { admissionCaller } from "@/lib/admissionCaller";
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { wasMadeHere, sha256Hex } from "@/music/provenance";
import { cancelJob, getJob, hasJobRunner, isJobPaused, listJobs, submitJob, waitForJob, type Job } from "@/lib/jobs";
import { PAUSED_LABEL } from "@/lib/genProgress";
import { getGovernorStatus } from "@/lib/governor";
import { align, ALIGN_MAX_LYRICS_CHARS, ALIGN_MAX_SECONDS, ALIGN_MAX_SOURCE_BYTES, ALIGN_PEAK_BYTES, alignPeakBytesFor } from "@/align/align";
import { ALIGN_JOB_KIND, alignFailure, alignOutput, alignStage, alignTracker, forgetAlignOutput, stashAlign, unstashAlign } from "@/align/jobs";
import { decode, looksAudio, looksM4a } from "@/routes/stems";

const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 30 * 60_000;
const Schema = z.object({ source: z.string().max(56_000_000), source_sha256: z.string().regex(/^[0-9a-fA-F]{64}$/), lyrics: z.string().min(1).max(ALIGN_MAX_LYRICS_CHARS), origin: z.enum(["made_here", "owned_file"]).optional(), timeout_ms: z.number().int().positive().max(MAX_WAIT_MS).optional(), from_s: z.number().min(0).optional(), to_s: z.number().optional() }).superRefine((v, ctx) => {
  if ((v.from_s === undefined) !== (v.to_s === undefined)) ctx.addIssue({ code: "custom", message: "Send from_s and to_s together." });
  else if (v.from_s !== undefined && v.to_s !== undefined && (v.to_s <= v.from_s || v.to_s - v.from_s > ALIGN_MAX_SECONDS)) ctx.addIssue({ code: "custom", message: "to_s must be after from_s, and the window at most 4 minutes." });
});
const ErrorSchema = z.object({ error: z.string(), code: z.string(), job: z.string().optional() });
const Word = z.object({ t: z.number(), end: z.number(), text: z.string() });
const Data = z.object({ words: z.array(Word), aligned_words: z.number().int(), total_words: z.number().int(), line_starts: z.array(z.number().int()), window: z.object({ from_s: z.number(), to_s: z.number() }).optional() });
const Reply = z.object({ created: z.number().int(), job: z.string(), data: Data.nullable() });
const post = createRoute({ method: "post", path: "/", tags: ["Align"], summary: "Time known lyrics against a song, word by word", request: { body: { content: { "application/json": { schema: Schema } } } }, responses: { 200: { content: { "application/json": { schema: Reply } }, description: "Word timings are ready." }, 202: { content: { "application/json": { schema: Reply } }, description: "The alignment is running; poll the job." }, 413: { content: { "application/json": { schema: ErrorSchema } }, description: "Source too large." }, 422: { content: { "application/json": { schema: ErrorSchema } }, description: "Invalid source." }, 429: { content: { "application/json": { schema: ErrorSchema } }, description: "Too many alignment jobs waiting." }, 503: { content: { "application/json": { schema: ErrorSchema } }, description: "Not installed or unavailable." } } });
const status = createRoute({ method: "get", path: "/{job}", tags: ["Align"], summary: "Alignment job progress and result", request: { params: z.object({ job: z.string() }) }, responses: { 200: { content: { "application/json": { schema: z.object({ job: z.string(), state: z.string(), phase: z.string(), progress: z.number(), progress_fraction: z.number(), stage_label: z.string(), position: z.number().nullable(), stage: z.string().nullable(), eta_seconds: z.number().nullable(), error: z.string().nullable(), code: z.string().nullable(), data: Data.nullable() }) } }, description: "Job state." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "No such alignment job." } } });
const cancel = createRoute({ method: "delete", path: "/{job}", tags: ["Align"], summary: "Cancel or delete an alignment job", request: { params: z.object({ job: z.string() }) }, responses: { 200: { content: { "application/json": { schema: z.object({ job: z.string(), state: z.string() }) } }, description: "Cancelled or deleted." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "No such alignment job." } } });
export const alignV1Routes = apiRouter<AppEnv>();
function fail(c: any, code: number, error_code: string, error: string, job?: string) { return c.json({ error, code: error_code, ...(job ? { job } : {}) }, code); }
const active = (state: string) => ["queued", "running", "stalled"].includes(state);
function statusOf(job: Job) { const tracker = alignTracker(job.id); const paused = isJobPaused(job.id); return { job: job.id, state: job.state === "stalled" ? "running" : job.state, phase: job.state === "queued" ? "queued" : job.status, progress: Math.round(job.percent), stage: job.state === "running" ? paused ? "paused" : alignStage(job.id) : null, stage_label: paused ? PAUSED_LABEL : (alignStage(job.id) ?? "Getting ready"), progress_fraction: tracker?.snapshot().fraction ?? (job.state === "done" ? 1 : 0), eta_seconds: job.state === "running" && !paused ? tracker?.snapshot().eta_seconds ?? 8 : null, position: job.position, error: job.state === "failed" ? alignFailure(job.id)?.message ?? job.reason ?? "The alignment failed." : null, code: job.state === "failed" ? "failed" : job.state === "cancelled" ? "cancelled" : null, data: job.state === "done" ? alignOutput(job.id) : null }; }

alignV1Routes.openapi(post, async (c) => {
  const body = c.req.valid("json");
  const encoded = body.source;
  if (encoded.length > Math.ceil(ALIGN_MAX_SOURCE_BYTES * 4 / 3) + 100) return fail(c, 413, "too_large", "The song is larger than 40 MB.");
  const source = decode(encoded);
  const owned = body.origin === "owned_file";
  if (!source || source.length > ALIGN_MAX_SOURCE_BYTES || !(owned ? looksAudio(source) : looksM4a(source))) return fail(c, source?.length && source.length > ALIGN_MAX_SOURCE_BYTES ? 413 : 422, source?.length && source.length > ALIGN_MAX_SOURCE_BYTES ? "too_large" : "bad_request", "Send the song as an audio file, as base64.");
  if (sha256Hex(source) !== body.source_sha256.toLowerCase()) return fail(c, 422, "bad_request", "source_sha256 does not match the song sent.");
  // Same rule as stems: an audio file the person owns may be timed against its own lyrics; any other caller needs a song this Stack made.
  if (!owned && !wasMadeHere(source)) return fail(c, 422, "source_not_made_here", "I can only time lyrics against a song that was made here.");
  if (!align.depsAvailable) return fail(c, 503, "unsupported", "Lyric timing is not available on this computer.");
  if (!align.installed) return fail(c, 503, "not_installed", "Install the lyric timing model from Home's Engines page, then try again.");
  if (!hasJobRunner(ALIGN_JOB_KIND)) return fail(c, 503, "unsupported", "Lyric timing is not available on this machine.");
  if (listJobs().filter((job) => job.kind === ALIGN_JOB_KIND && active(job.state)).length >= 4) return fail(c, 429, "queue_full", "Four lyric timing jobs are already waiting. Try again when one finishes.");
  const governor = getGovernorStatus();
  const resident = governor.loaded.filter((item) => item.kind === "resident").reduce((sum, item) => sum + item.peakBytes, 0);
  const windowed = body.from_s !== undefined && body.to_s !== undefined;
  const need = windowed ? alignPeakBytesFor(body.to_s! - body.from_s!) : ALIGN_PEAK_BYTES;
  if (resident + need > governor.capBytes) return fail(c, 503, "no_memory", "Not enough free memory for lyric timing right now. Close other big jobs, or try again.");
  const token = crypto.randomUUID(); stashAlign(token, source, body.lyrics);
  const submitted = submitJob({ caller: admissionCaller(c), kind: ALIGN_JOB_KIND, role: "music", input: { token, origin: owned ? "owned_file" : "made_here", ...(windowed ? { from_s: body.from_s, to_s: body.to_s } : {}) } });
  if ("refused" in submitted) { unstashAlign(token); return fail(c, 503, submitted.code ?? "no_memory", submitted.reason); }
  const settled = await waitForJob(submitted.job.id, body.timeout_ms ?? DEFAULT_WAIT_MS);
  const created = Math.floor(Date.parse((settled ?? submitted.job).createdAt) / 1000);
  if (!settled || active(settled.state)) return c.json({ created, job: submitted.job.id, data: null }, 202);
  if (settled.state !== "done") return fail(c, settled.state === "cancelled" ? 499 : 500, settled.state === "cancelled" ? "cancelled" : "failed", alignFailure(settled.id)?.message ?? "The lyrics could not be timed.", settled.id);
  return c.json({ created, job: settled.id, data: alignOutput(settled.id) }, 200);
});
alignV1Routes.openapi(status, (c) => { const job = getJob(c.req.param("job")); return job?.kind === ALIGN_JOB_KIND ? c.json(statusOf(job), 200) : fail(c, 404, "not_found", "No lyric timing job has that id."); });
alignV1Routes.openapi(cancel, (c) => { const id = c.req.param("job"); const job = getJob(id); if (!job || job.kind !== ALIGN_JOB_KIND) return fail(c, 404, "not_found", "No lyric timing job has that id."); if (active(job.state)) { cancelJob(id); unstashAlign(String((job.input as any)?.token ?? "")); return c.json({ job: id, state: "cancelled" }, 200); } if (job.state === "done") { forgetAlignOutput(id); return c.json({ job: id, state: "deleted" }, 200); } return c.json({ job: id, state: job.state }, 200); });
