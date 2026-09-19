import { beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetEventsForTests } from "@/lib/events";
import { __resetOperatorForTests, __resetOperatorThrottleForTests } from "@/lib/operator";
import { REPAIR_ACTIONS, __resetRepairsForTests } from "@/lib/repairs";
import { reportChatEngineExited } from "@/lib/supervisor";

async function operatorSessionCookie(): Promise<string> {
  const setup = await app.request("/stack/v1/operator/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "correct horse battery staple" }),
  });
  expect(setup.status).toBe(201);
  const cookie = setup.headers.get("set-cookie");
  expect(cookie?.startsWith("stack_session=")).toBe(true);
  return cookie?.split(";")[0] ?? "";
}

const headers = { stack_session: "unknown" };

beforeEach(() => {
  __resetEventsForTests();
  __resetRepairsForTests();
  __resetOperatorForTests();
  __resetOperatorThrottleForTests();
});

test("an engine crash opens a repair that is resolved once and 404 after", async () => {
  const auth = { cookie: await operatorSessionCookie() };
  reportChatEngineExited("scripted crash");
  const open = await (await app.request("/stack/v1/repairs", { headers: auth })).json() as { repairs: Array<{ id: string; action: string; resolvedAt: string | null }> };
  expect(open.repairs).toHaveLength(1);
  const { id, action, resolvedAt } = open.repairs[0]!;
  expect(REPAIR_ACTIONS.includes(action as (typeof REPAIR_ACTIONS)[number])).toBe(true);
  expect(resolvedAt).toBeNull();

  const resolved = await app.request(`/stack/v1/repairs/${id}/resolve`, { method: "POST", headers: auth });
  expect(resolved.status).toBe(200);
  const after = await (await app.request("/stack/v1/repairs", { headers: auth })).json() as { repairs: Array<{ id: string }> };
  expect(after.repairs.find((r) => r.id === id)).toBeUndefined();

  const again = await app.request(`/stack/v1/repairs/${id}/resolve`, { method: "POST", headers: auth });
  expect(again.status).toBe(404);
});

test("the repair routes require a session", async () => {
  expect((await app.request("/stack/v1/repairs", { headers })).status).toBe(401);
  expect((await app.request("/stack/v1/repairs/unknown/resolve", { method: "POST", headers })).status).toBe(401);
});
