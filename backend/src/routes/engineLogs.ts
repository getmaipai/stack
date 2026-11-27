// The per-engine live output buffer, for the admin page only (STACK-ENGINE-LOG-01).
// Home's token does not open these: every call needs a live admin session.
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { Context } from "hono";
import type { AppEnv } from "@/types";
import { adminCookie } from "@/lib/adminGuard";
import { validateSession } from "@/lib/adminAuth";
import { engineLogLines, engineLogRoles, subscribeEngineLogs } from "@/lib/engineLogs";

const Fail = z.object({ error: z.string(), code: z.string() });
const Line = z.object({ seq: z.number().int(), at: z.string(), role: z.string(), line: z.string() });
const listRoute = createRoute({
  method: "get", path: "/engine-logs", tags: ["Admin"], summary: "Recent output of every engine, redacted (admin session only)",
  description: "Secrets and prompt text are replaced before a line is stored. Needs a signed-in admin session; Home's token does not open it. `tail` is 1 to 500 lines per role (default 100).",
  request: { query: z.object({ tail: z.coerce.number().int().min(1).max(500).default(100).openapi({ param: { name: "tail", in: "query" }, example: 100 }) }) },
  responses: { 200: { content: { "application/json": { schema: z.object({ roles: z.array(z.object({ role: z.string(), lines: z.array(Line) })), redacted: z.literal(true) }) } }, description: "Per role, the newest lines, oldest first." }, 401: { content: { "application/json": { schema: Fail } }, description: "No admin session." } },
});
const streamRoute = createRoute({
  method: "get", path: "/engine-logs/stream", tags: ["Admin"], summary: "Live engine output (server-sent events, admin session only)",
  responses: { 200: { content: { "text/event-stream": { schema: z.string() } }, description: "One `data:` frame per redacted line, as JSON." }, 401: { content: { "application/json": { schema: Fail } }, description: "No admin session." } },
});

async function signedIn(c: Context): Promise<boolean> { const token = adminCookie(c.req.raw); return token ? (await validateSession(token)) !== null : false; }
const refusal = { error: "Engine output is for the signed-in admin. Sign in on the admin page first.", code: "admin_session_required" } as const;

export const engineLogRoutes = apiRouter<AppEnv>();
engineLogRoutes.openapi(listRoute, async (c) => {
  if (!await signedIn(c)) return c.json(refusal, 401);
  const { tail } = c.req.valid("query");
  return c.json({ roles: engineLogRoles().map((role) => ({ role, lines: engineLogLines(role, tail) })), redacted: true as const }, 200);
});
engineLogRoutes.openapi(streamRoute, async (c) => {
  if (!await signedIn(c)) return c.json(refusal, 401) as never;
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      unsubscribe = subscribeEngineLogs((entry) => { try { controller.enqueue(encoder.encode(`id: ${entry.seq}\ndata: ${JSON.stringify(entry)}\n\n`)); } catch { /* closed */ } });
      c.req.raw.signal?.addEventListener("abort", () => { unsubscribe?.(); unsubscribe = null; try { controller.close(); } catch { /* already closed */ } }, { once: true });
    },
    cancel() { unsubscribe?.(); unsubscribe = null; },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } }) as never;
});
