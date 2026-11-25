import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema, idParamSchema } from "@maipai/core/src/openapi";
import { StackConnection } from "@maipai/spec/stack/ts/stack-connection.js";
import type { AppEnv } from "@/types";
import { addMcpConnection, ConnectionError, listConnections, pauseConnection, removeConnection, resumeConnection, testConnection } from "@/lib/connections";

const err = (description: string) => ({ content: { "application/json": { schema: ErrorSchema } }, description });
const body = <T extends z.ZodType>(schema: T) => ({ content: { "application/json": { schema } } });
const one = (description: string) => ({ content: { "application/json": { schema: StackConnection } }, description });
const AddBody = z.object({
  name: z.string(),
  endpoint: z.union([z.object({ type: z.literal("command"), command: z.string(), args: z.array(z.string()).optional() }).strict(), z.object({ type: z.literal("url"), url: z.string() }).strict()]),
  secret_ref: z.string().nullable().optional(),
}).strict();
const list = createRoute({ method: "get", path: "/", tags: ["Connections"], summary: "List the connections the Stack manages", responses: { 200: { content: { "application/json": { schema: z.object({ connections: z.array(StackConnection) }) } }, description: "Paired Homes and custom MCP servers, oldest first." } } });
const add = createRoute({ method: "post", path: "/", tags: ["Connections"], summary: "Add a custom MCP server record (the Stack does not run it yet)", request: { body: body(AddBody) }, responses: { 201: one("The new record."), 400: err("Why it could not be added, in plain words.") } });
const test = createRoute({ method: "post", path: "/{id}/test", tags: ["Connections"], summary: "Test a connection (not available yet)", request: { params: idParamSchema("id") }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(false), available: z.literal(false), message: z.string() }) } }, description: "Testing is not available yet; says so plainly." }, 404: err("Not found.") } });
const pause = createRoute({ method: "post", path: "/{id}/pause", tags: ["Connections"], summary: "Pause a connection", request: { params: idParamSchema("id") }, responses: { 200: one("The paused record."), 404: err("Not found.") } });
const resume = createRoute({ method: "post", path: "/{id}/resume", tags: ["Connections"], summary: "Resume a paused connection", request: { params: idParamSchema("id") }, responses: { 200: one("The resumed record."), 404: err("Not found.") } });
const remove = createRoute({ method: "delete", path: "/{id}", tags: ["Connections"], summary: "Remove a connection record", request: { params: idParamSchema("id") }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Record removed." }, 404: err("Not found.") } });

export const connectionsRoutes = apiRouter<AppEnv>();
const fail = (e: unknown): { error: string; status: 400 | 404 } => e instanceof ConnectionError ? { error: e.message, status: e.status } : { error: "The connection could not be changed. Try again.", status: 400 };
connectionsRoutes.openapi(list, (c) => c.json({ connections: listConnections() }, 200));
connectionsRoutes.openapi(add, (c) => { try { return c.json(addMcpConnection(c.req.valid("json")), 201); } catch (e) { const f = fail(e); return c.json({ error: f.error }, 400); } });
connectionsRoutes.openapi(test, (c) => { try { return c.json(testConnection(c.req.valid("param").id), 200); } catch (e) { return c.json({ error: fail(e).error }, 404); } });
connectionsRoutes.openapi(pause, (c) => { try { return c.json(pauseConnection(c.req.valid("param").id), 200); } catch (e) { return c.json({ error: fail(e).error }, 404); } });
connectionsRoutes.openapi(resume, (c) => { try { return c.json(resumeConnection(c.req.valid("param").id), 200); } catch (e) { return c.json({ error: fail(e).error }, 404); } });
connectionsRoutes.openapi(remove, (c) => { try { removeConnection(c.req.valid("param").id); return c.json({ ok: true as const }, 200); } catch (e) { return c.json({ error: fail(e).error }, 404); } });
