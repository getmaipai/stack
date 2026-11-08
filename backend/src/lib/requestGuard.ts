// ISOLATION-04: who may talk to the Stack at all. The Stack listens on loopback only, but loopback is not private from a web page: a page
// in a browser on this computer can send requests to 127.0.0.1 (CSRF), and a page whose name is re-pointed at 127.0.0.1 (DNS rebinding)
// reads the answers too. Three checks, in this order, on every request that reaches the server:
//   1. Host: the name must be 127.0.0.1, localhost or [::1] (any port: the SSH link to an engine computer lands on a different local
//      port). A rebound name is neither, so it is refused (421) on every route, GET included.
//   2. Origin: absent (a program, not a page) or the same as Host. A page on another origin is refused (403), GET included.
//   3. A POST, PUT, PATCH or DELETE must carry Home's token (the one `x-maipai-home-token` the full view already uses, the file
//      `keys/home-view-token`), must not be a form-style body (text/plain or urlencoded: what a page can send without a preflight),
//      and a missing or wrong token is refused (401). Reads stay open on loopback after the Host and Origin checks.
// A CORS preflight (OPTIONS) is not answered with permission: it falls through to the bare 404 it always got.
// This runs in front of the app (daemon.ts `serveOptions`), so a refusal never reaches a route, and it is the same code for every route
// that exists now or is added later.
import { timingSafeEqual } from "node:crypto";
import { HOME_TOKEN_HEADER, homeViewToken } from "@/lib/adultView";
import { checkLoopbackCaller, refuse } from "@/lib/loopbackGuard";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function tokenMatches(presented: string | null): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented.trim());
  const b = Buffer.from(homeViewToken());
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A refusal for a request this Stack must not answer, or null when it may go on to the routes. */
export function guardRequest(request: Request): Response | null {
  const loopback = checkLoopbackCaller(request);
  if (loopback) return loopback;
  if (READ_METHODS.has(request.method.toUpperCase())) return null;

  const contentType = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (contentType === "text/plain" || contentType === "application/x-www-form-urlencoded") {
    return refuse(415, "content_type_not_allowed", "The Stack takes JSON (or an uploaded file), not a form or plain-text body. Send the request as application/json.");
  }
  const presented = request.headers.get(HOME_TOKEN_HEADER);
  if (presented === null || presented.trim() === "") {
    return refuse(401, "home_token_required", "This request did not carry Home's token, so the Stack did not run it. Make the request through Home. If Home itself got this, restart Home so it reads the Stack's token again.");
  }
  let matches: boolean;
  try { matches = tokenMatches(presented); } catch {
    return refuse(503, "home_token_unavailable", "The Stack could not read or make its token file (keys/home-view-token in its data folder), so it did not run the request. Free some disk space or fix the folder's permissions, then restart the Stack.");
  }
  if (!matches) {
    return refuse(401, "home_token_refused", "The Stack does not accept the token Home sent, so it did not run the request. Restart Home so it reads the Stack's current token (the file keys/home-view-token in the Stack's data folder).");
  }
  return null;
}

/** `app.fetch` behind the guard. */
export function guardedFetch(inner: (request: Request, server: unknown) => Response | Promise<Response>): (request: Request, server: unknown) => Response | Promise<Response> {
  return (request, server) => guardRequest(request) ?? inner(request, server);
}
