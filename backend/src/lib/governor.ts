import { emit } from "@/lib/events";
import { getMemoryReader, type MemoryPressure, type MemoryReader } from "@/lib/memory";
import { raise, resolve as resolveHealth } from "@/lib/health";
import { ROLES } from "@/roles";

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
export type RunState = "running" | "pausing" | "paused";

export interface GovernorRequest {
  id: string;
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
  kind: GovernorKind;
  class?: GovernorClass;
  requestedBytes: number;
  token?: number;
  retainWarm?: boolean;
}

export interface GovernorLoadedModel {
  id: string;
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
  queue: Array<{ id: string; position: number; kind: GovernorKind; class: GovernorClass }>;
}

export interface GovernorDecision { at: string; decision: string; reason: string; model: string; reasonCode?: "coding_mode"; }

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

function decide(decision: string, reason: string, model: string, reasonCode?: "coding_mode"): void {
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
}

/** Room a request could use after eligible idle items are unloaded. */
export function roomAfterEviction(request: GovernorRequest, busy: (id: string) => boolean = () => false, now = Date.now()): EvictionRoom {
  const targetClass = requestClass(request);
  const classRank: Record<GovernorClass, number> = { reserved: 0, warm: 1, burst: 2 };
  const evictionRank = (item: LoadedInternal): number => {
    if (item.class === "burst") return item.id.includes("tool") ? 1 : 0;
    if (item.id.includes("vision")) return 1;
    if (item.id.includes("edit")) return 2;
    if (item.id.includes("coding")) return 3;
    return 4;
  };
  const candidates = [...loaded.values()].filter((item) => {
    if (item.class === "reserved" || item.pinned || item.evicting || item.kind === "generator" || busy(item.id)) return false;
    const warmGracePassed = item.class === "warm" && now - new Date(item.lastUsedAt).getTime() >= GovernorRules.warmEvictionGraceMs;
    if (classRank[item.class] < classRank[targetClass] && !warmGracePassed) return false;
    if (item.class === "warm" && !warmGracePassed) return false;
    return true;
  }).sort((a, b) => classRank[b.class] - classRank[a.class] || evictionRank(a) - evictionRank(b) || new Date(a.lastUsedAt).getTime() - new Date(b.lastUsedAt).getTime());
  let roomBytes = admissionRoomBytes();
  const evictionOrder: string[] = [];
  for (const item of candidates) {
    evictionOrder.push(item.id);
    roomBytes += item.peakBytes;
  }
  return { roomBytes, evictionOrder };
}

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
  if (codingModeActive && request.kind === "generator") return false;
  if (memoryReadingDegraded) return false;
  if (!gateVerdict(request, peakBytes).ok) return false;
  if (pressure !== "normal") return false;
  const existing = loaded.get(request.id);
  const generatorBusy = request.kind === "generator" && [...loaded.values()].some((item) => item.kind === "generator" && item !== existing);
  if (generatorBusy) return false;
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
  if (!fitsEver(request)) {
    const reason = neverFitReason(request);
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
    queue.push(entry);
    const gated = gateVerdict(request, peak.bytes);
    const heldByMode = codingModeActive && request.kind === "generator";
    decide("Queued", heldByMode ? "The large coding mode is holding picture, video and music work." : !gated.ok ? gated.reason : pressure !== "normal" ? `Memory pressure is ${pressure}.` : "The current memory budget cannot admit the request.", request.id, heldByMode ? "coding_mode" : undefined);
    return { queued: true, position: queue.length, class: requestClass(request), admitted };
  }
  refusalCounts.delete(request.id);
  resolveHealth("admission-refused-repeatedly");
  const borrowsFlexBand = usesFlexBand(request, peak.bytes);
  const existing = loaded.get(request.id);
  if (existing) {
    existing.kind = request.kind;
    existing.class = requestClass(request);
    existing.peakBytes = peak.bytes;
    existing.measured = peak.measured;
    existing.lastUsedAt = nowIso();
    existing.evicting = false;
    existing.token = nextToken++;
    existing.keepAliveSeconds = 0;
    existing.yieldsToGenerators = false;
    const handle: GovernorHandle = { id: request.id, kind: request.kind, class: requestClass(request), requestedBytes: peak.bytes, token: existing.token, retainWarm: request.retainWarm };
    decide("Admitted", "The current memory budget has room.", request.id);
    if (borrowsFlexBand) flexBandBorrowerToken = existing.token;
    return handle;
  }
  const item = loadedItemFor(request);
  loaded.set(request.id, item);
  if (borrowsFlexBand) flexBandBorrowerToken = item.token;
  decide("Admitted", "The current memory budget has room.", request.id);
  return { id: request.id, kind: request.kind, class: requestClass(request), requestedBytes: peak.bytes, token: item.token, retainWarm: request.retainWarm };
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
  queue.length = 0;
  for (const item of [...loaded.values()]) loaded.delete(item.id);
  setRunState("paused");
}

export function resumeAll(): void { setRunState("running"); }

function settleAdmission(entry: QueuedEntry): void {
  const borrowsFlexBand = usesFlexBand(entry.request, peakFor(entry.request).bytes);
  const existing = loaded.get(entry.request.id);
  if (existing) {
    existing.kind = entry.request.kind;
    existing.class = requestClass(entry.request);
    existing.peakBytes = peakFor(entry.request).bytes;
    existing.measured = peakFor(entry.request).measured;
    existing.lastUsedAt = nowIso();
    existing.evicting = false;
    existing.token = nextToken++;
    const handle: GovernorHandle = { id: entry.request.id, kind: entry.request.kind, class: requestClass(entry.request), requestedBytes: existing.peakBytes, token: existing.token, retainWarm: entry.request.retainWarm };
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
  entry.resolve({ id: entry.request.id, kind: entry.request.kind, class: requestClass(entry.request), requestedBytes: item.peakBytes, token: item.token, retainWarm: entry.request.retainWarm });
}

export function release(handle: GovernorHandle): void {
  const item = loaded.get(handle.id);
  // An older admission's handle frees nothing, so it admits nothing.
  if (!item || (handle.token !== undefined && item.token !== handle.token)) return;
  if (handle.retainWarm) {
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
    queue: queue.map((entry, index) => ({ id: entry.request.id, position: index + 1, kind: entry.request.kind, class: requestClass(entry.request) })),
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
    // Every poll tries the queue head, not only on a pressure or floor edge:
    // a request can be queued by the working margin alone (free dipped under
    // peak + margin while an engine loaded) with neither edge ever firing.
    if (queue.length > 0) {
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
      const head = queue[0];
      if (head && unloadItem && !head.settled && !canAdmit(head.request, peakFor(head.request).bytes)) {
        const required = peakFor(head.request).bytes;
        const room = roomAfterEviction(head.request, (id) => options.busy?.(id) ?? false, now);
        if (room.roomBytes >= required) {
          let available = admissionRoomBytes();
          for (const id of room.evictionOrder) {
            if (available >= required) break;
            const item = loaded.get(id);
            if (!item || item.evicting) continue;
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
  codingModeActive = false;
  metalCapBytes = null;
  admissionGate = null;
  loaded.clear();
  flexBandBorrowerToken = null;
  idleTtlOverrides.clear();
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
