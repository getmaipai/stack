// CODE-SANDBOX-01b: /stack/v1/sandboxes. Home asks; the Stack owns the machines (lib/sandbox.ts). Who may call is the global guard.
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, errorResponses, idParamSchema } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { dataDir } from "@/lib/paths";
import { sandboxService, SandboxError } from "@/lib/sandbox";

const Sandbox = z.object({ id: z.string(), machine: z.string(), state: z.enum(["running", "stopped"]), workspace: z.string(), cpus: z.number(), memory_gb: z.number(), created_at: z.string(), last_active_at: z.string() }).openapi("Sandbox");
const CreateBody = z.object({
  id: z.string().describe("The session's id; names the machine."),
  workspace: z.string().describe("Absolute path of an existing folder inside the coding folder; the only folder the machine sees."),
  cpus: z.number().int().optional().describe("Defaults to 4, clamped to 1 to 8."),
  memory_gb: z.number().int().optional().describe("Defaults to 4, clamped to 1 to 16."),
  env: z.record(z.string(), z.string().max(2000)).optional().describe("Plain variables the agent can read; never a secret."),
  network: z.object({ policy: z.enum(["none", "hosts"]), hosts: z.array(z.string()).default([]) }).optional().describe("Only policy none exists today; hosts waits for the egress proxy (CODE-SANDBOX-02)."),
});
const createErrors = errorResponses({ 400: "A field is not allowed.", 409: "The id is taken.", 500: "The machine did not start, or its network lock did not load.", 503: "The container system is not running." });
const notFound = errorResponses({ 404: "No sandbox with this id." });
const idParams = { params: idParamSchema("id") };
const createR = createRoute({ method: "post", path: "/", tags: ["Sandboxes"], summary: "Start a sandbox machine", request: { body: { content: { "application/json": { schema: CreateBody } } } }, responses: { 201: { content: { "application/json": { schema: Sandbox } }, description: "The machine runs behind its network lock." }, ...createErrors } });
const listR = createRoute({ method: "get", path: "/", tags: ["Sandboxes"], summary: "List sandboxes", responses: { 200: { content: { "application/json": { schema: z.object({ sandboxes: z.array(Sandbox) }) } }, description: "Every sandbox the Stack knows." } } });
const getR = createRoute({ method: "get", path: "/{id}", tags: ["Sandboxes"], summary: "One sandbox", request: idParams, responses: { 200: { content: { "application/json": { schema: Sandbox } }, description: "Its state." }, ...notFound } });
const stopR = createRoute({ method: "post", path: "/{id}/stop", tags: ["Sandboxes"], summary: "Stop a sandbox", request: idParams, responses: { 200: { content: { "application/json": { schema: Sandbox } }, description: "Stopped; the workspace folder is untouched." }, ...notFound } });
const deleteR = createRoute({ method: "delete", path: "/{id}", tags: ["Sandboxes"], summary: "Remove a sandbox machine", request: idParams, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "The machine is gone; the workspace folder is untouched." }, ...notFound } });

export const sandboxRoutes = apiRouter<AppEnv>();
const fail = (error: unknown): { error: string; status: 400 | 404 | 409 | 500 | 503 } => {
  if (error instanceof SandboxError) return { error: error.message, status: error.status };
  return { error: "The sandbox service failed in a way it did not expect. Try again; if it repeats, check the Stack log.", status: 500 };
};
// Each handler keeps its own try so the typed status reaches the wire.
sandboxRoutes.openapi(createR, async (c) => {
  const body = c.req.valid("json");
  if (body.network && body.network.policy !== "none") return c.json({ error: "Allowing hosts is not available yet. Create the sandbox with network policy none." }, 400);
  try { return c.json(await sandboxService(dataDir).create({ id: body.id, workspace: body.workspace, cpus: body.cpus, memory_gb: body.memory_gb, env: body.env }), 201); }
  catch (error) {
    const f = fail(error);
    if (f.status === 400) return c.json({ error: f.error }, 400);
    if (f.status === 409) return c.json({ error: f.error }, 409);
    if (f.status === 503) return c.json({ error: f.error }, 503);
    return c.json({ error: f.error }, 500);
  }
});
sandboxRoutes.openapi(listR, (c) => c.json({ sandboxes: sandboxService(dataDir).list() }, 200));
sandboxRoutes.openapi(getR, (c) => {
  try { return c.json(sandboxService(dataDir).get(c.req.valid("param").id), 200); } catch (error) { return c.json({ error: fail(error).error }, 404); }
});
sandboxRoutes.openapi(stopR, async (c) => {
  try { return c.json(await sandboxService(dataDir).stop(c.req.valid("param").id), 200); } catch (error) { return c.json({ error: fail(error).error }, 404); }
});
sandboxRoutes.openapi(deleteR, async (c) => {
  try { await sandboxService(dataDir).remove(c.req.valid("param").id); return c.json({ ok: true as const }, 200); } catch (error) { return c.json({ error: fail(error).error }, 404); }
});
