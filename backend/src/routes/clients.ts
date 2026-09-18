import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema, idParamSchema } from "@/lib/openapi";
import { issueClient, listClients, resolveClient, revokeClient } from "@/lib/clients";
import { hasOperator, requireOperator } from "@/lib/operator";
import { RoleIdSchema } from "@/roles";
import { showroom, showroomClients } from "@/showroom/fixture";

const ClientSchema = z.object({
  id: z.string(),
  name: z.string(),
  keyPrefix: z.string(),
  allowedRoles: z.array(RoleIdSchema),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  requests: z.number().int(),
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  audioSeconds: z.number().int(),
  jobs: z.number().int(),
});
const ClientsResponseSchema = z.object({ clients: z.array(ClientSchema) });
const CreateClientSchema = z.object({ name: z.string().min(1), allowedRoles: z.array(RoleIdSchema) });
const CreateClientResponseSchema = z.object({ client: ClientSchema, key: z.string() });
const PasswordRequiredSchema = z.object({ error: z.string(), setPasswordFirst: z.literal(true) });

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Clients"],
  summary: "List role-scoped client keys",
  middleware: [requireOperator] as const,
  responses: {
    200: { content: { "application/json": { schema: ClientsResponseSchema } }, description: "Client metadata without key values." },
    401: { content: { "application/json": { schema: ErrorSchema } }, description: "Operator is not signed in." },
  },
});

const createRoute_ = createRoute({
  method: "post",
  path: "/",
  tags: ["Clients"],
  summary: "Create a role-scoped client key",
  middleware: [requireOperator] as const,
  request: { body: { content: { "application/json": { schema: CreateClientSchema } } } },
  responses: {
    201: { content: { "application/json": { schema: CreateClientResponseSchema } }, description: "Client metadata and its raw key, shown once." },
    409: { content: { "application/json": { schema: PasswordRequiredSchema } }, description: "Set the deferred operator password first." },
    401: { content: { "application/json": { schema: ErrorSchema } }, description: "Operator is not signed in." },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Clients"],
  summary: "Revoke a client key",
  middleware: [requireOperator] as const,
  request: { params: idParamSchema("id", "client-example") },
  responses: {
    200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Client revoked." },
    401: { content: { "application/json": { schema: ErrorSchema } }, description: "Operator is not signed in." },
    404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown client." },
  },
});

export const clientsRoutes = apiRouter();
clientsRoutes.openapi(listRoute, (c) => c.json({ clients: showroom() ? showroomClients as never : listClients() }, 200));
clientsRoutes.openapi(createRoute_, (c) => {
  if (!hasOperator()) return c.json({ error: "Set an operator password before creating a client key", setPasswordFirst: true as const }, 409);
  const body = c.req.valid("json");
  const key = issueClient(body.name, body.allowedRoles);
  const client = resolveClient(key);
  if (!client) return c.json({ error: "Client could not be created" }, 500 as never);
  return c.json({ client, key }, 201);
});
clientsRoutes.openapi(deleteRoute, (c) => {
  const id = c.req.valid("param").id;
  if (!revokeClient(id)) return c.json({ error: "Unknown client" }, 404);
  return c.json({ ok: true as const }, 200);
});

export { ClientSchema };
