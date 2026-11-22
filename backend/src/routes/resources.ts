import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { RANGE_MS, resourceHistory, setRolePidProvider } from "@/lib/resourceHistory";
import { resourceEvents } from "@/lib/resourceEvents";
import { engineProcessRows } from "@/lib/supervisor";
import { getGovernorStatus } from "@/lib/governor";
import { getModel } from "@/lib/modelStore";
import { rolePriorityOf } from "@/lib/roleSwitches";
import { settingValues } from "@/settings";
import { ROLES, ROLE_IDS, type RoleId } from "@/roles";

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
  roles: z.record(z.string(), z.number()).optional().openapi({ description: "Bytes by engine role (chat, tts, ...): the role's engine process and everything below it. Absent on points recorded before this field existed; a role that shares chat's process is counted under chat." }),
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
  responses: { 200: { content: { "application/json": { schema: z.object({ range: z.enum(["1h", "24h", "7d", "30d"]), step_seconds: z.number(), points: z.array(PointSchema), roles: Roles, engine_roles: Roles.openapi({ description: "Roles that have a `roles` figure somewhere in these points." }) }) } }, description: "At most 600 points, oldest first. Raw 5 s samples for 24 h, 1 minute means for 7 days, 1 hour means for 30 days. Read only." } },
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

const MarkerSchema = z.object({ t: z.number().openapi({ description: "Milliseconds since the epoch." }), kind: z.enum(["loaded", "unloaded", "restart", "mode", "problem"]), role: z.string(), text: z.string().openapi({ description: "One plain sentence, safe to show as written." }) });
const eventsRoute = createRoute({
  method: "get", path: "/events", tags: ["Resources"], summary: "Timeline markers: engines loaded, unloaded, restarted, mode switches, problems",
  request: { query: z.object({ range: z.enum(["1h", "24h", "7d", "30d"]).default("1h") }) },
  responses: { 200: { content: { "application/json": { schema: z.object({ range: z.enum(["1h", "24h", "7d", "30d"]), events: z.array(MarkerSchema) }) } }, description: "Oldest first, kept 30 days, at most 3000. Read only." } },
});
const EngineRow = z.object({
  role: z.string(), label: z.string(), serves: z.array(z.string()).openapi({ description: "Other roles answered by the same process (judge and router share chat's)." }),
  state: z.enum(["running", "idle", "loading", "queued"]).openapi({ description: "running: a request or session is open; idle: loaded and waiting; loading: starting; queued: waiting in the admission queue for memory." }),
  engine: z.string().nullable(), pid: z.number().nullable(), model_id: z.string().nullable(), model_bytes: z.number().nullable().openapi({ description: "Size of the model file on disk, when known." }),
  memory_bytes: z.number().openapi({ description: "Bytes held now by the process and its children, from the latest 5 s sample; 0 when none is read." }),
  peak_bytes_24h: z.number().nullable(), mean_bytes_24h: z.number().nullable(),
  started_at: z.string().nullable(), uptime_seconds: z.number().nullable(), restarts_24h: z.number(), restarts_7d: z.number(),
  last_used_at: z.string().nullable().openapi({ description: "The last request or lease, from the memory ledger when it has one, else the last answered request." }), idle_seconds: z.number().nullable(),
  residency: z.enum(["resident", "jit"]).openapi({ description: "resident: loaded at start and kept; jit: loaded on the first request and unloaded after its idle time." }),
  memory_class: z.string(), keep_warm_minutes: z.number().nullable(), idle_ttl_seconds: z.number().nullable(), pinned: z.boolean(), priority: z.number(),
  active_requests: z.number(), queue_position: z.number().nullable(), tokens_per_second: z.number().nullable().openapi({ description: "Null until the engine keeps a counter: shown as not measured, never guessed." }),
});
const enginesRoute = createRoute({
  method: "get", path: "/engines", tags: ["Resources"], summary: "One row per engine process: memory now, peak, uptime, restarts and why it is resident",
  responses: { 200: { content: { "application/json": { schema: z.object({ sampled_at: z.string().nullable(), budget: z.object({ total_bytes: z.number(), cap_bytes: z.number(), loaded_bytes: z.number() }), engines: z.array(EngineRow) }) } }, description: "Memory comes from the same 5 s sample as the history; peak and mean cover the last 24 h of minute buckets. Read only." } },
});

setRolePidProvider(() => engineProcessRows().filter((row): row is typeof row & { pid: number } => row.pid !== null).map((row) => ({ role: row.role, pid: row.pid })));

const keepWarmMinutes = (role: string): number | null => { const v = settingValues()[`stack.engines.${role}.keep_warm_minutes`]; return typeof v === "number" ? v : null; };

export function engineRows(): z.infer<typeof EngineRow>[] {
  const now = Date.now();
  const gov = getGovernorStatus();
  const history = resourceHistory();
  const latest = history.summary().current;
  const stats = history.roleStats();
  const restarts24 = resourceEvents().restarts(RANGE_MS["24h"]);
  const restarts7 = resourceEvents().restarts(RANGE_MS["7d"]);
  const procs = new Map(engineProcessRows().map((row) => [row.role, row]));
  const ids = new Set<string>([...procs.keys(), ...gov.loaded.map((l) => l.id), ...gov.queue.map((q) => q.id), ...Object.keys(latest?.roles ?? {})]);
  const rows: z.infer<typeof EngineRow>[] = [];
  for (const id of ids) {
    if (!(ROLE_IDS as readonly string[]).includes(id)) continue;
    const role = id as RoleId;
    const def = ROLES[role] as { label: string; residency: "resident" | "jit"; memoryClass: string };
    const proc = procs.get(role);
    const item = gov.loaded.find((l) => l.id === id);
    const queued = gov.queue.find((q) => q.id === id);
    const modelId = proc?.modelId ?? null;
    const model = modelId ? getModel(modelId) : null;
    const lastMs = item ? new Date(item.lastUsedAt).getTime() : proc?.lastRealRequestAt ?? null;
    const state = proc ? (proc.starting ? "loading" : proc.activeRequests > 0 || proc.sessions > 0 ? "running" : "idle") : queued ? "queued" : "idle";
    rows.push({
      role: id, label: def.label, serves: ROLE_IDS.filter((other) => other !== role && (ROLES[other] as { sharesModelWith?: string }).sharesModelWith === role),
      state, engine: proc?.engine ?? null, pid: proc?.pid ?? null, model_id: modelId, model_bytes: model?.sizeBytes ?? null,
      memory_bytes: Math.round(latest?.roles?.[id] ?? 0), peak_bytes_24h: stats[id] ? Math.round(stats[id]!.peak) : null, mean_bytes_24h: stats[id] ? Math.round(stats[id]!.mean) : null,
      started_at: proc?.startedAt ? new Date(proc.startedAt).toISOString() : null, uptime_seconds: proc?.startedAt ? Math.max(0, Math.round((now - proc.startedAt) / 1000)) : null,
      restarts_24h: restarts24[id] ?? 0, restarts_7d: restarts7[id] ?? 0,
      last_used_at: lastMs ? new Date(lastMs).toISOString() : null, idle_seconds: lastMs ? Math.max(0, Math.round((now - lastMs) / 1000)) : null,
      residency: def.residency, memory_class: def.memoryClass, keep_warm_minutes: keepWarmMinutes(id), idle_ttl_seconds: item?.idleTtlSeconds ?? null, pinned: item?.pinned ?? false,
      priority: rolePriorityOf(role), active_requests: proc?.activeRequests ?? 0, queue_position: queued?.position ?? null, tokens_per_second: latest?.tps?.[id] ?? null,
    });
  }
  return rows.sort((a, b) => b.memory_bytes - a.memory_bytes || a.label.localeCompare(b.label));
}

export const resourcesRoutes = apiRouter<AppEnv>();
resourcesRoutes.openapi(historyRoute, (c) => { const q = c.req.valid("query"); return c.json(resourceHistory().query(q.range, q.step), 200); });
resourcesRoutes.openapi(summaryRoute, (c) => c.json(resourceHistory().summary(), 200));

resourcesRoutes.openapi(eventsRoute, (c) => { const { range } = c.req.valid("query"); return c.json({ range, events: resourceEvents().query(RANGE_MS[range]) }, 200); });
resourcesRoutes.openapi(enginesRoute, (c) => {
  const gov = getGovernorStatus();
  const engines = engineRows();
  return c.json({ sampled_at: resourceHistory().summary().sampled_at, budget: { total_bytes: gov.totalMemoryBytes, cap_bytes: gov.capBytes, loaded_bytes: engines.reduce((n, e) => n + e.memory_bytes, 0) }, engines }, 200);
});
