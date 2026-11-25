import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema, idParamSchema } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { addDisk, listDisks, removeDisk } from "@/lib/disks";
import { db } from "@/db";
import { moveJobs } from "@/db/schema";
import { desc } from "drizzle-orm";
import { featureOf, featureLocations, cancelBatch, modelIdsForFeature, planBatch, rolesForFeature, startBatch } from "@/lib/featureMoves";
import { resumeMoveJobs } from "@/lib/moveModels";
const Disk = z.object({ id: z.string(), label: z.string(), root_path: z.string(), connected: z.boolean(), free_bytes: z.number(), total_bytes: z.number(), removable: z.boolean() });
const list = createRoute({ method: "get", path: "/", tags: ["Disks"], summary: "List model drives", responses: { 200: { content: { "application/json": { schema: z.object({ disks: z.array(Disk) }) } }, description: "Main and added drives." } } });
const add = createRoute({ method: "post", path: "/", tags: ["Disks"], summary: "Add a model drive", request: { body: { content: { "application/json": { schema: z.object({ label: z.string(), root_path: z.string(), removable: z.boolean().default(false) }) } } } }, responses: { 201: { content: { "application/json": { schema: Disk } }, description: "Added drive." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "Invalid folder." } } });
const remove = createRoute({ method: "delete", path: "/{id}", tags: ["Disks"], request: { params: idParamSchema("id") }, summary: "Remove a model drive", responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Drive row removed." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "Drive contains model records." } } });
export const disksRoutes = apiRouter<AppEnv>();
disksRoutes.openapi(list, async (c) => c.json({ disks: await listDisks() }, 200));
disksRoutes.openapi(add, (c) => { try { return c.json(addDisk({ label: c.req.valid("json").label, rootPath: c.req.valid("json").root_path, removable: c.req.valid("json").removable }), 201); } catch (e) { return c.json({ error: e instanceof Error ? e.message : "Could not add drive." }, 400); } });
disksRoutes.openapi(remove, (c) => { try { removeDisk(c.req.valid("param").id); return c.json({ ok: true as const }, 200); } catch (e) { return c.json({ error: e instanceof Error ? e.message : "Could not remove drive." }, 400); } });
const Job = z.object({ id: z.string(), model_id: z.string(), feature_id: z.string().nullable(), from_disk: z.string(), to_disk: z.string(), state: z.string(), bytes_done: z.number(), bytes_total: z.number(), error: z.string().nullable(), updated_at: z.string() });
const moveBody = z.object({ feature_id: z.string().optional(), model_ids: z.array(z.string()).optional(), to_disk_id: z.string(), dry_run: z.boolean().default(false) });
const moveStart = createRoute({ method: "post", path: "/moves", tags: ["Disks"], summary: "Move a feature's model files to another drive (dry_run returns the plan only)", request: { body: { content: { "application/json": { schema: moveBody } } } }, responses: { 200: { content: { "application/json": { schema: z.object({ model_ids: z.array(z.string()), bytes: z.number(), started: z.boolean() }) } }, description: "The plan, and whether the move started." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "Why the move cannot start, in plain words." } } });
const moveList = createRoute({ method: "get", path: "/moves", tags: ["Disks"], summary: "Recent moves with progress", responses: { 200: { content: { "application/json": { schema: z.object({ moves: z.array(Job) }) } }, description: "Newest first." } } });
const moveCancel = createRoute({ method: "post", path: "/moves/cancel", tags: ["Disks"], summary: "Cancel the running move (only before the switch)", responses: { 200: { content: { "application/json": { schema: z.object({ cancelled: z.boolean() }) } }, description: "Whether a move was running." } } });
disksRoutes.openapi(moveStart, async (c) => {
  const body = c.req.valid("json");
  try {
    if (!body.feature_id && !body.model_ids?.length) throw new Error("Say which feature or which model files to move.");
    const ids = body.model_ids?.length ? body.model_ids : modelIdsForFeature(body.feature_id!);
    const plan = await planBatch(ids, body.to_disk_id);
    if (body.dry_run) return c.json({ model_ids: plan.model_ids, bytes: plan.bytes, started: false }, 200);
    void startBatch(ids, body.to_disk_id, body.feature_id ? rolesForFeature(body.feature_id) : []).catch(() => undefined);
    return c.json({ model_ids: plan.model_ids, bytes: plan.bytes, started: true }, 200);
  } catch (e) { return c.json({ error: e instanceof Error ? e.message : "The move could not start. Try again." }, 400); }
});
disksRoutes.openapi(moveList, (c) => c.json({ moves: db.select().from(moveJobs).orderBy(desc(moveJobs.updatedAt)).limit(30).all().map((j) => ({ id: j.id, model_id: j.modelId, feature_id: featureOf(j.modelId), from_disk: j.fromDisk, to_disk: j.toDisk, state: j.state, bytes_done: j.bytesDone, bytes_total: j.bytesTotal, error: j.error, updated_at: j.updatedAt })) }, 200));
disksRoutes.openapi(moveCancel, (c) => c.json({ cancelled: cancelBatch() }, 200));
export { resumeMoveJobs };
const Loc = z.object({ feature_id: z.string(), label: z.string(), bytes: z.number(), drive_ids: z.array(z.string()), drives: z.array(z.object({ id: z.string(), label: z.string(), connected: z.boolean() })) });
const locRoute = createRoute({ method: "get", path: "/features", tags: ["Disks"], summary: "Which drive each feature's files are on", responses: { 200: { content: { "application/json": { schema: z.object({ features: z.array(Loc) }) } }, description: "Features with installed files." } } });
disksRoutes.openapi(locRoute, (c) => c.json({ features: featureLocations() }, 200));
