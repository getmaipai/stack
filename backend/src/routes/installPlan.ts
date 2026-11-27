// What to install on this computer, in one call: the shipped pins for
// the proposed tier's resident roles, each shaped as a pull body so the
// first-run wizard posts them to POST /stack/v1/models unchanged.
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { detectHardware } from "@/lib/hardware";
import diskModelRows from "@/rows/diskModelRows.json";
import { IMAGE_FAMILIES, type ImageFamilyId } from "@/images/models";
import { buildInstallPlan, imageInstallModels, restoreInstallModels, talkingPicturesInstallModels, videoInstallModels, splashChatInstallModels } from "@/lib/installPlan";
import { diskPlanForTier } from "@/lib/diskPlan";
import { listModels } from "@/lib/modelStore";
import { modelView } from "@/routes/models";
import { RoleIdSchema } from "@/roles";
import { PROFILE_IDS } from "@/lib/profileIds";

/** The install-plan row that offers a family: the row of rows/diskModelRows.json whose part is the family. */
const diskRowOfFamily = (family: string): string => (diskModelRows as Array<{ id: string; part: string }>).find((row) => row.part === family)?.id ?? "";
/** The picture families the plan route adds when their disk row is offered, in plan order (IMAGE_FAMILIES planOrder). */
const PLAN_FAMILIES = (Object.keys(IMAGE_FAMILIES) as ImageFamilyId[]).filter((family) => IMAGE_FAMILIES[family].planOrder !== null).sort((a, b) => IMAGE_FAMILIES[a].planOrder! - IMAGE_FAMILIES[b].planOrder!);
const PlanModelSchema = z.object({
  id: z.string(), role: RoleIdSchema, repo: z.string().optional(), url: z.string().url(), sha256: z.string().length(64), approx_bytes: z.number().int().nonnegative(), licence: z.string(), revision: z.string(),
  engine: z.string().optional(), archive: z.boolean().optional(), hub_file: z.string().optional(), component: z.string().optional(),
  starter: z.boolean(), installed: z.boolean(),
  removable: z.boolean().optional().openapi({ description: "True for a part the recommended setup installs but an admin may remove later in Settings (the coding model on p64 and p128); absent otherwise." }),
});
const DiskRowSchema = z.object({
  id: z.string(), label: z.string(), note: z.string(), kind: z.enum(["home", "model", "engine"]), need: z.enum(["required", "recommended", "optional"]), selectable: z.boolean(),
  download_bytes: z.number().int().nonnegative(), installed_bytes: z.number().int().nonnegative(), peak_temp_bytes: z.number().int().nonnegative(),
  model_ids: z.array(z.string()), engines: z.array(z.string()), installed: z.boolean(), basis: z.enum(["pins", "measured", "estimate"]),
  minors_only: z.boolean().optional().describe("The row installs a model made for minors only; an adult-only home is never offered it."),
  feature: z.string().nullable().optional().describe("The feature row (id in /choices) this row belongs to; null for Home itself and the shared helpers."),
});
const DiskTotalsSchema = z.object({ download_bytes: z.number().int(), installed_bytes: z.number().int(), peak_temp_bytes: z.number().int(), needed_bytes: z.number().int(), required_free_bytes: z.number().int() });
const DiskPlanSchema = z.object({
  tier: z.enum(PROFILE_IDS), level: z.enum(["minimal", "moderate", "recommended"]), margin_percent: z.number(), headroom_warn_bytes: z.number().int(),
  rows: z.array(DiskRowSchema), default: DiskTotalsSchema, minimum: DiskTotalsSchema, everything: DiskTotalsSchema, measured_on: z.string(), default_selected: z.array(z.string()),
}).openapi({ description: "What each install costs on disk, per component, from the pins' byte counts and a measured table. required_free_bytes is the installed size plus the safety margin plus the peak temporary space: the free space a plan asks for." });
const PlanSchema = z.object({
  level: z.enum(["minimal", "moderate", "recommended"]).nullable(), tier: z.enum(PROFILE_IDS).nullable(), label: z.string(),
  memory_gb: z.number(), memory_source: z.enum(["unified", "graphics", "override", "unknown"]),
  models: z.array(PlanModelSchema), total_bytes: z.number().int(), remaining_bytes: z.number().int(), free_disk_bytes: z.number().int().nullable(), fits_disk: z.boolean().nullable(),
  disk: DiskPlanSchema.nullable(),
  optional_models: z.array(PlanModelSchema).openapi({ description: "The pinned files of the disk plan's picture and video rows (FLUX.2 Klein, ERNIE-Image-Turbo, Z-Image Turbo, Wan2.2 and its tokenizer), shaped as pull bodies, for a wizard that installs a row the person turned on. Not part of `models`: the first-run set." }),
});
const planRoute = createRoute({
  method: "get", path: "/", tags: ["Install plan"], summary: "The models to install on this computer",
  request: { query: z.object({ vram_gb: z.coerce.number().int().min(1).max(512).optional() }) },
  responses: { 200: { content: { "application/json": { schema: PlanSchema } }, description: "The proposed level and tier, the memory they were judged on, and the pinned models (starter first) shaped as pull bodies. With no detectable graphics memory on a computer without unified memory, level is null and memory_source is unknown until the person's total VRAM is passed as vram_gb." } },
});

export const installPlanRoutes = apiRouter<AppEnv>();
installPlanRoutes.openapi(planRoute, async (c) => {
  const { vram_gb: vramGb } = c.req.valid("query");
  const hardware = await detectHardware();
  const installedIds = listModels().map(modelView).filter((model) => model.state === "installed").map((model) => model.id);
  const plan = buildInstallPlan(hardware, { vramOverrideGb: vramGb ?? null, installedIds });
  const disk = plan.tier ? diskPlanForTier(plan.tier, installedIds) : null;
  const rows = new Set(disk?.rows.map((row) => row.id) ?? []);
  const optional = [
    ...PLAN_FAMILIES.filter((family) => rows.has(diskRowOfFamily(family))).flatMap((family) => imageInstallModels(family, installedIds)),
    // A tier whose lineup plans another everyday picture model (p128: FLUX 3 Image Klein) holds it in the required pictures row.
    ...(disk?.rows.find((row) => row.id === "pictures")?.model_ids.includes(IMAGE_FAMILIES["flux3-image-klein"].pins[0]?.id ?? "") ? imageInstallModels("flux3-image-klein", installedIds) : []),
    ...(rows.has("pictures-clearer") ? restoreInstallModels(installedIds) : []),
    ...(rows.has("talking-pictures") ? talkingPicturesInstallModels(installedIds) : []),
    ...(rows.has("video") ? videoInstallModels(installedIds) : []),
    ...(plan.tier ? splashChatInstallModels(installedIds, plan.tier) : []),
  ];
  return c.json({ ...plan, disk, optional_models: optional }, 200);
});
