import { timingSafeEqual } from "node:crypto";

// ISOLATION-04 / 04b: the two checks every loopback listener of the Stack makes first, kept in one light module (only node:crypto) so the Stack
// and the engine workers it starts (the speech worker) share one definition.
//   1. Host: the name must be 127.0.0.1, localhost or [::1] (any port). A rebound name (DNS rebinding) is neither: 421.
//   2. Origin: absent (a program) or the same as Host. A page on another origin: 403.
const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The hostname of a Host header value (port removed), lower case; null when it is empty or malformed. */
function hostnameOf(host: string | null): string | null {
  const value = (host ?? "").trim().toLowerCase();
  if (!value) return null;
  const match = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(value);
  return match ? match[1]! : null;
}

export function refuse(status: number, code: string, error: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error, code }), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
}

/** A refusal when the Host or Origin is not a program on this computer, else null. */
export function checkLoopbackCaller(request: Request): Response | null {
  const host = request.headers.get("host");
  if (!hostnameOf(host) || !ALLOWED_HOSTNAMES.has(hostnameOf(host)!)) {
    return refuse(421, "host_not_allowed", "The Stack answers only to 127.0.0.1 or localhost. Reach it by that address from this computer, or through Home.");
  }
  const origin = request.headers.get("origin");
  if (origin !== null) {
    // Both sides go through URL with the Origin's scheme, so a default port (80, 443) is dropped from each the same way.
    let sameOrigin = false;
    try { const parsed = new URL(origin); sameOrigin = parsed.host !== "" && parsed.host === new URL(`${parsed.protocol}//${(host ?? "").trim()}`).host; } catch { /* "null" and junk are not an origin we know */ }
    if (!sameOrigin) {
      return refuse(403, "origin_not_allowed", "The Stack does not take requests from a web page. Use Home, which makes them for you.");
    }
  }
  return null;
}

/** The env var an engine worker the Stack starts reads its launch key from (the Stack makes a new key at every launch). */
export const ENGINE_KEY_ENV = "STACK_ENGINE_KEY";

/** A worker of the Stack (an engine on its own loopback port): the Host and Origin checks, then `Authorization: Bearer <launch key>` on every
 * route but GET /health (the supervisor's liveness probe). No key given means the worker was started outside the Stack: only the first two apply. */
export function checkEngineCaller(request: Request, key: string | undefined): Response | null {
  const loopback = checkLoopbackCaller(request);
  if (loopback) return loopback;
  if (!key) return null;
  if (request.method === "GET" && new URL(request.url).pathname === "/health") return null;
  const presented = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  const a = Buffer.from(presented), b = Buffer.from(key);
  if (a.length === b.length && timingSafeEqual(a, b)) return null;
  return refuse(401, "engine_key_required", "This engine takes requests only from the Stack, with the key the Stack made when it started the engine. Use the Stack's own routes instead.", { "www-authenticate": "Bearer" });
}
