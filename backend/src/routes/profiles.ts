// ADMIN-05: choose what this computer runs. `recommend` reads the machine and the person's role switches and answers Matched, Custom
// recommended and the shipped templates; `apply` writes the role enable and priority settings (the same ones as ADMIN-04, audited like
// every admin action) and starts the pinned installs the plan lacks as ordinary model install jobs. Home and the admin page both call these
// and never choose a tier themselves.
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { detectHardware, type HardwareInfo } from "@/lib/hardware";
import { recommend } from "@/lib/profilePlanner";
import { applyProfile, storedSwitches, withChoices } from "@/lib/profileApply";
import { clearChoiceForTests, readChoice, replanNeeded } from "@/lib/profileChoice";
import { ROLE_PRIORITY_MAX, ROLE_PRIORITY_MIN } from "@/lib/roleSwitches";
import { remoteOf, sourceOf } from "@/lib/adminActions";
import { startModelInstall } from "@/lib/installJobs";
import { RoleIdSchema } from "@/roles";

const TierId = z.enum(["p16", "p32", "p64", "p128"]);
const Mode = z.enum(["matched", "custom_recommended", "custom"]);
const RoleChoice = z.object({ role: RoleIdSchema, enabled: z.boolean().optional(), priority: z.number().int().min(ROLE_PRIORITY_MIN).max(ROLE_PRIORITY_MAX).optional() });

const PlanRoleSchema = z.object({
  role: RoleIdSchema, enabled: z.boolean(), priority: z.number().int(),
  state: z.enum(["resident", "on_demand", "installed", "shared", "off", "unavailable"]),
  model: z.string().nullable(), peak_bytes: z.number().nullable(), basis: z.enum(["measured", "estimated"]).nullable(),
  slot: z.enum(["standard", "boost", "max"]).nullable(), fit: z.enum(["fits", "queues", "refused", "n/a"]), reason: z.string(),
});
const PlanSchema = z.object({
  tier: TierId, chat_model: z.string(),
  budget: z.object({ total_bytes: z.number(), os_reserve_bytes: z.number(), working_margin_bytes: z.number(), resident_cap_bytes: z.number(), resident_bytes: z.number(), room_bytes: z.number(), tight: z.boolean() }),
  roles: z.array(PlanRoleSchema), notes: z.array(z.string()),
});
const SavedSchema = z.object({ mode: Mode, tier: z.string().nullable(), memory_gb: z.number(), at: z.string() });
const RecommendationSchema = z.object({
  memory: z.object({ gb: z.number(), source: z.enum(["unified", "graphics", "override", "unknown"]), bytes: z.number() }),
  matched: z.object({ tier: TierId, quality: z.literal("good"), reason: z.string() }).nullable().describe("A shipped tier within 25 percent above its floor (p16 up to 24 GB), else null."),
  custom_recommended: z.object({ plan: PlanSchema, why: z.array(z.string()) }).nullable().describe("The plan computed for this exact memory; null when the memory clears no tier."),
  templates: z.array(z.object({ tier: TierId, label: z.string(), min_gb: z.number(), cleared: z.boolean(), match: z.boolean(), resident: z.array(RoleIdSchema), on_demand: z.array(RoleIdSchema), not_available: z.array(RoleIdSchema) })),
  saved: SavedSchema.nullable(),
  replan: z.object({ needed: z.boolean(), reason: z.string().nullable() }),
});
const RecommendBody = z.object({ vram_gb: z.number().int().min(1).max(512).optional(), roles: z.array(RoleChoice).optional().describe("Overrides the stored role switches for this question only (for a live budget preview before a switch is saved).") });
const ApplyBody = z.object({
  mode: Mode, tier: TierId.optional().describe("Matched only: the template to apply; defaults to the matched tier."),
  vram_gb: z.number().int().min(1).max(512).optional(),
  plan: z.object({ roles: z.array(RoleChoice) }).optional().describe("Custom only: the roles the person chose by hand."),
});
const ApplyResponse = z.object({
  mode: Mode, tier: TierId, plan: PlanSchema,
  settings: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])).describe("Every setting written."),
  installs: z.array(z.object({ model: z.string(), job: z.string() })), skipped: z.array(z.object({ model: z.string(), reason: z.string() })),
});

const recommendRoute = createRoute({
  method: "post", path: "/recommend", tags: ["Profiles"], summary: "Matched, Custom recommended and the templates for this computer (ADMIN-05)",
  description: "Send `{}` for the defaults. Pure of side effects: reads the hardware and the role switches, writes nothing. `custom_recommended` is computed by a deterministic planner: the measured memory budget (memory less the OS reserve), role priority, each pinned model's footprint (flagged `estimated` until measured), then the resident set, upgrades while they leave headroom, and the largest on-demand generator slot that still fits. Each role says `state`, `fit` (`fits`, `queues`, `refused`) and why. `replan` says when the saved Matched or Custom recommended choice was made on different memory.",
  request: { body: { required: true, content: { "application/json": { schema: RecommendBody } } } },
  responses: { 200: { content: { "application/json": { schema: RecommendationSchema } }, description: "The recommendation." } },
});
const applyRoute = createRoute({
  method: "post", path: "/apply", tags: ["Profiles"], summary: "Apply a profile: write role settings and start the missing installs (ADMIN-05)",
  description: "`matched` applies a shipped tier (default: the matched one), `custom_recommended` re-plans now and applies that, `custom` applies the roles the person chose and judges them with the same fit check. Role enable and priority go through the ADMIN-04 settings and are audited (`admin.action.profile.apply`); a role the computer cannot run is left as it was. The choice and its memory are saved so a later change of memory asks before re-planning. Models the plan needs that are not installed start as ordinary install jobs (`installs`); one that cannot (disk) is listed in `skipped` with the reason.",
  request: { body: { required: true, content: { "application/json": { schema: ApplyBody } } } },
  responses: {
    200: { content: { "application/json": { schema: ApplyResponse } }, description: "Applied." },
    400: { content: { "application/json": { schema: ErrorSchema } }, description: "A custom plan is missing, or a setting value is invalid." },
    409: { content: { "application/json": { schema: ErrorSchema } }, description: "This computer's memory clears no tier, or the asked tier is above this computer." },
  },
});

/** Seams a test replaces: the hardware probe and the install starter. */
export const profileDeps: { probe: () => Promise<HardwareInfo>; install: typeof startModelInstall } = { probe: detectHardware, install: startModelInstall };
export function __setProfileDepsForTests(next: Partial<typeof profileDeps> | null): void {
  profileDeps.probe = next?.probe ?? detectHardware;
  profileDeps.install = next?.install ?? startModelInstall;
  if (!next) clearChoiceForTests();
}

export const profilesRoutes = apiRouter<AppEnv>();
profilesRoutes.openapi(recommendRoute, async (c) => {
  const body = c.req.valid("json");
  const hardware = await profileDeps.probe();
  const result = recommend({ hardware, overrideGb: body.vram_gb ?? null, ...withChoices(storedSwitches(), body.roles) });
  const saved = readChoice();
  return c.json({ ...result, saved, replan: replanNeeded(saved, result.memory.gb) }, 200);
});

profilesRoutes.openapi(applyRoute, async (c) => {
  const outcome = await applyProfile(c.req.valid("json"), profileDeps, sourceOf(c), remoteOf(c));
  return outcome.ok ? c.json(outcome.body, 200) : c.json({ error: outcome.error }, outcome.status);
});
