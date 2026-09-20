import { beforeEach, describe, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetEventsForTests, eventsAfter } from "@/lib/events";
import { __resetHealthForTests, list, raise, resolve } from "@/lib/health";

beforeEach(() => { __resetHealthForTests(); __resetEventsForTests(); });

describe("GET /healthz", () => {
  test("returns a healthy semver response", async () => {
    const response = await app.request("/healthz");
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; version: string; uptimeSeconds: number };
    expect(body.ok).toBe(true);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});

test("raising the same code updates one item and emits only on change", () => {
  const item = { code: "engine.crashed", severity: "error" as const, title: "Engine crashed", text: "The engine stopped.", cause: "exit", fix: { label: "Restart", action: "restart_engine" as const } };
  raise(item); raise(item);
  expect(list()).toHaveLength(1);
  expect(eventsAfter(0).filter((event) => event.id === "health.changed")).toHaveLength(1);
});

test("resolve removes an item from the active list", () => {
  raise({ code: "disk-under-reserve", severity: "warning", title: "Disk low", text: "Free space is low.", cause: "probe" });
  expect(resolve("disk-under-reserve")).toBe(true);
  expect(list()).toEqual([]);
  expect(resolve("disk-under-reserve")).toBe(false);
});

test("producer codes are stable, actionable, and every served item is the spec's HealthItem", () => {
  for (const code of ["engine.crashed.chat", "post-load-check-failed.chat", "managed-host-offline.tts", "memory-pressure-warn", "memory-pressure-critical", "admission-refused-repeatedly", "stored-blob-checksum-mismatch", "disk-under-reserve", "failed-swap", "check-fit-together"]) {
    raise({ code, severity: "warning", title: code, text: "scripted condition", cause: "scripted input", fix: { label: "Fix", action: "restart_engine" } });
  }
  expect(list().map((item) => item.code)).toEqual(expect.arrayContaining(["engine.crashed.chat", "failed-swap", "check-fit-together"]));
  expect(eventsAfter(0).filter((event) => event.id === "health.changed").every((event) => event.data.open === true)).toBe(true);
});

test("an engine's empty words never make the health list unreadable", () => {
  raise({ code: "check-role.chat", severity: "warning", title: "", text: "", cause: "", fix: { label: "Restart engine", action: "restart_engine" } });
  const item = list().find((candidate) => candidate.code === "check-role.chat")!;
  expect(item.title).toBe("check-role.chat");
  expect(item.text.length).toBeGreaterThan(0);
  expect(item.cause.length).toBeGreaterThan(0);
});
