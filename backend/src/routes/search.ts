// The web search service the Stack runs for Home (STACK-DDGS-01): where
// the ddgs sidecar listens and whether it is healthy. Home reads this
// instead of being told an address by hand. The Stack does not carry
// searches: Home calls the returned loopback address itself.
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { ddgsSupervisor } from "@/search/ddgsSidecar";

const StatusSchema = z.object({
  state: z.enum(["unsupported", "disabled", "building", "starting", "ready", "failed"]).openapi({ description: "ready means the service answered its health check; building and starting are temporary; failed has a retry waiting and a health item with the reason." }),
  url: z.string().nullable().openapi({ description: "The loopback address of the DuckDuckGo search service, set only while it is ready." }),
  phase: z.string().nullable(),
  reason: z.string().nullable(),
  restarts: z.number().int(),
  library: z.object({ name: z.literal("ddgs"), version: z.string() }),
});
const getRoute = createRoute({ method: "get", path: "/", tags: ["Search"], summary: "The DuckDuckGo search service's address and health", responses: { 200: { content: { "application/json": { schema: z.object({ ddgs: StatusSchema }) } }, description: "The ddgs service the Stack builds, starts and restarts. Additive: Home reads it to know DuckDuckGo search is ready." } } });
const retryRoute = createRoute({ method: "post", path: "/retry", tags: ["Search"], summary: "Try the search service's build or start again now", responses: { 202: { content: { "application/json": { schema: z.object({ ddgs: StatusSchema }) } }, description: "A waiting retry was cut short; poll GET for the result." } } });

export const searchRoutes = apiRouter<AppEnv>();
searchRoutes.openapi(getRoute, (c) => c.json({ ddgs: ddgsSupervisor.get() }, 200));
searchRoutes.openapi(retryRoute, (c) => { ddgsSupervisor.retryNow(); return c.json({ ddgs: ddgsSupervisor.get() }, 202); });
