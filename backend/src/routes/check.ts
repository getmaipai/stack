import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema } from "@/lib/openapi";
import { requireClientOrOperator } from "@/lib/clients";
import { requireOperator } from "@/lib/operator";
import { latestCheck, runCheck } from "@/lib/checkMyStack";
import { showroom, showroomCheck } from "@/showroom/fixture";

const ResultSchema = z.object({ role: z.string(), ok: z.boolean(), ms: z.number().int(), reason: z.string().nullable(), loadMs: z.number().int().nullable(), skipped: z.boolean().optional() });
const CheckSchema = z.object({ at: z.string(), ok: z.boolean(), results: z.array(ResultSchema), fitTogether: z.object({ ok: z.boolean(), reason: z.string().nullable() }), reason: z.string().nullable() });
const checkRoute = createRoute({ method: "post", path: "/", tags: ["Health"], summary: "Check every ready Stack role", middleware: [requireOperator] as const, responses: { 200: { content: { "application/json": { schema: CheckSchema } }, description: "The completed Stack check." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "The check could not run." } } });
const latestRoute = createRoute({ method: "get", path: "/latest", tags: ["Health"], summary: "Read the last Stack check", middleware: [requireClientOrOperator] as const, responses: { 200: { content: { "application/json": { schema: CheckSchema.nullable() } }, description: "The last completed Stack check, if any." } } });

export const checkRoutes = apiRouter();
checkRoutes.openapi(checkRoute, async (c) => {
  if (showroom()) return c.json(showroomCheck as never, 200);
  try { return c.json(await runCheck() as never, 200); } catch (error) { return c.json({ error: error instanceof Error ? error.message : "The Stack check failed." }, 400); }
});
checkRoutes.openapi(latestRoute, (c) => c.json((showroom() ? showroomCheck : latestCheck()) as never, 200));
