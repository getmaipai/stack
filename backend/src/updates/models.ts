import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { meta } from "@/db/schema";
import { detectHardware } from "@/lib/hardware";
import { listModels, type CatalogModelLike } from "@/lib/modelStore";
import { proposeProfile } from "@/profiles";
import { check, conditionalHeaders, type UpdateFetcher, updatesEnabled } from "@/updates/check";
import { MODEL_INDEX_URL } from "@/updates/manifests";

const profileIds = ["p16", "p32", "p64", "p128"] as const;
const ModelIndexEntrySchema = z.object({
  id: z.string(), role: z.string(), profile: z.enum(profileIds), quality: z.number().int().nonnegative(),
  repo: z.string().optional(), license: z.string().optional(), revision: z.string(), engine: z.string().optional(),
  download: z.object({ url: z.string().url(), sha256: z.string().length(64), approx_bytes: z.number().int().nonnegative() }),
});
const ModelIndexSchema = z.object({ version: z.string(), models: z.array(ModelIndexEntrySchema) });
export type ModelIndexEntry = z.infer<typeof ModelIndexEntrySchema>;
export type ModelRecommendation = ModelIndexEntry & { sentence: string };
const key = (suffix: string) => `updates.modelIndex.${suffix}`;
const read = (suffix: string) => db.select({ value: meta.value }).from(meta).where(eq(meta.key, key(suffix))).get()?.value ?? null;
const write = (suffix: string, value: string) => db.insert(meta).values({ key: key(suffix), value }).onConflictDoUpdate({ target: meta.key, set: { value } }).run();

export function catalogModelForId(id: string): CatalogModelLike | null {
  const entry = readIndex()?.models.find((model) => model.id === id);
  return entry ? { ...entry, role: entry.role as CatalogModelLike["role"], sizing: { profile: entry.profile, quality: entry.quality } } : null;
}
function readIndex(): z.infer<typeof ModelIndexSchema> | null { const value = read("body"); return value ? ModelIndexSchema.safeParse(JSON.parse(value)).data ?? null : null; }
export async function watchModels(fetcher: UpdateFetcher = fetch) {
  const state = await check("models", fetcher);
  if (!updatesEnabled()) return state;
  const response = await fetcher(MODEL_INDEX_URL, { headers: conditionalHeaders(read("etag")) });
  if (response.status === 304) { write("checked", new Date().toISOString()); return state; }
  if (!response.ok) throw new Error(`Model index check returned ${response.status}`);
  const index = ModelIndexSchema.parse(await response.json());
  write("body", JSON.stringify(index)); write("checked", new Date().toISOString());
  const etag = response.headers.get("etag"); if (etag) write("etag", etag);
  return state;
}
export function recommendationsFor(index: z.infer<typeof ModelIndexSchema>, profileId: string | null, installedQualities: Record<string, number> = {}): ModelRecommendation[] {
  if (!profileId) return [];
  const current = profileIds.indexOf(profileId as typeof profileIds[number]);
  return index.models.filter((model) => profileIds.indexOf(model.profile) <= current && (installedQualities[model.role] === undefined || model.quality > installedQualities[model.role]!)).map((model) => ({ ...model, sentence: installedQualities[model.role] === undefined ? `Add ${model.role} with quality band ${model.quality}.` : `Improve ${model.role} to quality band ${model.quality}.` }));
}
export async function modelRecommendations(): Promise<ModelRecommendation[]> {
  const profile = proposeProfile(await detectHardware());
  const installedQualities: Record<string, number> = {};
  for (const model of listModels()) {
    const sizing = model.engineRequirements.sizing;
    const quality = typeof sizing === "object" && sizing !== null && "quality" in sizing && typeof sizing.quality === "number" ? sizing.quality : 0;
    for (const role of model.roles) installedQualities[role] = Math.max(installedQualities[role] ?? 0, quality);
  }
  return recommendationsFor(readIndex() ?? { version: "", models: [] }, profile?.id ?? null, installedQualities);
}
