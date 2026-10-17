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
import { installPlanRoutes } from "@/routes/installPlan";
import { settingsRoutes } from "@/routes/settings";
import { declarationRoutes } from "@/routes/declarations";
import { voicesRoutes } from "@/routes/voices";
import { fitPlanRoutes } from "@/routes/fitPlan";
import { warmupRoutes } from "@/routes/warmup";
import { searchRoutes } from "@/routes/search";
import { imageToolsRoutes } from "@/routes/imageTools";
import { registerImageToolJobs } from "@/imagetools/jobs";
import { videoRoutes } from "@/routes/video";
import { videoV1Routes } from "@/routes/videoGenerations";
import { registerVideoJobs } from "@/video/jobs";
import { imageRoutes } from "@/routes/image";
import { likenessRoutes } from "@/routes/likeness";
import { imageV1Routes } from "@/routes/imageGenerations";
import { registerImageJobs } from "@/images/jobs";
import { memoryRoutes } from "@/routes/memory";
import { isStopping } from "@/lib/lifecycle";
import { speechRoutes, websocket } from "@/routes/speech";
import { registerGenerators } from "@/generators";
import { SESSION_PATH } from "@/speech/server";

/** The websocket handler Bun.serve needs beside `app.fetch` for the
 * speech session; index.ts passes it through. */
export { websocket };

export const version = packageJson.version;
/** The wire contract number Home compares before it talks to this Stack.
 * Bumped only when a route or field is removed or repurposed. */
export const CONTRACT = 1;
export const app = apiRouter<AppEnv>();
// The generator runners exist from the first request; a role with no
// engine still answers the honest 503 through the route's bound check.
registerGenerators();
registerImageToolJobs();
registerVideoJobs();
registerImageJobs();

const livenessRoute = createRoute({
  method: "get", path: "/healthz", tags: ["Health"], summary: "Stack process liveness",
  responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true), version: z.string(), contract: z.number().int(), uptimeSeconds: z.number() }) } }, description: "The daemon is running; Home checks its pinned minimum version and the contract number here." } },
});
app.openapi(livenessRoute, (c) => c.json({ ok: true as const, version, contract: CONTRACT, uptimeSeconds: process.uptime() }, 200));

// While the Stack is shutting down (an update, a restart) a new request is
// told so plainly, with when to come back, instead of reaching a half-stopped
// engine and dropping mid-answer. Liveness stays answerable.
app.use("*", async (c, next) => {
  if (isStopping() && c.req.path !== "/healthz") {
    return c.json({ error: "The Stack is restarting. Try again in a few seconds.", code: "stack_restarting" }, 503, { "Retry-After": "5" });
  }
  await next();
});

app.doc("/api/openapi.json", { openapi: "3.0.0", info: { title: "MaiPai Stack API", version } });
app.get("/api/docs", apiReference({ url: "/api/openapi.json" }));

// The session route is mounted before the JSON role routes so the
// upgrade is never read as a POST body.
app.route(SESSION_PATH, speechRoutes);
app.route("/v1", v1Routes);
app.route("/v1/videos", videoV1Routes);
app.route("/v1/images", imageV1Routes);
app.route("/stack/v1/roles", rolesRoutes);
app.route("/stack/v1/engines", enginesRoutes);
app.route("/stack/v1/models", modelsRoutes);
app.route("/stack/v1/jobs", jobsRoutes);
app.route("/stack/v1/health", healthRoutes);
app.route("/stack/v1/check", checkRoutes);
app.route("/stack/v1/updates", updatesRoutes);
app.route("/stack/v1", eventsRoutes);
app.route("/stack/v1/hardware", hardwareRoutes);
app.route("/stack/v1/memory", memoryRoutes);
app.route("/stack/v1/install-plan", installPlanRoutes);
app.route("/stack/v1/fit-plan", fitPlanRoutes);
app.route("/stack/v1/warmup", warmupRoutes);
app.route("/stack/v1/search", searchRoutes);
app.route("/stack/v1/image-tools", imageToolsRoutes);
app.route("/stack/v1/video", videoRoutes);
app.route("/stack/v1/image", imageRoutes);
app.route("/stack/v1/likeness", likenessRoutes);
app.route("/stack/v1/settings", settingsRoutes);
app.route("/stack/v1", declarationRoutes);
app.route("/stack/v1/voices", voicesRoutes);

app.notFound((c) => c.json({ error: "Not found" }, 404));
