import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetOperatorForTests } from "@/lib/operator";
import { __resetSetupPlanForTests } from "@/lib/setupPlan";

const previousScripted = process.env.STACK_SCRIPTED_ENGINES;
const previousNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  process.env.STACK_SCRIPTED_ENGINES = "1";
  process.env.NODE_ENV = "test";
  __resetOperatorForTests();
  __resetSetupPlanForTests();
});

afterEach(() => {
  __resetSetupPlanForTests();
  __resetOperatorForTests();
  if (previousScripted === undefined) delete process.env.STACK_SCRIPTED_ENGINES;
  else process.env.STACK_SCRIPTED_ENGINES = previousScripted;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});

test("a fresh loopback can choose a plan and scripted mode queues three honest rows", async () => {
  const response = await app.request("/stack/v1/setup/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tier: "p16", mode: "small" }) });
  expect(response.status).toBe(202);
  const body = await response.json() as { queued: boolean; downloads: Array<{ id: string; sizeBytes: number; status: string }> };
  expect(body.queued).toBe(true);
  expect(body.downloads).toHaveLength(3);
  expect(body.downloads.map((item) => item.sizeBytes)).toEqual([700_000_000, 80_000_000, 150_000_000]);
  expect(body.downloads[0]?.status).toBe("downloading");
});

test("a scripted row can be paused and resumed", async () => {
  const queued = await app.request("/stack/v1/setup/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tier: "p16", mode: "small" }) });
  const first = (await queued.json() as { downloads: Array<{ id: string }> }).downloads[0]!;
  const paused = await app.request(`/stack/v1/setup/plan/${first.id}/pause`, { method: "POST" });
  expect(paused.status).toBe(200);
  expect((await paused.json() as { status: string }).status).toBe("paused");
  const resumed = await app.request(`/stack/v1/setup/plan/${first.id}/resume`, { method: "POST" });
  expect(resumed.status).toBe(200);
  expect((await resumed.json() as { status: string }).status).toBe("downloading");
});

test("the first client key asks for a password, then admin reads need its session", async () => {
  const first = await app.request("/stack/v1/clients", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "first tool", allowedRoles: ["chat"] }) });
  expect(first.status).toBe(409);
  expect(await first.json()).toEqual({ error: "Set an operator password before creating a client key", setPasswordFirst: true });
  const setup = await app.request("/stack/v1/operator/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "deferred password" }) });
  expect(setup.status).toBe(201);
  const withoutSession = await app.request("/stack/v1/roles");
  expect(withoutSession.status).toBe(401);
  const cookie = setup.headers.get("set-cookie")!.split(";", 1)[0]!;
  const created = await app.request("/stack/v1/clients", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "first tool", allowedRoles: ["chat"] }) });
  expect(created.status).toBe(201);
});
