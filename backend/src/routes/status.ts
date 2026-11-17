import { createRoute } from "@hono/zod-openapi";
import { StackStatus } from "@maipai/spec/stack/ts/stack-status.js";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { stackStatus } from "@/lib/stackStatus";

const statusRoute = createRoute({ method: "get", path: "/", tags: ["Status"], summary: "One status read: health, busy, memory, jobs and problems with a fix each (STACK-STATUS-01)", responses: { 200: { content: { "application/json": { schema: StackStatus } }, description: "health is updating while an engine update runs and down only when the chat engine is stopped. Every problem has a plain cause and a fix. Composed from the health list, job list, governor and memory watchdog; starts no work." } } });
export const statusRoutes = apiRouter<AppEnv>();
statusRoutes.openapi(statusRoute, async (c) => c.json(await stackStatus(), 200));
