// MAKE-CLEARER-2026-11-13 (CREATOR-52): SeedVR2 3B, the Best level of Make clearer for pictures. It runs as one more operation (`restore`) of the picture
// engine's worker (mflux 0.23.0, the version image-gen already pins), from two pinned weight files in one hub-cache folder, offline, in mflux's low-RAM
// mode. It is not a picture family: it makes no picture from words and takes no LoRA. It is generative (it redraws fine detail, and on a face it can shift
// small features), which is why Home guards faces and locks it like any engine edit; the Stack only restores.
import { existsSync } from "node:fs";
import { getModel } from "@/lib/modelStore";
import { STACK_IMAGE_RESTORE_ID, STACK_IMAGE_RESTORE_MODELS } from "@/lib/modelCatalog";

export const RESTORE_FAMILY = STACK_IMAGE_RESTORE_ID;
export type RestoreFamilyId = typeof RESTORE_FAMILY;
export const RESTORE_LABEL = "Make clearer, best quality (SeedVR2 3B)";
const GB = 1_000_000_000;
/** Low-RAM mode peak (macOS footprint) for a picture up to about 1 megapixel, measured on the Studio; the figure the governor holds. */
export const RESTORE_PEAK_BYTES = 12 * GB;
/** Hard ceiling on the picture the Stack restores, in output megapixels (measured 2026-11-13; larger pictures were not benched). */
export const RESTORE_MAX_MEGAPIXELS = 2;
/** The longest side the output may have; keeps a thin panorama inside the measured envelope. */
export const RESTORE_MAX_SIDE = 2048;
/** Seconds a 512 px picture takes (measured, warm weights in the page cache), for the status route. */
export const RESTORE_WARM_SECONDS = 6;
/** The enlarging factors a restore may ask for (1 repairs at the same size; 2 doubles it). */
export const RESTORE_SCALES = [1, 2] as const;

let installedOverride: boolean | null = null;
export function __setRestoreInstalledForTests(value: boolean | null): void { installedOverride = value; }

/** Whether both pinned files are installed and verified. */
export function restoreInstalled(): boolean {
  if (installedOverride !== null) return installedOverride;
  return STACK_IMAGE_RESTORE_MODELS.every((pin) => {
    const record = getModel(pin.id);
    return !!record?.modelPath && !!record.verifiedAt && existsSync(record.modelPath);
  });
}

/** The hub-cache snapshot folder holding both files, or null when they are not both installed. */
export function restoreSnapshot(): string | null {
  if (!restoreInstalled()) return null;
  if (installedOverride) return "/models/seedvr2-3b";
  const primary = STACK_IMAGE_RESTORE_MODELS.find((pin) => pin.id === RESTORE_FAMILY)!;
  const record = getModel(primary.id)!;
  const file = primary.download!.hub_file!;
  return record.modelPath!.endsWith(`/${file}`) ? record.modelPath!.slice(0, -(file.length + 1)) : null;
}

/** The output size of a restore at `scale` for a picture of this size, or the plain sentence that says why it is refused. */
export function restoreOutputSize(width: number, height: number, scale: number): { width: number; height: number } | string {
  if (!(RESTORE_SCALES as readonly number[]).includes(scale)) return "Make clearer can keep the size (scale 1) or double it (scale 2).";
  const out = { width: width * scale, height: height * scale };
  if (out.width * out.height > RESTORE_MAX_MEGAPIXELS * 1_000_000 || Math.max(out.width, out.height) > RESTORE_MAX_SIDE) {
    return `That picture is too large for the best quality. It can restore up to ${RESTORE_MAX_MEGAPIXELS} megapixels (about 1400 by 1400), so use a smaller picture or the Better level.`;
  }
  return out;
}
