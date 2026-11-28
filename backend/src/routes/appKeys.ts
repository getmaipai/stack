// APP-KEYS-01: make, list and revoke the keys other programs use on the OpenAI-shaped routes. Who may call is decided before these routes
// run (lib/adminGuard.ts): Home's token or a signed-in admin session. An app key cannot reach this file at all. The key is returned once,
// by the create call, and never again.
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema, idParamSchema } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { APP_KEY_SCOPES, AppKeyError, createAppKey, forgetAppKey, listAppKeys, revokeAppKey } from "@/lib/appKeys";
import { auditAction, remoteOf, sourceOf } from "@/lib/adminActions";

const Scope = z.enum(APP_KEY_SCOPES);
const AppKey = z.object({
  id: z.string(), name: z.string(), prefix: z.string().openapi({ description: "The first characters of the key, to tell keys apart. Not enough to use it." }), scopes: z.array(Scope),
  state: z.enum(["active", "revoked"]), created_at: z.string(), created_by: z.string(), last_used_at: z.string().nullable(), use_count: z.number().int(), revoked_at: z.string().nullable(),
}).openapi("AppKey");
const Fail = z.object({ error: z.string(), code: z.string() });
const failure = (description: string) => ({ content: { "application/json": { schema: Fail } }, description });
const CreateBody = z.object({ name: z.string(), scopes: z.array(z.string()) }).strict();

const listRoute = createRoute({ method: "get", path: "/", tags: ["App keys"], summary: "The app keys: name, scopes, last use, state (never the key)", responses: { 200: { content: { "application/json": { schema: z.object({ app_keys: z.array(AppKey), scopes: z.array(Scope) }) } }, description: "Every key, oldest first, with the scopes a key may have." } } });
const createRouteDef = createRoute({
  method: "post", path: "/", tags: ["App keys"], summary: "Make an app key (the key is shown once)",
  description: "Returns `key` once. The Stack stores only a hash, so a lost key cannot be shown again: revoke it and make a new one. Send the key as `Authorization: Bearer <key>` to the model routes its scopes allow.",
  request: { body: { content: { "application/json": { schema: CreateBody } } } },
  responses: { 201: { content: { "application/json": { schema: z.object({ key: z.string(), app_key: AppKey }) } }, description: "The new key, once." }, 400: failure("The name or scopes are not usable; the error says what to change."), 409: failure("A key with that name exists, or there are too many active keys.") },
});
const revokeRoute = createRoute({ method: "post", path: "/{id}/revoke", tags: ["App keys"], summary: "Revoke an app key at once", request: { params: idParamSchema("id") }, responses: { 200: { content: { "application/json": { schema: AppKey } }, description: "The revoked key." }, 404: { content: { "application/json": { schema: Fail } }, description: "No such key." } } });
const forgetRoute = createRoute({ method: "delete", path: "/{id}", tags: ["App keys"], summary: "Remove a revoked key from the list", request: { params: idParamSchema("id") }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Removed." }, 404: failure("No such key."), 409: failure("The key is still active; revoke it first.") } });
void ErrorSchema;

export const appKeysRoutes = apiRouter<AppEnv>();
appKeysRoutes.openapi(listRoute, (c) => c.json({ app_keys: listAppKeys(), scopes: [...APP_KEY_SCOPES] }, 200));
appKeysRoutes.openapi(createRouteDef, (c) => {
  try {
    const body = c.req.valid("json");
    const by = sourceOf(c);
    const made = createAppKey({ name: body.name, scopes: body.scopes, by });
    auditAction("app_key.created", by, remoteOf(c), { key_id: made.record.id, key_name: made.record.name, scopes: made.record.scopes.join(",") });
    c.header("cache-control", "no-store");
    return c.json({ key: made.key, app_key: made.record }, 201);
  } catch (e) {
    if (e instanceof AppKeyError && e.status !== 404) return c.json({ error: e.message, code: e.code }, e.status === 409 ? 409 : 400);
    return c.json({ error: "The key could not be made. Try again.", code: "app_key_failed" }, 400);
  }
});
appKeysRoutes.openapi(revokeRoute, (c) => {
  try {
    const by = sourceOf(c);
    const record = revokeAppKey(c.req.valid("param").id);
    auditAction("app_key.revoked", by, remoteOf(c), { key_id: record.id, key_name: record.name });
    return c.json(record, 200);
  } catch (e) { return c.json({ error: e instanceof AppKeyError ? e.message : "The key could not be revoked. Try again.", code: e instanceof AppKeyError ? e.code : "app_key_failed" }, 404); }
});
appKeysRoutes.openapi(forgetRoute, (c) => {
  try {
    const id = c.req.valid("param").id;
    forgetAppKey(id);
    auditAction("app_key.removed", sourceOf(c), remoteOf(c), { key_id: id });
    return c.json({ ok: true as const }, 200);
  } catch (e) {
    if (e instanceof AppKeyError) return c.json({ error: e.message, code: e.code }, e.status === 409 ? 409 : 404);
    return c.json({ error: "The key could not be removed. Try again.", code: "app_key_failed" }, 404);
  }
});
