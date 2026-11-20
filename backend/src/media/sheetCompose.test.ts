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
  // Three panels make a two column grid.
  expect(slots).toEqual([
    { index: 0, label: "red", x: 0, y: 0, width: 5, height: 1 },
    { index: 1, label: "green", x: 6, y: 0, width: 5, height: 1 },
    { index: 2, label: "blue", x: 0, y: 2, width: 5, height: 1 },
  ]);
  const args = sheetFfmpegArgs("ffmpeg", ["a.png", "b.png", "c.png"], slots, layout, "out.png");
  expect(args.slice(0, 12)).toEqual(["ffmpeg", "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-i", "a.png", "-i", "b.png", "-i", "c.png"]);
  expect(args.slice(-7)).toEqual(["-map", "[b2]", "-frames:v", "1", "-threads", "1", "out.png"]);
  const filter = args[args.indexOf("-filter_complex") + 1]!;
  expect(filter.startsWith("color=c=white:s=12x4[base];")).toBe(true);
  for (const [i, slot] of slots.entries()) {
    expect(filter).toContain(`[${i}:v]scale=${slot.width}:${slot.height}:force_original_aspect_ratio=decrease,pad=${slot.width}:${slot.height}:(ow-iw)/2:(oh-ih)/2:color=white[p${i}]`);
    expect(filter).toContain(`[p${i}]overlay=${slot.x}:${slot.y}[b${i}]`);
  }
});

test("six views of one place make a 3 by 2 grid; attached places are full-height columns on the left", () => {
  const sheet: SheetLayout = { width: 768, height: 448, place_width: 288, gap: 2, max_places: 2 };
  const six = Array.from({ length: 6 }, (_, i) => ({ role: "object" as const, label: `view ${i}`, image: new Uint8Array() }));
  const grid = sheetSlots(six, sheet);
  expect(grid.map((slot) => [slot.x, slot.y, slot.width, slot.height])).toEqual([[0, 0, 254, 223], [256, 0, 254, 223], [512, 0, 254, 223], [0, 225, 254, 223], [256, 225, 254, 223], [512, 225, 254, 223]]);
  const mixed = [{ role: "place" as const, label: "hall", image: new Uint8Array() }, { role: "object" as const, label: "lamp", image: new Uint8Array() }, { role: "object" as const, label: "vase", image: new Uint8Array() }];
  const slots = sheetSlots(mixed, sheet, true);
  expect(slots[0]).toMatchObject({ x: 0, y: 0, width: 288, height: 448 });
  expect(slots[1]).toMatchObject({ x: 290, y: 0, width: 238, height: 448 });
  expect(slots[2]).toMatchObject({ x: 530, y: 0, width: 238, height: 448 });
  expect(() => sheetSlots([...mixed, ...mixed, ...mixed].filter((panel) => panel.role === "place" || true).map((p) => ({ ...p, role: "place" as const })), sheet, true)).toThrow();
});

const ffmpeg = process.env.STACK_MEDIA_FFMPEG ?? "ffmpeg";
const haveFfmpeg = spawnSync(ffmpeg, ["-version"], { stdio: "ignore" }).status === 0;
const real = haveFfmpeg ? test : test.skip;
real("compose solid panels and decode sheet pixels with ffmpeg", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sheet-compose-test-"));
  try {
    const oldNice = process.env.STACK_MEDIA_NO_NICE; process.env.STACK_MEDIA_NO_NICE = "1";
    const colors = ["red", "green"];
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
    expect(near(pixel(1), [255, 0, 0])).toBe(true); expect(near(pixel(8), [0, 128, 0])).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
