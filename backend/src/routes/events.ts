import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { sseResponse } from "@/lib/events";

const eventsRoute = createRoute({ method: "get", path: "/events", tags: ["Events"], summary: "The event feed (server-sent events, stays open)", responses: { 200: { content: { "text/event-stream": { schema: z.string() } }, description: "Envelopes { id, at, seq, data }; reconnect with Last-Event-Id to replay." } } });

export const eventsRoutes = apiRouter<AppEnv>();
eventsRoutes.openapi(eventsRoute, (c) => sseResponse({ lastEventId: Number(c.req.header("last-event-id") ?? 0) || 0, signal: c.req.raw.signal }) as never);
