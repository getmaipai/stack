// MEDIA-STACK-01: the media job kinds on the Stack job API. Home submits with
// POST /stack/v1/jobs { kind, input } and polls GET /stack/v1/jobs/{id}
// (or listens to job.progress on the event feed). All kinds run on the one
// idle lane (lib/jobs.ts `lane`): first in first out, one at a time, at idle
// priority, a cap on the waiting queue, a deadline per kind, and a lane that
// a cancelled or crashed job cannot hold. Contract: docs/integrations.md.
import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { JobFailure, registerJobRunner, type Job, type JobLane, type JobProgress, type JobRefusal } from "@/lib/jobs";
import { clipArgs, FetchInput, fetchArgs, inputProblem, parseFetchProgress, parseFetchedItem, parseProgressSeconds, PreviewInput, ProbeInput, SetupInput, storyboardArgs, thumbnailArgs, TranscodeInput, transcodePlan, type FetchedItem } from "./commands";
import { classifyFetchFailure, hostKey, hostLimiter, type HostLimiter } from "./hosts";
import { archivesDir, jobDir, MediaPathError, resolveReadable, resolveWritableDir, safeName } from "./paths";
import { probeFile, type ProbeResult } from "./probe";
import { spawnRunner, type Runner } from "./run";
import { defaultToolbox, MediaToolError, type MediaToolbox } from "./tools";
import { mkdirSync } from "node:fs";

export const MEDIA_KINDS = ["media.probe", "media.fetch", "media.transcode", "media.preview", "media.setup"] as const;
export type MediaKind = typeof MEDIA_KINDS[number];
export const MEDIA_LANE = "idle";
export const MEDIA_QUEUE_CAP = 64;
const MINUTE = 60_000;
export const MEDIA_DEADLINES_MS: Record<MediaKind, number> = { "media.probe": 3 * MINUTE, "media.preview": 20 * MINUTE, "media.fetch": 3 * 60 * MINUTE, "media.transcode": 12 * 60 * MINUTE, "media.setup": 30 * MINUTE };

export interface MediaDeps { toolbox: MediaToolbox; run: Runner; limiter: HostLimiter; now: () => number; sleep: (ms: number, signal?: AbortSignal) => Promise<void>; }
const realSleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => { const timer = setTimeout(resolve, ms); signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });
export const mediaDeps: MediaDeps = { toolbox: defaultToolbox, run: spawnRunner, limiter: hostLimiter, now: Date.now, sleep: realSleep };
export function setMediaDepsForTests(deps: Partial<MediaDeps>): void { Object.assign(mediaDeps, deps); }
export function resetMediaDepsForTests(): void { Object.assign(mediaDeps, { toolbox: defaultToolbox, run: spawnRunner, limiter: hostLimiter, now: Date.now, sleep: realSleep }); }

/** The failure a job reports: the code is stable (Home branches on it), the message is for the person. */
export interface MediaFailure { code: string; message: string; host?: string; quiet?: boolean; quiet_until?: string | null; detail?: string; }
const fail = (failure: MediaFailure): JobFailure => new JobFailure(failure.message, { failure });

function pathFailure(error: unknown): JobFailure | null {
  if (error instanceof MediaPathError) return fail({ code: error.code, message: error.message });
  if (error instanceof MediaToolError) return fail({ code: error.code, message: error.message });
  return null;
}

/** Validates what can be validated before a job takes a place in the queue: the shape of the input, every path, and a background fetch against a resting host. */
function precheck(kind: MediaKind): (input: Record<string, unknown>) => JobRefusal | null {
  return (input) => {
    try {
      if (kind === "media.probe") resolveReadable(ProbeInput.parse(input).path);
      else if (kind === "media.transcode") { const parsed = TranscodeInput.parse(input); resolveReadable(parsed.path); if (parsed.output_dir) resolveWritableDir(parsed.output_dir); if (parsed.output_name) safeName(parsed.output_name, ""); }
      else if (kind === "media.preview") { const parsed = PreviewInput.parse(input); resolveReadable(parsed.path); if (parsed.output_dir) resolveWritableDir(parsed.output_dir); }
      else if (kind === "media.setup") SetupInput.parse(input);
      else {
        const parsed = FetchInput.parse(input);
        if (parsed.cookies_path) resolveReadable(parsed.cookies_path, "The cookies file");
        if (parsed.output_dir) resolveWritableDir(parsed.output_dir);
        const host = hostKey(parsed.url);
        if (!host) return { reason: "The link is not a web address the Stack can read.", code: "bad_input", status: 422 };
        const admission = mediaDeps.limiter.admission(host, parsed.person_initiated);
        if (!admission.ok) return { reason: `${host} asked the Stack to slow down, so background checks for it rest until ${new Date(admission.quietUntil).toISOString()}. A request a person makes still goes through.`, code: "media_quiet_mode", status: 503 };
      }
      return null;
    } catch (error) {
      if (error instanceof MediaPathError) return { reason: error.message, code: error.code, status: 422 };
      if (error && typeof error === "object" && "issues" in error) return { reason: inputProblem(error as never), code: "bad_input", status: 422 };
      throw error;
    }
  };
}

const laneFor = (kind: MediaKind): JobLane => ({ name: MEDIA_LANE, cap: MEDIA_QUEUE_CAP, deadlineMs: () => MEDIA_DEADLINES_MS[kind], precheck: precheck(kind) });

type Status = (status: string) => void;
const statusOf = (progress: JobProgress): Status => (status) => progress({ status });
const sizeOf = (path: string): number => { try { return statSync(path).size; } catch { return 0; } };

async function toolPaths(names: Array<"ffmpeg" | "ffprobe" | "yt-dlp">, progress: JobProgress, signal: AbortSignal): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of names) {
    try { out[name] = await mediaDeps.toolbox.path(name, statusOf(progress), signal); } catch (error) { throw pathFailure(error) ?? error; }
  }
  return out;
}

function cancelled(signal: AbortSignal): void { if (signal.aborted) throw new Error("Cancelled."); }

// ---- media.probe ----
async function runProbe(job: Job, signal: AbortSignal, progress: JobProgress): Promise<ProbeResult & { elapsed_ms: number }> {
  const started = mediaDeps.now();
  let path: string;
  try { path = resolveReadable(ProbeInput.parse(job.input ?? {}).path); } catch (error) { throw pathFailure(error) ?? error; }
  const tools = await toolPaths(["ffprobe"], progress, signal);
  progress({ status: "reading the file" });
  try { return { ...await probeFile(mediaDeps.run, tools.ffprobe!, path, signal), elapsed_ms: mediaDeps.now() - started }; } catch (error) { if (signal.aborted) throw error; throw fail({ code: "unreadable", message: error instanceof Error ? error.message : String(error) }); }
}

// ---- media.fetch ----
export interface FetchResult { host: string; output_dir: string; count: number; items: Array<FetchedItem & { size_bytes: number; subtitle_paths: string[]; thumbnail_path: string | null }>; warnings: string[]; elapsed_ms: number; }
function sidecars(item: FetchedItem): { subtitle_paths: string[]; thumbnail_path: string | null } {
  const stem = item.path.slice(0, item.path.length - extname(item.path).length);
  const dir = dirname(item.path);
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { /* gone */ }
  const own = (name: string) => join(dir, name).startsWith(stem + ".");
  const thumbnail = names.find((name) => own(name) && /\.(jpe?g|png|webp)$/i.test(name));
  return { subtitle_paths: names.filter((name) => own(name) && name.endsWith(".vtt")).map((name) => join(dir, name)).sort(), thumbnail_path: thumbnail ? join(dir, thumbnail) : null };
}

async function runFetch(job: Job, signal: AbortSignal, progress: JobProgress): Promise<FetchResult> {
  const started = mediaDeps.now();
  const input = FetchInput.parse(job.input ?? {});
  const host = hostKey(input.url);
  if (!host) throw fail({ code: "bad_input", message: "The link is not a web address the Stack can read." });
  const admission = mediaDeps.limiter.admission(host, input.person_initiated);
  if (!admission.ok) throw fail({ code: "media_quiet_mode", host, quiet: true, quiet_until: new Date(admission.quietUntil).toISOString(), message: `${host} asked the Stack to slow down. Background checks for it rest until ${new Date(admission.quietUntil).toISOString()}.` });
  if (admission.waitMs > 0) { progress({ status: "waiting to keep a gentle pace with the site" }); await mediaDeps.sleep(admission.waitMs, signal); cancelled(signal); }
  let outputDir: string; let cookies: string | null = null;
  try {
    outputDir = input.output_dir ? resolveWritableDir(input.output_dir) : jobDir(job.id);
    if (input.cookies_path) cookies = resolveReadable(input.cookies_path, "The cookies file");
  } catch (error) { throw pathFailure(error) ?? error; }
  const tools = await toolPaths(["ffmpeg", "yt-dlp"], progress, signal);
  let archiveFile: string | null = null;
  if (input.archive_key) { mkdirSync(archivesDir(), { recursive: true, mode: 0o700 }); archiveFile = join(archivesDir(), `${input.archive_key}.txt`); }
  const items: FetchedItem[] = [];
  mediaDeps.limiter.started(host);
  progress({ status: "contacting the site" });
  const result = await mediaDeps.run(fetchArgs(input, { ytDlp: tools["yt-dlp"]!, ffmpegDir: dirname(tools.ffmpeg!), outputDir, archiveFile, cookiesFile: cookies }), {
    signal,
    onStdoutLine: (line) => {
      const download = parseFetchProgress(line);
      if (download) { progress({ completedBytes: download.completedBytes, totalBytes: Math.max(download.totalBytes, download.completedBytes), status: items.length ? `downloading item ${items.length + 1}` : "downloading", ...(download.bytesPerSecond === undefined ? {} : { bytesPerSecond: download.bytesPerSecond }) }); return; }
      const item = parseFetchedItem(line);
      if (item) { items.push(item); progress({ status: `finished ${items.length} item${items.length === 1 ? "" : "s"}` }); }
    },
  });
  if (result.aborted || signal.aborted) throw new Error("Cancelled.");
  const warnings = result.stderr.split("\n").filter((line) => /^(WARNING|ERROR)/.test(line.trim())).slice(-5).map((line) => line.trim().slice(0, 300));
  // 101 is yt-dlp saying max_items was reached, which is how a subscription stops.
  const ok = result.code === 0 || result.code === 101;
  if (!ok) {
    const failure = classifyFetchFailure(result.stderr);
    const state = mediaDeps.limiter.record(host, failure.pushback ? "pushback" : "other");
    if (items.length === 0) {
      if (!input.output_dir) rmSync(outputDir, { recursive: true, force: true });
      throw fail({ code: failure.code, message: failure.message, host, quiet: state.quiet, quiet_until: state.quietUntil === null ? null : new Date(state.quietUntil).toISOString(), detail: result.stderr.trim().split("\n").slice(-6).join("\n").slice(-1200) });
    }
    warnings.push(`Some items did not download: ${failure.message}`);
  } else mediaDeps.limiter.record(host, "success");
  return { host, output_dir: outputDir, count: items.length, items: items.map((item) => ({ ...item, size_bytes: sizeOf(item.path), ...sidecars(item) })), warnings, elapsed_ms: mediaDeps.now() - started };
}

// ---- media.transcode ----
export interface TranscodeResult { path: string; size_bytes: number; container: "mp4" | "m4a"; video_action: string; audio_action: string; duration_s: number | null; width: number | null; height: number | null; video_codec: string | null; audio_codec: string | null; elapsed_ms: number; }
async function runTranscode(job: Job, signal: AbortSignal, progress: JobProgress): Promise<TranscodeResult> {
  const started = mediaDeps.now();
  const input = TranscodeInput.parse(job.input ?? {});
  let src: string; let dir: string; let stem: string;
  try {
    src = resolveReadable(input.path);
    dir = input.output_dir ? resolveWritableDir(input.output_dir) : jobDir(job.id);
    stem = safeName(input.output_name, basename(src, extname(src)));
  } catch (error) { throw pathFailure(error) ?? error; }
  const tools = await toolPaths(["ffmpeg", "ffprobe"], progress, signal);
  progress({ status: "reading the file" });
  let source: ProbeResult;
  try { source = await probeFile(mediaDeps.run, tools.ffprobe!, src, signal); } catch (error) { if (signal.aborted) throw error; throw fail({ code: "unreadable", message: error instanceof Error ? error.message : String(error) }); }
  if (!source.has_video && !source.has_audio) throw fail({ code: "unreadable", message: "That file has no picture or sound to convert." });
  const final0 = join(dir, `${stem}.${source.has_video ? "mp4" : "m4a"}`);
  if (final0 === src) throw fail({ code: "bad_input", message: "The converted file would replace the original. Choose another output folder or name." });
  const partial = `${final0}.part`;
  const plan = transcodePlan(input, { has_video: source.has_video, has_audio: source.has_audio, video_codec: source.video_codec, pix_fmt: source.streams.find((stream) => stream.type === "video" && !stream.cover_art)?.pix_fmt ?? null, height: source.height, audio_codec: source.audio_codec }, tools.ffmpeg!, src, partial);
  const total = source.duration_s ?? 0;
  progress({ status: "converting", percent: 0 });
  const result = await mediaDeps.run(plan.args, { signal, onStdoutLine: (line) => { const seconds = parseProgressSeconds(line); if (seconds !== null && total > 0) progress({ percent: Math.min(99, Math.round((seconds / total) * 100)), status: "converting" }); } });
  if (result.aborted || signal.aborted) { rmSync(partial, { force: true }); throw new Error("Cancelled."); }
  if (result.code !== 0 || !existsSync(partial)) { rmSync(partial, { force: true }); throw fail({ code: "failed", message: "The file could not be converted. Open Details for what the tool said.", detail: result.stderr.trim().split("\n").slice(-6).join("\n").slice(-1200) }); }
  renameSync(partial, final0);
  let after: ProbeResult | null = null;
  try { after = await probeFile(mediaDeps.run, tools.ffprobe!, final0, signal); } catch { /* the file is there; the summary is a courtesy */ }
  return { path: final0, size_bytes: sizeOf(final0), container: plan.container, video_action: plan.video, audio_action: plan.audio, duration_s: after?.duration_s ?? source.duration_s, width: after?.width ?? null, height: after?.height ?? null, video_codec: after?.video_codec ?? null, audio_codec: after?.audio_codec ?? null, elapsed_ms: mediaDeps.now() - started };
}

// ---- media.preview ----
export interface PreviewResult {
  duration_s: number | null;
  thumbnail: { path: string; width: number | null; height: number | null; at_s: number | null; from_cover_art: boolean; size_bytes: number } | null;
  storyboard: { path: string; width: number | null; height: number | null; columns: number; rows: number; tile_width: number; tile_height: number; interval_s: number; frames: number; size_bytes: number } | null;
  clip: { path: string; start_s: number; duration_s: number; height: number | null; has_audio: false; size_bytes: number } | null;
  skipped: Array<{ part: "thumbnail" | "storyboard" | "clip"; reason: string }>;
  elapsed_ms: number;
}
const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);
async function runPreview(job: Job, signal: AbortSignal, progress: JobProgress): Promise<PreviewResult> {
  const started = mediaDeps.now();
  const input = PreviewInput.parse(job.input ?? {});
  let src: string; let dir: string;
  try { src = resolveReadable(input.path); dir = input.output_dir ? resolveWritableDir(input.output_dir) : jobDir(job.id); } catch (error) { throw pathFailure(error) ?? error; }
  const tools = await toolPaths(["ffmpeg", "ffprobe"], progress, signal);
  progress({ status: "reading the file" });
  let source: ProbeResult;
  try { source = await probeFile(mediaDeps.run, tools.ffprobe!, src, signal); } catch (error) { if (signal.aborted) throw error; throw fail({ code: "unreadable", message: error instanceof Error ? error.message : String(error) }); }
  const duration = source.duration_s ?? 0;
  const stem = safeName(undefined, basename(src, extname(src))).replace(/[^\w.-]+/g, "_");
  const out: PreviewResult = { duration_s: source.duration_s, thumbnail: null, storyboard: null, clip: null, skipped: [], elapsed_ms: 0 };
  const runFfmpeg = async (args: string[], target: string, what: string): Promise<boolean> => {
    const result = await mediaDeps.run(args, { signal });
    if (result.aborted || signal.aborted) { rmSync(target, { force: true }); throw new Error("Cancelled."); }
    if (result.code !== 0 || sizeOf(target) === 0) { rmSync(target, { force: true }); out.skipped.push({ part: what as "thumbnail", reason: `The tool could not make it: ${result.stderr.trim().split("\n").slice(-1)[0] ?? `exit ${result.code}`}` }); return false; }
    return true;
  };
  const dimensions = async (path: string): Promise<{ width: number | null; height: number | null }> => { try { const probed = await probeFile(mediaDeps.run, tools.ffprobe!, path, signal); return { width: probed.width, height: probed.height }; } catch { return { width: null, height: null }; } };
  const steps = [input.thumbnail, input.storyboard, input.clip].filter(Boolean).length || 1;
  let done = 0;
  const step = (status: string) => progress({ status, percent: Math.round((done / steps) * 100) });

  if (input.thumbnail) {
    step("making the thumbnail");
    if (!source.has_video && !source.has_cover_art) out.skipped.push({ part: "thumbnail", reason: "This file has no picture." });
    else {
      const target = join(dir, `${stem}.thumb.jpg`);
      const fromCover = !source.has_video;
      const at = fromCover ? 0 : Math.min(Math.max(input.thumbnail_at_s ?? duration * 0.1, duration > 2 ? 1 : 0), Math.max(0, duration - 0.5));
      if (await runFfmpeg(thumbnailArgs(tools.ffmpeg!, src, target, at, input.thumbnail_width, fromCover), target, "thumbnail")) out.thumbnail = { path: target, ...await dimensions(target), at_s: fromCover ? null : Math.round(at * 1000) / 1000, from_cover_art: fromCover, size_bytes: sizeOf(target) };
    }
    done += 1;
  }
  if (input.storyboard) {
    step("making the storyboard");
    if (!source.has_video) out.skipped.push({ part: "storyboard", reason: "This file has no video." });
    else if (duration < 1) out.skipped.push({ part: "storyboard", reason: "This video is too short for a storyboard." });
    else {
      const frames = Math.max(1, Math.min(input.storyboard_frames, Math.floor(duration)));
      const interval = duration / frames;
      const columns = Math.min(input.storyboard_columns, frames);
      const rows = Math.ceil(frames / columns);
      const tileHeight = source.width && source.height ? even((input.storyboard_tile_width * source.height) / source.width) : even((input.storyboard_tile_width * 9) / 16);
      const target = join(dir, `${stem}.storyboard.jpg`);
      if (await runFfmpeg(storyboardArgs(tools.ffmpeg!, src, target, interval, columns, rows, input.storyboard_tile_width), target, "storyboard")) out.storyboard = { path: target, ...await dimensions(target), columns, rows, tile_width: input.storyboard_tile_width, tile_height: tileHeight, interval_s: Math.round(interval * 1000) / 1000, frames, size_bytes: sizeOf(target) };
    }
    done += 1;
  }
  if (input.clip) {
    step("making the preview clip");
    if (!source.has_video) out.skipped.push({ part: "clip", reason: "This file has no video." });
    else if (duration < 1) out.skipped.push({ part: "clip", reason: "This video is too short for a preview clip." });
    else {
      const length = Math.min(input.clip_length_s, duration);
      const start = Math.max(0, Math.min(input.clip_start_s ?? duration * 0.3, duration - length));
      const target = join(dir, `${stem}.preview.mp4`);
      if (await runFfmpeg(clipArgs(tools.ffmpeg!, src, target, start, length, input.clip_height), target, "clip")) out.clip = { path: target, start_s: Math.round(start * 1000) / 1000, duration_s: Math.round(length * 1000) / 1000, height: (await dimensions(target)).height, has_audio: false, size_bytes: sizeOf(target) };
    }
    done += 1;
  }
  out.elapsed_ms = mediaDeps.now() - started;
  return out;
}

// ---- media.setup ----
async function runSetup(_job: Job, signal: AbortSignal, progress: JobProgress): Promise<{ tools: Record<string, string>; elapsed_ms: number }> {
  const started = mediaDeps.now();
  const tools = await toolPaths(["ffmpeg", "ffprobe", "yt-dlp"], progress, signal);
  return { tools, elapsed_ms: mediaDeps.now() - started };
}

export function registerMediaJobs(): void {
  registerJobRunner("media.probe", runProbe, { lane: laneFor("media.probe") });
  registerJobRunner("media.fetch", runFetch, { lane: laneFor("media.fetch") });
  registerJobRunner("media.transcode", runTranscode, { lane: laneFor("media.transcode") });
  registerJobRunner("media.preview", runPreview, { lane: laneFor("media.preview") });
  registerJobRunner("media.setup", runSetup, { lane: laneFor("media.setup") });
}
