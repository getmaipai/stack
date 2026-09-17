import { beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetEventsForTests, clearAll, emit, listNotifications } from "@/lib/events";
import { __resetRepairsForTests } from "@/lib/repairs";
import { reportChatEngineExited } from "@/lib/supervisor";
import { testClientHeaders } from "./authTest";

beforeEach(() => {
  __resetEventsForTests();
  __resetRepairsForTests();
});

test("an engine crash produces an event, one-action repair, and notification", async () => {
  reportChatEngineExited("scripted crash");
  const notifications = listNotifications();
  expect(notifications.some((item) => (item as { eventId: string }).eventId === "engine.state")).toBe(true);
  expect(notifications.some((item) => (item as { eventId: string }).eventId === "repair")).toBe(true);
  const repairs = await (await app.request("/stack/v1/repairs", { headers: testClientHeaders })).json() as { repairs: Array<{ action: string }> };
  expect(repairs.repairs[0]?.action).toBe("restart_engine");
});

test("the SSE route replays events after Last-Event-ID", async () => {
  const first = emit({ id: "engine.state", data: { state: "ready" } });
  const second = emit({ id: "pressure", data: { freeMemoryBytes: 1 } });
  const response = await app.request("/stack/v1/events", { headers: { ...testClientHeaders, "last-event-id": String(first.seq) } });
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const body = await response.text();
  expect(body).not.toContain(`"seq":${first.seq}`);
  expect(body).toContain(`"seq":${second.seq}`);
});

test("clearAll empties the durable notification center", () => {
  emit({ id: "pressure", data: { freeMemoryBytes: 1 } });
  expect(listNotifications()).toHaveLength(1);
  clearAll();
  expect(listNotifications()).toHaveLength(0);
});
