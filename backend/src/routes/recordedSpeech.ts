import { admissionCaller } from "@/lib/admissionCaller";
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";
import { cancelJob, getJob, hasJobRunner, listJobs, submitJob, waitForJob, type Job } from "@/lib/jobs";
import { getGovernorStatus } from "@/lib/governor";
import { sha256Hex } from "@/music/provenance";
import { decode, looksAudio } from "@/routes/stems";
import { recordedSpeech, RECORDED_SPEECH_MAX_REFERENCE_BYTES, RECORDED_SPEECH_MAX_TEXT, RECORDED_SPEECH_PEAK_BYTES } from "@/recordedSpeech/recordedSpeech";
import { RECORDED_SPEECH_JOB_KIND, recordedSpeechFailure, recordedSpeechStage, recordedSpeechTracker, stashRecordedSpeech, unstashRecordedSpeech } from "@/recordedSpeech/jobs";
import { getReducedChatState } from "@/lib/reducedChat";

const WAIT = 30_000, MAX_WAIT = 30 * 60_000;
const Clip = z.object({ reference: z.string().max(56_000_000), reference_text: z.string().max(12_000).optional(), reference_sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional() });
const Schema = z.object({ text: z.string().min(1), reference: z.string().max(56_000_000).optional(), reference_text: z.string().max(12_000).optional(), reference_sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(), speakers: z.array(Clip).optional(), format: z.enum(["m4a", "wav"]).default("m4a"), timeout_ms: z.number().int().positive().max(MAX_WAIT).optional() });
const ErrorSchema = z.object({ error: z.string(), code: z.string(), job: z.string().optional() });
const Data = z.object({ url: z.string(), content_type: z.enum(["audio/mp4", "audio/wav"]), bytes: z.number().int(), sha256: z.string(), duration: z.number(), sample_rate: z.number().int() });
const Reply = z.object({ created: z.number().int(), job: z.string(), data: Data.nullable() });
const post = createRoute({ method: "post", path: "/", tags: ["Recorded speech"], summary: "Render recorded speech", request: { body: { content: { "application/json": { schema: Schema } } } }, responses: { 200: { content: { "application/json": { schema: Reply } }, description: "Speech rendered." }, 202: { content: { "application/json": { schema: Reply } }, description: "Rendering is running." }, 413: { content: { "application/json": { schema: ErrorSchema } }, description: "Reference clip too large." }, 422: { content: { "application/json": { schema: ErrorSchema } }, description: "Invalid text or reference." }, 503: { content: { "application/json": { schema: ErrorSchema } }, description: "Unsupported, not installed, or insufficient memory." } } });
const status = createRoute({ method: "get", path: "/{job}", tags: ["Recorded speech"], summary: "Recorded speech job progress and result", request: { params: z.object({ job: z.string() }) }, responses: { 200: { content: { "application/json": { schema: z.object({ job: z.string(), state: z.string(), phase: z.string(), progress: z.number(), progress_fraction: z.number(), stage_label: z.string(), position: z.number().nullable(), stage: z.string().nullable(), eta_seconds: z.number().nullable(), error: z.string().nullable(), code: z.string().nullable(), data: Data.nullable() }) } }, description: "Job state." } } });
const cancel = createRoute({ method: "delete", path: "/{job}", tags: ["Recorded speech"], summary: "Cancel or delete a recorded speech job", request: { params: z.object({ job: z.string() }) }, responses: { 200: { content: { "application/json": { schema: z.object({ job: z.string(), state: z.string() }) } }, description: "Cancelled or deleted." } } });
const fail = (c: any, code: string, error: string, statusCode = 422, job?: string) => c.json({ error, code, ...(job ? { job } : {}) }, statusCode);
const resultDir = (id: string) => join(dataDir, "speech-recorded", "results", id);
function output(job: string) { try { const manifest = JSON.parse(readFileSync(join(resultDir(job), "speech.json"), "utf8")); return { url: `/v1/audio/speech/recorded/${job}/file`, content_type: manifest.format === "m4a" ? "audio/mp4" as const : "audio/wav" as const, bytes: manifest.bytes, sha256: manifest.sha256, duration: manifest.duration, sample_rate: manifest.sample_rate }; } catch { return null; } }
function statusOf(job: Job) { const tracker = recordedSpeechTracker(job.id), stage = recordedSpeechStage(job.id); return { job: job.id, state: job.state === "stalled" ? "running" : job.state, phase: job.state === "queued" ? "queued" : job.status, progress: Math.round(job.percent), stage: job.state === "running" ? stage : null, stage_label: stage ?? "Getting ready", progress_fraction: Math.max(job.percent / 100, tracker?.snapshot().fraction ?? 0, job.state === "done" ? 1 : 0), eta_seconds: job.state === "running" ? tracker?.snapshot().eta_seconds ?? 8 : null, position: job.position, error: job.state === "failed" ? recordedSpeechFailure(job.id)?.message ?? job.reason ?? "Recorded speech could not be rendered." : null, code: job.state === "failed" ? "failed" : job.state === "cancelled" ? "cancelled" : null, data: job.state === "done" ? output(job.id) : null }; }
function durationWav(bytes: Uint8Array): number | null { if (String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF" || String.fromCharCode(...bytes.slice(8, 12)) !== "WAVE" || bytes.length < 44) return null; const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let rate = 0, dataBytes = 0; for (let p = 12; p + 8 <= bytes.length;) { const name = String.fromCharCode(...bytes.slice(p, p + 4)), size = view.getUint32(p + 4, true); if (name === "fmt ") rate = view.getUint32(p + 16, true); if (name === "data") dataBytes = size; p += 8 + size + (size % 2); } return rate ? dataBytes / rate : null; }
function durationAudio(bytes: Uint8Array): number | null {
  const wavSeconds = durationWav(bytes); if (wavSeconds !== null) return wavSeconds;
  if (process.platform !== "darwin") return null;
  const probe = join(dataDir, "tmp", "recorded-speech", `probe-${crypto.randomUUID()}.audio`); mkdirSync(join(dataDir, "tmp", "recorded-speech"), { recursive: true, mode: 0o700 });
  try { writeFileSync(probe, bytes, { mode: 0o600 }); const result = Bun.spawnSync(["/usr/bin/afinfo", probe], { stdout: "pipe", stderr: "ignore", timeout: 10_000 }); const match = /estimated duration:\s*([0-9.]+)\s*sec/i.exec(result.stdout.toString()); return match ? Number(match[1]) : null; }
  catch { return null; }
  finally { rmSync(probe, { force: true }); }
}
function parseClip(encoded: string, text: string | undefined, digest: string | undefined) { const audio = decode(encoded); if (!audio || !looksAudio(audio)) return { error: "Send a supported reference audio clip as base64." }; if (audio.length > RECORDED_SPEECH_MAX_REFERENCE_BYTES) return { error: "Each reference clip must be no larger than 40 MB.", tooLarge: true }; if (digest && sha256Hex(audio) !== digest.toLowerCase()) return { error: "A reference checksum does not match the clip sent." }; const transcript = text?.trim(); if (!transcript) return { error: "This reference needs the sample's words." }; const duration = durationAudio(audio); if (duration !== null && (duration < 6 || duration > 30)) return { error: "Reference clips must be 6 to 30 seconds long." }; return { audio, text: transcript }; }

export const recordedSpeechV1Routes = apiRouter<AppEnv>();
recordedSpeechV1Routes.openapi(post, async (c) => {
  const body = c.req.valid("json");
  if (!body.text.trim()) return fail(c, "bad_request", "Text must contain at least one character.");
  if (body.text.length > RECORDED_SPEECH_MAX_TEXT) return fail(c, "text_too_long", "Text must be no longer than 4,000 characters.");
  if ((body.speakers?.length ?? 0) > 4) return fail(c, "bad_request", "A dialogue can have up to four speakers.");
  const references: Array<{ audio: Uint8Array; text: string }> = [];
  if (body.speakers?.length) {
    for (const speaker of body.speakers) { const parsed = parseClip(speaker.reference, speaker.reference_text, speaker.reference_sha256); if ("error" in parsed) return fail(c, parsed.tooLarge ? "too_large" : "bad_reference", parsed.error ?? "Invalid reference clip.", parsed.tooLarge ? 413 : 422); references.push({ audio: parsed.audio, text: parsed.text.trim() }); }
  } else if (body.reference !== undefined) {
    const parsed = parseClip(body.reference, body.reference_text, body.reference_sha256); if ("error" in parsed) return fail(c, parsed.tooLarge ? "too_large" : "bad_reference", parsed.error ?? "Invalid reference clip.", parsed.tooLarge ? 413 : 422); references.push({ audio: parsed.audio, text: parsed.text.trim() });
  } else if (body.reference_text !== undefined) return fail(c, "bad_request", "Send the reference clip with its transcript.");
  if (!recordedSpeech.depsAvailable) return fail(c, "unsupported", "Recorded speech is not available on this computer.", 503);
  if (!recordedSpeech.installed) return fail(c, "not_installed", "Install Fish Audio Drama 3 from Home's Engines page, then try again.", 503);
  if (!hasJobRunner(RECORDED_SPEECH_JOB_KIND)) return fail(c, "unsupported", "Recorded speech is not available on this machine.", 503);
  const governor = getGovernorStatus();
  if (getReducedChatState() === "reduced" || governor.tier === "p16" || governor.tier === "p32") return fail(c, "unsupported", "Recorded speech needs a larger memory tier; use the live voice instead.", 503);
  const resident = governor.loaded.filter((item) => item.kind === "resident").reduce((sum, item) => sum + item.peakBytes, 0);
  if (resident + RECORDED_SPEECH_PEAK_BYTES > governor.capBytes) return fail(c, "unsupported", "There is not enough memory for recorded speech alongside the current chat and picture engines; use the live voice instead.", 503);
  const active = listJobs().filter((job) => job.kind === RECORDED_SPEECH_JOB_KIND && ["queued", "running", "stalled"].includes(job.state)).length;
  if (active >= 4) return fail(c, "queue_full", "Four recorded speech jobs are already waiting.", 429);
  const token = crypto.randomUUID(); stashRecordedSpeech(token, body.text, references, body.format);
  const submitted = submitJob({ caller: admissionCaller(c), kind: RECORDED_SPEECH_JOB_KIND, role: "tts", input: { token } });
  if ("refused" in submitted) { unstashRecordedSpeech(token); return fail(c, submitted.code ?? "no_memory", submitted.reason, 503); }
  const settled = await waitForJob(submitted.job.id, body.timeout_ms ?? WAIT);
  if (!settled || ["queued", "running", "stalled"].includes(settled.state)) return c.json({ created: Math.floor(Date.parse(submitted.job.createdAt) / 1000), job: submitted.job.id, data: null }, 202);
  if (settled.state !== "done") return fail(c, settled.state === "cancelled" ? "cancelled" : "failed", recordedSpeechFailure(settled.id)?.message ?? "Recorded speech could not be rendered.", settled.state === "cancelled" ? 499 : 500, settled.id);
  return c.json({ created: Math.floor(Date.parse(settled.createdAt) / 1000), job: settled.id, data: output(settled.id) }, 200);
});
recordedSpeechV1Routes.openapi(status, (c) => { const job = getJob(c.req.param("job")); return job?.kind === RECORDED_SPEECH_JOB_KIND ? c.json(statusOf(job), 200) : fail(c, "not_found", "No recorded speech job has that id.", 404); });
recordedSpeechV1Routes.openapi(cancel, (c) => { const id = c.req.param("job"), job = getJob(id); if (!job || job.kind !== RECORDED_SPEECH_JOB_KIND) return fail(c, "not_found", "No recorded speech job has that id.", 404); if (["queued", "running", "stalled"].includes(job.state)) { cancelJob(id); unstashRecordedSpeech(String((job.input as any)?.token ?? "")); return c.json({ job: id, state: "cancelled" }, 200); } if (job.state === "done") { rmSync(resultDir(id), { recursive: true, force: true }); return c.json({ job: id, state: "deleted" }, 200); } return c.json({ job: id, state: job.state }, 200); });
const fileRoute = createRoute({ method: "get", path: "/{job}/file", tags: ["Recorded speech"], summary: "Fetch rendered speech", request: { params: z.object({ job: z.string() }) }, responses: { 200: { content: { "audio/mp4": { schema: z.any() }, "audio/wav": { schema: z.any() } }, description: "Rendered speech audio." }, 404: { description: "Not found." } } });
recordedSpeechV1Routes.openapi(fileRoute, (c) => { const id = c.req.param("job"), meta = output(id); if (!meta) return fail(c, "not_found", "Rendered speech not found.", 404); const path = join(resultDir(id), meta.content_type === "audio/mp4" ? "speech.m4a" : "speech.wav"); return c.body(readFileSync(path), 200, { "Content-Type": meta.content_type, "Content-Length": String(statSync(path).size), "Accept-Ranges": "bytes" }); });
