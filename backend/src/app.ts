import { apiReference } from "@scalar/hono-api-reference";
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@/lib/openapi";
import { hardwareRoutes } from "@/routes/hardware";
import { enginesRoutes } from "@/routes/engines";
import packageJson from "../../package.json";

export const version = packageJson.version;
export const app = apiRouter();

const healthRoute = createRoute({
  method: "get",
  path: "/healthz",
  tags: ["Health"],
  summary: "Stack process health",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            version: z.string(),
            uptimeSeconds: z.number(),
          }),
        },
      },
      description: "The Stack is running.",
    },
  },
});

app.openapi(healthRoute, (c) => c.json({ ok: true, version, uptimeSeconds: process.uptime() }, 200));

app.doc("/api/openapi.json", {
  openapi: "3.0.0",
  info: { title: "MaiPai Stack API", version },
});
app.get("/api/docs", apiReference({ url: "/api/openapi.json" }));
app.route("/stack/v1/hardware", hardwareRoutes);
app.route("/stack/v1/engines", enginesRoutes);
