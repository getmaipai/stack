// Restart the Stack, restart the computer (off unless a setting allows it)
// and read the redacted log. Who may call is decided before these routes
// run, by lib/adminGuard.ts: Home's token, or an admin session with the
// CSRF rule; this file adds nothing of its own. Each call is logged with
// its time and source (lib/adminActions.ts).
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { adminExecutors, auditAction, LOG_TAIL_DEFAULT, LOG_TAIL_MAX, readLogTail, remoteOf, sourceOf } from "@/lib/adminActions";
import { settingValues } from "@/settings";
import { logger } from "@/lib/log";

const Fail = z.object({ error: z.string(), code: z.string() });
const failure = (description: string) => ({ content: { "application/json": { schema: Fail } }, description });
const Accepted = z.object({ ok: z.literal(true), action: z.enum(["service.restart", "host.reboot"]), source: z.enum(["admin", "home"]), at: z.string() });
const RESTART_DELAY_MS = 750;

const serviceRestartRoute = createRoute({
  method: "post", path: "/service/restart", tags: ["Admin"], summary: "Restart the Stack through its launchd or systemd unit",
  description: "Answers 202 first, then asks the service manager to restart the Stack about a second later, so the answer arrives. Calls made while it restarts get 503 `stack_restarting`; poll `/healthz`. Needs Home's token or a signed-in admin session. Logged as `admin.action.service.restart` with time, source and remote address.",
  responses: { 202: { content: { "application/json": { schema: Accepted } }, description: "The restart was requested." }, 409: failure("The Stack was started by hand, not by a service unit, so there is nothing to restart it through.") },
});
const rebootRoute = createRoute({
  method: "post", path: "/host/reboot", tags: ["Admin"], summary: "Restart the computer (off by default)",
  description: "Refused with 403 `reboot_disabled` unless the setting `stack.admin.allow_reboot` is on. Answers 202, then asks the operating system to restart about a second later. Logged as `admin.action.host.reboot` (or `.refused`).",
  responses: { 202: { content: { "application/json": { schema: Accepted } }, description: "The restart was requested." }, 403: failure("Restarting the computer is switched off in the Stack's settings.") },
});
const logsRoute = createRoute({
  method: "get", path: "/logs", tags: ["Admin"], summary: "The last lines of the Stack log, redacted",
  description: "Tokens, keys, cookies, passwords, admin session ids and setup codes are replaced with `[redacted]` before the lines leave the Stack. `tail` is 1 to 2000 lines (default 200).",
  request: { query: z.object({ tail: z.coerce.number().int().min(1).max(LOG_TAIL_MAX).default(LOG_TAIL_DEFAULT).openapi({ param: { name: "tail", in: "query" }, example: 200 }) }) },
  responses: { 200: { content: { "application/json": { schema: z.object({ lines: z.array(z.string()), tail: z.number().int(), redacted: z.literal(true) }) } }, description: "The newest lines, oldest first." } },
});

export const adminActionRoutes = apiRouter<AppEnv>();

/** Runs after the answer is sent; a failure is logged, since nobody is waiting to hear it. */
function later(name: string, run: () => void): void {
  setTimeout(() => {
    try { run(); } catch (error) { logger.appendLine(JSON.stringify({ event: `admin.action.${name}.failed`, at: new Date().toISOString(), reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" })); }
  }, RESTART_DELAY_MS).unref?.();
}

adminActionRoutes.openapi(serviceRestartRoute, (c) => {
  const source = sourceOf(c), remote = remoteOf(c);
  if (!adminExecutors().serviceInstalled()) {
    auditAction("service.restart.refused", source, remote, { code: "service_not_installed" });
    return c.json({ error: "The Stack was not started by a service unit (launchd or systemd), so it cannot restart itself. Restart it the way you started it, or run maipai-stack install-service so it runs as a service.", code: "service_not_installed" }, 409);
  }
  auditAction("service.restart", source, remote);
  later("service.restart", () => adminExecutors().restartService());
  return c.json({ ok: true as const, action: "service.restart" as const, source, at: new Date().toISOString() }, 202);
});

adminActionRoutes.openapi(rebootRoute, (c) => {
  const source = sourceOf(c), remote = remoteOf(c);
  if (settingValues()["stack.admin.allow_reboot"] !== true) {
    auditAction("host.reboot.refused", source, remote, { code: "reboot_disabled" });
    return c.json({ error: "Restarting the computer from the Stack is switched off, so nothing was restarted. Turn on \"Allow restarting the computer from the admin page\" in the Stack's settings, then try again.", code: "reboot_disabled" }, 403);
  }
  auditAction("host.reboot", source, remote);
  later("host.reboot", () => adminExecutors().rebootHost());
  return c.json({ ok: true as const, action: "host.reboot" as const, source, at: new Date().toISOString() }, 202);
});

adminActionRoutes.openapi(logsRoute, (c) => {
  const { tail } = c.req.valid("query");
  return c.json({ lines: readLogTail(tail), tail, redacted: true as const }, 200);
});
