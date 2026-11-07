// SPATIAL-03: the render graph of the `spatial_sound` op, pure strings so a test reads it without a binary. Mid and side:
// M = (L + R) / 2 carries the dialog, S = (L - R) / 2 carries the width. A constant-power pan on M follows the speaker; S stays where the clip
// had it. The gains are piecewise-linear in time, built from the segment list (a glide of 150 ms back to the middle between lines), and run in
// ffmpeg's `volume` filter in frame mode. Built from the exact graph measured in SPATIAL-01 (stereo: pan-left L minus R +14.2 dB, pan-right
// -6.2 dB; render balance within 0.02 of the formula).
import type { SpatialSegment } from "./spatialTrack";

export const SPATIAL_GLIDE_S = 0.15;
/** Share of the side signal that goes to the front left and right of the 5.1 file. */
const FRONT_SIDE_SHARE = 0.7;

/** The plain lines Home shows (STYLE.md: what happened, then what to do). Home reads `reason` and `note` from the job result, never the words. */
export const SPATIAL_LINES = {
  no_audio: "This clip has no sound, so there is nothing to place. Make or add sound first.",
  no_picture: "Spatial sound needs a picture to find who is talking, and this clip has none.",
  not_last: "Make the 5.1 file as the last step of the edit.",
  only_once: "Spatial sound can be used only once in an edit.",
  surround_container: "A 5.1 file needs an output ending in .mp4 or .mov. Name the output file that way.",
  no_person: "No person was found on screen, so the sound is unchanged stereo. Spatial sound works on videos of real people.",
  no_speech: "Nobody speaks in this clip, so the sound is unchanged stereo.",
  several_people: "Several people are on screen, so the voice stays in the middle and the sound is unchanged stereo.",
  centered: "The speaker stands in the middle of the picture, so the sound is unchanged stereo.",
  already_spatial: "This clip's sound already moves with the picture, so it is unchanged.",
  applied: "Sound now follows who is talking on screen. Wear headphones to hear it.",
  applied_effects: "Sound effects now come from the side of the picture where they happen. Wear headphones to hear it.",
  surround: "The 5.1 file plays on a surround system or an Apple TV. Other players play it as stereo.",
  rear_quiet: "This clip's sound had little width, so the back speakers stay quiet.",
  look_missing: "Spatial sound needs the Look part. An admin can install it in Settings, Models and storage, then try again.",
} as const;

/** Constant-power pan of the mid signal for a position in -1 (left) .. +1 (right); `c` is the 5.1 centre share, 1 - |position|. */
export function spatialGains(position: number): { l: number; r: number; c: number } {
  const p = Math.min(1, Math.max(-1, position));
  const theta = ((p + 1) * Math.PI) / 4;
  return { l: Math.SQRT2 * Math.cos(theta), r: Math.SQRT2 * Math.sin(theta), c: 1 - Math.abs(p) };
}

/** Segments in time order, clamped to the clip, no overlaps (a later line starts where the earlier one ended at the earliest). */
function tidy(segments: SpatialSegment[], durationS: number): SpatialSegment[] {
  const out: SpatialSegment[] = [];
  for (const segment of [...segments].sort((a, b) => a.start_s - b.start_s)) {
    const start = Math.max(out.at(-1)?.end_s ?? 0, Math.max(0, segment.start_s));
    const end = Math.min(durationS + SPATIAL_GLIDE_S, segment.end_s);
    if (end > start + 1e-3) out.push({ start_s: start, end_s: end, position: segment.position });
  }
  return out;
}

/** (time, position) points of the position curve: 0 outside a line, the line's position inside it, a 150 ms glide between. */
export function positionKnots(segments: SpatialSegment[], durationS: number, glide: number = SPATIAL_GLIDE_S): Array<[number, number]> {
  const knots: Array<[number, number]> = [[0, 0]];
  for (const { start_s: a, end_s: b, position: p } of tidy(segments, durationS)) {
    const last = () => knots[knots.length - 1]![0];
    if (a - glide > last() + 1e-3) knots.push([a - glide, 0]);
    knots.push([Math.max(a, last() + 1e-3), p]);
    knots.push([Math.max(b, last() + 1e-3), p]);
    knots.push([b + glide, 0]);
  }
  knots.push([Math.max(durationS + glide, knots[knots.length - 1]![0] + 1e-3), 0]);
  const out: Array<[number, number]> = [];
  for (const [t, v] of knots) out.push([Math.round((out.length && t <= out[out.length - 1]![0] ? out[out.length - 1]![0] + 1e-3 : t) * 1e4) / 1e4, v]);
  return out;
}

/**
 * An ffmpeg expression in `t`: f(position) at the knots, linear between them. Built as a balanced tree of if(lt(t,...)) rather than a chain:
 * ffmpeg's expression parser allows about 100 levels of nesting, and a chain of 30 lines of speech already needs more than that.
 */
function expression(knots: Array<[number, number]>, f: (position: number) => number): string {
  const points = knots.map(([t, v]) => [t, f(v)] as const);
  // piece i covers [points[i].t, points[i+1].t); the last piece is the constant after the final knot
  const pieces: string[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [t0, v0] = points[i]!; const [t1, v1] = points[i + 1]!;
    pieces.push(Math.abs(v1 - v0) < 1e-6 ? v0.toFixed(5) : `${v0.toFixed(5)}+(${(v1 - v0).toFixed(5)})*(t-${t0})/${(t1 - t0).toFixed(4)}`);
  }
  pieces.push(points[points.length - 1]![1].toFixed(5));
  const build = (lo: number, hi: number): string => {
    if (hi - lo === 1) return pieces[lo]!;
    const mid = (lo + hi) >> 1;
    return `if(lt(t,${points[mid]![0]}),${build(lo, mid)},${build(mid, hi)})`;
  };
  return build(0, pieces.length);
}
const esc = (expr: string): string => expr.replace(/,/g, "\\,");

/** The filter_complex of the stereo result (label [out], two channels) or the 5.1 result (label [out], FL FR FC LFE BL BR). */
export function spatialGraph(segments: SpatialSegment[], durationS: number, surround: boolean): string {
  return spatialGraphKnots(positionKnots(segments, durationS), surround);
}

/** The same graph from a position curve given as (time, position) knots, strictly increasing in time (SPATIAL-07: the effects pan is a curve, not lines of speech). */
export function spatialGraphKnots(knots: Array<[number, number]>, surround: boolean): string {
  const gl = esc(expression(knots, (p) => spatialGains(p).l));
  const gr = esc(expression(knots, (p) => spatialGains(p).r));
  const head = "[0:a:0]aformat=sample_fmts=fltp:channel_layouts=stereo,asplit=2[a1][a2];[a1]pan=mono|c0=0.5*c0+0.5*c1,";
  if (!surround) {
    return head
      + "asplit=2[m1][m2];[a2]pan=mono|c0=0.5*c0-0.5*c1,asplit=2[s1][s2];"
      + `[m1]volume='${gl}':eval=frame[ml];[m2]volume='${gr}':eval=frame[mr];[s2]volume=-1[sn];`
      + "[ml][s1]amix=inputs=2:normalize=0[L];[mr][sn]amix=inputs=2:normalize=0[R];[L][R]amerge=inputs=2,aformat=channel_layouts=stereo[out]";
  }
  const gc = esc(expression(knots, (p) => spatialGains(p).c));
  return head
    + "asplit=4[m1][m2][m3][m4];[a2]pan=mono|c0=0.5*c0-0.5*c1,asplit=3[s1][s2][s3];"
    + `[m1]volume='${gl}':eval=frame[ml];[m2]volume='${gr}':eval=frame[mr];[m3]volume='${gc}':eval=frame[fc];`
    + `[s1]volume=${FRONT_SIDE_SHARE}[sl];[s2]volume=-${FRONT_SIDE_SHARE}[sr];`
    + "[ml][sl]amix=inputs=2:normalize=0[FL];[mr][sr]amix=inputs=2:normalize=0[FR];"
    + "[m4]lowpass=f=120,volume=0.5[LFE];"
    + "[s3]asplit=2[sb1][sb2];[sb1]adelay=10,lowpass=f=7000[BL];[sb2]volume=-1,adelay=10,lowpass=f=7000[BR];"
    + "[FL][FR][fc][LFE][BL][BR]amerge=inputs=6,channelmap=map=0|1|2|3|4|5:channel_layout=5.1[out]";
}
