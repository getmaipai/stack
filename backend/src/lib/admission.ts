// One way to wait on the governor, for a generator job and for an
// engine start alike. The governor answers `admit` at once: a handle,
// `queued` with its `admitted` promise, or `refused`. A queued request
// is admitted later inside a `release`, and the governor's own poll
// settles the `admitted` promise when memory frees, so the wait simply
// awaits it. A caller that stops waiting (a cancel, a deadline) calls
// `withdraw`, which removes the request from the governor's queue and
// settles the `admitted` promise refused, so no late admission ever
// happens and nothing is loaded that nobody holds.
import { admit, getGovernorDecisions, getGovernorStatus, getRunState, GovernorRules, withdraw, type GovernorHandle, type GovernorRequest } from "@/lib/governor";

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
   * caller is told through `onGaveUp` and the request is withdrawn. */
  stillWanted: () => boolean;
  /** Called once when the caller stopped wanting it (a cancel, a deadline). */
  onGaveUp?: () => void;
  onPosition?: (position: number) => void;
  /** A deadline after which the wait stops wanting the admission on its own. */
  timeoutMs?: number;
}

/** Waits for the governor to admit a request. Resolves with the handle,
 * or null when the caller gave up (the request is withdrawn from the
 * governor's queue, so no late admission ever happens), and rejects with
 * the governor's reason when the request is refused or dropped, or with
 * the peak's numbers when the budget could never hold it. */
export async function waitForAdmission(request: GovernorRequest, options: WaitOptions): Promise<GovernorHandle | null> {
  const status = getGovernorStatus();
  const peak = governorPeak(request);
  if (peak > status.capBytes) throw new AdmissionRefusedError(`${request.id} needs about ${gb(peak)} GB; the memory budget for models is ${gb(status.capBytes)} GB.`);
  const answer = await admit(request);
  if ("refused" in answer) throw new AdmissionRefusedError(answer.reason);
  if (!("queued" in answer)) return answer;
  options.onPosition?.(answer.position);
  let gaveUp = false;
  const giveUp = () => {
    if (gaveUp) return;
    gaveUp = true;
    options.onGaveUp?.();
    withdraw(request.id);
  };
  if (options.timeoutMs !== undefined) {
    setTimeout(giveUp, options.timeoutMs);
  }
  const admitted = await answer.admitted;
  if (gaveUp) return null;
  if ("refused" in admitted) throw new AdmissionRefusedError(admitted.reason);
  if (!options.stillWanted()) { giveUp(); return null; }
  return admitted;
}

/** Retained for the test harness; the wait no longer polls, so there is
 * nothing to tune. */
export function __setAdmissionTuningForTests(_options: { kickMs?: number } = {}): void {
}
