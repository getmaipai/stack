import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { latestCheck, runCheck, runningCheck } from "@/lib/readiness";

const RoleResultSchema = z.object({ role: z.string(), ok: z.boolean(), ms: z.number().int(), reason: z.string().nullable(), loadMs: z.number().int().nullable(), skipped: z.boolean().optional() });
const CheckRunSchema = z.object({ at: z.string(), ok: z.boolean(), results: z.array(RoleResultSchema), fitTogether: z.object({ ok: z.boolean(), reason: z.string().nullable() }), reason: z.string().nullable() });
const runRoute = createRoute({ method: "post", path: "/", tags: ["Readiness"], summary: "Run the readiness check now", responses: { 200: { content: { "application/json": { schema: CheckRunSchema } }, description: "Every installed role probed through the public route, then the fit-together pass." } } });
const latestRoute = createRoute({ method: "get", path: "/latest", tags: ["Readiness"], summary: "The last readiness run", responses: { 200: { content: { "application/json": { schema: z.object({ latest: CheckRunSchema.nullable(), running: z.object({ startedAt: z.string() }).nullable() }) } }, description: "The last recorded run and whether one is in progress." } } });

export const checkRoutes = apiRouter<AppEnv>();
checkRoutes.openapi(runRoute, async (c) => c.json(await runCheck(), 200));
checkRoutes.openapi(latestRoute, (c) => c.json({ latest: latestCheck(), running: runningCheck() }, 200));
