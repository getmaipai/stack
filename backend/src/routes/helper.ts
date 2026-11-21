// The Helper's routes (HELPER-01): chat, history, status and the Approve and
// Deny decisions. Admin only: a request must carry an admin session (the
// guard in lib/adminGuard.ts has already checked it is live); Home's token
// is refused here, so the Helper never speaks to a household member.
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { Context } from "hono";
import type { AppEnv } from "@/types";
import { sourceOf } from "@/lib/adminActions";
import { approve, chat, clearHistory, deny, HELPER_MESSAGE_MAX, helperModelInstalled, listPending, readHistory } from "@/lib/helper";
import { HELPER_TOOLS } from "@/lib/helperTools";
import { STACK_JUDGE_MODEL } from "@/lib/modelCatalog";
import { EngineUnavailableError, getRoleStatus } from "@/lib/supervisor";
import { settingValues } from "@/settings";

const Fail = z.object({ error: z.string(), code: z.string() });
const failure = (description: string) => ({ content: { "application/json": { schema: Fail } }, description });
const PendingSchema = z.object({ id: z.string(), tool: z.string(), args: z.record(z.string(), z.unknown()), summary: z.string(), at: z.string() });
const MessageSchema = z.object({ role: z.enum(["user", "assistant"]), content: z.string(), at: z.string(), tools: z.array(z.string()).optional() });
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
  description: `Loads the Helper's model if it is asleep (a few seconds), lets it call read tools, and returns its answer. Any change it wants comes back in \`pending\`; nothing changes until \`POST /stack/v1/helper/approvals/{id}/approve\`. Messages are at most ${HELPER_MESSAGE_MAX} characters. 409 \`not_installed\` when the model is not on disk, 503 \`helper_unavailable\` when it cannot start (not enough memory, engine missing).`,
  request: { body: { required: true, content: { "application/json": { schema: z.object({ message: z.string().min(1).max(HELPER_MESSAGE_MAX) }) } } } },
  responses: {
    200: { content: { "application/json": { schema: z.object({ reply: z.string(), pending: z.array(PendingSchema), tools: z.array(z.string()), wake_ms: z.number().int() }) } }, description: "The answer." },
    403: failure("Only a signed-in admin may use the Helper."), 409: failure("The Helper's model is not installed."), 503: failure("The Helper could not start."),
  },
});
const approveRoute = createRoute({
  method: "post", path: "/approvals/{id}/approve", tags: ["Helper"], summary: "Approve one change the Helper asked for",
  description: "Runs the change through the same route the page uses and logs it as `admin.action.helper.approved` (by Helper, approved by admin). A request waits at most 10 minutes.",
  request: { params: Id },
  responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true), summary: z.string(), result: z.string() }) } }, description: "Done." }, 403: failure("Only a signed-in admin may use the Helper."), 404: failure("That request is no longer waiting."), 502: failure("The change was tried and the Stack refused it.") },
});
const denyRoute = createRoute({
  method: "post", path: "/approvals/{id}/deny", tags: ["Helper"], summary: "Turn down one change the Helper asked for",
  request: { params: Id },
  responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Dropped." }, 403: failure("Only a signed-in admin may use the Helper."), 404: failure("That request is no longer waiting.") },
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
    return c.json({ reply: result.reply, pending: result.pending, tools: result.tools, wake_ms: result.wakeMs }, 200);
  } catch (error) {
    const reason = error instanceof EngineUnavailableError ? error.reason : error instanceof Error ? error.message : "unknown";
    return c.json({ error: `The Helper could not start or answer: ${reason.slice(0, 300)} Close something that uses memory, or restart the Stack, then ask again.`, code: "helper_unavailable" }, 503) as never;
  }
});

helperRoutes.openapi(approveRoute, async (c) => {
  if (!admin(c)) return refused(c) as never;
  const result = await approve(c.req.valid("param").id);
  if (result.ok) return c.json({ ok: true as const, summary: result.summary, result: result.result }, 200);
  return result.code === "not_found" ? c.json({ error: result.error, code: "not_found" }, 404) as never : c.json({ error: `The Stack refused the change: ${result.error}`, code: "change_failed" }, 502) as never;
});
helperRoutes.openapi(denyRoute, (c) => {
  if (!admin(c)) return refused(c) as never;
  return deny(c.req.valid("param").id) ? c.json({ ok: true as const }, 200) : c.json({ error: "That request is no longer waiting.", code: "not_found" }, 404) as never;
});
