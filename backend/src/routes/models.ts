// The model list with provenance, install and runtime state; install by
// pin, import a verified local file, remove, and the load, unload, pin
// and unpin actions. Nothing installs without url, sha256, licence and
// revision (goal 4).
import { createRoute, z } from "@hono/zod-openapi";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { apiRouter, ErrorSchema, idParamSchema } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { installCatalogModel, listModels, ModelSourceSchema, refuseUnsafeModelId, removeModel, upsertModel, type CatalogModelLike, type ModelRecord } from "@/lib/modelStore";
import { readModelManifest } from "@/lib/store/manifests";
import { modelsRoot } from "@/lib/store/layout";
import { raise } from "@/lib/health";
import { importPath } from "@/lib/store/importScan";
import { modelsDir } from "@/lib/paths";
import { RoleIdSchema } from "@/roles";
import { createJob, finishJob, jobSignal, updateJob } from "@/lib/jobs";
import { catalogModelForId } from "@/updates/catalog";
import { getProcess, isModelPinned, loadedRoleForModel, pinModel, preferModel, restartRole, unloadRole, EngineUnavailableError } from "@/lib/supervisor";
import { STACK_MODELS, STACK_WAKEWORD_MODELS } from "@/lib/modelCatalog";

const ModelSchema = z.object({
  id: z.string(), roles: z.array(z.string()), state: z.enum(["notInstalled", "installed"]), runtimeState: z.enum(["loaded", "ready"]), pinned: z.boolean(),
  sizeBytes: z.number().int().nullable(), fileMissing: z.boolean(), measuredFootprintBytes: z.number().int().nullable(), measuredContextLength: z.number().int().nullable(), estimated: z.boolean(),
  source: z.string(), licence: z.string().nullable(), revision: z.string(), sha256: z.string().nullable(), provenance: z.record(z.string(), z.unknown()), modelPath: z.string().nullable(), installedAt: z.string().nullable(), verifiedAt: z.string().nullable(),
});
const PullSchema = z.object({ id: z.string(), role: RoleIdSchema, repo: z.string().optional(), url: z.string().url(), sha256: z.string().length(64), approx_bytes: z.number().int().nonnegative().optional(), licence: z.string(), revision: z.string(), engine: z.string().optional(), archive: z.boolean().optional(), hub_file: z.string().optional(), component: z.string().optional() });
const ImportSchema = z.object({ id: z.string(), path: z.string(), roles: z.array(RoleIdSchema).min(1), licence: z.string(), revision: z.string().optional() });
const ActionSchema = z.object({ action: z.enum(["load", "unload", "pin", "unpin"]) });

const listRoute = createRoute({ method: "get", path: "/", tags: ["Models"], summary: "Installed and known models", responses: { 200: { content: { "application/json": { schema: z.object({ models: z.array(ModelSchema) }) } }, description: "Every model record with its provenance and state." } } });
const pullRoute = createRoute({ method: "post", path: "/", tags: ["Models"], summary: "Install a pinned model (progress on the event feed)", request: { body: { content: { "application/json": { schema: PullSchema } } } }, responses: { 202: { content: { "application/json": { schema: z.object({ job: z.string(), model: z.string() }) } }, description: "The download job." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "Provenance incomplete, or an id that is not a plain name." } } });
const importRoute = createRoute({ method: "post", path: "/import", tags: ["Models"], summary: "Import a local model file by verified link", request: { body: { content: { "application/json": { schema: ImportSchema } } } }, responses: { 200: { content: { "application/json": { schema: ModelSchema } }, description: "The imported model." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "The path is not a file." } } });
const removeRoute = createRoute({ method: "delete", path: "/{id}", tags: ["Models"], summary: "Remove a model", request: { params: idParamSchema("id") }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Removed." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown model." } } });
const actionRoute = createRoute({ method: "post", path: "/{id}/actions", tags: ["Models"], summary: "Load, unload, pin or unpin a model", request: { params: idParamSchema("id"), body: { content: { "application/json": { schema: ActionSchema } } } }, responses: { 200: { content: { "application/json": { schema: z.object({ modelId: z.string(), ok: z.boolean(), reason: z.string().optional() }) } }, description: "The outcome." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown model." } } });
const catalogRoute = createRoute({ method: "get", path: "/catalog", tags: ["Models"], summary: "The pinned models this build ships", responses: { 200: { content: { "application/json": { schema: z.object({ models: z.array(z.record(z.string(), z.unknown())) }) } }, description: "The Stack's own pins (the Catalog index adds more once fetched)." } } });
const wakewordFileRoute = createRoute({ method: "get", path: "/{id}/file", tags: ["Models"], summary: "Read a verified installed wakeword asset for Home", request: { params: idParamSchema("id") }, responses: { 200: { content: { "application/octet-stream": { schema: z.string() } }, description: "Verified bytes of an installed pinned wakeword asset." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "The id is not a wakeword asset or it is not installed." }, 503: { content: { "application/json": { schema: ErrorSchema } }, description: "The installed bytes failed checksum verification." } } });

export function modelView(model: ModelRecord) {
  const fileMissing = model.modelPath !== null && !existsSync(model.modelPath);
  return { id: model.id, roles: model.roles, state: model.modelPath && !fileMissing && readModelManifest(model.id) ? "installed" as const : "notInstalled" as const, runtimeState: loadedRoleForModel(model.id) ? "loaded" as const : "ready" as const, pinned: isModelPinned(model.id), sizeBytes: model.sizeBytes, fileMissing, measuredFootprintBytes: model.measuredFootprintBytes, measuredContextLength: model.measuredContextLength, estimated: model.measuredFootprintBytes === null, source: model.source, licence: model.licence, revision: model.revision, sha256: model.sha256, provenance: model.provenance, modelPath: model.modelPath, installedAt: model.installedAt, verifiedAt: model.verifiedAt };
}

/** What a pull installs: the body's fields, and what it leaves out from
 * the Catalog's index entry or the Stack's own shipped pin for that id
 * (a package's archive flag, a hub file's placement, a component's
 * kind, a directory model's file list), so an install by id lands the
 * way the pin says. A directory model's files come from the pin that
 * has them: the Catalog's entry when it carries them, else the shipped
 * pin, so an index entry without them never turns the model into one
 * file. */
export function pullSpec(body: z.infer<typeof PullSchema>): CatalogModelLike & { download: NonNullable<CatalogModelLike["download"]> } {
  const catalogEntry = catalogModelForId(body.id);
  const shipped = STACK_MODELS.find((pin) => pin.id === body.id) ?? null;
  const indexed = catalogEntry ?? shipped;
  // The shipped list stands in only for the same revision: another
  // revision's files would be verified against hashes that are not theirs.
  const directoryPin = catalogEntry?.download?.files ? catalogEntry : shipped?.download?.files && body.revision === shipped.revision ? shipped : null;
  // What a record declares about itself (picture input, its own launch,
  // its card's sampling) comes only from the pin whose file this is: a
  // caller's body never declares image input for a file nobody proved.
  const samePin = [catalogEntry, shipped].find((pin) => pin?.download?.sha256?.toLowerCase() === body.sha256.toLowerCase() && pin?.revision === body.revision && (pin.imageInput || pin.launch || pin.sampling)) ?? null;
  return { id: body.id, role: body.role, repo: body.repo ?? indexed?.repo, license: body.licence, revision: body.revision, engine: body.engine ?? indexed?.engine, sizing: indexed?.sizing, component: body.component ?? indexed?.component, ...(samePin?.imageInput ? { imageInput: samePin.imageInput } : {}), ...(samePin?.launch ? { launch: samePin.launch } : {}), ...(samePin?.sampling ? { sampling: samePin.sampling } : {}), download: { url: body.url, sha256: body.sha256, approx_bytes: body.approx_bytes ?? indexed?.download?.approx_bytes ?? 0, archive: body.archive ?? indexed?.download?.archive, hub_file: body.hub_file ?? indexed?.download?.hub_file, directory: directoryPin?.download?.directory, files: directoryPin?.download?.files } };
}

export const modelsRoutes = apiRouter<AppEnv>();
modelsRoutes.openapi(listRoute, (c) => c.json({ models: listModels().map(modelView) }, 200));
modelsRoutes.openapi(catalogRoute, (c) => c.json({ models: STACK_MODELS as unknown as Record<string, unknown>[] }, 200));
modelsRoutes.openapi(wakewordFileRoute, (c) => {
  const id = c.req.valid("param").id;
  const pin = STACK_WAKEWORD_MODELS.find((model) => model.id === id);
  const record = listModels().find((model) => model.id === id);
  const manifest = readModelManifest(id);
  const blob = manifest?.blobs.length === 1 ? manifest.blobs[0] : null;
  if (!pin?.download || !record || !manifest || !blob || !record.verifiedAt || !record.roles.includes("wakeword") || record.engineRequirements.component !== "wakeword_asset" || !manifest.roles.includes("wakeword") || !existsSync(blob.path)) return c.json({ error: "Wakeword asset is not installed" }, 404);
  const expected = pin.download.sha256.toLowerCase();
  const path = resolve(blob.path);
  if (!path.startsWith(`${resolve(modelsRoot)}${sep}`) || record.sha256?.toLowerCase() !== expected || blob.digest.toLowerCase() !== expected) return c.json({ error: "Wakeword asset provenance is incomplete" }, 404);
  const bytes = readFileSync(path);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    raise({ code: "wakeword-asset-checksum-mismatch", severity: "error", title: "A wakeword asset failed verification", text: `The stored wakeword asset ${id} was not served because its checksum changed.`, cause: "The stored bytes no longer match the pinned SHA-256.", fix: { label: "Download again", action: "retry_download" } });
    return c.json({ error: "Wakeword asset failed checksum verification" }, 503);
  }
  return c.body(bytes, 200, { "content-type": "application/octet-stream", "content-length": String(bytes.byteLength), "content-disposition": `attachment; filename="${basename(new URL(pin.download.url).pathname)}"`, etag: `"${actual}"` });
});
modelsRoutes.openapi(pullRoute, (c) => {
  const body = c.req.valid("json");
  // The id names the model's directory under the store.
  try { refuseUnsafeModelId(body.id); } catch (error) { return c.json({ error: (error as Error).message }, 400); }
  const wakewordPin = STACK_WAKEWORD_MODELS.find((pin) => pin.id === body.id);
  if (wakewordPin) {
    const pin = wakewordPin;
    if (!pin.download || body.role !== pin.role || body.url !== pin.download.url || body.sha256.toLowerCase() !== pin.download.sha256.toLowerCase() || body.licence !== pin.license || body.revision !== pin.revision || (body.repo !== undefined && body.repo !== pin.repo) || (body.approx_bytes !== undefined && body.approx_bytes !== pin.download.approx_bytes) || (body.component !== undefined && body.component !== pin.component)) return c.json({ error: "Wakeword assets must be installed using the shipped pin." }, 400);
  }
  const model = pullSpec(body);
  // An MLX model is a directory; a pull that resolved no file list for
  // one would install a lone weights file no engine can launch.
  if (model.engine === "mlx-serve" && !model.download.files) return c.json({ error: `${body.id} is an MLX model and needs its pinned file list; none is known for revision ${body.revision}.` }, 400);
  const job = createJob({ kind: "model.install", role: body.role, totalBytes: model.download.approx_bytes, status: "downloading", input: { model: body.id } });
  // One directory per model id: two pins whose URLs end in the same file
  // name never share a path.
  const destination = join(modelsDir, body.id, basename(new URL(body.url).pathname) || `${body.id}.gguf`);
  void installCatalogModel(model, { destination, signal: jobSignal(job.id), onProgress: (progress) => { updateJob(job.id, { completedBytes: progress.completedBytes, totalBytes: progress.totalBytes || model.download.approx_bytes, status: progress.status }); } })
    .then((installed) => finishJob(job.id, { ok: true, result: { model: installed.id } }))
    .catch((error) => finishJob(job.id, { ok: false, reason: error instanceof Error ? error.message : String(error) }));
  return c.json({ job: job.id, model: body.id }, 202);
});
modelsRoutes.openapi(importRoute, async (c) => {
  const body = c.req.valid("json");
  try {
    refuseUnsafeModelId(body.id);
    const manifest = await importPath(body.path, { id: body.id, roles: body.roles, licence: body.licence, revision: body.revision });
    const now = new Date().toISOString();
    const record = upsertModel({ id: manifest.id, roles: body.roles, source: ModelSourceSchema.parse(manifest.source), provenance: { source: manifest.source, path: manifest.sourcePath }, revision: manifest.revision ?? "import", sha256: manifest.blobs[0]?.digest ?? null, sizeBytes: manifest.sizeBytes, licence: body.licence, modelPath: manifest.blobs[0]?.path ?? null, installedAt: now, verifiedAt: now });
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
