import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema, idParamSchema } from "@/lib/openapi";
import { requireClientOrOperator } from "@/lib/clients";
import { clearAll, dismiss, emit, eventsAfter, listNotifications, markRead } from "@/lib/events";
import { listRepairs, resolveRepair } from "@/lib/repairs";
import { requireOperator } from "@/lib/operator";
import { EventEnvelopeSchema } from "@/events";
import { ignore, list as listHealth, resolve } from "@/lib/health";
import { showroom, showroomHealth, showroomNotifications, showroomResolveHealth } from "@/showroom/fixture";

const eventsRoute = createRoute({ method: "get", path: "/events", tags: ["Events"], summary: "Stream Stack events", middleware: [requireClientOrOperator] as const, responses: { 200: { content: { "text/event-stream": { schema: z.string() } }, description: "Event envelopes, replayable by sequence." } } });
const notificationsRoute = createRoute({ method: "get", path: "/notifications", tags: ["Notifications"], middleware: [requireClientOrOperator] as const, request: { query: z.object({ durable: z.string().optional() }) }, responses: { 200: { content: { "application/json": { schema: z.object({ notifications: z.array(z.unknown()) }) } }, description: "Recent operator notifications." } } });
const readRoute = createRoute({ method: "post", path: "/notifications/{id}/read", tags: ["Notifications"], middleware: [requireClientOrOperator] as const, request: { params: idParamSchema("id") }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Notification marked read." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown notification." } } });
const dismissRoute = createRoute({ method: "post", path: "/notifications/{id}/dismiss", tags: ["Notifications"], middleware: [requireClientOrOperator] as const, request: { params: idParamSchema("id") }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Notification dismissed." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown notification." } } });
const clearRoute = createRoute({ method: "post", path: "/notifications/clear", tags: ["Notifications"], middleware: [requireClientOrOperator] as const, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Notifications cleared." } } });
const repairsRoute = createRoute({ method: "get", path: "/repairs", tags: ["Repairs"], middleware: [requireClientOrOperator] as const, responses: { 200: { content: { "application/json": { schema: z.object({ repairs: z.array(z.unknown()) }) } }, description: "Operator repairs." } } });
const resolveRoute = createRoute({ method: "post", path: "/repairs/{id}/resolve", tags: ["Repairs"], middleware: [requireOperator] as const, request: { params: idParamSchema("id") }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Repair resolved." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown repair." } } });
const healthItem = z.object({ code: z.string(), severity: z.enum(["critical", "error", "warning"]), title: z.string(), text: z.string(), since: z.string(), cause: z.string(), fix: z.object({ label: z.string(), action: z.string() }).optional(), learnMore: z.string().optional() });
const healthRoute = createRoute({ method: "get", path: "/health", tags: ["Health"], summary: "List active health items", middleware: [requireClientOrOperator] as const, responses: { 200: { content: { "application/json": { schema: z.object({ health: z.array(healthItem) }) } }, description: "Active daemon health items." } } });
const healthActionRoute = (action: "resolve" | "ignore") => createRoute({ method: "post", path: `/health/{code}/${action}`, tags: ["Health"], summary: `${action[0]!.toUpperCase()}${action.slice(1)} a health item`, middleware: [requireOperator] as const, request: { params: idParamSchema("code") }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: `Health item ${action}d.` }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown health item." } } });

function sse(envelopes: unknown[]): Response {
  const body = envelopes.map((event) => `id: ${(event as { seq: number }).seq}\ndata: ${JSON.stringify(EventEnvelopeSchema.parse(event))}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export const eventsRoutes = apiRouter();
eventsRoutes.openapi(eventsRoute, (c) => sse(eventsAfter(Number(c.req.header("last-event-id") ?? 0))));
eventsRoutes.openapi(notificationsRoute, (c) => { const durable = c.req.valid("query").durable === "1"; const rows = showroom() ? showroomNotifications.filter((item) => !durable || item.durable !== false) : listNotifications(durable); return c.json({ notifications: rows }, 200); });
eventsRoutes.openapi(readRoute, (c) => markRead(c.req.valid("param").id) ? c.json({ ok: true as const }, 200) : c.json({ error: "Unknown notification" }, 404));
eventsRoutes.openapi(dismissRoute, (c) => dismiss(c.req.valid("param").id) ? c.json({ ok: true as const }, 200) : c.json({ error: "Unknown notification" }, 404));
eventsRoutes.openapi(clearRoute, (c) => { if (showroom()) { showroomNotifications.splice(0); return c.json({ ok: true as const }, 200); } clearAll(); return c.json({ ok: true as const }, 200); });
eventsRoutes.openapi(repairsRoute, (c) => c.json({ repairs: listRepairs() }, 200));
eventsRoutes.openapi(resolveRoute, (c) => resolveRepair(c.req.valid("param").id) ? c.json({ ok: true as const }, 200) : c.json({ error: "Unknown repair" }, 404));
eventsRoutes.openapi(healthRoute, (c) => c.json({ health: showroom() ? showroomHealth : listHealth() }, 200));
for (const action of ["resolve", "ignore"] as const) eventsRoutes.openapi(healthActionRoute(action), (c) => { const code = c.req.valid("param").code; const changed = showroom() ? showroomResolveHealth(code) : action === "resolve" ? resolve(code) : ignore(code); return changed ? c.json({ ok: true as const }, 200) : c.json({ error: "Unknown health item" }, 404); });

export { emit };
