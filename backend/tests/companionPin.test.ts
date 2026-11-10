// MAKER-A2: pin_rest of media.companion_clip.
import { expect, test } from "bun:test";
import { CompanionClipInput } from "@/media/commands";
import { PIN_FRAMES_DEFAULT, pinFrameCount, pinRestEnds, pinWeight, restFrameDifference } from "@/media/companionClip";

const S = 32, N = 30;
const body = (x: number, y: number) => (x - 16) ** 2 + (y - 16) ** 2 <= 100;
function tile(shiftX: number, gain: number, f = 0): Uint8Array {
  const out = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4, inside = body(x - shiftX, y);
    if (!inside) continue;
    out.set([Math.min(255, 200 * gain + f), Math.min(255, 150 * gain), 100 * gain, 255], i);
  }
  return out;
}
const rest = tile(0, 1);
// ends drift (colour gain 1.12, offset 2 px, at both ends), middle is clean and moves a little
function clip(): Uint8Array[] { return Array.from({ length: N }, (_, f) => { const edge = Math.max(0, 1 - Math.min(f, N - 1 - f) / 6); return tile(Math.round(2 * edge), 1 + 0.12 * edge, f % 3); }); }
const params = { path: "/x.mp4", key: "none", kind: "loop", min_seconds: 1, max_seconds: 2 };

test("pin_rest brings the first and last frame within 0.7 Lab of the rest picture, alpha equals the rest alpha there", () => {
  const frames = clip();
  const before = [restFrameDifference(frames[0]!, rest), restFrameDifference(frames[N - 1]!, rest)];
  expect(before[0]!).toBeGreaterThan(2);
  pinRestEnds(frames, rest, 8);
  expect(restFrameDifference(frames[0]!, rest)).toBeLessThanOrEqual(0.7);
  expect(restFrameDifference(frames[N - 1]!, rest)).toBeLessThanOrEqual(0.7);
  for (const f of [0, N - 1]) for (let i = 3; i < rest.length; i += 4) expect(Math.abs(frames[f]![i]! - rest[i]!)).toBeLessThanOrEqual(1);
});
test("pin_rest leaves the middle frames unchanged and keeps colours valid", () => {
  const original = clip(), frames = clip();
  pinRestEnds(frames, rest, 8);
  for (let f = 8; f < N - 8; f++) expect(Buffer.compare(frames[f]!, original[f]!)).toBe(0);
  for (const frame of frames) for (let i = 0; i < frame.length; i += 4) if (!frame[i + 3]) expect([frame[i], frame[i + 1], frame[i + 2]]).toEqual([0, 0, 0]);
});
test("the pin fades smoothly and counts are bounded", () => {
  expect(pinWeight(0, 8)).toBe(1); expect(pinWeight(8, 8)).toBe(0);
  for (let d = 1; d < 8; d++) expect(pinWeight(d, 8)).toBeLessThan(pinWeight(d - 1, 8));
  expect(pinFrameCount(16, 10)).toBe(5); expect(PIN_FRAMES_DEFAULT).toBe(8);
});
test("pin_rest never worsens the loop seam", () => {
  const gap = (frames: Uint8Array[]) => restFrameDifference(frames[N - 1]!, frames[0]!);
  const frames = clip(), seam = gap(frames);
  pinRestEnds(frames, rest, 8);
  expect(gap(frames)).toBeLessThanOrEqual(seam);
});
test("the request refuses pin_rest without a rest reference, in plain words, and bounds pin_frames", () => {
  const refused = CompanionClipInput.safeParse({ ...params, pin_rest: true });
  expect(refused.success).toBe(false);
  expect(JSON.stringify(refused.error?.issues)).toContain("needs rest_reference");
  expect(CompanionClipInput.safeParse({ ...params, pin_rest: true, rest_reference: "QUJD" }).success).toBe(true);
  expect(CompanionClipInput.safeParse({ ...params, pin_rest: true, rest_reference: "QUJD", pin_frames: 17 }).success).toBe(false);
  expect(CompanionClipInput.parse(params).pin_rest).toBe(false);
});
