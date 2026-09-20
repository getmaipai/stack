// The problem list with one fix per item, and the three actions Home
// calls on an item: fix (the Stack runs the repair), resolve, ignore.
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema, idParamSchema } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { ignore, list as listHealth, resolve } from "@/lib/health";
import { getProcess, restartRole, stopRole, unloadAllRoles } from "@/lib/supervisor";
import { rollbackEngine, currentEngine, previousEngine } from "@/updates/engines";
import { ROLE_IDS, type RoleId } from "@/roles";

import { HealthItem as HealthItemSchema } from "@/spec/ts/health-item";

const listRoute = createRoute({ method: "get", path: "/", tags: ["Health"], summary: "Active health items", responses: { 200: { content: { "application/json": { schema: z.object({ health: z.array(HealthItemSchema) }) } }, description: "Open problems, each with at most one fix." } } });
const fixRoute = createRoute({ method: "post", path: "/{code}/fix", tags: ["Health"], summary: "Run a health item's fix", request: { params: idParamSchema("code") }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), result: z.string() }) } }, description: "What the fix did." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown item or no fix." } } });
const actionRoute = (action: "resolve" | "ignore") => createRoute({ method: "post", path: `/{code}/${action}`, tags: ["Health"], summary: `${action[0]!.toUpperCase()}${action.slice(1)} a health item`, request: { params: idParamSchema("code") }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Done." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown item." } } });

function roleFromCode(code: string): RoleId {
  const suffix = code.split(".").at(-1) ?? "";
  return ROLE_IDS.includes(suffix as RoleId) ? (suffix as RoleId) : "chat";
}

export async function runFix(code: string): Promise<{ ok: boolean; result: string } | null> {
  const item = listHealth().find((candidate) => candidate.code === code);
  if (!item?.fix) return null;
  const role = roleFromCode(code);
  switch (item.fix.action) {
    case "restart_engine": { await restartRole(role); try { await getProcess(role); } catch (error) { return { ok: false, result: (error as Error).message }; } resolve(code); return { ok: true, result: `The ${role} engine was restarted.` }; }
    case "free_memory": { await unloadAllRoles("Unloaded to free memory."); resolve(code); return { ok: true, result: "Every engine was unloaded to free memory; the next request starts what it needs." }; }
    case "rollback_update": {
      const previous = previousEngine("llama-server");
      if (!previous) return { ok: false, result: "No previous build is recorded to roll back to." };
      await stopRole("chat", "Draining for a rollback.");
      await rollbackEngine("llama-server", previous);
      await restartRole("chat");
      resolve(code);
      return { ok: true, result: `Rolled back to ${currentEngine("llama-server") ?? previous}.` };
    }
    default: return { ok: false, result: "This repair needs the matching engine or model installer; reinstall from Home's Engines page." };
  }
}

export const healthRoutes = apiRouter<AppEnv>();
healthRoutes.openapi(listRoute, (c) => c.json({ health: listHealth() }, 200));
healthRoutes.openapi(fixRoute, async (c) => { const result = await runFix(c.req.valid("param").code); return result ? c.json(result, 200) : c.json({ error: "Unknown health item or no fix." }, 404); });
for (const action of ["resolve", "ignore"] as const) healthRoutes.openapi(actionRoute(action), (c) => { const code = c.req.valid("param").code; return (action === "resolve" ? resolve(code) : ignore(code)) ? c.json({ ok: true as const }, 200) : c.json({ error: "Unknown health item" }, 404); });
