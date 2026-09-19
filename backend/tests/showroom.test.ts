import { afterEach, expect, test } from "bun:test";
import { app } from "@/app";
import { assertShowroomAllowed, showroom } from "@/showroom/fixture";
import { __resetOperatorForTests } from "@/lib/operator";

const originalShowroom = process.env.STACK_SHOWROOM;
const originalNodeEnv = process.env.NODE_ENV;
afterEach(() => { if (originalShowroom === undefined) delete process.env.STACK_SHOWROOM; else process.env.STACK_SHOWROOM = originalShowroom; if (originalNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalNodeEnv; __resetOperatorForTests(); });

test("showroom is refused in production", () => {
  process.env.STACK_SHOWROOM = "1"; process.env.NODE_ENV = "production";
  expect(showroom()).toBe(false);
  expect(() => assertShowroomAllowed()).toThrow("disabled in production");
});

test("showroom feeds believable household-sized counts through the normal routes", async () => {
  process.env.STACK_SHOWROOM = "1"; process.env.NODE_ENV = "development";
  const setup = await app.request("/stack/v1/operator/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct horse battery staple" }) });
  const headers = { cookie: setup.headers.get("set-cookie")!.split(";", 1)[0]! };
  const paths = ["/stack/v1/models", "/stack/v1/engines", "/stack/v1/health", "/stack/v1/clients", "/stack/v1/updates", "/stack/v1/storage", "/stack/v1/hardware", "/stack/v1/roles", "/stack/v1/groups", "/stack/v1/detected"];
  const responses = await Promise.all(paths.map((path) => app.request(path, { headers })));
  expect(responses.every((response) => response.status === 200)).toBe(true);
  expect((await (await app.request("/stack/v1/models", { headers })).json() as { models: unknown[] }).models).toHaveLength(8);
  expect((await (await app.request("/stack/v1/engines", { headers })).json() as { engines: unknown[] }).engines).toHaveLength(3);
  expect((await (await app.request("/stack/v1/clients", { headers })).json() as { clients: unknown[] }).clients).toHaveLength(3);
  expect((await (await app.request("/stack/v1/notifications", { headers })).json() as { notifications: unknown[] }).notifications).toHaveLength(8);
  expect((await (await app.request("/stack/v1/groups", { headers })).json() as { groups: unknown[] }).groups).toHaveLength(3);
  expect((await (await app.request("/stack/v1/detected", { headers })).json() as { detected: unknown[] }).detected).toHaveLength(2);
});
