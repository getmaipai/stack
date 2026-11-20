import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { getDiskConfig, latestDisk, missingModelFiles, setDiskConfig } from "@/lib/diskState";
const Volume = z.object({ path: z.string(), free_bytes: z.number(), total_bytes: z.number(), level: z.enum(["normal", "warn", "critical"]), warn_bytes: z.number(), critical_bytes: z.number() });
const route = createRoute({ method: "get", path: "/", tags: ["Disk"], summary: "Disk space and selected model files", responses: { 200: { content: { "application/json": { schema: z.object({ level: z.enum(["normal", "warn", "critical"]), volumes: z.array(Volume), missing: z.array(z.object({ role: z.string(), model: z.string(), missing_paths: z.array(z.string()) })) }) } }, description: "Current disk volume levels and missing files for selected models." } } });
const configRoute = createRoute({
  method: "post", path: "/config", tags: ["Disk"], summary: "Set runtime disk thresholds",
  request: { body: { content: { "application/json": { schema: z.object({ warn_free_gb: z.number().min(0), critical_free_gb: z.number().min(0) }) } } } },
  responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true), config: z.object({ warn_free_gb: z.number(), critical_free_gb: z.number() }) }) } }, description: "In-memory thresholds, reset to zero on restart." } },
});
export const diskRoutes = apiRouter<AppEnv>();
diskRoutes.openapi(route, async (c) => c.json({ ...await latestDisk(), missing: missingModelFiles() }, 200));
diskRoutes.openapi(configRoute, (c) => { const config = c.req.valid("json"); setDiskConfig(config); return c.json({ ok: true as const, config: getDiskConfig() }, 200); });
