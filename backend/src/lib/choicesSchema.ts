// The wire shapes of the choices API (docs/dev/choices.md), declared once: the routes use the schemas, choices.ts uses the inferred types.
import { z } from "@hono/zod-openapi";
import { CHOICE_PROFILES, CHOICE_TIERS } from "@/lib/choicesStore";
import featureRows from "@/rows/featureRows.json";

/** Feature ids, from rows/featureRows.json. */
export const CATEGORY_IDS = featureRows.map((row) => row.id) as [string, ...string[]];
export type CategoryId = string;
/** The features that have tier candidates (a `tierCategory`), the values of the tiers routes' `category`. */
export const TIER_CATEGORY_IDS = featureRows.flatMap((row) => ("tierCategory" in row && row.tierCategory ? [row.tierCategory as string] : [])) as [string, ...string[]];
/** The groups the components list is split into: every tiered feature plus the tools and the loras. */
export const COMPONENT_GROUPS = [...TIER_CATEGORY_IDS, "tools", "loras"] as [string, ...string[]];
/** Capability rows: the name the capabilities route uses for a feature (its `capability` value, or its id when it is `true`) and the feature's tier category. */
export const CAPABILITY_CATEGORIES = featureRows.flatMap((row) => {
  const flag = (row as { capability?: true | string }).capability;
  return flag ? [[flag === true ? row.id : flag, (row as { tierCategory?: string }).tierCategory ?? row.id] as const] : [];
});

export const TierName = z.enum(CHOICE_TIERS).openapi("ChoiceLevel");
export const ProfileName = z.enum(CHOICE_PROFILES).openapi("ChoiceProfile");
export const OptionsValue = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
export const ErrorBody = z.object({ error: z.string(), code: z.string() }).openapi("ChoicesError");

export const CandidateState = z.enum(["installed", "installing", "notInstalled", "failed", "unsupported"]);
export const CandidateSchema = z.object({
  id: z.string(), label: z.string().min(1).describe("The model's plain name."), summary: z.string().min(1).describe("One plain sentence: what it is good for and its limits."),
  family: z.string().nullable(), version: z.string().nullable().describe("The model version as people say it (for example 3.8); null when its name carries none."),
  quantization: z.string().nullable().describe("The precision in plain words (for example `4-bit, compact`)."), quantization_raw: z.string().nullable().describe("The catalog's own tag (for example `UD-IQ4_XS`)."),
  license: z.string().nullable(), repo: z.string().nullable(), engine: z.string().nullable().describe("The engine that runs it."), role: z.string().nullable().describe("The role it serves."),
  min_profile: z.string().nullable().describe("The smallest computer it is offered on, in plain words."), min_profile_id: ProfileName.nullable(),
  search_text: z.string().describe("Lowercase text for searching: label, id, repo, family, version, quantization (plain and raw), licence, summary, engine and role joined by spaces."),
  kind: z.enum(["shipped", "added"]).describe("`added` is a chat model an admin added by link."),
  pickable: z.boolean().describe("False for a part that is ordered, switched off or removed here but never chosen for a level (still being checked)."),
  state: CandidateState, reason: z.string().nullable().describe("The plain sentence for the state, or null when it is installed and fine."),
  size_bytes: z.number().int().nonnegative().describe("The model's size: on disk when installed, else what installing it downloads."), download_bytes: z.number().int().nonnegative().describe("What an install would still download; 0 when installed."),
  peak_bytes: z.number().int().nonnegative().nullable(), peak_verified: z.boolean().nullable(), percent: z.number().nullable(),
  can_install: z.boolean(), can_uninstall: z.boolean(), licence_needed: z.boolean(),
  enabled: z.boolean().describe("False when it is on the category's off list."), rank: z.number().int().min(1).describe("Position in the category's order (1 is tried first)."),
}).openapi("ChoiceCandidate");
export type Candidate = z.infer<typeof CandidateSchema>;

export const LevelOptionSchema = z.object({ model: z.string(), fits: z.boolean(), refusal: z.string().nullable() });
export const TierRowSchema = z.object({
  tier: TierName, cap_bytes: z.number().nullable().describe("What this level may use on this computer, in bytes; null where no cap applies (Reduced, single-model categories)."),
  chosen: z.string().nullable().describe("The model this level uses: the household's pick, else the recommended one. Null when the level is off or nothing fits."),
  chosen_by: z.enum(["household", "recommended", "off", "none"]),
  chosen_state: CandidateState.nullable(),
  customization: OptionsValue.nullable().describe("The options stored with the household's pick (for example `thinking`); null when none."),
  problem: z.string().nullable().describe("A plain sentence when the saved pick is not offered here any more or no longer fits; the recommended model runs meanwhile."),
  options: z.array(LevelOptionSchema).describe("Every model that may be offered at this level, with whether it fits and the plain reason when it does not."),
  recommended: z.object({ model: z.string().nullable(), why: z.string() }),
  running: z.object({
    active: z.boolean().describe("True when this level is the one in use now: chat is Standard unless Reduced or coding mode (Max) is on; a picture, video or music level is always live."),
    model: z.string().nullable().describe("The model answering this level, or the one the next request starts; null when this level is not in use or nothing is installed."),
    answering: z.boolean().describe("True when `chosen` is the model answering. False while a chosen model waits to be installed, does not fit, or starts at the next restart; `reason` says which."),
    reason: z.string().nullable().describe("The plain sentence for why the chosen model is not answering yet, or null."),
  }).describe("What answers for this level, from the same code the role view uses, so the two never disagree."),
}).openapi("ChoiceLevelRow");
export type TierRow = z.infer<typeof TierRowSchema>;

export const RequiresEntrySchema = z.object({
  id: z.string(), kind: z.enum(["engine", "draft"]).describe("`engine` is an engine a candidate runs on; `draft` is a companion model a candidate needs alongside it."),
  label: z.string(), state: CandidateState, reason: z.string().nullable().describe("The plain sentence for the state, or null when it is installed and fine."),
  size_bytes: z.number().int().nonnegative().describe("On disk when installed, else what installing it downloads."),
  can_install: z.boolean(), can_uninstall: z.boolean(),
  needed_by: z.array(z.string()).describe("The candidate ids of this category that use it."),
}).openapi("ChoiceRequires");
export type RequiresEntry = z.infer<typeof RequiresEntrySchema>;

export const ProfileAssignmentSchema = z.object({
  profile: ProfileName, memory_gb: z.number(), current: z.boolean().describe("True for this computer's own profile."),
  assignments: z.array(z.object({ tier: TierName, model: z.string(), customization: OptionsValue.nullable() })),
});
export const RolePlanSchema = z.object({ state: z.string(), fit: z.string(), reason: z.string() });

export const CategorySchema = z.object({
  id: z.enum(CATEGORY_IDS), label: z.string(), icon: z.string(), description: z.string(),
  role: z.string().nullable(), role_enabled: z.boolean().nullable(), role_priority: z.number().int().nullable(),
  role_plan: RolePlanSchema.nullable().describe("What the profile planner says about this category's role on this computer (state, fit, reason)."),
  steps: z.array(z.object({ id: z.enum(["installed", "loaded", "ready"]), label: z.string(), status: z.enum(["done", "current", "waiting", "failed"]), reason: z.string().nullable() })).describe("Readiness of the feature in order; empty when the category has no role."),
  requires: z.array(RequiresEntrySchema).describe("The engines and drafts this category's candidates need, with the candidate ids using each; sorted engine first, then by id."),
  available: z.boolean(), unavailable_reason: z.string().nullable(),
  tiered: z.boolean().describe("False for single-model categories, which have only the `standard` level."),
  order: z.array(z.string()).describe("Every candidate id, tried first to last."), disabled: z.array(z.string()),
  candidates: z.array(CandidateSchema), tiers: z.array(TierRowSchema), profiles: z.array(ProfileAssignmentSchema),
}).openapi("ChoiceCategory");
export type Category = z.infer<typeof CategorySchema>;

export const UnusedItemSchema = z.object({ id: z.string(), label: z.string(), category: z.enum(CATEGORY_IDS), kind: z.enum(["shipped", "added"]), size_bytes: z.number().int().nonnegative(), reason: z.string() });
export type UnusedItem = z.infer<typeof UnusedItemSchema>;
export const UnusedSummarySchema = z.object({ count: z.number().int(), total_bytes: z.number().int() });

export const MigrationStateSchema = z.object({ done: z.boolean(), done_at: z.string().nullable(), accepted: z.number().int(), refused: z.number().int() });

export const ChoicesViewSchema = z.object({
  profile: ProfileName.nullable().describe("This computer's profile; null when its memory is below 16 GB."),
  memory_gb: z.number(), room_bytes: z.number(), free_disk_bytes: z.number(),
  categories: z.array(CategorySchema), unused: UnusedSummarySchema, migration: MigrationStateSchema,
}).openapi("ChoicesView");
export type ChoicesView = z.infer<typeof ChoicesViewSchema>;

export const PickBody = z.object({
  model: z.string().min(1).max(200).describe("A model id from the category's candidates, `recommended` (clear the pick), or `off` (switch the level off; not for Standard)."),
  options: OptionsValue.optional().describe("Customization stored with the pick, for example `{ \"thinking\": true }`. Keys must be options the model's builds declare."),
  profile: ProfileName.optional().describe("The hardware profile this assignment is for; omitted means this computer's own profile."),
  install: z.boolean().default(true).describe("Start the download when the model is not installed (this computer's profile only). False stores the pick without downloading."),
});
export const PickResult = z.object({
  ok: z.literal(true), category: z.enum(CATEGORY_IDS), tier: TierName, profile: ProfileName, model: z.string().nullable().describe("The model that answers at this level now: the stored pick, or the resolved recommended model after a pick of recommended; null when the level has none."), changed: z.boolean(),
  applied: z.boolean().describe("True when the Stack changed a setting so the pick takes effect (voice engine, chat model)."), pending_restart: z.boolean(),
  install_job: z.string().nullable(), note: z.string().nullable(),
}).openapi("ChoicePickResult");

export const OrderBody = z.object({ order: z.array(z.string().min(1).max(200)).max(60).describe("Candidate ids, tried first to last. Candidates left out keep their default place after these."), off: z.array(z.string().min(1).max(200)).max(60).optional().describe("The candidates switched off. Omitted leaves the off list as it is.") });
export const OrderResult = z.object({ ok: z.literal(true), category: z.enum(CATEGORY_IDS), order: z.array(z.string()), disabled: z.array(z.string()) });

export const RecommendedBody = z.object({ dry_run: z.boolean().default(false).describe("Answer what would change and write nothing."), household_has_minors: z.boolean().default(false).describe("WAN-DEFAULT-01: the household has a child or teen. The parts made for minors only (the silent video model) are then installed too; for an adult-only home they are never listed or started. An installed copy is never removed.") });
export const ChangeSchema = z.object({ category: z.enum(CATEGORY_IDS), tier: TierName, from: z.string().nullable(), to: z.string() });
export const RecommendedResult = z.object({
  dry_run: z.boolean(), changed: z.array(ChangeSchema), unchanged: z.number().int(),
  roles: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])).describe("The role settings written (empty on a dry run), as `profiles/apply` writes them."),
  installs: z.array(z.object({ model: z.string(), job: z.string() })), skipped: z.array(z.object({ model: z.string(), reason: z.string() })),
  needs_licence: z.array(z.object({ id: z.string(), label: z.string() })),
}).openapi("ChoicesRecommendedResult");

export const UnusedListSchema = z.object({
  items: z.array(UnusedItemSchema), total_bytes: z.number().int(),
  folders: z.array(z.object({
    path: z.string(), bytes: z.number().int().nonnegative(), label: z.string(), in_use: z.boolean(), advice: z.string(),
    owner: z.object({ kind: z.enum(["engine", "engines", "models", "feature", "stack"]), id: z.string() }).nullable().describe("Who owns the folder; null when the Stack does not know it (for example `splash` is the Splash engine's)."),
    used_by: z.array(z.object({ id: z.string(), label: z.string() })).describe("Installed models that run on the owner engine; removing the folder would hurt them."),
  })).describe("Every top-level folder of the Stack's data with its owner and what depends on it."),
  tidy: z.object({ reclaimable_bytes: z.number().int(), items: z.array(z.object({ id: z.string(), kind: z.enum(["superseded", "orphan_folder", "partial_download"]), bytes: z.number().int(), reason: z.string(), blocked: z.string().nullable() })) }),
}).openapi("ChoicesUnused");
export const RemoveBody = z.object({ ids: z.array(z.string().min(1).max(200)).max(20).default([]), tidy: z.boolean().default(false).describe("Also run the Stack's tidy of replaced and abandoned files.") });
export const RemoveResult = z.object({
  results: z.array(z.object({ id: z.string(), status: z.enum(["removed", "kept", "failed"]), freed_bytes: z.number().int(), message: z.string() })),
  tidy_removed: z.array(z.object({ id: z.string(), bytes: z.number().int() })), freed_bytes: z.number().int(), kept: z.number().int(), failed: z.number().int(),
}).openapi("ChoicesRemoveResult");

export const AddModelBody = z.object({
  source: z.string().trim().min(1).max(500).describe("A huggingface.co link or `owner/repo`."), file: z.string().trim().min(1).max(300).optional().describe("The .gguf file when the repository has more than one."),
  category: z.literal("chat").default("chat"), tier: TierName.default("standard"), use: z.boolean().default(true).describe("Select the model for the category and level now."),
});
export const AddModelResult = z.object({
  ok: z.literal(true), id: z.string(), label: z.string(), category: z.literal("chat"), tier: TierName, chosen: z.boolean(), state: CandidateState,
  install_job: z.string().nullable(), size_bytes: z.number().int(), licence: z.string(),
}).openapi("ChoicesAddModelResult");

export const MigrateBody = z.object({
  dry_run: z.boolean().default(false),
  slots: z.array(z.object({ role: z.string().min(1).max(40), tier: TierName, model: z.string().min(1).max(200), options: OptionsValue.optional() })).max(80).default([]).describe("Home's `engines.<role>.tier.<tier>.model`. `role` is a Stack category id or role (`image`, `tts`, `videos` are accepted)."),
  orders: z.array(z.object({ category: z.string().min(1).max(40), order: z.array(z.string().min(1).max(200)).max(60) })).max(20).default([]).describe("Home's `engines.<category>.order`."),
  features: z.array(z.object({ role: z.string().min(1).max(40), enabled: z.boolean() })).max(20).default([]).describe("Home's feature switches, already as on or off (Home inverts `chat.paused` itself)."),
  added_models: z.array(z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).max(120), label: z.string().min(1).max(200), repo: z.string().min(1).max(300), file: z.string().min(1).max(400), url: z.string().url().max(1000), revision: z.string().min(1).max(100),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), size_bytes: z.number().int().positive(), licence: z.string().max(200).nullable().default(null), architecture: z.string().max(100).default("unknown"), verified: z.boolean().default(false), ram_bytes: z.number().int().nonnegative().default(0),
  })).max(40).default([]).describe("Home's added chat model records."),
});
export const MigratedValue = z.object({ kind: z.enum(["slot", "order", "feature", "added_model"]), key: z.string(), status: z.enum(["accepted", "unchanged", "refused"]), reason: z.string().nullable() });
export const MigrateResult = z.object({
  dry_run: z.boolean(), already_done: z.boolean().describe("True when the migration was done before: nothing was read or written."),
  results: z.array(MigratedValue), accepted: z.number().int(), refused: z.array(MigratedValue).describe("The values the Stack refused; Home keeps them and shows the reason."),
  done_at: z.string().nullable(),
}).openapi("ChoicesMigrateResult");
