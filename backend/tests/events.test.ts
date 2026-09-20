import { beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetEventsForTests, emit, eventsAfter, sseResponse, subscribe } from "@/lib/events";

beforeEach(() => __resetEventsForTests());

test("emit stamps a sequence and the ring replays from a sequence", () => {
  emit({ id: "engine.state", data: { engine: "chat", state: "ready" } });
  emit({ id: "health.changed", data: { code: "x", severity: "warning", title: "x", open: true } });
  expect(eventsAfter(0).map((event) => event.seq)).toEqual([1, 2]);
  expect(eventsAfter(1).map((event) => event.id)).toEqual(["health.changed"]);
});

test("the feed stays open: a reconnect replays after Last-Event-Id, then live events arrive", async () => {
  emit({ id: "engine.state", data: { engine: "chat", state: "ready" } });
  emit({ id: "model.installed", data: { model: "m" } });
  const controller = new AbortController();
  const response = sseResponse({ lastEventId: 1, signal: controller.signal });
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value);
  expect(first).toContain("id: 2\nevent: model.installed\n");
  expect(first).not.toContain("id: 1\n");
  emit({ id: "pressure", data: { pressure: "warn" } });
  const live = decoder.decode((await reader.read()).value);
  expect(live).toContain("event: pressure");
  expect(JSON.parse(live.split("data: ")[1]!.trim()).data.pressure).toBe("warn");
  controller.abort();
  expect((await reader.read()).done).toBe(true);
});

test("a subscriber that throws never stops the producer", () => {
  const unsubscribe = subscribe(() => { throw new Error("boom"); });
  expect(() => emit({ id: "job.done", data: { job: "j", ok: true } })).not.toThrow();
  unsubscribe();
});

test("GET /stack/v1/events answers as a stream and needs no key", async () => {
  emit({ id: "engine.state", data: { engine: "chat", state: "ready" } });
  const controller = new AbortController();
  const response = await app.request("/stack/v1/events", { headers: { "last-event-id": "0" }, signal: controller.signal });
  expect(response.status).toBe(200);
  const chunk = new TextDecoder().decode((await response.body!.getReader().read()).value);
  expect(chunk).toContain("event: engine.state");
  controller.abort();
});
