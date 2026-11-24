// ADMIN-05: applying a profile (the writes behind `POST /stack/v1/profiles/apply`), kept in one place so the choices route
// (`POST /stack/v1/choices/recommended`) applies the recommended setup through the very same code: role enable and priority go through the
// ADMIN-04 settings, audited, and the plan's missing pinned models start as ordinary install jobs.
import type { HardwareInfo } from "@/lib/hardware";
import { PROFILE_TIERS, PROFILE_MODEL_BINDINGS } from "@/profiles";
import { planFor, recommend, type PlannerInput, type ProfileMode, type ProfilePlan } from "@/lib/profilePlanner";
import { writeChoice } from "@/lib/profileChoice";
import { rolePriorityOf, roleDisabledReason, defaultRolePriority } from "@/lib/roleSwitches";
import { updateSettingsAudited } from "@/lib/roleSettingsApply";
import { auditAction, type ActionSource } from "@/lib/adminActions";
import { startModelInstall } from "@/lib/installJobs";
import { plannedPinsFor } from "@/lib/installPlan";
import { DiskRefusalError } from "@/lib/diskState";
import { listModels } from "@/lib/modelStore";
import { STACK_MODELS } from "@/lib/modelCatalog";
import { modelView } from "@/routes/models";
import { ROLE_IDS, type RoleId, PRIMARY_ROLE } from "@/roles";

export interface RoleChoiceInput { role: RoleId; enabled?: boolean; priority?: number }
export interface ApplyInput {
  mode: ProfileMode;
  tier?: "p16" | "p32" | "p64" | "p128";
  vram_gb?: number;
  plan?: { roles: RoleChoiceInput[] };
}
export interface ApplyDeps { probe: () => Promise<HardwareInfo>; install: typeof startModelInstall }
export interface ApplyBodyOut {
  mode: ProfileMode; tier: ProfilePlan["tier"]; plan: ProfilePlan;
  settings: Record<string, boolean | number | string>;
  installs: Array<{ model: string; job: string }>; skipped: Array<{ model: string; reason: string }>;
}
export type ApplyOutcome = { ok: true; body: ApplyBodyOut } | { ok: false; status: 400 | 409; error: string };

export function storedSwitches(): Pick<PlannerInput, "disabled" | "priority"> {
  return { disabled: ROLE_IDS.filter((role) => roleDisabledReason(role) !== null), priority: Object.fromEntries(ROLE_IDS.map((role) => [role, rolePriorityOf(role)])) };
}
export function withChoices(base: Pick<PlannerInput, "disabled" | "priority">, roles: RoleChoiceInput[] | undefined): Pick<PlannerInput, "disabled" | "priority"> {
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

export async function applyProfile(body: ApplyInput, deps: ApplyDeps, source: ActionSource, remote: string): Promise<ApplyOutcome> {
  const hardware = await deps.probe();
  const base: PlannerInput = { hardware, overrideGb: body.vram_gb ?? null };
  const result = recommend(base);
  if (!result.custom_recommended) return { ok: false, status: 409, error: "This computer's memory is below 16 GB, the least the Stack can run chat and voice on. Nothing was changed." };
  const cleared = PROFILE_TIERS.filter((tier) => result.templates.find((row) => row.tier === tier.id)?.cleared);
  const values: Record<string, boolean | number | string> = {};
  let plan: ProfilePlan;
  let tierId: ProfilePlan["tier"];

  if (body.mode === "matched") {
    tierId = body.tier ?? result.matched?.tier ?? result.custom_recommended.plan.tier;
    const tier = PROFILE_TIERS.find((item) => item.id === tierId)!;
    if (!cleared.some((item) => item.id === tier.id)) return { ok: false, status: 409, error: `The ${tier.minUnifiedGb} GB setup needs more memory than this computer has (${result.memory.gb} GB). Choose a smaller setup, or Custom recommended.` };
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
    if (!body.plan) return { ok: false, status: 400, error: "Custom needs the roles you chose: send plan.roles." };
    const switches = withChoices(storedSwitches(), body.plan.roles);
    plan = planFor({ ...base, ...switches }, { upgrade: false })!;
    tierId = plan.tier;
    for (const choice of body.plan.roles) {
      if (choice.enabled !== undefined) values[`stack.roles.${choice.role}.enabled`] = choice.enabled;
      if (choice.priority !== undefined) values[`stack.roles.${choice.role}.priority`] = choice.priority;
    }
  }

  try { await updateSettingsAudited(values, source, remote, "profile.settings"); }
  catch (error) { return { ok: false, status: 400, error: error instanceof Error ? error.message : "Invalid setting" }; }

  // Installs: the tier's first-run models and a bound chat upgrade, only when the person did not hand-pick (Custom picks models on the AI and models screen).
  const installs: Array<{ model: string; job: string }> = [];
  const skipped: Array<{ model: string; reason: string }> = [];
  if (body.mode !== "custom") {
    const installed = new Set(listModels().map(modelView).filter((model) => model.state === "installed").map((model) => model.id));
    const pins = plannedPinsFor(PROFILE_TIERS.find((tier) => tier.id === tierId)!, hardware).map((entry) => entry.pin);
    const upgraded = STACK_MODELS.find((pin) => pin.id === plan.chat_model && pin.role === PRIMARY_ROLE);
    if (upgraded && !pins.some((pin) => pin.id === upgraded.id)) pins.push(upgraded);
    for (const pin of pins) {
      if (installed.has(pin.id)) continue;
      if (!pin.download) { skipped.push({ model: pin.id, reason: "No pinned download is declared for it." }); continue; }
      try { const started = await deps.install(pin as typeof pin & { download: NonNullable<typeof pin.download> }, pin.role); started.done.catch(() => {}); installs.push({ model: pin.id, job: started.job }); }
      catch (error) { skipped.push({ model: pin.id, reason: error instanceof DiskRefusalError ? error.reason : error instanceof Error ? error.message : "The install could not start." }); }
    }
  }

  writeChoice({ mode: body.mode, tier: body.mode === "custom" ? null : tierId, memory_gb: result.memory.gb, at: new Date().toISOString() });
  auditAction("profile.apply", source, remote, { mode: body.mode, tier: tierId, installs: String(installs.length) });
  return { ok: true, body: { mode: body.mode, tier: tierId, plan, settings: values, installs, skipped } };
}
