import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema } from "@/lib/openapi";
import { requireOperator } from "@/lib/operator";
import { chooseSetupPlan, getSetupPlan, pauseSetupDownload, resumeSetupDownload } from "@/lib/setupPlan";

const PlanRequestSchema = z.object({ tier: z.enum(["p16", "p32", "p64", "p128"]), mode: z.enum(["small", "full"]) });
const DownloadSchema = z.object({
  id: z.string(), name: z.string(), sizeBytes: z.number().int(), completedBytes: z.number().int(),
  speedBytesPerSecond: z.number().int(), timeLeftSeconds: z.number().int().nullable(),
  status: z.enum(["queued", "downloading", "paused", "installed", "failed"]), source: z.string(), licence: z.string(), reason: z.string().optional(),
});
const PlanResponseSchema = z.object({
  plan: z.object({ tier: z.enum(["p16", "p32", "p64", "p128"]), mode: z.enum(["small", "full"]), createdAt: z.string(), health: z.string().nullable() }).nullable(),
  downloads: z.array(DownloadSchema), health: z.string().nullable(),
});
const QueueResponseSchema = PlanResponseSchema.extend({ queued: z.literal(true) });
const DownloadParamSchema = z.object({ id: z.string() });

const getRoute = createRoute({ method: "get", path: "/", tags: ["Setup"], summary: "Current ability plan and downloads", middleware: [requireOperator] as const, responses: { 200: { content: { "application/json": { schema: PlanResponseSchema } }, description: "The selected plan and honest download status." } } });
const postRoute = createRoute({ method: "post", path: "/", tags: ["Setup"], summary: "Choose the first ability plan", middleware: [requireOperator] as const, request: { body: { content: { "application/json": { schema: PlanRequestSchema } } } }, responses: { 202: { content: { "application/json": { schema: QueueResponseSchema } }, description: "The plan was recorded and downloads queued." }, 401: { content: { "application/json": { schema: ErrorSchema } }, description: "Operator authentication required." } } });
const actionRoute = (path: "/{id}/pause" | "/{id}/resume") => createRoute({ method: "post", path, tags: ["Setup"], summary: "Pause or resume a setup download", middleware: [requireOperator] as const, request: { params: DownloadParamSchema }, responses: { 200: { content: { "application/json": { schema: DownloadSchema } }, description: "Updated download." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown download." } } });

export const setupPlanRoutes = apiRouter();
setupPlanRoutes.openapi(getRoute, (c) => c.json(getSetupPlan(), 200));
setupPlanRoutes.openapi(postRoute, (c) => c.json(chooseSetupPlan(c.req.valid("json").tier, c.req.valid("json").mode), 202));
setupPlanRoutes.openapi(actionRoute("/{id}/pause"), (c) => {
  const item = pauseSetupDownload(c.req.valid("param").id);
  return item ? c.json(item, 200) : c.json({ error: "Unknown download" }, 404);
});
setupPlanRoutes.openapi(actionRoute("/{id}/resume"), (c) => {
  const item = resumeSetupDownload(c.req.valid("param").id);
  return item ? c.json(item, 200) : c.json({ error: "Unknown download" }, 404);
});
