// What to install on this computer, in one call: the shipped pins for
// the proposed tier's resident roles, each shaped as a pull body so the
// first-run wizard posts them to POST /stack/v1/models unchanged.
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { detectHardware } from "@/lib/hardware";
import { buildInstallPlan } from "@/lib/installPlan";
import { listModels } from "@/lib/modelStore";
import { modelView } from "@/routes/models";
import { RoleIdSchema } from "@/roles";

const PlanModelSchema = z.object({
  id: z.string(), role: RoleIdSchema, repo: z.string().optional(), url: z.string().url(), sha256: z.string().length(64), approx_bytes: z.number().int().nonnegative(), licence: z.string(), revision: z.string(),
  engine: z.string().optional(), archive: z.boolean().optional(), hub_file: z.string().optional(), component: z.string().optional(),
  starter: z.boolean(), installed: z.boolean(),
});
const PlanSchema = z.object({
  level: z.enum(["minimal", "moderate", "recommended"]).nullable(), tier: z.enum(["p16", "p32", "p64", "p128"]).nullable(), label: z.string(),
  memory_gb: z.number(), memory_source: z.enum(["unified", "graphics", "override", "unknown"]),
  models: z.array(PlanModelSchema), total_bytes: z.number().int(), remaining_bytes: z.number().int(), free_disk_bytes: z.number().int().nullable(), fits_disk: z.boolean().nullable(),
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
  return c.json(buildInstallPlan(hardware, { vramOverrideGb: vramGb ?? null, installedIds }), 200);
});
