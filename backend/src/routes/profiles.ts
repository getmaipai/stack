// ADMIN-05: choose what this computer runs. `recommend` reads the machine and the person's role switches and answers Matched, Custom
// recommended and the shipped templates; `apply` writes the role enable and priority settings (the same ones as ADMIN-04, audited like
// every admin action) and starts the pinned installs the plan lacks as ordinary model install jobs. Home and the admin page both call these
// and never choose a tier themselves.
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { detectHardware, type HardwareInfo } from "@/lib/hardware";
import { PROFILE_TIERS, PROFILE_MODEL_BINDINGS } from "@/profiles";
import { planFor, recommend, type PlannerInput, type ProfileMode, type ProfilePlan } from "@/lib/profilePlanner";
import { clearChoiceForTests, readChoice, replanNeeded, writeChoice } from "@/lib/profileChoice";
import { rolePriorityOf, roleDisabledReason, ROLE_PRIORITY_MAX, ROLE_PRIORITY_MIN, defaultRolePriority } from "@/lib/roleSwitches";
import { updateSettingsAudited } from "@/lib/roleSettingsApply";
import { remoteOf, sourceOf } from "@/lib/adminActions";
import { startModelInstall } from "@/lib/installJobs";
import { plannedPinsFor } from "@/lib/installPlan";
import { DiskRefusalError } from "@/lib/diskState";
import { listModels } from "@/lib/modelStore";
import { STACK_MODELS } from "@/lib/modelCatalog";
import { modelView } from "@/routes/models";
import { ROLE_IDS, RoleIdSchema, type RoleId } from "@/roles";
import { auditAction } from "@/lib/adminActions";

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
const RecommendBody = z.object({ vram_gb: z.number().int().min(1).max(512).optional(), roles: z.array(RoleChoice).optional().describe("Overrides the stored role switches for this question only (for the Features screen's live budget bar).") });
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

function storedSwitches(): Pick<PlannerInput, "disabled" | "priority"> {
  return { disabled: ROLE_IDS.filter((role) => roleDisabledReason(role) !== null), priority: Object.fromEntries(ROLE_IDS.map((role) => [role, rolePriorityOf(role)])) };
}
function withChoices(base: Pick<PlannerInput, "disabled" | "priority">, roles: Array<z.infer<typeof RoleChoice>> | undefined): Pick<PlannerInput, "disabled" | "priority"> {
  if (!roles) return base;
  const disabled = new Set<RoleId>(base.disabled ?? []);
  const priority = { ...base.priority };
  for (const choice of roles) {
    if (choice.enabled === true) disabled.delete(choice.role);
    if (choice.enabled === false) disabled.add(choice.role);
    if (choice.priority !== undefined) priority[choice.role] = choice.priority;
  }
  return { disabled, priority };
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
  const body = c.req.valid("json");
  const hardware = await profileDeps.probe();
  const base: PlannerInput = { hardware, overrideGb: body.vram_gb ?? null };
  const result = recommend(base);
  if (!result.custom_recommended) return c.json({ error: "This computer's memory is below 16 GB, the least the Stack can run chat and voice on. Nothing was changed." }, 409);
  const cleared = PROFILE_TIERS.filter((tier) => result.templates.find((row) => row.tier === tier.id)?.cleared);
  const values: Record<string, boolean | number | string> = {};
  let plan: ProfilePlan;
  let tierId: ProfilePlan["tier"];

  if (body.mode === "matched") {
    tierId = body.tier ?? result.matched?.tier ?? result.custom_recommended.plan.tier;
    const tier = PROFILE_TIERS.find((item) => item.id === tierId)!;
    if (!cleared.some((item) => item.id === tier.id)) return c.json({ error: `The ${tier.minUnifiedGb} GB setup needs more memory than this computer has (${result.memory.gb} GB). Choose a smaller setup, or Custom recommended.` }, 409);
    // The tier's own plan, judged on this computer with every role on.
    plan = planFor(base, { upgrade: false, tier: tier.id })!;
    for (const role of ROLE_IDS) {
      if (tier.notAvailable.includes(role)) continue;
      values[`stack.roles.${role}.enabled`] = true;
      values[`stack.roles.${role}.priority`] = defaultRolePriority(role);
    }
    values["stack.engines.chat.model"] = "";
    // The plan shown is the tier's own: judged on this computer with every template role on.
    plan = { ...plan, tier: tier.id };
  } else if (body.mode === "custom_recommended") {
    plan = planFor({ ...base, ...storedSwitches() })!;
    tierId = plan.tier;
    for (const role of plan.roles) {
      if (role.state === "unavailable") continue;
      values[`stack.roles.${role.role}.enabled`] = role.state !== "off";
      values[`stack.roles.${role.role}.priority`] = role.priority;
    }
    values["stack.engines.chat.model"] = plan.chat_model === PROFILE_MODEL_BINDINGS[plan.tier]?.chat ? "" : plan.chat_model;
  } else {
    if (!body.plan) return c.json({ error: "Custom needs the roles you chose: send plan.roles." }, 400);
    const switches = withChoices(storedSwitches(), body.plan.roles);
    plan = planFor({ ...base, ...switches }, { upgrade: false })!;
    tierId = plan.tier;
    for (const choice of body.plan.roles) {
      if (choice.enabled !== undefined) values[`stack.roles.${choice.role}.enabled`] = choice.enabled;
      if (choice.priority !== undefined) values[`stack.roles.${choice.role}.priority`] = choice.priority;
    }
  }

  try { await updateSettingsAudited(values, sourceOf(c), remoteOf(c), "profile.settings"); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : "Invalid setting" }, 400); }

  // Installs: the tier's first-run models and a bound chat upgrade, only when the person did not hand-pick (Custom picks models on the Models screen).
  const installs: Array<{ model: string; job: string }> = [];
  const skipped: Array<{ model: string; reason: string }> = [];
  if (body.mode !== "custom") {
    const installed = new Set(listModels().map(modelView).filter((model) => model.state === "installed").map((model) => model.id));
    const pins = plannedPinsFor(PROFILE_TIERS.find((tier) => tier.id === tierId)!, hardware).map((entry) => entry.pin);
    const upgraded = STACK_MODELS.find((pin) => pin.id === plan.chat_model && pin.role === "chat");
    if (upgraded && !pins.some((pin) => pin.id === upgraded.id)) pins.push(upgraded);
    for (const pin of pins) {
      if (installed.has(pin.id)) continue;
      if (!pin.download) { skipped.push({ model: pin.id, reason: "No pinned download is declared for it." }); continue; }
      try { const started = await profileDeps.install(pin as typeof pin & { download: NonNullable<typeof pin.download> }, pin.role); started.done.catch(() => {}); installs.push({ model: pin.id, job: started.job }); }
      catch (error) { skipped.push({ model: pin.id, reason: error instanceof DiskRefusalError ? error.reason : error instanceof Error ? error.message : "The install could not start." }); }
    }
  }

  writeChoice({ mode: body.mode as ProfileMode, tier: body.mode === "custom" ? null : tierId, memory_gb: result.memory.gb, at: new Date().toISOString() });
  auditAction("profile.apply", sourceOf(c), remoteOf(c), { mode: body.mode, tier: tierId, installs: String(installs.length) });
  return c.json({ mode: body.mode, tier: tierId, plan, settings: values, installs, skipped }, 200);
});
