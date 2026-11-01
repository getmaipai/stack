import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { memoryWatchdog } from "@/lib/memoryWatchdog";
import { heavyGate } from "@/lib/heavyGate";
import { listReclaimable, runReclaim } from "@/lib/reclaim";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";
import { isReducedChat } from "@/lib/reducedChatLease";
import { getMaxWindow } from "@/lib/governor";
import { dailyResources } from "@/lib/dailyResources";

const Level = z.enum(["normal", "warn", "critical"]);
const MemorySchema = z.object({
  video_window: z.object({ shrinks: z.number(), restores: z.number(), shrunk_now: z.boolean(), shrunk_since: z.string().nullable() }).openapi({ description: "Video-triggered chat window shrink and restore counts and current state." }),
  watchdog: z.object({ enabled: z.boolean(), level: Level, since: z.string(), reserve_bytes: z.number(), generation_paused: z.boolean(), chat_paged_out: z.boolean(), survivors_stopped: z.number() }),
  ledger: z.object({ reserved_bytes: z.number(), warm_bytes: z.number(), burst_bytes: z.number(), budget_bytes: z.number(), working_margin_bytes: z.number(), free_bytes: z.number(), queue_depth: z.object({ reserved: z.number(), warm: z.number(), burst: z.number() }), chat_paged_out: z.boolean() }),
  memory: z.object({ total_bytes: z.number(), available_bytes: z.number(), free_bytes: z.number(), wired_bytes: z.number(), compressor_bytes: z.number(), swap_used_bytes: z.number(), swap_total_bytes: z.number(), swap_growth_bytes_30s: z.number(), pressure_level: z.number(), pressure: z.string(), sampled_at: z.string() }).nullable(),
  stack: z.object({ bytes: z.number(), tmp_bytes: z.number(), unaccounted_bytes: z.number().openapi({ description: "Stack process memory above loaded model peaks." }), unregistered: z.object({ count: z.number(), bytes: z.number() }).openapi({ description: "Older Stack descendants absent from the owned process registry." }), processes: z.array(z.object({ pid: z.number(), name: z.string(), bytes: z.number() })) }),
  dev_load: z.object({ others_bytes: z.number(), processes: z.array(z.object({ name: z.string(), bytes: z.number() })) }).openapi({ description: "MEM-SPACE-05: what other programs hold beside the Stack. `processes` names the big ones (name and bytes only) and is empty when nothing is flagged." }),
  top_consumers: z.array(z.object({ pid: z.number(), name: z.string(), bytes: z.number(), stack: z.boolean() })),
  non_stack_bytes: z.number(),
  isolation: z.object({ enabled: z.boolean(), paused_now: z.number(), interactive_in_flight: z.number(), pauses: z.number(), resumes: z.number(), forced_resumes: z.number(), paused_seconds: z.number() }).openapi({ description: "ISOLATION-01: heavy workers (picture, video, music, image tools) are stopped while a chat or voice request is in flight and continued after it. paused_now is how many are stopped this moment; paused_seconds is the total since the Stack started." }),
  reduced_chat: z.boolean().openapi({ description: "Whether chat is on the smaller Reduced model right now (the Stack's own state, for Home's notice)." }),
  max_window: z.object({ state: z.enum(["none", "draining", "open"]), owner: z.string().nullable(), since: z.string().nullable() }).openapi({ description: "TIER-STATUS-01: the governor's own Max window. `draining`: a Max job waits for running work to finish; `open`: it holds the computer. `owner` is the job id. Home reads this for its Status line and Stop button." }),
  recent_actions: z.array(z.object({ at: z.string(), level: Level, action: z.string(), detail: z.string() })),
  history: z.array(z.object({ at: z.string(), available_bytes: z.number(), swap_used_bytes: z.number(), pressure_level: z.number() })),
});

const route = createRoute({
  method: "get", path: "/", tags: ["Memory"], summary: "The whole computer's memory and what the watchdog is doing about it",
  responses: { 200: { content: { "application/json": { schema: MemorySchema } }, description: "The latest 5-second sample (available, free, wired, compressed memory, swap and its recent growth, the kernel's pressure level), the watchdog's level and reserve, whether picture and video making is paused, the Stack's own processes, the biggest memory users on the computer by name (the Stack's and not), and the watchdog's recent actions. Read only." } },
});

function maxWindowView() { const w = getMaxWindow(); return { state: w.state, owner: w.ownerId, since: w.since === null ? null : new Date(w.since).toISOString() }; }
export const memoryRoutes = apiRouter<AppEnv>();
memoryRoutes.openapi(route, (c) => c.json({ ...memoryWatchdog().report(), isolation: heavyGate.status(), reduced_chat: isReducedChat(), max_window: maxWindowView() }, 200));

const DailySchema = z.object({ days: z.array(z.object({
  date: z.string().openapi({ description: "Local calendar date." }),
  chat_restarts_by_cause: z.record(z.string(), z.number()).openapi({ description: "Chat restarts counted by cause." }),
  engine_stops_by_cause: z.record(z.string(), z.number()).openapi({ description: "Engine stops counted by cause." }),
  pauses: z.number().openapi({ description: "Isolation pauses." }),
  resumes: z.number().openapi({ description: "Isolation resumes." }),
  forced_resumes: z.number().openapi({ description: "Forced isolation resumes." }),
  paused_seconds: z.number().openapi({ description: "Seconds recorded while isolation resumed." }),
  memory_actions: z.record(z.string(), z.number()).openapi({ description: "Watchdog actions counted by action." }),
  shrinks: z.number().openapi({ description: "Chat window shrinks." }),
  restores: z.number().openapi({ description: "Chat window restores." }),
  survivors_stopped: z.number().openapi({ description: "Surviving processes stopped." }),
  sweeps: z.object({ runs: z.number().openapi({ description: "Completed sweeps." }), freed_bytes: z.number().openapi({ description: "Bytes freed by sweeps." }) }),
  canary_restarts: z.number().openapi({ description: "Restarts requested by canaries." }),
})) });
const dailyRoute = createRoute({
  method: "get", path: "/daily", tags: ["Memory"], summary: "Daily resource events from the Stack log",
  request: { query: z.object({ days: z.coerce.number().int().min(1).max(14).default(2).openapi({ description: "Number of local calendar days to report, from today backward." }) }) },
  responses: { 200: { content: { "application/json": { schema: DailySchema } }, description: "Daily counts from available Stack log files, read only." } },
});
memoryRoutes.openapi(dailyRoute, (c) => {
  const logs = join(dataDir, "logs");
  let files: string[] = [];
  try {
    files = readdirSync(logs).filter((name) => name === "stack.log" || /^stack\.log\.\d{4}-/.test(name)).sort().reverse();
  } catch { /* Missing log directory means zero counts. */ }
  const lines: string[] = [];
  let remaining = 5 * 1024 * 1024;
  for (const name of files) {
    if (remaining <= 0) break;
    const path = join(logs, name);
    try {
      const size = statSync(path).size;
      if (!statSync(path).isFile()) continue;
      const length = Math.min(size, remaining);
      const content = readFileSync(path).subarray(Math.max(0, size - length)).toString("utf8");
      lines.push(...content.split("\n").slice(size > length ? 1 : 0));
      remaining -= length;
    } catch { /* A rotated file may disappear during the read. */ }
  }
  return c.json({ days: dailyResources(lines, c.req.valid("query").days, new Date()) }, 200);
});

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
