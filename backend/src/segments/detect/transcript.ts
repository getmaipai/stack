// Transcript types, sliding windows and the numbered text a window is shown to the model as.

export interface TranscriptSegment {
  startSec: number;
  endSec: number;
  text: string;
}

export interface TranscriptWindow {
  index: number;
  startSec: number;
  endSec: number;
  /** Segments whose start falls inside the window. */
  segments: TranscriptSegment[];
}

export interface WindowOptions {
  windowSec?: number;
  overlapSec?: number;
}

export const DEFAULT_WINDOW_SEC = 600;
export const DEFAULT_OVERLAP_SEC = 180;

/** Sliding windows over segments: `windowSec` long, each starting `windowSec - overlapSec` after the last. */
export function windowSegments(segments: TranscriptSegment[], opts: WindowOptions = {}): TranscriptWindow[] {
  const windowSec = opts.windowSec ?? DEFAULT_WINDOW_SEC;
  const overlapSec = opts.overlapSec ?? DEFAULT_OVERLAP_SEC;
  if (windowSec <= 0 || overlapSec < 0 || overlapSec >= windowSec) {
    throw new Error("windowSegments: need windowSec > overlapSec >= 0 (set a longer window or a smaller overlap)");
  }
  if (segments.length === 0) return [];
  const step = windowSec - overlapSec;
  const first = segments[0]!.startSec;
  const last = segments[segments.length - 1]!.endSec;
  const out: TranscriptWindow[] = [];
  for (let t0 = first; ; t0 += step) {
    const t1 = t0 + windowSec;
    const segs = segments.filter((s) => s.startSec >= t0 && s.startSec < t1);
    if (segs.length > 0) {
      out.push({
        index: out.length,
        startSec: segs[0]!.startSec,
        endSec: segs[segs.length - 1]!.endSec,
        segments: segs,
      });
    }
    if (t1 >= last) break;
  }
  return out;
}

export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(r).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** One line per segment: `[12] 04:31 text`. Line numbers start at 1 and are local to the window. */
export function formatWindow(window: TranscriptWindow): string {
  return window.segments
    .map((s, i) => `[${i + 1}] ${formatClock(s.startSec)} ${s.text.replace(/\s+/g, " ").trim()}`)
    .join("\n");
}
