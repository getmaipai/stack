import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema } from "@/lib/openapi";
import { requireOperator } from "@/lib/operator";
import { readStackConfig, updateStackConfig } from "@/settings/stackKeys";

const settingSchema = z.object({
  key: z.string(), type: z.enum(["number", "boolean", "text", "enum"]), default: z.union([z.string(), z.number(), z.boolean()]), group: z.string().optional(), options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  label: z.string(), help: z.string(), disclosure: z.enum(["basic", "advanced", "developer"]), needsRestart: z.boolean(), range: z.object({ min: z.number().optional(), max: z.number().optional() }).optional(),
  inEffect: z.union([z.string(), z.number(), z.boolean()]), pending: z.union([z.string(), z.number(), z.boolean()]).nullable(),
});

const readRoute = createRoute({ method: "get", path: "/", tags: ["Settings"], summary: "Read Stack settings", middleware: [requireOperator] as const, responses: { 200: { content: { "application/json": { schema: z.object({ settings: z.array(settingSchema) }) } }, description: "Declared and effective Stack settings." } } });
const updateRoute = createRoute({ method: "put", path: "/", tags: ["Settings"], summary: "Update Stack settings", middleware: [requireOperator] as const, request: { body: { content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } } }, responses: { 200: { content: { "application/json": { schema: z.object({ settings: z.array(settingSchema) }) } }, description: "Updated Stack settings." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "Invalid Stack setting." } } });

export const settingsRoutes = apiRouter();
settingsRoutes.openapi(readRoute, (c) => c.json({ settings: readStackConfig() }, 200));
settingsRoutes.openapi(updateRoute, (c) => { try { return c.json({ settings: updateStackConfig(c.req.valid("json")) }, 200); } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Invalid Stack setting" }, 400); } });
