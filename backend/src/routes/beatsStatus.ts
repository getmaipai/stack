import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { beats, BEATS_IDLE_MS, BEATS_MAX_SECONDS, BEATS_PEAK_BYTES, BEATS_NAME, BEATS_VERSION } from "@/beats/beats";
const route = createRoute({ method: "get", path: "/", tags: ["Beats"], summary: "Beat analysis availability and limits", responses: { 200: { content: { "application/json": { schema: z.object({ beats: z.object({ state: z.string(), available: z.boolean(), installed: z.boolean(), ready: z.boolean(), engine: z.string(), version: z.string(), limits: z.object({ max_source_mb: z.number(), max_seconds: z.number(), peak_bytes: z.number(), idle_exit_seconds: z.number() }) }) }) } }, description: "Beat analysis status." } } });
export const beatsRoutes = apiRouter<AppEnv>();
beatsRoutes.openapi(route, (c) => { const available = beats.depsAvailable; return c.json({ beats: { state: !available ? "unsupported" : beats.state, available, installed: beats.installed, ready: beats.installed && beats.state === "idle", engine: BEATS_NAME, version: BEATS_VERSION, limits: { max_source_mb: 40, max_seconds: BEATS_MAX_SECONDS, peak_bytes: BEATS_PEAK_BYTES, idle_exit_seconds: BEATS_IDLE_MS / 1000 } } }, 200 as const); });
