import packageJson from "../../package.json";
import type { StackPart } from "@maipai/spec/stack/ts/stack-part.js";
import { StackPart as StackPartSchema } from "@maipai/spec/stack/ts/stack-part.js";
import { TIER_CANDIDATES } from "@/lib/tiers";
import { STACK_MODELS } from "@/lib/modelCatalog";
import type { CatalogModelLike } from "@/lib/modelStore";

import { PART_DEFS } from "@/lib/partDefs";
export { PART_DEFS, partDef, partLabel, type PartDef } from "@/lib/partDefs";

interface PartUnitLike { id: string; pins: CatalogModelLike[]; licenceName?: string; licenceNotice?: { id: string } }
let componentUnits: () => PartUnitLike[] = () => [];
export function registerPartUnits(provider: () => PartUnitLike[]): void { componentUnits = provider; }

// A static import, never createRequire: the compiled Stack binary (scripts/build-binary.sh) resolves no relative require (2026-11-17, a ship failed on it).
const stackVersion = packageJson.version;

// A runner is required when it is a part of its own: an engine row, or a tool part that doubles as the runner (image-tools, liveportrait, score-gen).
const ENGINE_PART_IDS = new Set(PART_DEFS.filter((def) => def.kind !== "model").map((def) => def.id));

export function stackParts(): StackPart[] {
  const units = componentUnits();
  return PART_DEFS.filter((def) => def.kind !== "engine").flatMap((def) => {
    const unit = units.find((candidate) => candidate.id === def.id);
    if (!unit) return [];
    const pins = unit.pins.filter((pin) => pin.download && pin.revision);
    if (!pins.length) return [];
    const primary = pins.find((pin) => pin.id === def.id) ?? pins[0]!;
    const candidates = TIER_CANDIDATES.filter((candidate) => candidate.id === def.id);
    const files = pins.flatMap((pin) => {
      const download = pin.download!;
      if (download.files?.length) {
        const base = download.url.slice(0, download.url.lastIndexOf("/") + 1);
        return download.files.map((file) => ({ url: new URL(file.path, base).href, sha256: file.sha256, bytes: file.bytes, path: file.path }));
      }
      return [{ url: download.url, sha256: download.sha256, bytes: download.approx_bytes, ...(download.hub_file ? { path: download.hub_file } : {}) }];
    });
    const builds = candidates.flatMap((candidate) => candidate.tiers.filter((tier) => tier !== "reduced").flatMap((tier) => candidate.peaks.map((peak) => ({ tier: tier as "standard" | "boost" | "max", options: peak.options }))));
    const peaks = candidates.flatMap((candidate) => candidate.peaks.map((peak) => ({ options: peak.options, bytes: peak.peakBytes, status: peak.status })));
    const noticeId = unit.licenceNotice?.id ?? null;
    const projector = primary.imageInput ? STACK_MODELS.find((pin) => pin.id === primary.imageInput!.projector) : undefined;
    const chat = primary.role === "chat" && (primary.sampling || projector) ? {
      ...(primary.sampling ? { sampling: primary.sampling } : {}),
      ...(projector?.download ? { image_input: { projector: { file: projector.download.hub_file ?? projector.download.url.split("/").at(-1)!, download: { url: projector.download.url, sha256: projector.download.sha256, approx_bytes: projector.download.approx_bytes } } } } : {}),
    } : undefined;
    const runner = primary.engine ?? null;
    const raw = { id: def.id, kind: def.kind, category: def.category, priority: def.priority, label: def.label, neutral_label: def.neutralLabel, description: def.description, adult_only: def.adultOnly, ...(def.minorOnly ? { minor_only: true } : {}), ...(def.category === "chat" && chat ? { chat } : {}), version: primary.revision!, files, licence: { name: primary.license ?? unit.licenceName ?? "Unknown", notice_id: noticeId }, runner, requires: runner && ENGINE_PART_IDS.has(runner) ? [runner] : [], builds, peaks, min_stack: stackVersion };
    return [StackPartSchema.parse(raw)];
  });
}
