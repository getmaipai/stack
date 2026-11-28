// Who may call, with the admin page added (Owner-approved 2026-11-21).
// Home's path is unchanged and stays first: loopback Host and Origin
// checks, then Home's token on every write (requestGuard.ts). Beside it,
// a request to /stack/v1/* that carries a live `stack_admin` session
// cookie is accepted in place of Home's token. A write with a cookie
// must also carry `x-stack-admin: 1` and an Origin equal to the Host, so
// a web page on another site cannot ride the cookie. The admin routes
// themselves (/stack/v1/admin/*) take no Home token: they check the
// password or the session inside.
//
// On the Tailscale listener nothing is open: every /stack/v1/* request
// needs a live admin session, except /healthz, the sign-in routes and
// the session probe. Home's token is not accepted there at all.
import { guardRequest } from "@/lib/requestGuard";
import { checkLoopbackCaller, refuse } from "@/lib/loopbackGuard";
import { validateSession } from "@/lib/adminAuth";
import { isAdminUiPath } from "@/lib/adminUi";
import { appKeyAdmit, runAdmitted } from "@/lib/appKeyGuard";

export const ADMIN_COOKIE = "stack_admin";
export const ADMIN_HEADER = "x-stack-admin";
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ADMIN_PREFIX = "/stack/v1/admin/";

export type GuardMode = { tailscaleAddress?: string };

/** The value of the admin session cookie, or null. */
export function adminCookie(request: Request): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === ADMIN_COOKIE) {
      const value = part.slice(index + 1).trim();
      return value === "" ? null : value;
    }
  }
  return null;
}

function hostnameOf(host: string | null): string {
  return (host ?? "").trim().toLowerCase().replace(/:\d{1,5}$/, "");
}

function csrfRefusal(request: Request): Response | null {
  if (request.headers.get(ADMIN_HEADER) !== "1") {
    return refuse(403, "admin_header_required", "This request came from a signed-in admin page but did not carry the x-stack-admin: 1 header, so the Stack did not run it. Use the Stack's own admin page.");
  }
  const origin = request.headers.get("origin");
  const host = (request.headers.get("host") ?? "").trim();
  let same = false;
  try { if (origin !== null) { const parsed = new URL(origin); same = parsed.host !== "" && parsed.host === new URL(`${parsed.protocol}//${host}`).host; } } catch { /* junk origin */ }
  if (!same) return refuse(403, "origin_not_allowed", "The Stack takes signed-in admin requests only from its own admin page. Use the page the Stack serves.");
  return null;
}

function formBody(request: Request): boolean {
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  return contentType === "text/plain" || contentType === "application/x-www-form-urlencoded";
}

function hostAndOrigin(request: Request, address: string): Response | null {
  if (hostnameOf(request.headers.get("host")) !== address) {
    return refuse(421, "host_not_allowed", "This listener answers only to its own Tailscale address. Reach it by the address the Stack logged at start.");
  }
  const origin = request.headers.get("origin");
  if (origin !== null) {
    let same = false;
    try { const parsed = new URL(origin); same = parsed.host !== "" && parsed.host === new URL(`${parsed.protocol}//${(request.headers.get("host") ?? "").trim()}`).host; } catch { /* junk */ }
    if (!same) return refuse(403, "origin_not_allowed", "The Stack does not take requests from another web page. Use the admin page the Stack serves.");
  }
  return null;
}

/** A refusal, or null when the request may go on to the routes. */
export async function guardAdminAware(request: Request, mode: GuardMode = {}): Promise<Response | null> {
  const tailscale = mode.tailscaleAddress !== undefined;
  if (tailscale) {
    const bad = hostAndOrigin(request, mode.tailscaleAddress!);
    if (bad) return bad;
  }
  const path = new URL(request.url).pathname;
  const write = !READ_METHODS.has(request.method.toUpperCase());
  const token = adminCookie(request);
  if (tailscale) {
    if (path === "/healthz") return null;
    // The admin page itself is static (GET only); every number on it still needs the session below.
    if (isAdminUiPath(path) && !write) return null;
    if (!path.startsWith("/stack/v1/")) return refuse(404, "not_found", "Not found. Only the admin routes are served on this address.");
    if (path === "/stack/v1/admin/setup") return refuse(403, "setup_local_only", "First-run setup is done on the computer the Stack runs on, not over Tailscale. Open the admin page there.");
  }
  if (path.startsWith(ADMIN_PREFIX)) {
    if (!tailscale) { const bad = checkLoopbackCaller(request); if (bad) return bad; }
    if (write && formBody(request)) return refuse(415, "content_type_not_allowed", "The Stack takes JSON, not a form or plain-text body. Send the request as application/json.");
    if (write && token) return csrfRefusal(request);
    return null;
  }
  if (path.startsWith("/stack/v1/") && token) {
    const session = await validateSession(token);
    if (session) {
      if (write && formBody(request)) return refuse(415, "content_type_not_allowed", "The Stack takes JSON, not a form or plain-text body. Send the request as application/json.");
      return write ? csrfRefusal(request) : null;
    }
  }
  if (tailscale) {
    return refuse(401, "admin_session_required", "Sign in to the admin page first. This address takes only signed-in admin requests.");
  }
  return guardRequest(request);
}

/** `fetch` behind the guard, with the admin session accepted beside Home's token. */
export function adminGuardedFetch(inner: (request: Request, server: unknown) => Response | Promise<Response>, mode: GuardMode = {}): (request: Request, server: unknown) => Promise<Response> {
  return async (request, server) => {
    // APP-KEYS-01: a request with a bearer app key and no Home token goes through the key's own door (loopback listener only).
    if (mode.tailscaleAddress === undefined) {
      const admit = await appKeyAdmit(request);
      if (admit) return "response" in admit ? admit.response : runAdmitted(admit, () => inner(request, server));
    }
    return (await guardAdminAware(request, mode)) ?? inner(request, server);
  };
}
