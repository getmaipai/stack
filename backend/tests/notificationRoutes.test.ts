import { beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetEventsForTests } from "@/lib/events";
import { __resetOperatorForTests, __resetOperatorThrottleForTests } from "@/lib/operator";
import { __resetRepairsForTests } from "@/lib/repairs";
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

test("an engine crash lists one notification that is marked read, dismissed, or cleared", async () => {
  const cookie = await operatorSessionCookie();
  const auth = { cookie };
  reportChatEngineExited("scripted crash");
  const first = await (await app.request("/stack/v1/notifications", { headers: auth })).json() as { notifications: Array<{ id: string; eventId: string; title: string; readAt: string | null }> };
  const engine = first.notifications.find((n) => n.eventId === "engine.state");
  expect(engine).toBeDefined();
  const { id, title } = engine!;
  expect(title).toContain("chat");
  expect(title).toContain("offline");
  expect(title).not.toContain("{");
  expect(engine!.readAt).toBeNull();

  const read = await app.request(`/stack/v1/notifications/${id}/read`, { method: "POST", headers: auth });
  expect(read.status).toBe(200);
  const afterRead = await (await app.request("/stack/v1/notifications", { headers: auth })).json() as { notifications: Array<{ id: string; readAt: string | null }> };
  const readEntry = afterRead.notifications.find((n) => n.id === id);
  expect(readEntry?.readAt).not.toBeNull();

  const dismissed = await app.request(`/stack/v1/notifications/${id}/dismiss`, { method: "POST", headers: auth });
  expect(dismissed.status).toBe(200);
  const afterDismiss = await (await app.request("/stack/v1/notifications", { headers: auth })).json() as { notifications: Array<{ id: string }> };
  expect(afterDismiss.notifications.find((n) => n.id === id)).toBeUndefined();

  const cleared = await app.request("/stack/v1/notifications/clear", { method: "POST", headers: auth });
  expect(cleared.status).toBe(200);
  const afterClear = await (await app.request("/stack/v1/notifications", { headers: auth })).json() as { notifications: unknown[] };
  expect(afterClear.notifications).toHaveLength(0);
});

test("the notification routes require a session", async () => {
  expect((await app.request("/stack/v1/notifications", { headers })).status).toBe(401);
  for (const path of ["/stack/v1/notifications/unknown/read", "/stack/v1/notifications/unknown/dismiss"]) {
    expect((await app.request(path, { method: "POST", headers })).status).toBe(401);
  }
  expect((await app.request("/stack/v1/notifications/clear", { method: "POST", headers })).status).toBe(401);
});
