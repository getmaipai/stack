import { StackPartList as StackPartListSchema, type StackPartList } from "@maipai/spec/stack/ts/stack-part-list.js";
import type { StackPartView } from "@maipai/spec/stack/ts/stack-part-view.js";
import { partDef } from "@/lib/partDefs";
import { stackParts } from "@/lib/parts";
import { listComponents } from "@/lib/components";
import { detectHardware, type HardwareInfo } from "@/lib/hardware";
import { proposeProfile } from "@/profiles";
import { reducedRoomBytes, tierRoomBytes } from "@/lib/governor";
import { tierCandidateLists, type TierCategory } from "@/lib/tiers";

export type PartsAudience = "adult" | "minor";
export interface PartsFilter { audience: PartsAudience; kind?: "model" | "tool" | "engine"; category?: string }
let testHardware: HardwareInfo | null = null;
let hasHardwareOverride = false;
export function __setPartsHardwareForTests(hw: HardwareInfo | null): void { testHardware = hw; hasHardwareOverride = hw !== null; }

const candidateCategories: TierCategory[] = ["chat", "pictures", "video", "music", "voice", "stems"];

export async function listParts(filter: PartsFilter, hw?: HardwareInfo): Promise<StackPartList> {
  const hardware = hw ?? (hasHardwareOverride ? testHardware! : await detectHardware());
  const [components, runtimeParts] = await Promise.all([listComponents(hardware), Promise.resolve(stackParts())]);
  const runtimeById = new Map(runtimeParts.map((part) => [part.id, part]));
  const componentById = new Map(components.components.filter((component) => !component.id.startsWith("lora.")).map((component) => [component.id, component]));
  const defs = [...componentById.keys()].flatMap((id) => { const def = partDef(id); return def ? [def] : []; });
  const requiredBy = new Map<string, string[]>();
  for (const component of components.components) {
    if (component.id.startsWith("lora.")) continue;
    for (const dependency of component.depends_on) requiredBy.set(dependency, [...(requiredBy.get(dependency) ?? []), component.id]);
  }
  const profile = proposeProfile(hardware)?.id ?? null;
  const candidateLists = new Map<TierCategory, ReturnType<typeof tierCandidateLists>>();
  if (profile) for (const category of candidateCategories) candidateLists.set(category, tierCandidateLists(category, profile, tierRoomBytes(), reducedRoomBytes()));

  let parts: StackPartView[] = defs.flatMap((def) => {
    if ((filter.audience === "minor" && def.adultOnly) || (filter.audience === "adult" && def.minorOnly)) return [];
    const component = componentById.get(def.id)!;
    const unsupported = component.requirement === "unsupported";
    let fits: StackPartView["fits"] = { standard: true, boost: true, max: true, reason: null };
    if (unsupported) fits = { standard: false, boost: false, max: false, reason: component.requirement_reason };
    else if (candidateCategories.includes(def.category as TierCategory)) {
      if (!profile) fits = { standard: false, boost: false, max: false, reason: "This computer is too small for this part." };
      else {
        const levels = candidateLists.get(def.category as TierCategory) ?? [];
        const rows = levels.map((level) => ({ level: level.tier, row: level.candidates.find((candidate) => candidate.id === def.id) })).filter((entry) => entry.row);
        if (rows.length) {
          const rowFor = (tier: "standard" | "boost" | "max") => levels.find((level) => level.tier === tier)?.candidates.find((candidate) => candidate.id === def.id);
          fits = { standard: rowFor("standard")?.fits ?? true, boost: rowFor("boost")?.fits ?? true, max: rowFor("max")?.fits ?? true, reason: rows.map(({ row }) => row!.refusal).find((refusal) => refusal !== null) ?? null };
        }
      }
    }
    const state = unsupported ? "unsupported" : component.state === "installed" ? "ready" : component.state === "notInstalled" ? "missing" : component.state;
    const view = {
      id: def.id, kind: def.kind, category: def.category, priority: def.priority,
      ...(runtimeById.get(def.id)?.chat ? { chat: runtimeById.get(def.id)!.chat } : {}),
      label: filter.audience === "adult" ? def.label : def.neutralLabel,
      description: filter.audience === "adult" ? def.description : "", enabled: true, state,
      size_bytes: component.size_bytes ?? 0, download_bytes: component.download_bytes, percent: component.percent,
      fits, can_install: component.can_install, install_block: component.install_block,
      can_uninstall: component.can_uninstall, uninstall_block: component.uninstall_block,
      licence_needed: component.licence !== null && component.licence.accepted_at === null,
      required_by: requiredBy.get(def.id) ?? [], update: { available: false, version: null },
    } satisfies StackPartView;
    return [view];
  });
  if (filter.kind) parts = parts.filter((part) => part.kind === filter.kind);
  if (filter.category !== undefined) parts = parts.filter((part) => part.category === filter.category);
  parts.sort((a, b) => a.category.localeCompare(b.category) || a.priority - b.priority || a.id.localeCompare(b.id));
  return StackPartListSchema.parse({ audience: filter.audience, parts });
}
