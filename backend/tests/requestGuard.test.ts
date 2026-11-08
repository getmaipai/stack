// ISOLATION-04: forged Host, cross-origin page, missing or wrong token, form-style body, and the happy path, on a real server.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { serveOptions } from "@/daemon";
import { __resetAdultViewForTests } from "@/lib/adultView";

const TOKEN = "t".repeat(40);
let server: ReturnType<typeof Bun.serve>;
let base = "";
let hostValue = "";
const previous = process.env.STACK_HOME_VIEW_TOKEN;

beforeAll(() => {
  process.env.STACK_HOME_VIEW_TOKEN = TOKEN;
  __resetAdultViewForTests();
  server = Bun.serve({ ...serveOptions(), port: 0 });
  base = `http://127.0.0.1:${server.port}`;
  hostValue = `127.0.0.1:${server.port}`;
});
afterAll(() => {
  server.stop(true);
  if (previous === undefined) delete process.env.STACK_HOME_VIEW_TOKEN; else process.env.STACK_HOME_VIEW_TOKEN = previous;
  __resetAdultViewForTests();
});

const call = (path: string, init: RequestInit = {}) => fetch(base + path, init);
const json = { "content-type": "application/json" };

test("a forged Host is refused on a read, a write and the liveness route", async () => {
  for (const path of ["/healthz", "/stack/v1/roles"]) {
    const res = await call(path, { headers: { host: "evil.example" } });
    expect(res.status).toBe(421);
    expect((await res.json() as { code: string }).code).toBe("host_not_allowed");
  }
  const post = await call("/stack/v1/jobs/none/cancel", { method: "POST", headers: { host: "evil.example:8770", "x-maipai-home-token": TOKEN, ...json } });
  expect(post.status).toBe(421);
});

test("loopback names are accepted on any port (the SSH link to an engine computer uses another one)", async () => {
  for (const host of [hostValue, "localhost:8771", "127.0.0.1", "[::1]:9"]) {
    expect((await call("/healthz", { headers: { host } })).status).toBe(200);
  }
});

test("a page on another origin is refused, a same-origin or absent Origin is not", async () => {
  const page = await call("/healthz", { headers: { origin: "https://evil.example" } });
  expect(page.status).toBe(403);
  expect((await page.json() as { code: string }).code).toBe("origin_not_allowed");
  const localhostPage = await call("/healthz", { headers: { origin: "http://localhost:3000" } });
  expect(localhostPage.status).toBe(403);
  expect((await call("/healthz", { headers: { origin: `http://${hostValue}` } })).status).toBe(200);
  expect((await call("/healthz")).status).toBe(200);
  const nullOrigin = await call("/healthz", { headers: { origin: "null" } });
  expect(nullOrigin.status).toBe(403);
});

test("a cross-origin POST with the right token is still refused", async () => {
  const res = await call("/stack/v1/jobs/none/cancel", { method: "POST", headers: { origin: "https://evil.example", "x-maipai-home-token": TOKEN, ...json } });
  expect(res.status).toBe(403);
});

test("POST and DELETE without the token are 401 on generation, job and control routes", async () => {
  const cases: Array<[string, string]> = [["POST", "/v1/images/generations"], ["POST", "/v1/videos/generations"], ["POST", "/v1/audio/music/generations"], ["POST", "/stack/v1/jobs/none/cancel"], ["DELETE", "/stack/v1/jobs/none"], ["POST", "/stack/v1/warmup"], ["PUT", "/stack/v1/settings/stack.runtime.port"], ["PATCH", "/stack/v1/settings"]];
  for (const [method, path] of cases) {
    const res = await call(path, { method, headers: json, body: method === "DELETE" ? undefined : "{}" });
    expect(res.status).toBe(401);
    expect((await res.json() as { code: string }).code).toBe("home_token_required");
  }
});

test("a wrong token is refused with a sentence that says what to do", async () => {
  const res = await call("/v1/images/generations", { method: "POST", headers: { ...json, "x-maipai-home-token": "w".repeat(40) }, body: "{}" });
  expect(res.status).toBe(401);
  const body = await res.json() as { code: string; error: string };
  expect(body.code).toBe("home_token_refused");
  expect(body.error).toContain("Restart Home");
  const short = await call("/v1/images/generations", { method: "POST", headers: { ...json, "x-maipai-home-token": "x" }, body: "{}" });
  expect(short.status).toBe(401);
});

test("a text/plain or form POST (a simple cross-site request) is refused even with the token", async () => {
  for (const type of ["text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded"]) {
    const res = await call("/v1/images/generations", { method: "POST", headers: { "content-type": type, "x-maipai-home-token": TOKEN }, body: "{}" });
    expect(res.status).toBe(415);
  }
});

test("the right token reaches the route (any answer but a guard refusal)", async () => {
  const res = await call("/stack/v1/jobs/does-not-exist/cancel", { method: "POST", headers: { ...json, "x-maipai-home-token": TOKEN }, body: "{}" });
  expect([401, 415, 421, 403]).not.toContain(res.status);
  const get = await call("/stack/v1/jobs");
  expect(get.status).toBe(200);
});

test("a CORS preflight is a bare rejection, never permission", async () => {
  const res = await call("/v1/images/generations", { method: "OPTIONS", headers: { origin: `http://${hostValue}`, "access-control-request-method": "POST" } });
  expect(res.status).toBe(404);
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
  const forged = await call("/v1/images/generations", { method: "OPTIONS", headers: { host: "evil.example", origin: "https://evil.example" } });
  expect(forged.status).toBe(421);
});
