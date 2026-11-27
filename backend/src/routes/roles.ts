import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import { ChatRoleContextSchema } from "@maipai/spec/stack/ts/role-context.js";
import type { AppEnv } from "@/types";
import { plainReasonOf } from "@/lib/crashClassifier";
import { resolveRoleState } from "@/lib/router";
import { ROLE_IDS, RoleRecordSchema, ROLES } from "@/roles";
import { isComponent, listModels } from "@/lib/modelStore";
import { activeTtsChoice, codingEngineStatus, getRoleStatus, identityCheck, pictureTokensMax, roleReadsPictures, selectableModels, selectedModel, ttsEngineInEffect } from "@/lib/supervisor";
import { roleDisabledReason, rolePriorityOf } from "@/lib/roleSwitches";
import { listJobs } from "@/lib/jobs";
import { roleCheck } from "@/lib/readiness";
import { TTS_ENGINES } from "@/speech/ttsEngines";
import { roleChoice } from "@/lib/choiceRuntime";

const CheckSchema = z.object({ state: z.enum(["not checked", "passed", "failed", "skipped"]), at: z.string().nullable(), reason: z.string().nullable(), stale: z.boolean() });
const IdentitySchema = z.object({ ok: z.boolean(), expected: z.string().nullable(), actual: z.string().nullable(), reason: z.string().nullable() });
const PendingInstallSchema = z.object({ job: z.string(), model: z.string().nullable(), purpose: z.string().nullable(), percent: z.number() });
const CodingStatusSchema = z.object({
  state: z.enum(["notInstalled", "installed", "loading", "ready", "busy", "offline"]).openapi({ description: "notInstalled: no coding model on disk. installed: on disk and unloaded (a coding request loads it). loading: starting. ready: loaded and free. busy: serving a request. offline: it failed to start or exited." }),
  keep_warm_minutes: z.number().int().openapi({ description: "Minutes the engine stays loaded after its last request (stack.engines.coding.keep_warm_minutes)." }),
  idle_seconds: z.number().int().nullable().openapi({ description: "Seconds since the last request ended while loaded and free; null when unloaded or busy." }),
  slots: z.number().int().nullable().openapi({ description: "Server slots (concurrent requests); null when not installed. On Splash this is the number of requests expected to run at once; Splash queues the rest itself." }),
  slots_busy: z.number().int().openapi({ description: "Requests in flight, at most slots." }),
  cannot_fit_reason: z.string().nullable().openapi({ description: "Why the model cannot load now (it would not fit in memory beside the always-on models), with what to do; null when nothing is known to stop it." }),
  engine: z.enum(["llama-server", "splash"]).openapi({ description: "The engine serving coding: the running process's while one runs, otherwise the one the next start chooses. splash is the faster engine on an Apple silicon Mac with an M3 chip or newer, 64 GB of memory or more and macOS 26.4 or later; llama-server everywhere else and when Splash did not start." }),
  engine_requested: z.enum(["auto", "llama-server", "splash"]).openapi({ description: "What stack.engines.coding.engine asks for." }),
  engine_reason: z.string().nullable().openapi({ description: "Why the faster engine is not in use though it was wanted (not installed, its draft missing, did not start, or forced off), with what to do; null when nothing is amiss, including on a computer Splash never runs on." }),
});
const RoleViewSchema = RoleRecordSchema.extend({ coding: CodingStatusSchema.optional(), pending_install: PendingInstallSchema.nullable(), plain_reason: z.string().nullable().openapi({ description: "The offline reason as one classified plain sentence (the Mac's graphics compiler not answering, or out of memory), safe to show as written; null for every other reason. `state.reason` keeps the raw reason." }), check: CheckSchema, identity: IdentitySchema, ...ChatRoleContextSchema.shape, models: z.array(z.object({ id: z.string(), name: z.string() })).optional(), picture_tokens_max: z.number().int().nullable().optional(), reads_pictures: z.boolean().optional(), tts: z.object({ delivery_mode: z.enum(["streaming", "buffered"]).optional().openapi({ description: "How speech is sent now: streaming (as it is made) or buffered (whole reply first, with a short pause in front, while the computer is busy)." }), engine: z.string(), requested: z.string(), tags: z.array(z.string()), fallback_reason: z.string().nullable() }).optional(), choice: z.object({
  category: z.string().describe("The model-choices category this role answers for (chat, coding, pictures, video, music, voice, stt, embeddings, vision, wakeword)."),
  level: z.enum(["reduced", "standard", "boost", "max"]).describe("The level in use now: Standard, or Reduced while chat is swapped down, or Max while coding mode is on."),
  chosen: z.string().nullable().describe("The model the Stack's choices name for this level (the household's pick, else the order, else the recommended model)."),
  chosen_by: z.enum(["household", "recommended", "off", "none"]).describe("Where the choice came from: the household (a pick, the order, or a setting Home wrote) or the Stack's recommended model. The same word `GET /stack/v1/choices` uses."),
  model: z.string().nullable().describe("The model answering this role now, or the one its next request starts."),
  answering: z.boolean().describe("True when the chosen model is the one answering. When false, `reason` says why in plain words (not installed yet, does not fit, starts at the next restart) and the earlier model keeps answering."),
  reason: z.string().nullable(),
}).nullable().optional().describe("What the household chose for this role and whether it is the model answering; the same facts as `GET /stack/v1/choices`, from the same code.") });

const rolesRoute = createRoute({ method: "get", path: "/", tags: ["Roles"], summary: "Every declared role and its current state", responses: { 200: { content: { "application/json": { schema: z.object({ roles: z.array(RoleViewSchema) }) } }, description: "Declaration; derived state with since, checkedAt on ready and the reason a role is only loaded; the bound model; the launched context length, slot count and whether context is per slot or total (chat, and coding once its engine runs: one window shared by its slots); what the last readiness run said; the identity check." } } });

/** The voice role's capability flag (VOICE-STUDIO-01): the engine in effect, the one asked for, the tags it renders as sounds, and why it fell back when it did. */
import { ttsDelivery } from "@/lib/ttsDeliveryState";
function ttsView() {
  const choice = activeTtsChoice();
  const engine = ttsEngineInEffect();
  return { delivery_mode: ttsDelivery.mode, engine: TTS_ENGINES[engine].catalogEngine, requested: TTS_ENGINES[choice.requested].catalogEngine, tags: [...TTS_ENGINES[engine].tags], fallback_reason: engine === choice.requested ? null : choice.reason };
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
    // The coding engine runs one KV pool shared by its slots (`--kv-unified`, scope "total across slots"): one request may use the whole window, and the total is the window itself, not the window times the slots.
    const sharedPool = status.contextScope === "total across slots";
    const perSlot = contextLength;
    const total = perSlot === null ? null : sharedPool ? perSlot : perSlot * (slots ?? 1);
    const choice = roleChoice(id);
    const contextFields = { context_length: contextLength, context_per_slot: perSlot, context_total: total, slots, context_scope: status.contextScope ?? null };
    return { id, ...ROLES[id], enabled: roleDisabledReason(id) === null, priority: rolePriorityOf(id), state, pending_install: pendingInstall(id), reason: state.reason ?? null, plain_reason: roleDisabledReason(id) ?? plainReasonOf(state.reason), model: model ? { id: model.id, sizeBytes: model.sizeBytes, measuredFootprintBytes: model.measuredFootprintBytes, measuredContextLength: model.measuredContextLength, estimated: model.measuredFootprintBytes === null, imageInput: roleReadsPictures(id, model) } : null, check: roleCheck(id), identity: identityCheck(id), ...(id === "chat" || id === "coding" ? contextFields : {}), ...(id === "chat" ? { models: selectableModels(id), picture_tokens_max: pictureTokensMax(id) } : {}), ...(id === "chat" || id === "vision" ? { reads_pictures: roleReadsPictures(id, model) } : {}), choice: choice ? { category: choice.category, level: choice.level, chosen: choice.chosen, chosen_by: choice.chosen_by, model: choice.model, answering: choice.answering, reason: choice.reason } : null, ...(id === "tts" ? { tts: ttsView() } : {}), ...(id === "coding" ? { coding: codingEngineStatus() } : {}) };
  }),
}, 200));
