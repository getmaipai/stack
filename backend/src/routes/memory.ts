import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { memoryWatchdog } from "@/lib/memoryWatchdog";
import { heavyGate } from "@/lib/heavyGate";
import { listReclaimable, runReclaim } from "@/lib/reclaim";

const Level = z.enum(["normal", "warn", "critical"]);
const MemorySchema = z.object({
  watchdog: z.object({ enabled: z.boolean(), level: Level, since: z.string(), reserve_bytes: z.number(), generation_paused: z.boolean(), chat_paged_out: z.boolean() }),
  ledger: z.object({ reserved_bytes: z.number(), warm_bytes: z.number(), burst_bytes: z.number(), budget_bytes: z.number(), working_margin_bytes: z.number(), free_bytes: z.number(), queue_depth: z.object({ reserved: z.number(), warm: z.number(), burst: z.number() }), chat_paged_out: z.boolean() }),
  memory: z.object({ total_bytes: z.number(), available_bytes: z.number(), free_bytes: z.number(), wired_bytes: z.number(), compressor_bytes: z.number(), swap_used_bytes: z.number(), swap_total_bytes: z.number(), swap_growth_bytes_30s: z.number(), pressure_level: z.number(), pressure: z.string(), sampled_at: z.string() }).nullable(),
  stack: z.object({ bytes: z.number(), processes: z.array(z.object({ pid: z.number(), name: z.string(), bytes: z.number() })) }),
  dev_load: z.object({ others_bytes: z.number(), processes: z.array(z.object({ name: z.string(), bytes: z.number() })) }).openapi({ description: "MEM-SPACE-05: what other programs hold beside the Stack. `processes` names the big ones (name and bytes only) and is empty when nothing is flagged." }),
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

const ReclaimItem = z.object({ id: z.string(), kind: z.enum(["reserved", "warm", "burst"]), bytes: z.number() });
const reclaimListRoute = createRoute({
  method: "get", path: "/reclaim", tags: ["Memory"], summary: "What the Stack could unload right now to make space (MEM-SPACE-03)",
  description: "Idle items the Stack loaded itself, in the order they would go: finished burst workers first, then idle warm models. Never chat, never an item in use, never a process the Stack does not own. A warm item is listed only after 2 minutes idle; the bytes still inside that grace are in `held_for_grace_bytes`. Ids and byte counts only.",
  responses: { 200: { content: { "application/json": { schema: z.object({ items: z.array(ReclaimItem), total_bytes: z.number(), held_for_grace_bytes: z.number() }) } }, description: "The items that could go now." } },
});
const reclaimRunRoute = createRoute({
  method: "post", path: "/reclaim", tags: ["Memory"], summary: "Unload the idle items to make space (MEM-SPACE-04)",
  description: "Unloads what `GET /reclaim` lists, one at a time. An item that became busy stays loaded and is not counted. A second call while one is running unloads nothing.",
  responses: { 200: { content: { "application/json": { schema: z.object({ unloaded: z.number(), freed_bytes: z.number() }) } }, description: "How many items were unloaded and the memory they held." } },
});
memoryRoutes.openapi(reclaimListRoute, async (c) => c.json(await listReclaimable(), 200));
memoryRoutes.openapi(reclaimRunRoute, async (c) => c.json(await runReclaim(), 200));
