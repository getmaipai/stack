import { emit } from "@/lib/events";
import { getMemoryReader, type MemoryPressure, type MemoryReader } from "@/lib/memory";
import { raise, resolve as resolveHealth } from "@/lib/health";

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
export type RunState = "running" | "pausing" | "paused";

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
  totalMemoryBytes: number;
  capBytes: number;
  freeMemoryBytes: number;
  availablePercent: number;
  pressure: MemoryPressure;
  memoryReadingDegraded: boolean;
  loaded: GovernorLoadedModel[];
  queue: Array<{ id: string; position: number; kind: GovernorKind }>;
}

export interface GovernorDecision { at: string; decision: string; reason: string; model: string; }

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
let totalMemoryBytes = 0;
let freeMemoryBytes = 0;
let availablePercent = 0;
let pressure: MemoryPressure = "normal";
let pressurePolls = 0;
let memoryReadingDegraded = false;
let lastDegradedProbeError: string | null = null;
let runState: RunState = "running";
const loaded = new Map<string, LoadedInternal>();
type QueuedEntry = { request: GovernorRequest; settled: boolean; admitted: Promise<GovernorHandle | { refused: true; reason: string }>; resolve: (result: GovernorHandle | { refused: true; reason: string }) => void };
const queue: QueuedEntry[] = [];
const refusalCounts = new Map<string, number>();
const decisions: GovernorDecision[] = [];

const initialMemory = getMemoryReader().read();
totalMemoryBytes = initialMemory.totalBytes;
freeMemoryBytes = initialMemory.freeBytes;
availablePercent = initialMemory.availablePercent;
pressure = initialMemory.pressure;

function nowIso(): string {
  return new Date().toISOString();
}

function decide(decision: string, reason: string, model: string): void {
  decisions.unshift({ at: nowIso(), decision, reason, model });
  if (decisions.length > 200) decisions.length = 200;
}

export function defaultModelBudgetBytes(): number { return Math.max(0, totalMemoryBytes - GovernorRules.osMarginBytes); }
export function setGovernorMemorySettings(values: { modelBudgetBytes?: number; systemLowWaterPct?: number; systemLowWaterFloorBytes?: number; systemSustainedPolls?: number }): void {
  if (values.modelBudgetBytes !== undefined) tuning.osMarginBytes = Math.max(0, totalMemoryBytes - values.modelBudgetBytes);
  if (values.systemLowWaterPct !== undefined) tuning.systemLowWaterPct = values.systemLowWaterPct;
  if (values.systemLowWaterFloorBytes !== undefined) tuning.systemLowWaterFloorBytes = values.systemLowWaterFloorBytes;
  if (values.systemSustainedPolls !== undefined) tuning.systemSustainedPolls = values.systemSustainedPolls;
}
export function getGovernorDecisions(): GovernorDecision[] { return [...decisions]; }

function loadedItemFor(request: GovernorRequest): LoadedInternal {
  const peak = peakFor(request);
  return {
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
  if (memoryReadingDegraded) return false;
  if (pressure !== "normal") return false;
  const generatorBusy = request.kind === "generator" && [...loaded.values()].some((item) => item.kind === "generator");
  if (generatorBusy) return false;
  const cap = Math.max(0, totalMemoryBytes - tuning.osMarginBytes);
  return loadedBytes() + peakBytes <= cap && freeMemoryBytes - peakBytes >= workingMargin();
}

export async function admit(request: GovernorRequest): Promise<GovernorHandle | { queued: true; position: number; admitted: Promise<GovernorHandle | { refused: true; reason: string }> } | { refused: true; reason: string }> {
  if (runState !== "running") { decide("Refused", "The Stack is paused.", request.id); return { refused: true, reason: "The Stack is paused." }; }
  const peak = peakFor(request);
  if (memoryReadingDegraded) {
    decide("Refused", "The memory reading is unavailable.", request.id);
    return { refused: true, reason: "The memory reading is unavailable." };
  }
  if (!canAdmit(request, peak.bytes)) {
    const refusals = (refusalCounts.get(request.id) ?? 0) + 1;
    refusalCounts.set(request.id, refusals);
    if (refusals >= 3) raise({ code: "admission-refused-repeatedly", severity: "warning", title: "Work is waiting for memory", text: `The governor has deferred ${request.id} repeatedly.`, cause: "The current memory budget cannot admit the request.", fix: { label: "Free memory", action: "free_memory" } });
    if (queue.length >= tuning.queueMax) { decide("Refused", "The governor queue is full.", request.id); return { refused: true, reason: "The governor queue is full." }; }
    const existing = queue.findIndex((entry) => entry.request.id === request.id);
    if (existing >= 0) return { queued: true, position: existing + 1, admitted: queue[existing]!.admitted };
    let resolveQueued!: (result: GovernorHandle | { refused: true; reason: string }) => void;
    const admitted: Promise<GovernorHandle | { refused: true; reason: string }> = new Promise<GovernorHandle | { refused: true; reason: string }>((resolve) => { resolveQueued = resolve; });
    const entry: QueuedEntry = { request, settled: false, admitted, resolve: resolveQueued };
    queue.push(entry);
    decide("Queued", pressure !== "normal" ? `Memory pressure is ${pressure}.` : "The current memory budget cannot admit the request.", request.id);
    return { queued: true, position: queue.length, admitted };
  }
  refusalCounts.delete(request.id);
  resolveHealth("admission-refused-repeatedly");
  const item = loadedItemFor(request);
  loaded.set(request.id, item);
  decide("Admitted", "The current memory budget has room.", request.id);
  return { id: request.id, kind: request.kind, requestedBytes: peak.bytes };
}

/** A spawned process's pid is known only after admission; the resident
 * RSS watch needs it on the loaded item. */
export function setGovernorPid(id: string, pid: number | null): void {
  const item = loaded.get(id);
  if (item) item.pid = pid;
}

export function getRunState(): RunState { return runState; }

export function setRunState(next: RunState): void {
  runState = next;
}

export async function pauseAll(): Promise<void> {
  if (runState === "paused") return;
  setRunState("pausing");
  queue.length = 0;
  for (const item of [...loaded.values()]) loaded.delete(item.id);
  setRunState("paused");
}

export function resumeAll(): void { setRunState("running"); }

function settleAdmission(entry: QueuedEntry): void {
  const item = loadedItemFor(entry.request);
  loaded.set(entry.request.id, item);
  decide("Admitted", "The current memory budget has room.", entry.request.id);
  entry.settled = true;
  entry.resolve({ id: entry.request.id, kind: entry.request.kind, requestedBytes: item.peakBytes });
}

export function release(handle: GovernorHandle): void {
  loaded.delete(handle.id);
  const next = queue.shift();
  if (next && !next.settled) settleAdmission(next);
}

/** Removes a queued request before it is admitted and settles its
 * promise refused; the request behind it becomes the head. */
export function withdraw(requestId: string): void {
  const index = queue.findIndex((entry) => entry.request.id === requestId);
  if (index < 0) return;
  const entry = queue[index]!;
  queue.splice(index, 1);
  if (!entry.settled) {
    entry.settled = true;
    entry.resolve({ refused: true, reason: "Withdrawn." });
  }
}

export function queuePosition(id: string): number | null {
  const position = queue.findIndex((entry) => entry.request.id === id);
  return position < 0 ? null : position + 1;
}

export function getGovernorStatus(): GovernorStatus {
  return {
    totalMemoryBytes,
    capBytes: Math.max(0, totalMemoryBytes - tuning.osMarginBytes),
    freeMemoryBytes,
    availablePercent,
    pressure,
    memoryReadingDegraded,
    loaded: [...loaded.values()].map(({ peakBaselineBytes: _baseline, processBreaches: _breaches, keepAliveSeconds: _keepAlive, ...item }) => item),
    queue: queue.map((entry, index) => ({ id: entry.request.id, position: index + 1, kind: entry.request.kind })),
  };
}

export interface StartGovernorOptions {
  pid: number;
  pollMs?: number;
  kind?: GovernorKind;
  totalMemory?: () => number;
  freeMemory?: () => number;
  processMemory?: (pid: number) => Promise<number | null>;
  memoryReader?: MemoryReader;
  loadInFlight?: () => boolean;
  unload?: (id: string) => Promise<void> | void;
  restart?: (id: string) => Promise<void> | void;
  abort?: (id: string) => Promise<void> | void;
  now?: () => number;
  tier?: GovernorTier;
}

export function startGovernor(options: StartGovernorOptions): () => void {
  activeTier = options.tier ?? activeTier;
  let stopped = false;
  let systemBreaches = 0;
  const memoryReader = options.memoryReader ?? getMemoryReader();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (): void => {
    if (!stopped) timer = setTimeout(async () => { await poll(); schedule(); }, options.loadInFlight?.() ? 1_000 : options.pollMs ?? tuning.pollMs);
  };
  void poll();
  schedule();

  async function poll(): Promise<void> {
    if (stopped) return;
    const reading = memoryReader.read();
    const previousPressure = pressure;
    const previousFreeMemoryBytes = freeMemoryBytes;
    const previousTotalMemoryBytes = totalMemoryBytes;
    if (reading.degraded) {
      memoryReadingDegraded = true;
      lastDegradedProbeError = `The memory probe failed: ${(reading.probeError ?? "no detail was reported")}`;
      raise({ code: "memory-reading-unavailable", severity: "warning", title: "This computer's memory cannot be read right now", text: "The Stack keeps what is running but will not start anything new until the reading is back.", cause: lastDegradedProbeError, fix: { label: "Check again", action: "free_memory" } });
      return;
    }
    memoryReadingDegraded = false;
    lastDegradedProbeError = null;
    resolveHealth("memory-reading-unavailable");
    totalMemoryBytes = options.totalMemory?.() ?? reading.totalBytes;
    freeMemoryBytes = options.freeMemory?.() ?? reading.freeBytes;
    availablePercent = reading.availablePercent;
    const kernelPressure = reading.pressure;
    const floor = Math.max(totalMemoryBytes * tuning.systemLowWaterPct, tuning.systemLowWaterFloorBytes);
    const previousFloor = Math.max(previousTotalMemoryBytes * tuning.systemLowWaterPct, tuning.systemLowWaterFloorBytes);
    const low = freeMemoryBytes < floor;
    systemBreaches = low ? systemBreaches + 1 : 0;
    pressurePolls = systemBreaches;
    const arithmeticPressure: MemoryPressure = systemBreaches >= tuning.systemSustainedPolls ? "warn" : "normal";
    pressure = kernelPressure === "critical" ? "critical" : kernelPressure === "warn" || arithmeticPressure === "warn" ? "warn" : "normal";
    if (pressure === "critical") {
      raise({ code: "memory-pressure-critical", severity: "critical", title: "Memory pressure is critical", text: "The governor is stopping work to protect this computer.", cause: "The kernel reported critical memory pressure.", fix: { label: "Free memory", action: "free_memory" } });
      resolveHealth("memory-pressure-warn");
    } else if (pressure === "warn") {
      raise({ code: "memory-pressure-warn", severity: "warning", title: "Memory pressure is tight", text: "New work may wait while the Stack frees memory.", cause: "The kernel or the governor watermark is under pressure.", fix: { label: "Free memory", action: "free_memory" } });
      resolveHealth("memory-pressure-critical");
    } else {
      resolveHealth("memory-pressure-warn");
      resolveHealth("memory-pressure-critical");
    }
    if (pressure !== "normal" && (systemBreaches === tuning.systemSustainedPolls || kernelPressure !== "normal")) emit({ id: "pressure", data: { pressure, free_memory_bytes: Math.round(freeMemoryBytes), floor_bytes: Math.round(floor), available_percent: Math.max(0, Math.min(100, availablePercent)) } });
    const processReader = options.processMemory ?? ((pid: number) => Promise.resolve(memoryReader.processFootprint(pid)));
    const now = options.now?.() ?? Date.now();
    for (const item of [...loaded.values()]) {
      if (item.pid === options.pid) {
        const measured = await processReader(options.pid);
        if (measured !== null && item.peakBaselineBytes !== null && measured > item.peakBaselineBytes * tuning.processSafetyMultiplier + tuning.processMinOverageBytes) {
          item.processBreaches++;
        } else item.processBreaches = 0;
        if (item.kind === "resident" && item.processBreaches >= tuning.processSustainedPolls) {
          emit({ id: "pressure", data: { pressure, reason: "resident RSS exceeded measured peak", id: item.id } });
          await options.restart?.(item.id);
          item.processBreaches = 0;
        }
      }
      const idleLimit = (item.idleTtlSeconds + item.keepAliveSeconds) * 1000;
      const idle = now - new Date(item.lastUsedAt).getTime() >= idleLimit;
      if (item.kind === "generator" && pressure === "critical") {
        await options.abort?.(item.id);
        emit({ id: "pressure", data: { reason: "critical kernel memory pressure aborted a generator", id: item.id, pressure } });
      }
      if (item.kind === "jit" && !item.pinned && (idle || pressure !== "normal")) {
        await options.unload?.(item.id); decide("Unloaded", pressure !== "normal" ? `Memory pressure is ${pressure}.` : "The model was idle.", item.id);
        loaded.delete(item.id);
      }
    }
    if (memoryReadingDegraded) return;
    const pressureAdmitting = pressure === "normal" && previousPressure !== "normal";
    const floorAdmitting = previousFreeMemoryBytes < previousFloor && freeMemoryBytes >= floor;
    if ((pressureAdmitting || floorAdmitting) && queue.length > 0) {
      let index = 0;
      while (index < queue.length) {
        const entry = queue[index]!;
        if (entry.settled) {
          queue.splice(index, 1);
          continue;
        }
        if (!canAdmit(entry.request, peakFor(entry.request).bytes)) break;
        settleAdmission(entry);
        queue.splice(index, 1);
      }
    }
  }

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
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
  refusalCounts.clear();
  decisions.length = 0;
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
  const reading = getMemoryReader().read();
  totalMemoryBytes = reading.totalBytes;
  freeMemoryBytes = reading.freeBytes;
  availablePercent = reading.availablePercent;
  pressure = "normal";
  pressurePolls = 0;
  memoryReadingDegraded = false;
  lastDegradedProbeError = null;
  runState = "running";
}
