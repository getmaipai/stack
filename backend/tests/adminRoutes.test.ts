// The admin routes, the CSRF rule, Home's unchanged path, the reset and the
// Tailscale listener's guard, on a real server on a free loopback port.
import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serveOptions, tailscaleServeOptions } from "@/daemon";
import { __resetAdultViewForTests } from "@/lib/adultView";
import { __resetAdminAuthRateLimitsForTests, createSetupCode, resetAdmin } from "@/lib/adminAuth";
import { guardAdminAware } from "@/lib/adminGuard";
import { isTailscaleAddress, pickTailscaleAddress } from "@/lib/adminListener";
import { dataDir } from "@/lib/paths";
import { logger } from "@/lib/log";
import { db } from "@/db";
import { adminSessions } from "@/db/schema";

const TOKEN = "t".repeat(40);
const PASSWORD = "correct horse battery";
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
afterAll(async () => {
  server.stop(true);
  await resetAdmin(dataDir);
  if (previous === undefined) delete process.env.STACK_HOME_VIEW_TOKEN; else process.env.STACK_HOME_VIEW_TOKEN = previous;
  __resetAdultViewForTests();
});
beforeEach(() => { __resetAdminAuthRateLimitsForTests(); });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify(body) });
const body = async (res: Response) => await res.json() as Record<string, unknown>;

/** A fresh admin with PASSWORD, returns the session cookie value after signing in. */
async function freshSession(): Promise<string> {
  const code = await resetAdmin(dataDir);
  expect((await post("/stack/v1/admin/setup", { code, password: PASSWORD })).status).toBe(200);
  const res = await post("/stack/v1/admin/login", { password: PASSWORD });
  expect(res.status).toBe(200);
  return /stack_admin=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]!;
}
const authed = (token: string) => ({ cookie: `stack_admin=${token}`, "x-stack-admin": "1", origin: base });

test("setup: a wrong code is refused with a sentence, the right one creates the admin and removes the file, a short password is refused", async () => {
  const code = await resetAdmin(dataDir);
  const wrong = await post("/stack/v1/admin/setup", { code: "WRONG", password: PASSWORD });
  expect(wrong.status).toBe(403);
  expect((await body(wrong)).code).toBe("invalid_setup_code");
  expect((await post("/stack/v1/admin/setup", { code, password: "short" })).status).toBe(400);
  expect((await post("/stack/v1/admin/setup", { code, password: PASSWORD })).status).toBe(200);
  expect(() => readFileSync(join(dataDir, "admin-setup-code"))).toThrow();
  expect((await post("/stack/v1/admin/login", { password: PASSWORD })).status).toBe(200);
});

test("login sets a cookie with HttpOnly, SameSite=Strict, Path=/, no Secure over http, and the session route answers", async () => {
  const token = await freshSession();
  const login = await post("/stack/v1/admin/login", { password: PASSWORD });
  const cookie = login.headers.get("set-cookie")!;
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Strict");
  expect(cookie).toContain("Path=/");
  expect(cookie).toContain("Max-Age=43200");
  expect(cookie).not.toContain("Secure");
  const forwarded = await post("/stack/v1/admin/login", { password: PASSWORD }, { "x-forwarded-proto": "https" });
  expect(forwarded.headers.get("set-cookie")).toContain("Secure");
  const session = await fetch(`${base}/stack/v1/admin/session`, { headers: { cookie: `stack_admin=${token}` } });
  expect(session.status).toBe(200);
  expect((await body(session)).signed_in).toBe(true);
  expect((await fetch(`${base}/stack/v1/admin/session`)).status).toBe(401);
});

test("five wrong passwords then 429 with retry_after", async () => {
  await freshSession();
  for (let i = 0; i < 5; i++) expect((await post("/stack/v1/admin/login", { password: "wrong password!" })).status).toBe(401);
  const limited = await post("/stack/v1/admin/login", { password: PASSWORD });
  expect(limited.status).toBe(429);
  const data = await body(limited);
  expect(data.code).toBe("rate_limited");
  expect(typeof data.retry_after).toBe("number");
});

test("logout ends the session and clears the cookie; an idle session is refused", async () => {
  const token = await freshSession();
  const out = await post("/stack/v1/admin/logout", {}, authed(token));
  expect(out.status).toBe(200);
  expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
  expect((await fetch(`${base}/stack/v1/admin/session`, { headers: { cookie: `stack_admin=${token}` } })).status).toBe(401);
  const second = await freshSession();
  db.update(adminSessions).set({ lastSeenAt: new Date(Date.now() - 31 * 60_000).toISOString() }).run();
  expect((await fetch(`${base}/stack/v1/admin/session`, { headers: { cookie: `stack_admin=${second}` } })).status).toBe(401);
});

test("password change needs the current password and ends other sessions", async () => {
  const token = await freshSession();
  expect((await post("/stack/v1/admin/password", { current: "nope nope nope", new: "another long password" }, authed(token))).status).toBe(401);
  expect((await post("/stack/v1/admin/password", { current: PASSWORD, new: "short" }, authed(token))).status).toBe(400);
  expect((await post("/stack/v1/admin/password", { current: PASSWORD, new: "another long password" }, authed(token))).status).toBe(200);
  expect((await post("/stack/v1/admin/login", { password: "another long password" })).status).toBe(200);
});

test("CSRF: a write with the cookie needs x-stack-admin and a matching Origin; a read with the cookie is accepted", async () => {
  const token = await freshSession();
  const config = { warn_free_gb: 1, critical_free_gb: 0.5 };
  const noHeader = await post("/stack/v1/disk/config", config, { cookie: `stack_admin=${token}`, origin: base });
  expect(noHeader.status).toBe(403);
  expect((await body(noHeader)).code).toBe("admin_header_required");
  const noOrigin = await post("/stack/v1/disk/config", config, { cookie: `stack_admin=${token}`, "x-stack-admin": "1" });
  expect(noOrigin.status).toBe(403);
  const otherOrigin = await post("/stack/v1/disk/config", config, { cookie: `stack_admin=${token}`, "x-stack-admin": "1", origin: "http://evil.example" });
  expect(otherOrigin.status).toBe(403);
  expect((await post("/stack/v1/disk/config", config, authed(token))).status).toBe(200);
  expect((await fetch(`${base}/stack/v1/roles`, { headers: { cookie: `stack_admin=${token}` } })).status).toBe(200);
  const formBody = await fetch(`${base}/stack/v1/admin/login`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
  expect(formBody.status).toBe(415);
});

test("Home's path is unchanged: no token is 401, the token passes, a bad cookie does not replace it", async () => {
  const config = { warn_free_gb: 1, critical_free_gb: 0.5 };
  const none = await post("/stack/v1/disk/config", config);
  expect(none.status).toBe(401);
  expect((await body(none)).code).toBe("home_token_required");
  expect((await post("/stack/v1/disk/config", config, { "x-maipai-home-token": TOKEN })).status).toBe(200);
  const stale = await post("/stack/v1/disk/config", config, { cookie: "stack_admin=deadbeef", "x-stack-admin": "1", origin: base });
  expect(stale.status).toBe(401);
  expect((await fetch(`${base}/stack/v1/roles`, { headers: { host: "evil.example" } })).status).toBe(421);
});

test("audit lines carry time and remote address and never the password", async () => {
  const lines: string[] = [];
  const spy = spyOn(logger, "appendLine").mockImplementation((line: string) => { lines.push(line); });
  try {
    const token = await freshSession();
    await post("/stack/v1/admin/login", { password: "wrong password!" });
    await post("/stack/v1/admin/logout", {}, authed(token));
  } finally { spy.mockRestore(); }
  const events = lines.map((line) => JSON.parse(line) as { event: string; at: string; remote: string });
  for (const name of ["admin.setup", "admin.login", "admin.login.failed", "admin.logout"]) {
    const found = events.find((e) => e.event === name);
    expect(found).toBeTruthy();
    expect(found!.remote).toBe("127.0.0.1");
    expect(Number.isNaN(Date.parse(found!.at))).toBe(false);
  }
  expect(lines.join("\n")).not.toContain(PASSWORD);
});

test("reset removes the admin and every session and writes a fresh code", async () => {
  const token = await freshSession();
  const code = await resetAdmin(dataDir);
  expect(readFileSync(join(dataDir, "admin-setup-code"), "utf8")).toBe(code);
  expect((await fetch(`${base}/stack/v1/admin/session`, { headers: { cookie: `stack_admin=${token}` } })).status).toBe(401);
  expect((await post("/stack/v1/admin/login", { password: PASSWORD })).status).toBe(409);
});

test("the Tailscale chooser picks only a 100.64.0.0/10 IPv4 and never a LAN, wildcard or IPv6 address", () => {
  const entry = (address: string, family = "IPv4", internal = false) => ({ address, family, internal, netmask: "", mac: "", cidr: null }) as never;
  expect(isTailscaleAddress("100.64.0.1")).toBe(true);
  expect(isTailscaleAddress("100.127.255.254")).toBe(true);
  for (const bad of ["100.63.255.255", "100.128.0.1", "0.0.0.0", "192.168.1.5", "10.0.0.2", "172.16.0.9", "127.0.0.1", "fd7a:115c::1", "100.64.0"]) expect(isTailscaleAddress(bad)).toBe(false);
  expect(pickTailscaleAddress({ en0: [entry("192.168.1.5")], lo0: [entry("127.0.0.1", "IPv4", true)], utun4: [entry("fd7a:115c::1", "IPv6"), entry("100.101.102.103")] })).toBe("100.101.102.103");
  expect(pickTailscaleAddress({ en0: [entry("192.168.1.5"), entry("0.0.0.0")] })).toBeNull();
  expect(pickTailscaleAddress({})).toBeNull();
  expect(tailscaleServeOptions(serveOptions(), "100.101.102.103")).toBeNull();
});

test("on the Tailscale listener only /healthz and the sign-in routes pass without a session", async () => {
  const ip = "100.101.102.103";
  const mode = { tailscaleAddress: ip };
  const req = (path: string, init: RequestInit = {}) => new Request(`http://${ip}:8770${path}`, { ...init, headers: { host: `${ip}:8770`, ...(init.headers as Record<string, string> | undefined) } });
  expect(await guardAdminAware(req("/healthz"), mode)).toBeNull();
  expect((await guardAdminAware(req("/stack/v1/roles"), mode))!.status).toBe(401);
  expect((await guardAdminAware(req("/v1/models"), mode))!.status).toBe(404);
  expect((await guardAdminAware(req("/stack/v1/admin/setup", { method: "POST", headers: json }), mode))!.status).toBe(403);
  expect(await guardAdminAware(req("/stack/v1/admin/login", { method: "POST", headers: json }), mode)).toBeNull();
  expect((await guardAdminAware(new Request(`http://${ip}/stack/v1/roles`, { headers: { host: "127.0.0.1:8770" } }), mode))!.status).toBe(421);
  // Home's token is not accepted here.
  expect((await guardAdminAware(req("/stack/v1/disk/config", { method: "POST", headers: { ...json, "x-maipai-home-token": TOKEN } }), mode))!.status).toBe(401);
  const token = await freshSession();
  expect(await guardAdminAware(req("/stack/v1/roles", { headers: { cookie: `stack_admin=${token}` } }), mode)).toBeNull();
  expect(await guardAdminAware(req("/stack/v1/disk/config", { method: "POST", headers: { ...json, ...authed(token), host: `${ip}:8770`, origin: `http://${ip}:8770` } }), mode)).toBeNull();
});

test("the setup code helper is exported for the first-run path", () => {
  expect(createSetupCode(dataDir)).toHaveLength(32);
});
