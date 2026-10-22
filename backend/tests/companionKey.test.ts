import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { estimateBackground, keyOutRgba } from "@/media/companionClip";
import { spawnRunner } from "@/media/run";

process.env.STACK_MEDIA_NO_NICE = "1";

type Rgb = [number, number, number];
const at = (frame: Uint8Array, width: number, x: number, y: number) => (y * width + x) * 4;

function scene(background: Rgb, disc: Rgb, key: "green" | "magenta", extra: "shadow" | "red" = "shadow"): Uint8Array {
  const width = 128, height = 128, frame = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = at(frame, width, x, y); frame.set([...background, 255], i);
    if (extra === "shadow") {
      const ellipse = ((x - 64) / 30) ** 2 + ((y - 91) / 8) ** 2;
      if (ellipse < 1) frame.set(key === "green" ? [80, 130, 85, 255] : [190, 110, 190, 255], i);
    }
    const distance = Math.hypot(x - 64, y - 58);
    const opacity = Math.max(0, Math.min(1, (38 - distance) / 2));
    if (opacity > 0) {
      const colour = extra === "red" ? [230, 40, 30] : disc;
      frame.set([...colour, Math.round(opacity * 255)], i);
    }
  }
  keyOutRgba(frame, key === "green" ? [0, 255, 0] : [255, 0, 255], { width, height });
  return frame;
}

test("estimates the per-channel median of the sampled two-pixel border", () => {
  const width = 8, height = 8, frame = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) frame.set([10, 20, 30, 255], i * 4);
  frame.set([250, 250, 250, 255], at(frame, width, 0, 0));
  expect(estimateBackground(frame, width, height)).toEqual([10, 20, 30]);
});

test("muted green keys its estimated background and despills edges", () => {
  const frame = scene([113, 174, 112], [240, 140, 40], "green");
  const width = 128;
  for (const [x, y] of [[0, 0], [127, 0], [0, 127], [127, 127]] as [number, number][]) expect(frame[at(frame, width, x, y) + 3]).toBe(0);
  expect([...frame.slice(at(frame, width, 64, 58), at(frame, width, 64, 58) + 4)]).toEqual([240, 140, 40, 255]);
  for (let y = 80; y < 101; y++) for (let x = 38; x < 91; x++) {
    const i = at(frame, width, x, y), [r, g, b] = frame.slice(i, i + 3);
    if (g! - Math.max(r!, b!) >= 40) expect(frame[i + 3]).toBeLessThanOrEqual(20);
  }
  for (let i = 0; i < frame.length; i += 4) if (frame[i + 3]! > 20) expect(frame[i + 1]).toBeLessThanOrEqual(Math.max(frame[i]!, frame[i + 2]!) + 12);
});

test("shifted magenta keys without clamping red character edges", () => {
  const yellow = scene([170, 90, 175], [250, 210, 40], "magenta");
  for (const [x, y] of [[0, 0], [127, 0], [0, 127], [127, 127]] as [number, number][]) expect(yellow[at(yellow, 128, x, y) + 3]).toBe(0);
  expect([...yellow.slice(at(yellow, 128, 64, 58), at(yellow, 128, 64, 58) + 4)]).toEqual([250, 210, 40, 255]);
  for (let y = 80; y < 101; y++) for (let x = 38; x < 91; x++) {
    const i = at(yellow, 128, x, y), [r, g, b] = yellow.slice(i, i + 3);
    if (Math.min(r!, b!) - g! >= 40) expect(yellow[i + 3]).toBeLessThanOrEqual(20);
  }
  const red = scene([170, 90, 175], [230, 40, 30], "magenta", "red");
  const edge = red[at(red, 128, 64, 21)];
  expect(edge).toBeGreaterThan(220);
});

test("background estimates adapt frame by frame, while a character border uses pure-key fallback", () => {
  for (const background of [[113, 174, 112], [100, 160, 100]] as Rgb[]) {
    const frame = new Uint8Array(16 * 16 * 4);
    for (let i = 0; i < frame.length; i += 4) frame.set([...background, 255], i);
    keyOutRgba(frame, [0, 255, 0], { width: 16, height: 16 });
    expect(frame[3]).toBe(0);
  }
  const touched = new Uint8Array(8 * 8 * 4);
  for (let i = 0; i < touched.length; i += 4) touched.set([230, 40, 30, 255], i);
  const expected = touched.slice(); keyOutRgba(expected, [0, 255, 0]);
  keyOutRgba(touched, [0, 255, 0], { width: 8, height: 8 });
  expect(touched).toEqual(expected);
});

const ffmpeg = "/Users/jessetorres/.cache/uv/archive-v0/_tZvViE2XqBtGyd7/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1";
const fixture = new URL("./fixtures/rivet-muted-green-256.png", import.meta.url).pathname;
const real = existsSync(ffmpeg) ? test : test.skip;

real("real muted-green robot picture keys cleanly", async () => {
  const output = join(tmpdir(), "companion-key-picture.rgba");
  const result = await spawnRunner([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", fixture, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", output]);
  if (result.code !== 0) throw new Error(result.stderr);
  const frame = new Uint8Array(readFileSync(output));
  rmSync(output, { force: true });
  const original = frame.slice();
  keyOutRgba(frame, [0, 255, 0], { width: 256, height: 256 });
  for (const [x, y] of [[0, 0], [255, 0], [0, 255], [255, 255]] as [number, number][]) expect(frame[at(frame, 256, x, y) + 3]).toBe(0);
  let opaque = 0;
  for (let i = 3; i < frame.length; i += 4) if (frame[i]! > 128) opaque++;
  expect(opaque / (256 * 256)).toBeGreaterThanOrEqual(0.12);
  expect(opaque / (256 * 256)).toBeLessThanOrEqual(0.30);
  // Locate the requested white chest patch within the opaque robot pixels.
  let chest: number[] | undefined;
  outer: for (let y = 0; y <= 236; y++) for (let x = 0; x <= 236; x++) {
    let matches = true;
    for (let dy = 0; dy < 20 && matches; dy++) for (let dx = 0; dx < 20; dx++) {
      const i = at(frame, 256, x + dx, y + dy);
      if (frame[i + 3]! !== 255 || frame[i]! < 245 || frame[i + 1]! < 245 || frame[i + 2]! < 245) { matches = false; break; }
    }
    if (matches) {
      for (let dy = 0; dy < 20; dy++) for (let dx = 0; dx < 20; dx++) {
        const white = at(frame, 256, x + dx, y + dy);
        if (original[white] === 255 && original[white + 1] === 255 && original[white + 2] === 255) { chest = [x + dx, y + dy]; break outer; }
      }
    }
  }
  expect(chest).toBeDefined();
  if (chest) expect([...frame.slice(at(frame, 256, chest[0]!, chest[1]!), at(frame, 256, chest[0]!, chest[1]!) + 4)]).toEqual([255, 255, 255, 255]);
  // Pixels in the one-to-two pixel exterior ring of the opaque bbox stay mostly transparent.
  let minX = 256, minY = 256, maxX = 0, maxY = 0;
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) if (frame[at(frame, 256, x, y) + 3]! > 128) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  for (let y = Math.max(0, minY - 2); y <= Math.min(255, maxY + 2); y++) for (let x = Math.max(0, minX - 2); x <= Math.min(255, maxX + 2); x++) {
    const outside = x < minX || x > maxX || y < minY || y > maxY;
    if (outside && (x < minX + 2 || x > maxX - 2 || y < minY + 2 || y > maxY - 2)) expect(frame[at(frame, 256, x, y) + 3]).toBeLessThanOrEqual(40);
  }
});
