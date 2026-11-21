import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { resourceHistory } from "@/lib/resourceHistory";

const Nullable = z.number().nullable();
const PointSchema = z.object({
  t: z.number().openapi({ description: "Start of the sample or bucket, milliseconds since the epoch." }),
  n: z.number().openapi({ description: "How many 5-second samples this point averages." }),
  total: z.number(), avail: z.number(), wired: z.number(), compressed: z.number(), swap: z.number(),
  pressure: z.number().openapi({ description: "Kernel pressure level, worst in the bucket: 1 normal, 2 warn, 4 critical." }),
  used: z.number().openapi({ description: "Total minus available memory, mean." }), used_max: z.number(),
  stack: z.number().openapi({ description: "Bytes held by the Stack's processes, mean." }), stack_max: z.number(),
  other: z.number().openapi({ description: "Bytes held by everything outside the Stack." }),
  procs: z.record(z.string(), z.number()).openapi({ description: "Stack bytes by process name." }),
  cpu: Nullable.openapi({ description: "Whole-machine CPU percent, mean; null before the second sample." }), cpu_max: Nullable,
  stack_cpu: Nullable.openapi({ description: "CPU percent of the whole machine used by the Stack's own process; engine children are not counted." }), stack_cpu_max: Nullable,
  gpu: Nullable.openapi({ description: "GPU utilisation percent; null where the OS gives no cheap figure (macOS today)." }),
  disk: Nullable.openapi({ description: "Bytes used by models and engines." }),
  tps: z.record(z.string(), z.number()).nullable().openapi({ description: "Tokens per second by role; null until a role keeps a counter." }),
  queue: z.number().openapi({ description: "Requests waiting in the admission queue." }),
});
const Roles = z.array(z.object({ id: z.string(), color_key: z.string().openapi({ description: "A stable palette slot (series-1 to series-8) for this name." }) }));

const historyRoute = createRoute({
  method: "get", path: "/history", tags: ["Resources"], summary: "Memory, CPU and queue history for charts",
  request: { query: z.object({
    range: z.enum(["1h", "24h", "7d", "30d"]).default("1h"),
    step: z.union([z.literal("auto"), z.coerce.number().int().min(5)]).default("auto").openapi({ description: "Bucket size in seconds, or auto. The Stack raises it when the range would exceed 600 points." }),
  }) },
  responses: { 200: { content: { "application/json": { schema: z.object({ range: z.enum(["1h", "24h", "7d", "30d"]), step_seconds: z.number(), points: z.array(PointSchema), roles: Roles }) } }, description: "At most 600 points, oldest first. Raw 5 s samples for 24 h, 1 minute means for 7 days, 1 hour means for 30 days. Read only." } },
});
const summaryRoute = createRoute({
  method: "get", path: "/summary", tags: ["Resources"], summary: "Current resource numbers with last-hour peak and mean",
  responses: { 200: { content: { "application/json": { schema: z.object({
    sampled_at: z.string().nullable(),
    current: PointSchema.nullable(),
    last_hour: z.object({ memory_used_peak_bytes: z.number(), memory_used_mean_bytes: z.number(), cpu_peak: Nullable, cpu_mean: Nullable, queue_peak: z.number(), samples: z.number() }),
    roles: z.array(z.object({ id: z.string(), color_key: z.string(), current_bytes: z.number(), peak_bytes: z.number(), mean_bytes: z.number() })),
  }) } }, description: "For the admin Overview cards. Read only." } },
});

export const resourcesRoutes = apiRouter<AppEnv>();
resourcesRoutes.openapi(historyRoute, (c) => { const q = c.req.valid("query"); return c.json(resourceHistory().query(q.range, q.step), 200); });
resourcesRoutes.openapi(summaryRoute, (c) => c.json(resourceHistory().summary(), 200));
