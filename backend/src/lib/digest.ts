import { and, eq, gte, desc } from "drizzle-orm";
import { db } from "@/db";
import { usageSamples, speedResults, memorySamples, meta, clients } from "@/db/schema";
import { emit } from "@/lib/events";
import type { Clock } from "@/lib/maintenance";

const systemClock: Clock = { now: () => new Date() };

function weekKey(now: Date): string {
  const d = new Date(now);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function readWeekKey(now: Date): string | null {
  return db.select({ value: meta.value }).from(meta).where(eq(meta.key, "digest.weekKey.inEffect")).get()?.value ?? null;
}

function writeWeekKey(now: Date): void {
  const key = weekKey(now);
  db.insert(meta).values({ key: "digest.weekKey.inEffect", value: key }).onConflictDoUpdate({ target: meta.key, set: { value: key } }).run();
}

function weekStart(now: Date): Date {
  const d = new Date(now);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

function buildDigestSentences(now: Date, clock: Clock): string[] {
  const start = weekStart(now).toISOString();
  const end = clock.now().toISOString();
  const since = start;

  const usageRows = db.select().from(usageSamples).where(gte(usageSamples.at, since)).all();
  const totalRequests = usageRows.reduce((sum, row) => sum + row.requests, 0);
  const totalTokensIn = usageRows.reduce((sum, row) => sum + row.tokensIn, 0);
  const totalTokensOut = usageRows.reduce((sum, row) => sum + row.tokensOut, 0);
  const totalTokens = totalTokensIn + totalTokensOut;

  const byClient = new Map<string, number>();
  for (const row of usageRows) {
    if (row.clientId) byClient.set(row.clientId, (byClient.get(row.clientId) ?? 0) + row.requests);
  }
  let busiestClient: string | null = null;
  let busiestRequests = 0;
  for (const [clientId, requests] of byClient) {
    if (requests > busiestRequests) { busiestRequests = requests; busiestClient = clientId; }
  }
  const busiestClientName = busiestClient ? (db.select().from(clients).where(eq(clients.id, busiestClient)).get()?.name ?? "a client") : null;

  const speedRows = db.select().from(speedResults).where(and(gte(speedResults.at, since), gte(speedResults.tokensPerSecond, 0))).all();
  let slowestRole: string | null = null;
  let slowestTps = Infinity;
  for (const row of speedRows) {
    if (row.ability && row.tokensPerSecond !== null && row.tokensPerSecond < slowestTps) { slowestTps = row.tokensPerSecond; slowestRole = row.ability; }
  }

  const memoryRows = db.select().from(memorySamples).where(gte(memorySamples.at, since)).orderBy(desc(memorySamples.at)).all();
  const first = memoryRows[memoryRows.length - 1];
  const last = memoryRows[0];
  const storageChange = first && last ? last.freeBytes - first.freeBytes : 0;

  const sentences: string[] = [];
  if (totalRequests > 0) sentences.push(`${totalRequests} requests were served.`);
  if (totalTokens > 0) sentences.push(`${totalTokens} tokens were used.`);
  if (busiestClientName) sentences.push(`The busiest client was ${busiestClientName}.`);
  if (slowestRole) sentences.push(`The slowest role was ${slowestRole}.`);
  if (Math.abs(storageChange) > 0) {
    const abs = Math.abs(storageChange);
    const unit = abs >= 1_073_741_824 ? "GB" : "MB";
    const amount = Math.round(abs / (unit === "GB" ? 1_073_741_824 : 1_073_741_824));
    sentences.push(storageChange > 0 ? `Free storage grew by ${amount} ${unit}.` : `Free storage shrank by ${amount} ${unit}.`);
  }
  return sentences;
}

export function runWeeklyDigest(clock: Clock = systemClock): void {
  const now = clock.now();
  const currentWeek = weekKey(now);
  const previousWeek = readWeekKey(now);
  if (previousWeek === currentWeek) return;

  const sentences = buildDigestSentences(now, clock);
  const title = sentences.join(" ");
  emit({ id: "digest.week", data: { sentences, weekKey: currentWeek, message: title } });
  writeWeekKey(now);
}

export function __resetDigestForTests(): void {
  db.delete(meta).where(eq(meta.key, "digest.weekKey.inEffect")).run();
}
