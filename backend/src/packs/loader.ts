// MODELPACK-STACK-01: loads and validates every model pack at boot. A pack that does not match `StackModelPack`, that names a part the
// part table does not have, or whose recipe file is missing stops the Stack from starting. This file knows no model: only a pack does (rule E7).
import { StackModelPack } from "@maipai/spec/stack/ts/stack-model-pack.js";
import { PACK_SOURCES } from "@/packs/index.generated";
import { PART_DEFS } from "@/lib/partDefs";

export interface LoadedPack { dir: string; pack: StackModelPack; recipes: Readonly<Record<string, string>> }

export function loadPacks(sources: typeof PACK_SOURCES = PACK_SOURCES, partIds: ReadonlySet<string> = new Set(PART_DEFS.map((p) => p.id))): LoadedPack[] {
  const seen = new Set<string>();
  return sources.map(({ dir, pack, recipes }) => {
    const parsed = StackModelPack.safeParse(pack);
    if (!parsed.success) throw new Error(`Model pack "${dir}" is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. Fix model-pack.json in that folder.`);
    const value = parsed.data;
    if (dir !== value.part) throw new Error(`Model pack folder "${dir}" must be named for its part "${value.part}". Rename the folder.`);
    if (!partIds.has(value.part)) throw new Error(`Model pack "${dir}" names part "${value.part}", which the part table does not have. Add the part or remove the pack.`);
    if (seen.has(value.part)) throw new Error(`Two model packs name part "${value.part}". Keep one.`);
    seen.add(value.part);
    for (const job of value.jobs) {
      if (!(job.recipe in recipes)) throw new Error(`Model pack "${dir}" job "${job.job}" names recipe "${job.recipe}", which is not in the folder. Add the file.`);
    }
    return { dir, pack: value, recipes };
  });
}

let cached: LoadedPack[] | null = null;
/** Every pack, validated once. Calling it at boot is what makes a broken pack stop the Stack. */
export function packs(): readonly LoadedPack[] { return (cached ??= loadPacks()); }
export function packFor(part: string): LoadedPack | null { return packs().find((p) => p.pack.part === part) ?? null; }
export function partsServing(job: StackModelPack["jobs"][number]["job"]): LoadedPack[] { return packs().filter((p) => p.pack.jobs.some((j) => j.job === job)); }
