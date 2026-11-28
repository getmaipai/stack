// APP-KEYS-01: the door for a program that holds an app key. It runs in front of the app (lib/adminGuard.ts) and only when the request
// carries `Authorization: Bearer mpk_...` and no Home token, so Home's path and the admin session path are untouched.
// Order: Host and Origin (a program on this computer, never a web page), no form-style body, the key itself (unknown or revoked), the
// route (only the model routes), the scope, the role the request names, then the rate and at-once limits. Every refusal says what went
// wrong and what to do.
import { HOME_TOKEN_HEADER } from "@/lib/adultView";
import { checkLoopbackCaller, refuse } from "@/lib/loopbackGuard";
import { resolveRole } from "@/lib/router";
import { ROLES, HEAVY_ROLE, PICTURE_READER_ROLE, PRIMARY_ROLE, type RoleId } from "@/roles";
import { endWithStream } from "@/lib/heavyGate";
import {
  APP_KEY_SCOPES, SCOPE_WORDS, logAppKeyRefusal, logAppKeyUse, noteAdmitted, noteRevokedInUse, noteThrottled, stampAppKeyUse, tryAcquire, verifyAppKey, type AppKeyScope,
} from "@/lib/appKeys";

const ROUTES_SENTENCE = "An app key can call only the model routes: chat (POST /v1/chat/completions and /v1/responses), speech (POST /v1/audio/transcriptions and /v1/audio/speech) and models (GET /v1/models)";
const MAKE_NEW = "make a new key on the admin page (Connections, App keys)";

type Need = AppKeyScope | "chat_or_vision";
function routeScope(method: string, path: string): Need | null {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (method === "GET" && p === "/v1/models") return "models";
  if (method === "POST" && (p === "/v1/chat/completions" || p === "/v1/responses")) return "chat_or_vision";
  if (method === "POST" && (p === "/v1/audio/transcriptions" || p === "/v1/audio/speech")) return "speech";
  return null;
}

/** The role a request's `model` field names, or null when it names none the Stack knows (the route then gives its own, plainer error). */
function roleOfModel(model: unknown): RoleId | null {
  if (typeof model !== "string" || model === "") return PRIMARY_ROLE;
  try { return resolveRole(model).role; } catch { return null; }
}

/** What a chat-wire request needs: chat for the text roles, vision for the picture reader and for any picture in the messages. */
async function chatNeeds(request: Request): Promise<{ scopes: AppKeyScope[]; badRole?: string } > {
  let text = "";
  try { text = await request.clone().text(); } catch { return { scopes: ["chat"] }; }
  let body: { model?: unknown } = {};
  try { body = JSON.parse(text) as { model?: unknown }; } catch { return { scopes: ["chat"] }; }
  const scopes = new Set<AppKeyScope>();
  const role = roleOfModel(body.model);
  if (role === null || role === PRIMARY_ROLE || role === HEAVY_ROLE) scopes.add("chat");
  else if (role === PICTURE_READER_ROLE) scopes.add("vision");
  else return { scopes: [], badRole: role };
  if (/"type"\s*:\s*"(image_url|input_image|image)"/.test(text)) scopes.add("vision");
  return { scopes: [...scopes] };
}

function bearerKey(request: Request): string | null {
  const match = /^Bearer\s+(mpk_\S*)$/i.exec((request.headers.get("authorization") ?? "").trim());
  return match ? match[1]! : null;
}

export type Admit = { response: Response } | { release: () => void };

/** Null when this is not an app-key request (Home's token, an admin session, or no key at all): the existing guards decide. */
export async function appKeyAdmit(request: Request): Promise<Admit | null> {
  if (request.headers.get(HOME_TOKEN_HEADER) !== null) return null;
  const presented = bearerKey(request);
  if (presented === null) return null;
  const method = request.method.toUpperCase();
  const path = new URL(request.url).pathname;
  const no = (response: Response, keyId: string | null, code: string): Admit => { logAppKeyRefusal(keyId, code, method, path); return { response }; };

  const loopback = checkLoopbackCaller(request);
  if (loopback) return { response: loopback };
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (method !== "GET" && method !== "HEAD" && (contentType === "text/plain" || contentType === "application/x-www-form-urlencoded")) {
    return { response: refuse(415, "content_type_not_allowed", "The Stack takes JSON (or an uploaded file), not a form or plain-text body. Send the request as application/json.") };
  }

  let verified: ReturnType<typeof verifyAppKey>;
  try { verified = verifyAppKey(presented); } catch {
    return { response: refuse(503, "app_key_unavailable", "The Stack could not check the app key (its key folder or database could not be read), so it did not run the request. Free some disk space or fix the permissions of the Stack's data folder, then restart the Stack.") };
  }
  if (!verified.ok && verified.code === "app_key_unknown") {
    return no(refuse(401, "app_key_unknown", `The Stack does not know this app key, so it did not run the request. Check that the whole key was copied, or ${MAKE_NEW}.`, { "www-authenticate": "Bearer" }), null, "app_key_unknown");
  }
  if (!verified.ok) {
    noteRevokedInUse(verified.row);
    return no(refuse(401, "app_key_revoked", `The app key '${verified.row.name}' was revoked, so the Stack did not run the request. On the admin page (Connections, App keys), make a new key and put it in the program.`, { "www-authenticate": "Bearer" }), verified.row.id, "app_key_revoked");
  }
  const { row, scopes } = verified;

  const need = routeScope(method, path);
  if (need === null) {
    return no(refuse(403, "app_key_route_not_allowed", `${ROUTES_SENTENCE}. It cannot reach ${method} ${path}. Use one of those routes, or use Home for everything else.`), row.id, "app_key_route_not_allowed");
  }
  let required: AppKeyScope[];
  if (need === "chat_or_vision") {
    const needs = await chatNeeds(request);
    if (needs.badRole) {
      return no(refuse(403, "app_key_role_not_allowed", `The app key '${row.name}' cannot ask the ${ROLES[needs.badRole as RoleId]?.label ?? needs.badRole} role. App keys reach the chat and vision roles on this route; name one of those in the model field.`), row.id, "app_key_role_not_allowed");
    }
    required = needs.scopes;
  } else required = [need];
  const missing = required.find((s) => !scopes.includes(s));
  if (missing) {
    return no(refuse(403, "app_key_scope_missing", `The app key '${row.name}' does not have the ${SCOPE_WORDS[missing]} scope, so the Stack did not run the request. On the admin page (Connections, App keys), make a new key with that scope turned on and use it instead. Scopes of this key: ${scopes.join(", ") || "none"}.`), row.id, "app_key_scope_missing");
  }

  const slot = tryAcquire(row.id);
  if (!slot.ok) {
    noteThrottled(row);
    const why = slot.code === "app_key_rate_limited" ? `The app key '${row.name}' sent too many requests this minute, so the Stack did not run this one.`
      : slot.code === "app_key_busy" ? `The app key '${row.name}' already has its share of requests running, so the Stack did not run this one.`
      : "App keys together are using all the room the Stack keeps for other programs, so it did not run this one. Home's own requests are not affected.";
    return no(refuse(429, slot.code, `${why} Wait ${slot.retryAfterSeconds} seconds and send it again, and keep to a few requests at a time.`, { "retry-after": String(slot.retryAfterSeconds) }), row.id, slot.code);
  }
  noteAdmitted(row);
  try { stampAppKeyUse(row.id); logAppKeyUse(row, method, path); } catch { /* the record is a help, never a reason to fail a request */ }
  return { release: slot.release };
}

/** The scopes an app key may have, for the routes and the admin page. */
export { APP_KEY_SCOPES };

/** Runs `inner` for an admitted app-key request and gives the slot back when the answer, streamed or not, has ended. */
export async function runAdmitted(admit: { release: () => void }, inner: () => Response | Promise<Response>): Promise<Response> {
  let response: Response;
  try { response = await inner(); } catch (error) { admit.release(); throw error; }
  if (!response.body) { admit.release(); return response; }
  return new Response(endWithStream(response.body, admit.release), { status: response.status, statusText: response.statusText, headers: response.headers });
}
