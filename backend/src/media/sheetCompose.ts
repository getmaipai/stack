import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaDeps } from "./jobs";
import { spawnRunner, type Runner } from "./run";

export type SheetRole = "place" | "object" | "identity";
export interface SheetLayout { width: number; height: number; place_width: number; gap: number; max_places: number; }
export interface SheetPanel { role: SheetRole; label: string; image: Uint8Array; }
export interface SheetSlot { index: number; label: string; x: number; y: number; width: number; height: number; }
export class SheetComposeError extends Error {}

export function sheetSlots(panels: readonly SheetPanel[], layout: SheetLayout, placeColumns = false): SheetSlot[] {
  const { width, height, place_width, gap, max_places } = layout;
  if (![width, height, place_width, gap, max_places].every(Number.isFinite) || width < 1 || height < 1 || place_width < 1 || gap < 0 || max_places < 0) throw new SheetComposeError("The sheet layout is not valid.");
  if (!panels.length) throw new SheetComposeError("A sheet needs at least one picture.");
  const places = panels.filter((panel) => panel.role === "place").length;
  if (places > max_places) throw new SheetComposeError(`A sheet holds up to ${max_places} place pictures. Send fewer places.`);
  // Attached place pictures (reference clips only) are full-height columns on the left; every other panel, including the views of one place, goes in a grid in the remaining width.
  const placePanels = placeColumns ? panels.filter((panel) => panel.role === "place") : [];
  const gridPanels = panels.filter((panel) => !placePanels.includes(panel));
  const slots = new Map<SheetPanel, SheetSlot>();
  let x = 0;
  for (const panel of placePanels) { slots.set(panel, { index: panels.indexOf(panel), label: panel.label, x, y: 0, width: place_width, height }); x += place_width + gap; }
  if (gridPanels.length) {
    const areaWidth = width - x;
    const columns = gridPanels.length <= 2 ? gridPanels.length : gridPanels.length <= 4 ? 2 : gridPanels.length <= 6 ? 3 : 4;
    const rows = Math.ceil(gridPanels.length / columns);
    const cellW = Math.floor((areaWidth - gap * (columns - 1)) / columns), cellH = Math.floor((height - gap * (rows - 1)) / rows);
    if (cellW < 1 || cellH < 1) throw new SheetComposeError("The sheet panels do not fit this layout.");
    gridPanels.forEach((panel, i) => slots.set(panel, { index: panels.indexOf(panel), label: panel.label, x: x + (i % columns) * (cellW + gap), y: Math.floor(i / columns) * (cellH + gap), width: cellW, height: cellH }));
  } else if (x - gap > width) throw new SheetComposeError("The sheet panels do not fit this layout.");
  return panels.map((panel) => slots.get(panel)!);
}

export function sheetFfmpegArgs(ffmpeg: string, inputs: readonly string[], slots: readonly SheetSlot[], layout: SheetLayout, output: string): string[] {
  const args = [ffmpeg, "-hide_banner", "-nostdin", "-y", "-loglevel", "error"];
  for (const input of inputs) args.push("-i", input);
  const chains: string[] = [ `color=c=white:s=${layout.width}x${layout.height}[base]` ];
  slots.forEach((slot, i) => chains.push(`[${i}:v]scale=${slot.width}:${slot.height}:force_original_aspect_ratio=decrease,pad=${slot.width}:${slot.height}:(ow-iw)/2:(oh-ih)/2:color=white[p${i}]`, `[${i === 0 ? "base" : `b${i - 1}`}][p${i}]overlay=${slot.x}:${slot.y}[b${i}]`));
  args.push("-filter_complex", chains.join(";"), "-map", `[b${slots.length - 1}]`, "-frames:v", "1", "-threads", "1", output);
  return args;
}

export async function composeSheet(options: { panels: readonly SheetPanel[]; layout: SheetLayout; run?: Runner; ffmpeg?: string; placeColumns?: boolean }): Promise<{ png: Uint8Array; panels: Array<{ index: number; label: string; slot: SheetSlot }> }> {
  const slots = sheetSlots(options.panels, options.layout, options.placeColumns);
  const dir = mkdtempSync(join(tmpdir(), "stack-sheet-"));
  try {
    const inputs = options.panels.map((panel, index) => { const path = join(dir, `panel-${index}.png`); writeFileSync(path, panel.image, { mode: 0o600 }); return path; });
    const output = join(dir, "sheet.png");
    const ffmpeg = options.ffmpeg ?? await mediaDeps.toolbox.path("ffmpeg", () => {});
    const result = await (options.run ?? spawnRunner)(sheetFfmpegArgs(ffmpeg, inputs, slots, options.layout, output));
    if (result.code !== 0 || result.aborted) throw new SheetComposeError(`The sheet could not be composed: ${result.stderr.slice(-1500)}`);
    return { png: new Uint8Array(readFileSync(output)), panels: options.panels.map((panel, index) => ({ index, label: panel.label, slot: slots[index]! })) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
