import { afterEach, expect, test } from "bun:test";
import { MaintenanceScheduler } from "@/lib/maintenance";
import { recordUsageSample, recordMemorySample, recordSpeedResult } from "@/lib/series";
import { __resetEventsForTests, listNotifications } from "@/lib/events";
import { __resetStackSettingsForTests } from "@/settings/stackKeys";
import { __resetDigestForTests } from "@/lib/digest";
import { issueClient, listClients } from "@/lib/clients";
import { db } from "@/db";
import { clients, usageSamples, memorySamples, speedResults } from "@/db/schema";
import { ne } from "drizzle-orm";

const clock = (hour: number, minute = 0) => ({ now: () => new Date(2026, 8, 18, hour, minute) });
const quiet = { secondsSinceInput: () => 301 };
const normal = { onBattery: () => false };

afterEach(() => { db.delete(clients).where(ne(clients.name, "test-suite")).run(); db.delete(usageSamples).run(); db.delete(memorySamples).run(); db.delete(speedResults).run(); __resetEventsForTests(); __resetStackSettingsForTests(); __resetDigestForTests(); });

function cleanSeriesTables() { db.delete(usageSamples).run(); db.delete(memorySamples).run(); db.delete(speedResults).run(); db.delete(clients).where(ne(clients.name, "test-suite")).run(); }

test("a scripted week yields exactly one digest with the expected facts, and a restart in the same week yields none", async () => {
  cleanSeriesTables();
  issueClient("Jessie's Mac", ["chat"]);
  issueClient("Kitchen tablet", ["image"]);
  const clients = listClients();
  const clientA = clients.find((c) => c.name === "Jessie's Mac")!.id;
  const clientB = clients.find((c) => c.name === "Kitchen tablet")!.id;

  recordUsageSample({ at: new Date(2026, 8, 14, 10).toISOString(), ability: "chat", clientId: clientA, modelId: "m1", requests: 10, tokensIn: 100, tokensOut: 25, jobs: 0 });
  recordUsageSample({ at: new Date(2026, 8, 15, 10).toISOString(), ability: "chat", clientId: clientA, modelId: "m1", requests: 5, tokensIn: 50, tokensOut: 10, jobs: 0 });
  recordUsageSample({ at: new Date(2026, 8, 16, 10).toISOString(), ability: "image", clientId: clientB, modelId: "m2", requests: 20, tokensIn: 0, tokensOut: 0, jobs: 1 });
  recordMemorySample({ at: new Date(2026, 8, 14, 10).toISOString(), totalBytes: 24 * 1_073_741_824, freeBytes: 10 * 1_073_741_824, availablePercent: 40, pressure: "normal", loadedBytes: 0 });
  recordMemorySample({ at: new Date(2026, 8, 17, 10).toISOString(), totalBytes: 24 * 1_073_741_824, freeBytes: 11 * 1_073_741_824, availablePercent: 45, pressure: "normal", loadedBytes: 0 });
  recordSpeedResult({ at: new Date(2026, 8, 15, 10).toISOString(), ability: "chat", modelId: "m1", engine: "llama", firstTokenMs: 100, tokensPerSecond: 15, contextLength: 4096 });
  recordSpeedResult({ at: new Date(2026, 8, 15, 10).toISOString(), ability: "image", modelId: "m2", engine: "llama", firstTokenMs: 500, tokensPerSecond: 3, contextLength: 4096 });

  const settings = () => ({ alertWeeklyDigest: true, maintenanceStart: "02:00", maintenanceEnd: "05:00" });
  const scheduler = new MaintenanceScheduler({ clock: clock(2, 30), activity: quiet, battery: normal, pressure: () => "normal", settings });

  const result = await scheduler.run();
  expect(result.state).toBe("ran");
  expect(result.ran).toContain("digest");

  const notifications = listNotifications() as Array<{ eventId: string; title: string }>;
  const digest = notifications.find((n) => n.eventId === "digest.week");
  expect(digest).toBeDefined();
  expect(notifications.filter((n) => n.eventId === "digest.week").length).toBe(1);

  const expected = "35 requests were served. 185 tokens were used. The busiest client was Kitchen tablet. The slowest role was image. Free storage grew by 1 GB.";
  expect(digest!.title).toBe(expected);

  const restart = new MaintenanceScheduler({ clock: clock(3, 0), activity: quiet, battery: normal, pressure: () => "normal", settings });
  const result2 = await restart.run();
  expect(result2.state).toBe("ran");

  const notifications2 = listNotifications() as Array<{ eventId: string }>;
  expect(notifications2.filter((n) => n.eventId === "digest.week").length).toBe(1);
});

test("the digest is off by default and runs nothing when disabled", async () => {
  cleanSeriesTables();
  const settings = () => ({ alertWeeklyDigest: false, maintenanceStart: "02:00", maintenanceEnd: "05:00" });
  const scheduler = new MaintenanceScheduler({ clock: clock(2, 30), activity: quiet, battery: normal, pressure: () => "normal", settings });
  const result = await scheduler.run();
  expect(result.state).toBe("ran");
  const notifications = listNotifications() as Array<{ eventId: string }>;
  expect(notifications.filter((n) => n.eventId === "digest.week").length).toBe(0);
});
