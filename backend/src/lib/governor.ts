import { emit, emitGovernorWindow } from "@/lib/events";
import { getMemoryReader, type MemoryPressure, type MemoryReader } from "@/lib/memory";
import { raise, resolve as resolveHealth } from "@/lib/health";
import { ROLES } from "@/roles";
import { tierCapBytes } from "@/lib/tiers";

const GB = 1_073_741_824;

export const GovernorRules = {
  pollMs: 5_000,
  queueMax: 4,
  idleTtlSeconds: 600,
  warmEvictionGraceMs: 2 * 60_000,
  systemLowWaterPct: 0.1,
  systemLowWaterFloorBytes: GB,
  systemSustainedPolls: 2,
  processSafetyMultiplier: 1.3,
  processMinOverageBytes: 500_000_000,
  processSustainedPolls: 3,
  /** A run's peak is written back to the store only when it rises by at
   * least this much, so a slowly filling cache is not a write per poll. */
  peakRecordStepBytes: 64 * 1_048_576,
  imagePoolPeakBytes: 29_000_000_000,
  osMarginBytes: 8 * GB,
  /** Rule Q8: only one picture may borrow this much of the working margin. */
  q8FlexBandBytes: 4 * GB,
  /** Rule Q8: free memory after a flex-band admission must stay above this floor. */
  q8FlexFloorBytes: 16 * GB,
  engineMultipliers: { "llama-server": 1.3, "mlx-serve": 1.4, oMLX: 1.4, default: 1.3 },
  tiers: {
    p16: { workingMarginBytes: 4 * GB },
    p32: { workingMarginBytes: 8 * GB },
    p64: { workingMarginBytes: 12 * GB },
    p128: { workingMarginBytes: 20 * GB },
  },
} as const;

export type GovernorKind = "resident" | "jit" | "generator";
export type GovernorClass = "reserved" | "warm" | "burst";
export type GovernorTier = keyof typeof GovernorRules.tiers;
export type JobTier = "standard" | "boost" | "max";
export type RunState = "running" | "pausing" | "paused";

export interface GovernorRequest {
  id: string;
  tier?: JobTier;
  kind: GovernorKind;
  class?: GovernorClass;
  role?: string;
  requestedBytes: number;
  modelFileBytes?: number | null;
  measuredPeakBytes?: number | null;
  dryRunPeakBytes?: number | null;
  headroomBytes?: number | null;
  engine?: string;
  pinned?: boolean;
  keepAliveSeconds?: number;
  pid?: number | null;
  /** A `jit` item that gives way to a generator job: while a generator waits for memory the item's unload is asked at once, and the supervisor's unload declines while the item serves a request (CODE-STACK-01 S2). */
  yieldsToGenerators?: boolean;
  /** Reuses the picture worker's single warm ledger entry between jobs. */
  retainWarm?: boolean;
  /** For an edit, reserve the two-model pool when it fits, otherwise use
   * the request's one-model peak. */
  poolPeakBytes?: number;
}

export interface GovernorHandle {
  id: string;
  tier?: JobTier;
  kind: GovernorKind;
  class?: GovernorClass;
  requestedBytes: number;
  token?: number;
  retainWarm?: boolean;
}

export interface GovernorLoadedModel {
  id: string;
  tier?: JobTier;
  kind: GovernorKind;
  class: GovernorClass;
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
  tier: GovernorTier;
  marginBytes: number;
  loaded: GovernorLoadedModel[];
  queue: Array<{ id: string; position: number; kind: GovernorKind; class: GovernorClass; tier?: JobTier }>;
}

export interface GovernorDecision { at: string; decision: string; reason: string; model: string; reasonCode?: "coding_mode" | "max_window"; }

interface LoadedInternal extends GovernorLoadedModel {
  /** Which admission this entry is: a release or an eviction removes
   * only its own entry, never a newer admission under the same id. */
  token: number;
  evicting: boolean;
  /** The runaway watch's baseline: this process's own reading after its
   * post-load check, plus headroom. Null until that reading exists; a
   * figure stored by an earlier run (another context, another definition)
   * never arms the watch. */
  peakBaselineBytes: number | null;
  /** The largest healthy reading of this run, and the last one written
   * back through `onPeak`. */
  runPeakBytes: number;
  recordedPeakBytes: number;
  headroomBytes: number;
  processBreaches: number;
  keepAliveSeconds: number;
  yieldsToGenerators: boolean;
  role: string | null;
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
  peakRecordStepBytes: number;
  osMarginBytes: number;
}

let tuning: GovernorTuning = { ...GovernorRules, tiers: undefined as never, engineMultipliers: undefined as never } as unknown as GovernorTuning;
let activeTier: GovernorTier = "p16";
let totalMemoryBytes = 0;
let metalCapBytes: number | null = null;
let freeMemoryBytes = 0;
let availablePercent = 0;
let pressure: MemoryPressure = "normal";
let pressurePolls = 0;
let memoryReadingDegraded = false;
let lastDegradedProbeError: string | null = null;
let runState: RunState = "running";
/** An item's own idle limit in seconds, in place of the governor-wide one: the coding engine's keep-warm setting (CODE-STACK-01 S2). */
const idleTtlOverrides = new Map<string, number>();
const loaded = new Map<string, LoadedInternal>();
type QueuedEntry = { request: GovernorRequest; settled: boolean; admitted: Promise<GovernorHandle | { refused: true; reason: string }>; resolve: (result: GovernorHandle | { refused: true; reason: string }) => void };
const queue: QueuedEntry[] = [];
const refusalCounts = new Map<string, number>();
const decisions: GovernorDecision[] = [];
type ReclaimStep = { at: number; step: "pool_idle_wait" | "evict_pool" | "evict_idle" | "window_drain"; itemId: string; bytes: number };
const reclaimSteps = new Map<string, ReclaimStep[]>();
let maxWindow: { state: "none" | "draining" | "open"; ownerId: string | null; since: number | null } = { state: "none", ownerId: null, since: null };
export function getMaxWindow(): typeof maxWindow { return { ...maxWindow }; }
export function getReclaimSteps(requestId: string): ReclaimStep[] { return [...(reclaimSteps.get(requestId) ?? [])]; }
function reclaim(requestId: string, step: ReclaimStep["step"], itemId: string, bytes: number, at = Date.now()): void { const rows = reclaimSteps.get(requestId) ?? []; if (rows.at(-1)?.step === step && rows.at(-1)?.itemId === itemId) return; rows.push({ at, step, itemId, bytes }); reclaimSteps.set(requestId, rows); }
function windowEvent(data: { state: "open" | "closed"; owner: string | null; tier: "max" }): void { emitGovernorWindow(data); }
function closeMaxWindow(): void { if (maxWindow.state === "none") return; maxWindow = { state: "none", ownerId: null, since: null }; windowEvent({ state: "closed", owner: null, tier: "max" }); }
let imagePoolUnload: (() => boolean | Promise<boolean>) | null = null;

/** The image worker is managed by its service, not the role supervisor.
 * Its stable warm item still uses the governor's normal eviction path. */
export function setImagePoolUnload(unload: (() => boolean | Promise<boolean>) | null): void { imagePoolUnload = unload; }

const initialMemory = getMemoryReader().read();
totalMemoryBytes = initialMemory.totalBytes;
freeMemoryBytes = initialMemory.freeBytes;
availablePercent = initialMemory.availablePercent;
pressure = initialMemory.pressure;

function nowIso(): string {
  return new Date().toISOString();
}

let codingModeActive = false;
export function setCodingModeActive(active: boolean): void { codingModeActive = active; }
/** True while the large coding mode holds picture, video and music work back. */
export function generatorsHeldByMode(): boolean { return codingModeActive; }

function decide(decision: string, reason: string, model: string, reasonCode?: "coding_mode" | "max_window"): void {
  decisions.unshift({ at: nowIso(), decision, reason, model, ...(reasonCode ? { reasonCode } : {}) });
  if (decisions.length > 200) decisions.length = 200;
}

function requestClass(request: GovernorRequest): GovernorClass {
  return request.class ?? ROLES[request.role as keyof typeof ROLES]?.memoryClass ?? ROLES[request.id as keyof typeof ROLES]?.memoryClass ?? (request.kind === "resident" ? "reserved" : request.kind === "jit" ? "warm" : "burst");
}

function taggedRequest(request: GovernorRequest): GovernorRequest {
  return { ...request, class: requestClass(request) };
}

export function setMetalCapBytes(bytes: number | null): void { metalCapBytes = bytes; }
function effectiveCapBytes(): number {
  const osCap = Math.max(0, totalMemoryBytes - tuning.osMarginBytes);
  return metalCapBytes === null ? osCap : Math.min(osCap, metalCapBytes);
}
export function defaultModelBudgetBytes(): number { return Math.min(Math.max(0, totalMemoryBytes - GovernorRules.osMarginBytes), metalCapBytes ?? Number.POSITIVE_INFINITY); }
export function setGovernorMemorySettings(values: { modelBudgetBytes?: number; systemLowWaterPct?: number; systemLowWaterFloorBytes?: number; systemSustainedPolls?: number }): void {
  if (values.modelBudgetBytes !== undefined) tuning.osMarginBytes = Math.max(0, totalMemoryBytes - values.modelBudgetBytes);
  if (values.systemLowWaterPct !== undefined) tuning.systemLowWaterPct = values.systemLowWaterPct;
  if (values.systemLowWaterFloorBytes !== undefined) tuning.systemLowWaterFloorBytes = values.systemLowWaterFloorBytes;
  if (values.systemSustainedPolls !== undefined) tuning.systemSustainedPolls = values.systemSustainedPolls;
}
export function getGovernorDecisions(): GovernorDecision[] { return [...decisions]; }

let nextToken = 1;
let flexBandBorrowerToken: number | null = null;
function loadedItemFor(request: GovernorRequest): LoadedInternal {
  const peak = peakFor(request);
  return {
    token: nextToken++,
    evicting: false,
    id: request.id,
    ...(request.tier ? { tier: request.tier } : {}),
    kind: request.kind,
    class: requestClass(request),
    peakBytes: peak.bytes,
    measured: peak.measured,
    lastUsedAt: nowIso(),
    idleTtlSeconds: idleTtlOverrides.get(request.id) ?? tuning.idleTtlSeconds,
    pinned: request.pinned ?? false,
    pid: request.pid ?? null,
    peakBaselineBytes: null,
    runPeakBytes: 0,
    recordedPeakBytes: 0,
    headroomBytes: request.headroomBytes ?? 0,
    processBreaches: 0,
    keepAliveSeconds: request.kind === "generator" ? 0 : request.keepAliveSeconds ?? 0,
    yieldsToGenerators: request.kind === "jit" && request.yieldsToGenerators === true,
    role: request.role ?? null,
  };
}

/** Sets (or, with null, clears) one item's own idle limit. The item is evicted exactly `seconds` after its last touch (the poll checks every `pollMs`), counted from the last request's end. It applies to the item already loaded and to the next admission. */
export function setIdleTtlSeconds(id: string, seconds: number | null): void {
  if (seconds === null) idleTtlOverrides.delete(id); else idleTtlOverrides.set(id, Math.max(1, Math.floor(seconds)));
  const item = loaded.get(id);
  if (item) item.idleTtlSeconds = idleTtlOverrides.get(id) ?? tuning.idleTtlSeconds;
}

/** What a new admission could use right now without evicting anything: the model budget less what is loaded, and the free memory less the tier's working margin; whichever is smaller. */
export function admissionRoomBytes(): number {
  return Math.max(0, Math.min(effectiveCapBytes() - loadedBytes(), freeMemoryBytes - workingMargin()));
}

/** Whether a request fits with every non-reserved item removed. */
export function fitsEver(request: GovernorRequest): boolean {
  const peakBytes = peakFor(request).bytes;
  const reservedBytes = [...loaded.values()].filter((item) => item.class === "reserved").reduce((sum, item) => sum + item.peakBytes, 0);
  const modelRoom = Math.max(0, effectiveCapBytes() - reservedBytes);
  const workingRoom = Math.max(0, totalMemoryBytes - reservedBytes - workingMargin());
  return peakBytes <= modelRoom && peakBytes <= workingRoom;
}

export function tierRoomBytes(): number {
  const reservedBytes = [...loaded.values()].filter((item) => item.class === "reserved").reduce((sum, item) => sum + item.peakBytes, 0);
  return Math.max(0, Math.min(effectiveCapBytes() - reservedBytes, totalMemoryBytes - reservedBytes - workingMargin()));
}
export function fitsEverForTier(request: GovernorRequest, opts: { reducedFreedBytes?: number } = {}): { fits: boolean; capBytes: number; peakBytes: number } {
  const peakBytes = peakFor(request).bytes;
  if (!request.tier) return { fits: fitsEver(request), capBytes: tierRoomBytes(), peakBytes };
  const capBytes = tierCapBytes(request.tier, tierRoomBytes(), opts.reducedFreedBytes);
  return { fits: peakBytes <= capBytes, capBytes, peakBytes };
}
export function neverFitTierReason(request: GovernorRequest, capBytes: number, peakBytes = peakFor(request).bytes): string {
  const tier = request.tier![0]!.toUpperCase() + request.tier!.slice(1);
  return `This ${tier} job needs about ${(peakBytes / GB).toFixed(0)} GB and ${tier} on this computer holds ${(capBytes / GB).toFixed(0)} GB. Use Standard, or ask an admin about Max.`;
}

export function neverFitReason(request: GovernorRequest): string {
  const peak = peakFor(request).bytes;
  const reservedBytes = [...loaded.values()].filter((item) => item.class === "reserved").reduce((sum, item) => sum + item.peakBytes, 0);
  const afterChat = Math.max(0, Math.min(effectiveCapBytes() - reservedBytes, totalMemoryBytes - reservedBytes - workingMargin()));
  const role = request.role ?? request.id;
  const label = role === "image" ? "picture" : ROLES[role as keyof typeof ROLES]?.label.toLowerCase() ?? "request";
  const needs = (peak / GB).toFixed(1);
  const available = (afterChat / GB).toFixed(1);
  if (role === "video") return `This video needs about ${needs} GB of memory and this computer has ${available} GB for pictures and videos after chat. Try a shorter clip, or ask an admin to turn video off for this computer.`;
  if (role === "image") return `This picture needs about ${needs} GB of memory and this computer has ${available} GB for pictures and videos after chat. Try a smaller picture, or ask an admin to choose a smaller picture model.`;
  return `This ${label} needs about ${needs} GB of memory and this computer has ${available} GB for jobs after chat. Try a smaller ${label} or ask an admin to turn it off for this computer.`;
}

export interface EvictionRoom {
  roomBytes: number;
  evictionOrder: string[];
  capBytes?: number;
  fitsCap?: boolean;
}

const classRank: Record<GovernorClass, number> = { reserved: 0, warm: 1, burst: 2 };
/** The memory note's 4.3 order inside a class: finished burst workers first, then warm items from cheapest to dearest to reload. */
const evictionRank = (item: LoadedInternal): number => {
  if (item.class === "burst") return item.id.includes("tool") ? 1 : 0;
  if (item.id.includes("vision")) return 1;
  if (item.id.includes("edit")) return 2;
  if (item.id.includes("coding")) return 3;
  return 4;
};

const byEvictionOrder = (a: LoadedInternal, b: LoadedInternal): number => classRank[b.class] - classRank[a.class] || evictionRank(a) - evictionRank(b) || new Date(a.lastUsedAt).getTime() - new Date(b.lastUsedAt).getTime();

/** Room a request could use after eligible idle items are unloaded. */
export function roomAfterEviction(request: GovernorRequest, busy: (id: string) => boolean = () => false, now = Date.now()): EvictionRoom {
  const targetClass = requestClass(request);
  const candidates = [...loaded.values()].filter((item) => {
    if (item.class === "reserved" || item.pinned || item.evicting || item.kind === "generator" || busy(item.id)) return false;
    const warmGracePassed = item.class === "warm" && now - new Date(item.lastUsedAt).getTime() >= GovernorRules.warmEvictionGraceMs;
    if (classRank[item.class] < classRank[targetClass] && !warmGracePassed) return false;
    if (item.class === "warm" && !warmGracePassed) return false;
    return true;
  }).sort(byEvictionOrder);
  let roomBytes = admissionRoomBytes();
  const evictionOrder: string[] = [];
  for (const item of candidates) {
    evictionOrder.push(item.id);
    roomBytes += item.peakBytes;
  }
  return { roomBytes, evictionOrder };
}
export function roomAfterEvictionForTier(request: GovernorRequest, busy: (id: string) => boolean = () => false, now = Date.now()): EvictionRoom {
  const room = roomAfterEviction(request, busy, now);
  const fit = fitsEverForTier(request);
  return { ...room, capBytes: fit.capBytes, fitsCap: room.roomBytes >= fit.peakBytes && fit.peakBytes <= fit.capBytes };
}

export interface ReclaimItem { id: string; kind: GovernorClass; bytes: number }
/** MEM-SPACE-03: the idle items the Stack owns that an unload could free right now, in eviction order. Reserved items (chat), pinned items, items already leaving, generators and busy items are never listed; a warm item is listed only once idle past the 2 minute grace, and the bytes still inside it are reported apart. Ids and byte counts only. */
export function reclaimableItems(busy: (id: string) => boolean = () => false, now = Date.now()): { items: ReclaimItem[]; heldForGraceBytes: number } {
  let heldForGraceBytes = 0;
  const eligible = [...loaded.values()].filter((item) => {
    // Only what an unload can actually stop: jit roles and the picture worker, the same set the poll evicts.
    if (!(item.kind === "jit" || item.id === "image-pool")) return false;
    if (item.class === "reserved" || item.pinned || item.evicting || item.kind === "generator" || busy(item.id)) return false;
    if (item.class === "warm" && now - new Date(item.lastUsedAt).getTime() < GovernorRules.warmEvictionGraceMs) { heldForGraceBytes += item.peakBytes; return false; }
    return true;
  }).sort(byEvictionOrder);
  return { items: eligible.map((item) => ({ id: item.id, kind: item.class, bytes: item.peakBytes })), heldForGraceBytes };
}
/** Marks an item as leaving so the poll and admission leave it alone while a caller unloads it; false when it is gone or already leaving. */
export function beginEvicting(id: string): boolean { const item = loaded.get(id); if (!item || item.evicting) return false; item.evicting = true; return true; }
/** Clears the leaving mark after an unload that did not happen. */
export function cancelEvicting(id: string): void { const item = loaded.get(id); if (item) item.evicting = false; }
/** Unloads the image worker through its service; false when none is registered or it declined (busy). */
export async function unloadImagePool(): Promise<boolean> { return imagePoolUnload ? Boolean(await imagePoolUnload()) : false; }

export function peakFor(request: GovernorRequest): { bytes: number; measured: boolean } {
  let base: number;
  let measured = false;
  if (request.measuredPeakBytes && request.measuredPeakBytes > 0) { base = request.measuredPeakBytes; measured = true; }
  else if (request.dryRunPeakBytes && request.dryRunPeakBytes > 0) base = request.dryRunPeakBytes;
  else if (!request.modelFileBytes) base = request.requestedBytes;
  else {
    const multiplier = GovernorRules.engineMultipliers[request.engine as keyof typeof GovernorRules.engineMultipliers] ?? GovernorRules.engineMultipliers.default;
    base = Math.ceil(request.modelFileBytes * multiplier);
  }
  return { bytes: base + (request.headroomBytes ?? 0), measured };
}

/** Replace a provisional admission peak with the process memory
 * measured after this exact process passed its post-load check; that
 * reading is also the runaway watch's baseline for this run. */
export function refreshMeasuredPeak(handle: GovernorHandle, processBytes: number): void {
  if (!Number.isFinite(processBytes) || processBytes <= 0) return;
  const item = loaded.get(handle.id);
  if (!item || (handle.token !== undefined && item.token !== handle.token)) return;
  const bytes = Math.ceil(processBytes);
  item.peakBytes = bytes;
  item.measured = true;
  item.peakBaselineBytes = bytes + item.headroomBytes;
  item.runPeakBytes = bytes;
  item.recordedPeakBytes = bytes;
}

/** Records the image worker's measured live pool peak under its stable
 * ledger id. The image job owns the handle, while the resident pool keeps
 * that same governor item after the handle is released. */
export function refreshMeasuredPeakById(id: string, processBytes: number): void {
  const item = loaded.get(id);
  if (!item || !Number.isFinite(processBytes) || processBytes <= 0) return;
  const bytes = Math.ceil(processBytes);
  item.peakBytes = bytes;
  item.measured = true;
  item.peakBaselineBytes = null;
  item.runPeakBytes = 0;
  item.recordedPeakBytes = bytes;
}

/** A managed worker exited, so its warm reservation is no longer resident. */
export function forgetLoadedItem(id: string): void {
  const item = loaded.get(id);
  if (!item) return;
  loaded.delete(id);
  freeMemoryBytes += item.peakBytes;
}

function loadedBytes(): number {
  return [...loaded.values()].reduce((sum, item) => sum + item.peakBytes, 0);
}

function workingMargin(): number {
  return GovernorRules.tiers[activeTier].workingMarginBytes;
}

function usesFlexBand(request: GovernorRequest, peakBytes: number): boolean {
  const freeAfterAdmission = freeMemoryBytes - peakBytes;
  return request.role === "image"
    && requestClass(request) === "warm"
    && pressure === "normal"
    && flexBandBorrowerToken === null
    && freeAfterAdmission < workingMargin()
    && workingMargin() - freeAfterAdmission <= GovernorRules.q8FlexBandBytes
    && freeAfterAdmission >= GovernorRules.q8FlexFloorBytes
    && loadedBytes() + peakBytes <= effectiveCapBytes();
}

/** The memory watchdog's say on a start, from the whole machine's real
 * numbers (lib/memoryWatchdog.ts). One hook, so every generative start
 * (picture, clip, image tools, voice engine) asks it the same way. */
export type AdmissionGate = (request: GovernorRequest, peakBytes: number) => { ok: true } | { ok: false; reason: string };
let admissionGate: AdmissionGate | null = null;
export function setAdmissionGate(gate: AdmissionGate | null): void { admissionGate = gate; }
export function gateVerdict(request: GovernorRequest, peakBytes: number): { ok: true } | { ok: false; reason: string } { return admissionGate ? admissionGate(request, peakBytes) : { ok: true }; }

function canAdmit(request: GovernorRequest, peakBytes: number): boolean {
  if (maxWindow.state !== "none" && request.id !== maxWindow.ownerId && requestClass(request) !== "reserved") return false;
  if (codingModeActive && request.kind === "generator") return false;
  if (memoryReadingDegraded) return false;
  if (request.tier && peakBytes > tierCapBytes(request.tier, tierRoomBytes())) return false;
  if (!gateVerdict(request, peakBytes).ok) return false;
  if (pressure !== "normal") return false;
  const existing = loaded.get(request.id);
  const generatorBusy = request.kind === "generator" && [...loaded.values()].some((item) => item.kind === "generator" && item !== existing);
  if (generatorBusy) return false;
  if ((request.tier === "boost" || request.tier === "max") && [...loaded.values()].some((item) => item !== existing && (item.tier === "boost" || item.tier === "max"))) return false;
  const cap = effectiveCapBytes();
  const growth = Math.max(0, peakBytes - (existing?.peakBytes ?? 0));
  if (loadedBytes() + growth > cap) return false;
  return freeMemoryBytes - growth >= workingMargin() || usesFlexBand(request, growth);
}

/** Whether the request would be admitted if `freedBytes` of loaded jit memory were gone. The memory watchdog's gate is not asked: it reads real memory, which the item to be evicted still holds. */
function wouldAdmitAfterFreeing(request: GovernorRequest, peakBytes: number, freedBytes: number): boolean {
  if (memoryReadingDegraded || pressure !== "normal") return false;
  if (request.kind === "generator" && [...loaded.values()].some((item) => item.kind === "generator")) return false;
  return loadedBytes() - freedBytes + peakBytes <= effectiveCapBytes() && freeMemoryBytes + freedBytes - peakBytes >= workingMargin();
}

export async function admit(request: GovernorRequest): Promise<GovernorHandle | { queued: true; position: number; class: GovernorClass; admitted: Promise<GovernorHandle | { refused: true; reason: string }> } | { refused: true; reason: string }> {
  request = taggedRequest(request);
  if (runState !== "running") { decide("Refused", "The Stack is paused.", request.id); return { refused: true, reason: "The Stack is paused." }; }
  if (request.poolPeakBytes && request.poolPeakBytes > request.requestedBytes) {
    const pooledRequest: GovernorRequest = { ...request, requestedBytes: request.poolPeakBytes, measuredPeakBytes: null, dryRunPeakBytes: null, modelFileBytes: null, poolPeakBytes: undefined };
    const pooledPeak = peakFor(pooledRequest).bytes;
    if (fitsEver(pooledRequest) && canAdmit(pooledRequest, pooledPeak)) request = pooledRequest;
    else request = { ...request, poolPeakBytes: undefined };
  }
  const peak = peakFor(request);
  const tierFit = fitsEverForTier(request);
  if (!tierFit.fits) {
    const reason = request.tier ? neverFitTierReason(request, tierFit.capBytes, tierFit.peakBytes) : neverFitReason(request);
    decide("Refused", reason, request.id);
    return { refused: true, reason };
  }
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
    if (existing >= 0) return { queued: true, position: existing + 1, class: requestClass(request), admitted: queue[existing]!.admitted };
    let resolveQueued!: (result: GovernorHandle | { refused: true; reason: string }) => void;
    const admitted: Promise<GovernorHandle | { refused: true; reason: string }> = new Promise<GovernorHandle | { refused: true; reason: string }>((resolve) => { resolveQueued = resolve; });
    const entry: QueuedEntry = { request, settled: false, admitted, resolve: resolveQueued };
    if (request.tier === "max" && maxWindow.state === "none") {
      maxWindow = { state: "draining", ownerId: request.id, since: Date.now() };
      reclaim(request.id, "window_drain", "", 0);
    }
    queue.push(entry);
    const gated = gateVerdict(request, peak.bytes);
    const heldByMode = codingModeActive && request.kind === "generator";
    const heldByWindow = maxWindow.state !== "none" && request.id !== maxWindow.ownerId && requestClass(request) !== "reserved";
    decide("Queued", heldByWindow ? "A Max job is waiting for the computer. This one starts after it." : heldByMode ? "The large coding mode is holding picture, video and music work." : !gated.ok ? gated.reason : pressure !== "normal" ? `Memory pressure is ${pressure}.` : "The current memory budget cannot admit the request.", request.id, heldByWindow ? "max_window" : heldByMode ? "coding_mode" : undefined);
    return { queued: true, position: queue.length, class: requestClass(request), admitted };
  }
  refusalCounts.delete(request.id);
  resolveHealth("admission-refused-repeatedly");
  const borrowsFlexBand = usesFlexBand(request, peak.bytes);
  const existing = loaded.get(request.id);
  if (existing) {
    existing.kind = request.kind;
    existing.class = requestClass(request);
    existing.tier = request.tier;
    existing.peakBytes = peak.bytes;
    existing.measured = peak.measured;
    existing.lastUsedAt = nowIso();
    existing.evicting = false;
    existing.token = nextToken++;
    existing.keepAliveSeconds = 0;
    existing.yieldsToGenerators = false;
    const handle: GovernorHandle = { id: request.id, kind: request.kind, class: requestClass(request), requestedBytes: peak.bytes, token: existing.token, retainWarm: request.retainWarm, ...(request.tier ? { tier: request.tier } : {}) };
    decide("Admitted", "The current memory budget has room.", request.id);
    if (request.tier === "max") { maxWindow = { state: "open", ownerId: request.id, since: Date.now() }; windowEvent({ state: "open", owner: request.id, tier: "max" }); }
    if (borrowsFlexBand) flexBandBorrowerToken = existing.token;
    return handle;
  }
  const item = loadedItemFor(request);
  loaded.set(request.id, item);
  if (borrowsFlexBand) flexBandBorrowerToken = item.token;
  decide("Admitted", "The current memory budget has room.", request.id);
  if (request.tier === "max") { maxWindow = { state: "open", ownerId: request.id, since: Date.now() }; windowEvent({ state: "open", owner: request.id, tier: "max" }); }
  return { id: request.id, kind: request.kind, class: requestClass(request), requestedBytes: peak.bytes, token: item.token, retainWarm: request.retainWarm, ...(request.tier ? { tier: request.tier } : {}) };
}

/** A request on a loaded item: its idle clock starts again. */
export function touch(id: string): void {
  const item = loaded.get(id);
  if (item) item.lastUsedAt = nowIso();
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
  closeMaxWindow();
  queue.length = 0;
  for (const item of [...loaded.values()]) loaded.delete(item.id);
  setRunState("paused");
}

export function resumeAll(): void { setRunState("running"); }

function settleAdmission(entry: QueuedEntry): void {
  if (entry.request.tier === "max") { maxWindow = { state: "open", ownerId: entry.request.id, since: Date.now() }; windowEvent({ state: "open", owner: entry.request.id, tier: "max" }); }
  const borrowsFlexBand = usesFlexBand(entry.request, peakFor(entry.request).bytes);
  const existing = loaded.get(entry.request.id);
  if (existing) {
    existing.kind = entry.request.kind;
    existing.class = requestClass(entry.request);
    existing.tier = entry.request.tier;
    existing.peakBytes = peakFor(entry.request).bytes;
    existing.measured = peakFor(entry.request).measured;
    existing.lastUsedAt = nowIso();
    existing.evicting = false;
    existing.token = nextToken++;
    const handle: GovernorHandle = { id: entry.request.id, kind: entry.request.kind, class: requestClass(entry.request), requestedBytes: existing.peakBytes, token: existing.token, retainWarm: entry.request.retainWarm, ...(entry.request.tier ? { tier: entry.request.tier } : {}) };
    decide("Admitted", "The current memory budget has room.", entry.request.id);
    if (borrowsFlexBand) flexBandBorrowerToken = existing.token;
    entry.settled = true;
    entry.resolve(handle);
    return;
  }
  const item = loadedItemFor(entry.request);
  loaded.set(entry.request.id, item);
  if (borrowsFlexBand) flexBandBorrowerToken = item.token;
  decide("Admitted", "The current memory budget has room.", entry.request.id);
  entry.settled = true;
  entry.resolve({ id: entry.request.id, kind: entry.request.kind, class: requestClass(entry.request), requestedBytes: item.peakBytes, token: item.token, retainWarm: entry.request.retainWarm, ...(entry.request.tier ? { tier: entry.request.tier } : {}) });
}

export function release(handle: GovernorHandle): void {
  const item = loaded.get(handle.id);
  // An older admission's handle frees nothing, so it admits nothing.
  if (!item || (handle.token !== undefined && item.token !== handle.token)) return;
  reclaimSteps.delete(handle.id);
  if (maxWindow.ownerId === handle.id) closeMaxWindow();
  if (handle.retainWarm) {
    delete item.tier;
    item.kind = "jit";
    item.class = "warm";
    item.idleTtlSeconds = idleTtlOverrides.get(item.id) ?? tuning.idleTtlSeconds;
    item.lastUsedAt = nowIso();
    item.pid = null;
    item.peakBaselineBytes = null;
    item.runPeakBytes = 0;
    item.recordedPeakBytes = 0;
    item.processBreaches = 0;
    item.keepAliveSeconds = 0;
    return;
  }
  loaded.delete(handle.id);
  if (item.token === flexBandBorrowerToken) flexBandBorrowerToken = null;
  if (memoryReadingDegraded) return;
  while (queue.length > 0) {
    const next = queue[0]!;
    if (next.settled) { queue.shift(); continue; }
    if (!canAdmit(next.request, peakFor(next.request).bytes)) break;
    queue.shift();
    settleAdmission(next);
  }
}

/** Removes a queued request before it is admitted and settles its
 * promise refused; the request behind it becomes the head. */
export function withdraw(requestId: string): void {
  const index = queue.findIndex((entry) => entry.request.id === requestId);
  if (index < 0) return;
  const entry = queue[index]!;
  queue.splice(index, 1);
  reclaimSteps.delete(requestId);
  if (maxWindow.ownerId === requestId && maxWindow.state === "draining") closeMaxWindow();
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
    capBytes: effectiveCapBytes(),
    freeMemoryBytes,
    availablePercent,
    pressure,
    memoryReadingDegraded,
    tier: activeTier,
    marginBytes: workingMargin(),
    loaded: [...loaded.values()].map(({ peakBaselineBytes: _baseline, runPeakBytes: _runPeak, recordedPeakBytes: _recorded, processBreaches: _breaches, keepAliveSeconds: _keepAlive, token: _token, evicting: _evicting, ...item }) => item),
    queue: queue.map((entry, index) => ({ id: entry.request.id, position: index + 1, kind: entry.request.kind, class: requestClass(entry.request), ...(entry.request.tier ? { tier: entry.request.tier } : {}) })),
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
  /** Evicts a jit item; resolves false when nothing was unloaded (the
   * item stays counted and may be evicted on a later poll). */
  unload?: (id: string) => Promise<boolean | void> | boolean | void;
  restart?: (id: string) => Promise<void> | void;
  /** True while the process serves a request: a runaway restart waits
   * for it to finish unless the kernel reports critical pressure. */
  busy?: (id: string) => boolean;
  /** This run's peak rose (a healthy reading above the last one written
   * back, by at least `peakRecordStepBytes`): the caller stores it, so
   * the next admission starts from the latest run, not the first. */
  onPeak?: (id: string, processBytes: number) => void;
  abort?: (id: string) => Promise<void> | void;
  /** A video job is held for memory and nothing lighter freed enough: the
   * caller restarts idle chat at a smaller window. Resolves false when
   * chat is busy (asked again next poll). */
  shrinkChat?: () => Promise<boolean>;
  /** No video job is waiting or running: put chat's full window back. */
  restoreChat?: () => Promise<boolean>;
  chatWindowShrunk?: () => boolean;
  now?: () => number;
  tier?: GovernorTier;
}

let chatYieldBusy = false;

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
    const processReader = options.processMemory ?? ((pid: number) => Promise.resolve(memoryReader.processMemoryBytes(pid)));
    const now = options.now?.() ?? Date.now();
    const unloadItem = options.unload ?? (imagePoolUnload ? (id: string) => {
      if (id !== "image-pool") return false;
      return imagePoolUnload ? imagePoolUnload() : false;
    } : undefined);
    for (const item of [...loaded.values()]) {
      // The runaway watch compares this process's memory with its own
      // post-load reading (never a figure an earlier run stored), so a
      // healthy engine is never restarted for using what it used at load.
      if (item.pid === options.pid && item.peakBaselineBytes !== null) {
        const measured = await processReader(options.pid);
        const limit = item.peakBaselineBytes * tuning.processSafetyMultiplier + tuning.processMinOverageBytes;
        if (measured !== null && measured > limit) {
          item.processBreaches++;
        } else {
          item.processBreaches = 0;
          if (measured !== null && measured > item.runPeakBytes) {
            item.runPeakBytes = measured;
            item.peakBytes = Math.max(item.peakBytes, measured);
          }
          if (item.runPeakBytes - item.recordedPeakBytes >= tuning.peakRecordStepBytes) {
            // A failed write (a locked store) must not stop this watch;
            // the peak counts as stored only once the write returned, so
            // the next healthy poll tries again.
            try { options.onPeak?.(item.id, item.runPeakBytes); item.recordedPeakBytes = item.runPeakBytes; } catch { /* retried on the next poll */ }
          }
        }
        const busy = options.busy?.(item.id) ?? false;
        if (item.kind === "resident" && item.processBreaches >= tuning.processSustainedPolls && (!busy || pressure === "critical")) {
          emit({ id: "pressure", data: { pressure, reason: "process memory exceeded its measured peak", id: item.id, process_bytes: measured, limit_bytes: Math.round(limit) } });
          await options.restart?.(item.id);
          item.processBreaches = 0;
        }
      }
      const idleLimit = ((idleTtlOverrides.get(item.id) ?? item.idleTtlSeconds) + item.keepAliveSeconds) * 1000;
      const idle = now - new Date(item.lastUsedAt).getTime() >= idleLimit;
      if (item.kind === "generator" && pressure === "critical") {
        if (maxWindow.ownerId === item.id) { closeMaxWindow(); decide("Released", "The Max job stopped because memory pressure became critical.", item.id, "max_window"); }
        await options.abort?.(item.id);
        emit({ id: "pressure", data: { reason: "critical kernel memory pressure aborted a generator", id: item.id, pressure } });
      }
      // Only a watch that can unload evicts: forgetting a jit item whose
      // process still runs would hide its memory from every admission.
      if ((item.kind === "jit" || (item.id === "image-pool" && item.kind !== "generator")) && item.class !== "reserved" && unloadItem && !options.busy?.(item.id) && !item.evicting && !item.pinned && (idle || pressure !== "normal")) {
        // Not awaited: an unload drains requests in flight, and this poll
        // (another process's RSS watch among them) never waits on it. The
        // entry goes when its own process is gone, never a newer one.
        item.evicting = true;
        const unload = unloadItem;
        decide("Unloaded", pressure !== "normal" ? `Memory pressure is ${pressure}.` : "The model was idle.", item.id);
        void (async () => {
          let unloaded: boolean | void = undefined;
          try { unloaded = await unload(item.id); } catch { unloaded = false; }
          if (unloaded === false) { item.evicting = false; return; }
          if (loaded.get(item.id) === item) { loaded.delete(item.id); freeMemoryBytes += item.peakBytes; }
        })();
      }
    }
    if (memoryReadingDegraded) return;
    // A generator job waiting for memory asks the idle coding engine to go
    // when that would make room (CODE-STACK-01 S2). The supervisor's unload
    // declines while a coding request is in flight, so a busy engine makes
    // the job wait; it is asked again on the next poll. Residents are never
    // asked: only items that declared `yieldsToGenerators` are.
    if (unloadItem && queue.length > 0) {
      const head = queue.find((entry) => !entry.settled);
        if (!codingModeActive && head && head.request.kind === "generator") {
        const yielding = [...loaded.values()].filter((item) => item.kind === "jit" && item.yieldsToGenerators && !item.evicting && !item.pinned);
        const headPeak = peakFor(head.request).bytes;
        if (yielding.length > 0 && !canAdmit(head.request, headPeak) && wouldAdmitAfterFreeing(head.request, headPeak, yielding.reduce((sum, item) => sum + item.peakBytes, 0))) {
          const unload = unloadItem;
          for (const item of yielding) {
            item.evicting = true;
            void (async () => {
              let unloaded: boolean | void = undefined;
              try { unloaded = await unload(item.id); } catch { unloaded = false; }
              if (unloaded === false) { item.evicting = false; return; }
              decide("Unloaded", "A picture, video or music job was waiting and the model was idle.", item.id);
              if (loaded.get(item.id) === item) { loaded.delete(item.id); freeMemoryBytes += item.peakBytes; }
            })();
          }
        }
      }
    }
    // A video job still held after idle helpers were offered: chat is the
    // priority, but its window may shrink once for the length of the job
    // (DESIGN-chat-memory-yields-to-generators-2026-10-27). Video only.
    if (options.shrinkChat && !chatYieldBusy) {
      const videoWaiting = queue.some((entry) => !entry.settled && entry.request.kind === "generator" && entry.request.role === "video");
      const videoRunning = [...loaded.values()].some((item) => item.kind === "generator" && item.role === "video");
      const head = queue.find((entry) => !entry.settled);
      if (head && head.request.kind === "generator" && head.request.role === "video" && !codingModeActive && !canAdmit(head.request, peakFor(head.request).bytes) && !options.chatWindowShrunk?.()) {
        chatYieldBusy = true;
        void options.shrinkChat().then((done) => { if (done) decide("Restarted", "A video job was waiting for memory, so chat was restarted once at a smaller window.", "chat"); }).catch(() => {}).finally(() => { chatYieldBusy = false; });
      } else if (options.restoreChat && options.chatWindowShrunk?.() && !videoWaiting && !videoRunning) {
        chatYieldBusy = true;
        void options.restoreChat().then((done) => { if (done) decide("Restarted", "The video job is done, so chat has its full window back.", "chat"); }).catch(() => {}).finally(() => { chatYieldBusy = false; });
      }
    }
    // Every poll tries the queue head, not only on a pressure or floor edge:
    // a request can be queued by the working margin alone (free dipped under
    // peak + margin while an engine loaded) with neither edge ever firing.
    if (queue.length > 0) {
      const maxOwner = maxWindow.state === "draining" ? queue.find((entry) => !entry.settled && entry.request.id === maxWindow.ownerId) : undefined;
      if (maxOwner) {
        const draining = [...loaded.values()].some((item) => item.kind === "generator" || (item.class !== "reserved" && (options.busy?.(item.id) ?? false)));
        if (!draining && canAdmit(maxOwner.request, peakFor(maxOwner.request).bytes)) {
          const at = queue.indexOf(maxOwner); queue.splice(at, 1); settleAdmission(maxOwner);
        }
      }
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
      const head = (maxWindow.state === "draining" ? queue.find((entry) => entry.request.id === maxWindow.ownerId) : undefined) ?? queue[0];
      if (head && unloadItem && !head.settled && !canAdmit(head.request, peakFor(head.request).bytes)) {
        const required = peakFor(head.request).bytes;
        const room = roomAfterEvictionForTier(head.request, (id) => options.busy?.(id) ?? false, now);
        if (!room.fitsCap && head.request.tier) { /* capped tier cannot be fixed by eviction */ }
        else if (room.roomBytes < required && loaded.get("image-pool")?.class === "warm") {
          const pool = loaded.get("image-pool")!;
          const idleMs = now - new Date(pool.lastUsedAt).getTime();
          if (idleMs < GovernorRules.warmEvictionGraceMs) reclaim(head.request.id, "pool_idle_wait", pool.id, pool.peakBytes, now);
        } else if (room.roomBytes >= required) {
          let available = admissionRoomBytes();
          for (const id of room.evictionOrder) {
            if (available >= required) break;
            const item = loaded.get(id);
            if (!item || item.evicting) continue;
            reclaim(head.request.id, id === "image-pool" ? "evict_pool" : "evict_idle", id, item.peakBytes, now);
            item.evicting = true;
            const unload = unloadItem;
            void (async () => {
              let unloaded: boolean | void = undefined;
              try { unloaded = await unload(id); } catch { unloaded = false; }
              if (unloaded === false) { item.evicting = false; return; }
              decide("Unloaded", `The ${requestClass(head.request)} request needed room.`, id);
              if (loaded.get(id) === item) { loaded.delete(id); freeMemoryBytes += item.peakBytes; }
            })();
            available += item.peakBytes;
          }
        }
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
  chatYieldBusy = false;
  codingModeActive = false;
  metalCapBytes = null;
  admissionGate = null;
  loaded.clear();
  flexBandBorrowerToken = null;
  idleTtlOverrides.clear();
  queue.length = 0;
  refusalCounts.clear();
  decisions.length = 0;
  reclaimSteps.clear();
  maxWindow = { state: "none", ownerId: null, since: null };
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
    peakRecordStepBytes: GovernorRules.peakRecordStepBytes,
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
