// ADULT-LOCK-04: the Stack's half of Home's Adult lock. A job made for an
// adult audience (`audience: "adult"` on the request) is reported to every
// caller as state and progress only: no prompt, no LoRA names, no seed or
// size, no result, no preview frame, no stage words, no failure text. The
// full view of such a job is for Home alone, and only when Home asks for it
// on that request after it has checked the person's unlock proof.
//
// The ask: header `x-maipai-view: full` together with `x-maipai-home-token`.
// The token is a random value the Stack keeps in `data/keys/home-view-token`
// (made at first use, mode 600) or takes from STACK_HOME_VIEW_TOKEN; Home
// reads it from the same place or sets the variable in the unit it installs.
// A full-view ask with a missing or wrong token is refused (403
// `full_view_forbidden`) on every route, adult job or not, so a caller never
// learns whether a job is adult by trying. No header means the redacted view.
// Nothing here changes how a job runs, and the job's `classification` second
// lock (lora_not_allowed and the audience checks) is untouched.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { keysDir } from "@/lib/paths";
import type { StackJob } from "@maipai/spec/stack/ts/stack-job.js";

export const VIEW_HEADER = "x-maipai-view";
export const HOME_TOKEN_HEADER = "x-maipai-home-token";
const TOKEN_FILE = "home-view-token";

let cachedToken: string | null = null;
/** The credential a full-view ask must present. */
export function homeViewToken(): string {
  const fromEnv = process.env.STACK_HOME_VIEW_TOKEN?.trim();
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  if (cachedToken) return cachedToken;
  const path = join(keysDir, TOKEN_FILE);
  try {
    if (existsSync(path)) {
      const stored = readFileSync(path, "utf8").trim();
      if (stored.length >= 16) return (cachedToken = stored);
    }
  } catch { /* fall through and make one */ }
  const made = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
  mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${made}\n`, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
  return (cachedToken = made);
}
export function __resetAdultViewForTests(): void { cachedToken = null; adultJobs.clear(); }

type HeaderGet = (name: string) => string | undefined;
function tokenMatches(presented: string | undefined): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(homeViewToken());
  return a.length === b.length && timingSafeEqual(a, b);
}
/** Did the caller ask for the full view? (Whether it may have it is `fullViewAllowed`.) */
export function fullViewAsked(header: HeaderGet): boolean { return (header(VIEW_HEADER) ?? "").trim().toLowerCase() === "full"; }
/** The caller asked for the full view and presented Home's credential. */
export function fullViewAllowed(header: HeaderGet): boolean { return fullViewAsked(header) && tokenMatches(header(HOME_TOKEN_HEADER)); }

/** Job ids made for an adult audience (marked when the job is created). */
const adultJobs = new Set<string>();
const MAX_MARKED = 5000;
export function markAdultJob(id: string): void {
  adultJobs.add(id);
  while (adultJobs.size > MAX_MARKED) adultJobs.delete(adultJobs.values().next().value as string);
}
export function isAdultJobId(id: string): boolean { return adultJobs.has(id); }
export function isAdultJob(job: Pick<StackJob, "id" | "input">): boolean {
  return adultJobs.has(job.id) || (job.input as { audience?: unknown } | null)?.audience === "adult";
}
/** The job input fragment that marks a job adult (spread into a submit). */
export const adultInput = (audience: string | undefined): { audience?: "adult" } => (audience === "adult" ? { audience: "adult" } : {});

/** The only words an adult job's status ever carries: its state. */
const coarseStatus = (state: string): string => state;
/** A job record with the content taken out: identity, kind, state, percent and place in line stay. */
export function redactJob(job: StackJob): StackJob {
  const input = job.input as { tier?: unknown } | null;
  return {
    id: job.id, kind: job.kind, role: job.role, state: job.state, percent: job.percent, completedBytes: 0, totalBytes: 0,
    status: coarseStatus(job.state), position: job.position,
    input: { audience: "adult", ...(input?.tier === "boost" || input?.tier === "max" || input?.tier === "standard" ? { tier: input.tier } : {}) },
    result: null, reason: job.state === "failed" ? "This job failed." : job.state === "cancelled" ? "This job was cancelled." : null,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
  };
}
/** The job as the caller may see it. */
export function jobView(job: StackJob, full: boolean): StackJob { return !full && isAdultJob(job) ? redactJob(job) : job; }

/** An event as a caller without the full view may see it: a job.progress or job.done of an adult job keeps the job, kind, state, percent and place in line only. */
export function redactEventData(id: string, data: Record<string, unknown>): Record<string, unknown> {
  if ((id !== "job.progress" && id !== "job.done") || typeof data.job !== "string" || !isAdultJobId(data.job)) return data;
  if (id === "job.done") return { job: data.job, kind: data.kind, ok: data.ok };
  return { job: data.job, kind: data.kind, state: data.state, percent: data.percent, status: coarseStatus(String(data.state)), position: data.position ?? null };
}
