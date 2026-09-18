import { createRoute, z } from "@hono/zod-openapi";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { apiRouter, ErrorSchema, idParamSchema } from "@/lib/openapi";
import { requireClientOrOperator } from "@/lib/clients";
import { requireOperator } from "@/lib/operator";
import { listModels, removeModel } from "@/lib/modelStore";
import { getModelUsage, modelRuntimeState, performModelAction, updateModelPlacement } from "@/lib/modelGroups";
import { importCandidate, importPath, scanImports, type ImportCandidate } from "@/lib/store/importScan";
import { readModelManifest } from "@/lib/store/manifests";
import { invalidateStorageAccounting } from "@/lib/store/storage";
import { showroom, showroomModels } from "@/showroom/fixture";
import { modelsDir } from "@/lib/paths";
import { licenceInfo } from "@/lib/licences";

const ModelSchema = z.object({
  id: z.string(), nickname: z.string().nullable(), groupId: z.string().nullable(), roles: z.array(z.string()), state: z.enum(["notInstalled", "installed"]), runtimeState: z.enum(["loaded", "ready", "onDemand", "failed"]), sizeBytes: z.number().int().nullable(), measuredFootprintBytes: z.number().int().nullable(), estimated: z.boolean(), source: z.string(), licenceSentence: z.string(), licenceFlag: z.string(), licenceUrl: z.string().url().nullable(), provenance: z.record(z.string(), z.unknown()), usage: z.object({ modelId: z.string(), requests: z.number().int(), tokensIn: z.number().int(), tokensOut: z.number().int(), secondsLoaded: z.number().int(), peakMemoryBytes: z.number().int(), lastUsedAt: z.string().nullable() }),
});
const CandidateSchema = z.object({ source: z.string(), path: z.string(), digest: z.string(), sizeBytes: z.number().int(), name: z.string(), repo: z.string().optional(), revision: z.string().optional() });
const listRoute = createRoute({ method: "get", path: "/", tags: ["Models"], summary: "List installed models", middleware: [requireClientOrOperator] as const, responses: { 200: { content: { "application/json": { schema: z.object({ models: z.array(ModelSchema) }) } }, description: "Installed and known model records." } } });
const pullRoute = createRoute({ method: "post", path: "/", tags: ["Models"], summary: "Pull a model", middleware: [requireClientOrOperator] as const, request: { body: { content: { "application/json": { schema: z.object({ id: z.string(), source: z.enum(["catalog", "huggingface"]), roles: z.array(z.string()), url: z.string().url().optional(), sha256: z.string().length(64).optional(), licence: z.string().optional(), revision: z.string().optional() }) } } } }, responses: { 202: { content: { "application/json": { schema: z.object({ accepted: z.literal(true), id: z.string(), message: z.string() }) } }, description: "Model pull accepted." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "A source is missing required provenance." } } });
const importRoute = createRoute({ method: "post", path: "/import", tags: ["Models"], summary: "Scan or import an existing model", middleware: [requireClientOrOperator] as const, request: { body: { content: { "application/json": { schema: z.object({ scan: z.boolean().optional(), path: z.string().optional(), id: z.string().optional(), roles: z.array(z.string()).optional(), licence: z.string().optional() }) } } } }, responses: { 200: { content: { "application/json": { schema: z.object({ candidates: z.array(CandidateSchema), model: ModelSchema.optional() }) } }, description: "Candidates or the imported model." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "Invalid import request." } } });
const uploadRoute = createRoute({ method: "post", path: "/upload", tags: ["Models"], summary: "Upload a model from another device", middleware: [requireOperator] as const, request: { body: { content: { "multipart/form-data": { schema: z.object({ file: z.any() }) } } } }, responses: { 202: { content: { "application/json": { schema: z.object({ accepted: z.literal(true), id: z.string(), message: z.string() }) } }, description: "Upload accepted." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "No model file was uploaded." } } });
const removeRoute = createRoute({ method: "delete", path: "/{id}", tags: ["Models"], summary: "Remove an installed model", middleware: [requireClientOrOperator] as const, request: { params: idParamSchema("id") }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Model removed." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown model." } } });
const updateRoute = createRoute({ method: "patch", path: "/{id}", tags: ["Models"], summary: "Rename or move a model", middleware: [requireOperator] as const, request: { params: idParamSchema("id"), body: { content: { "application/json": { schema: z.object({ nickname: z.string().nullable().optional(), groupId: z.string().nullable().optional() }) } } } }, responses: { 200: { content: { "application/json": { schema: ModelSchema } }, description: "Updated model." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "Invalid model placement." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown model." } } });
const actionRoute = createRoute({ method: "post", path: "/{id}/actions", tags: ["Models"], summary: "Apply a model action", middleware: [requireOperator] as const, request: { params: idParamSchema("id"), body: { content: { "application/json": { schema: z.object({ action: z.enum(["load", "unload", "pin", "unpin", "checkUpdates"]) }) } } } }, responses: { 200: { content: { "application/json": { schema: z.object({ modelId: z.string(), ok: z.boolean(), reason: z.string().optional() }) } }, description: "Model action result." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown model." } } });

export function modelView(model: ReturnType<typeof listModels>[number]) {
  const info = licenceInfo(model.licence);
  return { id: model.id, nickname: model.nickname, groupId: model.groupId, roles: model.roles, state: model.modelPath && existsSync(model.modelPath) && readModelManifest(model.id) ? "installed" as const : "notInstalled" as const, runtimeState: modelRuntimeState(model), sizeBytes: model.sizeBytes, measuredFootprintBytes: model.measuredFootprintBytes, estimated: model.measuredFootprintBytes === null, source: model.source, licenceSentence: info.sentence, licenceFlag: info.flag, licenceUrl: info.url, provenance: model.provenance, usage: getModelUsage(model.id) };
}

function showroomModelView(model: typeof showroomModels[number]) {
  return { ...model, runtimeState: model.id === "qwen3-27b-instruct" || model.id === "qwen3-4b-kids" ? "loaded" as const : model.estimated ? "onDemand" as const : "ready" as const, usage: { modelId: model.id, requests: model.id.includes("qwen") ? 1842 : 16, tokensIn: 420, tokensOut: 690, secondsLoaded: model.id.includes("qwen") ? 18_420 : 3_600, peakMemoryBytes: model.measuredFootprintBytes ?? 0, lastUsedAt: new Date().toISOString() } };
}

export const modelsRoutes = apiRouter();
modelsRoutes.openapi(listRoute, (c) => c.json({ models: showroom() ? showroomModels.map(showroomModelView) as never : listModels().map(modelView) }, 200));
modelsRoutes.openapi(pullRoute, (c) => {
  const body = c.req.valid("json");
  if (!body.url || !body.sha256 || !body.licence || !body.revision) return c.json({ error: "pull requires url, sha256, licence, and revision before download" }, 400);
  return c.json({ accepted: true as const, id: body.id, message: "Pull is recorded as a resumable job by the download worker." }, 202);
});
modelsRoutes.openapi(importRoute, async (c) => {
  const body = c.req.valid("json");
  if (body.scan || !body.path) return c.json({ candidates: scanImports().map(({ source, path, digest, sizeBytes, name, repo, revision }) => ({ source, path, digest, sizeBytes, name, repo, revision })) }, 200);
  if (!body.id || !body.roles?.length) return c.json({ error: "id and roles are required to import a model" }, 400);
  const candidates = scanImports();
  const found: ImportCandidate | undefined = candidates.find((candidate) => candidate.path === body.path);
  const manifest = found ? importCandidate(found, { id: body.id, roles: body.roles, licence: body.licence }) : importPath(body.path, { id: body.id, roles: body.roles, licence: body.licence });
  invalidateStorageAccounting();
  const record = listModels().find((model) => model.id === body.id);
  return c.json({ candidates: [], model: record ? modelView(record) : { id: manifest.id, roles: manifest.roles, state: "installed" as const, sizeBytes: manifest.sizeBytes, measuredFootprintBytes: null, estimated: true, source: manifest.source, provenance: { path: manifest.sourcePath } } }, 200);
});
modelsRoutes.openapi(uploadRoute, async (c) => {
  const body = await c.req.parseBody(); const file = body.file;
  if (!(file instanceof File)) return c.json({ error: "A model file is required." }, 400);
  mkdirSync(modelsDir, { recursive: true }); const id = `upload-${crypto.randomUUID()}`; const destination = join(modelsDir, `${id}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "-")}`); await Bun.write(destination, await file.arrayBuffer());
  return c.json({ accepted: true as const, id, message: "The upload was stored locally. Select it from Import to assign roles and provenance." }, 202);
});
modelsRoutes.openapi(removeRoute, (c) => { const id = c.req.valid("param").id; if (!removeModel(id)) return c.json({ error: "Unknown model" }, 404); invalidateStorageAccounting(); return c.json({ ok: true as const }, 200); });
modelsRoutes.openapi(updateRoute, (c) => { try { const model = updateModelPlacement(c.req.valid("param").id, c.req.valid("json")); return c.json(modelView(model) as never, 200); } catch (error) { const message = error instanceof Error ? error.message : "Invalid model placement."; return c.json({ error: message }, message === "Unknown model." ? 404 : 400); } });
modelsRoutes.openapi(actionRoute, async (c) => { const model = listModels().find((entry) => entry.id === c.req.valid("param").id); if (!model) return c.json({ error: "Unknown model" }, 404); return c.json(await performModelAction(model, c.req.valid("json").action) as never, 200); });
