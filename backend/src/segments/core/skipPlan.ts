import type { MediaSegmentsRecordT, Range, SegmentKindT } from "./types";

export const PLAN_MERGE_GAP_SEC = 1;

export interface SkipOptions {
  kinds: readonly SegmentKindT[];
  minConfidence?: number;
  includeHeld?: boolean;
}

/** Ranges a player jumps over, sorted, merged when the gap is under 1 s. Rejected never; confirmed ignores minConfidence. */
export function skipPlan(record: MediaSegmentsRecordT, opts: SkipOptions): Range[] {
  const min = opts.minConfidence ?? 0;
  const ranges: Range[] = [];
  for (const s of record.segments) {
    if (!opts.kinds.includes(s.kind)) continue;
    if (s.status === "rejected") continue;
    if (s.status === "held" && !opts.includeHeld) continue;
    if (s.status !== "confirmed" && s.confidence < min) continue;
    const startSec = Math.max(0, s.startSec);
    const endSec = Math.min(record.durationSec, s.endSec);
    if (endSec > startSec) ranges.push({ startSec, endSec });
  }
  ranges.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
  const out: Range[] = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r.startSec - last.endSec < PLAN_MERGE_GAP_SEC) last.endSec = Math.max(last.endSec, r.endSec);
    else out.push({ ...r });
  }
  return out;
}

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
