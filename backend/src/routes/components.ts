import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@/lib/openapi";
import { requireClientOrOperator } from "@/lib/clients";
import { ComponentCategorySchema, ComponentRowSchema, ComponentStatusSchema, componentsSummary, listComponents } from "@/lib/components";
import { showroom, showroomComponents, showroomComponentsSummary } from "@/showroom/fixture";

const componentsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Components"],
  summary: "Every installed component in one list",
  middleware: [requireClientOrOperator] as const,
  request: { query: z.object({ category: ComponentCategorySchema.optional(), status: ComponentStatusSchema.optional() }) },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ components: z.array(ComponentRowSchema), managed: z.record(ComponentCategorySchema, z.boolean()) }) } },
      description: "Models, runtimes, apps, extensions, and system rows, plus which categories are managed yet.",
    },
  },
});

const summaryRoute = createRoute({
  method: "get",
  path: "/summary",
  tags: ["Components"],
  summary: "Component counts for the Overview cards",
  middleware: [requireClientOrOperator] as const,
  responses: {
    200: {
      content: { "application/json": { schema: z.object({
        installed: z.number(),
        running: z.number(),
        clientsConnected: z.object({ local: z.number(), remote: z.number() }),
        updatesAvailable: z.number(),
        perCategory: z.record(ComponentCategorySchema, z.number()),
      }) } },
      description: "Counts derived from the same component list.",
    },
  },
});

export const componentsRoutes = apiRouter();
componentsRoutes.openapi(componentsRoute, async (c) => {
  const { category, status } = c.req.valid("query");
  const { components, managed } = showroom() ? showroomComponents() : await listComponents();
  const filtered = components.filter((row) => (!category || row.category === category) && (!status || row.status === status));
  return c.json({ components: filtered, managed }, 200);
});
componentsRoutes.openapi(summaryRoute, async (c) => c.json(showroom() ? showroomComponentsSummary() : await componentsSummary(), 200));
