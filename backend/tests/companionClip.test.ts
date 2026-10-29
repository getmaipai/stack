import { expect, test } from "bun:test";
import { CompanionClipInput } from "@/media/commands";
import { COLOUR_MATCH_STRENGTH, COMPANION_CLIP_LIMITS, ONESHOT_SETTLE_FRAMES, applyColourMatch, companionMetrics, companionReasons, fitCompanionFrames, keyOutRgba, medianMatte } from "@/media/companionClip";

test("keying preserves a red character over either key and clears pure key pixels", () => {
  const green = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
  keyOutRgba(green, [0, 255, 0]);
  expect([...green.slice(0, 4)]).toEqual([255, 0, 0, 255]);
  expect(green[7]).toBe(0);
  const magenta = new Uint8Array([255, 0, 0, 255, 255, 0, 128, 255, 255, 0, 255, 255]);
  keyOutRgba(magenta, [255, 0, 255]);
  expect([...magenta.slice(0, 4)]).toEqual([255, 0, 0, 255]);
  expect(magenta[4]!).toBeGreaterThan(220);
  expect(magenta[5]!).toBeLessThanOrEqual(16);
  expect(magenta[6]!).toBeLessThanOrEqual(16);
  expect(magenta[11]).toBe(0);
});

test("the temporal matte is each pixel's three-frame median, with two samples at the ends", () => {
  const frames = [20, 240, 80, 200].map((alpha) => new Uint8Array([9, 8, 7, alpha]));
  medianMatte(frames, 1, 1);
  expect(frames.map((frame) => frame[3])).toEqual([20, 80, 200, 200]);
  expect(frames.map((frame) => [...frame.slice(0, 3)])).toEqual([[9, 8, 7], [9, 8, 7], [9, 8, 7], [9, 8, 7]]);
});

function movingDot(periodic: boolean): Uint8Array[] {
  return Array.from({ length: 96 }, (_, n) => {
    const frame = new Uint8Array(16 * 16 * 4);
    if (!periodic) {
      for (let i = 0; i < frame.length; i += 4) { frame[i] = n * 2; frame[i + 3] = 255; }
      return frame;
    }
    const x = periodic ? n % 24 : n % 16;
    const i = (8 * 16 + x) * 4;
    frame[i] = 255; frame[i + 3] = 255;
    return frame;
  });
}

test("loop fitting finds a period and reports a small gap, and the seam blend closes the gap even without a period", () => {
  const periodic = fitCompanionFrames(movingDot(true), 16, 16, "loop", 1, 3);
  expect(periodic.frames.length % 24).toBe(0);
  expect(periodic.loop_gap).toBeLessThan(12);
  const aperiodic = fitCompanionFrames(movingDot(false), 16, 16, "loop", 1, 2);
  expect(aperiodic.frames.length).toBeGreaterThan(0);
  expect(aperiodic.loop_gap).toBeLessThan(12);
});

test("a loop joins end to start as smoothly as two neighbouring frames, even on a steady drift", () => {
  const drift = Array.from({ length: 96 }, (_, n) => new Uint8Array([n * 2, 0, 0, 255]));
  const fitted = fitCompanionFrames(drift, 1, 1, "loop", 1, 2);
  const step = Math.abs(fitted.frames[1]![0]! - fitted.frames[0]![0]!), seam = Math.abs(fitted.frames[fitted.frames.length - 1]![0]! - fitted.frames[0]![0]!);
  expect(seam).toBeLessThanOrEqual(Math.max(step, 4) + 2);
});

test("one-shot crossfades its last six frames to the first pose", () => {
  const frames = Array.from({ length: 48 }, (_, n) => new Uint8Array([n, 0, 0, 255]));
  const fitted = fitCompanionFrames(frames, 1, 1, "oneshot", 1, 2);
  expect(fitted.frames.length).toBe(33);
  expect(fitted.settle_skipped_frames).toBe(15);
  expect(fitted.frames[32]![0]).toBe(fitted.frames[0]![0]);
  expect(fitted.loop_gap).toBe(0);
});

test("one-shot skips the oversized settling frames before blending to its settled first pose", () => {
  const frames = Array.from({ length: 48 }, (_, n) => {
    const frame = new Uint8Array(100 * 100 * 4);
    const radius = n < ONESHOT_SETTLE_FRAMES ? 26 : 20;
    for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
      const i = (y * 100 + x) * 4;
      if ((x - 50) ** 2 + (y - 50) ** 2 <= radius ** 2) frame.set([220, 180, 40, 255], i);
    }
    return frame;
  });
  const fitted = fitCompanionFrames(frames, 100, 100, "oneshot", 1, 2);
  const areas = fitted.frames.map((frame) => { let count = 0; for (let i = 3; i < frame.length; i += 4) if (frame[i]! > 128) count++; return count; });
  expect(fitted.settle_skipped_frames).toBe(ONESHOT_SETTLE_FRAMES);
  expect(fitted.frames.length).toBe(48 - ONESHOT_SETTLE_FRAMES);
  expect(areas[0]! / areas[10]!).toBeGreaterThan(0.95);
  expect(areas[0]! / areas[10]!).toBeLessThan(1.05);
  expect(fitted.loop_gap).toBeLessThan(COMPANION_CLIP_LIMITS.loop_gap);
});

test("palette matching moves a saturated yellow clip toward a softer reference", () => {
  const clip = new Uint8Array([248, 200, 8, 255, 0, 0, 0, 0]);
  const reference = new Uint8Array([248, 200, 72, 255, 0, 0, 0, 0]);
  const before = companionMetrics([clip], 2, 1, ["#F8C848"]);
  const matched = clip.slice();
  applyColourMatch([matched], [reference], COLOUR_MATCH_STRENGTH);
  const after = companionMetrics([matched], 2, 1, ["#000000"], [reference]);
  expect(matched[2]).toBeGreaterThan(clip[2]!);
  expect(Math.abs(matched[2]! - reference[2]!)).toBeLessThanOrEqual(Math.abs(clip[2]! - reference[2]!) / 2);
  expect(after.colour_distance).toBeLessThan(before.colour_distance!);
});

test("the report limit decisions cover every quality reason", () => {
  expect(COMPANION_CLIP_LIMITS).toMatchObject({ colour_distance: 48, area_ratio: 1.35, opaque_share_min: 0.03, opaque_share_max: 0.85, loop_gap: 12 });
  expect(companionReasons({ colour_distance: 49, area_ratio: 1.36, opaque_share: { min: 0.02, max: 0.86 }, loop_gap: 13 }, 0.5, 1, 2)).toHaveLength(6);
  expect(companionReasons({ colour_distance: 48, area_ratio: 1.35, opaque_share: { min: 0.03, max: 0.85 }, loop_gap: 12 }, 1, 1, 2)).toEqual([]);
});

test("companion clip input applies defaults, validates duration bounds and refuses unknown fields", () => {
  expect(CompanionClipInput.parse({ path: "/clip.mp4", key: "none", kind: "loop", min_seconds: 1, max_seconds: 3 })).toMatchObject({ colours: [], max_bytes: 614400 });
  expect(CompanionClipInput.safeParse({ path: "/clip.mp4", key: "none", kind: "loop", min_seconds: 4, max_seconds: 3 }).success).toBe(false);
  expect(CompanionClipInput.safeParse({ path: "/clip.mp4", key: "none", kind: "loop", min_seconds: 1, max_seconds: 3, fps: 30 }).success).toBe(false);
  expect(CompanionClipInput.safeParse({ path: "/clip.mp4", key: "none", kind: "loop", min_seconds: 1, max_seconds: 3, colours: ["#aabbcc"] }).success).toBe(false);
  expect(CompanionClipInput.safeParse({ path: "/clip.mp4", key: "none", kind: "loop", min_seconds: 1, max_seconds: 3, palette_reference: "not-base64!" }).success).toBe(false);
});
