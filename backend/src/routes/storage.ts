import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@/lib/openapi";
import { requireClientOrOperator } from "@/lib/clients";
import { storageAccounting } from "@/lib/store/storage";

const StorageSchema = z.object({ totalBytes: z.number().int(), byCategory: z.object({ models: z.number().int(), engines: z.number().int(), logs: z.number().int(), backups: z.number().int(), other: z.number().int() }), models: z.object({ byAbility: z.record(z.string(), z.number().int()), sharedBytes: z.number().int() }), freeDiskBytes: z.number().int(), updatedAt: z.string() });
const storageRoute = createRoute({ method: "get", path: "/", tags: ["Storage"], summary: "Storage accounting", middleware: [requireClientOrOperator] as const, responses: { 200: { content: { "application/json": { schema: StorageSchema } }, description: "Current physical storage usage." } } });
export const storageRoutes = apiRouter();
storageRoutes.openapi(storageRoute, (c) => c.json(storageAccounting(), 200));
