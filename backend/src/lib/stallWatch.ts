// STACK-STALL-WATCHDOG-01: an engine that is busy but has made no progress for its role's limit is restarted. Progress is something the
// engine really did: a streamed token, or the answer itself. Wall-clock age alone is never a reason, so a long job that keeps reporting is left alone,
// and a request with no visible progress signal (a long unstreamed completion, a generator job) is not watched at all. The memory watch (lib/governor.ts, "governor-runaway")
// stays the watch on memory; this one is only about silence.
import type { RoleId } from "@/roles";

/** Seconds of silence per role before the engine is restarted. A role with no entry is never watched. Chat and coding are minutes because a very long prompt is read before the first token. */
export const STALL_SECONDS: Partial<Record<RoleId, number>> = {
  chat: 300, coding: 600, judge: 300, router: 300, vision: 300, embed: 120, rerank: 120, stt: 300,
};

export function stallLimitMs(role: RoleId): number | null {
  const seconds = STALL_SECONDS[role];
  return seconds === undefined ? null : seconds * 1000;
}

interface Watch { lastProgressAt: number; fail: (error: Error) => void }
const watches = new Map<object, Set<Watch>>();

export interface StallWatchHandle {
  touch(now?: number): void;
  end(): void;
  /** Rejects when the engine is declared stalled, so a request waiting on a process that will never answer stops waiting. */
  stalled: Promise<never>;
}

/** Starts watching one request on `key` (the engine process). `touch` records progress; `end` stops watching. */
export function beginStallWatch(key: object, now = Date.now()): StallWatchHandle {
  let fail: (error: Error) => void = () => {};
  const stalled = new Promise<never>((_, reject) => { fail = reject; });
  stalled.catch(() => {});
  const watch: Watch = { lastProgressAt: now, fail };
  const set = watches.get(key) ?? new Set<Watch>();
  set.add(watch);
  watches.set(key, set);
  return {
    touch: (at = Date.now()) => { watch.lastProgressAt = at; },
    stalled,
    end: () => { set.delete(watch); if (set.size === 0 && watches.get(key) === set) watches.delete(key); },
  };
}

/** The keys whose every watched request has been silent past the key's limit. */
export function findStalled(now: number, limitMsFor: (key: object) => number | null): object[] {
  const stalled: object[] = [];
  for (const [key, set] of watches) {
    const limit = limitMsFor(key);
    if (limit === null || set.size === 0) continue;
    if ([...set].every((watch) => now - watch.lastProgressAt > limit)) stalled.push(key);
  }
  return stalled;
}

/** Fails every request still watched on `key` with `error` (the plain message the caller sees). */
export function failStalled(key: object, error: Error): void {
  for (const watch of watches.get(key) ?? []) watch.fail(error);
}

export function __resetStallWatchForTests(): void { watches.clear(); }
