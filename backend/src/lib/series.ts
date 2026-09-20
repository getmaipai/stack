import { and, asc, desc, eq, gte, lt } from "drizzle-orm";
import { db } from "@/db";
import { memorySamples, resourceSamples, speedResults, usageSamples } from "@/db/schema";
import { collectSample, getLastLiveSample } from "@/lib/live";
import { getMemoryReader } from "@/lib/memory";

export type SeriesRange = "hour" | "day" | "week" | "month";
const durations: Record<SeriesRange, number> = { hour: 60 * 60_000, day: 24 * 60 * 60_000, week: 7 * 24 * 60 * 60_000, month: 30 * 24 * 60 * 60_000 };

export interface UsageDeltaSample { at: string; ability: string | null; clientId: string | null; modelId: string | null; requests: number; tokensIn: number; tokensOut: number; jobs: number; }
export interface MemorySample { at: string; totalBytes: number; freeBytes: number; availablePercent: number; pressure: string; loadedBytes: number; }
export interface SpeedResult { at: string; ability: string | null; modelId: string | null; engine: string | null; firstTokenMs: number | null; loadMs: number | null; measuredFootprintBytes: number | null; promptTps: number | null; tokensPerSecond: number | null; contextLength: number | null; }

export function sinceFor(range: SeriesRange): string { return new Date(Date.now() - durations[range]).toISOString(); }

export function recordUsageSample(sample: Omit<UsageDeltaSample, "at"> & { at?: string }): void {
  db.insert(usageSamples).values({ at: sample.at ?? new Date().toISOString(), ability: sample.ability, clientId: sample.clientId, modelId: sample.modelId, requests: sample.requests, tokensIn: sample.tokensIn, tokensOut: sample.tokensOut, jobs: sample.jobs }).run();
}

export interface UsualChatHour { hour: number; days: number; requests: number; }

// Usage is intentionally read in the Stack's local timezone. The warm-up is a
// convenience for the person using this computer, not a portable profile.
export function usualChatHour(now = new Date()): UsualChatHour | null {
  const since = new Date(now); since.setDate(since.getDate() - 28);
  const rows = db.select().from(usageSamples).where(gte(usageSamples.at, since.toISOString())).all()
    .filter((row) => row.ability === "chat" && row.requests > 0);
  const hours = new Map<number, { dates: Set<string>; requests: number }>();
  for (const row of rows) {
    const at = new Date(row.at); const hour = at.getHours();
    const day = `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;
    const bucket = hours.get(hour) ?? { dates: new Set<string>(), requests: 0 };
    bucket.dates.add(day); bucket.requests += row.requests; hours.set(hour, bucket);
  }
  const candidates = [...hours.entries()]
    .filter(([, value]) => value.dates.size >= 3)
    .map(([hour, value]) => ({ hour, days: value.dates.size, requests: value.requests }))
    .sort((left, right) => right.requests - left.requests || right.days - left.days || left.hour - right.hour);
  return candidates[0] ?? null;
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
  const bucketCount = range === "hour" ? 13 : range === "day" ? 25 : range === "week" ? 29 : 61;
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

// Resource history: CPU, memory, GPU and storage, one row per kind per
// sample so a future resource is a new kind, not a new table (the
// STACK-50 database split is not built; see the schema comment).
export type ResourceKind = "cpu" | "memory" | "gpu" | "storage";
export interface ResourceGpuDevice { index: number; name: string; utilization: number | null; memoryUsedBytes: number | null; memoryTotalBytes: number | null; }
export interface ResourceDriveDevice { name: string; usedBytes: number; totalBytes: number; }
export interface ResourceBucket { at: string; percent: number | null; usedBytes: number | null; totalBytes: number | null; }
export interface ResourcesSampleInput {
  at?: string;
  cpuPercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  gpus: ResourceGpuDevice[];
  drives: ResourceDriveDevice[];
}

export function recordResourcesSample(sample: ResourcesSampleInput): void {
  const at = sample.at ?? new Date().toISOString();
  const cpuPercent = sample.cpuPercent !== null ? Math.round(sample.cpuPercent) : null;
  const memoryPercent = sample.memoryTotalBytes && sample.memoryTotalBytes > 0 && sample.memoryUsedBytes !== null
    ? Math.round((sample.memoryUsedBytes / sample.memoryTotalBytes) * 100) : null;
  const gpuUtilizations = sample.gpus.map((gpu) => gpu.utilization).filter((value): value is number => value !== null);
  const gpuPercent = gpuUtilizations.length > 0 ? Math.round(gpuUtilizations.reduce((sum, value) => sum + value, 0) / gpuUtilizations.length) : null;
  const storageUsed = sample.drives.reduce((sum, drive) => sum + drive.usedBytes, 0);
  const storageTotal = sample.drives.reduce((sum, drive) => sum + drive.totalBytes, 0);
  const storagePercent = storageTotal > 0 ? Math.round((storageUsed / storageTotal) * 100) : null;
  db.insert(resourceSamples).values([
    { at, kind: "cpu", percent: cpuPercent, usedBytes: null, totalBytes: null, devices: null },
    { at, kind: "memory", percent: memoryPercent, usedBytes: sample.memoryUsedBytes, totalBytes: sample.memoryTotalBytes, devices: null },
    { at, kind: "gpu", percent: gpuPercent, usedBytes: null, totalBytes: null, devices: sample.gpus.length ? JSON.stringify(sample.gpus) : null },
    { at, kind: "storage", percent: storagePercent, usedBytes: sample.drives.length ? storageUsed : null, totalBytes: sample.drives.length ? storageTotal : null, devices: sample.drives.length ? JSON.stringify(sample.drives) : null },
  ]).run();
}

const RESOURCE_RETENTION_MS = 35 * 24 * 60 * 60_000;

export function pruneResourceSamples(now = Date.now()): void {
  const cutoff = new Date(now - RESOURCE_RETENTION_MS).toISOString();
  db.delete(resourceSamples).where(lt(resourceSamples.at, cutoff)).run();
}

// The live sampler (lib/live.ts) already polls processes, GPUs and
// drives every 5 s; this reuses its last sample rather than running a
// second `ps`/`df` pass, and reads memory the same way the governor
// does. It runs unconditionally from process start (lib/live.ts's
// sampler is the same), unlike the governor's memory sampler, which
// only runs while the chat engine is loaded and so cannot be this
// panel's source.
export async function sampleResourcesOnce(): Promise<void> {
  // startLiveSampler()'s own first sample resolves asynchronously, so the
  // very first call here (right after it, at process boot) would otherwise
  // record cpu/gpus/drives as empty even on real hardware; collect one
  // directly rather than wait for the interval to catch up.
  const live = getLastLiveSample() ?? (await collectSample().catch(() => null));
  const memory = getMemoryReader().read();
  recordResourcesSample({
    cpuPercent: live?.cpu.percent ?? null,
    memoryUsedBytes: memory.totalBytes - memory.freeBytes,
    memoryTotalBytes: memory.totalBytes,
    gpus: (live?.gpus ?? []).map((gpu, index) => ({ index, name: gpu.name, utilization: gpu.utilization, memoryUsedBytes: gpu.memoryUsedBytes, memoryTotalBytes: gpu.memoryTotalBytes })),
    drives: (live?.drives ?? []).filter((drive) => drive.mounted).map((drive) => ({ name: drive.name, usedBytes: drive.usedBytes, totalBytes: drive.totalBytes })),
  });
}

let resourcesSamplerHandle: ReturnType<typeof setInterval> | null = null;

export function startResourcesSampler(intervalMs = 60_000): void {
  if (resourcesSamplerHandle) return;
  void sampleResourcesOnce();
  resourcesSamplerHandle = setInterval(() => { void sampleResourcesOnce(); }, intervalMs);
}

export function stopResourcesSampler(): void {
  if (resourcesSamplerHandle) {
    clearInterval(resourcesSamplerHandle);
    resourcesSamplerHandle = null;
  }
}

const resourceBucketCounts: Record<SeriesRange, number> = { hour: 60, day: 96, week: 168, month: 120 };
const resourceStepMs: Record<SeriesRange, number> = { hour: 60_000, day: 15 * 60_000, week: 60 * 60_000, month: 6 * 60 * 60_000 };

export interface ResourceSeriesResult {
  cpu: ResourceBucket[];
  memory: ResourceBucket[];
  gpu: ResourceBucket[];
  storage: ResourceBucket[];
  devices: { gpus: ResourceGpuDevice[]; drives: ResourceDriveDevice[] };
}

export function readResourceSeries(range: SeriesRange): ResourceSeriesResult {
  const stepMs = resourceStepMs[range];
  const bucketCount = resourceBucketCounts[range];
  const end = Date.now();
  const start = end - stepMs * bucketCount;
  const since = new Date(start).toISOString();
  const rows = db.select().from(resourceSamples).where(gte(resourceSamples.at, since)).orderBy(asc(resourceSamples.at)).all();
  const buckets = Array.from({ length: bucketCount }, (_, index) => new Date(start + (index + 1) * stepMs).toISOString());

  const bucketed = (kind: ResourceKind): ResourceBucket[] => {
    const kindRows = rows.filter((row) => row.kind === kind);
    return buckets.map((at) => {
      const atMs = new Date(at).getTime();
      let best: (typeof kindRows)[number] | undefined;
      let bestDelta = Infinity;
      for (const row of kindRows) {
        const delta = Math.abs(new Date(row.at).getTime() - atMs);
        if (delta <= stepMs / 2 && delta < bestDelta) { best = row; bestDelta = delta; }
      }
      return best ? { at, percent: best.percent, usedBytes: best.usedBytes, totalBytes: best.totalBytes } : { at, percent: null, usedBytes: null, totalBytes: null };
    });
  };

  const latestGpuRow = [...rows].reverse().find((row) => row.kind === "gpu" && row.devices);
  const latestDriveRow = [...rows].reverse().find((row) => row.kind === "storage" && row.devices);

  return {
    cpu: bucketed("cpu"),
    memory: bucketed("memory"),
    gpu: bucketed("gpu"),
    storage: bucketed("storage"),
    devices: {
      gpus: latestGpuRow?.devices ? (JSON.parse(latestGpuRow.devices) as ResourceGpuDevice[]) : [],
      drives: latestDriveRow?.devices ? (JSON.parse(latestDriveRow.devices) as ResourceDriveDevice[]) : [],
    },
  };
}
