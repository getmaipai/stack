// The Stack holds the household's model choices (owner decision 2026-11-21; docs/dev/choices.md). One read for the shared AI and models page,
// and the writes behind it: a pick per category and level (and per hardware profile), the order, the recommended setup, what is unused,
// add-a-model-and-use-it, and the one-time import of Home's old values. Home and the admin page are two views over these routes. Writes go
// through the same guard as every other write (the loopback checks and Home's token, or the admin session with its CSRF header).
import { PRIMARY_ROLE } from "@/roles";
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { remoteOf, sourceOf } from "@/lib/adminActions";
import { addModel, applyRecommended, isRefusal, migrate, readChoices, readUnused, removeUnused, setOrder, setPick } from "@/lib/choices";
import {
  AddModelBody, AddModelResult, ChoicesViewSchema, ErrorBody, MigrateBody, MigrateResult, OrderBody, OrderResult, PickBody, PickResult, RecommendedBody, RecommendedResult, RemoveBody, RemoveResult, UnusedListSchema,
} from "@/lib/choicesSchema";

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ content: { "application/json": { schema } }, description });
const refusal = json(ErrorBody, "A plain sentence and a stable code.");
const path = z.object({ category: z.string().min(1).max(40).openapi({ param: { name: "category", in: "path" }, example: PRIMARY_ROLE }) });
const levelPath = path.extend({ tier: z.string().min(1).max(20).openapi({ param: { name: "tier", in: "path" }, example: "standard" }) });

const readRoute = createRoute({
  method: "get", path: "/", tags: ["Choices"], summary: "Everything the AI and models page shows, in one read",
  description: "Per category (chat, coding, pictures, video, music, voice, speech to text, embeddings, vision, wake word, stem splitter): the role switch and priority, the candidates with their plain facts (`label`, `summary`, `family`, `version`, `quantization` and `quantization_raw`, `license`, `repo`, `engine`, `role`, `size_bytes`, `min_profile`, and `search_text`, the lowercase text of all of them for one search box), whether each is installed, installing, not installed or unsupported and why, the order and the off list, and per level (Reduced, Standard, Boost, Max where they exist) the model in use, who chose it (`household`, `recommended`, `off`), every option with whether it fits, and the recommended pick with its reason. `profiles` shows the picks saved per hardware profile. Categories without levels have one, `standard`. `unused` is what no choice or order uses. Starts no work.",
  responses: { 200: json(ChoicesViewSchema, "The whole page.") },
});
const unusedRoute = createRoute({
  method: "get", path: "/unused", tags: ["Choices"], summary: "Installed models no choice, order or fallback uses, and what removing them frees",
  description: "A model is listed when it is installed, removable, chosen at no level, not in a category's order (unless that category switched it off), not required by another part and not what this computer's setup binds to a role. `tidy` is the Stack's own list of replaced and abandoned files (`/components/tidy`).",
  responses: { 200: json(UnusedListSchema, "The list, largest first.") },
});
const removeRoute = createRoute({
  method: "post", path: "/unused/remove", tags: ["Choices"], summary: "Remove the chosen unused models; each id is checked again at removal time",
  description: "Each id is judged on fresh state: a model that became used since the list was read is `kept` with the plain reason, never removed. A removal the Stack's own guards refuse (in use, required) is `failed` with its sentence. One id never stops the rest. `tidy: true` also runs the Stack's tidy of replaced and abandoned files.",
  request: { body: { required: true, content: { "application/json": { schema: RemoveBody } } } },
  responses: { 200: json(RemoveResult, "One line per id, in the order sent.") },
});
const recommendedRoute = createRoute({
  method: "post", path: "/recommended", tags: ["Choices"], summary: "Write the recommended pick for every level and the recommended role switches",
  description: "Stores the recommended model for every level this computer has one for, writes the role enable and priority settings as `profiles/apply` (custom_recommended) does, and starts the downloads of the Standard and Reduced picks that are missing. Safe to repeat; it never removes anything. `dry_run: true` answers what would change and writes nothing.",
  request: { body: { required: false, content: { "application/json": { schema: RecommendedBody } } } },
  responses: { 200: json(RecommendedResult, "What changed."), 400: refusal, 404: refusal, 409: refusal },
});
const addModelRoute = createRoute({
  method: "post", path: "/add-model", tags: ["Choices"], summary: "Add a chat model from a Hugging Face link and use it",
  description: "Reads the repository without downloading it (size, checksum, licence, architecture), refuses what it cannot size or license, stores the record, starts the checked download and, with `use: true`, selects the model for the category and level. The model then appears among the category's candidates with `kind: added`.",
  request: { body: { required: true, content: { "application/json": { schema: AddModelBody } } } },
  responses: { 200: json(AddModelResult, "The model is stored and its download has started (or it was already installed)."), 400: refusal, 404: refusal, 409: refusal },
});
const migrateRoute = createRoute({
  method: "post", path: "/migrate", tags: ["Choices"], summary: "Import Home's old model values once",
  description: "Takes Home's per-level models, orders, feature switches and added-model records. Each value is accepted, unchanged or refused on its own with a plain reason; refused values are returned so Home keeps and shows them. Marks the migration done in the Stack (not on a dry run); a second call reads and writes nothing and answers `already_done`.",
  request: { body: { required: true, content: { "application/json": { schema: MigrateBody } } } },
  responses: { 200: json(MigrateResult, "Per-value results."), 400: refusal, 404: refusal, 409: refusal },
});
const orderRoute = createRoute({
  method: "put", path: "/{category}/order", tags: ["Choices"], summary: "Set a category's model order and off list",
  description: "The same stored value as `PUT /parts/choices`, limited to one category. Candidates left out keep their default place after the listed ones. An engine cannot be switched off, and a model another part needs cannot (409 `required_by`).",
  request: { params: path, body: { required: true, content: { "application/json": { schema: OrderBody } } } },
  responses: { 200: json(OrderResult, "The order after the change."), 400: refusal, 404: refusal, 409: refusal },
});
const pickRoute = createRoute({
  method: "put", path: "/{category}/{tier}", tags: ["Choices"], summary: "Choose the model for a category and level, for this computer or for a hardware profile",
  description: "Validates that the model is a candidate of the category, is offered for the level on the profile, fits it (this computer's own profile) and is installed or installable, then stores the pick in the Stack. A missing model starts downloading first (`install: false` skips that). `model: \"recommended\"` clears the pick; `model: \"off\"` switches a Reduced, Boost or Max level off. A Standard voice pick sets the voice engine, and a Standard chat pick sets the chat model once it is installed. With `profile` the pick is saved for that hardware profile (judged only on being offered there). Refusals carry a stable `code`: unknown_category, unknown_level, no_such_level, unknown_model, not_offered_here, does_not_fit, unsupported, unknown_option, standard_cannot_be_off, computer_too_small, or the install refusal (not_enough_space, licence_required, not_available).",
  request: { params: levelPath, body: { required: true, content: { "application/json": { schema: PickBody } } } },
  responses: { 200: json(PickResult, "Stored (or already stored)."), 400: refusal, 404: refusal, 409: refusal },
});

export const choicesRoutes = apiRouter<AppEnv>();
choicesRoutes.openapi(readRoute, async (c) => c.json(await readChoices(), 200) as never);
choicesRoutes.openapi(unusedRoute, async (c) => c.json(await readUnused(), 200) as never);
choicesRoutes.openapi(removeRoute, async (c) => {
  const body = c.req.valid("json");
  return c.json(await removeUnused(body.ids, body.tidy, sourceOf(c), remoteOf(c)), 200) as never;
});
choicesRoutes.openapi(recommendedRoute, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = RecommendedBody.safeParse(body ?? {});
  if (!parsed.success) return c.json({ error: "Send { \"dry_run\": true } or nothing.", code: "invalid_body" }, 400);
  const result = await applyRecommended(parsed.data.dry_run, sourceOf(c), remoteOf(c), parsed.data.household_has_minors);
  return isRefusal(result) ? c.json({ error: result.error, code: result.code }, result.status) : c.json(result, 200) as never;
});
choicesRoutes.openapi(addModelRoute, async (c) => {
  const body = c.req.valid("json");
  const result = await addModel({ source: body.source, ...(body.file ? { file: body.file } : {}), tier: body.tier, use: body.use }, sourceOf(c), remoteOf(c));
  return isRefusal(result) ? c.json({ error: result.error, code: result.code }, result.status) : c.json(result, 200) as never;
});
choicesRoutes.openapi(migrateRoute, async (c) => {
  const result = await migrate(c.req.valid("json") as Parameters<typeof migrate>[0], sourceOf(c), remoteOf(c));
  return isRefusal(result) ? c.json({ error: result.error, code: result.code }, result.status) as never : c.json(result, 200) as never;
});
choicesRoutes.openapi(orderRoute, async (c) => {
  const { category } = c.req.valid("param");
  const body = c.req.valid("json");
  const result = await setOrder(category, { order: body.order, ...(body.off ? { off: body.off } : {}) }, sourceOf(c), remoteOf(c));
  return isRefusal(result) ? c.json({ error: result.error, code: result.code }, result.status) : c.json(result, 200) as never;
});
choicesRoutes.openapi(pickRoute, async (c) => {
  const { category, tier } = c.req.valid("param");
  const body = c.req.valid("json");
  const result = await setPick({ category, tier, model: body.model, ...(body.options ? { options: body.options } : {}), ...(body.profile ? { profile: body.profile } : {}), install: body.install }, sourceOf(c), remoteOf(c));
  return isRefusal(result) ? c.json({ error: result.error, code: result.code }, result.status) : c.json(result, 200) as never;
});
