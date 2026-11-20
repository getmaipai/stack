import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sheetFfmpegArgs, sheetSlots, composeSheet, type SheetLayout } from "./sheetCompose";
import { spawnRunner } from "./run";

const layout: SheetLayout = { width: 12, height: 4, place_width: 4, gap: 1, max_places: 2 };
const panels = ["red", "green", "blue"].map((label) => ({ role: "object" as const, label, image: new Uint8Array() }));
test("sheet slots and ffmpeg arguments match the goldens", () => {
  const slots = sheetSlots(panels, layout);
  expect(slots).toEqual([
    { index: 0, label: "red", x: 0, y: 0, width: 3, height: 4 },
    { index: 1, label: "green", x: 4, y: 0, width: 3, height: 4 },
    { index: 2, label: "blue", x: 8, y: 0, width: 3, height: 4 },
  ]);
  expect(sheetFfmpegArgs("ffmpeg", ["a.png", "b.png", "c.png"], slots, layout, "out.png")).toEqual([
    "ffmpeg", "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-i", "a.png", "-i", "b.png", "-i", "c.png", "-filter_complex",
    "color=c=white:s=12x4[base];[0:v]scale=3:4:force_original_aspect_ratio=decrease,pad=3:4:(ow-iw)/2:(oh-ih)/2:color=white[p0];[base][p0]overlay=0:0[b0];[1:v]scale=3:4:force_original_aspect_ratio=decrease,pad=3:4:(ow-iw)/2:(oh-ih)/2:color=white[p1];[b0][p1]overlay=4:0[b1];[2:v]scale=3:4:force_original_aspect_ratio=decrease,pad=3:4:(ow-iw)/2:(oh-ih)/2:color=white[p2];[b1][p2]overlay=8:0[b2]",
    "-map", "[b2]", "-frames:v", "1", "-threads", "1", "out.png",
  ]);
});

const ffmpeg = process.env.STACK_MEDIA_FFMPEG ?? "ffmpeg";
const haveFfmpeg = spawnSync(ffmpeg, ["-version"], { stdio: "ignore" }).status === 0;
const real = haveFfmpeg ? test : test.skip;
real("compose solid panels and decode sheet pixels with ffmpeg", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sheet-compose-test-"));
  try {
    const oldNice = process.env.STACK_MEDIA_NO_NICE; process.env.STACK_MEDIA_NO_NICE = "1";
    const colors = ["red", "green", "blue"];
    const files = colors.map((color, i) => join(dir, `${i}.png`));
    for (let i = 0; i < colors.length; i++) spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${colors[i]}:s=4x4`, "-frames:v", "1", files[i]!], { stdio: "inherit" });
    const bytes = files.map((file) => new Uint8Array(readFileSync(file)));
    const made = await composeSheet({ panels: colors.map((label, i) => ({ role: "object", label, image: bytes[i]! })), layout: { width: 12, height: 4, place_width: 4, gap: 0, max_places: 2 }, ffmpeg, run: spawnRunner });
    if (oldNice === undefined) delete process.env.STACK_MEDIA_NO_NICE; else process.env.STACK_MEDIA_NO_NICE = oldNice;
    const path = join(dir, "made.png"); writeFileSync(path, made.png);
    const raw = join(dir, "pixels.rgba");
    const decoded = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", raw], { stdio: "inherit" });
    expect(decoded.status).toBe(0);
    const pixels = readFileSync(raw); expect(pixels.length).toBe(12 * 4 * 4);
    const pixel = (x: number) => [...pixels.subarray((1 * 12 + x) * 4, (1 * 12 + x) * 4 + 3)];
    const near = (got: number[], want: number[]) => got.every((channel, index) => Math.abs(channel - want[index]!) <= 6);
    expect(near(pixel(1), [255, 0, 0])).toBe(true); expect(near(pixel(5), [0, 128, 0])).toBe(true); expect(near(pixel(9), [0, 0, 255])).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
