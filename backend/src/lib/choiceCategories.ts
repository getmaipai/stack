// The categories of the model choices (docs/dev/choices.md), declared once and light to import: the choices API, the resolver and the
// supervisor all read them, and none of them may pull the other's weight in. A tiered category takes its candidates from the tier table;
// the others name their parts and have one level, Standard.
import type { RoleId } from "@/roles";
import type { TierCategory } from "@/lib/tiers";
import { CATEGORY_IDS, type CategoryId } from "@/lib/choicesSchema";
import type { ChoiceTier } from "@/lib/choicesStore";
import rows from "@/rows/featureRows.json";

export interface CategoryDef {
  id: CategoryId; label: string; role: RoleId | null; partCategory: string; tierCategory?: TierCategory; partIds?: readonly string[]; levels: readonly ChoiceTier[];
  /** A level that is the same choice as the same level of another category (one store, two doors): it offers, resolves, lists and saves exactly what that category does. */
  follows?: Partial<Record<ChoiceTier, CategoryId>>;
  /** Levels that run through coding mode, and the only models coding mode can start there (a pick outside the list is refused). */
  heavyAt?: Partial<Record<ChoiceTier, readonly string[]>>;
  /** True when a model process serves this category (a live load, swap and "answering" state) instead of a job. */
  process?: true;
  /** The household may add its own models to this feature. */
  addedModels?: true;
  /** The older setting that mirrors this feature's Standard pick; `by: "model"` holds a model id, `by: "engine"` names an engine. */
  legacySetting?: { key: string; by: "model" | "engine" };
}
export const CATEGORY_DEFS: readonly CategoryDef[] = rows as unknown as readonly CategoryDef[];
export const defOf = (id: string): CategoryDef | undefined => CATEGORY_DEFS.find((def) => def.id === id);
/** The category a role answers for (the first, so `tts` is voice and `stt` is speech to text). */
export const categoryOfRole = (role: RoleId): CategoryDef | undefined => CATEGORY_DEFS.find((def) => def.role === role);
export const levelName = (tier: ChoiceTier): string => tier[0]!.toUpperCase() + tier.slice(1);
/** Home's words and role ids for a category, so a caller may send either. */
const CATEGORY_ALIASES: Record<string, CategoryId> = { image: "pictures", videos: "video", tts: "voice", embed: "embeddings" };
export function resolveCategoryId(name: string): CategoryId | null {
  const id = CATEGORY_ALIASES[name] ?? name;
  return (CATEGORY_IDS as readonly string[]).includes(id) ? id as CategoryId : null;
}
