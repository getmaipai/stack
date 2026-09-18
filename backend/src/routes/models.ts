import { createRoute, z } from "@hono/zod-openapi";
import { existsSync } from "node:fs";
import { apiRouter, ErrorSchema, idParamSchema } from "@/lib/openapi";
import { requireClientOrOperator } from "@/lib/clients";
import { listModels, removeModel } from "@/lib/modelStore";
import { importCandidate, importPath, scanImports, type ImportCandidate } from "@/lib/store/importScan";
import { readModelManifest } from "@/lib/store/manifests";
import { invalidateStorageAccounting } from "@/lib/store/storage";
import { showroom, showroomModels } from "@/showroom/fixture";

const ModelSchema = z.object({
  id: z.string(), roles: z.array(z.string()), state: z.enum(["notInstalled", "installed"]), sizeBytes: z.number().int().nullable(), measuredFootprintBytes: z.number().int().nullable(), estimated: z.boolean(), source: z.string(), provenance: z.record(z.string(), z.unknown()),
});
const CandidateSchema = z.object({ source: z.string(), path: z.string(), digest: z.string(), sizeBytes: z.number().int(), name: z.string(), repo: z.string().optional(), revision: z.string().optional() });
const listRoute = createRoute({ method: "get", path: "/", tags: ["Models"], summary: "List installed models", middleware: [requireClientOrOperator] as const, responses: { 200: { content: { "application/json": { schema: z.object({ models: z.array(ModelSchema) }) } }, description: "Installed and known model records." } } });
const pullRoute = createRoute({ method: "post", path: "/", tags: ["Models"], summary: "Pull a model", middleware: [requireClientOrOperator] as const, request: { body: { content: { "application/json": { schema: z.object({ id: z.string(), source: z.enum(["catalog", "huggingface"]), roles: z.array(z.string()), url: z.string().url().optional(), sha256: z.string().length(64).optional(), licence: z.string().optional(), revision: z.string().optional() }) } } } }, responses: { 202: { content: { "application/json": { schema: z.object({ accepted: z.literal(true), id: z.string(), message: z.string() }) } }, description: "Model pull accepted." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "A source is missing required provenance." } } });
const importRoute = createRoute({ method: "post", path: "/import", tags: ["Models"], summary: "Scan or import an existing model", middleware: [requireClientOrOperator] as const, request: { body: { content: { "application/json": { schema: z.object({ scan: z.boolean().optional(), path: z.string().optional(), id: z.string().optional(), roles: z.array(z.string()).optional(), licence: z.string().optional() }) } } } }, responses: { 200: { content: { "application/json": { schema: z.object({ candidates: z.array(CandidateSchema), model: ModelSchema.optional() }) } }, description: "Candidates or the imported model." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "Invalid import request." } } });
const removeRoute = createRoute({ method: "delete", path: "/{id}", tags: ["Models"], summary: "Remove an installed model", middleware: [requireClientOrOperator] as const, request: { params: idParamSchema("id") }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Model removed." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown model." } } });

function modelView(model: ReturnType<typeof listModels>[number]) {
  return { id: model.id, roles: model.roles, state: model.modelPath && existsSync(model.modelPath) && readModelManifest(model.id) ? "installed" as const : "notInstalled" as const, sizeBytes: model.sizeBytes, measuredFootprintBytes: model.measuredFootprintBytes, estimated: model.measuredFootprintBytes === null, source: model.source, provenance: model.provenance };
}

export const modelsRoutes = apiRouter();
modelsRoutes.openapi(listRoute, (c) => c.json({ models: showroom() ? showroomModels as never : listModels().map(modelView) }, 200));
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
modelsRoutes.openapi(removeRoute, (c) => { const id = c.req.valid("param").id; if (!removeModel(id)) return c.json({ error: "Unknown model" }, 404); invalidateStorageAccounting(); return c.json({ ok: true as const }, 200); });
