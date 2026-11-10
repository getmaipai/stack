
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


// ---- MAKER-A: light flattening, rest-boundary check ----------------------------------------------------------------------------------
// Ported from the demo's tools/light_fix.py (flatten_light): each generated clip drifts in exposure and colour mid-clip and differs from the
// next clip. The mean Lab of four regions away from the lower face and eyes (hair/forehead and clothes, left and right) is measured per
// frame against the rest frame (frame 0), smoothed over time, and subtracted as a smooth bilinear offset field; three closed-loop passes.
// Alpha and geometry are never touched. The measurement runs on a 4x box-reduced copy (the demo blurs by sigma 3 before measuring, so
// nothing the demo measures is lost); the correction is applied at full resolution.

/** Lab distance a clip's four-region lighting may stray from its rest frame after flattening (the demo's flattened clips measure well under it). */
export const LIGHT_STEP_MAX = 0.9;
/** Mean Lab difference of the loop's first and last frame against the rest picture. The demo's published clips are within 0.7 of idle1's rest frame; 1.0 leaves room for rounding in the encoder. */
export const REST_FRAME_DIFF_MAX = 1.0;
export const LIGHT_PASSES = 3;
export const LIGHT_TEMPORAL_SIGMA = 1.5;
/** Edge length, in tile pixels, of the square the light measurement is reduced by. */
export const LIGHT_REDUCE = 4;
export type LightBox = [number, number, number, number];
export type LightRegionName = "hair_left" | "hair_right" | "clothes_left" | "clothes_right";
export type LightRegions = Record<LightRegionName, LightBox>;
export const LIGHT_REGION_NAMES: LightRegionName[] = ["hair_left", "hair_right", "clothes_left", "clothes_right"];

/**
 * Where the four regions sit on the 480 px tile when a request names none, as fractions of the tile from the demo's per-character
 * settings (light_fix.py CFG: hair rows end at 135, 110 and 115 of 480 and clothes rows start at 440, 410 and 450; the means, 0.25 and 0.90,
 * are used so one default fits every character). Each box is further limited to the rest frame's solid, eroded silhouette.
 */
export function defaultLightRegions(size = COMPANION_CLIP_SIZE): LightRegions {
  const top = Math.round(size * 0.25), bottom = Math.round(size * 0.90), mid = size / 2;
  return { hair_left: [0, 0, mid, top], hair_right: [mid, 0, size, top], clothes_left: [0, bottom, mid, size], clothes_right: [mid, bottom, size, size] };
}

const SRGB_TO_LINEAR = (() => { const lut = new Float32Array(256); for (let i = 0; i < 256; i++) { const v = i / 255; lut[i] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; } return lut; })();
const WHITE = [0.950456, 1, 1.088754] as const;
const labF = (t: number) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
const labFInverse = (t: number) => t > 6 / 29 ? t * t * t : (t - 16 / 116) / 7.787;

/** sRGB bytes to CIE Lab (D65, the same maths as OpenCV's float RGB2LAB). */
export function rgbToLab(r: number, g: number, b: number, out: Float32Array | number[], at = 0): void {
  const lr = SRGB_TO_LINEAR[r]!, lg = SRGB_TO_LINEAR[g]!, lb = SRGB_TO_LINEAR[b]!;
  const x = (0.412453 * lr + 0.357580 * lg + 0.180423 * lb) / WHITE[0], y = 0.212671 * lr + 0.715160 * lg + 0.072169 * lb, z = (0.019334 * lr + 0.119193 * lg + 0.950227 * lb) / WHITE[2];
  const fy = labF(y);
  out[at] = y > 0.008856 ? 116 * fy - 16 : 903.3 * y; out[at + 1] = 500 * (labF(x) - fy); out[at + 2] = 200 * (fy - labF(z));
}
function labToRgb(l: number, a: number, b: number): [number, number, number] {
  const fy = (Math.max(0, Math.min(100, l)) + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const x = labFInverse(fx) * WHITE[0], y = labFInverse(fy), z = labFInverse(fz) * WHITE[2];
  const lr = 3.240479 * x - 1.537150 * y - 0.498535 * z, lg = -0.969256 * x + 1.875992 * y + 0.041556 * z, lb = 0.055648 * x - 0.204043 * y + 1.057311 * z;
  const gamma = (v: number) => { const c = Math.max(0, Math.min(1, v)); return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)); };
  return [gamma(lr), gamma(lg), gamma(lb)];
}

/** A frame reduced by LIGHT_REDUCE: mean Lab per block over its opaque pixels and the share of the block that is fully opaque. */
export interface LightSmall { w: number; h: number; lab: Float32Array; solid: Uint8Array }
export function reduceForLight(frame: Uint8Array, width: number, height: number, factor = LIGHT_REDUCE): LightSmall {
  const w = Math.floor(width / factor), h = Math.floor(height / factor), lab = new Float32Array(w * h * 3), solid = new Uint8Array(w * h), tmp = new Float32Array(3);
  for (let by = 0; by < h; by++) for (let bx = 0; bx < w; bx++) {
    let r = 0, g = 0, b = 0, n = 0, all = 1;
    for (let y = by * factor; y < by * factor + factor; y++) for (let x = bx * factor; x < bx * factor + factor; x++) {
      const i = (y * width + x) * 4;
      if (frame[i + 3]! >= 250) { r += frame[i]!; g += frame[i + 1]!; b += frame[i + 2]!; n++; } else all = 0;
    }
    const at = by * w + bx;
    if (n) { rgbToLab(Math.round(r / n), Math.round(g / n), Math.round(b / n), tmp); lab[at * 3] = tmp[0]!; lab[at * 3 + 1] = tmp[1]!; lab[at * 3 + 2] = tmp[2]!; }
    solid[at] = all;
  }
  return { w, h, lab, solid };
}

function erode(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const pass = (src: Uint8Array, horizontal: boolean) => {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let keep = 1;
      for (let k = -radius; k <= radius && keep; k++) { const xx = horizontal ? x + k : x, yy = horizontal ? y : y + k; if (xx < 0 || yy < 0 || xx >= w || yy >= h || !src[yy * w + xx]) keep = 0; }
      out[y * w + x] = keep;
    }
    return out;
  };
  return pass(pass(mask, true), false);
}
function blurLab(lab: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3)), kernel: number[] = []; let total = 0;
  for (let k = -radius; k <= radius; k++) { const v = Math.exp(-(k * k) / (2 * sigma * sigma)); kernel.push(v); total += v; }
  const pass = (src: Float32Array, horizontal: boolean) => {
    const out = new Float32Array(src.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) { const xx = Math.min(w - 1, Math.max(0, horizontal ? x + k : x)), yy = Math.min(h - 1, Math.max(0, horizontal ? y : y + k)); sum += src[(yy * w + xx) * 3 + c]! * kernel[k + radius]!; }
      out[(y * w + x) * 3 + c] = sum / total;
    }
    return out;
  };
  return pass(pass(lab, true), false);
}

interface LightGeometry { masks: Uint8Array[]; reference: Float32Array; w: number; h: number; top: number; bottom: number; centre: number; fade: number; factor: number }
/** The measurement state built from the rest frame: one mask per region, the blurred rest Lab, and the field's control rows and columns. */
function lightFieldGeometry(regions: LightRegions, size: number): { top: number; bottom: number; centre: number; fade: number } {
  const hair = [regions.hair_left, regions.hair_right], clothes = [regions.clothes_left, regions.clothes_right];
  const top = (hair[0]![3] + hair[1]![3]) / 2, bottom = (clothes[0]![1] + clothes[1]![1]) / 2;
  const centre = (regions.hair_left[2] + regions.hair_right[0] + regions.clothes_left[2] + regions.clothes_right[0]) / 4;
  return { top, bottom: Math.max(bottom, top + 1), centre, fade: size * 50 / 480 };
}
function lightGeometry(rest: LightSmall, regions: LightRegions, size: number): LightGeometry {
  const factor = size / rest.w, solid = erode(rest.solid, rest.w, rest.h, erosionRadius(size, 3));
  const masks = LIGHT_REGION_NAMES.map((name) => {
    const [x0, y0, x1, y1] = regions[name], mask = new Uint8Array(rest.w * rest.h);
    for (let y = 0; y < rest.h; y++) for (let x = 0; x < rest.w; x++) { const px = (x + 0.5) * factor, py = (y + 0.5) * factor; if (solid[y * rest.w + x] && px >= x0 && px < x1 && py >= y0 && py < y1) mask[y * rest.w + x] = 1; }
    return mask;
  });
  return { masks, reference: blurLab(rest.lab, rest.w, rest.h, 3 / factor), w: rest.w, h: rest.h, ...lightFieldGeometry(regions, size), factor };
}

/** The demo erodes the silhouette by 13 px (rest) and 7 px (frame) on the 480 px tile; on the reduced copy that is `base` blocks there and proportionally fewer on a smaller tile. */
function erosionRadius(size: number, base: number): number { return Math.max(1, Math.round(base * size / COMPANION_CLIP_SIZE)); }
const smoothstep = (x: number, a: number, b: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/** The offset field's value (Lab triple) at one tile pixel: bilinear between the four region offsets, constant outside the control rows. */
function fieldAt(offsets: number[][], x: number, y: number, g: { top: number; bottom: number; centre: number; fade: number }, out: number[]): void {
  const gx = smoothstep(x, g.centre - g.fade, g.centre + g.fade), gy = Math.max(0, Math.min(1, (y - g.top) / (g.bottom - g.top)));
  for (let c = 0; c < 3; c++) {
    const upper = offsets[0]![c]! * (1 - gx) + offsets[1]![c]! * gx, lower = offsets[2]![c]! * (1 - gx) + offsets[3]![c]! * gx;
    out[c] = upper * (1 - gy) + lower * gy;
  }
}

/** Per frame, per region: the trimmed (10 to 90 percent) mean Lab offset of the blurred frame from the rest frame. `lab` is the frame's reduced Lab, already blurred. */
function measureRegions(small: LightSmall, lab: Float32Array, g: LightGeometry): number[][] {
  const frameSolid = erode(small.solid, small.w, small.h, erosionRadius(g.w * g.factor, 2)), rows: number[][] = [];
  for (const mask of g.masks) {
    const d: number[][] = [[], [], []];
    for (let p = 0; p < mask.length; p++) if (mask[p] && frameSolid[p]) for (let c = 0; c < 3; c++) d[c]!.push(lab[p * 3 + c]! - g.reference[p * 3 + c]!);
    if (d[0]!.length < 8) { rows.push([0, 0, 0]); continue; }
    const bounds = d.map((values) => { const sorted = [...values].sort((a, b) => a - b); return [sorted[Math.floor((sorted.length - 1) * 0.1)]!, sorted[Math.ceil((sorted.length - 1) * 0.9)]!]; });
    const sums = [0, 0, 0]; let n = 0;
    for (let k = 0; k < d[0]!.length; k++) if ([0, 1, 2].every((c) => d[c]![k]! >= bounds[c]![0]! && d[c]![k]! <= bounds[c]![1]!)) { for (let c = 0; c < 3; c++) sums[c]! += d[c]![k]!; n++; }
    rows.push(n ? sums.map((v) => v / n) : [0, 1, 2].map((c) => d[c]!.reduce((a, b) => a + b, 0) / d[c]!.length));
  }
  return rows;
}

/** Temporal Gaussian smoothing over frames (OpenCV-free port of scipy's gaussian_filter1d, mode nearest, truncate 4); the ends are pinned to zero with a short ramp. */
export function smoothLightOffsets(series: number[][][], sigma = LIGHT_TEMPORAL_SIGMA): number[][][] {
  const n = series.length, radius = Math.ceil(4 * sigma), kernel: number[] = []; let total = 0;
  for (let k = -radius; k <= radius; k++) { const v = Math.exp(-(k * k) / (2 * sigma * sigma)); kernel.push(v); total += v; }
  const out = series.map((rows, f) => rows.map((triple, r) => triple.map((_, c) => {
    let sum = 0; for (let k = -radius; k <= radius; k++) sum += series[Math.min(n - 1, Math.max(0, f + k))]![r]![c]! * kernel[k + radius]!;
    return sum / total;
  })));
  if (!n) return out;
  const zero = () => [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  out[0] = zero(); out[n - 1] = zero();
  const ramp = Math.min(3, Math.floor(n / 2));
  for (let i = 1; i <= ramp; i++) { const t = i / (ramp + 1); out[i] = out[i]!.map((row) => row.map((v) => v * t)); out[n - 1 - i] = out[n - 1 - i]!.map((row) => row.map((v) => v * t)); }
  return out;
}

function blurredLab(small: LightSmall, factor: number): Float32Array { return blurLab(small.lab, small.w, small.h, 3 / factor); }

/** The largest absolute Lab offset, over frames, regions and channels, of the frames' four-region lighting from the first frame's. */
export function lightStep(frames: LightSmall[], regions: LightRegions = defaultLightRegions(), size = COMPANION_CLIP_SIZE): number {
  if (!frames.length) return 0;
  const g = lightGeometry(frames[0]!, regions, size); let worst = 0;
  for (const small of frames) for (const row of measureRegions(small, blurredLab(small, g.factor), g)) for (const v of row) worst = Math.max(worst, Math.abs(v));
  return worst;
}

/** The per-frame offsets (frames x 4 regions x Lab) that bring every frame's lighting back to the first frame's: three closed-loop passes of measure, smooth, accumulate. */
export function solveLightOffsets(frames: LightSmall[], regions: LightRegions = defaultLightRegions(), size = COMPANION_CLIP_SIZE, signal?: AbortSignal): number[][][] {
  const g = lightGeometry(frames[0]!, regions, size), n = frames.length;
  let total: number[][][] = frames.map(() => [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
  const scratch = [0, 0, 0];
  for (let pass = 0; pass < LIGHT_PASSES; pass++) {
    const measured: number[][][] = [];
    for (let f = 0; f < n; f++) {
      if (signal?.aborted) throw new Error("Cancelled.");
      const small = frames[f]!, lab = new Float32Array(small.lab.length);
      for (let y = 0; y < small.h; y++) for (let x = 0; x < small.w; x++) {
        fieldAt(total[f]!, (x + 0.5) * g.factor, (y + 0.5) * g.factor, g, scratch);
        const p = (y * small.w + x) * 3; lab[p] = small.lab[p]! - scratch[0]!; lab[p + 1] = small.lab[p + 1]! - scratch[1]!; lab[p + 2] = small.lab[p + 2]! - scratch[2]!;
      }
      measured.push(measureRegions(small, blurLab(lab, small.w, small.h, 3 / g.factor), g));
    }
    const step = smoothLightOffsets(measured);
    total = total.map((rows, f) => rows.map((triple, r) => triple.map((v, c) => v + step[f]![r]![c]!)));
  }
  return total;
}

/** Subtracts the smooth offset field from one full-resolution frame in place (Lab, lightness clamped to 0..100). Alpha is never read as a mask and never written; fully transparent pixels are left alone. */
export function applyLightOffsets(frame: Uint8Array, width: number, height: number, offsets: number[][], regions: LightRegions = defaultLightRegions(), size = COMPANION_CLIP_SIZE): void {
  const g = lightFieldGeometry(regions, size), lab = [0, 0, 0], field = [0, 0, 0], tmp = new Float32Array(3);
  if (offsets.every((row) => row.every((v) => v === 0))) return;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (!frame[i + 3]) continue;
    fieldAt(offsets, x + 0.5, y + 0.5, g, field);
    rgbToLab(frame[i]!, frame[i + 1]!, frame[i + 2]!, tmp);
    lab[0] = tmp[0]! - field[0]!; lab[1] = tmp[1]! - field[1]!; lab[2] = tmp[2]! - field[2]!;
    const [r, gr, b] = labToRgb(lab[0]!, lab[1]!, lab[2]!);
    frame[i] = r; frame[i + 1] = gr; frame[i + 2] = b;
  }
}

/** Mean Lab difference of a frame from the rest picture over the pixels opaque in both: the length of the mean Lab offset vector. Both are tile-sized RGBA. */
export function restFrameDifference(frame: Uint8Array, rest: Uint8Array): number {
  const a = new Float32Array(3), b = new Float32Array(3), sum = [0, 0, 0]; let n = 0;
  for (let i = 0; i < frame.length; i += 4) if (frame[i + 3]! >= 250 && rest[i + 3]! >= 250) {
    rgbToLab(frame[i]!, frame[i + 1]!, frame[i + 2]!, a); rgbToLab(rest[i]!, rest[i + 1]!, rest[i + 2]!, b);
    for (let c = 0; c < 3; c++) sum[c]! += a[c]! - b[c]!;
    n++;
  }
  return n ? Math.hypot(sum[0]! / n, sum[1]! / n, sum[2]! / n) : 0;
}

export function lightReasons(metrics: { light_step_after?: number; rest_frame_diff?: { first: number; last: number } }): string[] {
  const reasons: string[] = [];
  if (metrics.light_step_after !== undefined && metrics.light_step_after > LIGHT_STEP_MAX) reasons.push("The lighting still drifts during the clip after the light fix. Make the clip again with steadier, even lighting.");
  const rest = metrics.rest_frame_diff;
  if (rest && (rest.first > REST_FRAME_DIFF_MAX || rest.last > REST_FRAME_DIFF_MAX)) reasons.push("The first or last frame does not match the rest picture. Make the clip again so it starts and ends in the rest pose with the same lighting and colour.");
  return reasons;
}
