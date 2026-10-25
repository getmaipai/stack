// What the memory watchdog knows right now, and the one admission rule
// built from it. Kept apart from the watchdog (lib/memoryWatchdog.ts,
// which cancels jobs and unloads roles) so the governor, the job queue
// and the routes can read it without importing the supervisor.
//
// Admission uses the machine's real numbers, not only the governor's
// model of its own workers: another program (a scratch Stack, a build,
// a browser) may hold memory the governor never loaded.
import { getSystemSampler, type SystemSample } from "@/lib/memory/system";
import type { GovernorRequest } from "@/lib/governor";
import { settingValues } from "@/settings";

const GB = 1_073_741_824;

export const WatchdogRules = {
  sampleMs: 5_000,
  /** Process table every Nth sample (and at once while memory is tight). */
  processEvery: 3,
  ringSize: 120,
  /** WARN above this much available memory over the reserve ... */
  warnMarginBytes: 4 * GB,
  /** ... and it clears only once available memory is this far over the reserve (hysteresis). */
  warnClearMarginBytes: 8 * GB,
  criticalFloorBytes: 3 * GB,
  criticalClearBytes: 5 * GB,
  /** Swap that grew this much inside the window counts as growing fast. */
  swapGrowthWindowMs: 30_000,
  swapGrowthCriticalBytes: GB,
  /** Consecutive samples that confirm a worse level, and that confirm a better one. */
  enterSamples: 2,
  clearSamples: 6,
  /** Critical this long is the chat role's turn to be restarted. */
  chatRestartAfterMs: 60_000,
  chatRestartCooldownMs: 10 * 60_000,
  /** A generative job waits this long for memory, then fails with no_memory. */
  admissionWaitMs: 180_000,
  orphanMinAgeSeconds: 90,
  orphanKillGraceMs: 15_000,
  devSingleBytes: 40 * GB,
  devSumBytes: 30 * GB,
  devLogEveryMs: 10 * 60_000,
  notifyEveryMs: 10 * 60_000,
} as const;

/** The status of a job the watchdog stopped or held back for memory. */
export const PAUSED_LOW_MEMORY = "paused: low memory";

export type WatchdogLevel = "normal" | "warn" | "critical";

export interface WatchdogAction { at: string; level: WatchdogLevel; action: string; detail: string; }

interface MemoryState {
  level: WatchdogLevel;
  since: number;
  latest: SystemSample | null;
  chatPagedOut: boolean;
  actions: WatchdogAction[];
}
const state: MemoryState = { level: "normal", since: Date.now(), latest: null, chatPagedOut: false, actions: [] };

export function watchdogEnabled(): boolean { return settingValues()["stack.memory.watchdog"] !== false; }
export function orphanReaperEnabled(): boolean { return settingValues()["stack.memory.reap_orphans"] !== false; }

/** The reserve: `stack.memory.reserve_gb` when set, else the larger of 8 GB and 8 percent of the memory. */
export function reserveBytes(totalBytes: number): number {
  const configured = Number(settingValues()["stack.memory.reserve_gb"] ?? 0);
  return configured > 0 ? configured * GB : Math.min(Math.max(8 * GB, totalBytes * 0.08), totalBytes * 0.25);
}

export function memoryLevel(): WatchdogLevel { return state.level; }
export function levelSince(): number { return state.since; }
export function setMemoryLevel(level: WatchdogLevel, now = Date.now()): void { if (state.level !== level) { state.level = level; state.since = now; } }
export function latestSample(): SystemSample | null { return state.latest; }
export function setLatestSample(sample: SystemSample): void { state.latest = sample; }
export function chatPagedOut(): boolean { return state.chatPagedOut; }
export function setChatPagedOut(pagedOut: boolean): void { state.chatPagedOut = pagedOut; }
export function recordAction(level: WatchdogLevel, action: string, detail: string): void {
  state.actions.unshift({ at: new Date().toISOString(), level, action, detail });
  if (state.actions.length > 50) state.actions.length = 50;
}
export function recentActions(): WatchdogAction[] { return [...state.actions]; }
export function __resetMemoryStateForTests(): void { state.level = "normal"; state.since = Date.now(); state.latest = null; state.chatPagedOut = false; state.actions = []; }

function gb(bytes: number): string { return (bytes / GB).toFixed(1); }

/** Whether a start is gated: the generative work the watchdog guards (a picture, a clip, the image tools, the voice engine). */
export function isGuarded(request: Pick<GovernorRequest, "id" | "kind">): boolean {
  return request.kind === "generator" || request.kind === "jit" || request.id === "tts";
}

/** The reading to judge by: the latest sample, or a fresh one when it is stale or the watchdog has not run. */
function currentSample(): SystemSample {
  const latest = state.latest;
  if (latest && Date.now() - latest.at < 2_000) return latest;
  const fresh = getSystemSampler().sample();
  state.latest = fresh;
  return fresh;
}

/** The admission rule: a guarded start is allowed only while the level is normal and the available memory left after the start's declared peak stays above the reserve. */
export function admissionVerdict(request: Pick<GovernorRequest, "id" | "kind">, peakBytes: number): { ok: true } | { ok: false; reason: string } {
  if (!watchdogEnabled() || !isGuarded(request)) return { ok: true };
  const sample = currentSample();
  if (sample.degraded) return { ok: true };
  const reserve = reserveBytes(sample.totalBytes);
  if (state.level !== "normal") return { ok: false, reason: `This computer is low on memory (${gb(sample.availableBytes)} GB available, ${gb(reserve)} GB kept in reserve), so new picture and video work waits until it recovers.` };
  const left = sample.availableBytes - peakBytes;
  if (left < reserve) return { ok: false, reason: `It needs about ${gb(peakBytes)} GB and ${gb(sample.availableBytes)} GB is available, which would leave ${gb(Math.max(0, left))} GB; ${gb(reserve)} GB is kept in reserve.` };
  return { ok: true };
}

/** The status line of a job waiting on memory: the numbers a person can act on. */
export function waitingText(peakBytes: number, position: number): string {
  const sample = currentSample();
  const reserve = reserveBytes(sample.totalBytes);
  const ahead = position > 0 ? ` (${position} ahead)` : "";
  return `waiting for memory${ahead}: needs about ${gb(peakBytes)} GB, ${gb(sample.availableBytes)} GB available, ${gb(reserve)} GB kept in reserve`;
}

/** The sentence a route returns while the level is not normal: new generative work is refused, with what to do. */
export function lowMemoryRefusal(): string | null {
  if (!watchdogEnabled() || state.level === "normal") return null;
  const sample = state.latest;
  const numbers = sample ? ` (${gb(sample.availableBytes)} GB available, ${gb(reserveBytes(sample.totalBytes))} GB kept in reserve)` : "";
  return `This computer is low on memory${numbers}, so picture and video making is paused until it recovers. Close big apps, or try again in a minute.`;
}
