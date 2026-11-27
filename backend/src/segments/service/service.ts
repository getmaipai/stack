import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { mediaSegments } from "@/db/schema";
import { dataDir } from "@/lib/paths";
import { sha256OfFile } from "@/lib/fileHash";
import { mediaDeps } from "@/media/jobs";
import { resolveReadable } from "@/media/paths";
import { probeFile } from "@/media/probe";
import { TRANSCRIPTION_JOB_KIND, TRANSCRIPTION_MAX_BYTES, TRANSCRIPTION_MAX_SECONDS, stashTranscription, transcriptionOutput, transcriptionFailure } from "@/speech/transcriptionJobs";
import { registerJobRunner, submitJob, waitForJob, type Job, type JobProgress } from "@/lib/jobs";
import { alignClean } from "../align/align";
import { featuresFromFile, featuresFromSamples } from "../align/features";
import { detectFromTranscript } from "../detect/detect";
import { findHeuristicCandidates } from "../detect/heuristics";
import { applyDecisions, normalizeSegments } from "../core/validate";
import { MediaSegmentsRecord, type MediaSegmentT, type MediaSegmentsRecordT, type SegmentKindT } from "../core/types";

export const SEGMENTS_JOB_KIND = "media.segments";
export const SEGMENTS_PIPELINE_VERSION = "1";
export const SEGMENTS_MAX_FETCH_BYTES = TRANSCRIPTION_MAX_BYTES;
const SegmentRecord = MediaSegmentsRecord.extend({ cleanCopy: z.union([z.boolean(), z.literal("unknown")]).optional() });
const Input = z.object({ url: z.string().url().optional(), path: z.string().min(1).optional(), referenceUrl: z.string().url().optional(), referencePath: z.string().min(1).optional(), kinds: z.array(z.enum(["ad", "sponsor", "selfpromo", "intro", "outro", "recap", "filler"])).optional(), fetch: z.object({ userAgent: z.string().min(1).max(256).optional() }).default({}), allowPrivate: z.boolean().default(false), keepCopy: z.boolean().default(true), expectedDurationSec: z.number().positive().optional() }).strict().refine(v => Boolean(v.url || v.path), "url or path is required").refine(v => !(v.url && v.path), "send url or path, not both").refine(v => !(v.referenceUrl && v.referencePath), "send referenceUrl or referencePath, not both");
export type SegmentsInput = z.infer<typeof Input>;
const PRIVATE_V4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^198\.18\./, /^198\.19\./, /^224\./, /^23[5-9]\./, /^24\d\./, /^25[0-5]\./];
function privateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  if (isIP(normalized) === 4) return PRIVATE_V4.some(re => re.test(normalized));
  if (isIP(normalized) !== 6) return true;
  return normalized === "::1" || normalized === "::" || /^(fc|fd|fe[89ab])/.test(normalized);
}
async function assertPublicTarget(target: URL, allowPrivate: boolean): Promise<void> {
  if (target.protocol !== "https:" && target.protocol !== "http:") throw new Error("Only HTTP and HTTPS media links can be fetched.");
  if (target.username || target.password) throw new Error("This media address is not allowed.");
  if (allowPrivate) return;
  const host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) throw new Error("This media address is not allowed.");
}
const ownFetch = async (url: string, agent = "MaiPai-Stack/1", signal: AbortSignal, allowPrivate = false): Promise<Uint8Array> => {
  let target = new URL(url);
  const timeout = AbortSignal.timeout(30_000);
  const combined = AbortSignal.any([signal, timeout]);
  for (let n = 0; n <= 5; n++) {
    await assertPublicTarget(target, allowPrivate);
    const response = await fetch(target, { headers: { "user-agent": agent || "MaiPai-Stack/1" }, redirect: "manual", signal: combined });
    if ([301,302,303,307,308].includes(response.status)) { if (n === 5) throw new Error("The media link redirected too many times."); const location = response.headers.get("location"); if (!location) throw new Error("The media link returned an invalid redirect."); target = new URL(location, target); continue; }
    if (!response.ok) throw new Error(`The media host returned HTTP ${response.status}.`);
    const len = Number(response.headers.get("content-length") ?? 0); if (len > SEGMENTS_MAX_FETCH_BYTES) throw new Error("The media file exceeds the 250 MB limit.");
    const reader = response.body?.getReader(); if (!reader) throw new Error("The media host returned an empty file.");
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const {done,value} = await reader.read(); if (done) break; size += value.length; if (size > SEGMENTS_MAX_FETCH_BYTES) { await reader.cancel(); throw new Error("The media file exceeds the 250 MB limit."); } chunks.push(value); }
    const out = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; } return out;
  }
  throw new Error("The media link could not be fetched.");
};
export async function fetchSegmentBytesForTests(url: string, agent = "MaiPai-Stack/1", signal = new AbortController().signal, allowPrivate = false): Promise<Uint8Array> {
  return ownFetch(url, agent, signal, allowPrivate);
}
export interface SegmentDeps {
  fetch: (url: string, agent: string, signal: AbortSignal, allowPrivate?: boolean) => Promise<Uint8Array>;
  probe: typeof probeFile;
  transcribe: (path: string, bytes: Uint8Array, signal: AbortSignal, progress: JobProgress) => Promise<Awaited<ReturnType<typeof transcriptionOutput>>>;
  align: typeof alignClean;
  features: typeof featuresFromSamples;
  detect: typeof detectFromTranscript;
  /** Optional audio decoder for feature extraction; an injected implementation makes tests independent of engines. */
  decodeFeatures: (path: string, signal: AbortSignal) => Promise<unknown>;
  chat: (messages: Array<{ role: "system" | "user"; content: string }>, signal: AbortSignal) => Promise<string>;
}
const unavailable = async (): Promise<never> => { throw new Error("The media-segments audio feature adapter is unavailable."); };
export const segmentDeps: SegmentDeps = {
  fetch: ownFetch, probe: probeFile,
  transcribe: async (path, bytes, signal, progress) => {
    const token = crypto.randomUUID(); stashTranscription(token, { source: bytes });
    const submitted = submitJob({ caller: "dev", kind: TRANSCRIPTION_JOB_KIND, role: "stt", input: { token } });
    if ("refused" in submitted) throw new Error(submitted.reason);
    const settled = await waitForJob(submitted.job.id, 30 * 60_000);
    if (!settled || settled.state !== "done") throw new Error(transcriptionFailure(submitted.job.id)?.message ?? settled?.reason ?? "STT transcription did not finish.");
    progress({ status: "transcription complete" }); return transcriptionOutput(settled.id);
  },
  align: alignClean, features: featuresFromSamples, detect: detectFromTranscript as SegmentDeps["detect"], decodeFeatures: async (path, signal) => { if (signal.aborted) throw new Error("Cancelled."); return featuresFromFile(path); },
  chat: async (messages, signal) => { const { requestRole } = await import("@/lib/supervisor"); const result = await requestRole("chat", "/v1/chat/completions", { model: "chat", messages, temperature: 0, max_tokens: 1200 }, signal); return JSON.stringify(result.body); },
};
export function setSegmentDepsForTests(next: Partial<SegmentDeps>): void { Object.assign(segmentDeps, next); }
export function resetSegmentDepsForTests(): void { Object.assign(segmentDeps, { fetch: ownFetch, probe: probeFile, align: alignClean, features: featuresFromSamples, detect: detectFromTranscript as SegmentDeps["detect"], decodeFeatures: async (path: string, signal: AbortSignal) => { if (signal.aborted) throw new Error("Cancelled."); return featuresFromFile(path); } }); }
function storeDir() { const dir = join(dataDir, "segments", "media"); mkdirSync(dir, {recursive:true,mode:0o700}); return dir; }
export function getSegments(hash: string): MediaSegmentsRecordT | null { const row = db.select().from(mediaSegments).where(eq(mediaSegments.fileSha256, hash.toLowerCase())).get(); if (!row) return null; return SegmentRecord.parse(JSON.parse(row.recordJson)); }
export function deleteSegments(hash: string): boolean { const result = db.delete(mediaSegments).where(eq(mediaSegments.fileSha256, hash.toLowerCase())).run() as unknown as { changes: number }; return result.changes > 0; }
export function correctSegment(hash: string, id: string, status: "confirmed" | "rejected"): MediaSegmentsRecordT | null { const record = getSegments(hash); if (!record) return null; const index = record.segments.findIndex(s => s.id === id); if (index < 0) return null; record.segments[index] = { ...record.segments[index]!, status, source: "person", sources: [...new Set<MediaSegmentT["source"]>([...(record.segments[index]!.sources ?? []), "person"])] }; db.update(mediaSegments).set({ recordJson: JSON.stringify(record), updatedAt: new Date().toISOString() }).where(eq(mediaSegments.fileSha256, hash.toLowerCase())).run(); return record; }
async function bytesFromInput(input: SegmentsInput, signal: AbortSignal): Promise<{ bytes: Uint8Array; path: string; fileSha256: string }> {
  if (input.path) { const path = resolveReadable(input.path); const bytes = new Uint8Array(await Bun.file(path).arrayBuffer()); if (bytes.length > SEGMENTS_MAX_FETCH_BYTES) throw new Error("The media file exceeds the 250 MB limit."); return { bytes, path, fileSha256: await sha256OfFile(path) }; }
  const bytes = await segmentDeps.fetch(input.url!, input.fetch.userAgent ?? "MaiPai-Stack/1", signal, input.allowPrivate); const fileSha256 = createHash("sha256").update(bytes).digest("hex"); const suffix = extname(new URL(input.url!).pathname).slice(0,10) || ".audio"; const path = join(storeDir(), `${fileSha256}${suffix}`); if (!existsSync(path)) writeFileSync(path, bytes, {mode:0o600}); return { bytes, path, fileSha256 };
}
export async function runSegmentsForTests(job: Job, signal: AbortSignal, progress: JobProgress): Promise<MediaSegmentsRecordT> {
  const input = Input.parse(job.input ?? {}); progress({status:"fetching audio", percent:2}); const source = await bytesFromInput(input, signal);
  const cached = db.select().from(mediaSegments).where(and(eq(mediaSegments.fileSha256, source.fileSha256),eq(mediaSegments.pipelineVersion,SEGMENTS_PIPELINE_VERSION))).get(); if (cached) return SegmentRecord.parse(JSON.parse(cached.recordJson));
  const mediaPath = source.path.startsWith(storeDir()) ? source.path : join(storeDir(), `${source.fileSha256}${extname(source.path) || ".audio"}`); if (mediaPath !== source.path && !existsSync(mediaPath)) writeFileSync(mediaPath, source.bytes, {mode:0o600});
  const tools = await Promise.all([mediaDeps.toolbox.path("ffprobe", status=>progress({status}),signal),mediaDeps.toolbox.path("ffmpeg", status=>progress({status}),signal)]);
  const probe = await segmentDeps.probe(mediaDeps.run, tools[0]!, mediaPath, signal); if (!probe.has_audio || probe.duration_s === null) throw new Error("This file has no readable audio track."); if (probe.duration_s > TRANSCRIPTION_MAX_SECONDS) throw new Error("The audio is longer than 3 hours.");
  const cleanCopy = input.expectedDurationSec === undefined ? "unknown" : Math.abs(probe.duration_s-input.expectedDurationSec) <= 2 ? true : false;
  let alignment: MediaSegmentT[] = [];
  if (input.referencePath || input.referenceUrl) {
    const refBytes = input.referencePath ? new Uint8Array(await Bun.file(resolveReadable(input.referencePath)).arrayBuffer()) : await segmentDeps.fetch(input.referenceUrl!, input.fetch.userAgent ?? "MaiPai-Stack/1", signal, input.allowPrivate);
    const refPath = join(storeDir(), `${createHash("sha256").update(refBytes).digest("hex")}.reference`); if (!existsSync(refPath)) writeFileSync(refPath,refBytes,{mode:0o600});
    const [ref, stitched] = await Promise.all([segmentDeps.decodeFeatures(refPath,signal),segmentDeps.decodeFeatures(mediaPath,signal)]);
    alignment = (segmentDeps.align(ref as never, stitched as never).inserted as Array<{startSec:number;endSec:number;confidence?:number}>).map((span,i)=>({id:`align-${i}`,kind:"ad",startSec:span.startSec,endSec:span.endSec,confidence:span.confidence ?? 0.9,source:"alignment",sources:["alignment"],status:"auto"}));
  }
  progress({status:"transcribing audio",percent:15}); const transcript = await segmentDeps.transcribe(mediaPath,source.bytes,signal,progress); if (!transcript) throw new Error("STT returned no transcript.");
  const timed = transcript.segments.map(s=>({startSec:s.start,endSec:s.end,text:s.text})); const heuristic = findHeuristicCandidates(timed).map((s,i)=>({id:`heuristic-${i}`,kind:"ad" as SegmentKindT,startSec:s.startSec,endSec:s.endSec,confidence:s.score,source:"text-pattern" as const,sources:["text-pattern" as const],status:"held" as const,label:s.reasons.join(", ")}));
  progress({status:"detecting segments",percent:70}); const detected = await segmentDeps.detect(timed,{llm: async messages => segmentDeps.chat(messages,signal)});
  const llm = (Array.isArray(detected) ? detected : []).map((s:any,i:number)=>({id:`detected-${i}`,kind:(s.kind === "sponsor" || s.kind === "selfpromo" ? s.kind : "ad") as SegmentKindT,startSec:s.startSec,endSec:s.endSec,confidence:s.confidence,source:s.source === "text-pattern" ? "text-pattern" as const : "llm" as const,sources:[s.source === "text-pattern" ? "text-pattern" as const : "llm" as const],status:"held" as const,...(s.label?{label:s.label}:{})})) as MediaSegmentT[];
  const segments = applyDecisions(normalizeSegments([...alignment,...heuristic,...llm],probe.duration_s),probe.duration_s);
  const record = SegmentRecord.parse({fileSha256:source.fileSha256,durationSec:probe.duration_s,segments,producedBy:{transcriptRevision:"stt-current",modelId:"chat-current",pipelineVersion:SEGMENTS_PIPELINE_VERSION,createdAt:new Date().toISOString()},cleanCopy});
  const now = new Date().toISOString(); db.insert(mediaSegments).values({fileSha256:source.fileSha256,pipelineVersion:SEGMENTS_PIPELINE_VERSION,recordJson:JSON.stringify(record),sourcePath:mediaPath,createdAt:now,updatedAt:now}).onConflictDoUpdate({target:mediaSegments.fileSha256,set:{pipelineVersion:SEGMENTS_PIPELINE_VERSION,recordJson:JSON.stringify(record),sourcePath:mediaPath,updatedAt:now}}).run(); progress({status:"segments ready",percent:100}); return record;
}
export function registerSegmentsJob(): void { registerJobRunner(SEGMENTS_JOB_KIND,runSegmentsForTests,{lane:{name:"idle",cap:64,deadlineMs:()=>30*60_000,precheck:(raw)=>{try{const i=Input.parse(raw);if(i.path)resolveReadable(i.path);if(i.referencePath)resolveReadable(i.referencePath);return null;}catch(e){return {reason:e instanceof Error?e.message:"Invalid media segments input",code:"bad_input",status:422};}}}}); }
export function sourcePathFor(hash:string): string | null { return db.select({sourcePath:mediaSegments.sourcePath}).from(mediaSegments).where(eq(mediaSegments.fileSha256,hash.toLowerCase())).get()?.sourcePath ?? null; }
export function updateRecord(record:MediaSegmentsRecordT):void { db.update(mediaSegments).set({recordJson:JSON.stringify(record),updatedAt:new Date().toISOString()}).where(eq(mediaSegments.fileSha256,record.fileSha256)).run(); }
