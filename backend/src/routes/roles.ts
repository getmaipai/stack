import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema } from "@/lib/openapi";
import { requireClientOrOperator } from "@/lib/clients";
import { resolveRoleState } from "@/lib/router";
import { ROLE_IDS, RoleRecordSchema, ROLES } from "@/roles";
import { getModel, isModelSelectable, listModels } from "@/lib/modelStore";
import { showroom, showroomRoles } from "@/showroom/fixture";

const RolesResponseSchema = z.object({ roles: z.array(RoleRecordSchema) });

const rolesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Roles"],
  summary: "Declared capability roles",
  middleware: [requireClientOrOperator] as const,
  responses: {
    200: {
      content: { "application/json": { schema: RolesResponseSchema } },
      description: "Every declared role and its current state.",
    },
  },
});

export const rolesRoutes = apiRouter();
rolesRoutes.openapi(rolesRoute, (c) => c.json(showroom() ? { roles: showroomRoles } as never : {
  roles: ROLE_IDS.map((id) => {
    const state = resolveRoleState(id);
    const model = listModels().find((candidate) => candidate.roles.includes(id));
    return {
    id,
    ...ROLES[id],
    state,
    reason: state.state === "offline" ? (state.reason ?? null) : null,
    model: model ? { id: model.id, sizeBytes: model.sizeBytes, measuredFootprintBytes: model.measuredFootprintBytes, measuredContextLength: model.measuredContextLength, estimated: model.measuredFootprintBytes === null } : null,
  }; }),
}, 200));

const bindRoute = createRoute({ method: "post", path: "/{role}/bind", tags: ["Roles"], summary: "Bind a model to a role", middleware: [requireClientOrOperator] as const, request: { params: z.object({ role: z.string().openapi({ param: { name: "role", in: "path" } }) }), body: { content: { "application/json": { schema: z.object({ model: z.string() }) } } } }, responses: { 200: { content: { "application/json": { schema: z.object({ role: z.string(), model: z.string(), admitted: z.literal(true) }) } }, description: "Role binding admitted by the Stack." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown or unverified model." } } });
rolesRoutes.openapi(bindRoute, (c) => { const { role } = c.req.valid("param"); const modelId = c.req.valid("json").model; const model = getModel(modelId); if (!model || !model.roles.includes(role as never) || !isModelSelectable(model)) return c.json({ error: "Model is unknown, unverified, or cannot serve this role" }, 400); return c.json({ role, model: modelId, admitted: true as const }, 200); });
