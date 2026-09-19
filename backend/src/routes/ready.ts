import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@/lib/openapi";
import { requireClientOrOperator } from "@/lib/clients";
import { usualChatHour } from "@/lib/series";
import { stackSettingValues } from "@/settings/stackKeys";

const readyRoute = createRoute({ method: "get", path: "/", tags: ["Monitoring"], summary: "Local chat readiness schedule", middleware: [requireClientOrOperator] as const, responses: { 200: { content: { "application/json": { schema: z.object({ warmup: z.object({ hour: z.number().int(), minute: z.number().int(), days: z.number().int(), requests: z.number().int() }).nullable() }) } }, description: "The optional local warm-up inferred from this Stack's usage records." } } });

export const readyRoutes = apiRouter();
readyRoutes.openapi(readyRoute, (c) => {
  if (stackSettingValues().chatWarmupEnabled !== true) return c.json({ warmup: null }, 200);
  const usual = usualChatHour();
  return c.json({ warmup: usual ? { ...usual, minute: (usual.hour * 60 - 10 + 24 * 60) % (24 * 60) } : null }, 200);
});
