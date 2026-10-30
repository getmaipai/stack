import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { stems, STEMS_IDLE_MS, STEMS_PEAK_BYTES, STEMS_NAME, STEMS_VERSION } from "@/stems/stems";
import { STACK_STEMS_MODEL_ID } from "@/lib/modelCatalog";
import { listModels } from "@/lib/modelStore";
import { installedEnginePin } from "@/lib/engineCatalog";
import { stemsInstallModels } from "@/lib/installPlan";
import { modelView } from "@/routes/models";

const Model = z.object({ id: z.string(), role: z.string(), repo: z.string().optional(), url: z.string(), sha256: z.string(), approx_bytes: z.number().int(), licence: z.string(), revision: z.string(), engine: z.string().optional(), archive: z.boolean().optional(), hub_file: z.string().optional(), component: z.string().optional(), starter: z.boolean(), installed: z.boolean() });
const route = createRoute({ method: "get", path: "/", tags: ["Stems"], summary: "Stem splitting availability and limits", responses: { 200: { content: { "application/json": { schema: z.object({ stems: z.object({ state: z.string(), available: z.boolean(), model: z.object({ id: z.string(), installed: z.boolean() }), models: z.array(Model), installed: z.boolean(), ready: z.boolean(), limits: z.object({ max_source_mb: z.number(), outputs: z.array(z.string()), peak_bytes: z.number(), idle_exit_seconds: z.number() }) }) }) } }, description: "Stem splitter status." } } });
export const stemsRoutes = apiRouter<AppEnv>();
stemsRoutes.openapi(route, (c) => { const available = stems.depsAvailable; const installed = listModels().map(modelView).filter((m) => m.state === "installed").map((m) => m.id); const models = stemsInstallModels(installed); return c.json({ stems: { state: !available ? "unsupported" : stems.state, available, model: { id: STACK_STEMS_MODEL_ID, installed: models.every((m) => m.installed) }, models, installed: models.every((m) => m.installed), ready: stems.state === "idle", limits: { max_source_mb: 40, outputs: ["vocals", "drums", "bass", "other"], peak_bytes: STEMS_PEAK_BYTES, idle_exit_seconds: STEMS_IDLE_MS / 1000 } } }, 200 as const); });
