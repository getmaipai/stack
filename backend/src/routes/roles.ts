import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { resolveRoleState } from "@/lib/router";
import { ROLE_IDS, RoleRecordSchema, ROLES } from "@/roles";
import { listModels } from "@/lib/modelStore";
import { identityCheck, roleContext, selectableModels, selectedModel } from "@/lib/supervisor";
import { roleCheck } from "@/lib/readiness";

const CheckSchema = z.object({ state: z.enum(["not checked", "passed", "failed", "skipped"]), at: z.string().nullable(), reason: z.string().nullable(), stale: z.boolean() });
const IdentitySchema = z.object({ ok: z.boolean(), expected: z.string().nullable(), actual: z.string().nullable(), reason: z.string().nullable() });
const ContextSchema = z.object({ context_length: z.number().int().nullable(), slots: z.number().int().nullable(), context_per_slot: z.number().int().nullable(), reason: z.string().nullable() });
const RoleViewSchema = RoleRecordSchema.extend({ check: CheckSchema, identity: IdentitySchema, context: ContextSchema, models: z.array(z.object({ id: z.string(), name: z.string() })).optional() });
const rolesRoute = createRoute({ method: "get", path: "/", tags: ["Roles"], summary: "Every declared role and its current state", responses: { 200: { content: { "application/json": { schema: z.object({ roles: z.array(RoleViewSchema) }) } }, description: "Declaration; derived state with since, checkedAt on ready and the reason a role is only loaded; the bound model; what the last readiness run said (not checked, passed, failed, skipped; stale after a change); the identity check; the context the running engine reports (length, slots, per slot), null with a reason when no engine runs." } } });

export const rolesRoutes = apiRouter<AppEnv>();
rolesRoutes.openapi(rolesRoute, (c) => c.json({
  roles: ROLE_IDS.map((id) => {
    const state = resolveRoleState(id);
    const model = selectedModel(id) ?? listModels().find((candidate) => candidate.roles.includes(id)) ?? null;
    return { id, ...ROLES[id], state, reason: state.reason ?? null, model: model ? { id: model.id, sizeBytes: model.sizeBytes, measuredFootprintBytes: model.measuredFootprintBytes, measuredContextLength: model.measuredContextLength, estimated: model.measuredFootprintBytes === null } : null, check: roleCheck(id), identity: identityCheck(id), context: roleContext(id), ...(id === "chat" ? { models: selectableModels(id) } : {}) };
  }),
}, 200));
