// The household's model choices, stored once by the Stack (owner decision 2026-11-21; docs/dev/choices.md). Three values live in the same
// `meta` key/value table the settings and the part order already use, so there is no new database:
//   choices.picks      the model picked per hardware profile, category and level (Reduced, Standard, Boost, Max)
//   choices.added      the models an admin added by link (record only; the file is a normal installed model)
//   choices.migration  the one-time import of Home's old values, marked done
// The order of models and the list switched off stay in `parts.choices` (partChoices.ts); role on/off and priority stay in the
// settings (`stack.roles.<role>.enabled`, `.priority`). This module never reads those: choices.ts joins them.
import { PRIMARY_ROLE } from "@/roles";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { meta } from "@/db/schema";
import { PROFILE_IDS } from "@/lib/profileIds";

export const CHOICE_TIERS = ["reduced", "standard", "boost", "max"] as const;
export type ChoiceTier = typeof CHOICE_TIERS[number];
export const CHOICE_PROFILES = PROFILE_IDS;
export type ChoiceProfile = string;

const OptionValue = z.union([z.string(), z.number(), z.boolean()]);
export const PickSchema = z.object({ model: z.string().min(1).max(200), options: z.record(z.string(), OptionValue).optional() }).strict();
export type Pick = z.infer<typeof PickSchema>;
const LevelPicks = z.partialRecord(z.enum(CHOICE_TIERS), PickSchema);
const PicksSchema = z.partialRecord(z.enum(CHOICE_PROFILES), z.record(z.string(), LevelPicks));
export type Picks = z.infer<typeof PicksSchema>;

export const AddedModelSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).max(120),
  label: z.string().min(1).max(200),
  category: z.literal(PRIMARY_ROLE),
  repo: z.string().min(1).max(300), file: z.string().min(1).max(400), url: z.string().url().max(1000), revision: z.string().min(1).max(100),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), size_bytes: z.number().int().positive(),
  licence: z.string().max(200).nullable(), architecture: z.string().max(100), verified: z.boolean(), ram_bytes: z.number().int().nonnegative(),
  added_at: z.string(), added_by: z.string().max(60),
}).strict();
export type AddedModel = z.infer<typeof AddedModelSchema>;
const AddedSchema = z.record(z.string(), AddedModelSchema);

export const MigrationSchema = z.object({ done_at: z.string(), accepted: z.number().int().nonnegative(), refused: z.number().int().nonnegative() }).strict();
export type Migration = z.infer<typeof MigrationSchema>;

const PICKS_KEY = "choices.picks";
const ADDED_KEY = "choices.added";
const MIGRATION_KEY = "choices.migration";

function readJson<T>(key: string, schema: z.ZodType<T>, empty: T): T {
  const value = db.select().from(meta).where(eq(meta.key, key)).get()?.value;
  if (!value) return empty;
  try { const parsed = schema.safeParse(JSON.parse(value)); return parsed.success ? parsed.data : empty; } catch { return empty; }
}
function writeJson(key: string, schema: z.ZodType<unknown>, value: unknown): void {
  const text = JSON.stringify(schema.parse(value));
  db.insert(meta).values({ key, value: text }).onConflictDoUpdate({ target: meta.key, set: { value: text } }).run();
}

export const readPicks = (): Picks => readJson(PICKS_KEY, PicksSchema, {});
export const writePicks = (picks: Picks): void => writeJson(PICKS_KEY, PicksSchema, picks);
export const readAddedModels = (): Record<string, AddedModel> => readJson(ADDED_KEY, AddedSchema, {});
export const writeAddedModels = (added: Record<string, AddedModel>): void => writeJson(ADDED_KEY, AddedSchema, added);
export const readMigration = (): Migration | null => readJson<Migration | null>(MIGRATION_KEY, MigrationSchema.nullable(), null);
export const writeMigration = (migration: Migration): void => writeJson(MIGRATION_KEY, MigrationSchema, migration);

export function pickFor(picks: Picks, profile: ChoiceProfile, category: string, tier: ChoiceTier): Pick | null { return picks[profile]?.[category]?.[tier] ?? null; }

/** A new object with one pick set (or cleared with null); empty levels, categories and profiles are dropped so the stored value stays small. */
export function withPick(picks: Picks, profile: ChoiceProfile, category: string, tier: ChoiceTier, pick: Pick | null): Picks {
  const next: Picks = structuredClone(picks);
  const profileRow = (next[profile] ??= {});
  const categoryRow = (profileRow[category] ??= {});
  if (pick) categoryRow[tier] = pick; else delete categoryRow[tier];
  if (Object.keys(categoryRow).length === 0) delete profileRow[category];
  if (Object.keys(profileRow).length === 0) delete next[profile];
  return next;
}

/** Drops every pick that names a removed added model (a removed model must not stay chosen). */
export function dropPicksFor(picks: Picks, modelId: string): Picks {
  let next = picks;
  for (const profile of CHOICE_PROFILES) for (const [category, levels] of Object.entries(picks[profile] ?? {})) for (const tier of CHOICE_TIERS) {
    if (levels[tier]?.model === modelId) next = withPick(next, profile, category, tier, null);
  }
  return next;
}

export function __resetChoicesForTests(): void { for (const key of [PICKS_KEY, ADDED_KEY, MIGRATION_KEY]) db.delete(meta).where(eq(meta.key, key)).run(); }
