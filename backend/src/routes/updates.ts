import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { checkCatalog, modelRecommendations, updatesState } from "@/updates/catalog";
import { applyAvailableEngineUpdate, rollbackEngine } from "@/updates/engines";
import { restartRole, stopRole } from "@/lib/supervisor";

const EngineStateSchema = z.object({ name: z.string(), installed: z.string().nullable(), available: z.string().nullable(), availableKnown: z.boolean(), lastChecked: z.string().nullable(), notes: z.string().nullable() });
const ModelStateSchema = z.object({ id: z.string(), installed: z.string(), available: z.string().nullable() });
const RecommendationSchema = z.object({ id: z.string(), role: z.string(), profile: z.enum(["p16", "p32", "p64", "p128"]), quality: z.number().int(), repo: z.string().optional(), license: z.string().optional(), revision: z.string(), engine: z.string().optional(), download: z.object({ url: z.string(), sha256: z.string(), approx_bytes: z.number().int() }), sentence: z.string() });
const UpdatesSchema = z.object({ checksEnabled: z.boolean(), engines: z.array(EngineStateSchema), models: z.object({ lastChecked: z.string().nullable(), entries: z.array(ModelStateSchema) }), recommendations: z.array(RecommendationSchema) });
const nameParam = z.object({ name: z.string().openapi({ param: { name: "name", in: "path" }, example: "llama-server" }) });

const stateRoute = createRoute({ method: "get", path: "/", tags: ["Updates"], summary: "Installed, available, last checked", responses: { 200: { content: { "application/json": { schema: UpdatesSchema } }, description: "Per engine and per model; available is null when unknown." } } });
const checkRoute = createRoute({ method: "post", path: "/check", tags: ["Updates"], summary: "Read the Catalog index now (only when update checks are on)", responses: { 200: { content: { "application/json": { schema: UpdatesSchema } }, description: "The state after the check." } } });
const applyRoute = createRoute({ method: "post", path: "/engines/{name}/apply", tags: ["Updates"], summary: "Stage, drain, swap and check the available engine build", request: { params: nameParam }, responses: { 200: { content: { "application/json": { schema: z.object({ applied: z.boolean(), tag: z.string().nullable(), previous: z.string().nullable() }) } }, description: "What changed." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "The swap failed and was rolled back." } } });
const rollbackRoute = createRoute({ method: "post", path: "/engines/{name}/rollback", tags: ["Updates"], summary: "Go back to an installed build", request: { params: nameParam, body: { content: { "application/json": { schema: z.object({ tag: z.string() }) } } } }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true), tag: z.string() }) } }, description: "Rolled back." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "The tag is not installed." } } });

async function withRecommendations(state: ReturnType<typeof updatesState>) { return { ...state, recommendations: await modelRecommendations() }; }

export const updatesRoutes = apiRouter<AppEnv>();
updatesRoutes.openapi(stateRoute, async (c) => c.json(await withRecommendations(updatesState()), 200));
updatesRoutes.openapi(checkRoute, async (c) => { try { return c.json(await withRecommendations(await checkCatalog()), 200); } catch (error) { return c.json(await withRecommendations(updatesState()), 200); } });
updatesRoutes.openapi(applyRoute, async (c) => {
  if (c.req.valid("param").name !== "llama-server") return c.json({ error: "Only llama-server updates are managed today." }, 400);
  try { const applied = await applyAvailableEngineUpdate(); return c.json({ applied: applied !== null, tag: applied?.tag ?? null, previous: applied?.previous ?? null }, 200); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
});
updatesRoutes.openapi(rollbackRoute, async (c) => {
  const { name } = c.req.valid("param"); const { tag } = c.req.valid("json");
  try { await stopRole("chat", "Draining for a rollback."); await rollbackEngine(name, tag); await restartRole("chat"); return c.json({ ok: true as const, tag }, 200); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
});
