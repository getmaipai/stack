// The daemon's routes: the role routes on /v1, the control routes on
// /stack/v1, liveness on /healthz, the generated document and its
// explorer under /api. No static files, no auth middleware: loopback is
// the whole authentication (index.ts binds 127.0.0.1 and nothing else).
import { apiReference } from "@scalar/hono-api-reference";
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import packageJson from "../../package.json";
import { v1Routes } from "@/routes/v1";
import { rolesRoutes } from "@/routes/roles";
import { enginesRoutes } from "@/routes/engines";
import { modelsRoutes } from "@/routes/models";
import { jobsRoutes } from "@/routes/jobs";
import { healthRoutes } from "@/routes/health";
import { checkRoutes } from "@/routes/check";
import { updatesRoutes } from "@/routes/updates";
import { eventsRoutes } from "@/routes/events";
import { hardwareRoutes } from "@/routes/hardware";
import { settingsRoutes } from "@/routes/settings";
import { declarationRoutes } from "@/routes/declarations";
import { speechRoutes, websocket } from "@/routes/speech";
import { SESSION_PATH } from "@/speech/server";

/** The websocket handler Bun.serve needs beside `app.fetch` for the
 * speech session; index.ts passes it through. */
export { websocket };

export const version = packageJson.version;
export const app = apiRouter<AppEnv>();

const livenessRoute = createRoute({
  method: "get", path: "/healthz", tags: ["Health"], summary: "Stack process liveness",
  responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true), version: z.string(), uptimeSeconds: z.number() }) } }, description: "The daemon is running; Home checks its pinned minimum version here." } },
});
app.openapi(livenessRoute, (c) => c.json({ ok: true as const, version, uptimeSeconds: process.uptime() }, 200));

app.doc("/api/openapi.json", { openapi: "3.0.0", info: { title: "MaiPai Stack API", version } });
app.get("/api/docs", apiReference({ url: "/api/openapi.json" }));

// The session route is mounted before the JSON role routes so the
// upgrade is never read as a POST body.
app.route(SESSION_PATH, speechRoutes);
app.route("/v1", v1Routes);
app.route("/stack/v1/roles", rolesRoutes);
app.route("/stack/v1/engines", enginesRoutes);
app.route("/stack/v1/models", modelsRoutes);
app.route("/stack/v1/jobs", jobsRoutes);
app.route("/stack/v1/health", healthRoutes);
app.route("/stack/v1/check", checkRoutes);
app.route("/stack/v1/updates", updatesRoutes);
app.route("/stack/v1", eventsRoutes);
app.route("/stack/v1/hardware", hardwareRoutes);
app.route("/stack/v1/settings", settingsRoutes);
app.route("/stack/v1", declarationRoutes);

app.notFound((c) => c.json({ error: "Not found" }, 404));
