// The job queue Home's generator packages and the download routes share:
// submit, progress on the feed, cancel, result by id. The shape is the
// spec's StackJob. A generator job (image, video, music) waits in its
// role's queue, one in flight per role, and runs only once the governor
// admits it (one generator at a time across roles, the budget's say);
// a never-fit request fails with the governor's reason; a fitting request
// stays queued until memory frees or the person cancels. A download or an
// install created by another module runs as that module drives it. Until a runner is registered for a kind, a
// submit for it is refused with a reason rather than left queued.
import { emit } from "@/lib/events";
import { noteComponentUse } from "@/lib/componentUse";
import { admit, fitsEver, generatorsHeldByMode, getRunState, neverFitReason, peakFor, release, withdraw, type GovernorHandle, type GovernorRequest } from "@/lib/governor";
import { heavyGate, isolationRules } from "@/lib/heavyGate";
import { memoryLevel, PAUSED_LOW_MEMORY, waitingText } from "@/lib/memoryState";
import { ROLES } from "@/roles";
import { StackJob, StackJobState } from "@maipai/spec/stack/ts/stack-job.js";

export const JobStateSchema = StackJobState;
export type JobState = StackJobState;
export const JobSchema = StackJob;
export type Job = StackJob;

export type JobProgress = (update: Partial<Pick<Job, "percent" | "completedBytes" | "totalBytes" | "bytesPerSecond" | "items" | "status" | "state">>) => void;
export type JobRunner = (job: Job, signal: AbortSignal, progress: JobProgress) => Promise<unknown>;

/** What a generator runner needs the governor to hold for a job: the
 * peak it expects, the model file it loads and its engine (the
 * governor's multiplier), or a measured peak. */
export interface JobMemory { requestedBytes: number; modelFileBytes?: number | null; measuredPeakBytes?: number | null; engine?: string; }
/** A refusal at submit time carries a stable code Home can branch on. */
export type JobRefusal = { reason: string; code?: string; /** 422 when the input is not acceptable (a bad path, a bad field), 503 (the default) when the Stack cannot take the job now. */ status?: 422 | 503 };
/** The idle lane (MEDIA-STACK-01): one job at a time, first in first out,
 * for work that must never compete with the household's own requests
 * (media probes, fetches, transcodes). Its rules, ported from FileTube's
 * heavyGate and pinned by tests/mediaLane.test.ts:
 * - the queue has a cap; past it a submit is refused with a reason;
 * - a cancelled queued job leaves the queue; a cancelled running job frees
 *   the lane at once, whatever its runner does with the abort;
 * - a runner that throws, rejects or never settles cannot hold the lane:
 *   the lane moves on when it settles, is cancelled, or passes its deadline. */
export interface JobLane { name: string; cap: number; deadlineMs?: (job: Job) => number; precheck?: (input: Record<string, unknown>) => JobRefusal | null; }
export interface JobRunnerOptions {
  /** A generator: queued per role and admitted through the governor. */
  generator?: { role: string; memory: (job: Job) => JobMemory };
  /** Work on an idle lane: queued first in first out, one at a time. */
  lane?: JobLane;
}

/** A runner throws this to fail its job and still hand Home a structured result (a code to branch on). */
/** What a person is told when picture, video and music work is held back for the large coding mode. Plain words: no mention of modes. */
export const REFUSED_BY_MODE_TEXT = "Home is busy with a big job right now, so pictures, videos and songs are paused. Please try again later.";
/** The status line of a job that was already waiting when the hold began. */
export const HELD_BY_MODE_TEXT = "Home is busy with a big job. This starts again when it is done.";

export class JobFailure extends Error {
  constructor(message: string, readonly result?: unknown) { super(message); }
}

interface RegisteredRunner { run: JobRunner; options: JobRunnerOptions; }

const jobs = new Map<string, Job>();
const controllers = new Map<string, AbortController>();
const runners = new Map<string, RegisteredRunner>();
/** Queued generator jobs per role, in submission order. */
const queues = new Map<string, Job[]>();
/** The generator job in flight per role, if any. */
const inFlight = new Map<string, string>();
const pumping = new Set<string>();
/** Queued jobs per idle lane, the job running on each lane, and the settle function that frees a running job's lane (callable once). */
const laneQueues = new Map<string, Job[]>();
const laneRunning = new Map<string, string>();
const laneSettles = new Map<string, () => void>();
const laneTimers = new Map<string, ReturnType<typeof setTimeout>>();
const KEEP_FINISHED = 200;
let queueNow = Date.now;
let queueSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Test clock for the start-rule wait. */
export function __setJobQueueTimingForTests(options: { now?: () => number; sleep?: (ms: number) => Promise<void> } | null): void {
  queueNow = options?.now ?? Date.now;
  queueSleep = options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

async function waitToStart(role: string): Promise<void> {
  let quietSince: number | null = null;
  let observedInteractive = false;
  while (true) {
    if (!(queues.get(role)?.length)) return;
    const interactive = heavyGate.status().interactive_in_flight > 0;
    if (interactive) observedInteractive = true;
    const level = memoryLevel();
    if (level !== "normal" || interactive) {
      quietSince = null;
      await queueSleep(25);
      continue;
    }
    if (!observedInteractive) return;
    if (quietSince === null) quietSince = queueNow();
    const remaining = isolationRules.tailMs() - (queueNow() - quietSince);
    if (remaining <= 0) return;
    await queueSleep(Math.min(25, remaining));
  }
}

/** ISOLATION-01: the job card's stage string while the Stack has stopped the worker so a chat or voice request runs at full speed (rule S6: the existing status field, no new surface). */
export const PAUSED_FOR_CHAT = "paused: chat";
/** Running jobs that are paused, with the stage they were in (restored on resume; a stage that arrives meanwhile is remembered, not shown). */
const pausedJobs = new Map<string, { status: string }>();
export function isJobPaused(id: string): boolean { return pausedJobs.has(id); }
heavyGate.setObserver((id, paused) => {
  const job = jobs.get(id);
  if (!job || job.state !== "running") { pausedJobs.delete(id); return; }
  if (paused) { pausedJobs.set(id, { status: job.status }); touch(job, { status: PAUSED_FOR_CHAT }); return; }
  const before = pausedJobs.get(id);
  pausedJobs.delete(id);
  touch(job, { status: before?.status ?? job.status });
});

export function registerJobRunner(kind: string, runner: JobRunner, options: JobRunnerOptions = {}): void { runners.set(kind, { run: runner, options }); }
export function hasJobRunner(kind: string): boolean { return runners.has(kind); }

function touch(job: Job, patch: Partial<Job>): Job {
  const next = { ...job, ...patch, updatedAt: new Date().toISOString() };
  jobs.set(job.id, next);
  emit({ id: "job.progress", data: { job: next.id, kind: next.kind, state: next.state, percent: next.percent, completed_bytes: next.completedBytes, total_bytes: next.totalBytes, status: next.status, position: next.position, ...(next.bytesPerSecond === undefined ? {} : { bytesPerSecond: next.bytesPerSecond }), ...(next.items === undefined ? {} : { items: next.items }) } });
  if (next.state === "done" || next.state === "failed" || next.state === "cancelled") {
    emit({ id: "job.done", data: { job: next.id, kind: next.kind, ok: next.state === "done", reason: next.reason } });
    prune();
  }
  return next;
}

function prune(): void {
  const finished = [...jobs.values()].filter((job) => job.state !== "queued" && job.state !== "running" && job.state !== "stalled").sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  while (finished.length > KEEP_FINISHED) { const oldest = finished.shift(); if (oldest) jobs.delete(oldest.id); }
}

/** Creates a job record for work another module drives (a download):
 * the caller reports progress with `updateJob` and finishes it. */
export function createJob(input: { kind: string; role?: string | null; totalBytes?: number; bytesPerSecond?: number; items?: Job["items"]; status?: string; input?: Record<string, unknown> | null; id?: string; state?: JobState; position?: number | null }): Job {
  const now = new Date().toISOString();
  const job: Job = { id: input.id ?? `job-${crypto.randomUUID()}`, kind: input.kind, role: input.role ?? null, state: input.state ?? "running", percent: 0, completedBytes: 0, totalBytes: input.totalBytes ?? 0, ...(input.bytesPerSecond === undefined ? {} : { bytesPerSecond: input.bytesPerSecond }), ...(input.items === undefined ? {} : { items: input.items }), status: input.status ?? "starting", position: input.position ?? null, input: input.input ?? null, result: null, reason: null, createdAt: now, updatedAt: now };
  jobs.set(job.id, job);
  controllers.set(job.id, new AbortController());
  emit({ id: "job.progress", data: { job: job.id, kind: job.kind, state: job.state, percent: 0, completed_bytes: 0, total_bytes: job.totalBytes, status: job.status, position: job.position, ...(job.bytesPerSecond === undefined ? {} : { bytesPerSecond: job.bytesPerSecond }), ...(job.items === undefined ? {} : { items: job.items }) } });
  return job;
}

/** The signal a download driven by another module passes down, so a
 * cancel through the jobs route stops the bytes, not just the record. */
export function jobSignal(id: string): AbortSignal | undefined { return controllers.get(id)?.signal; }

export function updateJob(id: string, patch: Partial<Pick<Job, "percent" | "completedBytes" | "totalBytes" | "bytesPerSecond" | "items" | "status" | "state">>): Job | null {
  const job = jobs.get(id);
  if (!job || (job.state !== "running" && job.state !== "stalled")) return null;
  const totalBytes = patch.totalBytes ?? job.totalBytes;
  const completedBytes = patch.completedBytes ?? job.completedBytes;
  const percent = patch.percent ?? (totalBytes > 0 ? Math.min(100, Math.round((completedBytes / totalBytes) * 100)) : job.percent);
  // A stage that arrives while the worker is stopped is kept for the resume; the card keeps saying why it waits.
  const paused = pausedJobs.get(id);
  if (paused && patch.status !== undefined) { paused.status = patch.status; return touch(job, { ...patch, status: PAUSED_FOR_CHAT, totalBytes, completedBytes, percent }); }
  return touch(job, { ...patch, totalBytes, completedBytes, percent });
}

export function finishJob(id: string, outcome: { ok: true; result?: unknown } | { ok: false; reason: string; status?: string; result?: unknown }): Job | null {
  const job = jobs.get(id);
  controllers.delete(id);
  pausedJobs.delete(id);
  if (!job || (job.state !== "running" && job.state !== "queued" && job.state !== "stalled")) return null;
  // A finished picture or clip counts as use of its model family.
  if (outcome.ok && job.kind !== "component.install" && job.kind !== "model.install") { const input = job.input as { family?: unknown; model?: unknown } | null; noteComponentUse(typeof input?.family === "string" ? input.family : typeof input?.model === "string" ? input.model : job.kind.startsWith("video") ? "fastwan2-2-ti2v-5b-mlx-bf16" : job.kind.startsWith("music") ? "ace-step-1-5-turbo" : null); }
  return outcome.ok ? touch(job, { state: "done", percent: 100, status: "done", ...(job.items ? { items: job.items.map((item) => ({ ...item, completedBytes: item.totalBytes, state: "done" as const })) } : {}), result: outcome.result ?? null, position: null }) : touch(job, { state: "failed", status: outcome.status ?? "failed", ...(job.items ? { items: job.items.map((item) => item.state === "done" ? item : { ...item, state: "failed" as const }) } : {}), reason: outcome.reason, ...(outcome.result === undefined ? {} : { result: outcome.result }), position: null });
}

/** Submits work to a registered runner. A generator kind is queued for
 * its role and admitted through the governor; anything else runs at
 * once. Returns the job, or a refusal with the reason when nothing on
 * this machine can run the kind. */
export function submitJob(input: { kind: string; role?: string | null; input?: Record<string, unknown> }): { job: Job } | ({ refused: true } & JobRefusal) {
  const runner = runners.get(input.kind);
  if (!runner) return { refused: true, reason: `No engine on this machine can run ${input.kind} jobs yet.` };
  if (runner.options.lane) {
    const lane = runner.options.lane;
    const refusal = lane.precheck?.(input.input ?? {}) ?? null;
    if (refusal) return { refused: true, ...refusal };
    const queue = laneQueues.get(lane.name) ?? [];
    laneQueues.set(lane.name, queue);
    if (queue.length >= lane.cap) return { refused: true, code: "queue_full", reason: `The ${lane.name} queue is full (${queue.length} jobs are waiting). Try again when some have finished.` };
    const job = createJob({ kind: input.kind, role: input.role ?? null, input: input.input ?? null, status: "queued", state: "queued", position: queue.length + 1 });
    queue.push(job);
    void pumpLane(lane.name);
    return { job: jobs.get(job.id)! };
  }
  if (runner.options.generator && generatorsHeldByMode()) return { refused: true, code: "coding_mode", reason: REFUSED_BY_MODE_TEXT };
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
  // A runner that throws before its first await fails its job like one that rejects.
  let started: Promise<unknown>;
  try { started = Promise.resolve(runner.run(jobs.get(job.id) ?? job, controller.signal, (update) => { updateJob(job.id, update); })); } catch (error) { started = Promise.reject(error); }
  void started
    .then((result) => { if (!controller.signal.aborted) finishJob(job.id, { ok: true, result }); })
    .catch((error) => { if (!controller.signal.aborted) finishJob(job.id, { ok: false, reason: error instanceof Error ? error.message : String(error), ...(error instanceof JobFailure && error.result !== undefined ? { result: error.result } : {}) }); })
    .finally(() => { controllers.delete(job.id); onSettled(); });
}

/** Runs the next queued job of an idle lane when none is running. The lane
 * is freed exactly once per job (`settle`): when the runner settles, when
 * the job is cancelled, or when its deadline passes, whichever is first. */
function pumpLane(name: string): void {
  if (laneRunning.has(name)) return;
  const queue = laneQueues.get(name) ?? [];
  const next = queue.shift();
  if (!next) return;
  queue.forEach((job, index) => { const current = jobs.get(job.id); if (current && current.state === "queued" && current.position !== index + 1) touch(current, { position: index + 1 }); });
  const current = jobs.get(next.id);
  const runner = runners.get(next.kind);
  if (!current || current.state !== "queued") { pumpLane(name); return; }
  if (!runner?.options.lane) { finishJob(next.id, { ok: false, reason: `No runner is registered for ${next.kind} jobs.` }); pumpLane(name); return; }
  laneRunning.set(name, next.id);
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    const timer = laneTimers.get(next.id); if (timer) clearTimeout(timer);
    laneTimers.delete(next.id); laneSettles.delete(next.id);
    if (laneRunning.get(name) === next.id) laneRunning.delete(name);
    pumpLane(name);
  };
  laneSettles.set(next.id, settle);
  const started = touch({ ...current, position: null }, { state: "running", status: "starting", position: null });
  const deadline = runner.options.lane.deadlineMs?.(started);
  if (deadline && deadline > 0) {
    laneTimers.set(next.id, setTimeout(() => {
      const live = jobs.get(next.id);
      if (live && live.state === "running") { controllers.get(next.id)?.abort(); finishJob(next.id, { ok: false, reason: `The job took longer than ${Math.round(deadline / 60_000)} minutes and was stopped so the next one could run.` }); }
      settle();
    }, deadline));
  }
  run(started, runner, settle);
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
  if (inFlight.has(role) || pumping.has(role)) return;
  if (!(queues.get(role)?.length)) return;
  if (heavyGate.status().interactive_in_flight > 0 || memoryLevel() !== "normal") {
    pumping.add(role);
    await waitToStart(role);
    pumping.delete(role);
    if (inFlight.has(role)) return;
  }
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
    handle = await admitJob(next.id, { id: next.id, role, class: ROLES[role as keyof typeof ROLES]?.memoryClass ?? "burst", kind: "generator", ...runner.options.generator.memory(jobs.get(next.id)!) });
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
  return peakFor(request).bytes;
}

/** The governor's answer for one job: the handle once admitted, a
 * thrown reason when refused, or a thrown reason when the job was
 * cancelled or the Stack paused while waiting. The wait is a bare
 * await on the governor's own promise, which its poll settles when
 * memory frees; a cancel or a pause withdraws the request. */
async function admitJob(jobId: string, request: GovernorRequest): Promise<GovernorHandle> {
  // A peak the budget can never hold is refused now with the numbers,
  // not queued for memory that will not come.
  const peak = governorPeak(request);
  if (!fitsEver(request)) throw new Error(neverFitReason(request));
  const controller = controllers.get(jobId);
  const answer = await admit(request);
  if ("refused" in answer) throw new Error(answer.reason);
  if (!("queued" in answer)) return answer;
  updateJob(jobId, { status: generatorsHeldByMode() ? HELD_BY_MODE_TEXT : waitingText(peak, answer.position) });
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

export function __setAdmissionWaitForTests(_ms: number | null): void {}



export function cancelJob(id: string): Job | null {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.state !== "queued" && job.state !== "running" && job.state !== "stalled") return job;
  if (job.role && job.state === "queued") {
    const queue = queues.get(job.role);
    if (queue) { const index = queue.findIndex((queued) => queued.id === id); if (index >= 0) queue.splice(index, 1); renumber(job.role); }
  }
  if (job.state === "queued") {
    for (const queue of laneQueues.values()) {
      const index = queue.findIndex((queued) => queued.id === id);
      if (index < 0) continue;
      queue.splice(index, 1);
      queue.forEach((waiting, at) => { const current = jobs.get(waiting.id); if (current && current.position !== at + 1) touch(current, { position: at + 1 }); });
    }
  }
  controllers.get(id)?.abort();
  controllers.delete(id);
  pausedJobs.delete(id);
  const cancelled = touch(job, { state: "cancelled", status: "cancelled", reason: "Cancelled by Home.", position: null });
  // A running lane job frees its lane now; its runner may take a moment to stop its process, and the next job does not wait for that.
  laneSettles.get(id)?.();
  return cancelled;
}

/** The watchdog's way to stop generative work for memory. A queued job is cancelled before it starts; a running one has its signal aborted, which makes its runner stop the worker and remove its partial files (every runner cleans up in a finally). The record says plainly why. Running jobs go video first, then the rest. */
export function cancelGeneratorsForMemory(scope: "queued" | "running", reason: string, status = PAUSED_LOW_MEMORY): string[] {
  const stopped: string[] = [];
  const ids: string[] = [];
  if (scope === "queued") for (const queue of queues.values()) for (const queued of queue) ids.push(queued.id);
  else ids.push(...inFlight.values());
  ids.sort((a, b) => Number(/video/i.test(jobs.get(b)?.kind ?? "")) - Number(/video/i.test(jobs.get(a)?.kind ?? "")));
  for (const id of ids) {
    const job = jobs.get(id);
    if (!job || (job.state !== "queued" && job.state !== "running" && job.state !== "stalled")) continue;
    if (scope === "queued" && job.state === "queued") {
      const queue = job.role ? queues.get(job.role) : undefined;
      const index = queue?.findIndex((queued) => queued.id === id) ?? -1;
      if (queue && index >= 0) queue.splice(index, 1);
      if (job.role) renumber(job.role);
    }
    controllers.get(id)?.abort();
    controllers.delete(id);
    pausedJobs.delete(id);
    touch(job, { state: "cancelled", status, reason, position: null });
    stopped.push(id);
    // One running job per pass: the caller asks again if memory is still short.
    if (scope === "running") break;
  }
  return stopped;
}

/** The kind of the generator job in flight (the watchdog names it in its action log). */
export function runningGeneratorKinds(): string[] { return [...inFlight.values()].map((id) => jobs.get(id)?.kind ?? "").filter(Boolean); }

/** An idle lane's depth, for the status route. */
export function laneStatus(name: string): { queued: number; running: string | null } { return { queued: laneQueues.get(name)?.length ?? 0, running: laneRunning.get(name) ?? null }; }
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
  for (const timer of laneTimers.values()) clearTimeout(timer);
  controllers.clear(); pausedJobs.clear(); jobs.clear(); runners.clear(); queues.clear(); inFlight.clear(); pumping.clear();
  __setJobQueueTimingForTests(null);
  laneQueues.clear(); laneRunning.clear(); laneSettles.clear(); laneTimers.clear();
}
