import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema, idParamSchema } from "@/lib/openapi";
import { requireClientOrOperator } from "@/lib/clients";
import { requireOperator } from "@/lib/operator";
import { createModelGroup, listGroupRollups, performGroupAction, removeModelGroup, updateModelGroup, type ModelAction } from "@/lib/modelGroups";
import { showroom, showroomGroups, showroomModels } from "@/showroom/fixture";

const UsageSchema = z.object({ requests: z.number().int(), tokens: z.number().int(), secondsLoaded: z.number().int(), peakMemoryBytes: z.number().int() });
const StatusSchema = z.object({ loaded: z.number().int(), ready: z.number().int(), onDemand: z.number().int(), failed: z.number().int() });
const GroupSchema = z.object({ id: z.string(), name: z.string(), parentId: z.string().nullable(), createdAt: z.string(), modelCount: z.number().int(), bytesOnDisk: z.number().int(), memoryBytes: z.number().int(), usage: UsageSchema, status: StatusSchema, worstHealth: z.string().nullable() });
const listRoute = createRoute({ method: "get", path: "/", tags: ["Groups"], summary: "List model groups", middleware: [requireClientOrOperator] as const, responses: { 200: { content: { "application/json": { schema: z.object({ groups: z.array(GroupSchema) }) } }, description: "Model groups and rollups." } } });
const createRoute_ = createRoute({ method: "post", path: "/", tags: ["Groups"], summary: "Create a model group", middleware: [requireOperator] as const, request: { body: { content: { "application/json": { schema: z.object({ name: z.string().min(1), parentId: z.string().nullable().optional() }) } } } }, responses: { 201: { content: { "application/json": { schema: GroupSchema } }, description: "Created model group." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "Invalid group." } } });
const actionRoute = createRoute({ method: "post", path: "/{id}/actions", tags: ["Groups"], summary: "Apply a group action", middleware: [requireOperator] as const, request: { params: idParamSchema("id"), body: { content: { "application/json": { schema: z.object({ action: z.enum(["load", "unload", "pin", "unpin", "checkUpdates"]) }) } } } }, responses: { 200: { content: { "application/json": { schema: z.object({ results: z.array(z.object({ modelId: z.string(), ok: z.boolean(), reason: z.string().optional() })) }) } }, description: "Per-model group action results." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "Group action failed." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown group." } } });
const updateRoute = createRoute({ method: "patch", path: "/{id}", tags: ["Groups"], summary: "Rename or move a model group", middleware: [requireOperator] as const, request: { params: idParamSchema("id"), body: { content: { "application/json": { schema: z.object({ name: z.string().min(1).optional(), parentId: z.string().nullable().optional() }) } } } }, responses: { 200: { content: { "application/json": { schema: GroupSchema } }, description: "Updated model group." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "Invalid group move." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown group." } } });
const deleteRoute = createRoute({ method: "delete", path: "/{id}", tags: ["Groups"], summary: "Remove a model group", middleware: [requireOperator] as const, request: { params: idParamSchema("id") }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Group removed and its models re-parented." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown group." } } });

function showroomGroupView(group: typeof showroomGroups[number]) {
  return { ...group, createdAt: group.createdAt ?? new Date().toISOString(), usage: { secondsLoaded: 0, peakMemoryBytes: group.memoryBytes, ...group.usage } };
}

export const groupsRoutes = apiRouter();
groupsRoutes.openapi(listRoute, (c) => c.json({ groups: showroom() ? showroomGroups.map(showroomGroupView) : listGroupRollups() } as never, 200));
groupsRoutes.openapi(createRoute_, (c) => {
  try {
    const body = c.req.valid("json");
    if (showroom()) {
      const group = { id: `group-${crypto.randomUUID()}`, name: body.name, parentId: body.parentId ?? null, createdAt: new Date().toISOString(), modelCount: 0, bytesOnDisk: 0, memoryBytes: 0, usage: { requests: 0, tokens: 0, secondsLoaded: 0, peakMemoryBytes: 0 }, status: { loaded: 0, ready: 0, onDemand: 0, failed: 0 }, worstHealth: null };
      showroomGroups.push(group);
      return c.json(group as never, 201);
    }
    return c.json(createModelGroup(body.name, body.parentId ?? null) as never, 201);
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Invalid group." }, 400); }
});
groupsRoutes.openapi(actionRoute, async (c) => {
  const id = c.req.valid("param").id; const action = c.req.valid("json").action as ModelAction;
  if (showroom()) {
    const group = showroomGroups.find((item) => item.id === id); if (!group) return c.json({ error: "Unknown group." }, 404);
    const ids = showroomModels.filter((model) => model.groupId === id).map((model) => model.id);
    return c.json({ results: ids.map((modelId) => ({ modelId, ok: action !== "load" || !modelId.includes("refuse"), ...(modelId.includes("refuse") ? { reason: "The governor refused this model's memory admission." } : {}) })) }, 200);
  }
  try { return c.json(await performGroupAction(id, action), 200); } catch (error) { const message = error instanceof Error ? error.message : "Group action failed."; return c.json({ error: message }, message === "Unknown group." ? 404 : 400); }
});
groupsRoutes.openapi(updateRoute, (c) => {
  const id = c.req.valid("param").id; const body = c.req.valid("json");
  try {
    if (showroom()) {
      const group = showroomGroups.find((item) => item.id === id); if (!group) return c.json({ error: "Unknown group." }, 404);
      if (body.parentId === id) return c.json({ error: "A group cannot be its own ancestor." }, 400);
      if (body.name !== undefined) group.name = body.name; if (body.parentId !== undefined) group.parentId = body.parentId;
      return c.json(showroomGroupView(group) as never, 200);
    }
    return c.json(updateModelGroup(id, body) as never, 200);
  } catch (error) { const message = error instanceof Error ? error.message : "Invalid group move."; return c.json({ error: message }, message === "Unknown group." ? 404 : 400); }
});
groupsRoutes.openapi(deleteRoute, (c) => {
  const id = c.req.valid("param").id;
  if (showroom()) {
    const group = showroomGroups.find((item) => item.id === id); if (!group) return c.json({ error: "Unknown group." }, 404);
    for (const child of showroomGroups) if (child.parentId === id) child.parentId = group.parentId;
    for (const model of showroomModels) if (model.groupId === id) model.groupId = group.parentId ?? "group-ungrouped";
    showroomGroups.splice(showroomGroups.indexOf(group), 1); return c.json({ ok: true as const }, 200);
  }
  if (!removeModelGroup(id)) return c.json({ error: "Unknown group." }, 404); return c.json({ ok: true as const }, 200);
});
