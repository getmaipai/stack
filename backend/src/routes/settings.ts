import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { applyPendingSettings, readSettings, SETTING_SECTIONS, updateSettings } from "@/settings";
import { StackSetting } from "@maipai/spec/stack/ts/stack-setting.js";

const ResponseSchema = z.object({ sections: z.array(z.object({ id: z.string(), label: z.string() })), settings: z.array(StackSetting) });

const readRoute = createRoute({ method: "get", path: "/", tags: ["Settings"], summary: "The settings declaration with values", responses: { 200: { content: { "application/json": { schema: ResponseSchema } }, description: "Every declared key with its in-effect and pending value." } } });
const updateRoute = createRoute({ method: "put", path: "/", tags: ["Settings"], summary: "Store values (validated against the declaration)", request: { body: { content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } } }, responses: { 200: { content: { "application/json": { schema: ResponseSchema } }, description: "The declaration after the change." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown key or invalid value." } } });
const applyRoute = createRoute({ method: "post", path: "/apply", tags: ["Settings"], summary: "Promote pending values (Home restarts the service)", responses: { 200: { content: { "application/json": { schema: ResponseSchema } }, description: "Pending values are now in effect." } } });

export const settingsRoutes = apiRouter<AppEnv>();
settingsRoutes.openapi(readRoute, (c) => c.json({ sections: [...SETTING_SECTIONS], settings: readSettings() }, 200));
settingsRoutes.openapi(updateRoute, (c) => { try { return c.json({ sections: [...SETTING_SECTIONS], settings: updateSettings(c.req.valid("json")) }, 200); } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Invalid setting" }, 400); } });
settingsRoutes.openapi(applyRoute, (c) => c.json({ sections: [...SETTING_SECTIONS], settings: applyPendingSettings() }, 200));
