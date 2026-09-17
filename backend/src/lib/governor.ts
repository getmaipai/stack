import os from "node:os";
import { measureProcessMemoryBytes } from "@/lib/supervisor";
import { emit } from "@/lib/events";

const GB = 1_073_741_824;

export const GovernorRules = {
  pollMs: 5_000,
  queueMax: 4,
  idleTtlSeconds: 600,
  systemLowWaterPct: 0.1,
  systemLowWaterFloorBytes: GB,
  systemSustainedPolls: 2,
  processSafetyMultiplier: 1.3,
  processMinOverageBytes: 500_000_000,
  processSustainedPolls: 3,
  osMarginBytes: 8 * GB,
  engineMultipliers: { "llama-server": 1.3, "mlx-serve": 1.4, oMLX: 1.4, default: 1.3 },
  tiers: {
    p16: { workingMarginBytes: 4 * GB },
    p32: { workingMarginBytes: 8 * GB },
    p64: { workingMarginBytes: 12 * GB },
    p128: { workingMarginBytes: 20 * GB },
  },
} as const;

export type GovernorKind = "resident" | "jit" | "generator";
export type GovernorTier = keyof typeof GovernorRules.tiers;

export interface GovernorRequest {
  id: string;
  kind: GovernorKind;
  requestedBytes: number;
  modelFileBytes?: number | null;
  measuredPeakBytes?: number | null;
  engine?: string;
  pinned?: boolean;
  keepAliveSeconds?: number;
  pid?: number | null;
}

export interface GovernorHandle {
  id: string;
  kind: GovernorKind;
  requestedBytes: number;
}

export interface GovernorLoadedModel {
  id: string;
  kind: GovernorKind;
  peakBytes: number;
  measured: boolean;
  lastUsedAt: string;
  idleTtlSeconds: number;
  pinned: boolean;
  pid: number | null;
}

export interface GovernorStatus {
  capBytes: number;
  freeMemoryBytes: number;
  pressure: boolean;
  loaded: GovernorLoadedModel[];
  queue: Array<{ id: string; position: number; kind: GovernorKind }>;
}

interface LoadedInternal extends GovernorLoadedModel {
  peakBaselineBytes: number | null;
  processBreaches: number;
  keepAliveSeconds: number;
}

interface GovernorTuning {
  pollMs: number;
  idleTtlSeconds: number;
  queueMax: number;
  systemLowWaterPct: number;
  systemLowWaterFloorBytes: number;
  systemSustainedPolls: number;
  processSafetyMultiplier: number;
  processMinOverageBytes: number;
  processSustainedPolls: number;
  osMarginBytes: number;
}

let tuning: GovernorTuning = { ...GovernorRules, tiers: undefined as never, engineMultipliers: undefined as never } as unknown as GovernorTuning;
let activeTier: GovernorTier = "p16";
let totalMemoryBytes = os.totalmem();
let freeMemoryBytes = os.freemem();
let pressure = false;
let pressurePolls = 0;
const loaded = new Map<string, LoadedInternal>();
const queue: Array<GovernorRequest> = [];

function nowIso(): string {
  return new Date().toISOString();
}

function peakFor(request: GovernorRequest): { bytes: number; measured: boolean } {
  if (request.measuredPeakBytes && request.measuredPeakBytes > 0) return { bytes: request.measuredPeakBytes, measured: true };
  if (!request.modelFileBytes) return { bytes: request.requestedBytes, measured: false };
  const multiplier = GovernorRules.engineMultipliers[request.engine as keyof typeof GovernorRules.engineMultipliers] ?? GovernorRules.engineMultipliers.default;
  return { bytes: Math.ceil(request.modelFileBytes * multiplier), measured: false };
}

function loadedBytes(): number {
  return [...loaded.values()].reduce((sum, item) => sum + item.peakBytes, 0);
}

function workingMargin(): number {
  return GovernorRules.tiers[activeTier].workingMarginBytes;
}

function canAdmit(request: GovernorRequest, peakBytes: number): boolean {
  const generatorBusy = request.kind === "generator" && [...loaded.values()].some((item) => item.kind === "generator");
  if (generatorBusy) return false;
  const cap = Math.max(0, totalMemoryBytes - tuning.osMarginBytes);
  return loadedBytes() + peakBytes <= cap && freeMemoryBytes - peakBytes >= workingMargin();
}

export async function admit(request: GovernorRequest): Promise<GovernorHandle | { queued: true; position: number } | { refused: true; reason: string }> {
  const peak = peakFor(request);
  if (!canAdmit(request, peak.bytes)) {
    if (queue.length >= tuning.queueMax) return { refused: true, reason: "The governor queue is full." };
    const existing = queue.findIndex((item) => item.id === request.id);
    if (existing >= 0) return { queued: true, position: existing + 1 };
    queue.push(request);
    return { queued: true, position: queue.length };
  }
  const item: LoadedInternal = {
    id: request.id,
    kind: request.kind,
    peakBytes: peak.bytes,
    measured: peak.measured,
    lastUsedAt: nowIso(),
    idleTtlSeconds: tuning.idleTtlSeconds,
    pinned: request.pinned ?? false,
    pid: request.pid ?? null,
    peakBaselineBytes: request.measuredPeakBytes ?? null,
    processBreaches: 0,
    keepAliveSeconds: request.kind === "generator" ? 0 : request.keepAliveSeconds ?? 0,
  };
  loaded.set(request.id, item);
  return { id: request.id, kind: request.kind, requestedBytes: peak.bytes };
}

export function release(handle: GovernorHandle): void {
  loaded.delete(handle.id);
  const next = queue.shift();
  if (next) void admit(next);
}

export function queuePosition(id: string): number | null {
  const position = queue.findIndex((request) => request.id === id);
  return position < 0 ? null : position + 1;
}

export function getGovernorStatus(): GovernorStatus {
  return {
    capBytes: Math.max(0, totalMemoryBytes - tuning.osMarginBytes),
    freeMemoryBytes,
    pressure,
    loaded: [...loaded.values()].map(({ peakBaselineBytes: _baseline, processBreaches: _breaches, keepAliveSeconds: _keepAlive, ...item }) => item),
    queue: queue.map((request, index) => ({ id: request.id, position: index + 1, kind: request.kind })),
  };
}

export interface StartGovernorOptions {
  pid: number;
  pollMs?: number;
  kind?: GovernorKind;
  totalMemory?: () => number;
  freeMemory?: () => number;
  processMemory?: (pid: number) => Promise<number | null>;
  unload?: (id: string) => Promise<void> | void;
  restart?: (id: string) => Promise<void> | void;
  now?: () => number;
  tier?: GovernorTier;
}

export function startGovernor(options: StartGovernorOptions): () => void {
  activeTier = options.tier ?? activeTier;
  let stopped = false;
  let systemBreaches = 0;
  const timer = setInterval(() => void poll(), options.pollMs ?? tuning.pollMs);
  void poll();

  async function poll(): Promise<void> {
    if (stopped) return;
    totalMemoryBytes = options.totalMemory?.() ?? os.totalmem();
    freeMemoryBytes = options.freeMemory?.() ?? os.freemem();
    const floor = Math.max(totalMemoryBytes * tuning.systemLowWaterPct, tuning.systemLowWaterFloorBytes);
    const low = freeMemoryBytes < floor;
    systemBreaches = low ? systemBreaches + 1 : 0;
    pressurePolls = systemBreaches;
    pressure = systemBreaches >= tuning.systemSustainedPolls;
    if (pressure && systemBreaches === tuning.systemSustainedPolls) emit({ id: "pressure", data: { freeMemoryBytes, floorBytes: floor } });
    const processReader = options.processMemory ?? ((pid: number) => measureProcessMemoryBytes(pid));
    const now = options.now?.() ?? Date.now();
    for (const item of [...loaded.values()]) {
      if (item.pid === options.pid) {
        const measured = await processReader(options.pid);
        if (measured !== null && item.peakBaselineBytes !== null && measured > item.peakBaselineBytes * tuning.processSafetyMultiplier + tuning.processMinOverageBytes) {
          item.processBreaches++;
        } else item.processBreaches = 0;
        if (item.kind === "resident" && item.processBreaches >= tuning.processSustainedPolls) {
          emit({ id: "pressure", data: { reason: "resident RSS exceeded measured peak", id: item.id } });
          await options.restart?.(item.id);
          item.processBreaches = 0;
        }
      }
      const idleLimit = (item.idleTtlSeconds + item.keepAliveSeconds) * 1000;
      const idle = now - new Date(item.lastUsedAt).getTime() >= idleLimit;
      if (item.kind === "jit" && !item.pinned && (idle || pressure)) {
        await options.unload?.(item.id);
        loaded.delete(item.id);
      }
    }
  }

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export function __setGovernorTuningForTestsOnly(overrides: Partial<GovernorTuning> & { totalMemoryBytes?: number; freeMemoryBytes?: number; tier?: GovernorTier }): void {
  tuning = { ...tuning, ...overrides };
  if (overrides.totalMemoryBytes !== undefined) totalMemoryBytes = overrides.totalMemoryBytes;
  if (overrides.freeMemoryBytes !== undefined) freeMemoryBytes = overrides.freeMemoryBytes;
  if (overrides.tier) activeTier = overrides.tier;
}

export function __resetGovernorForTests(): void {
  loaded.clear();
  queue.length = 0;
  tuning = {
    pollMs: GovernorRules.pollMs,
    idleTtlSeconds: GovernorRules.idleTtlSeconds,
    queueMax: GovernorRules.queueMax,
    systemLowWaterPct: GovernorRules.systemLowWaterPct,
    systemLowWaterFloorBytes: GovernorRules.systemLowWaterFloorBytes,
    systemSustainedPolls: GovernorRules.systemSustainedPolls,
    processSafetyMultiplier: GovernorRules.processSafetyMultiplier,
    processMinOverageBytes: GovernorRules.processMinOverageBytes,
    processSustainedPolls: GovernorRules.processSustainedPolls,
    osMarginBytes: GovernorRules.osMarginBytes,
  };
  activeTier = "p16";
  totalMemoryBytes = os.totalmem();
  freeMemoryBytes = os.freemem();
  pressure = false;
  pressurePolls = 0;
}
