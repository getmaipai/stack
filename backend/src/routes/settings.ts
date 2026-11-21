import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { applyPendingSettings, readSettings, SETTING_SECTIONS, updateSettings } from "@/settings";
import { ROLE_IDS, ROLES } from "@/roles";
import { auditAction, remoteOf, sourceOf } from "@/lib/adminActions";
import { roleDisabledReason } from "@/lib/roleSwitches";
import { unloadRole } from "@/lib/supervisor";
import { StackSetting } from "@maipai/spec/stack/ts/stack-setting.js";

const ResponseSchema = z.object({ sections: z.array(z.object({ id: z.string(), label: z.string() })), settings: z.array(StackSetting) });

const readRoute = createRoute({ method: "get", path: "/", tags: ["Settings"], summary: "The settings declaration with values", responses: { 200: { content: { "application/json": { schema: ResponseSchema } }, description: "Every declared key with its in-effect and pending value." } } });
const updateRoute = createRoute({ method: "put", path: "/", tags: ["Settings"], summary: "Store values (validated against the declaration)", request: { body: { content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } } }, responses: { 200: { content: { "application/json": { schema: ResponseSchema } }, description: "The declaration after the change." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown key or invalid value." } } });
const applyRoute = createRoute({ method: "post", path: "/apply", tags: ["Settings"], summary: "Promote pending values (Home restarts the service)", responses: { 200: { content: { "application/json": { schema: ResponseSchema } }, description: "Pending values are now in effect." } } });

export const settingsRoutes = apiRouter<AppEnv>();
settingsRoutes.openapi(readRoute, (c) => c.json({ sections: [...SETTING_SECTIONS], settings: readSettings() }, 200));
settingsRoutes.openapi(updateRoute, async (c) => {
  try {
    const body = c.req.valid("json");
    const before = new Map(ROLE_IDS.map((role) => [role, roleDisabledReason(role) === null]));
    const settings = updateSettings(body);
    // ADMIN-04: a role turned off or on, or reordered, is an admin action: logged with time and source, and a running engine of a turned-off role is unloaded now.
    const roleKeys = Object.keys(body).filter((key) => key.startsWith("stack.roles."));
    if (roleKeys.length > 0) auditAction("roles.update", sourceOf(c), remoteOf(c), { changes: roleKeys.map((key) => `${key}=${String(body[key])}`).join(",") });
    for (const role of ROLE_IDS) {
      const reason = roleDisabledReason(role);
      // judge and router share chat's process: turning them off must not unload chat.
      if (reason !== null && before.get(role) && !("sharesModelWith" in ROLES[role])) await unloadRole(role, reason, "route-engines-stop");
    }
    return c.json({ sections: [...SETTING_SECTIONS], settings }, 200);
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Invalid setting" }, 400); }
});
settingsRoutes.openapi(applyRoute, (c) => c.json({ sections: [...SETTING_SECTIONS], settings: applyPendingSettings() }, 200));
