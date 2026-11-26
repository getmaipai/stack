// STACK-LORAS-01: the one LoRA library for pictures and video. Home reads it over the paired token and
// keeps no copy; the admin page reads the same routes. The per-media routes under /v1/images and
// /v1/videos stay for generation and existing callers. Same guard as every /stack/v1 route.
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { LoraError } from "@/lib/media/loraLibrary";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { getCatalog, importCatalog, listCatalog, previewDir, patchCatalog, purgeCatalog, restoreCatalog, trashCatalog, TRASH_DAYS } from "@/lib/media/loraCatalog";
import { browseSource, setSourceKey, sourceStatus, startCatalogInstall, startLoraMove } from "@/lib/media/loraSources";
import { LORA_INSTALL_SITES } from "@/lib/media/loraInstallCore";

const Media = z.enum(["picture", "video"]);
const Site = z.enum(LORA_INSTALL_SITES);
const Class = z.enum(["all-ages", "adult-only"]);
const Err = z.object({ error: z.string(), code: z.string() });
const LoraView = z.object({ id: z.string(), media: Media, name: z.string(), base_model: z.string(), classification: Class, sha256: z.string(), bytes: z.number(), strength_default: z.number(), trigger_words: z.array(z.string()), licence: z.string(), source_url: z.string().nullable(), added_by: z.string().nullable(), added_at: z.string(),
  disk_id: z.string().nullable().openapi({ description: "The Stack drive holding the file; null is the Stack's own data directory." }), disk_label: z.string(),
  status: z.enum(["ready", "drive_missing", "installing", "failed"]).openapi({ description: "`drive_missing` when the drive holding the file is not connected. Home treats the style as unavailable." }), status_note: z.string().nullable(),
  removed_at: z.string().nullable(), trash_until: z.string().nullable(), preview: z.string().nullable(), home: z.record(z.string(), z.unknown()).nullable().openapi({ description: "The spec Lora record Home sent on import, kept as sent (description, kind, add-ins, availability, licence text)." }),
});
const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ content: { "application/json": { schema } }, description });
const errors = { 403: json(Err, "A ticket or licence is needed."), 404: json(Err, "No such LoRA."), 409: json(Err, "Not allowed."), 422: json(Err, "Refused, with what to change."), 429: json(Err, "Too many searches."), 502: json(Err, "The source did not answer."), 503: json(Err, "Busy.") };
const tags = ["LoRAs"];

const listRoute = createRoute({ method: "get", path: "/", tags, summary: "Every LoRA, pictures and video", request: { query: z.object({ removed: z.enum(["true", "false"]).optional().openapi({ description: "true lists the trash." }), media: Media.optional() }) }, responses: { 200: json(z.object({ loras: z.array(LoraView), trash_days: z.number() }), "The unified library.") } });
const patchRoute = createRoute({ method: "patch", path: "/{id}", tags, summary: "Edit a LoRA", request: { params: z.object({ id: z.string() }), body: { content: { "application/json": { schema: z.object({ name: z.string().optional(), classification: Class.optional(), strength_default: z.number().optional(), trigger_words: z.array(z.string()).optional(), source_url: z.string().nullable().optional(), description: z.string().optional(), kind: z.string().optional(), availability_who: z.enum(["admins", "adults", "people"]).optional().openapi({ description: "Who may use it, written to `home.availability.who`. No ticket needed." }), ticket: z.string().optional().openapi({ description: "Home's fresh single-use adult-lock ticket. Required to change adult-only to all-ages; marking adult-only needs none." }) }) } } } }, responses: { 200: json(LoraView, "Updated."), ...errors } });
const deleteRoute = createRoute({ method: "delete", path: "/{id}", tags, summary: "Move a LoRA to the trash (30 days), or delete it for good with purge=true", request: { params: z.object({ id: z.string() }), query: z.object({ purge: z.enum(["true", "false"]).optional() }) }, responses: { 200: json(z.object({ ok: z.literal(true), purged: z.boolean() }), "Done."), ...errors } });
const restoreRoute = createRoute({ method: "post", path: "/{id}/restore", tags, summary: "Bring a LoRA back from the trash", request: { params: z.object({ id: z.string() }) }, responses: { 200: json(LoraView, "Restored."), ...errors } });
const moveRoute = createRoute({ method: "post", path: "/{id}/move", tags, summary: "Move a LoRA's file to another drive (lora.move job)", request: { params: z.object({ id: z.string() }), body: { content: { "application/json": { schema: z.object({ disk_id: z.string().min(1) }) } } } }, responses: { 202: json(z.object({ job: z.string() }), "A `lora.move` job started."), ...errors } });
const importRoute = createRoute({ method: "post", path: "/import", tags, summary: "Take Home's LoRA records and previews (idempotent by id, never deletes)", request: { body: { content: { "application/json": { schema: z.object({ items: z.array(z.object({ lora: z.record(z.string(), z.unknown()), preview: z.object({ content_type: z.string(), data_base64: z.string() }).nullable().optional() })).max(500) }) } } } }, responses: { 200: json(z.object({ results: z.array(z.object({ id: z.string(), result: z.enum(["imported", "unchanged", "missing_file", "conflict", "invalid"]), note: z.string().optional() })) }), "One result per item. `missing_file` means the Stack has no file with that id."), ...errors } });
const installRoute = createRoute({ method: "post", path: "/install", tags, summary: "Download a LoRA from Hugging Face or Civitai (needs the global licence accept)", request: { body: { content: { "application/json": { schema: z.object({ media: Media, source: Site, url: z.string(), name: z.string(), licence: z.string().optional(), audience: Class.optional(), strength_default: z.number().optional(), trigger_words: z.array(z.string()).optional(), added_by: z.string().nullable().optional(), disk_id: z.string().nullable().optional().openapi({ description: "The Stack drive to keep it on; absent is the Stack's own data directory." }), sha256: z.string().optional(), source_url: z.string().optional(), base_model: z.string().nullable().optional() }) } } } }, responses: { 202: json(z.object({ job: z.string() }), "A `<media>.lora.install` job started."), ...errors } });
const sourcesRoute = createRoute({ method: "get", path: "/sources", tags, summary: "The two sources and whether a key is saved (never the key)", responses: { 200: json(z.object({ sources: z.array(z.object({ site: Site, label: z.string(), has_key: z.boolean() })) }), "Sources.") } });
const keyRoute = createRoute({ method: "put", path: "/sources/{site}/key", tags, summary: "Save a Hugging Face token or Civitai key (null removes it)", request: { params: z.object({ site: Site }), body: { content: { "application/json": { schema: z.object({ key: z.string().nullable() }) } } } }, responses: { 200: json(z.object({ sources: z.array(z.object({ site: Site, label: z.string(), has_key: z.boolean() })) }), "Saved."), ...errors } });
const searchRoute = createRoute({ method: "get", path: "/sources/{site}/search", tags, summary: "Search a source for LoRAs", request: { params: z.object({ site: Site }), query: z.object({ q: z.string() }) }, responses: { 200: json(z.object({ hits: z.array(z.object({ site: Site, remote_id: z.string(), name: z.string(), base_model: z.string().nullable(), downloads: z.number(), install_url: z.string(), file_name: z.string().nullable(), bytes: z.number().nullable(), audience_hint: Class, licence: z.string().nullable(), page_url: z.string() })) }), "Hits."), ...errors } });
const PREVIEW_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const previewRoute = createRoute({ method: "get", path: "/{id}/preview", tags, summary: "A LoRA's preview picture", request: { params: z.object({ id: z.string() }) }, responses: { 200: { content: { "image/png": { schema: z.string().openapi({ format: "binary" }) } }, description: "The picture (PNG, JPEG, WebP or GIF), from the Stack's own data directory." }, 404: json(Err, "No such LoRA, or it has no preview.") } });

export const lorasRoutes = apiRouter<AppEnv>();
type Status = 403 | 404 | 409 | 422 | 429 | 502 | 503;
const fail = (c: { json: (body: unknown, status: Status) => Response }, error: unknown): Response => {
  if (error instanceof LoraError) return c.json({ error: error.message, code: error.code }, ([403, 404, 409, 422, 429, 502, 503].includes(error.status) ? error.status : 422) as Status);
  throw error;
};
const asView = (value: unknown) => value as z.infer<typeof LoraView>;
const asViews = (value: unknown) => value as Array<z.infer<typeof LoraView>>;
lorasRoutes.openapi(listRoute, (c) => { const q = c.req.valid("query"); return c.json({ loras: asViews(listCatalog({ removed: q.removed === "true", media: q.media })), trash_days: TRASH_DAYS }, 200); });
lorasRoutes.openapi(patchRoute, async (c) => {
  const body = c.req.valid("json");
  try { return c.json(asView(await patchCatalog(c.req.valid("param").id, { name: body.name, classification: body.classification, strengthDefault: body.strength_default, triggerWords: body.trigger_words, sourceUrl: body.source_url, description: body.description, kind: body.kind, availabilityWho: body.availability_who, ticket: body.ticket })), 200); } catch (error) { return fail(c, error) as never; }
});
lorasRoutes.openapi(deleteRoute, (c) => {
  const { id } = c.req.valid("param");
  try { if (c.req.valid("query").purge === "true") { return purgeCatalog(id) ? c.json({ ok: true as const, purged: true }, 200) : c.json({ error: "No such LoRA in the library.", code: "unknown_lora" }, 404); } trashCatalog(id); return c.json({ ok: true as const, purged: false }, 200); } catch (error) { return fail(c, error) as never; }
});
lorasRoutes.openapi(restoreRoute, (c) => { try { return c.json(asView(restoreCatalog(c.req.valid("param").id)), 200); } catch (error) { return fail(c, error) as never; } });
lorasRoutes.openapi(moveRoute, async (c) => { try { const job = await startLoraMove(c.req.valid("param").id, c.req.valid("json").disk_id); return c.json({ job: job.id }, 202); } catch (error) { return fail(c, error) as never; } });
lorasRoutes.openapi(importRoute, (c) => c.json({ results: importCatalog(c.req.valid("json").items) }, 200));
lorasRoutes.openapi(installRoute, (c) => {
  const body = c.req.valid("json");
  try { const job = startCatalogInstall({ media: body.media, site: body.source, url: body.url, name: body.name, licence: body.licence, classification: body.audience, strengthDefault: body.strength_default, triggerWords: body.trigger_words, addedBy: body.added_by, diskId: body.disk_id, sha256Expected: body.sha256, sourceUrl: body.source_url, baseModel: body.base_model }); return c.json({ job: job.id }, 202); } catch (error) { return fail(c, error) as never; }
});
lorasRoutes.openapi(sourcesRoute, (c) => c.json({ sources: sourceStatus() }, 200));
lorasRoutes.openapi(keyRoute, (c) => { try { setSourceKey(c.req.valid("param").site, c.req.valid("json").key); return c.json({ sources: sourceStatus() }, 200); } catch (error) { return fail(c, error) as never; } });
lorasRoutes.openapi(searchRoute, async (c) => { try { return c.json({ hits: await browseSource(c.req.valid("param").site, c.req.valid("query").q) }, 200); } catch (error) { return fail(c, error) as never; } });

lorasRoutes.openapi(previewRoute, (c) => {
  const record = getCatalog(c.req.valid("param").id);
  const name = record?.preview ?? null;
  // Only a bare file name under data/loras/previews is ever served; anything else is a 404, never a path outside that folder.
  const file = name && basename(name) === name ? join(previewDir(), name) : null;
  if (!file || !existsSync(file)) return c.json({ error: "That style has no preview picture.", code: "no_preview" }, 404) as never;
  return new Response(Bun.file(file), { status: 200, headers: { "content-type": PREVIEW_MIME[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "private, max-age=300" } }) as never;
});
