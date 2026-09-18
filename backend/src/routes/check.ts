import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema } from "@/lib/openapi";
import { requireClientOrOperator } from "@/lib/clients";
import { requireOperator } from "@/lib/operator";
import { latestCheck, runningCheckState, runCheck } from "@/lib/checkMyStack";
import { showroom, showroomCheck } from "@/showroom/fixture";

const ResultSchema = z.object({ role: z.string(), ok: z.boolean(), ms: z.number().int(), reason: z.string().nullable(), loadMs: z.number().int().nullable(), skipped: z.boolean().optional() });
const CheckSchema = z.object({ at: z.string(), ok: z.boolean(), results: z.array(ResultSchema), fitTogether: z.object({ ok: z.boolean(), reason: z.string().nullable() }), reason: z.string().nullable() });
const LatestSchema = CheckSchema.extend({ state: z.literal("running").optional(), startedAt: z.string().optional() });
const StartedSchema = z.object({ runId: z.string(), state: z.literal("running") }).openapi("CheckStarted");
const checkRoute = createRoute({ method: "post", path: "/", tags: ["Health"], summary: "Check every ready Stack role as a job", middleware: [requireOperator] as const, responses: { 202: { content: { "application/json": { schema: StartedSchema } }, description: "The check is running; check.progress and check.done events follow." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "The check could not run." }, 409: { content: { "application/json": { schema: ErrorSchema } }, description: "A check is already running." } } });
const latestRoute = createRoute({ method: "get", path: "/latest", tags: ["Health"], summary: "Read the last Stack check", middleware: [requireClientOrOperator] as const, responses: { 200: { content: { "application/json": { schema: LatestSchema.nullable() } }, description: "The last completed Stack check; running state when a check is in flight." } } });

export const checkRoutes = apiRouter();
checkRoutes.openapi(checkRoute, async (c) => {
  if (showroom()) return c.json(showroomCheck as never, 202);
  const running = runningCheckState();
  if (running !== null) return c.json({ error: "A check is already running." }, 409);
  const runId = crypto.randomUUID();
  const resultPromise = runCheck({ checkId: runId });
  void resultPromise.then(() => undefined, (error) => { console.error(error); });
  return c.json({ runId, state: "running" as const }, 202);
});
checkRoutes.openapi(latestRoute, (c) => {
  if (showroom()) return c.json(showroomCheck as never, 200);
  const latest = latestCheck();
  const running = runningCheckState();
  if (latest === null) {
    if (running === null) return c.json(null, 200);
    return c.json({ at: running.startedAt, ok: true, results: [], fitTogether: { ok: true, reason: null }, reason: null, state: "running" as const, startedAt: running.startedAt }, 200);
  }
  return c.json({ ...latest, ...(running === null ? {} : { state: "running" as const, startedAt: running.startedAt }) }, 200);
});
