// LOOK-01: what a camera has been seeing, per source, in memory only.
//
// Boxes from each frame are matched to the live tracks of the same label by overlap (greedy, best first), and a
// track lives until it has gone unseen for LOOK_TRACK_TTL_S. A maintained tracker was weighed and not used: norfair
// needs filterpy, scipy and rich, and supervision needs matplotlib and a second OpenCV, none of which the shared
// image-tools environment has, and the scene is a static room where objects mostly stay put, so greedy overlap
// matching is enough (architect LOOK-01: the reason for a hand-written matcher is recorded here).
//
// Nothing here is stored or logged. The source is only a key in a Map; labels and boxes are never written anywhere.

export const LOOK_TRACK_TTL_S = 90;
const MIN_OVERLAP = 0.3;

export interface LookDetection { label: string; score: number; box: number[] }
export interface LookObject { label: string; count: number; score: number; box: number[]; uncertain: false; stale?: true }

interface Track { label: string; box: number[]; score: number; lastSeen: number; seenFrame: number }
interface Source { tracks: Track[]; frame: number; lastFrameAt: number }

/** Intersection over union of two [x, y, width, height] boxes. */
export function overlap(a: number[], b: number[]): number {
  const [ax = 0, ay = 0, aw = 0, ah = 0] = a;
  const [bx = 0, by = 0, bw = 0, bh = 0] = b;
  const width = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx));
  const height = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
  const inter = width * height;
  return inter / Math.max(aw * ah + bw * bh - inter, 1e-8);
}

export class LookTracker {
  private readonly sources = new Map<string, Source>();

  /** Takes one frame's detections for a source and returns the live objects: one entry per label, with how many tracks it has. */
  update(sourceId: string, detections: LookDetection[], nowMs: number): LookObject[] {
    const ttlMs = LOOK_TRACK_TTL_S * 1000;
    let source = this.sources.get(sourceId);
    if (!source) { source = { tracks: [], frame: 0, lastFrameAt: nowMs }; this.sources.set(sourceId, source); }
    source.frame += 1;
    source.lastFrameAt = nowMs;
    source.tracks = source.tracks.filter((track) => nowMs - track.lastSeen < ttlMs);

    const pairs: { track: Track; detection: LookDetection; overlap: number }[] = [];
    for (const track of source.tracks) {
      for (const detection of detections) {
        if (track.label !== detection.label) continue;
        const value = overlap(track.box, detection.box);
        if (value >= MIN_OVERLAP) pairs.push({ track, detection, overlap: value });
      }
    }
    pairs.sort((a, b) => b.overlap - a.overlap);
    const usedTracks = new Set<Track>();
    const usedDetections = new Set<LookDetection>();
    for (const pair of pairs) {
      if (usedTracks.has(pair.track) || usedDetections.has(pair.detection)) continue;
      usedTracks.add(pair.track);
      usedDetections.add(pair.detection);
      pair.track.box = pair.detection.box;
      pair.track.score = Math.max(pair.track.score, pair.detection.score);
      pair.track.lastSeen = nowMs;
      pair.track.seenFrame = source.frame;
    }
    for (const detection of detections) {
      if (usedDetections.has(detection)) continue;
      source.tracks.push({ label: detection.label, box: detection.box, score: detection.score, lastSeen: nowMs, seenFrame: source.frame });
    }
    this.forgetIdleSources(nowMs);

    const byLabel = new Map<string, Track[]>();
    for (const track of source.tracks) byLabel.set(track.label, [...(byLabel.get(track.label) ?? []), track]);
    return [...byLabel].map(([label, tracks]) => {
      const best = tracks.reduce((a, b) => (b.score > a.score ? b : a));
      const seenNow = tracks.some((track) => track.seenFrame === source.frame);
      return { label, count: tracks.length, score: best.score, box: best.box, uncertain: false as const, ...(seenNow ? {} : { stale: true as const }) };
    }).sort((a, b) => b.score - a.score);
  }

  /** A source nobody has sent a frame for in LOOK_TRACK_TTL_S is dropped with all its tracks. */
  private forgetIdleSources(nowMs: number): void {
    for (const [id, source] of this.sources) {
      if (nowMs - source.lastFrameAt >= LOOK_TRACK_TTL_S * 1000) this.sources.delete(id);
    }
  }

  sourceCount(): number { return this.sources.size; }
}
