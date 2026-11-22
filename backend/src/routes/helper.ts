// The Helper's routes (HELPER-01): chat, history, status and the Confirm and
// Cancel decisions on a proposal card. Admin only: a request must carry an admin session (the
// guard in lib/adminGuard.ts has already checked it is live); Home's token
// is refused here, so the Helper never speaks to a household member.
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { Context } from "hono";
import type { AppEnv } from "@/types";
import { sourceOf } from "@/lib/adminActions";
import { cancel, chat, clearHistory, confirm, HELPER_MESSAGE_MAX, helperModelInstalled, listPending, readHistory } from "@/lib/helper";
import { HELPER_TOOLS } from "@/lib/helperTools";
import { STACK_JUDGE_MODEL } from "@/lib/modelCatalog";
import { EngineUnavailableError, getRoleStatus } from "@/lib/supervisor";
import { settingValues } from "@/settings";

const Fail = z.object({ error: z.string(), code: z.string() });
const failure = (description: string) => ({ content: { "application/json": { schema: Fail } }, description });
const ChangeSchema = z.object({ label: z.string(), from: z.string(), to: z.string() });
const PendingSchema = z.object({
  id: z.string().describe("The proposal id; Confirm and Cancel name it."),
  action: z.string().describe("One of the allow-listed action types."),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).describe("The exact parameters that will run. Confirm must send these back unchanged."),
  summary: z.string(), changes: z.array(ChangeSchema), note: z.string().nullable(), at: z.string(), expires_at: z.string(),
});
const MessageSchema = z.object({ role: z.enum(["user", "assistant"]), content: z.string(), at: z.string(), tools: z.array(z.string()).optional() });
const CallSchema = z.object({ name: z.string(), args: z.record(z.string(), z.unknown()) });
const Id = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });

const statusRoute = createRoute({
  method: "get", path: "/status", tags: ["Helper"], summary: "Whether the Helper is installed and awake",
  description: "The Helper is the admin page's chat assistant, with its own small model and process. `state` is the role state (`notInstalled`, `installed`, `loaded`, `ready`, `busy`, `offline`); it loads on the first message and unloads after `keep_warm_minutes` idle. `model` is the pinned catalog entry to install when `installed` is false.",
  responses: {
    200: { content: { "application/json": { schema: z.object({
      installed: z.boolean(), state: z.string(), reason: z.string().nullable(), keep_warm_minutes: z.number(),
      model: z.object({ id: z.string(), repo: z.string(), revision: z.string(), licence: z.string(), approx_bytes: z.number().int(), url: z.string(), sha256: z.string(), engine: z.string(), role: z.string() }),
      tools: z.array(z.object({ name: z.string(), kind: z.enum(["read", "write"]), description: z.string() })),
    }) } }, description: "The Helper's status." },
    403: failure("Only a signed-in admin may use the Helper."),
  },
});
const historyRoute = createRoute({
  method: "get", path: "/history", tags: ["Helper"], summary: "The chat so far and what waits for approval",
  responses: { 200: { content: { "application/json": { schema: z.object({ messages: z.array(MessageSchema), pending: z.array(PendingSchema) }) } }, description: "Kept in the Stack's database until cleared." }, 403: failure("Only a signed-in admin may use the Helper.") },
});
const clearRoute = createRoute({
  method: "delete", path: "/history", tags: ["Helper"], summary: "Clear the chat and drop anything waiting for approval",
  responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Cleared." }, 403: failure("Only a signed-in admin may use the Helper.") },
});
const chatRoute = createRoute({
  method: "post", path: "/chat", tags: ["Helper"], summary: "Send the Helper a message",
  description: `Loads the Helper's model if it is asleep (a few seconds), lets it call read tools, and returns its answer. Any change it wants comes back in \`pending\` as a proposal card (action, exact parameters, a plain sentence and the current and new values); nothing changes until \`POST /stack/v1/helper/actions/{id}/confirm\` carries those same parameters back. Messages are at most ${HELPER_MESSAGE_MAX} characters. 409 \`not_installed\` when the model is not on disk, 503 \`helper_unavailable\` when it cannot start (not enough memory, engine missing).`,
  request: { body: { required: true, content: { "application/json": { schema: z.object({ message: z.string().min(1).max(HELPER_MESSAGE_MAX) }) } } } },
  responses: {
    200: { content: { "application/json": { schema: z.object({ reply: z.string(), pending: z.array(PendingSchema), tools: z.array(z.string()), calls: z.array(CallSchema), dropped: z.number().int().describe("Sentences removed because a number or model name was not in what the tools returned."), wake_ms: z.number().int() }) } }, description: "The answer." },
    403: failure("Only a signed-in admin may use the Helper."), 409: failure("The Helper's model is not installed."), 503: failure("The Helper could not start."),
  },
});
const confirmRoute = createRoute({
  method: "post", path: "/actions/{id}/confirm", tags: ["Helper"], summary: "Confirm one proposed change",
  description: "Runs the proposal through the same routes the page uses and logs it as `admin.action.helper.approved`. The body must carry the proposal's `action` and `params` exactly as the card showed them. The Stack checks that the id was proposed in this chat, is still waiting, has not expired (10 minutes) and was not edited, and runs the stored parameters, never the posted ones. 404 `not_found`: never proposed here. 409 `used`: already confirmed or cancelled. 409 `edited`: the parameters differ, nothing ran and the proposal is burned. 410 `expired`. 502 `change_failed`: tried and refused.",
  request: { params: Id, body: { required: true, content: { "application/json": { schema: z.object({ action: z.string(), params: z.record(z.string(), z.unknown()) }) } } } },
  responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true), summary: z.string(), result: z.string() }) } }, description: "Done." }, 403: failure("Only a signed-in admin may use the Helper."), 404: failure("The Helper never proposed that change here."), 409: failure("Already used, or the parameters were edited."), 410: failure("The proposal expired."), 502: failure("The change was tried and the Stack refused it.") },
});
const cancelRoute = createRoute({
  method: "post", path: "/actions/{id}/cancel", tags: ["Helper"], summary: "Cancel one proposed change",
  request: { params: Id },
  responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Dropped." }, 403: failure("Only a signed-in admin may use the Helper."), 404: failure("That proposal is no longer waiting.") },
});

export const helperRoutes = apiRouter<AppEnv>();

const refused = (c: Context<AppEnv>) => c.json({ error: "Only a signed-in admin may use the Helper. Sign in to the admin page and try again.", code: "admin_only" }, 403);
const admin = (c: Context<AppEnv>) => sourceOf(c) === "admin";

helperRoutes.openapi(statusRoute, (c) => {
  if (!admin(c)) return refused(c) as never;
  const installed = helperModelInstalled();
  const status = getRoleStatus("helper");
  const m = STACK_JUDGE_MODEL;
  return c.json({
    installed, state: status.state, reason: status.reason ?? null,
    keep_warm_minutes: Math.max(1, Number(settingValues()["stack.engines.helper.keep_warm_minutes"] ?? 5)),
    model: { id: m.id, repo: m.repo!, revision: m.revision!, licence: m.license!, approx_bytes: m.download!.approx_bytes, url: m.download!.url, sha256: m.download!.sha256!, engine: m.engine!, role: m.role },
    tools: HELPER_TOOLS.map((t) => ({ name: t.name, kind: t.kind, description: t.description })),
  }, 200);
});

helperRoutes.openapi(historyRoute, (c) => admin(c) ? c.json({ messages: readHistory(), pending: listPending() }, 200) : refused(c) as never);
helperRoutes.openapi(clearRoute, (c) => { if (!admin(c)) return refused(c) as never; clearHistory(); return c.json({ ok: true as const }, 200); });

helperRoutes.openapi(chatRoute, async (c) => {
  if (!admin(c)) return refused(c) as never;
  if (!helperModelInstalled()) {
    return c.json({ error: "The Helper's model is not installed. Use Install the Helper on the Helper screen, then ask again.", code: "not_installed" }, 409) as never;
  }
  const { message } = c.req.valid("json");
  try {
    const result = await chat(message);
    return c.json({ reply: result.reply, pending: result.pending, tools: result.tools, calls: result.calls, dropped: result.dropped, wake_ms: result.wakeMs }, 200);
  } catch (error) {
    const reason = error instanceof EngineUnavailableError ? error.reason : error instanceof Error ? error.message : "unknown";
    return c.json({ error: `The Helper could not start or answer: ${reason.slice(0, 300)} Close something that uses memory, or restart the Stack, then ask again.`, code: "helper_unavailable" }, 503) as never;
  }
});

helperRoutes.openapi(confirmRoute, async (c) => {
  if (!admin(c)) return refused(c) as never;
  const body = c.req.valid("json");
  const result = await confirm(c.req.valid("param").id, body);
  if (result.ok) return c.json({ ok: true as const, summary: result.summary, result: result.result }, 200);
  const status = ({ not_found: 404, used: 409, edited: 409, expired: 410, failed: 502 } as const)[result.code];
  return c.json({ error: result.code === "failed" ? `The Stack refused the change: ${result.error}` : result.error, code: result.code === "failed" ? "change_failed" : result.code }, status) as never;
});
helperRoutes.openapi(cancelRoute, (c) => {
  if (!admin(c)) return refused(c) as never;
  return cancel(c.req.valid("param").id) ? c.json({ ok: true as const }, 200) : c.json({ error: "That proposal is no longer waiting.", code: "not_found" }, 404) as never;
});
