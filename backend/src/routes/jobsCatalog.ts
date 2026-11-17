import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import { StackJobsCatalog } from "@maipai/spec/stack/ts/stack-jobs-catalog.js";
import type { AppEnv } from "@/types";
import { jobsCatalog } from "@/lib/jobsCatalog";

const route = createRoute({
  method: "get", path: "/", tags: ["Jobs"], summary: "What can be made here, now: the eight generic jobs for one audience (MODELPACK-JOBS-01)",
  description: "A view over the model packs, the parts list and the household's order. It starts nothing. The adult catalog lists every job with `available`, the part that would serve it, its limits, `why_not` and `alternatives`; the minor catalog lists only the jobs a part in the minor's list serves, with neutral labels and no reason and no alternative (rule C10). A minor's candidates are ordered by the shipped priority, never by the household's order (rule E6). Home reads capabilities and limits here and never a second readiness: readiness stays in the parts list and the role health.",
  request: { query: z.object({ audience: z.enum(["adult", "minor"]) }) },
  responses: { 200: { content: { "application/json": { schema: StackJobsCatalog } }, description: "The jobs catalog for the audience." } },
});
export const jobsCatalogRoutes = apiRouter<AppEnv>();
jobsCatalogRoutes.openapi(route, async (c) => c.json(await jobsCatalog(c.req.valid("query").audience), 200) as never);
