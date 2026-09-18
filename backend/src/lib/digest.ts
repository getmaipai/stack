import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { checkRuns, memorySamples, notifications, usageSamples } from "@/db/schema";
import { notifyAlertChannels } from "@/lib/channels";
import { listModelManifests, readOrphans } from "@/lib/store/manifests";
import { readStackConfig } from "@/settings/stackKeys";
import { emit } from "@/lib/events";

function int(value: number): string { return new Intl.NumberFormat("en-US").format(value); }
function gb(value: number): string { return (value * 10).toFixed(1).replace(/\.0$/, ""); }

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function composeDigest(range: { until: string } = { until: new Date().toISOString() }): string[] {
  const until = new Date(range.until).getTime();
  const since = until - WEEK_MS;

  const usage = db.select({
    requests: sql<number>`coalesce(sum(${usageSamples.requests}), 0)`,
    tokensIn: sql<number>`coalesce(sum(${usageSamples.tokensIn}), 0)`,
    tokensOut: sql<number>`coalesce(sum(${usageSamples.tokensOut}), 0)`,
  }).from(usageSamples).where(and(gte(usageSamples.at, new Date(since).toISOString()), lte(usageSamples.at, range.until))).get();
  const requests = usage?.requests ?? 0;
  const tokens = ((usage?.tokensIn ?? 0) + (usage?.tokensOut ?? 0)) / 1_000_000_000;

  const updatesApplied = db.select({ count: sql<number>`count(*)` }).from(notifications)
    .where(and(eq(notifications.eventId, "update.applied"), gte(notifications.at, new Date(since).toISOString()), lte(notifications.at, range.until))).get()?.count ?? 0;

  const memoryRows = db.select().from(memorySamples)
    .where(and(gte(memorySamples.at, new Date(since).toISOString()), lte(memorySamples.at, range.until))).all();
  const tightTimes = memoryRows.filter((row) => row.availablePercent < 50).length;
  const peakUsedPercent = memoryRows.length > 0 ? Math.max(...memoryRows.map((row) => 100 - row.availablePercent)) : null;

  const orphanBytes = Object.entries(readOrphans()).reduce((bytes, [digest]) => bytes + listModelManifests().reduce((sum, manifest) => sum + manifest.blobs.filter((blob) => blob.digest.toLowerCase() === digest).reduce((b, blob) => b + blob.sizeBytes, 0), 0), 0);

  const lastCheck = db.select().from(checkRuns).where(lte(checkRuns.at, range.until)).orderBy(desc(checkRuns.at)).limit(1).get();

  return [
    `The Stack answered ${int(requests)} requests and moved ${gb(tokens)} GB of text last week.`,
    updatesApplied === 1 ? "It applied 1 update last week." : `It applied ${int(updatesApplied)} updates last week.`,
    tightTimes > 0 ? `Memory ran tight, dropping below half free ${tightTimes === 1 ? "once" : `${int(tightTimes)} times`} last week.` : peakUsedPercent === null ? "Memory was not sampled last week." : `Memory stayed comfortable, peaking at ${peakUsedPercent < 10 ? gb(peakUsedPercent) : int(peakUsedPercent)}% used last week.`,
    orphanBytes > 0 ? `About ${gb(orphanBytes / 1_000_000_000)} GB of stored data no longer belongs to any model and could be cleaned up.` : "No stored data is waiting to be cleaned up.",
    lastCheck === null ? "The Stack check has not run since last week." : lastCheck.ok === 1 ? "The Stack check passed last week." : `The Stack check failed last week${lastCheck.fitTogetherReason ? ` because ${lastCheck.fitTogetherReason}` : ""}.`,
  ];
}

export function runWeeklyDigest(now: string = new Date().toISOString()): void {
  if (readStackConfig().find((setting) => setting.key === "weeklyDigest")?.inEffect !== true) return;
  const sentences = composeDigest({ until: now });
  const message = sentences.join(" ");
  emit({ id: "digest.weekly", data: { sentences } });
  db.insert(notifications).values({ id: `notification-${crypto.randomUUID()}`, eventId: "digest.weekly", level: "passive", title: message, data: JSON.stringify({ sentences }), at: now, readAt: null, dismissedAt: null }).run();
  void notifyAlertChannels(message);
}
