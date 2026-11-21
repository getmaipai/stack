// The admin account's routes: first-run setup, sign-in and out, password
// change, and who-am-I. All logic is in lib/adminAuth.ts; this file maps
// it to HTTP, sets the session cookie, and writes the audit lines
// (time and remote address, never a password or a code). Who may reach
// these routes and the CSRF rule are in lib/adminGuard.ts.
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { Context } from "hono";
import type { AppEnv } from "@/types";
import { AdminError, changePassword, login, logout, setupAdmin, validateSession } from "@/lib/adminAuth";
import { adminCookie, ADMIN_COOKIE } from "@/lib/adminGuard";
import { dataDir } from "@/lib/paths";
import { logger } from "@/lib/log";

const SESSION_COOKIE_MAX_AGE = 12 * 60 * 60;
const Fail = z.object({ error: z.string(), code: z.string(), retry_after: z.number().int().optional() });
const Ok = z.object({ ok: z.literal(true) });
const failures = {
  400: { content: { "application/json": { schema: Fail } }, description: "The request was refused with a plain sentence and a stable code." },
  401: { content: { "application/json": { schema: Fail } }, description: "The password is wrong or the sign-in has ended." },
  403: { content: { "application/json": { schema: Fail } }, description: "The setup code is wrong." },
  409: { content: { "application/json": { schema: Fail } }, description: "The admin account already exists, or none exists yet." },
  429: { content: { "application/json": { schema: Fail } }, description: "Too many wrong tries; `retry_after` is the seconds to wait." },
};

const setupRoute = createRoute({
  method: "post", path: "/setup", tags: ["Admin"], summary: "First-run: set the admin password from the one-time setup code",
  request: { body: { content: { "application/json": { schema: z.object({ code: z.string(), password: z.string() }) } } } },
  responses: { 200: { content: { "application/json": { schema: Ok } }, description: "The admin account exists; sign in with the password." }, ...failures },
});
const loginRoute = createRoute({
  method: "post", path: "/login", tags: ["Admin"], summary: "Sign in; sets the stack_admin session cookie",
  request: { body: { content: { "application/json": { schema: z.object({ password: z.string() }) } } } },
  responses: { 200: { content: { "application/json": { schema: Ok } }, description: "Signed in. The cookie is HttpOnly, SameSite=Strict, Path=/, 12 hours at most, 30 minutes idle." }, ...failures },
});
const logoutRoute = createRoute({
  method: "post", path: "/logout", tags: ["Admin"], summary: "Sign out and clear the cookie",
  responses: { 200: { content: { "application/json": { schema: Ok } }, description: "The session is closed (also when there was none)." } },
});
const passwordRoute = createRoute({
  method: "post", path: "/password", tags: ["Admin"], summary: "Change the admin password (needs a signed-in session)",
  request: { body: { content: { "application/json": { schema: z.object({ current: z.string(), new: z.string() }) } } } },
  responses: { 200: { content: { "application/json": { schema: Ok } }, description: "Changed; every other sign-in ended." }, ...failures },
});
const sessionRoute = createRoute({
  method: "get", path: "/session", tags: ["Admin"], summary: "Who am I: the current sign-in and when it ends",
  responses: {
    200: { content: { "application/json": { schema: z.object({ signed_in: z.literal(true), expires_at: z.string() }) } }, description: "Signed in; `expires_at` is the absolute 12-hour limit." },
    401: { content: { "application/json": { schema: Fail } }, description: "Not signed in." },
  },
});

export const adminRoutes = apiRouter<AppEnv>();

type Status = 400 | 401 | 403 | 409 | 429;
const STATUS: Record<string, Status> = { invalid_setup_code: 403, too_many_attempts: 429, rate_limited: 429, password_too_short: 400, admin_exists: 409, no_admin: 409, wrong_password: 401, invalid_session: 401 };

/** The address the connection came from (never a forwarded header). */
function remoteOf(c: Context): string {
  const env = c.env as { requestIP?: (request: Request) => { address: string } | null } | undefined;
  return env?.requestIP?.(c.req.raw)?.address ?? "unknown";
}

/** The Secure flag is set when the request came in over https (directly or through Tailscale's forwarder). */
function secure(c: Context): boolean {
  return new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https";
}

function audit(event: string, remote: string, extra: Record<string, string> = {}): void {
  logger.appendLine(JSON.stringify({ event, at: new Date().toISOString(), remote, ...extra }));
}

function cookieValue(c: Context, token: string, maxAge: number): string {
  return `${ADMIN_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure(c) ? "; Secure" : ""}`;
}

function fail(c: Context, error: unknown) {
  if (error instanceof AdminError) {
    const status = STATUS[error.code] ?? 400;
    const body: { error: string; code: string; retry_after?: number } = { error: error.message, code: error.code };
    if (error.retryAfterSeconds !== undefined) body.retry_after = error.retryAfterSeconds;
    return c.json(body, status, error.retryAfterSeconds !== undefined ? { "Retry-After": String(error.retryAfterSeconds) } : {});
  }
  throw error;
}

adminRoutes.openapi(setupRoute, async (c) => {
  const { code, password } = c.req.valid("json");
  const remote = remoteOf(c);
  try {
    await setupAdmin(code, password, dataDir);
  } catch (error) {
    if (error instanceof AdminError) audit("admin.setup.failed", remote, { code: error.code });
    return fail(c, error) as never;
  }
  audit("admin.setup", remote);
  return c.json({ ok: true as const }, 200);
});

adminRoutes.openapi(loginRoute, async (c) => {
  const { password } = c.req.valid("json");
  const remote = remoteOf(c);
  let token: string;
  try {
    token = await login(password, remote);
  } catch (error) {
    if (error instanceof AdminError) audit("admin.login.failed", remote, { code: error.code });
    return fail(c, error) as never;
  }
  audit("admin.login", remote);
  c.header("Set-Cookie", cookieValue(c, token, SESSION_COOKIE_MAX_AGE));
  c.header("Cache-Control", "no-store");
  return c.json({ ok: true as const }, 200);
});

adminRoutes.openapi(logoutRoute, async (c) => {
  const token = adminCookie(c.req.raw);
  if (token) await logout(token);
  audit("admin.logout", remoteOf(c));
  c.header("Set-Cookie", cookieValue(c, "", 0));
  return c.json({ ok: true as const }, 200);
});

adminRoutes.openapi(passwordRoute, async (c) => {
  const { current, new: next } = c.req.valid("json");
  const token = adminCookie(c.req.raw);
  const remote = remoteOf(c);
  try {
    if (!token) throw new AdminError("invalid_session", "You are not signed in. Sign in, then change the password.");
    await changePassword(token, current, next);
  } catch (error) {
    if (error instanceof AdminError) audit("admin.password.failed", remote, { code: error.code });
    return fail(c, error) as never;
  }
  audit("admin.password", remote);
  return c.json({ ok: true as const }, 200);
});

adminRoutes.openapi(sessionRoute, async (c) => {
  const token = adminCookie(c.req.raw);
  const session = token ? await validateSession(token) : null;
  if (!session) return c.json({ error: "You are not signed in. Sign in with the admin password.", code: "invalid_session" }, 401);
  return c.json({ signed_in: true as const, expires_at: new Date(session.expiresAt).toISOString() }, 200);
});
