import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { warmUp, warmupStatus } from "@/lib/warmup";

const RoleSchema = z.object({ role: z.string(), state: z.enum(["pending", "warming", "warm", "skipped", "failed"]), reason: z.string().nullable(), ms: z.number().int().nullable() });
const WarmupSchema = z.object({ state: z.enum(["idle", "warming", "ready"]), startedAt: z.string().nullable(), finishedAt: z.string().nullable(), trigger: z.string().nullable(), roles: z.array(RoleSchema) });
const getRoute = createRoute({ method: "get", path: "/", tags: ["Warm-up"], summary: "The keep-warm state", responses: { 200: { content: { "application/json": { schema: WarmupSchema } }, description: "Whether the roles a first chat needs are loaded and primed, and which ones were left on-demand and why." } } });
const postRoute = createRoute({ method: "post", path: "/", tags: ["Warm-up"], summary: "Warm the roles a first chat needs now", responses: { 202: { content: { "application/json": { schema: WarmupSchema } }, description: "A warm-up is running (started now, or already under way); poll GET for the end." } } });

export const warmupRoutes = apiRouter<AppEnv>();
warmupRoutes.openapi(getRoute, (c) => c.json(warmupStatus(), 200));
warmupRoutes.openapi(postRoute, (c) => {
  void warmUp("home-request").catch(() => {});
  return c.json(warmupStatus(), 202);
});
