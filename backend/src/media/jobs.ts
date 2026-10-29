// MEDIA-STACK-01: the media job kinds on the Stack job API. Home submits with
// POST /stack/v1/jobs { kind, input } and polls GET /stack/v1/jobs/{id}
// (or listens to job.progress on the event feed). All kinds run on the one
// idle lane (lib/jobs.ts `lane`): first in first out, one at a time, at idle
// priority, a cap on the waiting queue, a deadline per kind, and a lane that
// a cancelled or crashed job cannot hold. Contract: docs/integrations.md.
import { closeSync, copyFileSync, createReadStream, createWriteStream, existsSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { JobFailure, registerJobRunner, type Job, type JobLane, type JobProgress, type JobRefusal } from "@/lib/jobs";
import { clipArgs, CompanionClipInput, FetchInput, fetchArgs, inputProblem, parseFetchProgress, parseFetchedItem, parseProgressSeconds, PreviewInput, ProbeInput, SetupInput, storyboardArgs, thumbnailArgs, TranscodeInput, transcodePlan, type FetchedItem } from "./commands";
import { classifyFetchFailure, hostKey, hostLimiter, type HostLimiter } from "./hosts";
import { archivesDir, jobDir, MediaPathError, resolveReadable, resolveWritableDir, safeName } from "./paths";
import { probeFile, type ProbeResult } from "./probe";
import { idleArgv, spawnRunner, type Runner, type RunResult } from "./run";
import { defaultToolbox, MediaToolError, type MediaToolbox } from "./tools";
import { mkdirSync } from "node:fs";
import { COLOUR_MATCH_STRENGTH, COMPANION_CLIP_FPS, COMPANION_CLIP_SIZE, ONESHOT_SETTLE_FRAMES, applyColourMatch, companionCrop, companionMetrics, companionReasons, crossfadeLoop, downscaleRgba4, frameDifference, keyOutRgba, selectCompanionWindow } from "./companionClip";

export const MEDIA_KINDS = ["media.probe", "media.fetch", "media.transcode", "media.preview", "media.companion_clip", "media.setup"] as const;
export type MediaKind = typeof MEDIA_KINDS[number];
export const MEDIA_LANE = "idle";
export const MEDIA_QUEUE_CAP = 64;
const MINUTE = 60_000;
export const MEDIA_DEADLINES_MS: Record<MediaKind, number> = { "media.probe": 3 * MINUTE, "media.preview": 20 * MINUTE, "media.fetch": 3 * 60 * MINUTE, "media.transcode": 12 * 60 * MINUTE, "media.companion_clip": 20 * MINUTE, "media.setup": 30 * MINUTE };

type RawInputRunner = (argv: string[], inputPath: string, signal: AbortSignal) => Promise<RunResult>;
async function spawnRawInputRunner(argv: string[], inputPath: string, signal: AbortSignal): Promise<RunResult> {
  const child = Bun.spawn(idleArgv(argv), { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  let aborted = false;
  const kill = () => { aborted = true; try { child.kill("SIGTERM"); } catch { /* exited */ } };
  if (signal.aborted) kill(); else signal.addEventListener("abort", kill, { once: true });
  const stderrPromise = new Response(child.stderr).text().catch(() => "");
  const writing = (async () => {
    try {
      for await (const chunk of createReadStream(inputPath)) {
        if (signal.aborted) break;
        child.stdin.write(chunk as Uint8Array); await child.stdin.flush();
      }
      child.stdin.end();
    } catch { try { child.stdin.end(); } catch { /* closed */ } }
  })();
  const code = await child.exited; await writing;
  const stderr = await stderrPromise; signal.removeEventListener("abort", kill);
  return { code, stdout: "", stderr, aborted: aborted || signal.aborted };
}
export interface MediaDeps { toolbox: MediaToolbox; run: Runner; runRaw: RawInputRunner; limiter: HostLimiter; now: () => number; sleep: (ms: number, signal?: AbortSignal) => Promise<void>; }
const realSleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => { const timer = setTimeout(resolve, ms); signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });
export const mediaDeps: MediaDeps = { toolbox: defaultToolbox, run: spawnRunner, runRaw: spawnRawInputRunner, limiter: hostLimiter, now: Date.now, sleep: realSleep };
export function setMediaDepsForTests(deps: Partial<MediaDeps>): void { Object.assign(mediaDeps, deps); }
export function resetMediaDepsForTests(): void { Object.assign(mediaDeps, { toolbox: defaultToolbox, run: spawnRunner, runRaw: spawnRawInputRunner, limiter: hostLimiter, now: Date.now, sleep: realSleep }); }

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
      else if (kind === "media.companion_clip") { const parsed = CompanionClipInput.parse(input); resolveReadable(parsed.path); if (parsed.output_dir) resolveWritableDir(parsed.output_dir); if (parsed.output_name) safeName(parsed.output_name, ""); }
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

// Home's player un-premultiplies in a shader: colour on top is premultiplied by alpha, with the matte repeated below.
// `premultiply=inplace=1` multiplies by the frame's own alpha; the two-input form left the key colour in the colour half (green fringes, 2026-10-29).
export const COMPANION_STACK_FILTER = "[0:v]format=gbrap,split=2[c][m0];[m0]alphaextract,format=gray,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[myuv];[c]premultiply=inplace=1,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[cpm];[cpm][myuv]vstack=inputs=2[out]";
const COMPANION_MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const COMPANION_MAX_SOURCE_SECONDS = 12;
const extOkay = (path: string) => [".mp4", ".mov", ".webm"].includes(extname(path).toLowerCase());
export const alphaPixelFormat = (pixel: string | null) => !!pixel && /(?:yuva|gbrap|rgba|bgra|argb|abgr|ya\d|pal8)/i.test(pixel);

async function decodeRgbaToFile(ffmpeg: string, path: string, width: number, rawPath: string, signal: AbortSignal, progress: JobProgress, forceVp9Alpha = false): Promise<number> {
  const frameBytes = width * COMPANION_CLIP_SIZE * 4;
  const argv = idleArgv([ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", ...(forceVp9Alpha ? ["-c:v", "libvpx-vp9"] : []), "-i", path, "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", "fps=24,scale=-2:480:flags=lanczos,format=rgba", "-frames:v", "288", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let aborted = false;
  const kill = () => { aborted = true; try { child.kill("SIGTERM"); } catch { /* exited */ } };
  if (signal.aborted) kill(); else signal.addEventListener("abort", kill, { once: true });
  const stderrPromise = new Response(child.stderr).text().catch(() => "");
  const reader = child.stdout.getReader();
  const out = createWriteStream(rawPath, { flags: "w", mode: 0o600 });
  let frames = 0;
  let carry = new Uint8Array(0), read = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const bytes = new Uint8Array(carry.length + next.value.length); bytes.set(carry); bytes.set(next.value, carry.length);
      let offset = 0;
      while (bytes.length - offset >= frameBytes && frames < 288) {
        const frame = bytes.subarray(offset, offset + frameBytes);
        if (!out.write(frame)) await new Promise<void>((resolve) => out.once("drain", resolve));
        offset += frameBytes; read++; frames++;
        if (read % 12 === 0) progress({ status: "reading the clip", percent: Math.min(40, Math.round(read / 288 * 40)) });
      }
      carry = bytes.slice(offset);
    }
  } finally { reader.releaseLock(); out.end(); await new Promise<void>((resolve, reject) => { out.once("finish", resolve); out.once("error", reject); }); }
  const code = await child.exited; const stderr = await stderrPromise; signal.removeEventListener("abort", kill);
  if (aborted || signal.aborted) throw new Error("Cancelled.");
  if (code !== 0) throw fail({ code: "unreadable", message: `The clip could not be decoded. Use an mp4, mov or webm clip with a readable video track. ${stderr.trim().split("\n").slice(-1)[0] ?? ""}` });
  if (carry.length) throw fail({ code: "unreadable", message: "The clip ended in an incomplete video frame. Export it again as mp4, mov or webm." });
  return frames;
}

function readRawFrame(fd: number, index: number, frameBytes: number): Uint8Array {
  const frame = new Uint8Array(frameBytes); let offset = 0;
  while (offset < frameBytes) { const read = readSync(fd, frame, offset, frameBytes - offset, index * frameBytes + offset); if (!read) throw new Error("The temporary clip frame could not be read."); offset += read; }
  return frame;
}
function writeRawFrame(fd: number, index: number, frame: Uint8Array): void {
  let offset = 0;
  while (offset < frame.length) { const written = writeSync(fd, frame, offset, frame.length - offset, index * frame.length + offset); if (!written) throw new Error("The temporary clip frame could not be written."); offset += written; }
}
function blendRawFrame(target: Uint8Array, fd: number, index: number, weight: number): void {
  const chunk = new Uint8Array(64 * 1024); let offset = 0;
  while (offset < target.length) {
    const size = Math.min(chunk.length, target.length - offset), read = readSync(fd, chunk, 0, size, index * target.length + offset);
    if (!read) throw new Error("The loop continuation frame could not be read.");
    for (let i = 0; i < read; i++) target[offset + i] = Math.round(target[offset + i]! * (1 - weight) + chunk[i]! * weight);
    offset += read;
  }
}
function smoothRawMatte(rawPath: string, frameCount: number, frameBytes: number, key: "#00FF00" | "#FF00FF" | "none", signal: AbortSignal): void {
  const fd = openSync(rawPath, "r+");
  const keyFrame = (n: number) => { const frame = readRawFrame(fd, n, frameBytes); if (key !== "none") keyOutRgba(frame, key === "#00FF00" ? [0, 255, 0] : [255, 0, 255], { width: frameBytes / 4 / COMPANION_CLIP_SIZE, height: COMPANION_CLIP_SIZE }, signal); return frame; };
  const med = (a: number, b: number, c: number) => a > b ? (b > c ? b : Math.min(a, c)) : (a > c ? a : Math.min(b, c));
  try {
    if (frameCount === 1) { const only = keyFrame(0); writeRawFrame(fd, 0, only); return; }
    let previous = keyFrame(0), current = keyFrame(1);
    for (let p = 3; p < frameBytes; p += 4) previous[p] = med(previous[p]!, previous[p]!, current[p]!);
    writeRawFrame(fd, 0, previous);
    for (let n = 2; n < frameCount; n++) {
      cancelled(signal);
      const next = keyFrame(n);
      for (let p = 3; p < frameBytes; p += 4) current[p] = med(previous[p]!, current[p]!, next[p]!);
      writeRawFrame(fd, n - 1, current);
      previous = current; current = next;
    }
    for (let p = 3; p < frameBytes; p += 4) current[p] = med(previous[p]!, current[p]!, current[p]!);
    writeRawFrame(fd, frameCount - 1, current);
  } finally { closeSync(fd); }
}

function readSmallFrames(rawPath: string, count: number, frameBytes: number, width: number, height: number, signal: AbortSignal): Uint8Array[] {
  const fd = openSync(rawPath, "r"), small: Uint8Array[] = [];
  try {
    for (let i = 0; i < count; i++) { cancelled(signal); small.push(downscaleRgba4(readRawFrame(fd, i, frameBytes), width, height).frame); }
  } finally { closeSync(fd); }
  return small;
}

function readKeptFrames(rawPath: string, start: number, length: number, frameBytes: number): Uint8Array[] {
  const fd = openSync(rawPath, "r"), frames: Uint8Array[] = [];
  try { for (let i = 0; i < length; i++) frames.push(readRawFrame(fd, start + i, frameBytes)); }
  finally { closeSync(fd); }
  return frames;
}

async function writeCrop(frames: Uint8Array[], width: number, height: number, crop: { x: number; y: number; size: number }, path: string, signal: AbortSignal): Promise<void> {
  const out = createWriteStream(path, { flags: "w", mode: 0o600 });
  try {
    for (const frame of frames) {
      cancelled(signal);
      for (let y = 0; y < crop.size; y++) {
        const row = new Uint8Array(crop.size * 4), sy = y + crop.y;
        if (sy >= 0 && sy < height) for (let x = 0; x < crop.size; x++) {
          const sx = x + crop.x;
          if (sx >= 0 && sx < width) {
            const from = (sy * width + sx) * 4, to = x * 4;
            row[to] = frame[from]!; row[to + 1] = frame[from + 1]!; row[to + 2] = frame[from + 2]!; row[to + 3] = frame[from + 3]!;
          }
        }
        if (!out.write(row)) await new Promise<void>((resolve) => out.once("drain", resolve));
      }
    }
    out.end(); await new Promise<void>((resolve, reject) => { out.once("finish", resolve); out.once("error", reject); });
  } catch (error) { out.destroy(); throw error; }
}

async function runCompanionClip(job: Job, signal: AbortSignal, progress: JobProgress): Promise<Record<string, unknown>> {
  const input = CompanionClipInput.parse(job.input ?? {}); let src: string, dir: string;
  try { src = resolveReadable(input.path); dir = input.output_dir ? resolveWritableDir(input.output_dir) : jobDir(job.id); if (input.output_name) dir = resolveWritableDir(join(dir, safeName(input.output_name, ""))); }
  catch (error) { throw pathFailure(error) ?? error; }
  const workDir = jobDir(job.id);
  for (const output of ["clip.h264.mp4", "clip.av1.mp4", "still.png", "report.json"]) if (existsSync(join(dir, output))) throw fail({ code: "bad_input", message: "The output folder already has a companion clip file. Choose an empty output folder or another output name." });
  const started = mediaDeps.now();
  const tools = await toolPaths(["ffmpeg", "ffprobe"], progress, signal);
  if (!extOkay(src)) throw fail({ code: "bad_input", message: "Use an mp4, mov or webm clip. Rename or export the clip in one of those formats." });
  progress({ status: "reading the clip", percent: 0 });
  let source: ProbeResult;
  try { source = await probeFile(mediaDeps.run, tools.ffprobe!, src, signal); }
  catch (error) { if (signal.aborted) throw error; throw fail({ code: "unreadable", message: "The clip could not be read. Use a readable mp4, mov or webm clip." }); }
  if (!source.has_video) throw fail({ code: "unreadable", message: "The clip has no video track. Use a clip with a picture." });
  if (source.duration_s === null) throw fail({ code: "unreadable", message: "The clip length could not be read. Use a standard mp4, mov or webm clip." });
  if (source.duration_s > COMPANION_MAX_SOURCE_SECONDS) throw fail({ code: "bad_input", message: "The clip is longer than 12 seconds. Use a clip of 10 seconds or less." });
  if (source.size_bytes > COMPANION_MAX_SOURCE_BYTES) throw fail({ code: "bad_input", message: "The clip is larger than 64 MB. Export a smaller clip and try again." });
  const stream = source.streams.find((entry) => entry.type === "video" && !entry.cover_art);
  const taggedAlpha = source.tags.alpha_mode === "1";
  const formatAlpha = alphaPixelFormat(stream?.pix_fmt ?? null);
  const alpha = formatAlpha || taggedAlpha;
  if (input.key === "none" && !alpha) throw fail({ code: "no_alpha", message: "This clip has no transparent background. Use a clip on a plain green or magenta background and tell Home which one." });
  const width = Math.max(2, Math.round(((source.width ?? 480) * COMPANION_CLIP_SIZE / Math.max(1, source.height ?? 480)) / 2) * 2);
  let partials: string[] = [], created: string[] = [];
  try {
    const forceVp9Alpha = input.key === "none" && taggedAlpha && !formatAlpha && extname(src).toLowerCase() === ".webm" && stream?.codec === "vp9";
    const rawDecoded = join(workDir, ".companion-decoded.rgba"); partials.push(rawDecoded);
    const frameBytes = width * COMPANION_CLIP_SIZE * 4;
    const frameCount = await decodeRgbaToFile(tools.ffmpeg!, src, width, rawDecoded, signal, progress, forceVp9Alpha);
    if (!frameCount) throw fail({ code: "unreadable", message: "The clip has no decodable video frames. Use a readable mp4, mov or webm clip." });
    progress({ status: "reading the clip", percent: 40 });
    progress({ status: "cutting out the background", percent: 42 });
    smoothRawMatte(rawDecoded, frameCount, frameBytes, input.key, signal);
    cancelled(signal);
    progress({ status: "fitting the loop", percent: 50 });
    let window: { start: number; length: number; spare: number };
    try {
      const smallFrames = input.kind === "loop" ? readSmallFrames(rawDecoded, frameCount, frameBytes, width, COMPANION_CLIP_SIZE, signal) : [];
      window = selectCompanionWindow(smallFrames, input.kind, frameCount, input.min_seconds, input.max_seconds, signal);
      smallFrames.length = 0;
    }
    catch (error) { if (error instanceof Error && error.message.includes("shorter")) throw fail({ code: "too_short", message: "The clip is shorter than this state needs. Make it again." }); throw error; }
    const keptFrames = readKeptFrames(rawDecoded, window.start, window.length, frameBytes);
    let referenceFrames: Uint8Array[] | undefined, colourMatchApplied = false;
    if (input.palette_reference) {
      const referencePath = join(workDir, ".companion-palette-reference.png"), referenceRaw = join(workDir, ".companion-palette-reference.rgba");
      partials.push(referencePath, referenceRaw);
      writeFileSync(referencePath, Buffer.from(input.palette_reference, "base64"), { mode: 0o600 });
      const referenceResult = await mediaDeps.run([tools.ffmpeg!, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", referencePath, "-frames:v", "1", "-vf", "scale=480:480:flags=lanczos,format=rgba", "-f", "rawvideo", "-pix_fmt", "rgba", referenceRaw], { signal });
      if (referenceResult.aborted || signal.aborted) throw new Error("Cancelled.");
      if (referenceResult.code !== 0 || sizeOf(referenceRaw) !== 480 * 480 * 4) throw fail({ code: "bad_input", message: "The palette reference could not be read as an image." });
      const referenceFd = openSync(referenceRaw, "r");
      try { referenceFrames = [readRawFrame(referenceFd, 0, 480 * 480 * 4)]; } finally { closeSync(referenceFd); }
      colourMatchApplied = applyColourMatch(keptFrames, referenceFrames, COLOUR_MATCH_STRENGTH);
      rmSync(referencePath, { force: true }); rmSync(referenceRaw, { force: true });
      partials = partials.filter((path) => path !== referencePath && path !== referenceRaw);
    }
    let loopGap = 0;
    const blendFrame = (frame: Uint8Array, toward: Uint8Array, weight: number) => { for (let i = 0; i < frame.length; i++) frame[i] = Math.round(frame[i]! * (1 - weight) + toward[i]! * weight); };
    if (input.kind === "oneshot") {
      const fade = Math.min(6, keptFrames.length);
      for (let i = 0; i < fade; i++) { const index = keptFrames.length - fade + i; keptFrames[index] = keptFrames[index]!.slice(); blendFrame(keptFrames[index]!, keptFrames[0]!, (i + 1) / fade); }
      loopGap = frameDifference(keptFrames[keptFrames.length - 1]!, keptFrames[0]!, width, COMPANION_CLIP_SIZE, signal);
    } else {
      // A seamless cycle when the window has spare frames; otherwise the old short fade toward the frames after the window.
      const cycle = window.spare ? crossfadeLoop(keptFrames, keptFrames.length - window.spare) : { frames: keptFrames, crossfaded: false };
      if (cycle.crossfaded) { keptFrames.length = 0; keptFrames.push(...cycle.frames); }
      else {
        const available = frameCount - window.start - window.length, fade = Math.min(4, keptFrames.length, available);
        if (fade) {
          const fd = openSync(rawDecoded, "r");
          try { for (let i = 0; i < fade; i++) { const index = keptFrames.length - fade + i; blendRawFrame(keptFrames[index]!, fd, window.start + window.length + i, (i + 1) / fade); } }
          finally { closeSync(fd); }
        }
      }
      loopGap = frameDifference(keptFrames[keptFrames.length - 1]!, keptFrames[0]!, width, COMPANION_CLIP_SIZE, signal);
    }
    const metrics = companionMetrics(keptFrames, width, COMPANION_CLIP_SIZE, input.colours, referenceFrames);
    const keptFrameCount = keptFrames.length;
    const crop = companionCrop(keptFrames, width, COMPANION_CLIP_SIZE);
    const rawCrop = join(workDir, ".companion-crop.rgba"), rawScaled = join(workDir, ".companion-scaled.rgba"); partials.push(rawCrop, rawScaled);
    await writeCrop(keptFrames, width, COMPANION_CLIP_SIZE, crop, rawCrop, signal);
    keptFrames.length = 0;
    rmSync(rawDecoded, { force: true }); partials = partials.filter((p) => p !== rawDecoded);
    progress({ status: "fitting the loop", percent: 60 });
    const scaleResult = await mediaDeps.run([tools.ffmpeg!, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${crop.size}x${crop.size}`, "-framerate", "24", "-i", rawCrop, "-frames:v", String(keptFrameCount), "-vf", "scale=480:480:flags=lanczos,format=rgba", "-f", "rawvideo", "-pix_fmt", "rgba", rawScaled], { signal });
    if (scaleResult.aborted || signal.aborted) throw new Error("Cancelled.");
    if (scaleResult.code !== 0 || !existsSync(rawScaled)) throw fail({ code: "unreadable", message: "The clip frames could not be resized. Use a smaller, standard video clip." });
    const outputPath = (file: string) => join(dir, file), stagePath = (file: string) => join(workDir, `.companion-${file}`), still = outputPath("still.png"), reportPath = outputPath("report.json");
    created.push(still, reportPath);
    const stillStage = stagePath("still.png"), stillPart = `${stillStage}.part`; partials.push(stillStage, stillPart);
    const stillResult = await mediaDeps.run([tools.ffmpeg!, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "480x480", "-framerate", "24", "-i", rawScaled, "-vf", `select=eq(n\\,${Math.floor(keptFrameCount / 2)})`, "-frames:v", "1", "-plays", "0", "-f", "image2", "-vcodec", "png", stillPart], { signal });
    if (stillResult.aborted || signal.aborted) throw new Error("Cancelled.");
    if (stillResult.code !== 0 || !existsSync(stillPart)) throw fail({ code: "unreadable", message: "The transparent still could not be written. Try the clip again." });
    renameSync(stillPart, stillStage); partials = partials.filter((p) => p !== stillPart);
    copyFileSync(stillStage, still); rmSync(stillStage, { force: true }); partials = partials.filter((p) => p !== stillStage);
    const check = await mediaDeps.run([tools.ffmpeg!, "-hide_banner", "-encoders"], { signal, collectStdout: true });
    const encoders = check.stdout + check.stderr, hasAv1 = /\blibsvtav1\b/.test(encoders);
    progress({ status: "encoding", percent: 60 });
    const files: Array<{ name: string; path: string; bytes: number }> = [{ name: "still.png", path: still, bytes: sizeOf(still) }];
    const encode = async (encoder: "libx264" | "libsvtav1", crfStart: number, targetName: string, progressBase: number, progressSpan: number) => {
      const final = outputPath(targetName), partial = `${stagePath(targetName)}.part`; partials.push(partial);
      for (let crf = crfStart; crf <= 38; crf += 2) {
        cancelled(signal);
        progress({ status: "encoding", percent: Math.min(progressBase + progressSpan - 1, progressBase + Math.round(((crf - crfStart) / 16) * progressSpan)) });
        rmSync(partial, { force: true });
        const args = [tools.ffmpeg!, "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "480x480", "-framerate", "24", "-i", "pipe:0", "-filter_complex", COMPANION_STACK_FILTER, "-map", "[out]", "-an", "-c:v", encoder, ...(encoder === "libx264" ? ["-preset", "slow", "-tune", "animation"] : ["-preset", "6"]), "-crf", String(crf), "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", "-movflags", "+faststart", "-r", "24", "-f", "mp4", partial];
        const result = await mediaDeps.runRaw(args, rawScaled, signal);
        if (result.aborted || signal.aborted) throw new Error("Cancelled.");
        if (result.code !== 0 || !existsSync(partial)) { rmSync(partial, { force: true }); throw fail({ code: "unreadable", message: "The clip could not be encoded. Try a shorter or simpler source clip.", detail: result.stderr.trim().split("\n").slice(-6).join("\n").slice(-1200) }); }
        if (sizeOf(partial) <= input.max_bytes) { const finalSize = sizeOf(partial); copyFileSync(partial, final); created.push(final); rmSync(partial, { force: true }); partials = partials.filter((p) => p !== partial); return { name: targetName, path: final, bytes: finalSize }; }
      }
      rmSync(partial, { force: true }); throw fail({ code: "too_large", message: "The clip is too large to ship. Make a shorter or simpler clip." });
    };
    files.push(await encode("libx264", 24, "clip.h264.mp4", 60, hasAv1 ? 20 : 40));
    if (hasAv1) files.push(await encode("libsvtav1", 24, "clip.av1.mp4", 80, 20));
    const seconds = keptFrameCount / COMPANION_CLIP_FPS;
    const reasons = companionReasons({ ...metrics, loop_gap: loopGap }, seconds, input.min_seconds, input.max_seconds);
    const report = { seconds, frames: keptFrameCount, fps: COMPANION_CLIP_FPS, width: 480, height: 960, files, av1: hasAv1, loop_gap: loopGap, settle_skipped_frames: input.kind === "oneshot" ? Math.min(ONESHOT_SETTLE_FRAMES, Math.max(0, frameCount - 24)) : 0, colour_match: { applied: colourMatchApplied, strength: COLOUR_MATCH_STRENGTH }, ...metrics, ok: reasons.length === 0, reasons };
    writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    rmSync(rawCrop, { force: true }); rmSync(rawScaled, { force: true });
    progress({ status: "encoding", percent: 100 });
    return { ...report, report_path: reportPath, elapsed_ms: mediaDeps.now() - started };
  } catch (error) {
    for (const partial of partials) rmSync(partial, { force: true });
    for (const file of created) rmSync(file, { force: true });
    if (signal.aborted) throw new Error("Cancelled.");
    throw error;
  }
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
  registerJobRunner("media.companion_clip", runCompanionClip, { lane: laneFor("media.companion_clip") });
  registerJobRunner("media.setup", runSetup, { lane: laneFor("media.setup") });
}
