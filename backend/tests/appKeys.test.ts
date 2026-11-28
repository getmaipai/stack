// APP-KEYS-01: a key a person makes on the admin page lets another program call the OpenAI-shaped routes with a standard bearer key.
// Every failure path first (missing, unknown, revoked, wrong scope, a route a key may not call, too many at once), then the happy path
// on a real server, Home's token path unchanged, and the key never stored or logged in the clear.
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { serveOptions } from "@/daemon";
import { __resetAdultViewForTests } from "@/lib/adultView";
import { db } from "@/db";
import { appKeys } from "@/db/schema";
import { __resetAppKeysForTests, createAppKey, healthCode, listAppKeys, revokeAppKey, tryAcquire } from "@/lib/appKeys";
import { __resetHealthForTests, list as healthList } from "@/lib/health";
import { logger } from "@/lib/log";

const TOKEN = "t".repeat(40);
let server: ReturnType<typeof Bun.serve>;
let base = "";
let host = "";
const previous = process.env.STACK_HOME_VIEW_TOKEN;
const json = { "content-type": "application/json" };

beforeAll(() => {
  process.env.STACK_HOME_VIEW_TOKEN = TOKEN;
  __resetAdultViewForTests();
  server = Bun.serve({ ...serveOptions(), port: 0 });
  base = `http://127.0.0.1:${server.port}`;
  host = `127.0.0.1:${server.port}`;
});
afterAll(() => {
  server.stop(true);
  if (previous === undefined) delete process.env.STACK_HOME_VIEW_TOKEN; else process.env.STACK_HOME_VIEW_TOKEN = previous;
  __resetAdultViewForTests();
});
beforeEach(() => { __resetAppKeysForTests(); __resetHealthForTests(); });
afterEach(() => { delete process.env.STACK_APP_KEY_RATE_PER_MINUTE; delete process.env.STACK_APP_KEY_MAX_CONCURRENT; delete process.env.STACK_APP_KEY_MAX_CONCURRENT_ALL; });

const chat = (key: string | null, body: unknown = { model: "chat", messages: [{ role: "user", content: "hi" }] }, headers: Record<string, string> = {}) =>
  fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { ...json, ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers }, body: JSON.stringify(body) });
const get = (path: string, key: string | null, headers: Record<string, string> = {}) => fetch(base + path, { headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers } });
const code = async (response: Response) => (await response.json() as { code: string; error: string });
/** The guard let the request through when the route answered, whatever the engine said (no engine runs in a test). */
const passed = (response: Response) => ![401, 403, 421, 429].includes(response.status);

test("a write with no key and no Home token says an app key is the way in", async () => {
  const response = await chat(null);
  expect(response.status).toBe(401);
  const body = await code(response);
  expect(body.code).toBe("home_token_required");
  expect(body.error).toContain("app key");
  expect(body.error).toContain("admin page");
});

test("a key the Stack does not know is refused with what to do", async () => {
  const response = await chat("mpk_" + "A".repeat(43));
  expect(response.status).toBe(401);
  const body = await code(response);
  expect(body.code).toBe("app_key_unknown");
  expect(body.error).toContain("admin page");
  expect(response.headers.get("www-authenticate")).toContain("Bearer");
});

test("a revoked key is refused, names the key, and raises a health item", async () => {
  const made = createAppKey({ name: "Old laptop", scopes: ["chat"], by: "admin" });
  revokeAppKey(made.record.id);
  const response = await chat(made.key);
  expect(response.status).toBe(401);
  const body = await code(response);
  expect(body.code).toBe("app_key_revoked");
  expect(body.error).toContain("Old laptop");
  expect(healthList().some((h) => h.code === healthCode("revoked-in-use", made.record.id))).toBe(true);
});

test("a key without the chat scope cannot chat, and the refusal names the scope and where to change it", async () => {
  const made = createAppKey({ name: "Models only", scopes: ["models"], by: "admin" });
  const response = await chat(made.key);
  expect(response.status).toBe(403);
  const body = await code(response);
  expect(body.code).toBe("app_key_scope_missing");
  expect(body.error).toContain("chat");
  expect(body.error).toContain("Models only");
});

test("a picture in the request needs the vision scope as well", async () => {
  const image = { model: "chat", messages: [{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }] };
  const chatOnly = createAppKey({ name: "Chat only", scopes: ["chat"], by: "admin" });
  const refused = await chat(chatOnly.key, image);
  expect(refused.status).toBe(403);
  const refusedBody = await code(refused);
  expect(refusedBody.code).toBe("app_key_scope_missing");
  expect(refusedBody.error).toContain("vision");
  const both = createAppKey({ name: "Chat and vision", scopes: ["chat", "vision"], by: "admin" });
  expect(passed(await chat(both.key, image))).toBe(true);
});

test("a key cannot call a role outside its scopes through the model field", async () => {
  const made = createAppKey({ name: "Chat only", scopes: ["chat"], by: "admin" });
  const response = await chat(made.key, { model: "image", messages: [{ role: "user", content: "hi" }] });
  expect(response.status).toBe(403);
  expect((await code(response)).code).toBe("app_key_role_not_allowed");
  const router = await chat(made.key, { model: "router", messages: [{ role: "user", content: "hi" }] });
  expect(router.status).toBe(403);
});

test("a key cannot reach the control routes, the other roles' routes, jobs or key management", async () => {
  const made = createAppKey({ name: "Everything it may have", scopes: ["chat", "vision", "speech", "models"], by: "admin" });
  const auth = { authorization: `Bearer ${made.key}` };
  for (const [method, path] of [["GET", "/stack/v1/roles"], ["POST", "/stack/v1/jobs/none/cancel"], ["GET", "/stack/v1/app-keys"], ["POST", "/stack/v1/app-keys"], ["POST", "/v1/embeddings"], ["POST", "/v1/images/generations"], ["POST", "/v1/messages"], ["GET", "/admin/"]] as const) {
    const response = await fetch(base + path, { method, headers: { ...auth, ...json }, ...(method === "POST" ? { body: "{}" } : {}) });
    expect(response.status).toBe(403);
    const body = await code(response);
    expect(body.code).toBe("app_key_route_not_allowed");
    expect(body.error).toContain("chat");
  }
});

test("a key is not accepted from a forged Host, from a web page, or with a form body", async () => {
  const made = createAppKey({ name: "Laptop", scopes: ["chat"], by: "admin" });
  expect((await chat(made.key, undefined, { host: "evil.example" })).status).toBe(421);
  expect((await chat(made.key, undefined, { origin: "http://evil.example" })).status).toBe(403);
  const form = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${made.key}`, "content-type": "text/plain" }, body: "x" });
  expect(form.status).toBe(415);
});

test("a key that is cut short or has the wrong shape is unknown, never a crash", async () => {
  for (const bad of ["mpk_", "mpk_short", "mpk_" + "!".repeat(43), "mpk_" + "A".repeat(400)]) {
    const response = await chat(bad);
    expect(response.status).toBe(401);
    expect((await code(response)).code).toBe("app_key_unknown");
  }
});

test("a good key reaches the routes it is scoped for, and the use is counted", async () => {
  const made = createAppKey({ name: "Laptop", scopes: ["chat", "models"], by: "admin" });
  const models = await get("/v1/models", made.key);
  expect(models.status).toBe(200);
  expect(passed(await chat(made.key))).toBe(true);
  const row = listAppKeys().find((k) => k.id === made.record.id)!;
  expect(row.use_count).toBe(2);
  expect(row.last_used_at).not.toBeNull();
  expect(row.state).toBe("active");
});

test("the models list needs the models scope when a key is presented, and stays open without one", async () => {
  expect((await get("/v1/models", null)).status).toBe(200);
  const chatOnly = createAppKey({ name: "Chat only", scopes: ["chat"], by: "admin" });
  const response = await get("/v1/models", chatOnly.key);
  expect(response.status).toBe(403);
  expect((await code(response)).code).toBe("app_key_scope_missing");
  expect((await get("/v1/models", "mpk_" + "B".repeat(43))).status).toBe(401);
});

test("speech and transcription need the speech scope", async () => {
  const chatOnly = createAppKey({ name: "Chat only", scopes: ["chat"], by: "admin" });
  const speechKey = createAppKey({ name: "Speech", scopes: ["speech"], by: "admin" });
  for (const path of ["/v1/audio/transcriptions", "/v1/audio/speech"]) {
    const refused = await fetch(base + path, { method: "POST", headers: { authorization: `Bearer ${chatOnly.key}` }, body: new FormData() });
    expect(refused.status).toBe(403);
    expect((await code(refused)).error).toContain("speech");
    const form = new FormData(); form.set("model", "stt"); form.set("input", "hi");
    expect(passed(await fetch(base + path, { method: "POST", headers: { authorization: `Bearer ${speechKey.key}` }, body: form }))).toBe(true);
  }
});

test("Home's token path is unchanged, and a bearer key beside it changes nothing", async () => {
  const withHome = await chat(null, undefined, { "x-maipai-home-token": TOKEN });
  expect(passed(withHome)).toBe(true);
  const wrong = await chat(null, undefined, { "x-maipai-home-token": "w".repeat(40) });
  expect(wrong.status).toBe(401);
  expect((await code(wrong)).code).toBe("home_token_refused");
  const made = createAppKey({ name: "Laptop", scopes: ["models"], by: "admin" });
  const both = await chat(made.key, undefined, { "x-maipai-home-token": TOKEN });
  expect(passed(both)).toBe(true);
  expect(listAppKeys().find((k) => k.id === made.record.id)!.use_count).toBe(0);
});

test("a key never gets Home's privileges: no live priority and no full view", async () => {
  const { admissionCaller } = await import("@/lib/admissionCaller");
  const made = createAppKey({ name: "Laptop", scopes: ["chat"], by: "admin" });
  const context = { req: { header: (name: string) => ({ "x-stack-caller": "live", authorization: `Bearer ${made.key}` } as Record<string, string>)[name] } };
  expect(admissionCaller(context as never)).toBe("dev");
});

test("the key is shown once, stored only as a hash, and never in a list, the log or the audit line", async () => {
  const lines: string[] = [];
  const spy = spyOn(logger, "appendLine").mockImplementation((line: string) => { lines.push(line); });
  try {
    const created = await fetch(`${base}/stack/v1/app-keys`, { method: "POST", headers: { ...json, "x-maipai-home-token": TOKEN }, body: JSON.stringify({ name: "Phone", scopes: ["chat", "models"] }) });
    expect(created.status).toBe(201);
    const body = await created.json() as { key: string; app_key: { id: string; prefix: string; scopes: string[] } };
    expect(body.key).toMatch(/^mpk_[A-Za-z0-9_-]{43}$/);
    expect(body.app_key.prefix).toBe(body.key.slice(0, 8));
    const row = db.select().from(appKeys).where(eq(appKeys.id, body.app_key.id)).get()!;
    expect(JSON.stringify(row)).not.toContain(body.key);
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    const listed = await (await fetch(`${base}/stack/v1/app-keys`, { headers: { "x-maipai-home-token": TOKEN } })).text();
    expect(listed).not.toContain(body.key);
    await chat(body.key);
    await chat(body.key.slice(0, -1) + "x");
    expect(lines.some((l) => l.includes("\"app_key.created\"") || l.includes("admin.action.app_key.created"))).toBe(true);
    expect(lines.some((l) => l.includes("app_key.use") && l.includes(body.app_key.id))).toBe(true);
    expect(lines.join("\n")).not.toContain(body.key);
    expect(lines.join("\n")).not.toContain(body.key.slice(0, -1) + "x");
  } finally { spy.mockRestore(); }
});

test("the admin routes: a name is needed, scopes must be known, names are not reused, revoke works, and a key cannot make keys", async () => {
  const post = (body: unknown) => fetch(`${base}/stack/v1/app-keys`, { method: "POST", headers: { ...json, "x-maipai-home-token": TOKEN }, body: JSON.stringify(body) });
  const noName = await post({ name: "  ", scopes: ["chat"] });
  expect(noName.status).toBe(400);
  expect((await code(noName)).error).toContain("name");
  const noScopes = await post({ name: "X", scopes: [] });
  expect(noScopes.status).toBe(400);
  expect((await code(noScopes)).error).toContain("scope");
  const badScope = await post({ name: "X", scopes: ["root"] });
  expect(badScope.status).toBe(400);
  const first = await post({ name: "Laptop", scopes: ["chat"] });
  expect(first.status).toBe(201);
  const again = await post({ name: "laptop", scopes: ["chat"] });
  expect(again.status).toBe(409);
  const { app_key: made, key } = await first.json() as { app_key: { id: string }; key: string };
  const revoke = await fetch(`${base}/stack/v1/app-keys/${made.id}/revoke`, { method: "POST", headers: { "x-maipai-home-token": TOKEN } });
  expect(revoke.status).toBe(200);
  expect((await chat(key)).status).toBe(401);
  const missing = await fetch(`${base}/stack/v1/app-keys/key_nope/revoke`, { method: "POST", headers: { "x-maipai-home-token": TOKEN } });
  expect(missing.status).toBe(404);
  expect((await code(missing)).error).toContain("refresh");
  const fromKey = createAppKey({ name: "Sneaky", scopes: ["chat", "vision", "speech", "models"], by: "admin" });
  const attempt = await fetch(`${base}/stack/v1/app-keys`, { method: "POST", headers: { ...json, authorization: `Bearer ${fromKey.key}` }, body: JSON.stringify({ name: "Child", scopes: ["chat"] }) });
  expect(attempt.status).toBe(403);
});

test("the same name can be used again once the old key is revoked", () => {
  const first = createAppKey({ name: "Laptop", scopes: ["chat"], by: "admin" });
  expect(() => createAppKey({ name: "Laptop", scopes: ["chat"], by: "admin" })).toThrow(/already/);
  revokeAppKey(first.record.id);
  expect(createAppKey({ name: "Laptop", scopes: ["chat"], by: "admin" }).record.id).not.toBe(first.record.id);
});

test("too many requests a minute: 429 with Retry-After and what to do, and a health item", async () => {
  process.env.STACK_APP_KEY_RATE_PER_MINUTE = "3";
  const made = createAppKey({ name: "Busy script", scopes: ["models"], by: "admin" });
  for (let i = 0; i < 3; i++) expect((await get("/v1/models", made.key)).status).toBe(200);
  const limited = await get("/v1/models", made.key);
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  const body = await code(limited);
  expect(body.code).toBe("app_key_rate_limited");
  expect(body.error).toContain("Busy script");
  expect(healthList().some((h) => h.code === healthCode("throttled", made.record.id))).toBe(true);
});

test("one key may hold only a few requests at once, and all keys together fewer than the machine can take", () => {
  process.env.STACK_APP_KEY_MAX_CONCURRENT = "2";
  process.env.STACK_APP_KEY_MAX_CONCURRENT_ALL = "3";
  const a = tryAcquire("key_a");
  const b = tryAcquire("key_a");
  expect(a.ok && b.ok).toBe(true);
  const third = tryAcquire("key_a");
  expect(third.ok).toBe(false);
  expect(!third.ok && third.code).toBe("app_key_busy");
  const other = tryAcquire("key_b");
  expect(other.ok).toBe(true);
  const crowded = tryAcquire("key_c");
  expect(crowded.ok).toBe(false);
  expect(!crowded.ok && crowded.code).toBe("app_keys_busy");
  if (a.ok) a.release();
  if (a.ok) a.release(); // a second release changes nothing
  expect(tryAcquire("key_a").ok).toBe(true);
});

test("a streamed answer holds its slot until the stream ends", async () => {
  process.env.STACK_APP_KEY_MAX_CONCURRENT = "1";
  const { appKeyAdmit } = await import("@/lib/appKeyGuard");
  const made = createAppKey({ name: "Streamer", scopes: ["chat"], by: "admin" });
  const request = () => new Request("http://127.0.0.1:1/v1/chat/completions", { method: "POST", headers: { host: "127.0.0.1:1", authorization: `Bearer ${made.key}`, ...json }, body: JSON.stringify({ model: "chat", messages: [] }) });
  const first = await appKeyAdmit(request());
  expect(first && "release" in first).toBe(true);
  const second = await appKeyAdmit(request());
  expect(second && "response" in second && second.response.status).toBe(429);
  if (first && "release" in first) first.release();
  const third = await appKeyAdmit(request());
  expect(third && "release" in third).toBe(true);
  if (third && "release" in third) third.release();
});
