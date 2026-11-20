import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { latestDisk, missingModelFiles } from "@/lib/diskState";
const Volume = z.object({ path: z.string(), free_bytes: z.number(), total_bytes: z.number(), level: z.enum(["normal", "warn", "critical"]), warn_bytes: z.number(), critical_bytes: z.number() });
const route = createRoute({ method: "get", path: "/", tags: ["Disk"], summary: "Disk space and selected model files", responses: { 200: { content: { "application/json": { schema: z.object({ level: z.enum(["normal", "warn", "critical"]), volumes: z.array(Volume), missing: z.array(z.object({ role: z.string(), model: z.string(), missing_paths: z.array(z.string()) })) }) } }, description: "Current disk volume levels and missing files for selected models." } } });
export const diskRoutes = apiRouter<AppEnv>();
diskRoutes.openapi(route, (c) => c.json({ ...latestDisk(), missing: missingModelFiles() }, 200));
