import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@/lib/openapi";
import { requireClientOrOperator } from "@/lib/clients";
import { requireOperator } from "@/lib/operator";
import { cleanStorageHygiene, storageHygiene } from "@/lib/hygiene";
import { storageAccounting } from "@/lib/store/storage";
import { showroom, showroomStorage } from "@/showroom/fixture";

const StorageSchema = z.object({ totalBytes: z.number().int(), byCategory: z.object({ models: z.number().int(), engines: z.number().int(), logs: z.number().int(), backups: z.number().int(), other: z.number().int() }), models: z.object({ byAbility: z.record(z.string(), z.number().int()), sharedBytes: z.number().int() }), freeDiskBytes: z.number().int(), updatedAt: z.string() });
const HygieneItemSchema = z.object({ id: z.string(), kind: z.enum(["unused-model", "duplicate-file", "orphan-blob", "old-engine-build", "stale-log"]), what: z.string(), why: z.string(), sizeBytes: z.number().int() });
const HygieneSchema = z.object({ items: z.array(HygieneItemSchema), reclaimableBytes: z.number().int(), generatedAt: z.string() });
const storageRoute = createRoute({ method: "get", path: "/", tags: ["Storage"], summary: "Storage accounting", middleware: [requireClientOrOperator] as const, responses: { 200: { content: { "application/json": { schema: StorageSchema } }, description: "Current physical storage usage." } } });
const hygieneRoute = createRoute({ method: "get", path: "/hygiene", tags: ["Storage"], summary: "Storage cleanup report", middleware: [requireClientOrOperator] as const, responses: { 200: { content: { "application/json": { schema: HygieneSchema } }, description: "Items that can be safely removed." } } });
const cleanRoute = createRoute({ method: "post", path: "/hygiene/clean", tags: ["Storage"], summary: "Clean listed storage items", middleware: [requireOperator] as const, request: { body: { content: { "application/json": { schema: z.object({ ids: z.array(z.string()).min(1) }) } } } }, responses: { 200: { content: { "application/json": { schema: z.object({ removed: z.array(HygieneItemSchema) }) } }, description: "Only current report items were removed." }, 400: { content: { "application/json": { schema: z.object({ error: z.string() }) } }, description: "An item was not in the current report." } } });
export const storageRoutes = apiRouter();
storageRoutes.openapi(storageRoute, (c) => c.json(showroom() ? showroomStorage : storageAccounting(), 200));
storageRoutes.openapi(hygieneRoute, (c) => c.json(showroom() ? { items: [], reclaimableBytes: 2_100_000_000, generatedAt: new Date().toISOString() } : storageHygiene(), 200));
storageRoutes.openapi(cleanRoute, (c) => { try { return c.json({ removed: cleanStorageHygiene(c.req.valid("json").ids) }, 200); } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Cleanup could not run." }, 400); } });
