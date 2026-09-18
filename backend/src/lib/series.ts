import { and, gte } from "drizzle-orm";
import { db } from "@/db";
import { memorySamples, speedResults, usageSamples } from "@/db/schema";

export type SeriesRange = "hour" | "day" | "week";
const durations: Record<SeriesRange, number> = { hour: 60 * 60_000, day: 24 * 60 * 60_000, week: 7 * 24 * 60 * 60_000 };

export interface UsageDeltaSample { at: string; ability: string | null; clientId: string | null; modelId: string | null; requests: number; tokensIn: number; tokensOut: number; jobs: number; }
export interface MemorySample { at: string; totalBytes: number; freeBytes: number; availablePercent: number; pressure: string; loadedBytes: number; }
export interface SpeedResult { at: string; ability: string | null; modelId: string | null; engine: string | null; firstTokenMs: number | null; tokensPerSecond: number | null; }

export function sinceFor(range: SeriesRange): string { return new Date(Date.now() - durations[range]).toISOString(); }

export function recordUsageSample(sample: Omit<UsageDeltaSample, "at"> & { at?: string }): void {
  db.insert(usageSamples).values({ at: sample.at ?? new Date().toISOString(), ability: sample.ability, clientId: sample.clientId, modelId: sample.modelId, requests: sample.requests, tokensIn: sample.tokensIn, tokensOut: sample.tokensOut, jobs: sample.jobs }).run();
}

export function recordMemorySample(sample: Omit<MemorySample, "at"> & { at?: string }): void {
  db.insert(memorySamples).values({ at: sample.at ?? new Date().toISOString(), totalBytes: sample.totalBytes, freeBytes: sample.freeBytes, availablePercent: Math.round(sample.availablePercent), pressure: sample.pressure, loadedBytes: sample.loadedBytes }).run();
}

export function recordSpeedResult(result: Omit<SpeedResult, "at"> & { at?: string }): void {
  db.insert(speedResults).values({ at: result.at ?? new Date().toISOString(), ability: result.ability, modelId: result.modelId, engine: result.engine, firstTokenMs: result.firstTokenMs, tokensPerSecond: result.tokensPerSecond }).run();
}

export function readSeries(range: SeriesRange) {
  const since = sinceFor(range);
  const where = gte(usageSamples.at, since);
  return {
    usage: db.select().from(usageSamples).where(where).all().map(({ id: _id, ...sample }) => sample),
    memory: db.select().from(memorySamples).where(and(gte(memorySamples.at, since))).all().map(({ id: _id, ...sample }) => sample),
    speed: db.select().from(speedResults).where(and(gte(speedResults.at, since))).all().map(({ id: _id, ...sample }) => sample),
  };
}
