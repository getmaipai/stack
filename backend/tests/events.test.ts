import { beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetEventsForTests, clearAll, dismiss, emit, listActivity, listNotifications } from "@/lib/events";
import { __resetHealthForTests, raise } from "@/lib/health";
import { __resetRepairsForTests } from "@/lib/repairs";
import { reportChatEngineExited } from "@/lib/supervisor";
import { EVENTS } from "@/events";
import { testClientHeaders } from "./authTest";

beforeEach(() => {
  __resetEventsForTests();
  __resetRepairsForTests();
  __resetHealthForTests();
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

test("the live event (fired every 5s indefinitely by live.ts) never persists a notification row", () => {
  emit({ id: "live", data: { at: new Date().toISOString() } });
  emit({ id: "live", data: { at: new Date().toISOString() } });
  expect(listNotifications()).toHaveLength(0);
});

test("clearAll empties the durable notification center", () => {
  emit({ id: "pressure", data: { freeMemoryBytes: 1 } });
  expect(listNotifications()).toHaveLength(1);
  clearAll();
  expect(listNotifications()).toHaveLength(0);
});

test("notification titles are plain sentences, no codes or placeholders", () => {
  emit({ id: "engine.state", data: { engine: "chat", state: "stopped" } });
  emit({ id: "model.installed", data: { model: "Llama" } });
  emit({ id: "job.done", data: { job: "setup-downloads" } });
  emit({ id: "update.applied", data: { kind: "engine", name: "chat", tag: "0.4.5" } });
  emit({ id: "update.failed", data: { kind: "engine", reason: "bad bytes" } });
  emit({ id: "repair", data: { title: "Chat engine is offline", detail: "reason" } });
  emit({ id: "detected.changed", data: { count: 1 } });
  raise({ code: "disk-under-reserve", severity: "warning", title: "Disk space is running low", text: "The Stack is below its 10 GB free-space reserve.", cause: "The filesystem reported less than the Stack's reserve." });
  const notifications = listNotifications() as Array<{ title: string; eventId: string }>;
  for (const item of notifications) {
    expect(item.title).not.toMatch(/-/);
    expect(item.title).not.toContain("{");
  }
});

test("health.changed reads as the item's title with its severity", () => {
  raise({ code: "disk-under-reserve", severity: "warning", title: "Disk space is running low", text: "The Stack is below its 10 GB free-space reserve.", cause: "The filesystem reported less than the Stack's reserve." });
  const notifications = listNotifications() as Array<{ title: string; eventId: string }>;
  const changed = notifications.find((item) => item.eventId === "health.changed");
  expect(changed?.title).toBe("Disk space is running low is warning.");
});

test("every event template renders as a plain sentence with no identifier tokens", () => {
  const samples: Record<string, Record<string, unknown>> = {
    "role.state": { role: "The chat", state: "ready" },
    "engine.state": { engine: "chat", state: "stopped" },
    pressure: { freeMemoryBytes: 1, floorBytes: 1, pressure: "warn", availablePercent: 10 },
    "job.progress": { job: "setup-downloads", percent: 42, completedBytes: 42, totalBytes: 100 },
    "job.done": { job: "setup-downloads" },
    "model.installed": { model: "Llama" },
    "update.available": { kind: "app" },
    "update.applied": { kind: "engine", name: "chat", tag: "0.4.5" },
    "update.failed": { kind: "engine", reason: "bad bytes" },
    repair: { title: "Chat engine is offline", detail: "reason" },
    "health.changed": { code: "disk-under-reserve", title: "Disk space is running low", severity: "warning" },
    "detected.changed": { count: 1 },
  };
  for (const [id, data] of Object.entries(samples)) {
    const definition = EVENTS[id as keyof typeof EVENTS];
    const title = definition.template.replace(/\{(\w+)\}/g, (_match, key: string) => {
      const value = data[key];
      return value === undefined ? `{${key}}` : String(value);
    });
    expect(title).not.toContain("{");
    expect(title).not.toMatch(/[a-z]+\-[a-z]/);
  }
});

test("activity is a filtered read of the durable log: installs, engine state, updates, checks, health, nothing else", () => {
  emit({ id: "model.installed", data: { model: "Llama" } });
  emit({ id: "engine.state", data: { engine: "chat", state: "stopped" } });
  emit({ id: "update.available", data: { kind: "app", version: "0.2.0" } });
  emit({ id: "check.done", data: {} });
  raise({ code: "disk-under-reserve", severity: "warning", title: "Disk space is running low", text: "low", cause: "low" });
  emit({ id: "pressure", data: { freeMemoryBytes: 1 } });
  emit({ id: "detected.changed", data: { count: 1 } });
  const activity = listActivity() as Array<{ eventId: string }>;
  const ids = activity.map((item) => item.eventId);
  expect(ids).toContain("model.installed");
  expect(ids).toContain("engine.state");
  expect(ids).toContain("update.available");
  expect(ids).toContain("check.done");
  expect(ids).toContain("health.changed");
  expect(ids).not.toContain("pressure");
  expect(ids).not.toContain("detected.changed");
});

test("dismissing or reading a notification does not remove it from activity: activity is history, not an inbox", () => {
  const envelope = emit({ id: "model.installed", data: { model: "Llama" } });
  const notification = (listNotifications() as Array<{ id: string; eventId: string }>).find((item) => item.eventId === envelope.id)!;
  dismiss(notification.id);
  expect(listNotifications().some((item) => (item as { id: string }).id === notification.id)).toBe(false);
  expect(listActivity().some((item) => (item as { id: string }).id === notification.id)).toBe(true);
});

test("GET /stack/v1/activity returns the same rows over HTTP", async () => {
  emit({ id: "model.installed", data: { model: "Llama" } });
  const response = await app.request("/stack/v1/activity", { headers: testClientHeaders });
  expect(response.status).toBe(200);
  const body = await response.json() as { activity: Array<{ eventId: string }> };
  expect(body.activity.some((item) => item.eventId === "model.installed")).toBe(true);
});
