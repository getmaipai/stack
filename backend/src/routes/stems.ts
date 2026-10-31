import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AppEnv } from "@/types";
import { wasMadeHere, sha256Hex } from "@/music/provenance";
import { isJobId, resultDir } from "@/music/results";
import { cancelJob, getJob, hasJobRunner, isJobPaused, listJobs, submitJob, waitForJob, type Job } from "@/lib/jobs";
import { PAUSED_LABEL } from "@/lib/genProgress";
import { getGovernorStatus } from "@/lib/governor";
import { STEMS_MODELS as STEMS_SPECS, STEMS_PEAK_BYTES } from "@/stems/stems";
import { STEMS_MODEL_ID, STEMS_MAX_SOURCE_BYTES, stems, type StemModelId } from "@/stems/stems";
import { STEMS_JOB_KIND, stashSource, unstashSource, stemsFailure, stemsStage, stemsTracker } from "@/stems/jobs";
import { STACK_STEMS_MODEL_ID } from "@/lib/modelCatalog";

export const STEM_MODELS = { htdemucs: STACK_STEMS_MODEL_ID, htdemucs_ft: "htdemucs_ft", htdemucs_6s: "htdemucs_6s" } as const;
const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 30 * 60_000;
const Schema = z.object({ source: z.string().max(56_000_000), source_sha256: z.string().regex(/^[0-9a-fA-F]{64}$/), model: z.enum(["htdemucs", "htdemucs_ft", "htdemucs_6s"]).default("htdemucs"), origin: z.enum(["made_here", "owned_file"]).optional(), timeout_ms: z.number().int().positive().max(MAX_WAIT_MS).optional() });
const ErrorSchema = z.object({ error: z.string(), code: z.string(), job: z.string().optional() });
const Item = z.object({ stem: z.enum(["vocals", "drums", "bass", "other", "guitar", "piano"]), url: z.string(), content_type: z.literal("audio/mp4"), bytes: z.number().int(), sha256: z.string() });
const Reply = z.object({ created: z.number().int(), job: z.string(), data: z.array(Item) });
const post = createRoute({ method: "post", path: "/", tags: ["Stems"], summary: "Split a song made here into stems", request: { body: { content: { "application/json": { schema: Schema } } } }, responses: { 200: { content: { "application/json": { schema: Reply } }, description: "Stems are ready." }, 202: { content: { "application/json": { schema: Reply } }, description: "The split is running; poll the job." }, 413: { content: { "application/json": { schema: ErrorSchema } }, description: "Source too large." }, 422: { content: { "application/json": { schema: ErrorSchema } }, description: "Invalid source or model." }, 503: { content: { "application/json": { schema: ErrorSchema } }, description: "Not installed or unavailable." } } });
const status = createRoute({ method: "get", path: "/{job}", tags: ["Stems"], summary: "Stem job progress and result", request: { params: z.object({ job: z.string() }) }, responses: { 200: { content: { "application/json": { schema: z.object({ job: z.string(), state: z.string(), phase: z.string(), progress: z.number(), progress_fraction: z.number(), stage_label: z.string(), position: z.number().nullable(), stage: z.string().nullable(), eta_seconds: z.number().nullable(), error: z.string().nullable(), code: z.string().nullable(), data: z.array(Item) }) } }, description: "Job state." } } });
const cancel = createRoute({ method: "delete", path: "/{job}", tags: ["Stems"], summary: "Cancel or delete a stem job", request: { params: z.object({ job: z.string() }) }, responses: { 200: { content: { "application/json": { schema: z.object({ job: z.string(), state: z.string() }) } }, description: "Cancelled or deleted." } } });
export const stemsV1Routes = apiRouter<AppEnv>();
function decode(value: string): Uint8Array | null { const raw = value.startsWith("data:") ? value.slice(value.indexOf(",") + 1) : value; if (!raw || raw.length % 4 === 1 || /[^A-Za-z0-9+/=\s]/.test(raw)) return null; try { const b = Buffer.from(raw, "base64"); return b.length ? new Uint8Array(b) : null; } catch { return null; } }
function fail(c: any, status: number, code: string, error: string, job?: string) { return c.json({ error, code, ...(job ? { job } : {}) }, status); }
function reply(c: any, body: unknown, status = 200) { return c.json(body, status); }
function data(job: string) { try { const manifest = JSON.parse(readFileSync(join(resultDir(job), "stems.json"), "utf8")); return manifest.files.map((f: any) => ({ stem: f.stem, url: `/v1/audio/stems/${job}/${f.stem}`, content_type: "audio/mp4" as const, bytes: f.bytes, sha256: f.sha256 })); } catch { return []; } }
function statusOf(job: Job) { const tracker = stemsTracker(job.id); const paused = isJobPaused(job.id); return { job: job.id, state: job.state === "stalled" ? "running" : job.state, phase: job.state === "queued" ? "queued" : job.status, progress: Math.round(job.percent), stage: job.state === "running" ? paused ? "paused" : stemsStage(job.id) : null, stage_label: paused ? PAUSED_LABEL : (stemsStage(job.id) ?? "Getting ready"), progress_fraction: tracker?.snapshot().fraction ?? (job.state === "done" ? 1 : 0), eta_seconds: job.state === "running" && !paused ? tracker?.snapshot().eta_seconds ?? 8 : null, position: job.position, error: job.state === "failed" ? stemsFailure(job.id)?.message ?? job.reason ?? "The split failed." : null, code: job.state === "failed" ? "failed" : job.state === "cancelled" ? "cancelled" : null, data: job.state === "done" ? data(job.id) : [] }; }

stemsV1Routes.openapi(post, async (c) => {
  const body = c.req.valid("json");
  if (!(body.model in STEM_MODELS)) return fail(c, 422, "bad_request", "Unknown stem model.");
  const encoded = body.source;
  if (encoded.length > Math.ceil(STEMS_MAX_SOURCE_BYTES * 4 / 3) + 100) return fail(c, 413, "too_large", "The song is larger than 40 MB.");
  const source = decode(encoded);
  const owned = body.origin === "owned_file";
  if (!source || source.length > STEMS_MAX_SOURCE_BYTES || !(owned ? looksAudio(source) : looksM4a(source))) return fail(c, source?.length && source.length > STEMS_MAX_SOURCE_BYTES ? 413 : 422, source?.length && source.length > STEMS_MAX_SOURCE_BYTES ? "too_large" : "bad_request", "Send the m4a this Stack made, as base64.");
  if (sha256Hex(source) !== body.source_sha256.toLowerCase()) return fail(c, 422, "bad_request", "source_sha256 does not match the song sent.");
  // An audio file the person owns may be split and nothing else (stems of it are never written to the ledger, so they cannot become an edit or cover source); every other caller still needs a song this Stack made.
  if (!owned && !wasMadeHere(source)) return fail(c, 422, "source_not_made_here", "I can only split a song that was made here.");
  if (!stems.depsAvailable) return fail(c, 503, "unsupported", "Stem splitting is not available on this computer.");
  if (!stems.isInstalled(body.model as StemModelId)) return fail(c, 503, "not_installed", body.model === "htdemucs_ft" ? "Install the fine-tuned stem model from Home's Engines page, then try again." : body.model === "htdemucs_6s" ? "Install the six-part stem model from Home's Engines page, then try again." : "Install HTDemucs from Home's Engines page, then try again.");
  if (!hasJobRunner(STEMS_JOB_KIND)) return fail(c, 503, "unsupported", "Stem splitting is not available on this machine.");
  const activeCount = listJobs().filter((job) => job.kind === STEMS_JOB_KIND && ["queued", "running", "stalled"].includes(job.state)).length;
  if (activeCount >= 4) return fail(c, 429, "queue_full", "Four stem jobs are already waiting. Try again when one finishes.");
  const statusNow = getGovernorStatus();
  const resident = statusNow.loaded.filter((item) => item.kind === "resident").reduce((sum, item) => sum + item.peakBytes, 0);
  const peakBytes = STEMS_SPECS[body.model].peakBytes;
  if (resident + peakBytes > statusNow.capBytes) return fail(c, 503, "no_memory", "Not enough free memory for stem splitting right now. Close other big jobs, or try again.");
  const token = crypto.randomUUID(); stashSource(token, source);
  const submitted = submitJob({ kind: STEMS_JOB_KIND, role: "music", input: { token, model: body.model, origin: owned ? "owned_file" : "made_here" } });
  if ("refused" in submitted) { unstashSource(token); return fail(c, 503, submitted.code ?? "no_memory", submitted.reason); }
  const settled = await waitForJob(submitted.job.id, body.timeout_ms ?? DEFAULT_WAIT_MS);
  if (!settled || ["queued", "running", "stalled"].includes(settled.state)) return reply(c, { created: Math.floor(Date.parse(submitted.job.createdAt) / 1000), job: submitted.job.id, data: [] }, 202);
  if (settled.state !== "done") return fail(c, settled.state === "cancelled" ? 499 : 500, settled.state === "cancelled" ? "cancelled" : "failed", stemsFailure(settled.id)?.message ?? "The song could not be split.", settled.id);
  return reply(c, { created: Math.floor(Date.parse(settled.createdAt) / 1000), job: settled.id, data: data(settled.id) });
});
// A container header of a common audio file: m4a/mp4, mp3 (ID3 or frame sync), wav, flac, ogg. The worker decodes with ffmpeg, which rejects anything else.
function looksAudio(b: Uint8Array) { if (b.length < 12) return false; const t = (from: number, to: number) => String.fromCharCode(...b.slice(from, to)); return t(4, 8) === "ftyp" || t(0, 3) === "ID3" || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) || (t(0, 4) === "RIFF" && t(8, 12) === "WAVE") || t(0, 4) === "fLaC" || t(0, 4) === "OggS"; }
function looksM4a(b: Uint8Array) { return b.length > 12 && String.fromCharCode(...b.slice(4, 8)) === "ftyp"; }
stemsV1Routes.openapi(status, (c) => { const job = getJob(c.req.param("job")); return job?.kind === STEMS_JOB_KIND ? c.json(statusOf(job), 200) : fail(c, 404, "not_found", "No stem job has that id."); });
stemsV1Routes.openapi(cancel, (c) => { const id = c.req.param("job"); const job = getJob(id); if (!job || job.kind !== STEMS_JOB_KIND) return fail(c, 404, "not_found", "No stem job has that id."); if (["queued", "running", "stalled"].includes(job.state)) { cancelJob(id); unstashSource(String((job.input as any)?.token ?? "")); return c.json({ job: id, state: "cancelled" }, 200); } if (job.state === "done") { const dir = resultDir(id); rmSync(dir, { recursive: true, force: true }); return c.json({ job: id, state: "deleted" }, 200); } return c.json({ job: id, state: job.state }, 200); });

const fileRoute = createRoute({ method: "get", path: "/{job}/{stem}", tags: ["Stems"], summary: "Fetch one AAC stem", request: { params: z.object({ job: z.string(), stem: z.enum(["vocals", "drums", "bass", "other", "guitar", "piano"]) }) }, responses: { 200: { content: { "audio/mp4": { schema: z.any() } }, description: "AAC stem." }, 404: { description: "Stem not found." } } });
stemsV1Routes.openapi(fileRoute, (c) => { const { job, stem } = c.req.valid("param"); if (!isJobId(job) || !data(job).some((f: any) => f.stem === stem)) return fail(c, 404, "not_found", "Stem not found."); const path = join(resultDir(job), `${stem}.m4a`); return c.body(readFileSync(path), 200, { "Content-Type": "audio/mp4", "Content-Length": String(statSync(path).size), "Accept-Ranges": "bytes" }); });
