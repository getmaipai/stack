// One way to wait on the governor, for a generator job and for an
// engine start alike. The governor answers `admit` at once: a handle,
// `queued`, or `refused`. A queued request is admitted later inside a
// `release` with no callback, so this loop watches the loaded set for
// it; when nothing the request waits on is loaded and pressure is
// normal, no release would ever come, so it releases a handle the
// governor does not hold (its one public way to re-run the queue head),
// no more often than the governor's own poll. A caller that stops
// waiting (a cancel, a deadline) leaves a watcher behind that releases
// the admission if it ever lands, so a phantom never blocks the next
// request. STACK-06c retires the watching and the kick.
import { admit, getGovernorDecisions, getGovernorStatus, getRunState, GovernorRules, release, type GovernorHandle, type GovernorRequest } from "@/lib/governor";

const POLL_MS = 250;
let kickMs: number = GovernorRules.pollMs;

/** The peak the governor will compute for a request, mirrored from its
 * `peakFor` so a refusal here agrees with an admission there. */
export function governorPeak(request: GovernorRequest): number {
  if (request.measuredPeakBytes && request.measuredPeakBytes > 0) return request.measuredPeakBytes;
  if (!request.modelFileBytes) return request.requestedBytes;
  const multiplier = GovernorRules.engineMultipliers[request.engine as keyof typeof GovernorRules.engineMultipliers] ?? GovernorRules.engineMultipliers.default;
  return Math.ceil(request.modelFileBytes * multiplier);
}

/** Why a request vanished from the governor's queue without admission:
 * a pause (the governor clears its queue and records nothing), or a
 * refusal recorded since the wait began; never the stale reason it was
 * queued for. */
export function governorReasonFor(id: string, since: string): string {
  if (getRunState() !== "running") return "The Stack is paused.";
  const refused = getGovernorDecisions().find((decision) => decision.model === id && decision.decision === "Refused" && decision.at >= since);
  return refused?.reason ?? "The governor dropped the request from its queue.";
}

/** The governor's own words on why a request is waiting, with the
 * numbers a person can act on. */
export function waitingReason(id: string, request: GovernorRequest): string {
  const why = getGovernorDecisions().find((decision) => decision.model === id)?.reason ?? "The current memory budget cannot admit the request.";
  const status = getGovernorStatus();
  return `${why} It needs about ${gb(governorPeak(request))} GB with ${gb(status.freeMemoryBytes)} GB free, after the working margin the machine's tier keeps back; memory pressure is ${status.pressure}.`;
}

export function gb(bytes: number): string { return (bytes / 1_073_741_824).toFixed(1); }

export class AdmissionRefusedError extends Error {
  constructor(message: string) { super(message); this.name = "AdmissionRefusedError"; }
}

export interface WaitOptions {
  /** Says whether the caller still wants the admission; once false the
   * caller is told through `onGaveUp` and the loop only watches. */
  stillWanted: () => boolean;
  /** Called once when the caller stopped wanting it (a cancel, a deadline). */
  onGaveUp?: () => void;
  onPosition?: (position: number) => void;
  /** A deadline after which the wait stops wanting the admission on its own. */
  timeoutMs?: number;
}

/** Waits for the governor to admit a request. Resolves with the handle,
 * or null when the caller gave up (its late admission, if any, is
 * released by the watcher this leaves behind), and rejects with the
 * governor's reason when the request is refused or dropped, or with
 * the peak's numbers when the budget could never hold it. */
export async function waitForAdmission(request: GovernorRequest, options: WaitOptions): Promise<GovernorHandle | null> {
  const status = getGovernorStatus();
  const peak = governorPeak(request);
  if (peak > status.capBytes) throw new AdmissionRefusedError(`${request.id} needs about ${gb(peak)} GB; the memory budget for models is ${gb(status.capBytes)} GB.`);
  const answer = await admit(request);
  if ("refused" in answer) throw new AdmissionRefusedError(answer.reason);
  if (!("queued" in answer)) return answer;
  options.onPosition?.(answer.position);
  // The caller's promise settles when the admission lands or the caller
  // gives up; the loop itself runs on as the watcher after a give-up,
  // until the request is admitted (and released) or dropped.
  return new Promise<GovernorHandle | null>((resolve, reject) => {
    const waitStartedAt = new Date().toISOString();
    const deadline = options.timeoutMs ? Date.now() + options.timeoutMs : null;
    let gaveUp = false;
    let lastKick = Date.now();
    wanted.add(request.id);
    // One watcher per id: a new wait for the same id (a retry after a
    // timeout, a restart) takes over the watch and the release duty, so
    // an old watcher never returns the admission a live wait just took.
    const token = Symbol(request.id);
    watchers.set(request.id, token);
    // A watcher another wait took over leaves `wanted` to that wait.
    const giveUp = () => { if (gaveUp) return; gaveUp = true; if (watchers.get(request.id) === token) wanted.delete(request.id); options.onGaveUp?.(); resolve(null); };
    const watch = async () => {
      while (true) {
        await new Promise((tick) => setTimeout(tick, POLL_MS));
        if (watchers.get(request.id) !== token) { if (!gaveUp) giveUp(); return; }
        const current = getGovernorStatus();
        const admitted = current.loaded.find((item) => item.id === request.id);
        if (admitted) {
          const handle: GovernorHandle = { id: request.id, kind: request.kind, requestedBytes: admitted.peakBytes };
          watchers.delete(request.id);
          if (gaveUp || !options.stillWanted()) { release(handle); giveUp(); return; }
          wanted.delete(request.id);
          resolve(handle);
          return;
        }
        const waiting = current.queue.find((item) => item.id === request.id);
        if (!waiting) {
          watchers.delete(request.id);
          if (gaveUp) return;
          wanted.delete(request.id);
          if (options.stillWanted()) reject(new AdmissionRefusedError(governorReasonFor(request.id, waitStartedAt)));
          else giveUp();
          return;
        }
        if (!gaveUp && (!options.stillWanted() || (deadline !== null && Date.now() >= deadline))) giveUp();
        if (!gaveUp) options.onPosition?.(waiting.position);
        // A wait that was given up kicks only while a live wait sits
        // behind its phantom; alone, it just watches, so the governor's
        // "work is waiting for memory" warning never fires for a request
        // nobody wants. A kick that still cannot admit the head moves that
        // request to the back of the governor's queue, so the order among
        // waiting requests rotates until one fits.
        // Never while the memory reading is degraded: the governor
        // refuses outright then, and a kick would drop the head for good.
        const liveWaiting = !gaveUp || current.queue.some((item) => item.id !== request.id && wanted.has(item.id));
        const generatorLoaded = current.loaded.some((item) => item.kind === "generator");
        const blockedByGenerator = request.kind === "generator" && generatorLoaded;
        if (liveWaiting && !blockedByGenerator && current.pressure === "normal" && !current.memoryReadingDegraded && Date.now() - lastKick >= kickMs) {
          lastKick = Date.now();
          release({ id: `kick:${request.id}`, kind: request.kind, requestedBytes: 0 });
        }
      }
    };
    void watch();
  });
}

/** The requests a caller still waits on, so a given-up wait knows
 * whether a live one sits behind its phantom. */
const wanted = new Set<string>();
/** The watcher that owns each id's wait. */
const watchers = new Map<string, symbol>();

export function __setAdmissionTuningForTests(options: { kickMs?: number } = {}): void {
  kickMs = options.kickMs ?? GovernorRules.pollMs;
  wanted.clear();
  watchers.clear();
}
