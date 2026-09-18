import { apiReference } from "@scalar/hono-api-reference";
import { createRoute, z } from "@hono/zod-openapi";
import { serveStatic } from "hono/bun";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { apiRouter } from "@/lib/openapi";
import { hardwareRoutes } from "@/routes/hardware";
import { enginesRoutes } from "@/routes/engines";
import { rolesRoutes } from "@/routes/roles";
import { inferenceRoutes } from "@/routes/inference";
import { operatorRoutes } from "@/routes/operator";
import { clientsRoutes } from "@/routes/clients";
import { setupPlanRoutes } from "@/routes/setupPlan";
import { modelsRoutes } from "@/routes/models";
import { storageRoutes } from "@/routes/storage";
import { jobsRoutes } from "@/routes/jobs";
import { updatesRoutes } from "@/routes/updates";
import { migrateLegacyStore } from "@/lib/store/migration";
import { budgetRoutes } from "@/routes/budget";
import { eventsRoutes } from "@/routes/events";
import { logsRoutes } from "@/routes/logs";
import { seriesRoutes } from "@/routes/series";
import { groupsRoutes } from "@/routes/groups";
import { detectedRoutes } from "@/routes/detected";
import { settingsRoutes } from "@/routes/settings";
import { speedTestRoutes } from "@/routes/speedTest";
import { checkRoutes } from "@/routes/check";
import { runStateRoutes } from "@/routes/runState";
import { channelsRoutes } from "@/routes/channels";
import { catalogRoutes } from "@/routes/catalog";
import { libraryRoutes } from "@/routes/library";
import packageJson from "../../package.json";
import { assertShowroomAllowed } from "@/showroom/fixture";

assertShowroomAllowed();

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
app.route("/stack/v1/budget", budgetRoutes);
app.route("/stack/v1", eventsRoutes);
app.route("/stack/v1", channelsRoutes);
app.route("/stack/v1/library", libraryRoutes);
app.route("/stack/v1/logs", logsRoutes);
app.route("/stack/v1/series", seriesRoutes);
app.route("/stack/v1/groups", groupsRoutes);
app.route("/stack/v1/detected", detectedRoutes);
app.route("/stack/v1/roles", rolesRoutes);
app.route("/stack/v1/operator", operatorRoutes);
app.route("/stack/v1/clients", clientsRoutes);
app.route("/stack/v1/setup/plan", setupPlanRoutes);
app.route("/stack/v1/models", modelsRoutes);
app.route("/stack/v1/catalog", catalogRoutes);
app.route("/stack/v1/storage", storageRoutes);
app.route("/stack/v1/jobs", jobsRoutes);
app.route("/stack/v1/updates", updatesRoutes);
app.route("/stack/v1/settings", settingsRoutes);
app.route("/stack/v1/speed-test", speedTestRoutes);
app.route("/stack/v1/check", checkRoutes);
app.route("/stack/v1/run-state", runStateRoutes);
app.route("/v1", inferenceRoutes);

migrateLegacyStore();

const here = dirname(fileURLToPath(import.meta.url));
const embeddedAssets = new Map<string, Blob>();
for (const asset of Bun.embeddedFiles ?? []) {
  const name = (asset as Blob & { name: string }).name.replaceAll("\\", "/").replace(/^.*\/frontend\/dist\//, "");
  const cleanName = name.replace(/^\/+/, "");
  embeddedAssets.set(`/${cleanName}`, asset);
  embeddedAssets.set(`/assets/${cleanName.split("/").pop() ?? cleanName}`, asset);
}

function contentType(path: string): string {
  return path.endsWith(".html") ? "text/html; charset=utf-8" : path.endsWith(".js") ? "text/javascript; charset=utf-8" : path.endsWith(".css") ? "text/css; charset=utf-8" : path.endsWith(".json") ? "application/json" : path.endsWith(".svg") ? "image/svg+xml" : path.endsWith(".png") ? "image/png" : "application/octet-stream";
}

// Hashed asset names are immutable; index.html is revalidated on every load
// so a rebuilt UI is never served stale.
function cacheControl(path: string): string {
  return path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
}

app.use("/*", async (c, next) => {
  const path = c.req.path === "/" ? "/index.html" : c.req.path;
  const asset = embeddedAssets.get(path);
  if (asset) return new Response(asset, { headers: { "content-type": contentType(path), "cache-control": cacheControl(path) } });
  await next();
});

// The daemon owns the API and the built UI on one origin. Checking the
// filesystem per request lets a deploy build the frontend after the daemon
// has started without leaving the process stuck in a 404 state.
app.use("/*", async (c, next) => {
  const distDir = process.env.STACK_DIST_DIR ?? join(here, "..", "..", "frontend", "dist");
  const handler = serveStatic({
    root: distDir,
    onFound: (path, ctx) => {
      ctx.header("Cache-Control", cacheControl(ctx.req.path));
    },
  });
  return handler(c, next);
});
app.get("*", async (c) => {
  if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/stack/") || c.req.path.startsWith("/v1/")) return c.notFound();
  const distDir = process.env.STACK_DIST_DIR ?? join(here, "..", "..", "frontend", "dist");
  const indexPath = join(distDir, "index.html");
  const embeddedIndex = embeddedAssets.get("/index.html");
  if (embeddedIndex) return c.html(await embeddedIndex.text(), 200, { "cache-control": "no-cache" });
  if (!existsSync(indexPath)) return c.text("UI not built", 503);
  return c.html(await Bun.file(indexPath).text(), 200, { "cache-control": "no-cache" });
});
