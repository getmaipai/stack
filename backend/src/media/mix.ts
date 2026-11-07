import { createHash } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import type { Job, JobProgress } from "@/lib/jobs";
import { jobDir, resolveReadable, resolveWritableDir, safeName } from "./paths";
import { defaultToolbox } from "./tools";
import { spawnRunner } from "./run";
import { probeFile } from "./probe";

export const MixInput = z.object({ tracks: z.array(z.object({ path: z.string(), start_ms: z.number().int().min(0), gain_db: z.number().min(-60).max(24).default(0), fade_in_ms: z.number().int().min(0).default(0), fade_out_ms: z.number().int().min(0).default(0), end_ms: z.number().int().min(1).optional() }).strict().refine((t) => !t.fade_out_ms || t.end_ms !== undefined, { message: "A track with a fade out needs end_ms (its length in milliseconds), so the fade knows where to start." })).min(1).max(400), duck: z.object({ under: z.array(z.number().int().min(0)), by_db: z.number().default(8) }).nullable().default(null), loudness_lufs: z.number().min(-24).max(-12).default(-16), output: z.object({ dir: z.string().optional(), name: z.string().regex(/\.(m4a|wav)$/i) }).strict(), chapters: z.array(z.object({ start_ms: z.number().int().min(0), title: z.string().min(1) }).strict()).optional() }).strict();

function wavDuration(bytes: Uint8Array): number { const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let rate = 0, data = 0; for (let at = 12; at + 8 <= bytes.length;) { const tag = String.fromCharCode(...bytes.slice(at, at + 4)), size = view.getUint32(at + 4, true); if (tag === "fmt ") rate = view.getUint32(at + 16, true); if (tag === "data") data = size; at += 8 + size + (size & 1); } if (!rate) throw new Error("The rendered WAV has no sample rate. Choose a valid output name and try again."); return data / rate; }

function filterFor(input: z.infer<typeof MixInput>): string {
  const chains = input.tracks.map((t, i) => { const filters = [ ...(t.end_ms === undefined ? [] : [`atrim=end=${t.end_ms / 1000}`]), ...(t.fade_in_ms ? [`afade=t=in:d=${t.fade_in_ms / 1000}`] : []), ...(t.fade_out_ms ? [`afade=t=out:st=${Math.max(0, (t.end_ms ?? 0) - t.fade_out_ms) / 1000}:d=${t.fade_out_ms / 1000}`] : []), `volume=${t.gain_db}dB`, `adelay=${t.start_ms}|${t.start_ms}` ]; return `[${i}:a]${filters.join(",")}[a${i}]`; });
  let labels = input.tracks.map((_, i) => `a${i}`);
  if (input.duck) {
    const under = [...new Set(input.duck.under)]; if (under.some((i) => i >= labels.length)) throw new Error("A duck track index is outside the track list. Choose an existing track.");
    const ducked = labels.map((_, i) => i).filter((i) => !under.includes(i));
    if (ducked.length) {
      // The ducking tracks are summed once, then split: an ffmpeg label may be consumed only once, so each ducked track gets its own copy of the key.
      for (const i of under) chains.push(`[a${i}]asplit=2[key${i}][keep${i}]`);
      chains.push(`${under.map((i) => `[key${i}]`).join("")}${under.length > 1 ? `amix=inputs=${under.length}:normalize=0,` : ""}asplit=${ducked.length}${ducked.map((i) => `[side${i}]`).join("")}`);
      for (const i of ducked) chains.push(`[a${i}][side${i}]sidechaincompress=threshold=0.03:ratio=8[duck${i}]`);
      labels = labels.map((label, i) => under.includes(i) ? `keep${i}` : `duck${i}`);
    }
  }
  chains.push(`${labels.map((label) => `[${label}]`).join("")}amix=inputs=${labels.length}:normalize=0:dropout_transition=0,loudnorm=I=${input.loudness_lufs}:TP=-1.5:LRA=11[out]`); return chains.join(";");
}
export async function runMix(job: Job, signal: AbortSignal, progress: JobProgress) {
  const input = MixInput.parse(job.input ?? {}); const tracks = input.tracks.map((t) => resolveReadable(t.path)); const dir = input.output.dir ? resolveWritableDir(input.output.dir) : jobDir(job.id); const name = safeName(input.output.name, "mix.wav"); const target = join(dir, name); const part = `${target}.part`; const ffmpeg = process.env.STACK_MEDIA_FFMPEG ?? await defaultToolbox.path("ffmpeg", (status) => progress({ status }), signal);
  let meta: string | null = null; const args = [ffmpeg, "-y", ...tracks.flatMap((path) => ["-i", path])];
  if (input.chapters?.length && name.toLowerCase().endsWith(".m4a")) { meta = join(dir, `.${basename(name)}.ffmeta`); writeFileSync(meta, `;FFMETADATA1\n${input.chapters.map((c, i) => `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${c.start_ms}\nEND=${input.chapters![i + 1]?.start_ms ?? c.start_ms + 1}\ntitle=${c.title.replace(/[=;#\\]/g, "\\$&")}`).join("\n")}\n`, { mode: 0o600 }); args.push("-i", meta); }
  args.push("-filter_complex", filterFor(input), "-map", "[out]", ...(meta ? ["-map_metadata", String(tracks.length)] : []), "-ar", "48000", ...(name.toLowerCase().endsWith(".m4a") ? ["-c:a", "aac", "-b:a", "160k", "-f", "ipod"] : ["-c:a", "pcm_s16le", "-f", "wav"]), "-progress", "pipe:1", part);
  try { const result = await spawnRunner(args, { signal, onStdoutLine: (line) => { const m = /out_time_ms=(\d+)/.exec(line); if (m) progress({ status: `mixing audio (${Math.round(Number(m[1]) / 1000)} ms)` }); } }); if (result.code !== 0 || signal.aborted) throw new Error(`The audio mix failed with ffmpeg exit code ${result.code}. Check the track files and try again.`); renameSync(part, target); } catch (error) { rmSync(part, { force: true }); if (meta) rmSync(meta, { force: true }); throw error; }
  const bytes = readFileSync(target);
  let duration_s: number;
  if (name.toLowerCase().endsWith(".wav")) duration_s = wavDuration(bytes);
  else { const ffprobe = process.env.STACK_MEDIA_FFPROBE ?? await defaultToolbox.path("ffprobe", (status) => progress({ status }), signal); const probe = await probeFile(spawnRunner, ffprobe, target, signal); duration_s = probe.duration_s ?? 0; }
  return { path: target, duration_s, sha256: createHash("sha256").update(bytes).digest("hex") };
}
