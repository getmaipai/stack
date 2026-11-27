// Turn the matched-level runs of an alignment into whole inserted breaks.
// A stitched copy is the clean copy plus inserted audio, so the stitched time minus the clean
// time (the delta) only grows, and each jump in delta is one inserted break whose length is the
// jump. Short runs are noise; only solid runs (default 30 s) anchor a break. Never overlaps.

import type { Inserted, Level } from "./align";

export interface MergeOptions { minRunSec?: number; lengthToleranceSec?: number; minInsertSec?: number }

interface Group { deltaSec: number; fromSec: number; toSec: number }

export function mergeInsertions(levels: Level[], refDurSec: number, stDurSec: number, opts: MergeOptions = {}): Inserted[] {
  const minRun = opts.minRunSec ?? 30, tol = opts.lengthToleranceSec ?? 8, minIns = opts.minInsertSec ?? 4;
  const solid = levels.filter((l) => l.toSec - l.fromSec >= minRun).sort((a, b) => a.fromSec - b.fromSec);
  if (solid.length === 0) return [];
  // Consecutive solid runs of the same delta (within 2 s) are one group.
  const groups: Group[] = [];
  for (const l of solid) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g.deltaSec - l.deltaSec) <= 2) { g.toSec = Math.max(g.toSec, l.toSec); continue; }
    groups.push({ deltaSec: l.deltaSec, fromSec: l.fromSec, toSec: l.toSec });
  }
  const out: Inserted[] = [];
  const first = groups[0]!;
  if (first.deltaSec >= minIns) {
    const end = Math.min(first.deltaSec, first.fromSec);
    out.push({ startSec: 0, endSec: Math.max(end, Math.min(first.deltaSec, stDurSec)), confidence: 0.9 });
  }
  for (let i = 0; i + 1 < groups.length; i++) {
    const a = groups[i]!, b = groups[i + 1]!;
    const jump = b.deltaSec - a.deltaSec;
    if (jump < minIns) continue; // delta never shrinks in a pure insertion; ignore a backward or tiny step
    const start = a.toSec, end = b.fromSec;
    const fit = Math.abs((end - start) - jump);
    out.push({ startSec: start, endSec: end, confidence: fit <= tol ? 0.9 : Math.max(0.3, 0.9 - fit / 60) });
  }
  const last = groups[groups.length - 1]!;
  const tail = stDurSec - (refDurSec + last.deltaSec);
  if (tail >= minIns) out.push({ startSec: stDurSec - tail, endSec: stDurSec, confidence: 0.7 });
  return out.sort((x, y) => x.startSec - y.startSec);
}
