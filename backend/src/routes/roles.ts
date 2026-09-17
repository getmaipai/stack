import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@/lib/openapi";
import { requireClientOrOperator } from "@/lib/clients";
import { resolveRole } from "@/lib/router";
import { ROLE_IDS, RoleRecordSchema, ROLES } from "@/roles";
import { listModels } from "@/lib/modelStore";

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
rolesRoutes.openapi(rolesRoute, (c) => c.json({
  roles: ROLE_IDS.map((id) => {
    const model = listModels().find((candidate) => candidate.roles.includes(id));
    return {
    id,
    ...ROLES[id],
    state: resolveRole(id).state,
    reason: null,
    model: model ? { id: model.id, sizeBytes: model.sizeBytes, measuredFootprintBytes: model.measuredFootprintBytes, measuredContextLength: model.measuredContextLength, estimated: model.measuredFootprintBytes === null } : null,
  }; }),
}, 200));
