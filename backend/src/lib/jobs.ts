// The job queue shape Home's generator packages and the download routes
// share: submit, progress on the feed, cancel, result by id. Generator
// execution is STACK-13; until a runner is registered for a kind, a
// submit for it is refused with a reason rather than left queued.
import { z } from "zod";
import { emit } from "@/lib/events";

export const JobStateSchema = z.enum(["queued", "running", "done", "failed", "cancelled"]);
export type JobState = z.infer<typeof JobStateSchema>;
export const JobSchema = z.object({
  id: z.string(),
  kind: z.string(),
  role: z.string().nullable(),
  state: JobStateSchema,
  percent: z.number().int().min(0).max(100),
  completedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  status: z.string(),
  input: z.record(z.string(), z.unknown()).nullable(),
  result: z.unknown().nullable(),
  reason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Job = z.infer<typeof JobSchema>;

export type JobRunner = (job: Job, signal: AbortSignal, progress: (update: Partial<Pick<Job, "percent" | "completedBytes" | "totalBytes" | "status">>) => void) => Promise<unknown>;

const jobs = new Map<string, Job>();
const controllers = new Map<string, AbortController>();
const runners = new Map<string, JobRunner>();
const KEEP_FINISHED = 200;

export function registerJobRunner(kind: string, runner: JobRunner): void { runners.set(kind, runner); }
export function hasJobRunner(kind: string): boolean { return runners.has(kind); }

function touch(job: Job, patch: Partial<Job>): Job {
  const next = { ...job, ...patch, updatedAt: new Date().toISOString() };
  jobs.set(job.id, next);
  emit({ id: "job.progress", data: { job: next.id, kind: next.kind, state: next.state, percent: next.percent, completedBytes: next.completedBytes, totalBytes: next.totalBytes, status: next.status } });
  if (next.state === "done" || next.state === "failed" || next.state === "cancelled") {
    emit({ id: "job.done", data: { job: next.id, kind: next.kind, ok: next.state === "done", reason: next.reason } });
    prune();
  }
  return next;
}

function prune(): void {
  const finished = [...jobs.values()].filter((job) => job.state !== "queued" && job.state !== "running").sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  while (finished.length > KEEP_FINISHED) { const oldest = finished.shift(); if (oldest) jobs.delete(oldest.id); }
}

/** Creates a job record for work another module drives (a download):
 * the caller reports progress with `updateJob` and finishes it. */
export function createJob(input: { kind: string; role?: string | null; totalBytes?: number; status?: string; input?: Record<string, unknown> | null; id?: string }): Job {
  const now = new Date().toISOString();
  const job: Job = { id: input.id ?? `job-${crypto.randomUUID()}`, kind: input.kind, role: input.role ?? null, state: "running", percent: 0, completedBytes: 0, totalBytes: input.totalBytes ?? 0, status: input.status ?? "starting", input: input.input ?? null, result: null, reason: null, createdAt: now, updatedAt: now };
  jobs.set(job.id, job);
  controllers.set(job.id, new AbortController());
  emit({ id: "job.progress", data: { job: job.id, kind: job.kind, state: job.state, percent: 0, completedBytes: 0, totalBytes: job.totalBytes, status: job.status } });
  return job;
}

/** The signal a download driven by another module passes down, so a
 * cancel through the jobs route stops the bytes, not just the record. */
export function jobSignal(id: string): AbortSignal | undefined { return controllers.get(id)?.signal; }

export function updateJob(id: string, patch: Partial<Pick<Job, "percent" | "completedBytes" | "totalBytes" | "status">>): Job | null {
  const job = jobs.get(id);
  if (!job || job.state !== "running") return null;
  const totalBytes = patch.totalBytes ?? job.totalBytes;
  const completedBytes = patch.completedBytes ?? job.completedBytes;
  const percent = patch.percent ?? (totalBytes > 0 ? Math.min(100, Math.round((completedBytes / totalBytes) * 100)) : job.percent);
  return touch(job, { ...patch, totalBytes, completedBytes, percent });
}

export function finishJob(id: string, outcome: { ok: true; result?: unknown } | { ok: false; reason: string }): Job | null {
  const job = jobs.get(id);
  controllers.delete(id);
  if (!job || (job.state !== "running" && job.state !== "queued")) return null;
  return outcome.ok ? touch(job, { state: "done", percent: 100, status: "done", result: outcome.result ?? null }) : touch(job, { state: "failed", status: "failed", reason: outcome.reason });
}

/** Submits work to a registered runner. Returns the job, or a refusal
 * with the reason when nothing on this machine can run the kind. */
export function submitJob(input: { kind: string; role?: string | null; input?: Record<string, unknown> }): { job: Job } | { refused: true; reason: string } {
  const runner = runners.get(input.kind);
  if (!runner) return { refused: true, reason: `No engine on this machine can run ${input.kind} jobs yet.` };
  const job = createJob({ kind: input.kind, role: input.role, input: input.input ?? null, status: "queued" });
  const controller = new AbortController();
  controllers.set(job.id, controller);
  void runner(job, controller.signal, (update) => { updateJob(job.id, update); })
    .then((result) => { if (!controller.signal.aborted) finishJob(job.id, { ok: true, result }); })
    .catch((error) => { if (!controller.signal.aborted) finishJob(job.id, { ok: false, reason: error instanceof Error ? error.message : String(error) }); })
    .finally(() => controllers.delete(job.id));
  return { job };
}

export function cancelJob(id: string): Job | null {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.state !== "queued" && job.state !== "running") return job;
  controllers.get(id)?.abort();
  controllers.delete(id);
  return touch(job, { state: "cancelled", status: "cancelled", reason: "Cancelled by Home." });
}

export function getJob(id: string): Job | null { return jobs.get(id) ?? null; }
export function listJobs(): Job[] { return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }

export function __resetJobsForTests(): void {
  for (const controller of controllers.values()) controller.abort();
  controllers.clear(); jobs.clear(); runners.clear();
}
