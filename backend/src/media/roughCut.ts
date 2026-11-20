// VF-ROUGHCUT-01 (architect MEDIA-ROUGH-CUT-01): the Stack media job `media.rough_cut`. One still per shot at its real length with its
// motion, each spoken line voiced, joined into one file, plus the timings the kit storyboard_player block plays. It is built from the media.edit
// step builders (kenburns, captions, concat), media.tts's speech call and an audio join; no estimate or memory figure is returned (E4), no model
// is named by the caller, and the op makes no new voice: Home picks the household voice and sends its address (or none for the household
// default). A speaker flagged `minor`, or any speaker when the audience is `minor`, may only use a starter voice this Stack ships; an address that
// needs cloning is refused (Home also sends none for such a speaker: two layers). With no lines it is the silent animatic.
// Logs carry counts and timings only, never line text, names or file names (rule 6a).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { StackClipDialogue } from "@maipai/spec/stack/ts/stack-make.js";
import { JobFailure, type Job, type JobProgress } from "@/lib/jobs";
import { speakRole, speechForm } from "@/lib/supervisor";
import { voiceNeedsCloning } from "@/speech/voices";
import { log } from "@/lib/log";
import { concatEncodeArgs, captionsArgs, kenBurnsArgs, type Clip, type EditOp } from "./editOps";
import { jobDir, resolveReadable } from "./paths";
import { probeFile } from "./probe";
import type { Runner } from "./run";
import { decodeWave } from "@/speech/audio";
import { finalizeWav, wavDuration } from "./tts";

// The request and result mirror commons spec `stack-rough-cut-request` and `stack-rough-cut-result` (one fixture set both tests read).
// This Stack still pins an older spec tag, so the shapes live here until the pin passes the tag that carries them.
const text = z.string().min(1);
const id = z.string().min(1).max(60).regex(/^[A-Za-z0-9._-]+$/);
export const RoughCutInput = z.object({
  audience: z.enum(["adult", "minor"]),
  shots: z.array(z.object({ id, picture: text, seconds: z.number().positive().max(60), motion: text.optional(), caption: z.string().min(1).max(200).optional() }).strict()).min(1).max(24),
  lines: z.array(z.object({ shot_id: id, line: StackClipDialogue }).strict()).max(96).optional(),
  voices: z.array(z.object({ speaker: text, voice_address: text.optional(), minor: z.boolean().optional() }).strict()).max(24).optional(),
}).strict();
export type RoughCutInput = z.infer<typeof RoughCutInput>;
export interface RoughCutResult { file: string; total_s: number; shots: Array<{ id: string; start_s: number; end_s: number }>; lines: Array<{ shot_id: string; speaker: string; start_s: number; length_s: number; audio: string; wave?: number[] }>; }

/** Loudness samples of one line's audio for the player's small waveform: RMS in up to 40 equal parts, the loudest scaled to 1 (silence stays 0). */
export function waveOf(wav: Uint8Array, parts = 40): number[] | undefined {
  try {
    const { samples } = decodeWave(wav);
    if (samples.length === 0) return undefined;
    const count = Math.max(1, Math.min(parts, Math.floor(samples.length / 160)));
    const size = samples.length / count; const rms: number[] = [];
    for (let part = 0; part < count; part++) { let sum = 0; const from = Math.floor(part * size), to = Math.floor((part + 1) * size); for (let i = from; i < to; i++) sum += samples[i]! * samples[i]!; rms.push(Math.sqrt(sum / Math.max(1, to - from))); }
    const top = Math.max(...rms); if (!(top > 0)) return rms.map(() => 0);
    return rms.map((value) => Math.round((value / top) * 1000) / 1000);
  } catch { return undefined; }
}

/** Where a line starts inside its shot, so the voice does not begin on the cut. */
export const LINE_LEAD_S = 0.2;

export class RoughCutRefusal extends Error { constructor(readonly code: "bad_input" | "clone_refused", message: string) { super(message); } }

/** The shot's motion words (the plan's own: "zoom in", "zoom out", "pan left", "pan right"; anything else holds still). Moved here from Home's animaticShotOps. */
export function motionOp(motion: string | undefined, seconds: number): Extract<EditOp, { op: "kenburns" }> {
  const direction = (motion ?? "").trim().toLowerCase();
  const pan = direction === "pan left" ? "left" : direction === "pan right" ? "right" : "none";
  const zoomFrom = direction === "zoom out" ? 1.2 : 1;
  const zoomTo = direction === "zoom out" ? 1 : direction === "zoom in" ? 1.2 : 1;
  return { op: "kenburns", zoom_from: zoomFrom, zoom_to: zoomTo, pan, duration_s: seconds };
}

/** The checks that need no file: lines name real shots, a minor speaker has no cloned voice. Throws RoughCutRefusal with a plain sentence. */
export function checkRoughCutRequest(input: RoughCutInput): void {
  const shotIds = new Set(input.shots.map((shot) => shot.id));
  if (shotIds.size !== input.shots.length) throw new RoughCutRefusal("bad_input", "Two shots share a name. Give each shot its own name and try again.");
  for (const entry of input.lines ?? []) if (!shotIds.has(entry.shot_id)) throw new RoughCutRefusal("bad_input", "A line names a shot that is not in the film. Check the shot names and try again.");
  const perShot = new Map<string, number>();
  for (const entry of input.lines ?? []) perShot.set(entry.shot_id, (perShot.get(entry.shot_id) ?? 0) + 1);
  if ([...perShot.values()].some((count) => count > 1)) throw new RoughCutRefusal("bad_input", "A shot has more than one line. Put each line in its own shot.");
  for (const voice of input.voices ?? []) {
    const minor = input.audience === "minor" || voice.minor === true;
    if (minor && voice.voice_address !== undefined && voiceNeedsCloning(voice.voice_address)) throw new RoughCutRefusal("clone_refused", "A child's lines use a starter voice. A cloned voice is not allowed for them. Choose a starter voice or none.");
  }
}

export interface RoughCutDeps {
  run: Runner;
  ffmpeg: string;
  ffprobe: string;
  /** One line of speech as a WAV. Default: the Stack's own speech role with the speaker's voice address (or its default voice). */
  speak(text: string, voiceAddress: string | undefined, signal: AbortSignal): Promise<Uint8Array>;
  signal: AbortSignal;
  progress?: (percent: number, status: string) => void;
}

export const defaultSpeak: RoughCutDeps["speak"] = async (lineText, voiceAddress, signal) => {
  const reply = await speakRole("tts", speechForm(lineText, voiceAddress), signal);
  if (reply.status < 200 || reply.status >= 300 || !reply.body) throw new RoughCutRefusal("bad_input", "The speech engine did not answer. Try again in a moment.");
  const bytes = new Uint8Array(await new Response(reply.body).arrayBuffer());
  finalizeWav(bytes);
  return bytes;
};

async function ffTry(deps: RoughCutDeps, args: string[]): Promise<boolean> {
  const result = await deps.run(args, { signal: deps.signal });
  if (result.aborted || deps.signal.aborted) throw new Error("Cancelled.");
  return result.code === 0;
}
async function ff(deps: RoughCutDeps, args: string[]): Promise<void> {
  if (!(await ffTry(deps, args))) throw new RoughCutRefusal("bad_input", "The rough cut could not be built from these pictures. Check that each picture opens and try again.");
}
const font = (): string | undefined => ["/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/Supplemental/Verdana.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"].find((path) => existsSync(path));

/** Builds the rough cut in `outDir` (pictures already resolved to readable paths). */
export async function buildRoughCut(input: RoughCutInput, outDir: string, deps: RoughCutDeps): Promise<RoughCutResult> {
  checkRoughCutRequest(input);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const tick = (percent: number, status: string) => deps.progress?.(percent, status);
  const lineByShot = new Map((input.lines ?? []).map((entry) => [entry.shot_id, entry.line]));

  // Speech first: a line longer than its shot is refused before any picture work.
  tick(2, "speaking the lines");
  const spoken = new Map<string, { path: string; length_s: number; speaker: string; wave?: number[] }>();
  let spokenCount = 0;
  for (const shot of input.shots) {
    const line = lineByShot.get(shot.id); if (!line) continue;
    const voice = (input.voices ?? []).find((entry) => entry.speaker === line.speaker);
    const bytes = await deps.speak(line.text, voice?.voice_address, deps.signal);
    const length = wavDuration(bytes);
    if (LINE_LEAD_S + length > shot.seconds) throw new RoughCutRefusal("bad_input", `The line in a ${shot.seconds}-second shot takes ${Math.ceil((LINE_LEAD_S + length) * 10) / 10} seconds to say. Make the shot longer or the line shorter.`);
    const path = join(outDir, `line-${spokenCount + 1}.wav`);
    writeFileSync(path, bytes, { mode: 0o600 });
    const wave = waveOf(bytes);
    spoken.set(shot.id, { path, length_s: Math.round(length * 1000) / 1000, speaker: line.speaker, ...(wave ? { wave } : {}) });
    spokenCount++;
    tick(2 + Math.round((spokenCount / Math.max(1, lineByShot.size)) * 18), "speaking the lines");
  }

  // One piece per shot: its motion, then its line as words for the whole shot (the silent animatic's look).
  const pieces: Clip[] = [];
  const fontFile = font();
  for (let index = 0; index < input.shots.length; index++) {
    const shot = input.shots[index]!;
    tick(20 + Math.round((index / input.shots.length) * 45), "moving the pictures");
    const still: Clip = { path: shot.picture, probe: await probeFile(deps.run, deps.ffprobe, shot.picture, deps.signal) };
    const motionPath = join(outDir, `shot-${index + 1}-motion.mp4`);
    await ff(deps, kenBurnsArgs(deps.ffmpeg, still, motionPath, motionOp(shot.motion, shot.seconds), true));
    let piecePath = motionPath;
    const line = lineByShot.get(shot.id);
    // A voiced line is captioned with its own text; a shot with no voiced line shows its `caption` (the silent animatic's words).
    const words = line ? line.text : shot.caption;
    if (words && fontFile) {
      const captioned = join(outDir, `shot-${index + 1}.mp4`);
      const motionClip: Clip = { path: motionPath, probe: await probeFile(deps.run, deps.ffprobe, motionPath, deps.signal) };
      // The words on screen are secondary to the voice: a build of ffmpeg without the subtitle filter keeps the moving picture without them.
      if (await ffTry(deps, captionsArgs(deps.ffmpeg, motionClip, captioned, { op: "captions", lines: [{ from_s: 0, to_s: shot.seconds, text: words.slice(0, 200) }], position: "bottom" }, fontFile, join(outDir, `captions-${index + 1}.ass`)))) piecePath = captioned;
    }
    pieces.push({ path: piecePath, probe: await probeFile(deps.run, deps.ffprobe, piecePath, deps.signal) });
  }

  tick(70, "joining the shots");
  const joined = join(outDir, "joined.mp4");
  if (pieces.length === 1) await ff(deps, [deps.ffmpeg, "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-i", pieces[0]!.path, "-c", "copy", joined]);
  else await ff(deps, concatEncodeArgs(deps.ffmpeg, pieces, joined));

  // Where each shot and line sits on the file's clock.
  let at = 0;
  const shots = input.shots.map((shot) => { const entry = { id: shot.id, start_s: Math.round(at * 1000) / 1000, end_s: Math.round((at + shot.seconds) * 1000) / 1000 }; at += shot.seconds; return entry; });
  const total_s = Math.round(at * 1000) / 1000;
  const lines: RoughCutResult["lines"] = [];
  for (const shot of shots) {
    const voiced = spoken.get(shot.id); if (!voiced) continue;
    lines.push({ shot_id: shot.id, speaker: voiced.speaker, start_s: Math.round((shot.start_s + LINE_LEAD_S) * 1000) / 1000, length_s: voiced.length_s, audio: voiced.path, ...(voiced.wave ? { wave: voiced.wave } : {}) });
  }

  const file = join(outDir, "rough-cut.mp4");
  if (lines.length === 0) {
    await ff(deps, [deps.ffmpeg, "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-i", joined, "-c", "copy", "-movflags", "+faststart", file]);
  } else {
    tick(80, "laying the voices");
    const inputs: string[] = ["-i", joined]; const graph: string[] = [];
    lines.forEach((line, i) => { inputs.push("-i", line.audio); const ms = Math.round(line.start_s * 1000); graph.push(`[${i + 1}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${ms}|${ms}[v${i}]`); });
    graph.push(`${lines.map((_, i) => `[v${i}]`).join("")}amix=inputs=${lines.length}:normalize=0:dropout_transition=0,apad=whole_dur=${total_s}[out]`);
    await ff(deps, [deps.ffmpeg, "-hide_banner", "-nostdin", "-y", "-loglevel", "error", ...inputs, "-filter_complex", graph.join(";"), "-map", "0:v:0", "-map", "[out]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-t", String(total_s), "-movflags", "+faststart", file]);
  }
  tick(100, "ready");
  // Counts and timings only (rule 6a).
  log("media.rough_cut done: %d shots, %d lines, %s s", input.shots.length, lines.length, String(total_s));
  return { file, total_s, shots, lines };
}

// ---- the job ----
export function roughCutPrecheck(raw: Record<string, unknown>): { reason: string; code: string; status: 422 } | null {
  const parsed = RoughCutInput.safeParse(raw);
  if (!parsed.success) return { reason: "The rough cut request is not valid. Send an audience, at least one shot with a picture and a length, and lines that name their shots.", code: "bad_input", status: 422 };
  try {
    checkRoughCutRequest(parsed.data);
    for (const shot of parsed.data.shots) resolveReadable(shot.picture);
    for (const voice of parsed.data.voices ?? []) if (voice.voice_address?.startsWith("/")) resolveReadable(voice.voice_address, "The voice file");
  } catch (error) {
    if (error instanceof RoughCutRefusal) return { reason: error.message, code: error.code, status: 422 };
    const code = (error as { code?: string }).code ?? "bad_input"; return { reason: error instanceof Error ? error.message : "A file in the request cannot be read.", code, status: 422 };
  }
  return null;
}

export async function runRoughCut(job: Job, signal: AbortSignal, progress: JobProgress, deps: { run: Runner; toolbox: { path(tool: "ffmpeg" | "ffprobe", onStatus: (s: string) => void, signal?: AbortSignal): Promise<string> }; speak?: RoughCutDeps["speak"] }): Promise<RoughCutResult> {
  const input = RoughCutInput.parse(job.input ?? {});
  const ffmpeg = await deps.toolbox.path("ffmpeg", (status) => progress({ status }), signal);
  const ffprobe = await deps.toolbox.path("ffprobe", (status) => progress({ status }), signal);
  const resolved: RoughCutInput = { ...input, shots: input.shots.map((shot) => ({ ...shot, picture: resolveReadable(shot.picture) })), ...(input.voices ? { voices: input.voices.map((voice) => ({ ...voice, ...(voice.voice_address?.startsWith("/") ? { voice_address: resolveReadable(voice.voice_address, "The voice file") } : {}) })) } : {}) };
  try {
    return await buildRoughCut(resolved, jobDir(job.id), { run: deps.run, ffmpeg, ffprobe, speak: deps.speak ?? defaultSpeak, signal, progress: (percent, status) => progress({ percent, status }) });
  } catch (error) {
    if (error instanceof RoughCutRefusal) throw new JobFailure(error.message, { failure: { code: error.code, message: error.message } });
    throw error;
  }
}
