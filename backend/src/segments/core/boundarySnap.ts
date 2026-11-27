import type { Range } from "./types";

export const DEFAULT_MAX_SHIFT_SEC = 2.5;

export interface SnapBounds {
  /** The edge cannot move below this (previous neighbour's end, or 0). */
  minSec?: number;
  /** The edge cannot move above this (next neighbour's start, or the duration). */
  maxSec?: number;
}

function nearest(edge: number, silences: readonly Range[], maxShift: number, lo: number, hi: number): number {
  // An edge already inside a silence stays put.
  for (const s of silences) if (edge >= s.startSec && edge <= s.endSec) return edge;
  let best = edge;
  let bestDist = Infinity;
  for (const s of silences) {
    for (const c of [s.startSec, s.endSec]) {
      if (c < lo || c > hi) continue;
      const d = Math.abs(c - edge);
      if (d <= maxShift && (d < bestDist || (d === bestDist && c < best))) {
        best = c;
        bestDist = d;
      }
    }
  }
  return best;
}

/** Move each edge to the nearest silence edge within maxShiftSec, staying inside bounds and never inverting the range. */
export function snapToSilence(
  range: Range,
  silences: readonly Range[],
  maxShiftSec: number = DEFAULT_MAX_SHIFT_SEC,
  bounds: SnapBounds = {},
): Range {
  const lo = bounds.minSec ?? 0;
  const hi = bounds.maxSec ?? Infinity;
  let startSec = nearest(range.startSec, silences, maxShiftSec, lo, Math.min(hi, range.endSec));
  let endSec = nearest(range.endSec, silences, maxShiftSec, Math.max(lo, startSec), hi);
  if (!(endSec > startSec)) {
    startSec = range.startSec;
    endSec = range.endSec;
  }
  return { startSec, endSec };
}

/** Snap a sorted list of ranges; each range's neighbours bound its movement. */
export function snapAll(
  ranges: readonly Range[],
  silences: readonly Range[],
  maxShiftSec: number = DEFAULT_MAX_SHIFT_SEC,
  durationSec: number = Infinity,
): Range[] {
  const sorted = [...ranges].sort((a, b) => a.startSec - b.startSec);
  const out: Range[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const prevEnd = i > 0 ? out[i - 1]!.endSec : 0;
    const nextStart = i < sorted.length - 1 ? sorted[i + 1]!.startSec : durationSec;
    out.push(snapToSilence(sorted[i]!, silences, maxShiftSec, { minSec: prevEnd, maxSec: nextStart }));
  }
  return out;
}

/** Parse ffmpeg `silencedetect` stderr into silence intervals. An unclosed silence ends at durationSec when given. */
export function parseSilenceDetect(stderr: string, durationSec?: number): Range[] {
  const out: Range[] = [];
  let open: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const st = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (st) {
      open = Math.max(0, Number(st[1]));
      continue;
    }
    const en = /silence_end:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (en && open !== null) {
      const end = Number(en[1]);
      if (end > open) out.push({ startSec: open, endSec: end });
      open = null;
    }
  }
  if (open !== null && durationSec !== undefined && durationSec > open) out.push({ startSec: open, endSec: durationSec });
  return out;
}
