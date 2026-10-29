
export const COMPANION_CLIP_LIMITS = {
  // First guesses to be set by the key-colour bench.
  colour_distance: 48,
  area_ratio: 1.35,
  opaque_share_min: 0.03,
  opaque_share_max: 0.85,
  loop_gap: 12,
} as const;
export const COMPANION_CLIP_FPS = 24;
export const COMPANION_CLIP_SIZE = 480;
export const ONESHOT_SETTLE_FRAMES = 15;
export const COLOUR_MATCH_STRENGTH = 0.7;
/** Lower edge of the existing pure-key alpha ramp. */
export const KEY_ALPHA_START = 5;
/** Upper edge of the existing pure-key alpha ramp. */
export const KEY_ALPHA_END = 245;
/** Maximum green left over a foreground channel on pure-key edges. */
export const KEY_DESPILL_TOLERANCE = 8;
/** Minimum estimated keyness for hue keying; any key-like border uses it, pure or muted (2026-10-29: the pure formula left skin and shirts part transparent and tinted). */
export const HUE_KEYNESS_MIN = 30;
/** Foreground keyness at or below this point stays opaque in the hue regime. */
export const HUE_ALPHA_T0 = 12;
/** Upper clamp for the hue-regime foreground transition. */
export const HUE_ALPHA_T1_MAX = 44;

type FrameSize = { width: number; height: number };

/** Estimate each background channel from every other pixel in the outer two-pixel ring. */
export function estimateBackground(frame: Uint8Array, width: number, height: number): [number, number, number] {
  const channels: [number[], number[], number[]] = [[], [], []];
  for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
    if (x >= 2 && x < width - 2 && y >= 2 && y < height - 2) continue;
    const offset = (y * width + x) * 4;
    for (let c = 0; c < 3; c++) channels[c]!.push(frame[offset + c]!);
  }
  const median = (values: number[]) => {
    values.sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    return values.length % 2 ? values[middle]! : Math.round((values[middle - 1]! + values[middle]!) / 2);
  };
  return [median(channels[0]), median(channels[1]), median(channels[2])];
}

function pureKeyAlpha(channels: [number, number, number], key: [number, number, number]): number {
  const keyCoverage = key[1] === 255
    ? Math.min(channels[1], 255 - channels[0], 255 - channels[2]) / 255
    : Math.min(channels[0], channels[2], 255 - channels[1]) / 255;
  const rawAlpha = Math.max(0, Math.min(1, 1 - keyCoverage)) * 255;
  return Math.round(Math.max(0, Math.min(1, (rawAlpha - KEY_ALPHA_START) / (KEY_ALPHA_END - KEY_ALPHA_START))) * 255);
}

/** Third argument accepts dimensions for keying, or the legacy abort signal. */
export function keyOutRgba(pixels: Uint8Array, key: [number, number, number], sizeOrSignal?: FrameSize | AbortSignal, signal?: AbortSignal): void {
  const size = sizeOrSignal && "width" in sizeOrSignal ? sizeOrSignal : undefined;
  const abortSignal = size ? signal : sizeOrSignal as AbortSignal | undefined;
  // Calls without dimensions retain the original pure-key behaviour for compatibility.
  const background = size ? estimateBackground(pixels, size.width, size.height) : key;
  const bgKeyness = key[1] === 255 ? background[1] - Math.max(background[0], background[2]) : Math.min(background[0], background[2]) - background[1];
  const regime = size && bgKeyness >= HUE_KEYNESS_MIN ? "hue" : "pure";
  const t0 = HUE_ALPHA_T0, t1 = Math.max(t0 + 16, Math.min(HUE_ALPHA_T1_MAX, bgKeyness * 0.75));
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if ((offset & 0xffff) === 0 && abortSignal?.aborted) throw new Error("Cancelled.");
    const channels: [number, number, number] = [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!];
    let alpha: number;
    if (regime === "hue") {
      const keyness = key[1] === 255 ? channels[1] - Math.max(channels[0], channels[2]) : Math.min(channels[0], channels[2]) - channels[1];
      alpha = Math.round(Math.max(0, Math.min(1, 1 - (keyness - t0) / (t1 - t0))) * 255);
    } else alpha = pureKeyAlpha(channels, key);
    pixels[offset + 3] = Math.min(pixels[offset + 3]!, alpha);
    if (alpha > 0 && alpha < 255) {
      const coverage = alpha / 255;
      if (regime === "hue") {
        for (let channel = 0; channel < 3; channel++) {
          const foreground = (channels[channel]! - background[channel]! * (1 - coverage)) / coverage;
          pixels[offset + channel] = Math.max(0, Math.min(255, Math.round(foreground)));
        }
        if (key[1] === 255) pixels[offset + 1] = Math.min(pixels[offset + 1]!, Math.max(pixels[offset]!, pixels[offset + 2]!) + 6);
      } else {
        for (let channel = 0; channel < 3; channel++) {
          const foreground = (channels[channel]! - key[channel]! * (1 - coverage)) / coverage;
          pixels[offset + channel] = Math.max(0, Math.min(255, Math.round(foreground)));
        }
        if (key[1] === 255) pixels[offset + 1] = Math.min(pixels[offset + 1]!, Math.max(pixels[offset]!, pixels[offset + 2]!) + KEY_DESPILL_TOLERANCE);
      }
    }
  }
}

export function medianMatte(frames: Uint8Array[], width: number, height: number, signal?: AbortSignal): void {
  if (!frames.length) return;
  const pixels = width * height;
  const med = (a: number, b: number, c: number) => a > b ? (b > c ? b : Math.min(a, c)) : (a > c ? a : Math.min(b, c));
  for (let p = 0; p < pixels; p++) {
    if (p % width === 0 && signal?.aborted) throw new Error("Cancelled.");
    let previous = frames[0]![p * 4 + 3]!;
    if (frames.length === 1) continue;
    let current = frames[1]![p * 4 + 3]!;
    frames[0]![p * 4 + 3] = med(previous, previous, current);
    for (let frame = 1; frame < frames.length - 1; frame++) {
      const following = frames[frame + 1]![p * 4 + 3]!;
      frames[frame]![p * 4 + 3] = med(previous, current, following);
      previous = current; current = following;
    }
    frames[frames.length - 1]![p * 4 + 3] = med(previous, current, current);
  }
}

export function frameDifference(a: Uint8Array, b: Uint8Array, width: number, height: number, signal?: AbortSignal, cutoff = Number.POSITIVE_INFINITY): number {
  let total = 0, count = 0;
  for (let y = 0; y < height; y += 4) for (let x = 0; x < width; x += 4) {
    if (x === 0 && signal?.aborted) throw new Error("Cancelled.");
    const i = (y * width + x) * 4, aa = a[i + 3]! / 255, ba = b[i + 3]! / 255;
    for (let c = 0; c < 3; c++) { total += Math.abs(a[i + c]! * aa - b[i + c]! * ba); count++; }
    total += Math.abs(a[i + 3]! - b[i + 3]!); count++;
    const maxSamples = Math.ceil(width / 4) * Math.ceil(height / 4) * 4;
    if (total > cutoff * maxSamples) return total / count;
  }
  return count ? total / count : 0;
}

/** One sample per 4x4 source block, the comparison copy used for loop search. */
export function downscaleRgba4(frame: Uint8Array, width: number, height: number): { frame: Uint8Array; width: number; height: number } {
  const w = Math.ceil(width / 4), h = Math.ceil(height / 4), out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const from = (Math.min(height - 1, y * 4) * width + Math.min(width - 1, x * 4)) * 4, to = (y * w + x) * 4;
    out[to] = frame[from]!; out[to + 1] = frame[from + 1]!; out[to + 2] = frame[from + 2]!; out[to + 3] = frame[from + 3]!;
  }
  return { frame: out, width: w, height: h };
}

export function frameDifference4(a: Uint8Array, b: Uint8Array): number {
  let total = 0;
  for (let i = 0; i < a.length; i += 4) {
    const aa = a[i + 3]! / 255, ba = b[i + 3]! / 255;
    total += Math.abs(a[i]! * aa - b[i]! * ba) + Math.abs(a[i + 1]! * aa - b[i + 1]! * ba) + Math.abs(a[i + 2]! * aa - b[i + 2]! * ba) + Math.abs(a[i + 3]! - b[i + 3]!);
  }
  return a.length ? total / a.length : 0;
}

/** Frames over which a loop's seam is blended. */
export const LOOP_SEAM_FRAMES = 10;
/** Spare frames a loop window carries past its cycle for the crossfade seam: up to ten, at least two, never below the state's minimum length. */
export function loopSpareFrames(count: number, minFrames: number): number { const spare = Math.min(LOOP_SEAM_FRAMES, count - minFrames); return spare >= 2 ? spare : 0; }

/**
 * The window to keep. For a loop the search scores cycle lengths (`frames[s + n]` against `frames[s]`) and the window is that
 * cycle plus `spare` frames after it, which `crossfadeLoop` folds into the seam; with no spare frames the window is the cycle alone.
 */
export function selectCompanionWindow(frames: Uint8Array[], kind: "loop" | "oneshot", count: number, minSeconds: number, maxSeconds: number, signal?: AbortSignal): { start: number; length: number; spare: number } {
  const min = Math.ceil(minSeconds * COMPANION_CLIP_FPS), max = Math.floor(maxSeconds * COMPANION_CLIP_FPS);
  if (count < min) throw new Error("The clip is shorter than this state needs. Make it again.");
  if (kind === "oneshot") {
    const settle = Math.min(ONESHOT_SETTLE_FRAMES, Math.max(0, count - 24));
    return { start: settle, length: Math.min(count - settle, max), spare: 0 };
  }
  const spare = loopSpareFrames(count, min);
  let start = 0, length = Math.min(count, max), best = Number.POSITIVE_INFINITY;
  const maxStart = Math.min(12 * COMPANION_CLIP_FPS, count - min - spare);
  for (let s = 0; s <= maxStart; s += COMPANION_CLIP_FPS) for (let n = min; n <= Math.min(max - spare, count - s - 1 - spare); n++) {
    if (signal?.aborted) throw new Error("Cancelled.");
    const score = frameDifference4(frames[s + n]!, frames[s]!);
    if (score < best) { best = score; start = s; length = n + spare; }
  }
  return { start, length, spare };
}

export interface FitFrames { frames: Uint8Array[]; start: number; loop_gap: number; settle_skipped_frames: number; }
const blend = (target: Uint8Array, toward: Uint8Array, weight: number) => {
  for (let i = 0; i < target.length; i++) target[i] = Math.round(target[i]! * (1 - weight) + toward[i]! * weight);
};

/**
 * A seamless cycle from a kept loop window (owner ruling 2026-10-29: loops must join perfectly). The first N spare frames
 * (up to ten, never below the state's minimum length) are dropped and the last N frames are blended toward them in equal
 * steps, so the last cycle frame sits one blend step before the first and playback wraps without a jump.
 * With fewer than two spare frames the window comes back unchanged (crossfaded: false) and the caller keeps its own seam.
 */
export function crossfadeLoop(kept: Uint8Array[], minFrames: number): { frames: Uint8Array[]; crossfaded: boolean } {
  const n = Math.min(LOOP_SEAM_FRAMES, kept.length - minFrames);
  if (n < 2) return { frames: kept, crossfaded: false };
  const cycle = kept.slice(n);
  for (let i = 0; i < n; i++) {
    const frame = kept[kept.length - n + i]!.slice();
    blend(frame, kept[i]!, (i + 1) / (n + 1));
    cycle[cycle.length - n + i] = frame;
  }
  return { frames: cycle, crossfaded: true };
}

export function fitCompanionFrames(frames: Uint8Array[], width: number, height: number, kind: "loop" | "oneshot", minSeconds: number, maxSeconds: number, signal?: AbortSignal): FitFrames {
  const min = Math.ceil(minSeconds * COMPANION_CLIP_FPS), max = Math.floor(maxSeconds * COMPANION_CLIP_FPS);
  if (frames.length < min) throw new Error("The clip is shorter than this state needs. Make it again.");
  const settleSkipped = kind === "oneshot" ? Math.min(ONESHOT_SETTLE_FRAMES, Math.max(0, frames.length - 24)) : 0;
  let start = settleSkipped, length = Math.min(frames.length - settleSkipped, max);
  const spare = kind === "loop" ? loopSpareFrames(frames.length, min) : 0;
  if (kind === "loop") {
    let best = Number.POSITIVE_INFINITY;
    const maxStart = Math.min(12 * COMPANION_CLIP_FPS, frames.length - min - spare);
    for (let s = 0; s <= maxStart; s += COMPANION_CLIP_FPS) for (let n = min; n <= Math.min(max - spare, frames.length - s - 1 - spare); n++) {
      if (signal?.aborted) throw new Error("Cancelled.");
      const score = frameDifference(frames[s + n]!, frames[s]!, width, height, signal, best);
      if (score < best) { best = score; start = s; length = n + spare; }
    }
  }
  let kept = frames.slice(start, start + length);
  const cycle = spare ? crossfadeLoop(kept, kept.length - spare) : null;
  if (cycle?.crossfaded) kept = cycle.frames;
  else if (kind === "oneshot") {
    const fade = Math.min(6, kept.length);
    for (let i = 0; i < fade; i++) {
      const index = kept.length - fade + i;
      kept[index] = kept[index]!.slice();
      blend(kept[index]!, kept[0]!, (i + 1) / fade);
    }
  } else {
    // No spare frames for a crossfade cycle: the first frames fade in from the frames that would follow the last one, so the step
    // from the end back to the start is as small as the step between any two neighbouring frames. With nothing after the window, the last frames fade toward the first instead.
    const ahead = frames.length - (start + length), fade = Math.min(LOOP_SEAM_FRAMES, kept.length, ahead);
    if (fade > 0) {
      for (let i = 0; i < fade; i++) { kept[i] = kept[i]!.slice(); blend(kept[i]!, frames[start + length + i]!, 1 - (i + 1) / (fade + 1)); }
    } else {
      const tail = Math.min(LOOP_SEAM_FRAMES, Math.floor(kept.length / 2));
      for (let i = 0; i < tail; i++) { const index = kept.length - tail + i; kept[index] = kept[index]!.slice(); blend(kept[index]!, kept[i]!, (i + 1) / (tail + 1)); }
    }
  }
  return { frames: kept, start, loop_gap: frameDifference(kept[kept.length - 1]!, kept[0]!, width, height, signal), settle_skipped_frames: settleSkipped };
}

function opaqueColourStats(frames: Uint8Array[]) {
  const count = [0, 0, 0], sum = [0, 0, 0], squares = [0, 0, 0];
  for (const frame of frames) for (let i = 0; i < frame.length; i += 4) if (frame[i + 3]! > 200) for (let c = 0; c < 3; c++) {
    const value = frame[i + c]!; count[c]!++; sum[c]! += value; squares[c]! += value * value;
  }
  return { mean: sum.map((value, c) => count[c] ? value / count[c]! : 0), std: sum.map((value, c) => count[c] ? Math.sqrt(Math.max(0, squares[c]! / count[c]! - (value / count[c]!) ** 2)) : 0), count: count[0]! };
}

/** Match opaque RGB channel statistics while preserving straight, un-premultiplied colour. */
export function applyColourMatch(frames: Uint8Array[], referenceFrames: Uint8Array[], strength = COLOUR_MATCH_STRENGTH): boolean {
  const source = opaqueColourStats(frames), reference = opaqueColourStats(referenceFrames);
  if (!source.count || !reference.count) return false;
  const gains = source.mean.map((mean, c) => source.std[c]! > 0.5 ? reference.std[c]! / source.std[c]! : 1);
  const offsets = source.mean.map((mean, c) => reference.mean[c]! - mean * gains[c]!);
  for (const frame of frames) for (let i = 0; i < frame.length; i += 4) for (let c = 0; c < 3; c++) {
    const original = frame[i + c]!;
    const fitted = Math.max(0, Math.min(255, original * gains[c]! + offsets[c]!));
    frame[i + c] = Math.round(original * (1 - strength) + fitted * strength);
  }
  return true;
}

function referencePalette(frames: Uint8Array[]): Array<[number, number, number]> {
  const palette = new Map<number, [number, number, number]>();
  for (const frame of frames) for (let i = 0; i < frame.length && palette.size < 256; i += 4) if (frame[i + 3]! > 200) {
    const colour: [number, number, number] = [frame[i]!, frame[i + 1]!, frame[i + 2]!];
    palette.set((colour[0] << 16) | (colour[1] << 8) | colour[2], colour);
  }
  return [...palette.values()];
}

export function companionMetrics(frames: Uint8Array[], width: number, height: number, colours: string[], referenceFrames?: Uint8Array[]) {
  const areas: number[] = [], shares: number[] = [];
  for (const frame of frames) {
    let opaque = 0;
    for (let i = 3; i < frame.length; i += 4) if (frame[i]! > 128) opaque++;
    areas.push(opaque); shares.push(opaque / (width * height));
  }
  const sortedAreas = areas.filter((v) => v > 0).sort((a, b) => a - b);
  const area_ratio = sortedAreas.length ? sortedAreas[sortedAreas.length - 1]! / sortedAreas[0]! : Infinity;
  let colour_distance: number | undefined;
  const referenceColours = referenceFrames ? referencePalette(referenceFrames) : [];
  if ((referenceColours.length || colours.length) && frames.length) {
    const parsed = referenceColours.length ? referenceColours : colours.map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]);
    const middle = frames[Math.floor(frames.length / 2)]!; let sum = 0, count = 0;
    for (let i = 0; i < middle.length; i += 4) if (middle[i + 3]! > 200) {
      let nearest = Infinity;
      for (const color of parsed) nearest = Math.min(nearest, Math.hypot(middle[i]! - color[0], middle[i + 1]! - color[1], middle[i + 2]! - color[2]));
      sum += nearest; count++;
    }
    colour_distance = count ? sum / count : 0;
  }
  return { ...(colour_distance === undefined ? {} : { colour_distance }), area_ratio, opaque_share: { min: shares.length ? Math.min(...shares) : 0, max: shares.length ? Math.max(...shares) : 0 } };
}

export function companionReasons(metrics: { colour_distance?: number; area_ratio: number; opaque_share: { min: number; max: number }; loop_gap: number }, seconds: number, min: number, max: number): string[] {
  const reasons: string[] = [];
  if (metrics.colour_distance !== undefined && metrics.colour_distance > COMPANION_CLIP_LIMITS.colour_distance) reasons.push("The character colours are too far from the colours Home expected. Check the listed colours and make the clip again.");
  if (metrics.area_ratio > COMPANION_CLIP_LIMITS.area_ratio) reasons.push("The character changes size too much during the clip. Keep the character at a steady scale.");
  if (metrics.opaque_share.min < COMPANION_CLIP_LIMITS.opaque_share_min) reasons.push("The character is too small or missing in part of the clip. Keep it visible in every frame.");
  if (metrics.opaque_share.max > COMPANION_CLIP_LIMITS.opaque_share_max) reasons.push("Too much of the frame is opaque. Leave clear space around the character.");
  if (metrics.loop_gap > COMPANION_CLIP_LIMITS.loop_gap) reasons.push("The first and last poses do not join smoothly. Make a steadier loop.");
  if (seconds < min || seconds > max) reasons.push("The finished clip is outside the requested length. Adjust the clip length and try again.");
  return reasons;
}

/** Bounds the union matte box and applies six percent padding, clamped to the frame. */
export function companionCrop(frames: Uint8Array[], width: number, height: number): { x: number; y: number; size: number } {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (const f of frames) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (f[(y * width + x) * 4 + 3]! > 16) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  if (maxX < 0) return { x: 0, y: 0, size: Math.min(width, height) };
  const box = Math.max(maxX - minX + 1, maxY - minY + 1), size = Math.ceil(box * 1.06);
  const cx = (minX + maxX + 1) / 2, cy = (minY + maxY + 1) / 2;
  return { x: Math.round(cx - size / 2), y: Math.round(cy - size / 2), size };
}

