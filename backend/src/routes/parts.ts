import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import { StackPartView as StackPartViewSchema } from "@maipai/spec/stack/ts/stack-part-view.js";
import type { AppEnv } from "@/types";
import { ComponentError, startComponentInstall, uninstallComponent } from "@/lib/components";
import { listParts } from "@/lib/partsList";
import { PART_DEFS } from "@/lib/partDefs";
import { choicesRefusal, writePartChoices, type Choices } from "@/lib/partChoices";
import { StackPartChoices } from "@maipai/spec/stack/ts/stack-part-choices.js";
import { stackParts } from "@/lib/parts";

const PartView = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).max(200), kind: z.enum(["model", "tool", "engine"]), category: z.string().min(1), chat: StackPartViewSchema.shape.chat,
  priority: z.number().int().min(1), label: z.string().min(1), description: z.string(), enabled: z.boolean(), state: z.enum(["ready", "missing", "installing", "updating", "failed", "unsupported"]),
  size_bytes: z.number().int().nonnegative(), download_bytes: z.number().int().nonnegative(), percent: z.number().min(0).max(100).nullable(),
  fits: z.object({ standard: z.boolean(), boost: z.boolean(), max: z.boolean(), reason: z.string().nullable() }),
  can_install: z.boolean(), install_block: z.string().nullable(), can_uninstall: z.boolean(), uninstall_block: z.string().nullable(), licence_needed: z.boolean(), required_by: z.array(z.string()),
  update: z.object({ available: z.boolean(), version: z.string().nullable() }),
}).strict().openapi("StackPartView");
const PartList = z.object({ audience: z.enum(["adult", "minor"]), parts: z.array(PartView) }).strict().openapi("StackPartList");
const ErrorBody = z.object({ error: z.string(), code: z.string() });
const partId = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).max(200).openapi({ param: { name: "id", in: "path" }, example: "z-image-turbo" }) });
const listRoute = createRoute({
  method: "get", path: "/", tags: ["Parts"], summary: "Every part this Stack can install and run, for one audience (PARTS-API-01)",
  description: "`enabled` and `priority` come from the one household choice Home pushes; `update.available` remains false until PARTS-UPDATE-01. A minor's list has neutral labels, empty descriptions and no adult-only part. This answer comes from memory and starts no work.",
  request: { query: z.object({ audience: z.enum(["adult", "minor"]), kind: z.enum(["model", "tool", "engine"]).optional(), category: z.string().max(40).optional() }) },
  responses: { 200: { content: { "application/json": { schema: PartList } }, description: "The audience filtered list of parts." } },
});
const choicesRoute = createRoute({
  method: "put", path: "/choices", tags: ["Parts"], summary: "The household's order and off list per category, pushed by Home (PARTS-ENABLE-01)",
  description: "Engines have no switch. The Stack stores only this one pushed value, no household data.",
  request: { body: { required: true, content: { "application/json": { schema: StackPartChoices } } } },
  responses: { 200: { content: { "application/json": { schema: PartList } }, description: "Stored choices and the adult list." }, 400: { content: { "application/json": { schema: ErrorBody } }, description: "Invalid choices or engine switch refused." }, 409: { content: { "application/json": { schema: ErrorBody } }, description: "A required part cannot be turned off." } },
});
const installRoute = createRoute({
  method: "post", path: "/{id}/install", tags: ["Parts"], summary: "Install a part by id",
  request: { params: partId, body: { required: false, content: { "application/json": { schema: z.unknown() } } } },
  responses: {
    202: { content: { "application/json": { schema: z.object({ job: z.string(), part: z.string(), joined: z.boolean() }) } }, description: "Install started or joined." },
    200: { content: { "application/json": { schema: z.object({ job: z.null(), part: z.string(), already_installed: z.literal(true) }) } }, description: "Already installed." },
    400: { content: { "application/json": { schema: ErrorBody } }, description: "The body contains a key the Stack does not accept." },
    404: { content: { "application/json": { schema: ErrorBody } }, description: "unknown_component." },
    409: { content: { "application/json": { schema: ErrorBody } }, description: "The part cannot be installed on this computer or needs licence acceptance." },
  },
});
const removeRoute = createRoute({
  method: "delete", path: "/{id}", tags: ["Parts"], summary: "Uninstall a part by id", request: { params: partId },
  responses: {
    200: { content: { "application/json": { schema: z.object({ part: z.string(), freed_bytes: z.number().int(), removed: z.boolean() }) } }, description: "Removed, or removed=false when it was not installed." },
    404: { content: { "application/json": { schema: ErrorBody } }, description: "unknown_component." },
    409: { content: { "application/json": { schema: ErrorBody } }, description: "The part is in use or required." },
  },
});

export const partsRoutes = apiRouter<AppEnv>();
partsRoutes.openapi(listRoute, async (c) => c.json(await listParts(c.req.valid("query")), 200) as never);
partsRoutes.openapi(choicesRoute, async (c) => {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { return c.json({ error: "Choices must map categories to unique order and off ids.", code: "invalid_choices" }, 400); }
  const parsed = StackPartChoices.safeParse(raw);
  if (!parsed.success) return c.json({ error: "Choices must map categories to unique order and off ids.", code: "invalid_choices" }, 400);
  const refusal = choicesRefusal(parsed.data as Choices);
  if (refusal) return c.json({ error: refusal.error, code: refusal.code }, refusal.status);
  writePartChoices(parsed.data as Choices);
  return c.json(await listParts({ audience: "adult" }), 200) as never;
});
partsRoutes.openapi(installRoute, async (c) => {
  const id = c.req.valid("param").id;
  const def = PART_DEFS.find((row) => row.id === id);
  if (def?.kind === "engine") return c.json({ error: `${def.label} is installed with the first part that runs on it.`, code: "engine_part" }, 409);
  // A household LoRA is not a part; an unknown id is a 404 from startComponentInstall itself (no disk scan here).
  if (id.startsWith("lora.")) return c.json({ error: `There is no part called ${id.slice(0, 60)}.`, code: "unknown_component" }, 404);
  let raw: unknown = {};
  const text = await c.req.text();
  if (text.trim()) {
    try { raw = JSON.parse(text); } catch { return c.json({ error: "The install body may only carry accepted_licence and accepted_by; a link or checksum is never accepted, the Stack owns them.", code: "body_not_allowed" }, 400); }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return c.json({ error: "The install body may only carry accepted_licence and accepted_by; a link or checksum is never accepted, the Stack owns them.", code: "body_not_allowed" }, 400);
    const extra = Object.keys(raw).find((key) => key !== "accepted_licence" && key !== "accepted_by");
    if (extra) return c.json({ error: `The install body may only carry accepted_licence and accepted_by; a link or checksum is never accepted, the Stack owns them. Unexpected key: ${extra}.`, code: "body_not_allowed" }, 400);
    const parsed = z.object({ accepted_licence: z.string().max(120).optional(), accepted_by: z.string().max(200).optional() }).strict().safeParse(raw);
    if (!parsed.success) return c.json({ error: "The install body may only carry accepted_licence and accepted_by; a link or checksum is never accepted, the Stack owns them.", code: "body_not_allowed" }, 400);
    raw = parsed.data;
  }
  try {
    const body = raw as { accepted_licence?: string; accepted_by?: string };
    const started = await startComponentInstall(id, undefined, { ...(body.accepted_licence ? { licence: body.accepted_licence } : {}), ...(body.accepted_by ? { by: body.accepted_by } : {}) });
    return started.job ? c.json({ job: started.job, part: id, joined: started.joined }, 202) : c.json({ job: null, part: id, already_installed: true as const }, 200);
  } catch (error) {
    if (error instanceof ComponentError) return c.json({ error: error.message, code: error.code }, error.status as 404 | 409);
    throw error;
  }
});
partsRoutes.openapi(removeRoute, async (c) => {
  const id = c.req.valid("param").id;
  const def = PART_DEFS.find((row) => row.id === id);
  if (def?.kind === "engine") return c.json({ error: `${def.label} is removed with the last part that runs on it.`, code: "engine_part" }, 409);
  if (id.startsWith("lora.")) return c.json({ error: `There is no part called ${id.slice(0, 60)}.`, code: "unknown_component" }, 404);
  try { const result = await uninstallComponent(id); return c.json({ part: result.component, freed_bytes: result.freed_bytes, removed: result.removed }, 200); }
  catch (error) { if (error instanceof ComponentError) return c.json({ error: error.message, code: error.code }, error.status as 404 | 409); throw error; }
});
