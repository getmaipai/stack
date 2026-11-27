import { afterAll, beforeAll, expect, test } from "bun:test";
import { app } from "@/app";
import { resetAdmin } from "@/lib/adminAuth";
import { dataDir } from "@/lib/paths";

const PASSWORD = "correct horse battery";
beforeAll(async () => { await resetAdmin(dataDir); });
afterAll(async () => { await resetAdmin(dataDir); });

test("metrics require credentials and return Prometheus text to the admin", async () => {
  const denied = await app.fetch(new Request("http://127.0.0.1/stack/v1/metrics"));
  expect(denied.status).toBe(401);

  const code = await resetAdmin(dataDir);
  const setup = await app.fetch(new Request("http://127.0.0.1/stack/v1/admin/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, password: PASSWORD }) }));
  expect(setup.status).toBe(200);
  const login = await app.fetch(new Request("http://127.0.0.1/stack/v1/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) }));
  const cookie = /stack_admin=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")![1]!;
  const response = await app.fetch(new Request("http://127.0.0.1/stack/v1/metrics", { headers: { cookie: `stack_admin=${cookie}` } }));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
  const text = await response.text();
  expect(text).toContain("# HELP maipai_stack_memory_total_bytes");
  expect(text).not.toMatch(/[\\/]/);
  expect(text.toLowerCase()).not.toContain("prompt");
});
