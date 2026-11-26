// Feeds the relationship map (relationships.ts) the Stack's real state: the model pins, the installed LoRAs, what is installed and what is in use.
import { ROLE_IDS } from "@/roles";
import { getModel } from "@/lib/modelStore";
import { loadedRoleForModel, selectedModel } from "@/lib/supervisor";
import { catalogPins } from "@/lib/tidy";
import { listLoras } from "@/video/loras";
import { settingValues } from "@/settings";
import { PART_DEFS, LORA_BASE_MODEL_IDS } from "@/lib/partDefs";
import { impactOf, buildLinks, type Action, type Facts, type Impact, type Link } from "@/lib/relationships";


export function liveFacts(): Facts {
  const pins = catalogPins();
  const selected = new Set(ROLE_IDS.map((role) => selectedModel(role)?.id).filter((id): id is string => !!id));
  const chatModel = settingValues()["stack.engines.chat.model"];
  const labels = new Map(PART_DEFS.map((def) => [def.id, def.label]));
  const hub = new Set(pins.filter((pin) => !!pin.download?.hub_file).map((pin) => pin.id));
  return {
    pins, loras: listLoras().map((lora) => ({ id: lora.id, base_model: lora.base_model })), loraBases: LORA_BASE_MODEL_IDS,
    installed: (id) => !!getModel(id)?.modelPath, inUse: (id) => selected.has(id) || chatModel === id || loadedRoleForModel(id) !== null,
    label: (id) => labels.get(id) ?? id, hubLayout: (id) => hub.has(id),
  };
}
export const liveLinks = (): Link[] => buildLinks(liveFacts());
export function liveImpact(id: string, action: Action): Impact { const facts = liveFacts(); return impactOf(facts, id, action, buildLinks(facts)); }

// ---- The data-folder impact report (GET /stack/v1/choices/unused) ----
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";
import { ownerOfFolder, type Owner } from "@/lib/relationships";

export interface FolderImpact { path: string; bytes: number; owner: Owner | null; label: string; in_use: boolean; used_by: Array<{ id: string; label: string }>; advice: string }
function walkBytes(path: string): number {
  try { const info = lstatSync(path); if (info.isSymbolicLink()) return 0; if (!info.isDirectory()) return info.size; return readdirSync(path).reduce((sum, name) => sum + walkBytes(join(path, name)), 0); } catch { return 0; }
}
/** Every top-level entry of the data folder with its owner, what installed model depends on it, and what removing it would do. `list` and `bytes` are injectable for tests. */
export function folderImpacts(facts: Facts = liveFacts(), list: () => string[] = () => readdirSync(dataDir), bytes: (name: string) => number = (name) => walkBytes(join(dataDir, name))): FolderImpact[] {
  const links = buildLinks(facts);
  return list().sort().map((name) => {
    const row = ownerOfFolder(name);
    const size = bytes(name);
    if (!row) return { path: name, bytes: size, owner: null, label: "The Stack does not know this folder.", in_use: false, used_by: [], advice: "Unknown: check what put it here before removing it." };
    const users = row.owner.kind === "engine" ? links.filter((link) => link.kind === "driven_by" && link.to === row.owner.id && facts.installed(link.from)).map((link) => ({ id: link.from, label: facts.label?.(link.from) ?? link.from })) : [];
    const inUse = row.owner.kind === "engine" ? users.some((user) => facts.inUse(user.id)) : true;
    const advice = row.owner.kind === "engine"
      ? (users.length ? `Owned by the ${row.owner.id} engine; ${users.map((user) => user.label).join(", ")} run${users.length === 1 ? "s" : ""} on it. Remove the engine's models from the engines page, not this folder.` : `Owned by the ${row.owner.id} engine; no installed model runs on it now, so it can be rebuilt or removed.`)
      : `Owned by ${row.owner.kind} "${row.owner.id}". Remove it through the Stack, not by hand.`;
    return { path: name, bytes: size, owner: row.owner, label: row.label, in_use: inUse, used_by: users, advice };
  });
}
