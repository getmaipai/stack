import { StackPartList as StackPartListSchema, type StackPartList } from "@maipai/spec/stack/ts/stack-part-list.js";
import type { StackPartView } from "@maipai/spec/stack/ts/stack-part-view.js";
import { partDef } from "@/lib/partDefs";
import { stackParts } from "@/lib/parts";
import { listComponents } from "@/lib/components";
import { detectHardware, type HardwareInfo } from "@/lib/hardware";
import { proposeProfile } from "@/profiles";
import { reducedRoomBytes, tierRoomBytes } from "@/lib/governor";
import { tierCandidateLists, type TierCategory } from "@/lib/tiers";
import { readPartChoices, enabledFor, effectivePriority } from "@/lib/partChoices";
import { ENGINE_BINARIES, installedEnginePin } from "@/lib/engineCatalog";
import { PART_DEFS } from "@/lib/partDefs";
import { componentDefs } from "@/lib/components";
import { getModel } from "@/lib/modelStore";
import { catalogModelsForIds, pendingEngineUpdate } from "@/updates/catalog";
import { modelUpdateJob } from "@/updates/models";

export type PartsAudience = "adult" | "minor";
export interface PartsFilter { audience: PartsAudience; kind?: "model" | "tool" | "engine"; category?: string }
let testHardware: HardwareInfo | null = null;
let hasHardwareOverride = false;
export function __setPartsHardwareForTests(hw: HardwareInfo | null): void { testHardware = hw; hasHardwareOverride = hw !== null; }

const candidateCategories: TierCategory[] = ["chat", "pictures", "video", "music", "voice", "stems"];

export async function listParts(filter: PartsFilter, hw?: HardwareInfo): Promise<StackPartList> {
  const choices = readPartChoices();
  const hardware = hw ?? (hasHardwareOverride ? testHardware! : await detectHardware());
  const [components, runtimeParts] = await Promise.all([listComponents(hardware), Promise.resolve(stackParts())]);
  const modelEntries = catalogModelsForIds(runtimeParts.filter((part) => part.kind === "model").map((part) => part.id));
  const modelUpdates = new Map(runtimeParts.filter((part) => part.kind === "model").map((part) => {
    const installed = getModel(part.id);
    const entry = modelEntries.get(part.id);
    const available = !!installed?.modelPath && !!entry?.revision && entry.revision !== installed.revision;
    return [part.id, { available, version: available ? entry!.revision! : null } as const];
  }));
  const runtimeById = new Map(runtimeParts.map((part) => [part.id, part]));
  const componentById = new Map(components.components.filter((component) => !component.id.startsWith("lora.") && partDef(component.id)?.kind !== "engine").map((component) => [component.id, component]));
  const defs = [...componentById.keys()].flatMap((id) => { const def = partDef(id); return def && def.kind !== "engine" ? [def] : []; });
  const requiredBy = new Map<string, string[]>();
  for (const component of components.components) {
    if (component.id.startsWith("lora.")) continue;
    for (const dependency of component.depends_on) requiredBy.set(dependency, [...(requiredBy.get(dependency) ?? []), component.id]);
  }
  for (const part of runtimeParts) for (const dependency of part.requires) requiredBy.set(dependency, [...(requiredBy.get(dependency) ?? []), part.id]);
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
    const view: StackPartView = {
      id: def.id, kind: def.kind, category: def.category, priority: effectivePriority(def, choices),
      ...(runtimeById.get(def.id)?.chat ? { chat: runtimeById.get(def.id)!.chat } : {}),
      label: filter.audience === "adult" ? def.label : def.neutralLabel,
      description: filter.audience === "adult" ? def.description : "", enabled: enabledFor(def.id, def.category, choices), state,
      size_bytes: component.size_bytes ?? 0, download_bytes: component.download_bytes, percent: component.percent,
      fits, can_install: component.can_install, install_block: component.install_block,
      can_uninstall: component.can_uninstall, uninstall_block: component.uninstall_block,
      licence_needed: component.licence !== null && component.licence.accepted_at === null,
      required_by: requiredBy.get(def.id) ?? [], update: modelUpdates.get(def.id) ?? { available: false, version: null },
    };
    if (modelUpdateJob(def.id)) view.state = "updating";
    return [view];
  });
  for (const def of PART_DEFS.filter((row) => row.kind === "engine")) {
    const dependents = runtimeParts.filter((part) => part.requires.includes(def.id));
    const binary = ENGINE_BINARIES.some((pin) => pin.name === def.id);
    const envs = componentDefs().flatMap((unit) => unit.envs).filter((env) => env.name === def.id);
    const ready = binary ? installedEnginePin(def.id) !== null : envs.some((env) => env.ready()) || (!envs.length && dependents.some((part) => componentById.get(part.id)?.state === "installed"));
    const engineUpdate = def.id === "llama-server" ? pendingEngineUpdate(def.id) : null;
    parts.push({ id: def.id, kind: "engine", category: "engines", priority: effectivePriority(def, choices), label: def.label, description: filter.audience === "adult" ? def.description : "", enabled: true, state: ready ? "ready" : "missing", size_bytes: 0, download_bytes: 0, percent: null, fits: { standard: true, boost: true, max: true, reason: null }, can_install: false, install_block: "Installed with the first part that runs on it.", can_uninstall: false, uninstall_block: "Removed with the last part that runs on it.", licence_needed: false, required_by: [...new Set(requiredBy.get(def.id) ?? [])], update: engineUpdate ? { available: true, version: engineUpdate.tag } : { available: false, version: null } });
  }
  if (filter.kind) parts = parts.filter((part) => part.kind === filter.kind);
  if (filter.category !== undefined) parts = parts.filter((part) => part.category === filter.category);
  parts.sort((a, b) => a.category.localeCompare(b.category) || a.priority - b.priority || a.id.localeCompare(b.id));
  return StackPartListSchema.parse({ audience: filter.audience, parts });
}
