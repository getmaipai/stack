import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { adminAccess } from "@/lib/adminAccess";

const AccessSchema = z.object({
  tailscale: z.object({
    state: z.enum(["listening", "restart_pending", "no_address", "off"]),
    url: z.string().nullable(),
    address: z.string().nullable(),
    port: z.number().int(),
    message: z.string(),
  }),
});

const accessRoute = createRoute({ method: "get", path: "/", tags: ["Status"], summary: "Where the admin page can be opened from another computer (the Tailscale listener's real state)", responses: { 200: { content: { "application/json": { schema: AccessSchema } }, description: "The listener state, the sign-in page URL when it is up, and one plain sentence." } } });
export const adminAccessRoutes = apiRouter<AppEnv>();
adminAccessRoutes.openapi(accessRoute, (c) => c.json(adminAccess(), 200));
