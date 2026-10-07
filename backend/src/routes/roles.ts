import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import { ChatRoleContextSchema } from "@maipai/spec/stack/ts/role-context.js";
import type { AppEnv } from "@/types";
import { resolveRoleState } from "@/lib/router";
import { ROLE_IDS, RoleRecordSchema, ROLES } from "@/roles";
import { isComponent, listModels } from "@/lib/modelStore";
import { getRoleStatus, identityCheck, pictureTokensMax, roleReadsPictures, selectableModels, selectedModel } from "@/lib/supervisor";
import { roleCheck } from "@/lib/readiness";

const CheckSchema = z.object({ state: z.enum(["not checked", "passed", "failed", "skipped"]), at: z.string().nullable(), reason: z.string().nullable(), stale: z.boolean() });
const IdentitySchema = z.object({ ok: z.boolean(), expected: z.string().nullable(), actual: z.string().nullable(), reason: z.string().nullable() });
const RoleViewSchema = RoleRecordSchema.extend({ check: CheckSchema, identity: IdentitySchema, ...ChatRoleContextSchema.shape, models: z.array(z.object({ id: z.string(), name: z.string() })).optional(), picture_tokens_max: z.number().int().nullable().optional() });
const rolesRoute = createRoute({ method: "get", path: "/", tags: ["Roles"], summary: "Every declared role and its current state", responses: { 200: { content: { "application/json": { schema: z.object({ roles: z.array(RoleViewSchema) }) } }, description: "Declaration; derived state with since, checkedAt on ready and the reason a role is only loaded; the bound model; the launched context length, slot count and whether context is per slot or total; what the last readiness run said; the identity check." } } });

export const rolesRoutes = apiRouter<AppEnv>();
rolesRoutes.openapi(rolesRoute, (c) => c.json({
  roles: ROLE_IDS.map((id) => {
    const state = resolveRoleState(id);
    const model = selectedModel(id) ?? listModels().find((candidate) => candidate.roles.includes(id) && !isComponent(candidate)) ?? null;
    const status = getRoleStatus(id);
    const contextLength = status.contextLength ?? null;
    const slots = status.slots ?? null;
    const perSlot = contextLength;
    const total = perSlot === null ? null : perSlot * (slots ?? 1);
    return { id, ...ROLES[id], state, reason: state.reason ?? null, model: model ? { id: model.id, sizeBytes: model.sizeBytes, measuredFootprintBytes: model.measuredFootprintBytes, measuredContextLength: model.measuredContextLength, estimated: model.measuredFootprintBytes === null, imageInput: roleReadsPictures(id, model) } : null, check: roleCheck(id), identity: identityCheck(id), ...(id === "chat" ? { context_length: contextLength, context_per_slot: perSlot, context_total: total, slots, context_scope: status.contextScope ?? null, models: selectableModels(id), picture_tokens_max: pictureTokensMax(id) } : {}) };
  }),
}, 200));
