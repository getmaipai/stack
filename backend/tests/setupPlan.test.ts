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

async function operatorHeaders() {
  const setup = await app.request("/stack/v1/operator/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "deferred password" }) });
  return { cookie: setup.headers.get("set-cookie")!.split(";", 1)[0]! };
}

test("a signed-in operator can choose a plan and scripted mode queues three honest rows", async () => {
  const response = await app.request("/stack/v1/setup/plan", { method: "POST", headers: { ...await operatorHeaders(), "content-type": "application/json" }, body: JSON.stringify({ tier: "p16", mode: "small" }) });
  expect(response.status).toBe(202);
  const body = await response.json() as { queued: boolean; downloads: Array<{ id: string; sizeBytes: number; status: string }> };
  expect(body.queued).toBe(true);
  expect(body.downloads).toHaveLength(3);
  expect(body.downloads.map((item) => item.sizeBytes)).toEqual([700_000_000, 80_000_000, 150_000_000]);
  expect(body.downloads[0]?.status).toBe("downloading");
});

test("a scripted row can be paused and resumed", async () => {
  const headers = await operatorHeaders();
  const queued = await app.request("/stack/v1/setup/plan", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ tier: "p16", mode: "small" }) });
  const first = (await queued.json() as { downloads: Array<{ id: string }> }).downloads[0]!;
  const paused = await app.request(`/stack/v1/setup/plan/${first.id}/pause`, { method: "POST", headers });
  expect(paused.status).toBe(200);
  expect((await paused.json() as { status: string }).status).toBe("paused");
  const resumed = await app.request(`/stack/v1/setup/plan/${first.id}/resume`, { method: "POST", headers });
  expect(resumed.status).toBe(200);
  expect((await resumed.json() as { status: string }).status).toBe("downloading");
});

test("client-key administration requires an operator session", async () => {
  const first = await app.request("/stack/v1/clients", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "first tool", allowedRoles: ["chat"] }) });
  expect(first.status).toBe(401);
  const headers = await operatorHeaders();
  const withoutSession = await app.request("/stack/v1/roles");
  expect(withoutSession.status).toBe(401);
  const created = await app.request("/stack/v1/clients", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: "first tool", allowedRoles: ["chat"] }) });
  expect(created.status).toBe(201);
});
