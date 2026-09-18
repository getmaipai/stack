import { afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@/db";
import { checkRuns, memorySamples, notifications, usageSamples } from "@/db/schema";
import { __resetEventsForTests } from "@/lib/events";
import { writeOrphans, writeModelManifest } from "@/lib/store/manifests";
import { ensureStoreLayout } from "@/lib/store/layout";
import { composeDigest, runWeeklyDigest } from "@/lib/digest";
import { updateStackConfig, __resetStackSettingsForTests, readStackConfig } from "@/settings/stackKeys";

const iso = (ms: number) => new Date(Date.now() - ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DIGEST = "a".repeat(64);

beforeAll(() => { process.env.STACK_DATA_DIR = mkdtempSync(join(tmpdir(), "maipai-stack-digest-")); });
afterEach(() => {
  __resetEventsForTests();
  __resetStackSettingsForTests();
  db.delete(usageSamples).run();
  db.delete(memorySamples).run();
  db.delete(checkRuns).run();
  db.delete(notifications).run();
  writeOrphans({});
});

test("weekly digest composes five plain sentences from scripted usage, update, memory, check, and store data", () => {
  db.insert(usageSamples).values([{ at: iso(HOUR), ability: "chat", clientId: "client", modelId: "model", requests: 1_000, tokensIn: 1_500_000_000, tokensOut: 2_000_000, jobs: 0 }, { at: iso(3 * DAY), ability: "chat", clientId: "client", modelId: "model", requests: 2_000, tokensIn: 1_500_000_000, tokensOut: 2_000_000, jobs: 0 }]).run();
  db.insert(memorySamples).values([{ at: iso(2 * HOUR), totalBytes: 16_000_000_000, freeBytes: 4_000_000_000, availablePercent: 25, pressure: "pressure", loadedBytes: 0 }, { at: iso(5 * DAY), totalBytes: 16_000_000_000, freeBytes: 14_000_000_000, availablePercent: 88, pressure: "comfort", loadedBytes: 0 }]).run();
  db.insert(notifications).values({ id: "notification-digest", eventId: "update.applied", level: "passive", title: "The update was applied.", data: "{}", at: iso(2 * DAY), readAt: null, dismissedAt: null }).run();
  db.insert(checkRuns).values({ at: iso(4 * DAY), ok: 1, results: "[]", fitTogetherOk: 1, fitTogetherReason: null }).run();
  ensureStoreLayout();
  writeModelManifest({ kind: "model", id: "model", source: "local", roles: ["chat"], blobs: [{ digest: DIGEST, sizeBytes: 1_500_000_000, path: `models/${DIGEST}` }], sizeBytes: 1_500_000_000, createdAt: iso(DAY) });
  writeOrphans({ [DIGEST]: Date.now() });

  const sentences = composeDigest({ until: new Date().toISOString() });
  expect(sentences).toHaveLength(5);
  expect(sentences[0]).toBe("The Stack answered 3,000 requests and moved 3 GB of text last week.");
  expect(sentences[1]).toBe("It applied 1 update last week.");
  expect(sentences[2]).toBe("Memory ran tight, dropping below half free once last week.");
  expect(sentences[3]).toBe("About 1.5 GB of stored data no longer belongs to any model and could be cleaned up.");
  expect(sentences[4]).toBe("The Stack check passed last week.");
});

test("weekly digest reports failure, no updates, and a clean store when the check fails", () => {
  db.insert(memorySamples).values([{ at: iso(2 * HOUR), totalBytes: 16_000_000_000, freeBytes: 12_000_000_000, availablePercent: 75, pressure: "comfort", loadedBytes: 0 }]).run();
  db.insert(checkRuns).values({ at: iso(DAY), ok: 0, results: "[]", fitTogetherOk: 0, fitTogetherReason: "The engine does not fit together." }).run();

  const sentences = composeDigest({ until: new Date().toISOString() });
  expect(sentences[1]).toBe("It applied 0 updates last week.");
  expect(sentences[2]).toBe("Memory stayed comfortable, peaking at 25% used last week.");
  expect(sentences[3]).toBe("No stored data is waiting to be cleaned up.");
  expect(sentences[4]).toBe("The Stack check failed last week because The engine does not fit together.");
});

test("weekly digest respects the setting and emits a durable notification when enabled", () => {
  updateStackConfig({ weeklyDigest: true });
  expect(readStackConfig().find((setting) => setting.key === "weeklyDigest")?.inEffect).toBe(true);
  runWeeklyDigest();
  const rows = db.select().from(notifications).all();
  expect(rows.length).toBe(1);
  expect(rows[0]!.eventId).toBe("digest.weekly");
  expect(rows[0]!.title).toContain("The Stack answered");
});

test("weekly digest stays silent when the setting is off", () => {
  expect(readStackConfig().find((setting) => setting.key === "weeklyDigest")?.inEffect).toBe(false);
  runWeeklyDigest();
  expect(db.select().from(notifications).all().length).toBe(0);
});
