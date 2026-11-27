import type { Range } from "@maipai/spec/media/ts/segments";
import { skipPlan } from "@maipai/spec/media/ts/segments";
export { skipPlan };

export type SkipOptions = Parameters<typeof skipPlan>[1];

/** Original time to time in the skipped copy. A time inside a skipped range lands on that cut point. */
export function mapTime(plan: readonly Range[], tOriginal: number): number {
  let removed = 0;
  for (const r of plan) {
    if (tOriginal >= r.endSec) removed += r.endSec - r.startSec;
    else if (tOriginal > r.startSec) return r.startSec - removed;
    else break;
  }
  return tOriginal - removed;
}

/** Time in the skipped copy back to original time. A cut point maps to the content after the cut. */
export function unmapTime(plan: readonly Range[], tSkipped: number): number {
  let removed = 0;
  for (const r of plan) {
    if (tSkipped >= r.startSec - removed) removed += r.endSec - r.startSec;
    else break;
  }
  return tSkipped + removed;
}

/** The complement of the plan within [0, duration]: what an ffmpeg cut keeps. */
export function renderKeepRanges(plan: readonly Range[], durationSec: number): Range[] {
  const keep: Range[] = [];
  let cursor = 0;
  for (const r of plan) {
    const start = Math.max(0, r.startSec);
    const end = Math.min(durationSec, r.endSec);
    if (end <= cursor) continue;
    if (start > cursor) keep.push({ startSec: cursor, endSec: start });
    cursor = Math.max(cursor, end);
  }
  if (cursor < durationSec) keep.push({ startSec: cursor, endSec: durationSec });
  return keep;
}
