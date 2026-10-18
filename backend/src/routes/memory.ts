import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { memoryWatchdog } from "@/lib/memoryWatchdog";
import { heavyGate } from "@/lib/heavyGate";

const Level = z.enum(["normal", "warn", "critical"]);
const MemorySchema = z.object({
  watchdog: z.object({ enabled: z.boolean(), level: Level, since: z.string(), reserve_bytes: z.number(), generation_paused: z.boolean() }),
  memory: z.object({ total_bytes: z.number(), available_bytes: z.number(), free_bytes: z.number(), wired_bytes: z.number(), compressor_bytes: z.number(), swap_used_bytes: z.number(), swap_total_bytes: z.number(), swap_growth_bytes_30s: z.number(), pressure_level: z.number(), pressure: z.string(), sampled_at: z.string() }).nullable(),
  stack: z.object({ bytes: z.number(), processes: z.array(z.object({ pid: z.number(), name: z.string(), bytes: z.number() })) }),
  top_consumers: z.array(z.object({ pid: z.number(), name: z.string(), bytes: z.number(), stack: z.boolean() })),
  non_stack_bytes: z.number(),
  isolation: z.object({ enabled: z.boolean(), paused_now: z.number(), interactive_in_flight: z.number(), pauses: z.number(), resumes: z.number(), forced_resumes: z.number(), paused_seconds: z.number() }).openapi({ description: "ISOLATION-01: heavy workers (picture, video, music, image tools) are stopped while a chat or voice request is in flight and continued after it. paused_now is how many are stopped this moment; paused_seconds is the total since the Stack started." }),
  recent_actions: z.array(z.object({ at: z.string(), level: Level, action: z.string(), detail: z.string() })),
  history: z.array(z.object({ at: z.string(), available_bytes: z.number(), swap_used_bytes: z.number(), pressure_level: z.number() })),
});

const route = createRoute({
  method: "get", path: "/", tags: ["Memory"], summary: "The whole computer's memory and what the watchdog is doing about it",
  responses: { 200: { content: { "application/json": { schema: MemorySchema } }, description: "The latest 5-second sample (available, free, wired, compressed memory, swap and its recent growth, the kernel's pressure level), the watchdog's level and reserve, whether picture and video making is paused, the Stack's own processes, the biggest memory users on the computer by name (the Stack's and not), and the watchdog's recent actions. Read only." } },
});

export const memoryRoutes = apiRouter<AppEnv>();
memoryRoutes.openapi(route, (c) => c.json({ ...memoryWatchdog().report(), isolation: heavyGate.status() }, 200));
