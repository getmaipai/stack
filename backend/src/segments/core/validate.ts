import type { MediaSegmentT, SegmentSourceT, SegmentStatusT } from "./types";

export const AUTO_CONFIDENCE = 0.8;
export const HELD_CONFIDENCE = 0.5;
export const MIN_SEGMENT_SEC = 1;
export const MERGE_GAP_SEC = 2;
export const AD_MIN_SEC = 5;
export const AD_MAX_SEC = 600;
export const AD_MAX_FRACTION = 0.4;

/** Sort, clamp to duration, drop under 1 s, merge same-kind overlaps and gaps under 2 s. */
export function normalizeSegments(segments: readonly MediaSegmentT[], durationSec: number): MediaSegmentT[] {
  const clamped: MediaSegmentT[] = [];
  for (const s of segments) {
    const startSec = Math.max(0, s.startSec);
    const endSec = Math.min(durationSec, s.endSec);
    if (!(endSec - startSec >= MIN_SEGMENT_SEC)) continue;
    clamped.push({ ...s, startSec, endSec, sources: [...(s.sources ?? [s.source])] });
  }
  clamped.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);

  const out: MediaSegmentT[] = [];
  const lastOfKind = new Map<string, number>(); // kind -> index in out
  for (const s of clamped) {
    const idx = lastOfKind.get(s.kind);
    const prev = idx === undefined ? undefined : out[idx];
    if (prev && s.startSec - prev.endSec < MERGE_GAP_SEC) {
      const sources = [...new Set<SegmentSourceT>([...(prev.sources ?? []), ...(s.sources ?? [])])];
      const best = s.confidence > prev.confidence ? s : prev;
      const status: SegmentStatusT =
        prev.status === "confirmed" || s.status === "confirmed" ? "confirmed" : best.status;
      const label = prev.label ?? s.label;
      const merged: MediaSegmentT = {
        ...prev,
        endSec: Math.max(prev.endSec, s.endSec),
        confidence: best.confidence,
        source: best.source,
        sources,
        status,
      };
      if (label !== undefined) merged.label = label;
      out[idx as number] = merged;
    } else {
      lastOfKind.set(s.kind, out.length);
      out.push(s);
    }
  }
  return out.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
}

export interface Decision {
  status: SegmentStatusT;
  reason: string;
}

/** MinusPod-style status from confidence, duration and position. A person's decision is kept. */
export function decideStatus(seg: MediaSegmentT, durationSec: number): Decision {
  if (seg.status === "confirmed" || seg.status === "rejected") {
    return { status: seg.status, reason: "person decision kept" };
  }
  if (seg.confidence < HELD_CONFIDENCE) return { status: "rejected", reason: "confidence below 0.50" };
  if (seg.confidence < AUTO_CONFIDENCE) return { status: "held", reason: "confidence 0.50 to 0.79" };
  if (seg.kind === "ad") {
    const len = seg.endSec - seg.startSec;
    if (len > AD_MAX_SEC) return { status: "held", reason: "ad longer than 10 minutes" };
    if (len < AD_MIN_SEC) return { status: "held", reason: "ad shorter than 5 seconds" };
    if (durationSec > 0 && len / durationSec > AD_MAX_FRACTION) {
      return { status: "held", reason: "ad covers more than 40% of the file" };
    }
  }
  return { status: "auto", reason: "confidence 0.80 or higher" };
}

/** Normalize, then set every segment's status from decideStatus. */
export function applyDecisions(segments: readonly MediaSegmentT[], durationSec: number): MediaSegmentT[] {
  return normalizeSegments(segments, durationSec).map((s) => ({ ...s, status: decideStatus(s, durationSec).status }));
}
