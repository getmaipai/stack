import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema, idParamSchema } from "@/lib/openapi";
import { requireOperator } from "@/lib/operator";
import { createChannel, listChannels, removeChannel, testChannel, updateChannel, type ChannelInput, type ChannelType } from "@/lib/channels";
import { showroom, showroomChannels } from "@/showroom/fixture";

const channelType = z.enum(["telegram", "ntfy"]);
const channel = z.object({ id: z.string(), type: channelType, name: z.string(), serverUrl: z.string().optional(), topic: z.string().optional(), verifiedAt: z.string().nullable(), createdAt: z.string(), lastError: z.string().nullable(), lastSentAt: z.string().nullable(), status: z.enum(["verified", "unverified", "failing"]), configPresent: z.literal(true) });
const config = z.object({ botToken: z.string().min(1).optional(), chatId: z.string().min(1).optional(), serverUrl: z.string().url().optional(), topic: z.string().min(1).optional(), accessToken: z.string().optional() });
const input = z.object({ type: channelType, name: z.string().min(1), config });
const listRoute = createRoute({ method: "get", path: "/channels", tags: ["Channels"], middleware: [requireOperator] as const, responses: { 200: { content: { "application/json": { schema: z.object({ channels: z.array(channel) }) } }, description: "List configured alert channels without secrets." } } });
const createRoute_ = createRoute({ method: "post", path: "/channels", tags: ["Channels"], middleware: [requireOperator] as const, request: { body: { content: { "application/json": { schema: input } } } }, responses: { 201: { content: { "application/json": { schema: channel } }, description: "Create an alert channel." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "Invalid channel." } } });
const updateRoute = createRoute({ method: "patch", path: "/channels/{id}", tags: ["Channels"], middleware: [requireOperator] as const, request: { params: idParamSchema("id"), body: { content: { "application/json": { schema: input.partial() } } } }, responses: { 200: { content: { "application/json": { schema: channel } }, description: "Update an alert channel." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown channel." } } });
const deleteRoute = createRoute({ method: "delete", path: "/channels/{id}", tags: ["Channels"], middleware: [requireOperator] as const, request: { params: idParamSchema("id") }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Delete an alert channel." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown channel." } } });
const testRoute = createRoute({ method: "post", path: "/channels/{id}/test", tags: ["Channels"], middleware: [requireOperator] as const, request: { params: idParamSchema("id") }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Send a test alert." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown channel." }, 502: { content: { "application/json": { schema: ErrorSchema } }, description: "Provider rejected the test." } } });

export const channelsRoutes = apiRouter();
channelsRoutes.openapi(listRoute, (c) => c.json({ channels: showroom() ? showroomChannels : listChannels() } as never, 200));
channelsRoutes.openapi(createRoute_, (c) => {
  const body = c.req.valid("json");
  if (showroom()) return c.json({ ...showroomChannels[0], id: `showroom-channel-${crypto.randomUUID()}`, name: body.name, type: body.type, configPresent: true } as never, 201);
  try { return c.json(createChannel(body as ChannelInput) as never, 201); } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Invalid channel." }, 400); }
});
channelsRoutes.openapi(updateRoute, (c) => {
  const id = c.req.valid("param").id; const body = c.req.valid("json");
  if (showroom()) { const row = showroomChannels.find((item) => item.id === id); if (!row) return c.json({ error: "Unknown channel." }, 404); Object.assign(row, { ...(body.name ? { name: body.name } : {}), ...(body.type ? { type: body.type } : {}) }); return c.json(row as never, 200); }
  const row = updateChannel(id, body as Partial<ChannelInput>); return row ? c.json(row as never, 200) : c.json({ error: "Unknown channel." }, 404);
});
channelsRoutes.openapi(deleteRoute, (c) => { const id = c.req.valid("param").id; if (showroom()) { const index = showroomChannels.findIndex((item) => item.id === id); if (index < 0) return c.json({ error: "Unknown channel." }, 404); showroomChannels.splice(index, 1); return c.json({ ok: true as const }, 200); } return removeChannel(id) ? c.json({ ok: true as const }, 200) : c.json({ error: "Unknown channel." }, 404); });
channelsRoutes.openapi(testRoute, async (c) => { const id = c.req.valid("param").id; if (showroom()) { const row = showroomChannels.find((item) => item.id === id); if (!row) return c.json({ error: "Unknown channel." }, 404); row.verifiedAt = new Date().toISOString(); row.status = "verified"; return c.json({ ok: true as const }, 200); } const result = await testChannel(id); return result.ok ? c.json(result, 200) : c.json({ error: result.error }, result.error === "Unknown channel." ? 404 : 502); });
