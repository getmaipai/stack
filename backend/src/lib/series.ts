import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { memorySamples, speedResults, usageSamples } from "@/db/schema";

export type SeriesRange = "hour" | "day" | "week";
const durations: Record<SeriesRange, number> = { hour: 60 * 60_000, day: 24 * 60 * 60_000, week: 7 * 24 * 60 * 60_000 };

export interface UsageDeltaSample { at: string; ability: string | null; clientId: string | null; modelId: string | null; requests: number; tokensIn: number; tokensOut: number; jobs: number; }
export interface MemorySample { at: string; totalBytes: number; freeBytes: number; availablePercent: number; pressure: string; loadedBytes: number; }
export interface SpeedResult { at: string; ability: string | null; modelId: string | null; engine: string | null; firstTokenMs: number | null; loadMs: number | null; measuredFootprintBytes: number | null; promptTps: number | null; tokensPerSecond: number | null; contextLength: number | null; }

export function sinceFor(range: SeriesRange): string { return new Date(Date.now() - durations[range]).toISOString(); }

export function recordUsageSample(sample: Omit<UsageDeltaSample, "at"> & { at?: string }): void {
  db.insert(usageSamples).values({ at: sample.at ?? new Date().toISOString(), ability: sample.ability, clientId: sample.clientId, modelId: sample.modelId, requests: sample.requests, tokensIn: sample.tokensIn, tokensOut: sample.tokensOut, jobs: sample.jobs }).run();
}

export function recordMemorySample(sample: Omit<MemorySample, "at"> & { at?: string }): void {
  db.insert(memorySamples).values({ at: sample.at ?? new Date().toISOString(), totalBytes: sample.totalBytes, freeBytes: sample.freeBytes, availablePercent: Math.round(sample.availablePercent), pressure: sample.pressure, loadedBytes: sample.loadedBytes }).run();
}

export function recordSpeedResult(result: Omit<SpeedResult, "at" | "loadMs" | "measuredFootprintBytes" | "promptTps" | "contextLength"> & Partial<Pick<SpeedResult, "loadMs" | "measuredFootprintBytes" | "promptTps" | "contextLength">> & { at?: string }): SpeedResult {
  const row = { at: result.at ?? new Date().toISOString(), ability: result.ability, modelId: result.modelId, engine: result.engine, firstTokenMs: result.firstTokenMs, loadMs: result.loadMs ?? null, measuredFootprintBytes: result.measuredFootprintBytes ?? null, promptTps: result.promptTps ?? null, tokensPerSecond: result.tokensPerSecond, contextLength: result.contextLength ?? null };
  db.insert(speedResults).values(row).run();
  return row;
}

export function latestSpeedResult(modelId: string, contextLength: number): SpeedResult | null {
  return db.select().from(speedResults)
    .where(and(eq(speedResults.modelId, modelId), eq(speedResults.contextLength, contextLength)))
    .orderBy(desc(speedResults.at)).limit(1).get() ?? null;
}

export function readSeries(range: SeriesRange) {
  const since = sinceFor(range);
  const end = Date.now();
  const bucketCount = range === "hour" ? 13 : range === "day" ? 25 : 29;
  const step = durations[range] / (bucketCount - 1);
  const buckets = Array.from({ length: bucketCount }, (_, index) => new Date(end - durations[range] + index * step).toISOString());
  const where = gte(usageSamples.at, since);
  const usageRows = db.select().from(usageSamples).where(where).all();
  const memoryRows = db.select().from(memorySamples).where(and(gte(memorySamples.at, since))).all();
  const speedRows = db.select().from(speedResults).where(and(gte(speedResults.at, since))).all();
  const nearest = <T extends { at: string }>(rows: T[], at: string): T | undefined => rows.reduce<T | undefined>((best, row) => {
    if (!best) return row;
    return Math.abs(new Date(row.at).getTime() - new Date(at).getTime()) < Math.abs(new Date(best.at).getTime() - new Date(at).getTime()) ? row : best;
  }, undefined);
  return {
    usage: buckets.map((at) => { const rows = usageRows.filter((row) => Math.abs(new Date(row.at).getTime() - new Date(at).getTime()) <= step / 2); const sample = rows[0]; if (!sample) return { at, ability: null, clientId: null, modelId: null, requests: 0, tokensIn: 0, tokensOut: 0, jobs: 0 }; const { id: _id, ...rest } = sample; return { ...rest, at }; }),
    memory: buckets.map((at) => { const sample = nearest(memoryRows, at); if (!sample) return { at, totalBytes: 0, freeBytes: 0, availablePercent: 0, pressure: "normal", loadedBytes: 0 }; const { id: _id, ...rest } = sample; return { ...rest, at }; }),
    speed: buckets.map((at) => { const sample = nearest(speedRows, at); if (!sample) return { at, ability: null, modelId: null, engine: null, firstTokenMs: null, loadMs: null, measuredFootprintBytes: null, promptTps: null, tokensPerSecond: null, contextLength: null }; const { id: _id, ...rest } = sample; return { ...rest, at }; }),
  };
}
