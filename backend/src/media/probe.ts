// MEDIA-STACK-01: ffprobe's JSON turned into the one shape Home stores
// (duration, codecs with the hvc1/hev1 tag, size, chapters, tags, the date and
// source URL a fetch embedded). Pure functions; the runner is injected.
import { statSync } from "node:fs";
import type { Runner } from "./run";

export interface ProbeStream { index: number; type: "video" | "audio" | "subtitle" | "attachment" | "data"; codec: string; codec_tag: string | null; profile: string | null; width: number | null; height: number | null; pix_fmt: string | null; fps: number | null; channels: number | null; sample_rate: number | null; bit_rate: number | null; language: string | null; default: boolean; cover_art: boolean; }
export interface ProbeChapter { index: number; start_s: number; end_s: number; title: string | null; }
export interface ProbeResult {
  path: string; size_bytes: number; format: string; duration_s: number | null; bit_rate: number | null;
  has_video: boolean; has_audio: boolean; has_cover_art: boolean;
  width: number | null; height: number | null; video_codec: string | null; /** For HEVC: hvc1 (plays in Safari and on Apple devices) or hev1 (does not). Null for other codecs. */ hevc_tag: "hvc1" | "hev1" | null;
  audio_codec: string | null; channels: number | null; sample_rate: number | null;
  projection: string | null; rotation: number | null;
  streams: ProbeStream[]; chapters: ProbeChapter[];
  /** Every tag, keys lower-cased, format tags over stream tags. */
  tags: Record<string, string>;
  title: string | null; /** ISO date (YYYY-MM-DD, or a year) from the date tag a fetch embeds; null when none. */ embedded_date: string | null; /** The creation_time tag as ISO, which is often the file's date, not the publish date. */ created_at: string | null;
  /** The page the file was fetched from (yt-dlp writes it as the purl tag). */ source_url: string | null;
}

type Raw = Record<string, unknown>;
const num = (value: unknown): number | null => { const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN; return Number.isFinite(parsed) ? parsed : null; };
const str = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
function fps(rate: unknown): number | null {
  const text = str(rate); if (!text) return null;
  const [top, bottom] = text.split("/").map(Number);
  return top && bottom ? Math.round((top / bottom) * 1000) / 1000 : null;
}
function lowerTags(tags: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (tags && typeof tags === "object") for (const [key, value] of Object.entries(tags as Raw)) if (typeof value === "string" || typeof value === "number") out[key.toLowerCase()] = String(value);
  return out;
}

/** 20240131 -> 2024-01-31; 2024-01-31T10:00:00Z -> 2024-01-31; 2024 -> 2024; anything else null. */
export function isoDate(value: string | undefined): string | null {
  if (!value) return null;
  const text = value.trim();
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text); if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const dashed = /^(\d{4})-(\d{2})-(\d{2})/.exec(text); if (dashed) return `${dashed[1]}-${dashed[2]}-${dashed[3]}`;
  return /^\d{4}$/.test(text) ? text : null;
}

export function normalizeProbe(raw: Raw, path: string, sizeBytes: number): ProbeResult {
  const format = (raw.format ?? {}) as Raw;
  const streams: ProbeStream[] = ((raw.streams ?? []) as Raw[]).map((stream) => {
    const type = str(stream.codec_type);
    const disposition = (stream.disposition ?? {}) as Raw;
    return {
      index: num(stream.index) ?? 0, type: type === "video" || type === "audio" || type === "subtitle" || type === "attachment" ? type : "data",
      codec: str(stream.codec_name) ?? "unknown", codec_tag: str(stream.codec_tag_string), profile: str(stream.profile),
      width: num(stream.width), height: num(stream.height), pix_fmt: str(stream.pix_fmt), fps: type === "video" ? fps(stream.avg_frame_rate) : null,
      channels: num(stream.channels), sample_rate: num(stream.sample_rate), bit_rate: num(stream.bit_rate), language: str(lowerTags(stream.tags).language),
      default: disposition.default === 1, cover_art: disposition.attached_pic === 1,
    };
  });
  const video = streams.find((stream) => stream.type === "video" && !stream.cover_art) ?? null;
  const audio = streams.find((stream) => stream.type === "audio") ?? null;
  const rawVideo = ((raw.streams ?? []) as Raw[]).find((stream) => stream.index === video?.index);
  const sideData = ((rawVideo?.side_data_list ?? []) as Raw[]);
  const spherical = sideData.find((entry) => String(entry.side_data_type ?? "").toLowerCase().includes("spherical"));
  const display = sideData.find((entry) => String(entry.side_data_type ?? "").toLowerCase().includes("display matrix"));
  const streamTags = streams.length ? Object.assign({}, ...((raw.streams ?? []) as Raw[]).filter((stream) => stream.codec_type === "video" || stream.codec_type === "audio").reverse().map((stream) => lowerTags(stream.tags))) as Record<string, string> : {};
  const tags = { ...streamTags, ...lowerTags(format.tags) };
  const chapters: ProbeChapter[] = ((raw.chapters ?? []) as Raw[]).map((chapter, index) => ({ index, start_s: num(chapter.start_time) ?? 0, end_s: num(chapter.end_time) ?? 0, title: str(lowerTags(chapter.tags).title) }));
  const comment = tags.comment && /^https?:\/\/\S+$/.test(tags.comment) ? tags.comment : null;
  const duration = num(format.duration) ?? (video ? num(((raw.streams ?? []) as Raw[]).find((stream) => stream.index === video.index)?.duration) : null);
  const created = tags.creation_time ? tags.creation_time : null;
  return {
    path, size_bytes: sizeBytes, format: str(format.format_name) ?? "unknown", duration_s: duration === null ? null : Math.round(duration * 1000) / 1000, bit_rate: num(format.bit_rate),
    has_video: !!video, has_audio: !!audio, has_cover_art: streams.some((stream) => stream.cover_art),
    width: video?.width ?? null, height: video?.height ?? null, video_codec: video?.codec ?? null,
    hevc_tag: video?.codec === "hevc" ? (video.codec_tag === "hvc1" ? "hvc1" : "hev1") : null,
    audio_codec: audio?.codec ?? null, channels: audio?.channels ?? null, sample_rate: audio?.sample_rate ?? null,
    projection: spherical ? str(spherical.projection)?.toLowerCase() ?? "spherical" : null, rotation: display ? num(display.rotation) : null,
    streams, chapters, tags, title: tags.title ?? null,
    embedded_date: isoDate(tags.date) ?? isoDate(tags.originaldate) ?? isoDate(tags.year) ?? isoDate(tags.releasedate),
    created_at: created, source_url: tags.purl ?? tags.url ?? comment,
  };
}

export function probeArgs(ffprobe: string, path: string): string[] {
  return [ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-show_chapters", "-i", path];
}

/** Probes a file already validated by paths.ts. Throws a plain-words Error when ffprobe cannot read it. */
export async function probeFile(run: Runner, ffprobe: string, path: string, signal?: AbortSignal): Promise<ProbeResult> {
  const result = await run(probeArgs(ffprobe, path), { signal, collectStdout: true });
  if (result.aborted) throw new Error("Cancelled.");
  if (result.code !== 0) throw new Error(`The file could not be read as media (${result.stderr.trim().split("\n").slice(-1)[0] ?? `ffprobe exited ${result.code}`}). It may be damaged or not a video or audio file.`);
  let parsed: Raw;
  try { parsed = JSON.parse(result.stdout) as Raw; } catch { throw new Error("The media tool returned something unreadable for this file. Try again."); }
  return normalizeProbe(parsed, path, statSync(path).size);
}
