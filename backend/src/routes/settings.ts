import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema } from "@/lib/openapi";
import { requireOperator } from "@/lib/operator";
import { activateStackConfig, readStackConfig, STACK_SETTING_SECTIONS, STACK_SETTINGS, updateStackConfig } from "@/settings/stackKeys";

const settingSchema = z.object({
  key: z.string(), type: z.enum(["number", "boolean", "text", "secret", "password", "enum"]), default: z.union([z.string(), z.number(), z.boolean()]), group: z.string().optional(), options: z.array(z.object({ value: z.string(), label: z.string() })).optional(), section: z.string().optional(), order: z.number().optional(),
  label: z.string(), help: z.string(), disclosure: z.enum(["basic", "advanced", "developer"]), needsRestart: z.boolean(), range: z.object({ min: z.number().optional(), max: z.number().optional() }).optional(),
  inEffect: z.union([z.string(), z.number(), z.boolean()]), pending: z.union([z.string(), z.number(), z.boolean()]).nullable(),
});

const readRoute = createRoute({ method: "get", path: "/", tags: ["Settings"], summary: "Read Stack settings", middleware: [requireOperator] as const, responses: { 200: { content: { "application/json": { schema: z.object({ settings: z.array(settingSchema) }) } }, description: "Declared and effective Stack settings." } } });
const updateRoute = createRoute({ method: "put", path: "/", tags: ["Settings"], summary: "Update Stack settings", middleware: [requireOperator] as const, request: { body: { content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } } }, responses: { 200: { content: { "application/json": { schema: z.object({ settings: z.array(settingSchema) }) } }, description: "Updated Stack settings." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "Invalid Stack setting." }, 409: { content: { "application/json": { schema: ErrorSchema.extend({ setPasswordFirst: z.boolean().optional() }) } }, description: "Operator password required before LAN access." } } });
const indexRoute = createRoute({ method: "get", path: "/index", tags: ["Settings"], summary: "Read the Stack settings index", middleware: [requireOperator] as const, responses: { 200: { content: { "application/json": { schema: z.object({ sections: z.array(z.unknown()), settings: z.array(z.unknown()) }) } }, description: "Declared settings index." } } });
const applyRoute = createRoute({ method: "post", path: "/apply", tags: ["Settings"], summary: "Apply pending Stack settings", middleware: [requireOperator] as const, responses: { 200: { content: { "application/json": { schema: z.object({ settings: z.array(settingSchema) }) } }, description: "Applied pending settings." } } });

export const settingsRoutes = apiRouter();
settingsRoutes.openapi(readRoute, (c) => c.json({ settings: readStackConfig() }, 200));
settingsRoutes.openapi(updateRoute, (c) => { try { return c.json({ settings: updateStackConfig(c.req.valid("json")) }, 200); } catch (error) { const message = error instanceof Error ? error.message : "Invalid Stack setting"; if (message === "Set the operator password before opening the Stack to the LAN.") return c.json({ error: message, setPasswordFirst: true }, 409); return c.json({ error: message }, 400); } });
settingsRoutes.openapi(indexRoute, (c) => c.json({ sections: STACK_SETTING_SECTIONS, settings: STACK_SETTINGS.map(({ key, label, help, disclosure, section, order }) => ({ key, label, help, level: disclosure, section, order, path: `/settings/${section}` })) }, 200));
settingsRoutes.openapi(applyRoute, (c) => { activateStackConfig(); return c.json({ settings: readStackConfig() }, 200); });
