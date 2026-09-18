import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@/lib/openapi";
import { requireClientOrOperator } from "@/lib/clients";
import { getGovernorStatus } from "@/lib/governor";
import { showroom, showroomBudget } from "@/showroom/fixture";

const BudgetSchema = z.object({
  capBytes: z.number().int(),
  freeMemoryBytes: z.number().int(),
  availablePercent: z.number(),
  pressure: z.enum(["normal", "warn", "critical"]),
  loaded: z.array(z.object({
    id: z.string(),
    kind: z.enum(["resident", "jit", "generator"]),
    peakBytes: z.number().int(),
    measured: z.boolean(),
    lastUsedAt: z.string(),
    idleTtlSeconds: z.number().int(),
    pinned: z.boolean(),
    pid: z.number().int().nullable(),
  })),
  queue: z.array(z.object({ id: z.string(), position: z.number().int(), kind: z.enum(["resident", "jit", "generator"]) })),
});

const budgetRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Hardware"],
  summary: "Current memory governor budget",
  middleware: [requireClientOrOperator] as const,
  responses: { 200: { content: { "application/json": { schema: BudgetSchema } }, description: "Current cap, loaded models, pressure and queue." } },
});

export const budgetRoutes = apiRouter();
budgetRoutes.openapi(budgetRoute, (c) => c.json(showroom() ? showroomBudget : getGovernorStatus(), 200));
