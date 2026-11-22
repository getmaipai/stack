// The categories of the model choices (docs/dev/choices.md), declared once and light to import: the choices API, the resolver and the
// supervisor all read them, and none of them may pull the other's weight in. A tiered category takes its candidates from the tier table;
// the others name their parts and have one level, Standard.
import type { RoleId } from "@/roles";
import type { TierCategory } from "@/lib/tiers";
import { CATEGORY_IDS, type CategoryId } from "@/lib/choicesSchema";
import type { ChoiceTier } from "@/lib/choicesStore";

export interface CategoryDef {
  id: CategoryId; label: string; role: RoleId | null; partCategory: string; tierCategory?: TierCategory; partIds?: readonly string[]; levels: readonly ChoiceTier[];
}
const STANDARD_ONLY: readonly ChoiceTier[] = ["standard"];
export const CATEGORY_DEFS: readonly CategoryDef[] = [
  { id: "chat", label: "Chat", role: "chat", partCategory: "chat", tierCategory: "chat", levels: ["reduced", "standard", "boost", "max"] },
  { id: "coding", label: "Coding", role: "coding", partCategory: "coding", partIds: ["qwen3.8-27b-ud-q4-k-m"], levels: STANDARD_ONLY },
  { id: "pictures", label: "Pictures", role: "image", partCategory: "pictures", tierCategory: "pictures", levels: ["standard", "boost", "max"] },
  { id: "video", label: "Video", role: "video", partCategory: "video", tierCategory: "video", levels: ["standard", "boost", "max"] },
  { id: "music", label: "Music", role: "music", partCategory: "music", tierCategory: "music", levels: ["standard", "boost", "max"] },
  { id: "voice", label: "Voice", role: "tts", partCategory: "voice", tierCategory: "voice", levels: ["reduced", "standard"] },
  { id: "stt", label: "Speech to text", role: "stt", partCategory: "voice", partIds: ["moonshine-tiny-en-int8", "parakeet-tdt-0.6b-v2-int8"], levels: STANDARD_ONLY },
  { id: "embeddings", label: "Embeddings", role: "embed", partCategory: "search", partIds: ["nomic-embed-text-v1-5-q4-k-m"], levels: STANDARD_ONLY },
  { id: "vision", label: "Vision", role: "vision", partCategory: "vision", partIds: ["qwen3-vl-4b-instruct-q4-k-m", "qwen3-vl-8b-instruct-q4-k-m"], levels: STANDARD_ONLY },
  { id: "wakeword", label: "Wake word", role: "wakeword", partCategory: "voice", partIds: ["wakeword"], levels: STANDARD_ONLY },
  { id: "stems", label: "Stem splitter", role: null, partCategory: "stems", tierCategory: "stems", levels: STANDARD_ONLY },
];
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
