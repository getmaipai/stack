import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import { ChatRoleContextSchema } from "@maipai/spec/stack/ts/role-context.js";
import type { AppEnv } from "@/types";
import { resolveRoleState } from "@/lib/router";
import { ROLE_IDS, RoleRecordSchema, ROLES } from "@/roles";
import { isComponent, listModels } from "@/lib/modelStore";
import { activeTtsChoice, getRoleStatus, identityCheck, pictureTokensMax, roleReadsPictures, selectableModels, selectedModel, ttsEngineInEffect } from "@/lib/supervisor";
import { listJobs } from "@/lib/jobs";
import { roleCheck } from "@/lib/readiness";
import { TTS_ENGINES } from "@/speech/ttsEngines";

const CheckSchema = z.object({ state: z.enum(["not checked", "passed", "failed", "skipped"]), at: z.string().nullable(), reason: z.string().nullable(), stale: z.boolean() });
const IdentitySchema = z.object({ ok: z.boolean(), expected: z.string().nullable(), actual: z.string().nullable(), reason: z.string().nullable() });
const PendingInstallSchema = z.object({ job: z.string(), model: z.string().nullable(), purpose: z.string().nullable(), percent: z.number() });
const RoleViewSchema = RoleRecordSchema.extend({ pending_install: PendingInstallSchema.nullable(), check: CheckSchema, identity: IdentitySchema, ...ChatRoleContextSchema.shape, models: z.array(z.object({ id: z.string(), name: z.string() })).optional(), picture_tokens_max: z.number().int().nullable().optional(), reads_pictures: z.boolean().optional(), tts: z.object({ engine: z.string(), requested: z.string(), tags: z.array(z.string()), fallback_reason: z.string().nullable() }).optional() });

const rolesRoute = createRoute({ method: "get", path: "/", tags: ["Roles"], summary: "Every declared role and its current state", responses: { 200: { content: { "application/json": { schema: z.object({ roles: z.array(RoleViewSchema) }) } }, description: "Declaration; derived state with since, checkedAt on ready and the reason a role is only loaded; the bound model; the launched context length, slot count and whether context is per slot or total; what the last readiness run said; the identity check." } } });

/** The voice role's capability flag (VOICE-STUDIO-01): the engine in effect, the one asked for, the tags it renders as sounds, and why it fell back when it did. */
function ttsView() {
  const choice = activeTtsChoice();
  const engine = ttsEngineInEffect();
  return { engine: TTS_ENGINES[engine].catalogEngine, requested: TTS_ENGINES[choice.requested].catalogEngine, tags: [...TTS_ENGINES[engine].tags], fallback_reason: engine === choice.requested ? null : choice.reason };
}

/** A download running for this role (an upgrade, a replacement engine's weights, a projector). It never changes `state`: the role is ready or not by its own model, and this only says something better is on the way. */
export function pendingInstall(role: string, jobs = listJobs()) {
  const job = jobs.find((item) => item.kind === "model.install" && item.role === role && (item.state === "queued" || item.state === "running" || item.state === "paused" || item.state === "stalled"));
  if (!job) return null;
  const input = job.input as { model?: unknown; purpose?: unknown } | null;
  return { job: job.id, model: typeof input?.model === "string" ? input.model : null, purpose: typeof input?.purpose === "string" ? input.purpose : null, percent: job.percent };
}

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
    return { id, ...ROLES[id], state, pending_install: pendingInstall(id), reason: state.reason ?? null, model: model ? { id: model.id, sizeBytes: model.sizeBytes, measuredFootprintBytes: model.measuredFootprintBytes, measuredContextLength: model.measuredContextLength, estimated: model.measuredFootprintBytes === null, imageInput: roleReadsPictures(id, model) } : null, check: roleCheck(id), identity: identityCheck(id), ...(id === "chat" ? { context_length: contextLength, context_per_slot: perSlot, context_total: total, slots, context_scope: status.contextScope ?? null, models: selectableModels(id), picture_tokens_max: pictureTokensMax(id) } : {}), ...(id === "chat" || id === "vision" ? { reads_pictures: roleReadsPictures(id, model) } : {}), ...(id === "tts" ? { tts: ttsView() } : {}) };
  }),
}, 200));
