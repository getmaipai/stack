// MODELPACK-STACK-01: loads and validates every model pack at boot. A pack that does not match `StackModelPack`, that names a part the
// part table does not have, or whose recipe file is missing stops the Stack from starting. This file knows no model: only a pack does (rule E7).
import { StackModelPack } from "@maipai/spec/stack/ts/stack-model-pack.js";
import { StackFinishOp } from "@maipai/spec/stack/ts/stack-model-pack.js";
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
      const profileKeys = new Set<string>();
      for (const recipe of job.profiles ?? []) {
        const hasLevel = job.limits.max_seconds?.[recipe.level] !== undefined || Object.values(job.limits.shapes ?? {}).some((shape) => shape?.[recipe.level] !== undefined);
        if (!hasLevel) throw new Error(`Model pack "${dir}" job "${job.job}" profile level "${recipe.level}" is missing from limits. Add its limits.`);
        const key = `${recipe.level}:${recipe.size ? `${recipe.size.width}x${recipe.size.height}` : "default"}:${recipe.adapter?.required ? `adapter ${recipe.adapter.id}` : "no adapter"}`;
        if (profileKeys.has(key)) throw new Error(`Model pack "${dir}" job "${job.job}" has two profiles for ${key}. Keep one.`);
        profileKeys.add(key);
        if (recipe.adapter?.required && !recipe.adapter.id.trim()) throw new Error(`Model pack "${dir}" job "${job.job}" required adapter needs an id.`);
        for (const step of recipe.finish ?? []) if (!StackFinishOp.safeParse(step.op).success) throw new Error(`Model pack "${dir}" job "${job.job}" has unknown finish operation "${step.op}".`);
      }
    }
    return { dir, pack: value, recipes };
  });
}

let cached: LoadedPack[] | null = null;
/** Every pack, validated once. Calling it at boot is what makes a broken pack stop the Stack. */
export function packs(): readonly LoadedPack[] { return (cached ??= loadPacks()); }
export function packFor(part: string): LoadedPack | null { return packs().find((p) => p.pack.part === part) ?? null; }
export function partsServing(job: StackModelPack["jobs"][number]["job"]): LoadedPack[] { return packs().filter((p) => p.pack.jobs.some((j) => j.job === job)); }
/** The optional reference clip rules declared by a serving clip pack. */
export function referenceClipRules(part: string) { return packFor(part)?.pack.jobs.find((job) => job.job === "clip")?.reference_clip ?? null; }
