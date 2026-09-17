import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema, idParamSchema } from "@/lib/openapi";
import { requireClientOrOperator } from "@/lib/clients";
import { clearAll, dismiss, emit, eventsAfter, listNotifications, markRead } from "@/lib/events";
import { listRepairs, resolveRepair } from "@/lib/repairs";
import { requireOperator } from "@/lib/operator";
import { EventEnvelopeSchema } from "@/events";

const eventsRoute = createRoute({ method: "get", path: "/events", tags: ["Events"], summary: "Stream Stack events", middleware: [requireClientOrOperator] as const, responses: { 200: { content: { "text/event-stream": { schema: z.string() } }, description: "Event envelopes, replayable by sequence." } } });
const notificationsRoute = createRoute({ method: "get", path: "/notifications", tags: ["Notifications"], middleware: [requireClientOrOperator] as const, responses: { 200: { content: { "application/json": { schema: z.object({ notifications: z.array(z.unknown()) }) } }, description: "Recent operator notifications." } } });
const readRoute = createRoute({ method: "post", path: "/notifications/{id}/read", tags: ["Notifications"], middleware: [requireClientOrOperator] as const, request: { params: idParamSchema("id") }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Notification marked read." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown notification." } } });
const dismissRoute = createRoute({ method: "post", path: "/notifications/{id}/dismiss", tags: ["Notifications"], middleware: [requireClientOrOperator] as const, request: { params: idParamSchema("id") }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Notification dismissed." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown notification." } } });
const clearRoute = createRoute({ method: "post", path: "/notifications/clear", tags: ["Notifications"], middleware: [requireClientOrOperator] as const, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Notifications cleared." } } });
const repairsRoute = createRoute({ method: "get", path: "/repairs", tags: ["Repairs"], middleware: [requireClientOrOperator] as const, responses: { 200: { content: { "application/json": { schema: z.object({ repairs: z.array(z.unknown()) }) } }, description: "Operator repairs." } } });
const resolveRoute = createRoute({ method: "post", path: "/repairs/{id}/resolve", tags: ["Repairs"], middleware: [requireOperator] as const, request: { params: idParamSchema("id") }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Repair resolved." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown repair." } } });

function sse(envelopes: unknown[]): Response {
  const body = envelopes.map((event) => `id: ${(event as { seq: number }).seq}\ndata: ${JSON.stringify(EventEnvelopeSchema.parse(event))}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export const eventsRoutes = apiRouter();
eventsRoutes.openapi(eventsRoute, (c) => sse(eventsAfter(Number(c.req.header("last-event-id") ?? 0))));
eventsRoutes.openapi(notificationsRoute, (c) => c.json({ notifications: listNotifications() }, 200));
eventsRoutes.openapi(readRoute, (c) => markRead(c.req.valid("param").id) ? c.json({ ok: true as const }, 200) : c.json({ error: "Unknown notification" }, 404));
eventsRoutes.openapi(dismissRoute, (c) => dismiss(c.req.valid("param").id) ? c.json({ ok: true as const }, 200) : c.json({ error: "Unknown notification" }, 404));
eventsRoutes.openapi(clearRoute, (c) => { clearAll(); return c.json({ ok: true as const }, 200); });
eventsRoutes.openapi(repairsRoute, (c) => c.json({ repairs: listRepairs() }, 200));
eventsRoutes.openapi(resolveRoute, (c) => resolveRepair(c.req.valid("param").id) ? c.json({ ok: true as const }, 200) : c.json({ error: "Unknown repair" }, 404));

export { emit };
