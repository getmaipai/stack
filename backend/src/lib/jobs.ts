// The job queue Home's generator packages and the download routes share:
// submit, progress on the feed, cancel, result by id. The shape is the
// spec's StackJob. A generator job (image, video, music) waits in its
// role's queue, one in flight per role, and runs only once the governor
// admits it (one generator at a time across roles, the budget's say);
// a job the budget refuses fails with the governor's reason, never
// hangs. A download or an install created by another module runs as
// that module drives it. Until a runner is registered for a kind, a
// submit for it is refused with a reason rather than left queued.
import { emit } from "@/lib/events";
import { admit, getGovernorStatus, getRunState, GovernorRules, release, withdraw, type GovernorHandle, type GovernorRequest } from "@/lib/governor";
import { StackJob, StackJobState } from "@maipai/spec/stack/ts/stack-job.js";

export const JobStateSchema = StackJobState;
export type JobState = StackJobState;
export const JobSchema = StackJob;
export type Job = StackJob;

export type JobProgress = (update: Partial<Pick<Job, "percent" | "completedBytes" | "totalBytes" | "status">>) => void;
export type JobRunner = (job: Job, signal: AbortSignal, progress: JobProgress) => Promise<unknown>;

/** What a generator runner needs the governor to hold for a job: the
 * peak it expects, the model file it loads and its engine (the
 * governor's multiplier), or a measured peak. */
export interface JobMemory { requestedBytes: number; modelFileBytes?: number | null; measuredPeakBytes?: number | null; engine?: string; }
export interface JobRunnerOptions {
  /** A generator: queued per role and admitted through the governor. */
  generator?: { role: string; memory: (job: Job) => JobMemory };
}

interface RegisteredRunner { run: JobRunner; options: JobRunnerOptions; }

const jobs = new Map<string, Job>();
const controllers = new Map<string, AbortController>();
const runners = new Map<string, RegisteredRunner>();
/** Queued generator jobs per role, in submission order. */
const queues = new Map<string, Job[]>();
/** The generator job in flight per role, if any. */
const inFlight = new Map<string, string>();
const KEEP_FINISHED = 200;

export function registerJobRunner(kind: string, runner: JobRunner, options: JobRunnerOptions = {}): void { runners.set(kind, { run: runner, options }); }
export function hasJobRunner(kind: string): boolean { return runners.has(kind); }

function touch(job: Job, patch: Partial<Job>): Job {
  const next = { ...job, ...patch, updatedAt: new Date().toISOString() };
  jobs.set(job.id, next);
  emit({ id: "job.progress", data: { job: next.id, kind: next.kind, state: next.state, percent: next.percent, completed_bytes: next.completedBytes, total_bytes: next.totalBytes, status: next.status, position: next.position } });
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
export function createJob(input: { kind: string; role?: string | null; totalBytes?: number; status?: string; input?: Record<string, unknown> | null; id?: string; state?: JobState; position?: number | null }): Job {
  const now = new Date().toISOString();
  const job: Job = { id: input.id ?? `job-${crypto.randomUUID()}`, kind: input.kind, role: input.role ?? null, state: input.state ?? "running", percent: 0, completedBytes: 0, totalBytes: input.totalBytes ?? 0, status: input.status ?? "starting", position: input.position ?? null, input: input.input ?? null, result: null, reason: null, createdAt: now, updatedAt: now };
  jobs.set(job.id, job);
  controllers.set(job.id, new AbortController());
  emit({ id: "job.progress", data: { job: job.id, kind: job.kind, state: job.state, percent: 0, completed_bytes: 0, total_bytes: job.totalBytes, status: job.status, position: job.position } });
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
  return outcome.ok ? touch(job, { state: "done", percent: 100, status: "done", result: outcome.result ?? null, position: null }) : touch(job, { state: "failed", status: "failed", reason: outcome.reason, position: null });
}

/** Submits work to a registered runner. A generator kind is queued for
 * its role and admitted through the governor; anything else runs at
 * once. Returns the job, or a refusal with the reason when nothing on
 * this machine can run the kind. */
export function submitJob(input: { kind: string; role?: string | null; input?: Record<string, unknown> }): { job: Job } | { refused: true; reason: string } {
  const runner = runners.get(input.kind);
  if (!runner) return { refused: true, reason: `No engine on this machine can run ${input.kind} jobs yet.` };
  if (runner.options.generator) {
    const role = runner.options.generator.role;
    const queue = queues.get(role) ?? [];
    queues.set(role, queue);
    const job = createJob({ kind: input.kind, role, input: input.input ?? null, status: "queued", state: "queued", position: queue.length + 1 });
    queue.push(job);
    void pump(role);
    return { job: jobs.get(job.id)! };
  }
  const job = createJob({ kind: input.kind, role: input.role, input: input.input ?? null, status: "queued" });
  run(job, runner);
  return { job };
}

function run(job: Job, runner: RegisteredRunner, onSettled: () => void = () => {}): void {
  const controller = controllers.get(job.id) ?? new AbortController();
  controllers.set(job.id, controller);
  void runner.run(jobs.get(job.id) ?? job, controller.signal, (update) => { updateJob(job.id, update); })
    .then((result) => { if (!controller.signal.aborted) finishJob(job.id, { ok: true, result }); })
    .catch((error) => { if (!controller.signal.aborted) finishJob(job.id, { ok: false, reason: error instanceof Error ? error.message : String(error) }); })
    .finally(() => { controllers.delete(job.id); onSettled(); });
}

/** Queue positions after a move, told on the feed like any progress. */
function renumber(role: string): void {
  const queue = queues.get(role) ?? [];
  queue.forEach((job, index) => { const current = jobs.get(job.id); if (current && current.state === "queued" && current.position !== index + 1) touch(current, { position: index + 1 }); });
}

/** Runs the next queued job of a role when none is in flight: it asks
 * the governor for room, waits on the governor's own promise when told
 * to (its poll settles it when memory frees), fails the job with the
 * governor's reason when refused or paused, and releases the admission
 * however the run ends. */
async function pump(role: string): Promise<void> {
  if (inFlight.has(role)) return;
  const queue = queues.get(role) ?? [];
  const next = queue.shift();
  if (!next) return;
  renumber(role);
  const current = jobs.get(next.id);
  if (!current || current.state !== "queued") { void pump(role); return; }
  inFlight.set(role, next.id);
  const runner = runners.get(next.kind);
  const settle = () => { inFlight.delete(role); void pump(role); };
  if (!runner?.options.generator) { finishJob(next.id, { ok: false, reason: `No generator runs ${next.kind} jobs.` }); settle(); return; }
  jobs.set(next.id, { ...jobs.get(next.id)!, position: null });
  touch(jobs.get(next.id)!, { state: "running", status: "waiting for memory" });
  let handle: GovernorHandle;
  try {
    handle = await admitJob(next.id, { id: next.id, kind: "generator", ...runner.options.generator.memory(jobs.get(next.id)!) });
  } catch (error) {
    finishJob(next.id, { ok: false, reason: error instanceof Error ? error.message : String(error) });
    settle();
    return;
  }
  const job = jobs.get(next.id);
  if (!job || job.state !== "running") { release(handle); settle(); return; }
  touch(job, { status: "starting" });
  run(job, runner, () => { release(handle!); settle(); });
}

/** The peak the governor will compute for a request, mirrored from its
 * `peakFor` so a refusal here agrees with an admission there. */
function governorPeak(request: GovernorRequest): number {
  if (request.measuredPeakBytes && request.measuredPeakBytes > 0) return request.measuredPeakBytes;
  if (!request.modelFileBytes) return request.requestedBytes;
  const multiplier = GovernorRules.engineMultipliers[request.engine as keyof typeof GovernorRules.engineMultipliers] ?? GovernorRules.engineMultipliers.default;
  return Math.ceil(request.modelFileBytes * multiplier);
}

/** The governor's answer for one job: the handle once admitted, a
 * thrown reason when refused, or a thrown reason when the job was
 * cancelled or the Stack paused while waiting. The wait is a bare
 * await on the governor's own promise, which its poll settles when
 * memory frees; a cancel or a pause withdraws the request. */
async function admitJob(jobId: string, request: GovernorRequest): Promise<GovernorHandle> {
  // A peak the budget can never hold is refused now with the numbers,
  // not queued for memory that will not come.
  const status = getGovernorStatus();
  const peak = governorPeak(request);
  if (peak > status.capBytes) throw new Error(`The render needs about ${gb(peak)} GB; the memory budget for models is ${gb(status.capBytes)} GB.`);
  const controller = controllers.get(jobId);
  const answer = await admit(request);
  if ("refused" in answer) throw new Error(answer.reason);
  if (!("queued" in answer)) return answer;
  updateJob(jobId, { status: `waiting for memory (${answer.position} ahead)` });
  const signal = controller?.signal;
  let pauseTimer: ReturnType<typeof setInterval> | null = null;
  try {
    const settled = await Promise.race([
      answer.admitted,
      signal
        ? new Promise<never>((_, reject) => {
            if (signal.aborted) { reject(new Error("Cancelled by Home.")); return; }
            signal.addEventListener("abort", () => reject(new Error("Cancelled by Home.")), { once: true });
          })
        : new Promise<never>(() => {}),
      new Promise<never>((_, reject) => {
        pauseTimer = setInterval(() => {
          if (getRunState() !== "running") { if (pauseTimer) clearInterval(pauseTimer); reject(new Error("The Stack is paused.")); }
        }, 100);
      }),
    ]);
    if ("refused" in settled) throw new Error(settled.reason);
    return settled;
  } catch (error) {
    withdraw(request.id);
    throw error;
  } finally {
    if (pauseTimer) clearInterval(pauseTimer);
  }
}

function gb(bytes: number): string { return (bytes / 1_073_741_824).toFixed(1); }


export function cancelJob(id: string): Job | null {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.state !== "queued" && job.state !== "running") return job;
  if (job.role && job.state === "queued") {
    const queue = queues.get(job.role);
    if (queue) { const index = queue.findIndex((queued) => queued.id === id); if (index >= 0) queue.splice(index, 1); renumber(job.role); }
  }
  controllers.get(id)?.abort();
  controllers.delete(id);
  return touch(job, { state: "cancelled", status: "cancelled", reason: "Cancelled by Home.", position: null });
}

export function getJob(id: string): Job | null { return jobs.get(id) ?? null; }
export function listJobs(): Job[] { return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }

/** Waits for a job to settle, up to a deadline; the job keeps running
 * past it (the caller then holds an id to come back for). */
export async function waitForJob(id: string, timeoutMs: number): Promise<Job | null> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const job = jobs.get(id);
    if (!job) return null;
    if (job.state === "done" || job.state === "failed" || job.state === "cancelled") return job;
    if (Date.now() >= deadline) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function __resetJobsForTests(): void {
  for (const controller of controllers.values()) controller.abort();
  controllers.clear(); jobs.clear(); runners.clear(); queues.clear(); inFlight.clear();
}
