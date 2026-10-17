// MEDIA-STACK-01: the inputs of the media job kinds and the exact command
// lines they run. Pure functions: a test reads the arguments without a
// binary. The yt-dlp arguments are FileTube's (embed metadata, thumbnail and
// chapters; subtitles as VTT; one download archive per source; cookies only
// when Home passes a cookies file the owner configured).
import { z } from "zod";

const Path = z.string().min(1).max(4096);
export const ProbeInput = z.object({ path: Path }).strict();
export type ProbeInput = z.infer<typeof ProbeInput>;

export const FetchInput = z.object({
  url: z.string().url().max(4096).refine((value) => /^https?:\/\//i.test(value), "Only http and https links can be fetched."),
  kind: z.enum(["video", "audio"]).default("video"),
  /** The highest picture height to download; best means no ceiling. Ignored for audio. */
  quality: z.enum(["best", "2160", "1440", "1080", "720", "480", "360"]).default("best"),
  /** True for a channel or playlist link; false takes the one video the link names. */
  playlist: z.boolean().default(false),
  /** Names this source's download archive, so an item fetched before is never fetched again. Letters, digits, dot, dash, underscore. */
  archive_key: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/).optional(),
  /** Newest items taken per call for a playlist (a subscription's max_per_check). */
  max_items: z.number().int().min(1).max(100).optional(),
  /** YYYYMMDD: nothing uploaded before this day (a subscription's cutoff). */
  date_after: z.string().regex(/^\d{8}$/).optional(),
  min_duration_s: z.number().int().min(0).max(86_400 * 7).optional(),
  max_duration_s: z.number().int().min(1).max(86_400 * 7).optional(),
  /** A Netscape cookies file inside a declared folder; passed only when the owner configured cookies. */
  cookies_path: Path.optional(),
  /** True when a person asked for this now; false (the default) is a background poll and is refused while the site is resting. */
  person_initiated: z.boolean().default(false),
  subtitles: z.boolean().default(true),
  limit_rate_kbps: z.number().int().min(50).max(1_000_000).optional(),
  /** Where the files go: a folder inside a declared write folder. Default: a folder the job owns, which Home reads and then releases. */
  output_dir: Path.optional(),
}).strict();
export type FetchInput = z.infer<typeof FetchInput>;

export const TranscodeInput = z.object({
  path: Path,
  output_dir: Path.optional(),
  /** File name without extension; default: the source's name. */
  output_name: z.string().min(1).max(200).optional(),
  /** Scale down to at most this height; never scales up. */
  max_height: z.number().int().min(144).max(4320).optional(),
  /** auto copies the picture when it is already 8-bit H.264 within max_height, otherwise encodes. */
  video: z.enum(["auto", "encode", "copy"]).default("auto"),
  audio: z.enum(["auto", "encode"]).default("auto"),
  crf: z.number().int().min(14).max(35).default(23),
  preset: z.enum(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium"]).default("veryfast"),
  audio_bitrate_k: z.number().int().min(64).max(320).default(160),
}).strict();
export type TranscodeInput = z.infer<typeof TranscodeInput>;

export const PreviewInput = z.object({
  path: Path,
  output_dir: Path.optional(),
  thumbnail: z.boolean().default(true),
  storyboard: z.boolean().default(true),
  clip: z.boolean().default(true),
  /** Seconds into the file for the thumbnail; default 10 percent in, at least 1 second. */
  thumbnail_at_s: z.number().min(0).max(86_400 * 7).optional(),
  thumbnail_width: z.number().int().min(160).max(1920).default(640),
  storyboard_columns: z.number().int().min(2).max(20).default(10),
  /** Most frames in the sheet (columns times rows); the interval follows from the duration. */
  storyboard_frames: z.number().int().min(4).max(400).default(100),
  storyboard_tile_width: z.number().int().min(80).max(480).default(160),
  clip_start_s: z.number().min(0).max(86_400 * 7).optional(),
  clip_length_s: z.number().min(1).max(30).default(6),
  clip_height: z.number().int().min(120).max(720).default(360),
}).strict();
export type PreviewInput = z.infer<typeof PreviewInput>;

export const SetupInput = z.object({ person_initiated: z.boolean().default(true) }).strict();

/** The sentence a bad input gets: the first problem, in words. */
export function inputProblem(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "The job input is not valid.";
  const field = issue.path.length ? issue.path.join(".") : "input";
  if (issue.code === "unrecognized_keys") return `The job input has a field the media service does not know (${(issue as { keys?: string[] }).keys?.join(", ")}). Check docs/integrations.md for the fields.`;
  return `${field}: ${issue.message}. Check docs/integrations.md for the fields of this job.`;
}

const HEIGHT_FORMAT = (height: string): string => (height === "best" ? "" : `[height<=${height}]`);

export interface FetchContext { ytDlp: string; ffmpegDir: string; outputDir: string; archiveFile: string | null; cookiesFile: string | null; }
export const FETCH_PRINT_FIELDS = "id,title,uploader,channel,channel_id,duration,upload_date,timestamp,webpage_url,extractor_key,ext,filepath,description,playlist_title,playlist_index";

/** The yt-dlp command line for a fetch, FileTube's arguments plus the person-paced extras. */
export function fetchArgs(input: FetchInput, context: FetchContext): string[] {
  const args = [context.ytDlp, "--ignore-config", "--no-colors", "--newline", "--ffmpeg-location", context.ffmpegDir,
    input.playlist ? "--yes-playlist" : "--no-playlist",
    "--embed-metadata", "--embed-thumbnail", "--embed-chapters",
    "--no-mtime", "--windows-filenames", "--retries", "3", "--fragment-retries", "3", "--socket-timeout", "30",
    "--no-simulate", "--quiet", "--progress", "--progress-template", "download:MPPROG %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s",
    "--print", `after_move:MPJSON %(.{${FETCH_PRINT_FIELDS}})j`,
    "-o", `${context.outputDir}/%(title).150B [%(id)s].%(ext)s`];
  if (input.kind === "audio") args.push("-f", "bestaudio[ext=m4a]/bestaudio/best", "-x", "--audio-format", "m4a");
  else args.push("-f", `bv*${HEIGHT_FORMAT(input.quality)}+ba/b${HEIGHT_FORMAT(input.quality)}`, "-S", "vcodec:h264,res,acodec:aac", "--merge-output-format", "mp4");
  if (input.subtitles && input.kind === "video") args.push("--write-subs", "--write-auto-subs", "--sub-langs", "en.*", "--convert-subs", "vtt");
  if (context.archiveFile) args.push("--download-archive", context.archiveFile);
  if (input.playlist && context.archiveFile) args.push("--break-on-existing", "--lazy-playlist");
  if (input.max_items) args.push("--playlist-end", String(input.max_items), "--max-downloads", String(input.max_items));
  if (input.date_after) args.push("--dateafter", input.date_after);
  const filters = ["!is_live"];
  if (input.min_duration_s !== undefined) filters.push(`duration >= ${input.min_duration_s}`);
  if (input.max_duration_s !== undefined) filters.push(`duration <= ${input.max_duration_s}`);
  args.push("--match-filters", filters.join(" & "));
  if (context.cookiesFile) args.push("--cookies", context.cookiesFile);
  if (input.limit_rate_kbps) args.push("--limit-rate", `${input.limit_rate_kbps}K`);
  // A background poll goes at a person's pace: a pause between requests and between files. A person's own request does not wait.
  if (!input.person_initiated) args.push("--sleep-requests", "1", "--sleep-interval", "3", "--max-sleep-interval", "8");
  args.push("--", input.url);
  return args;
}

/** Parses the MPPROG progress lines yt-dlp's template prints. */
export function parseFetchProgress(line: string): { completedBytes: number; totalBytes: number; bytesPerSecond?: number } | null {
  if (!line.startsWith("MPPROG ")) return null;
  const [downloaded, total, estimate, speed] = line.slice(7).trim().split(/\s+/);
  const completed = Number(downloaded); if (!Number.isFinite(completed)) return null;
  const totalBytes = Number.isFinite(Number(total)) ? Number(total) : Number.isFinite(Number(estimate)) ? Number(estimate) : 0;
  const rate = Number(speed);
  return { completedBytes: completed, totalBytes, ...(Number.isFinite(rate) ? { bytesPerSecond: rate } : {}) };
}

export interface FetchedItem { id: string; title: string | null; uploader: string | null; channel: string | null; channel_id: string | null; duration_s: number | null; upload_date: string | null; webpage_url: string | null; extractor: string | null; ext: string | null; description: string | null; playlist_title: string | null; playlist_index: number | null; path: string; }
/** Parses the MPJSON line printed after each file is moved into place. */
export function parseFetchedItem(line: string): FetchedItem | null {
  if (!line.startsWith("MPJSON ")) return null;
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(line.slice(7)) as Record<string, unknown>; } catch { return null; }
  const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
  const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
  const path = text(raw.filepath); const id = text(raw.id);
  if (!path || !id) return null;
  const day = text(raw.upload_date);
  return { id, title: text(raw.title), uploader: text(raw.uploader), channel: text(raw.channel), channel_id: text(raw.channel_id), duration_s: number(raw.duration), upload_date: day && /^\d{8}$/.test(day) ? `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}` : null, webpage_url: text(raw.webpage_url), extractor: text(raw.extractor_key), ext: text(raw.ext), description: text(raw.description), playlist_title: text(raw.playlist_title), playlist_index: number(raw.playlist_index), path };
}

export interface TranscodePlan { video: "copy" | "encode" | "none"; audio: "copy" | "encode" | "none"; args: string[]; output: string; container: "mp4" | "m4a"; }
export interface TranscodeSource { has_video: boolean; has_audio: boolean; video_codec: string | null; pix_fmt: string | null; height: number | null; audio_codec: string | null; }

/** H.264 + AAC + faststart, once. Copies the picture or the sound when it is already right; audio-only files become m4a. */
export function transcodePlan(input: TranscodeInput, source: TranscodeSource, ffmpeg: string, inputPath: string, output: string): TranscodePlan {
  const base = [ffmpeg, "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-progress", "pipe:1", "-nostats", "-i", inputPath, "-map_chapters", "0", "-map_metadata", "0"];
  const tooTall = input.max_height !== undefined && source.height !== null && source.height > input.max_height;
  const h264Ready = source.video_codec === "h264" && (source.pix_fmt === "yuv420p" || source.pix_fmt === null) && !tooTall;
  const video: TranscodePlan["video"] = !source.has_video ? "none" : input.video === "copy" ? "copy" : input.video === "encode" ? "encode" : h264Ready ? "copy" : "encode";
  const audio: TranscodePlan["audio"] = !source.has_audio ? "none" : input.audio === "auto" && source.audio_codec === "aac" ? "copy" : "encode";
  const args = [...base];
  if (video !== "none") args.push("-map", "0:v:0");
  if (audio !== "none") args.push("-map", "0:a:0");
  else args.push("-an");
  if (video === "none") args.push("-vn");
  if (video === "copy") args.push("-c:v", "copy");
  if (video === "encode") {
    args.push("-c:v", "libx264", "-preset", input.preset, "-crf", String(input.crf), "-pix_fmt", "yuv420p", "-profile:v", "high");
    if (input.max_height) args.push("-vf", `scale=-2:'min(${input.max_height},ih)'`);
  }
  args.push("-sn", "-dn");
  if (audio === "copy") args.push("-c:a", "copy");
  if (audio === "encode") args.push("-c:a", "aac", "-b:a", `${input.audio_bitrate_k}k`, "-ac", "2");
  const container = video === "none" ? "m4a" : "mp4";
  // The playable tag Safari and Apple devices need for H.264 is avc1, which libx264 and a copied H.264 stream already carry.
  args.push("-movflags", "+faststart", "-f", container === "m4a" ? "ipod" : "mp4", output);
  return { video, audio, args, output, container };
}

/** Seconds of output so far from an ffmpeg -progress line (out_time_us, or out_time_ms which ffmpeg also writes in microseconds). */
export function parseProgressSeconds(line: string): number | null {
  const match = /^out_time_(?:us|ms)=(\d+)$/.exec(line.trim());
  return match ? Number(match[1]) / 1_000_000 : null;
}

export function thumbnailArgs(ffmpeg: string, inputPath: string, output: string, at: number, width: number, fromCoverArt: boolean): string[] {
  const common = [ffmpeg, "-hide_banner", "-nostdin", "-y", "-loglevel", "error"];
  return fromCoverArt
    ? [...common, "-i", inputPath, "-map", "0:v:0", "-frames:v", "1", "-vf", `scale='min(${width},iw)':-2`, "-q:v", "3", output]
    : [...common, "-ss", at.toFixed(3), "-i", inputPath, "-map", "0:v:0", "-frames:v", "1", "-vf", `scale='min(${width},iw)':-2`, "-q:v", "3", output];
}

export function storyboardArgs(ffmpeg: string, inputPath: string, output: string, intervalS: number, columns: number, rows: number, tileWidth: number): string[] {
  return [ffmpeg, "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-i", inputPath, "-map", "0:v:0", "-an", "-sn", "-vf", `fps=1/${intervalS.toFixed(3)},scale=${tileWidth}:-2,tile=${columns}x${rows}`, "-frames:v", "1", "-q:v", "5", output];
}

export function clipArgs(ffmpeg: string, inputPath: string, output: string, start: number, length: number, height: number): string[] {
  return [ffmpeg, "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-ss", start.toFixed(3), "-i", inputPath, "-t", length.toFixed(3), "-map", "0:v:0", "-an", "-sn", "-vf", `scale=-2:'min(${height},ih)'`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", output];
}

