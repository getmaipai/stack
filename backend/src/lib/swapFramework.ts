// VF-SWAP-01: the model-free framework of the generic `swap` job. A swap replaces one person in the owner's own footage (a face, a head or the whole
// person, `kind`). Whatever draws the new person is a pack's business; this file holds what does not depend on it: the per-frame outline the swap may
// write inside (declared before the swap, judged against by the preservation check), how a clip is cut into windows with linear blends, which frames
// are scored for likeness, and the one verdict that combines the preservation check and the likeness line. It names no model and reads no file.

export const SWAP_KINDS = ["face", "head", "person"] as const;
export type SwapKind = (typeof SWAP_KINDS)[number];
export function isSwapKind(value: unknown): value is SwapKind { return typeof value === "string" && (SWAP_KINDS as readonly string[]).includes(value); }

export type Point = readonly [number, number];
/** What a segmentation part returns for one frame: the points of the target's outline (any order), or null when the target is not in the frame. */
export type Outline = readonly Point[] | null;
/** The seam a segmentation part fills. The framework only asks for outlines; it never learns which part made them. */
export interface OutlineProvider { outlines(frameCount: number): Promise<Outline[]> }

// ---- which kinds a pack serves ---------------------------------------------------------------------------------------------------------------
/** What the request asks for when it names no kind: a whole head, the replacement the first route was built and measured for. */
export const DEFAULT_SWAP_KIND: SwapKind = "head";
/** The kinds a pack's swap recipe serves, from an optional `kinds: head, person` line after the `---measured---` marker. No line means the default kind only. */
export function servedKinds(recipe: string): SwapKind[] {
  const after = recipe.split("---measured---")[1] ?? "";
  const line = /^kinds:\s*(.+)$/m.exec(after)?.[1];
  if (!line) return [DEFAULT_SWAP_KIND];
  const kinds = line.split(",").map((part) => part.trim());
  const bad = kinds.find((kind) => !isSwapKind(kind));
  if (bad !== undefined) throw new Error(`The swap recipe lists the kind "${bad}", which is not face, head or person. Fix recipes/swap.md.`);
  return kinds as SwapKind[];
}
const KIND_WORDS: Record<SwapKind, string> = { face: "only the face", head: "the whole head", person: "the whole person" };
/** The one plain line for a kind this computer's swap does not do yet. It names what to ask for instead. */
export function kindNotServedLine(kind: SwapKind, served: readonly SwapKind[]): string {
  const alternatives = served.map((k) => KIND_WORDS[k]).join(" or ");
  return `Swapping ${KIND_WORDS[kind]} is not available on this computer yet. Ask for a swap of ${alternatives} instead.`;
}

// ---- the declared region -------------------------------------------------------------------------------------------------------------------
export type RegionEntry = { polygon: [number, number][] } | null;
export interface RegionOptions {
  width: number; height: number;
  /** Frames a lost outline is held at the last one (a tracker blink). Past this the target counts as absent and the whole frame is checked. */
  holdFrames: number;
  /** The most points a polygon keeps; fewer points make a smaller region file and a faster check. */
  maxPoints: number;
}
export interface RegionTrack { entries: RegionEntry[]; heldFrames: number; absentFrames: number; firstFrame: number | null }

const cross = (o: Point, a: Point, b: Point): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Convex hull (monotone chain), counter-clockwise. A swap may write anywhere the hull covers, so a ragged outline never leaves a notch inside it. */
export function convexHull(points: readonly Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const unique = sorted.filter((p, i) => i === 0 || p[0] !== sorted[i - 1]![0] || p[1] !== sorted[i - 1]![1]);
  if (unique.length < 3) return unique;
  const build = (list: readonly Point[]): Point[] => {
    const out: Point[] = [];
    for (const p of list) { while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 0) out.pop(); out.push(p); }
    out.pop();
    return out;
  };
  return [...build(unique), ...build([...unique].reverse())];
}

export function polygonArea(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) { const a = points[i]!, b = points[(i + 1) % points.length]!; sum += a[0] * b[1] - b[0] * a[1]; }
  return Math.abs(sum) / 2;
}

/** Cuts a hull down to `maxPoints` by dropping, one at a time, the point whose removal loses the least area. The result always contains the original hull's
 *  area minus the dropped slivers, so the caller grows it by the check's own margin (the check, not this function, owns the margin). */
export function simplifyHull(hull: readonly Point[], maxPoints: number): Point[] {
  const points = [...hull];
  while (points.length > Math.max(3, maxPoints)) {
    let best = 0, bestArea = Infinity;
    for (let i = 0; i < points.length; i++) {
      const tri = Math.abs(cross(points[(i + points.length - 1) % points.length]!, points[i]!, points[(i + 1) % points.length]!)) / 2;
      if (tri < bestArea) { bestArea = tri; best = i; }
    }
    points.splice(best, 1);
  }
  return points;
}

const MIN_REGION_AREA = 16;   // a smaller outline is a speck, not a person

function entryFor(outline: Outline, options: RegionOptions): RegionEntry {
  if (!outline || outline.length < 3) return null;
  const clamped = outline.map((p): Point => [Math.min(options.width - 1, Math.max(0, p[0])), Math.min(options.height - 1, Math.max(0, p[1]))]);
  const hull = convexHull(clamped);
  if (hull.length < 3 || polygonArea(hull) < MIN_REGION_AREA) return null;
  return { polygon: simplifyHull(hull, options.maxPoints).map((p): [number, number] => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]) };
}

/** Per-frame declared region from per-frame outlines. A frame before the first outline, or after a lost outline has been held `holdFrames` frames, is null
 *  (the target is absent: the check judges the whole frame, so any edit there fails). */
export function buildRegionTrack(outlines: readonly Outline[], options: RegionOptions): RegionTrack {
  if (!(options.width > 0 && options.height > 0)) throw new Error("The clip's size is unknown, so no region can be declared for the swap. Try again with a clip that plays.");
  const entries: RegionEntry[] = [];
  let last: RegionEntry = null, lost = 0, held = 0, firstFrame: number | null = null;
  for (let k = 0; k < outlines.length; k++) {
    const entry = entryFor(outlines[k] ?? null, options);
    if (entry) { last = entry; lost = 0; entries.push(entry); if (firstFrame === null) firstFrame = k; continue; }
    lost += 1;
    if (last && lost <= options.holdFrames) { entries.push(last); held += 1; } else entries.push(null);
  }
  return { entries, heldFrames: held, absentFrames: entries.filter((e) => e === null).length, firstFrame };
}

/** The region file the composite worker reads (`--edit-region-file`): one entry per frame. */
export function regionFileBody(track: RegionTrack): string { return JSON.stringify(track.entries); }

// ---- windows and blends --------------------------------------------------------------------------------------------------------------------
export interface WindowRules {
  /** Longest window a pack's engine draws in one call, in frames, and the step a window length must be a multiple of beyond `baseFrames`. */
  maxFrames: number; baseFrames: number; stepFrames: number;
  /** Frames two neighbors share; blended linearly. */
  blendFrames: number;
}
export interface SwapWindow {
  index: number; start: number; frames: number;
  /** Frames at the start of this window that blend with the previous window's end (0 for the first). */
  blendIn: number;
  /** Clip frames this window covers, which can be shorter than `frames` when the clip ends first; the rest of the window is padded. */
  covers: number;
}

const validLength = (rules: WindowRules, needed: number): number => {
  const steps = Math.max(0, Math.ceil((needed - rules.baseFrames) / rules.stepFrames));
  return Math.min(rules.maxFrames, rules.baseFrames + steps * rules.stepFrames);
};

export function checkWindowRules(rules: WindowRules): void {
  const { maxFrames, baseFrames, stepFrames, blendFrames } = rules;
  if (![maxFrames, baseFrames, stepFrames, blendFrames].every(Number.isInteger) || baseFrames < 1 || stepFrames < 1 || blendFrames < 0) throw new Error("The swap pack's window numbers must be whole numbers. Fix its recipe.");
  if ((maxFrames - baseFrames) % stepFrames !== 0 || maxFrames < baseFrames) throw new Error("The swap pack's longest window is not a length its engine can draw. Fix its recipe.");
  if (blendFrames * 2 >= baseFrames) throw new Error("The swap pack's blend is as long as its shortest window. Fix its recipe.");
}

/** Cuts `total` frames into windows that overlap by `blendFrames`. Every window is a length the engine can draw. The last window is moved back so it
 *  ends exactly at the clip's end (a longer overlap with its neighbor) rather than drawing frames that do not exist; a clip shorter than the
 *  shortest window is one padded window. */
export function planWindows(total: number, rules: WindowRules): SwapWindow[] {
  checkWindowRules(rules);
  if (!Number.isInteger(total) || total < 1) throw new Error("The clip has no frames to swap. Try again with a clip that plays.");
  if (total <= rules.maxFrames) {
    const frames = validLength(rules, total);
    return [{ index: 0, start: 0, frames, blendIn: 0, covers: total }];
  }
  const windows: SwapWindow[] = [];
  let start = 0;
  while (true) {
    const remaining = total - start;
    if (remaining <= rules.maxFrames) {
      const frames = validLength(rules, remaining);
      const from = Math.max(0, total - frames);
      const prev = windows[windows.length - 1];
      windows.push({ index: windows.length, start: from, frames, blendIn: prev ? prev.start + prev.frames - from : 0, covers: total - from });
      break;
    }
    const prev = windows[windows.length - 1];
    windows.push({ index: windows.length, start, frames: rules.maxFrames, blendIn: prev ? prev.start + prev.frames - start : 0, covers: rules.maxFrames });
    start += rules.maxFrames - rules.blendFrames;
  }
  return windows;
}

/** The weight of the NEXT window for each of `n` shared frames: a straight ramp that never reaches 0 or 1, so both windows count in every shared frame. */
export function blendWeights(n: number): number[] { return Array.from({ length: n }, (_, i) => (i + 1) / (n + 1)); }

// ---- likeness frames and the verdict -------------------------------------------------------------------------------------------------------
/** Frames to score for likeness: evenly spaced over the frames where the target is present, never fewer than `count` when that many exist. */
export function likenessFrames(track: RegionTrack, count: number): number[] {
  const present = track.entries.map((entry, k) => (entry ? k : -1)).filter((k) => k >= 0);
  if (present.length <= count) return present;
  return Array.from({ length: count }, (_, i) => present[Math.floor(((i + 0.5) * present.length) / count)]!);
}

/** The likeness numbers in ONE place. FIRST VALUES FROM A SINGLE CASE: the swap bench (one 10 s two-person clip, one target, 12 to 18 scored frames,
 *  head swap mean 0.55, character swap mean 0.45, source actor near 0). They are not calibrated; a pack may override them in its swap recipe
 *  (`likeness_line`, `likeness_min_frames`, `likeness_min_share`) once more cases exist. */
export interface LikenessRules { line: number; minFrames: number; minShare: number }
export const DEFAULT_LIKENESS_RULES: LikenessRules = { line: 0.36, minFrames: 5, minShare: 0.75 };

/** What the likeness part reports: the match score of each scored frame against the person's own photos, and the same for the source actor as the negative. */
export interface LikenessResult { scores: readonly number[]; actorScores?: readonly number[] | undefined }
export type PreservationVerdict = "pass" | "fail" | "inconclusive";
export type SwapVerdict = { verdict: "pass" | "fail" | "inconclusive"; lines: string[]; likenessFrames: number; likenessPassing: number; likenessChecked: boolean };

const mean = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

/** The job's own verdict. Preservation must pass and likeness must clear the line; a missing piece of evidence is never a pass. A likeness that could not
 *  be checked for lack of scored frames (the face never in view, a back view) is `inconclusive` with `likenessChecked: false`: the swap was made, and it is
 *  never described as a bad one. */
export function swapVerdict(input: { kind: SwapKind; preservation: PreservationVerdict | null; likeness: LikenessResult | null; rules?: LikenessRules }): SwapVerdict {
  const rules = input.rules ?? DEFAULT_LIKENESS_RULES;
  const lines: string[] = [];
  let verdict: SwapVerdict["verdict"] = "pass";
  const worsen = (to: "fail" | "inconclusive"): void => { if (verdict !== "fail") verdict = to; };
  if (input.preservation === null) { lines.push("The swap was not checked against the original footage, so it is not delivered. Try again."); worsen("inconclusive"); }
  else if (input.preservation === "fail") { lines.push("The swap changed parts of the picture outside the person, which it must never do, so the clip was thrown away. Try again, and if it happens again send this clip in to be looked at."); worsen("fail"); }
  else if (input.preservation === "inconclusive") { lines.push("The swap could not be checked against the original footage, so the clip was thrown away. Try again with a clip that has no other edits."); worsen("inconclusive"); }
  const scores = input.likeness?.scores ?? [];
  const passing = scores.filter((s) => s >= rules.line).length;
  const who = input.kind === "face" ? "face" : input.kind === "head" ? "head" : "person";
  const likenessChecked = scores.length >= rules.minFrames;
  if (!likenessChecked) {
    lines.push(`The swap was made, but how well the new ${who} matches your pictures could not be checked, because the face was clearly in view in only ${scores.length} ${scores.length === 1 ? "frame" : "frames"}. Look at the result yourself, or try a clip where the person faces the camera for longer.`);
    worsen("inconclusive");
  } else if (passing / scores.length < rules.minShare) {
    lines.push(`The new ${who} matches your pictures in ${passing} of ${scores.length} checked frames, which is too few. Try again with clearer pictures that face the camera.`);
    worsen("fail");
  }
  const actor = input.likeness?.actorScores;
  if (likenessChecked && actor && actor.length && mean(actor) >= rules.line) { lines.push("The original person still shows in the result. Try again with clearer pictures that face the camera."); worsen("fail"); }
  return { verdict, lines, likenessFrames: scores.length, likenessPassing: passing, likenessChecked };
}
