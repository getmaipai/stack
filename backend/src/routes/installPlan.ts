// What to install on this computer, in one call: the shipped pins for
// the proposed tier's resident roles, each shaped as a pull body so the
// first-run wizard posts them to POST /stack/v1/models unchanged.
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { detectHardware } from "@/lib/hardware";
import { buildInstallPlan, imageInstallModels, videoInstallModels } from "@/lib/installPlan";
import { diskPlanForTier } from "@/lib/diskPlan";
import { listModels } from "@/lib/modelStore";
import { modelView } from "@/routes/models";
import { RoleIdSchema } from "@/roles";

const PlanModelSchema = z.object({
  id: z.string(), role: RoleIdSchema, repo: z.string().optional(), url: z.string().url(), sha256: z.string().length(64), approx_bytes: z.number().int().nonnegative(), licence: z.string(), revision: z.string(),
  engine: z.string().optional(), archive: z.boolean().optional(), hub_file: z.string().optional(), component: z.string().optional(),
  starter: z.boolean(), installed: z.boolean(),
});
const DiskRowSchema = z.object({
  id: z.string(), label: z.string(), note: z.string(), kind: z.enum(["home", "model", "engine"]), need: z.enum(["required", "recommended", "optional"]), selectable: z.boolean(),
  download_bytes: z.number().int().nonnegative(), installed_bytes: z.number().int().nonnegative(), peak_temp_bytes: z.number().int().nonnegative(),
  model_ids: z.array(z.string()), engines: z.array(z.string()), installed: z.boolean(), basis: z.enum(["pins", "measured", "estimate"]),
});
const DiskTotalsSchema = z.object({ download_bytes: z.number().int(), installed_bytes: z.number().int(), peak_temp_bytes: z.number().int(), needed_bytes: z.number().int(), required_free_bytes: z.number().int() });
const DiskPlanSchema = z.object({
  tier: z.enum(["p16", "p32", "p64", "p128"]), level: z.enum(["minimal", "moderate", "recommended"]), margin_percent: z.number(), headroom_warn_bytes: z.number().int(),
  rows: z.array(DiskRowSchema), default: DiskTotalsSchema, minimum: DiskTotalsSchema, everything: DiskTotalsSchema, measured_on: z.string(), default_selected: z.array(z.string()),
}).openapi({ description: "What each install costs on disk, per component, from the pins' byte counts and a measured table. required_free_bytes is the installed size plus the safety margin plus the peak temporary space: the free space a plan asks for." });
const PlanSchema = z.object({
  level: z.enum(["minimal", "moderate", "recommended"]).nullable(), tier: z.enum(["p16", "p32", "p64", "p128"]).nullable(), label: z.string(),
  memory_gb: z.number(), memory_source: z.enum(["unified", "graphics", "override", "unknown"]),
  models: z.array(PlanModelSchema), total_bytes: z.number().int(), remaining_bytes: z.number().int(), free_disk_bytes: z.number().int().nullable(), fits_disk: z.boolean().nullable(),
  disk: DiskPlanSchema.nullable(),
  optional_models: z.array(PlanModelSchema).openapi({ description: "The pinned files of the disk plan's picture and video rows (FLUX.2 Klein, Z-Image Turbo, Wan2.2 and its tokenizer), shaped as pull bodies, for a wizard that installs a row the person turned on. Not part of `models`: the first-run set." }),
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
    ...(rows.has("pictures") ? imageInstallModels("flux2-klein-4b", installedIds) : []),
    ...(rows.has("pictures-zimage") ? imageInstallModels("z-image-turbo", installedIds) : []),
    ...(rows.has("video") ? videoInstallModels(installedIds) : []),
  ];
  return c.json({ ...plan, disk, optional_models: optional }, 200);
});
