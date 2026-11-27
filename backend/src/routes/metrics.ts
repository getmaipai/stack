import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { resourceHistory } from "@/lib/resourceHistory";
import { renderGauges } from "@/lib/prometheusText";
import { ROLE_IDS } from "@/roles";
import { adminCookie } from "@/lib/adminGuard";
import { validateSession } from "@/lib/adminAuth";
import { homeViewToken } from "@/lib/adultView";
import { timingSafeEqual } from "node:crypto";

const metricsRoute = createRoute({
  method: "get", path: "/", tags: ["Resources"], summary: "Current resource gauges in Prometheus text format",
  responses: {
    200: { content: { "text/plain": { schema: z.string() } }, description: "Prometheus text exposition format 0.0.4. Read only; current sampled values only." },
    401: { content: { "text/plain": { schema: z.string() } }, description: "Home token or admin session required." },
  },
});

export const metricsRoutes = apiRouter<AppEnv>();
metricsRoutes.openapi(metricsRoute, async (c) => {
  // Loopback GETs are otherwise intentionally open for ordinary Home reads;
  // metrics are an admin surface and require either Home's token or a session.
  const presentedHomeToken = c.req.header("x-maipai-home-token")?.trim();
  let homeAuthenticated = false;
  if (presentedHomeToken) {
    try {
      const expected = Buffer.from(homeViewToken());
      const presented = Buffer.from(presentedHomeToken);
      homeAuthenticated = presented.length === expected.length && timingSafeEqual(presented, expected);
    } catch { /* no token file means no Home authentication */ }
  }
  const sessionToken = adminCookie(c.req.raw);
  const adminAuthenticated = sessionToken ? await validateSession(sessionToken) : false;
  if (!homeAuthenticated && !adminAuthenticated) return c.text("Authentication required.\n", 401);
  const { current } = resourceHistory().summary();
  const samples = (value: number | null) => [{ value }];
  const roleSamples = ROLE_IDS.filter((role) => current?.roles && Object.hasOwn(current.roles, role)).map((role) => ({ labels: { role }, value: current!.roles![role]! }));
  const text = renderGauges([
    { name: "maipai_stack_memory_total_bytes", help: "Total system memory in bytes.", samples: samples(current?.total ?? null) },
    { name: "maipai_stack_memory_used_bytes", help: "Used system memory in bytes.", samples: samples(current?.used ?? null) },
    { name: "maipai_stack_memory_free_bytes", help: "Available system memory in bytes.", samples: samples(current?.avail ?? null) },
    { name: "maipai_stack_swap_used_bytes", help: "Used swap memory in bytes.", samples: samples(current?.swap ?? null) },
    { name: "maipai_stack_cpu_percent", help: "Whole-machine CPU usage percent.", samples: samples(current?.cpu ?? null) },
    { name: "maipai_stack_queue_depth", help: "Requests waiting in the admission queue.", samples: samples(current?.queue ?? null) },
    { name: "maipai_stack_role_held_bytes", help: "Bytes held by each engine role.", samples: roleSamples },
  ]);
  return c.text(text, 200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
});
