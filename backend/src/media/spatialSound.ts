// SPATIAL-03: the `spatial_sound` edit op end to end. Finds the speaker's position over time (SPATIAL-02), renders the stereo result and, when
// asked, a 5.1 E-AC-3 sibling, both with the picture copied. A clip nobody can be placed in (no person, no speech, several people, a speaker
// in the middle) comes back as unchanged stereo with a plain line, not as a failure.
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LookError } from "@/look/look";
import { parseMeanVolume, SPATIAL_INLINE_GRAPH_LIMIT, spatialArgs, spatialSideLevelArgs, spatialUnchangedArgs } from "./editOps";
import type { Runner } from "./run";
import { analyzeClipAudio, computeEffectsTrack, effectsGate, mergeKnots, nativeTracksPerson, type EffectsTrack } from "./spatialEffects";
import { positionKnots, SPATIAL_LINES, spatialGraphKnots } from "./spatialRender";
import { computeSpatialTrack, resolveSpatialTrackDeps, setSpatialTrackDepsForTests, SpatialError, type SpatialReason, type SpatialSegment, type SpatialTrackDeps } from "./spatialTrack";

/** Under this level of the side signal the back speakers have nothing to play (the note: rear RMS under -50 dBFS). */
export const SPATIAL_REAR_QUIET_DB = -50;

export function setSpatialDepsForTests(deps: Partial<SpatialTrackDeps>): void { setSpatialTrackDepsForTests(deps); }
export function resetSpatialDepsForTests(): void { setSpatialTrackDepsForTests(null); }

export interface SpatialOutcome {
  /** True when at least one line of speech was moved off the middle. */
  applied: boolean;
  /** Why nothing moved: no_person, no_speech, several_people, centered or already_spatial (the clip's own sound already moves with the picture). null when applied. */
  reason: SpatialReason | null;
  /** The main plain line for the person. */
  note: string;
  /** Every plain line that applies, in the order to show them. */
  notes: string[];
  segments: number;
  /** What moved, in order: "speech" (the speaker's lines), and for the other sound "walker", "vehicle", "impact" or "side" (SPATIAL-07). Empty when nothing moved. */
  sources: string[];
  surround: boolean;
  /** The rear is quiet (little width in the clip's own sound), so the back speakers of the 5.1 file stay near silent. */
  rear_quiet: boolean;
  side_level_db: number;
  frames: number;
  people_frames: number;
  speech_spans: number;
}

export interface SpatialSoundOptions {
  run: Runner; ffmpeg: string; input: string; output: string;
  /** Where the 5.1 file is written, or null for stereo only. */
  surroundOutput: string | null;
  /** SPATIAL-07: a user-given side for the other sound; an override of the picture, never the default. */
  side?: "left" | "right";
  work: string; durationS: number; signal: AbortSignal;
  progress: (percent: number, status: string) => void;
}

/** The plain failure for an error out of the track or the render, or null when it is not one of ours (a cancel, a bug). */
export function spatialFailure(error: unknown): { code: string; message: string; detail?: string } | null {
  if (error instanceof SpatialError) return { code: error.code, message: error.message, ...(error.detail ? { detail: error.detail } : {}) };
  if (error instanceof LookError) {
    if (error.code === "model_missing") return { code: "model_missing", message: SPATIAL_LINES.look_missing };
    if (error.code === "no_memory" || error.code === "setup_failed" || error.code === "unsupported") return { code: error.code === "no_memory" ? "no_memory" : "model_missing", message: error.message };
    return { code: "spatial_failed", message: "Looking for who is on screen stopped unexpectedly. Try again, or try a shorter clip." };
  }
  return null;
}

async function render(options: SpatialSoundOptions, args: string[]): Promise<void> {
  const result = await options.run(args, { signal: options.signal });
  if (result.aborted || options.signal.aborted) throw new Error("Cancelled.");
  if (result.code !== 0) throw new SpatialError("spatial_failed", "The sound could not be re-mixed. Open Details for what the tool said.", result.stderr.trim().split("\n").slice(-6).join("\n").slice(-1200));
}

export async function spatialSoundClip(options: SpatialSoundOptions): Promise<SpatialOutcome> {
  const { run, ffmpeg, input, signal } = options;
  // The audio numbers first: they gate the effects pan and the speech skip. A clip whose sound cannot be read is treated as before SPATIAL-07.
  options.progress(2, "reading the sound");
  const stats = await analyzeClipAudio({ ffmpeg, source: input, work: options.work, run, signal });
  const gate = stats ? effectsGate(stats) : null;
  const track = await computeSpatialTrack({ ffmpeg, source: input, work: options.work, run, signal, progress: (percent, status) => options.progress(Math.round(5 + percent * 0.7), status) });
  const detail = track.detail;

  // The speech lines: as landed, except a clip whose own balance already ranges by 0.5 and follows the speaker is left alone.
  let speech: SpatialSegment[] = track.reason === null ? track.segments : [];
  let reason: SpatialReason | null = track.reason;
  if (speech.length > 0 && stats && detail && nativeTracksPerson(stats, detail.smoothed)) { speech = []; reason = "already_spatial"; }

  // The other sound: only on dual-mono audio, outside the speech lines.
  let effects: EffectsTrack | null = null;
  if (stats && gate === "dual_mono") {
    options.progress(78, "finding what makes the sound");
    try {
      effects = await computeEffectsTrack({ ffmpeg, source: input, work: options.work, run, signal, durationS: options.durationS, stats, people: detail?.people ?? [], lookAll: resolveSpatialTrackDeps().lookAll, ...(options.side ? { side: options.side } : {}) });
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.message === "Cancelled.")) throw error;
      effects = null; // an effects pan that could not be worked out leaves the sound as it is; the speech lines above do not depend on it
    }
  }
  const applied = speech.length > 0 || effects !== null;
  if (!applied && gate === "already_spatial") reason = "already_spatial";
  if (applied) reason = null;

  options.progress(82, "measuring the width of the sound");
  const level = await run(spatialSideLevelArgs(ffmpeg, input), { signal });
  if (level.aborted || signal.aborted) throw new Error("Cancelled.");
  const sideLevel = level.code === 0 ? parseMeanVolume(level.stderr) : -91;

  const speechKnots = positionKnots(speech, options.durationS);
  const knots = effects ? mergeKnots(speechKnots, effects.knots, detail?.spans_s ?? [], 0.15) : speechKnots;
  const graphFor = (surround: boolean): { args: (out: string) => string[]; cleanup: () => void } => {
    const graph = spatialGraphKnots(knots, surround);
    const scriptPath = graph.length > SPATIAL_INLINE_GRAPH_LIMIT ? join(options.work, `spatial-graph-${surround ? "51" : "stereo"}.txt`) : null;
    if (scriptPath) writeFileSync(scriptPath, graph);
    return { args: (out) => spatialArgs(ffmpeg, input, out, { graph, surround, scriptPath }), cleanup: () => { if (scriptPath) rmSync(scriptPath, { force: true }); } };
  };

  options.progress(85, "mixing the sound");
  if (applied) {
    const stereo = graphFor(false);
    try { await render(options, stereo.args(options.output)); } finally { stereo.cleanup(); }
  } else await render(options, spatialUnchangedArgs(ffmpeg, input, options.output));

  if (options.surroundOutput) {
    options.progress(92, "making the 5.1 file");
    const surround = graphFor(true);
    try { await render(options, surround.args(options.surroundOutput)); } finally { surround.cleanup(); }
  }

  const rearQuiet = sideLevel < SPATIAL_REAR_QUIET_DB;
  const lines = applied ? [...(speech.length > 0 ? [SPATIAL_LINES.applied] : []), ...(effects ? [SPATIAL_LINES.applied_effects] : [])] : [SPATIAL_LINES[reason!]];
  const main = lines[0]!;
  const notes = [...lines, ...(options.surroundOutput ? [SPATIAL_LINES.surround, ...(rearQuiet ? [SPATIAL_LINES.rear_quiet] : [])] : [])];
  return { applied, reason, note: main, notes, segments: speech.length + (effects?.events ?? 0), sources: [...(speech.length > 0 ? ["speech"] : []), ...(effects ? [effects.kind] : [])], surround: options.surroundOutput !== null, rear_quiet: options.surroundOutput !== null && rearQuiet, side_level_db: Math.round(sideLevel * 10) / 10, frames: track.frames, people_frames: track.people_frames, speech_spans: track.speech_spans };
}

