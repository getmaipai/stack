import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@/lib/openapi";
import { requireClientOrOperator } from "@/lib/clients";
import { requireOperator } from "@/lib/operator";
import { getRunState, setRunState, type RunState } from "@/lib/governor";
import { restartChatEngine, stopChatEngine } from "@/lib/supervisor";

const stateSchema = z.object({ state: z.enum(["running", "pausing", "paused"]) });
const getRoute = createRoute({ method: "get", path: "/", tags: ["Runtime"], summary: "Read the Stack run state", middleware: [requireClientOrOperator] as const, responses: { 200: { content: { "application/json": { schema: stateSchema } }, description: "Current run state." } } });
const setRoute = createRoute({ method: "post", path: "/", tags: ["Runtime"], summary: "Pause or resume the Stack", middleware: [requireOperator] as const, request: { body: { content: { "application/json": { schema: z.object({ state: z.enum(["running", "paused"]) }) } } } }, responses: { 200: { content: { "application/json": { schema: stateSchema } }, description: "Updated run state." } } });

export const runStateRoutes = apiRouter();
runStateRoutes.openapi(getRoute, (c) => c.json({ state: getRunState() }, 200));
runStateRoutes.openapi(setRoute, async (c) => {
  const state = c.req.valid("json").state as RunState;
  if (state === "paused") {
    setRunState("pausing");
    await stopChatEngine();
    setRunState("paused");
  } else {
    await restartChatEngine();
    setRunState("running");
  }
  return c.json({ state: getRunState() }, 200);
});
