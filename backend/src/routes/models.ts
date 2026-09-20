// The model list with provenance, install and runtime state; install by
// pin, import a verified local file, remove, and the load, unload, pin
// and unpin actions. Nothing installs without url, sha256, licence and
// revision (goal 4).
import { createRoute, z } from "@hono/zod-openapi";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { apiRouter, ErrorSchema, idParamSchema } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { installCatalogModel, listModels, removeModel, upsertModel, type ModelRecord } from "@/lib/modelStore";
import { readModelManifest } from "@/lib/store/manifests";
import { importPath } from "@/lib/store/importScan";
import { modelsDir } from "@/lib/paths";
import { RoleIdSchema } from "@/roles";
import { createJob, finishJob, jobSignal, updateJob } from "@/lib/jobs";
import { catalogModelForId } from "@/updates/catalog";
import { getProcess, isModelPinned, loadedRoleForModel, pinModel, preferModel, restartRole, unloadRole, EngineUnavailableError } from "@/lib/supervisor";
import { STACK_CHAT_MODEL } from "@/lib/modelCatalog";

const ModelSchema = z.object({
  id: z.string(), roles: z.array(z.string()), state: z.enum(["notInstalled", "installed"]), runtimeState: z.enum(["loaded", "ready"]), pinned: z.boolean(),
  sizeBytes: z.number().int().nullable(), fileMissing: z.boolean(), measuredFootprintBytes: z.number().int().nullable(), measuredContextLength: z.number().int().nullable(), estimated: z.boolean(),
  source: z.string(), licence: z.string().nullable(), revision: z.string(), sha256: z.string().nullable(), provenance: z.record(z.string(), z.unknown()), modelPath: z.string().nullable(), installedAt: z.string().nullable(), verifiedAt: z.string().nullable(),
});
const PullSchema = z.object({ id: z.string(), role: RoleIdSchema, repo: z.string().optional(), url: z.string().url(), sha256: z.string().length(64), approx_bytes: z.number().int().nonnegative().optional(), licence: z.string(), revision: z.string(), engine: z.string().optional() });
const ImportSchema = z.object({ id: z.string(), path: z.string(), roles: z.array(RoleIdSchema).min(1), licence: z.string(), revision: z.string().optional() });
const ActionSchema = z.object({ action: z.enum(["load", "unload", "pin", "unpin"]) });

const listRoute = createRoute({ method: "get", path: "/", tags: ["Models"], summary: "Installed and known models", responses: { 200: { content: { "application/json": { schema: z.object({ models: z.array(ModelSchema) }) } }, description: "Every model record with its provenance and state." } } });
const pullRoute = createRoute({ method: "post", path: "/", tags: ["Models"], summary: "Install a pinned model (progress on the event feed)", request: { body: { content: { "application/json": { schema: PullSchema } } } }, responses: { 202: { content: { "application/json": { schema: z.object({ job: z.string(), model: z.string() }) } }, description: "The download job." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "Provenance incomplete." } } });
const importRoute = createRoute({ method: "post", path: "/import", tags: ["Models"], summary: "Import a local model file by verified link", request: { body: { content: { "application/json": { schema: ImportSchema } } } }, responses: { 200: { content: { "application/json": { schema: ModelSchema } }, description: "The imported model." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "The path is not a file." } } });
const removeRoute = createRoute({ method: "delete", path: "/{id}", tags: ["Models"], summary: "Remove a model", request: { params: idParamSchema("id") }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Removed." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown model." } } });
const actionRoute = createRoute({ method: "post", path: "/{id}/actions", tags: ["Models"], summary: "Load, unload, pin or unpin a model", request: { params: idParamSchema("id"), body: { content: { "application/json": { schema: ActionSchema } } } }, responses: { 200: { content: { "application/json": { schema: z.object({ modelId: z.string(), ok: z.boolean(), reason: z.string().optional() }) } }, description: "The outcome." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown model." } } });
const catalogRoute = createRoute({ method: "get", path: "/catalog", tags: ["Models"], summary: "The pinned models this build ships", responses: { 200: { content: { "application/json": { schema: z.object({ models: z.array(z.record(z.string(), z.unknown())) }) } }, description: "The Stack's own pins (the Catalog index adds more once fetched)." } } });

export function modelView(model: ModelRecord) {
  const fileMissing = model.modelPath !== null && !existsSync(model.modelPath);
  return { id: model.id, roles: model.roles, state: model.modelPath && !fileMissing && readModelManifest(model.id) ? "installed" as const : "notInstalled" as const, runtimeState: loadedRoleForModel(model.id) ? "loaded" as const : "ready" as const, pinned: isModelPinned(model.id), sizeBytes: model.sizeBytes, fileMissing, measuredFootprintBytes: model.measuredFootprintBytes, measuredContextLength: model.measuredContextLength, estimated: model.measuredFootprintBytes === null, source: model.source, licence: model.licence, revision: model.revision, sha256: model.sha256, provenance: model.provenance, modelPath: model.modelPath, installedAt: model.installedAt, verifiedAt: model.verifiedAt };
}

export const modelsRoutes = apiRouter<AppEnv>();
modelsRoutes.openapi(listRoute, (c) => c.json({ models: listModels().map(modelView) }, 200));
modelsRoutes.openapi(catalogRoute, (c) => c.json({ models: [STACK_CHAT_MODEL as unknown as Record<string, unknown>] }, 200));
modelsRoutes.openapi(pullRoute, (c) => {
  const body = c.req.valid("json");
  const indexed = catalogModelForId(body.id);
  const model = { id: body.id, role: body.role, repo: body.repo ?? indexed?.repo, license: body.licence, revision: body.revision, engine: body.engine ?? indexed?.engine, sizing: indexed?.sizing, download: { url: body.url, sha256: body.sha256, approx_bytes: body.approx_bytes ?? indexed?.download?.approx_bytes ?? 0 } };
  const job = createJob({ kind: "model.install", role: body.role, totalBytes: model.download.approx_bytes, status: "downloading", input: { model: body.id } });
  // One directory per model id: two pins whose URLs end in the same file
  // name never share a path.
  const destination = join(modelsDir, body.id, basename(new URL(body.url).pathname) || `${body.id}.gguf`);
  void installCatalogModel(model, { destination, signal: jobSignal(job.id), onProgress: (progress) => { updateJob(job.id, { completedBytes: progress.completedBytes, totalBytes: progress.totalBytes || model.download.approx_bytes, status: progress.status }); } })
    .then((installed) => finishJob(job.id, { ok: true, result: { model: installed.id } }))
    .catch((error) => finishJob(job.id, { ok: false, reason: error instanceof Error ? error.message : String(error) }));
  return c.json({ job: job.id, model: body.id }, 202);
});
modelsRoutes.openapi(importRoute, (c) => {
  const body = c.req.valid("json");
  try {
    const manifest = importPath(body.path, { id: body.id, roles: body.roles, licence: body.licence, revision: body.revision });
    const now = new Date().toISOString();
    const record = upsertModel({ id: manifest.id, roles: body.roles, source: "huggingface", provenance: { source: manifest.source, path: manifest.sourcePath }, revision: manifest.revision ?? "import", sha256: manifest.blobs[0]?.digest ?? null, sizeBytes: manifest.sizeBytes, licence: body.licence, modelPath: manifest.blobs[0]?.path ?? null, installedAt: now, verifiedAt: now });
    return c.json(modelView(record), 200);
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
});
modelsRoutes.openapi(removeRoute, (c) => removeModel(c.req.valid("param").id) ? c.json({ ok: true as const }, 200) : c.json({ error: "Unknown model" }, 404));
modelsRoutes.openapi(actionRoute, async (c) => {
  const id = c.req.valid("param").id; const { action } = c.req.valid("json");
  const model = listModels().find((entry) => entry.id === id);
  if (!model) return c.json({ error: "Unknown model" }, 404);
  const role = model.roles[0];
  try {
    if (action === "pin" || action === "unpin") { pinModel(id, action === "pin"); return c.json({ modelId: id, ok: true }, 200); }
    if (!role) return c.json({ modelId: id, ok: false, reason: "The model declares no role." }, 200);
    if (action === "load") { preferModel(role, id); await restartRole(role); const started = await getProcess(role); return c.json(started.modelId === id ? { modelId: id, ok: true } : { modelId: id, ok: false, reason: `The ${role} role loaded ${started.modelId ?? "another model"} instead.` }, 200); }
    if (loadedRoleForModel(id) !== null) await unloadRole(role, "Unloaded by Home.");
    return c.json({ modelId: id, ok: true }, 200);
  } catch (error) { return c.json({ modelId: id, ok: false, reason: error instanceof EngineUnavailableError ? error.reason : (error as Error).message }, 200); }
});
