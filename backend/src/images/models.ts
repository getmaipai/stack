// IMGGEN-STACK-01: which picture models this Stack knows, how each is run, and
// what each costs. A "family" is one pinned set of weights (a primary record
// plus the component records mflux reads beside it, see lib/modelCatalog.ts).
// Quantization is decided here from the tier, never by the caller: Klein 4B
// runs 8-bit (4-bit on a 32 GB computer), Z-Image-Turbo 8-bit, and a reference
// edit runs the same Klein weights at bf16 (8-bit left a plant in the picture
// it was asked to remove). Peaks are the MLX allocations measured on the
// Studio (M5 Max, 128 GB), plus ten percent, in design note section 7.
import { existsSync } from "node:fs";
import { getGovernorStatus } from "@/lib/governor";
import { getModel } from "@/lib/modelStore";
import { STACK_IMAGE_ENGINE_MODELS, STACK_IMAGE_KLEIN_ID, STACK_IMAGE_ZIMAGE_ID } from "@/lib/modelCatalog";
import { IMAGE_LORA_BASES, type ImageLoraBase } from "@/images/loras";
import type { CatalogModelLike } from "@/lib/modelStore";

export type ImageFamilyId = ImageLoraBase;

export interface ImageFamily {
  id: ImageFamilyId;
  /** The catalog id of the primary record. */
  catalogId: string;
  label: string;
  licence: string;
  stepsDefault: number;
  stepsMax: number;
  /** Peak bytes the governor holds for one job. */
  peak: { gen8: number; gen4: number; edit: number };
  /** Added to the peak while LoRAs are applied (unbaked adapters). */
  loraExtraBytes: number;
  edit: boolean;
  /** Tiers that run it. */
  tiers: Array<"p32" | "p64" | "p128">;
  /** The seconds a 1024 x 1024 picture takes warm (measured), for the status route. */
  warmSeconds: number;
}

const GB = 1_000_000_000;
export const IMAGE_FAMILIES: Record<ImageFamilyId, ImageFamily> = {
  "flux2-klein-4b": { id: "flux2-klein-4b", catalogId: STACK_IMAGE_KLEIN_ID, label: "FLUX.2 Klein 4B", licence: "Apache-2.0", stepsDefault: 4, stepsMax: 12, peak: { gen8: 15 * GB, gen4: 13 * GB, edit: 18 * GB }, loraExtraBytes: 1 * GB, edit: true, tiers: ["p32", "p64", "p128"], warmSeconds: 4.0 },
  "z-image-turbo": { id: "z-image-turbo", catalogId: STACK_IMAGE_ZIMAGE_ID, label: "Z-Image-Turbo", licence: "Apache-2.0", stepsDefault: 9, stepsMax: 20, peak: { gen8: 34 * GB, gen4: 34 * GB, edit: 0 }, loraExtraBytes: 1 * GB, edit: false, tiers: ["p128"], warmSeconds: 12.9 },
};
export const DEFAULT_FAMILY: ImageFamilyId = "flux2-klein-4b";

/** Hard ceilings in the Stack, not settings. */
export const IMAGE_MIN_SIDE = 256;
export const IMAGE_MAX_SIDE = 2048;
export const IMAGE_SIZE_STEP = 16;
export const IMAGE_DEFAULT_SIZE = "1024x1024";
export const IMAGE_MAX_COUNT = 4;
export const IMAGE_MAX_PROMPT_CHARS = 4000;
export const IMAGE_MAX_INPUT_BYTES = 40 * 1024 * 1024;
export const IMAGE_MAX_EDIT_MEGAPIXELS = 25;
export const IMAGE_QUEUE_MAX = 4;
export const IMAGE_FEATHER_MAX = 64;
export const IMAGE_FEATHER_DEFAULT = 12;

export const isFamilyId = (value: string): value is ImageFamilyId => (IMAGE_LORA_BASES as readonly string[]).includes(value);

function recordsOf(family: ImageFamilyId): CatalogModelLike[] {
  const id = IMAGE_FAMILIES[family].catalogId;
  return STACK_IMAGE_ENGINE_MODELS.filter((pin) => pin.id === id || pin.id.startsWith(`${id}-`));
}

/** The suite says which families are installed without installing 16 GB of weights; null puts the real check back. */
let installedOverride: Set<ImageFamilyId> | null = null;
export function __setInstalledFamiliesForTests(families: ImageFamilyId[] | null): void { installedOverride = families ? new Set(families) : null; }

/** Whether every pinned file of the family is installed and verified. */
export function familyInstalled(family: ImageFamilyId): boolean {
  if (installedOverride) return installedOverride.has(family);
  return recordsOf(family).every((pin) => {
    const record = getModel(pin.id);
    return !!record?.modelPath && !!record.verifiedAt && existsSync(record.modelPath);
  });
}

/** The hub-cache snapshot folder the worker loads from, or null when the family is not fully installed. */
export function familySnapshot(family: ImageFamilyId): string | null {
  if (!familyInstalled(family)) return null;
  if (installedOverride) return `/models/${family}`;
  const primary = recordsOf(family).find((pin) => pin.id === IMAGE_FAMILIES[family].catalogId)!;
  const record = getModel(primary.id)!;
  const file = primary.download!.hub_file!;
  return record.modelPath!.endsWith(`/${file}`) ? record.modelPath!.slice(0, -(file.length + 1)) : null;
}

export function installedFamilies(): ImageFamilyId[] { return (Object.keys(IMAGE_FAMILIES) as ImageFamilyId[]).filter(familyInstalled); }

export function installPlanFor(family?: ImageFamilyId): CatalogModelLike[] {
  if (family) return recordsOf(family);
  return STACK_IMAGE_ENGINE_MODELS.filter((pin) => recordsOf(DEFAULT_FAMILY).includes(pin));
}

export type Tier = "p16" | "p32" | "p64" | "p128";
export function runsOnTier(family: ImageFamilyId, tier: string): boolean { return (IMAGE_FAMILIES[family].tiers as string[]).includes(tier); }

/** Bits the weights are quantized to at load; null for bf16. */
export function quantizeFor(family: ImageFamilyId, mode: "generate" | "edit", tier: string): number | null {
  if (mode === "edit") return null;
  if (family === "flux2-klein-4b" && tier === "p32") return 4;
  return 8;
}

export function peakBytes(family: ImageFamilyId, mode: "generate" | "edit", quantize: number | null, loras: number, count = 1): number {
  const info = IMAGE_FAMILIES[family];
  const base = mode === "edit" ? info.peak.edit : quantize === 4 ? info.peak.gen4 : info.peak.gen8;
  // Pixels beyond 1024 x 1024 cost activations; the measured peak is at 1 megapixel.
  void count;
  return base + (loras > 0 ? info.loraExtraBytes : 0);
}

export interface Availability { available: boolean; code: string | null; reason: string | null; tier: string; }
export function imageAvailability(supported: boolean, tier = getGovernorStatus().tier, totalMemoryBytes = getGovernorStatus().totalMemoryBytes): Availability {
  if (!supported) return { available: false, code: "unsupported", reason: `The picture generator is not available on ${process.platform} ${process.arch} yet.`, tier };
  if (tier === "p16") return { available: false, code: "not_available_on_this_computer", reason: `Pictures need a computer with 32 GB of memory or more; this one has ${Math.round(totalMemoryBytes / 1_073_741_824)} GB.`, tier };
  return { available: true, code: null, reason: null, tier };
}

export function parseSize(size: string | undefined): { width: number; height: number } | string {
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(size ?? IMAGE_DEFAULT_SIZE);
  if (!match) return `The size must look like ${IMAGE_DEFAULT_SIZE}.`;
  const width = Number(match[1]); const height = Number(match[2]);
  if (width % IMAGE_SIZE_STEP || height % IMAGE_SIZE_STEP) return `Width and height must be multiples of ${IMAGE_SIZE_STEP} (${IMAGE_DEFAULT_SIZE} is the default).`;
  if (width < IMAGE_MIN_SIDE || height < IMAGE_MIN_SIDE || width > IMAGE_MAX_SIDE || height > IMAGE_MAX_SIDE) return `Each side must be between ${IMAGE_MIN_SIDE} and ${IMAGE_MAX_SIDE} pixels.`;
  return { width, height };
}
