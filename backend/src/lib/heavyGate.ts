// ISOLATION-01: chat and voice always win over heavy jobs.
//
// The Stack sees every chat, transcription and speech request itself, so it
// can yield the machine without asking Home: while one is in flight (plus a
// short tail, so the gaps between the rounds of one turn do not flap), the
// heavy worker that is running a job (picture, video, music, image tools) is
// stopped with SIGSTOP and continued with SIGCONT afterwards. The worker
// keeps its memory and loses no work (measured on the Studio: chat back to
// its alone speed, the clip moved again 1.7 s after the resume), and no
// worker changes: every phase of every kind is covered.
//
// Safety rules this module holds, each pinned by tests/heavyGate.test.ts:
// - Only a worker a service attached while it runs a job can be paused,
//   never an arbitrary pid, never the Stack itself, never an engine the
//   supervisor runs (the chat engine and its role-mates).
// - Every way out resumes first: detach, cancel, kill, the deadline, the
//   Stack's shutdown and its exit. A pause is bounded (10 minutes, then a
//   forced resume that is logged); a leaked "request in flight" entry
//   expires on its own. The pids of paused workers are written to a file,
//   so a Stack that was killed while a worker was stopped continues it at
//   its next start.
// - A paused worker's own timers (the job deadline) stop with it, and the
//   job's clock (the progress estimate) leaves the paused time out.
//
// The coding engine (CODE-STACK-01 S3b) is the one engine the gate may stop,
// through the same lease: the supervisor attaches it while a coding request
// is in flight, with three differences, each pinned by tests/codingYield.test.ts:
// - it yields to every interactive request except coding's own (`skipCoding`),
//   with its own tail so a coding request never keeps it stopped;
// - its pause is bounded at 120 s (`maxPauseMs`), then it runs 60 s before
//   chat can stop it again, so coding is slowed in a long chat burst and
//   never starved;
// - the `stack.engines.coding.yield_to_chat` setting turns the yield off
//   (`enabled`), live.
// Only a PausableProcess made with `{ engine: true }` may be an engine; the
// protected-pid list still shields every other engine.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@/lib/log";
import { dataDir } from "@/lib/paths";
import { processTree } from "@/lib/processTree";

/** The roles whose requests are interactive (the turn pipeline and voice). The memory judge, embeddings and rerank are background work and never pause a job. */
export const INTERACTIVE_ROLES = ["chat", "coding", "vision", "router", "stt", "tts"] as const;
export function isInteractiveRole(role: string): boolean { return (INTERACTIVE_ROLES as readonly string[]).includes(role); }

const num = (name: string, fallback: number): number => { const value = Number(process.env[name]); return Number.isFinite(value) && process.env[name] !== undefined && process.env[name] !== "" ? value : fallback; };
export const isolationRules = {
  /** STACK_ISOLATION=off turns the pause off (the bench measures with and without). */
  enabled: (): boolean => process.env.STACK_ISOLATION !== "off",
  /** After the last interactive request ends, the worker waits this long before it continues. */
  tailMs: (): number => num("STACK_ISOLATION_TAIL_MS", 4_000),
  /** The longest one pause lasts; then the worker is continued by force and logged. */
  maxPauseMs: (): number => num("STACK_ISOLATION_MAX_PAUSE_MS", 10 * 60_000),
  /** The longest one pause of the coding engine lasts (a chat request burst); then it is continued by force and runs forcedRunMs before it can be stopped again. */
  codingMaxPauseMs: (): number => num("STACK_ISOLATION_CODING_MAX_PAUSE_MS", 120_000),
  /** Splash probes its native child every 10 s and restarts it (failing the request) when it does not answer within 30 s, so a Splash coding pause stays well under that. */
  codingSplashMaxPauseMs: (): number => num("STACK_ISOLATION_CODING_SPLASH_MAX_PAUSE_MS", 20_000),
  /** After a forced resume the worker runs this long before it can be paused again. */
  forcedRunMs: (): number => num("STACK_ISOLATION_FORCED_RUN_MS", 60_000),
  /** A request that has been in flight this long is a leak (a stream nobody closed), not a conversation; it stops counting. */
  maxInteractiveAgeMs: (): number => num("STACK_ISOLATION_MAX_AGE_MS", 30 * 60_000),
};

/** What the gate may pause: the process behind one running job. */
export interface PausableWorker { readonly pid: number | null; readonly paused: boolean; pause(): boolean; resume(): boolean; }

let protectedPids: () => number[] = () => [];
/** The supervisor says which pids are engines it runs; the gate never stops those. */
export function setProtectedPidProvider(provider: () => number[]): void { protectedPids = provider; }

function safePid(pid: number | null | undefined, engine = false): pid is number {
  if (!pid || !Number.isInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid) return false;
  // An engine the supervisor runs is protected unless its owner made this worker with `engine: true` (the coding engine, S3b).
  if (!engine) { try { if (protectedPids().includes(pid)) return false; } catch { /* the provider is advisory */ } }
  return true;
}

// ---- the file of paused pids, for a Stack that dies while a worker is stopped ----

const pausedFile = (): string => join(dataDir, "isolation-paused.json");
interface PausedEntry { pid: number; command: string; }
const pausedNow = new Map<number, string>();
function commandOf(pid: number): string { try { return Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim(); } catch { return ""; } }
function writePausedFile(): void {
  try {
    if (pausedNow.size === 0) { rmSync(pausedFile(), { force: true }); return; }
    mkdirSync(dataDir, { recursive: true });
    const tmp = `${pausedFile()}.tmp`;
    writeFileSync(tmp, JSON.stringify([...pausedNow].map(([pid, command]): PausedEntry => ({ pid, command }))), { mode: 0o600 });
    renameSync(tmp, pausedFile());
  } catch { /* a read-only disk loses the safety net, never the pause */ }
}

/** At startup: continue any worker an earlier Stack left stopped (it was killed while a worker was paused). The pid counts only if it is still the same command. Returns how many it continued. */
export function recoverPausedWorkers(): number {
  let continued = 0;
  try {
    if (!existsSync(pausedFile())) return 0;
    const entries = JSON.parse(readFileSync(pausedFile(), "utf8")) as PausedEntry[];
    for (const entry of entries) {
      if (!entry || !Number.isInteger(entry.pid) || entry.pid <= 1 || !entry.command || commandOf(entry.pid) !== entry.command) continue;
      try { process.kill(entry.pid, "SIGCONT"); continued++; logger.appendLine(JSON.stringify({ event: "isolation.resumed", pid: entry.pid, reason: "recovered at start" })); } catch { /* gone */ }
    }
  } catch { /* an unreadable file is dropped */ }
  try { rmSync(pausedFile(), { force: true }); } catch { /* gone */ }
  return continued;
}

// ---- the worker side: a process that can be stopped and whose timers stop with it ----

interface DeadlineEntry { fire: () => void; remaining: number; armedAt: number; timer: ReturnType<typeof setTimeout> | null; }

/** Wraps a spawned worker's pid. `kill` and every other way out continue it first, because a stopped process holds a SIGTERM until it runs again.
 * With `tree` the pause and the resume reach the pid and everything it started (Splash is a launcher process and a native engine child, and only the child does the work: CODE-STACK-01 S5a). */
export class PausableProcess implements PausableWorker {
  private isPaused = false;
  private alive = true;
  private readonly deadlines = new Set<DeadlineEntry>();
  private readonly engine: boolean;
  private readonly tree: boolean;
  /** The pids the last pause stopped; the resume continues these and whatever the tree holds by then. */
  private stopped: number[] = [];
  constructor(readonly pid: number | null, exited?: Promise<unknown>, options: { engine?: boolean; tree?: boolean } = {}) {
    this.engine = options.engine === true;
    this.tree = options.tree === true;
    void exited?.then(() => { this.alive = false; this.isPaused = false; for (const stoppedPid of this.stopped) pausedNow.delete(stoppedPid); if (this.pid !== null) pausedNow.delete(this.pid); this.stopped = []; writePausedFile(); }, () => {});
  }
  get paused(): boolean { return this.isPaused; }

  pause(): boolean {
    if (this.isPaused || !this.alive || !safePid(this.pid, this.engine)) return false;
    // The deepest members first, so the process that does the work stops before the one that waits on it.
    const targets = this.tree ? processTree(this.pid).reverse() : [this.pid];
    let any = false;
    for (const target of targets) { try { process.kill(target, "SIGSTOP"); any = true; this.stopped.push(target); } catch { /* gone, or not ours */ } }
    if (!any) return false;
    this.isPaused = true;
    for (const entry of this.deadlines) if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; entry.remaining = Math.max(0, entry.remaining - (Date.now() - entry.armedAt)); }
    for (const target of this.stopped) pausedNow.set(target, commandOf(target));
    writePausedFile();
    return true;
  }

  resume(): boolean {
    if (!this.isPaused) return false;
    this.isPaused = false;
    // The root first (it reads the child's output), then the rest; a member that started during the pause is continued too, which does nothing to one that was never stopped.
    const targets = this.alive && this.pid !== null ? [...new Set([this.pid, ...this.stopped.slice().reverse(), ...(this.tree ? processTree(this.pid) : [])])] : [];
    for (const target of this.stopped) pausedNow.delete(target);
    this.stopped = [];
    writePausedFile();
    for (const target of targets) { try { process.kill(target, "SIGCONT"); } catch { /* gone */ } }
    for (const entry of this.deadlines) this.arm(entry);
    return true;
  }

  /** Runs `stop` (the real kill) with the process running, so the signal is delivered at once. */
  killAfterResume(stop: () => void): void { this.resume(); stop(); }

  private arm(entry: DeadlineEntry): void {
    entry.armedAt = Date.now();
    entry.timer = setTimeout(() => { this.deadlines.delete(entry); entry.timer = null; entry.fire(); }, entry.remaining);
  }

  /** A timer that does not run while the process is stopped: the job deadline, for a job that is waiting on a person's chat and not stuck. */
  deadline(ms: number, fire: () => void): { clear(): void } {
    const entry: DeadlineEntry = { fire, remaining: ms, armedAt: Date.now(), timer: null };
    this.deadlines.add(entry);
    if (!this.isPaused) this.arm(entry);
    return { clear: () => { if (entry.timer) clearTimeout(entry.timer); entry.timer = null; this.deadlines.delete(entry); } };
  }
}

// ---- the gate ----

export interface Lease {
  detach(): void;
  /** Milliseconds this lease has had its worker stopped, including a pause still open. */
  pausedMs(): number;
}
interface LeaseState {
  role: string; jobId: string | null; worker: PausableWorker;
  /** Coding's own requests do not stop this worker (the coding engine). */
  skipCoding: boolean; maxPauseMs: (() => number) | null; enabled: (() => boolean) | null;
  pausedAt: number | null; pausedMs: number; pauses: number;
  forceTimer: ReturnType<typeof setTimeout> | null; repauseTimer: ReturnType<typeof setTimeout> | null; exemptUntil: number;
}

export interface IsolationStatus { enabled: boolean; paused_now: number; interactive_in_flight: number; pauses: number; resumes: number; forced_resumes: number; paused_seconds: number; }

type Observer = (jobId: string, paused: boolean) => void;

class HeavyGate {
  private readonly leases = new Set<LeaseState>();
  private readonly interactive = new Map<number, { role: string; at: number }>();
  private nextId = 1;
  private tailTimer: ReturnType<typeof setTimeout> | null = null;
  /** The tail after the last interactive request that is not coding's own, for the leases that skip coding. */
  private tailTimerOthers: ReturnType<typeof setTimeout> | null = null;
  private observer: Observer = () => {};
  private readonly stats = { pauses: 0, resumes: 0, forced: 0, pausedMs: 0 };
  private readonly pausedByJob = new Map<string, { ms: number; since: number | null }>();

  /** The jobs module shows "paused" on the job card through this. */
  setObserver(observer: Observer): void { this.observer = observer; }

  status(): IsolationStatus {
    this.prune();
    const openMs = [...this.leases].reduce((sum, lease) => sum + (lease.pausedAt === null ? 0 : Date.now() - lease.pausedAt), 0);
    return { enabled: isolationRules.enabled(), paused_now: [...this.leases].filter((lease) => lease.pausedAt !== null).length, interactive_in_flight: this.interactive.size, pauses: this.stats.pauses, resumes: this.stats.resumes, forced_resumes: this.stats.forced, paused_seconds: Math.round((this.stats.pausedMs + openMs) / 100) / 10 };
  }

  private prune(): void {
    const cutoff = Date.now() - isolationRules.maxInteractiveAgeMs();
    for (const [id, entry] of this.interactive) if (entry.at < cutoff) { this.interactive.delete(id); logger.appendLine(JSON.stringify({ event: "isolation.request_expired", role: entry.role })); }
  }

  private active(): boolean { return isolationRules.enabled() && (this.interactive.size > 0 || this.tailTimer !== null); }

  /** Interactive requests in flight that are not coding's own. */
  private othersInFlight(): number { let count = 0; for (const entry of this.interactive.values()) if (entry.role !== "coding") count++; return count; }

  /** Whether requests (or their tail) say this lease's worker should be stopped now. A lease that skips coding looks only at the requests that are not coding's. */
  private demands(lease: LeaseState): boolean {
    if (!isolationRules.enabled()) return false;
    return lease.skipCoding ? this.othersInFlight() > 0 || this.tailTimerOthers !== null : this.interactive.size > 0 || this.tailTimer !== null;
  }

  /** A chat, transcription or speech request starts (or a voice session opens). Call the returned function once when it ends, however it ends; calling it again does nothing. */
  begin(role: string): () => void {
    if (!isolationRules.enabled() || !isInteractiveRole(role)) return () => {};
    this.prune();
    const id = this.nextId++;
    this.interactive.set(id, { role, at: Date.now() });
    if (this.tailTimer) { clearTimeout(this.tailTimer); this.tailTimer = null; }
    if (role !== "coding" && this.tailTimerOthers) { clearTimeout(this.tailTimerOthers); this.tailTimerOthers = null; }
    this.pauseAll(role);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.interactive.delete(id);
      const tail = isolationRules.tailMs();
      // Leases that skip coding are quiet when no request but coding's is in flight.
      if (role !== "coding" && this.othersInFlight() === 0 && !this.tailTimerOthers) {
        if (tail <= 0) this.resumeAll("quiet", true);
        else this.tailTimerOthers = setTimeout(() => { this.tailTimerOthers = null; if (this.othersInFlight() === 0) this.resumeAll("quiet", true); }, tail);
      }
      if (this.interactive.size > 0 || this.tailTimer) return;
      if (tail <= 0) { this.resumeAll("quiet"); return; }
      this.tailTimer = setTimeout(() => { this.tailTimer = null; if (this.interactive.size === 0) this.resumeAll("quiet"); }, tail);
    };
  }

  /** A service attaches the worker that is running a job; the lease ends with `detach` (in a finally). A job that starts while a chat is in flight is paused at once. */
  attach(info: { role: string; jobId?: string | null; worker: PausableWorker | undefined | null; skipCoding?: boolean; maxPauseMs?: () => number; enabled?: () => boolean }): Lease {
    if (!info.worker) return { detach: () => {}, pausedMs: () => 0 };
    const lease: LeaseState = { role: info.role, jobId: info.jobId ?? null, worker: info.worker, skipCoding: info.skipCoding === true, maxPauseMs: info.maxPauseMs ?? null, enabled: info.enabled ?? null, pausedAt: null, pausedMs: 0, pauses: 0, forceTimer: null, repauseTimer: null, exemptUntil: 0 };
    this.leases.add(lease);
    this.prune();
    if (this.demands(lease)) this.pauseLease(lease);
    return { detach: () => this.detachLease(lease), pausedMs: () => lease.pausedMs + (lease.pausedAt === null ? 0 : Date.now() - lease.pausedAt) };
  }

  private detachLease(lease: LeaseState): void {
    this.resumeLease(lease, "job ended");
    if (lease.forceTimer) clearTimeout(lease.forceTimer);
    if (lease.repauseTimer) clearTimeout(lease.repauseTimer);
    lease.forceTimer = lease.repauseTimer = null;
    this.leases.delete(lease);
  }

  /** A request of `role` began: stop every worker it outranks. Coding's own request does not stop a lease that skips coding. */
  private pauseAll(role: string): void { for (const lease of this.leases) if (!(lease.skipCoding && role === "coding")) this.pauseLease(lease); }
  /** `others`: only the leases that skip coding (their own quiet moment). Otherwise every lease, except one that skips coding while its own tail still runs. */
  private resumeAll(reason: string, others = false): void {
    for (const lease of this.leases) {
      if (others && !lease.skipCoding) continue;
      if (!others && lease.skipCoding && (this.othersInFlight() > 0 || this.tailTimerOthers)) continue;
      this.resumeLease(lease, reason);
    }
  }

  /** The setting that lets a lease yield changed: a lease that is paused and no longer allowed to yield continues now. */
  recheck(): void { for (const lease of this.leases) if (lease.pausedAt !== null && lease.enabled && !this.safeEnabled(lease)) this.resumeLease(lease, "yielding turned off"); }

  private safeEnabled(lease: LeaseState): boolean { try { return lease.enabled ? lease.enabled() : true; } catch { return true; } }

  private pauseLease(lease: LeaseState): void {
    if (lease.pausedAt !== null || Date.now() < lease.exemptUntil || !this.safeEnabled(lease)) return;
    if (!lease.worker.pause()) return;
    lease.pausedAt = Date.now(); lease.pauses++; this.stats.pauses++;
    if (lease.jobId) { const entry = this.pausedByJob.get(lease.jobId) ?? { ms: 0, since: null }; entry.since = lease.pausedAt; this.remember(lease.jobId, entry); }
    logger.appendLine(JSON.stringify({ event: "isolation.paused", job: lease.jobId, role: lease.role, pid: lease.worker.pid, interactive: this.interactive.size }));
    if (lease.jobId) this.safely(lease.jobId, true);
    lease.forceTimer = setTimeout(() => this.forceResume(lease), (lease.maxPauseMs ?? isolationRules.maxPauseMs)());
  }

  private resumeLease(lease: LeaseState, reason: string, forced = false): void {
    if (lease.pausedAt === null) { lease.worker.resume(); return; }
    const seconds = (Date.now() - lease.pausedAt) / 1000;
    lease.worker.resume();
    lease.pausedMs += Date.now() - lease.pausedAt; this.stats.pausedMs += Date.now() - lease.pausedAt; this.stats.resumes++;
    lease.pausedAt = null;
    if (lease.forceTimer) { clearTimeout(lease.forceTimer); lease.forceTimer = null; }
    if (lease.jobId) { const entry = this.pausedByJob.get(lease.jobId); if (entry && entry.since !== null) { entry.ms += Date.now() - entry.since; entry.since = null; } }
    logger.appendLine(JSON.stringify({ event: "isolation.resumed", job: lease.jobId, role: lease.role, pid: lease.worker.pid, paused_seconds: Math.round(seconds * 10) / 10, reason, ...(forced ? { forced: true } : {}) }));
    if (lease.jobId) this.safely(lease.jobId, false);
  }

  /** The bound: a pause that has lasted too long is ended by force and logged; the worker then runs for a while before a request can stop it again. */
  private forceResume(lease: LeaseState): void {
    if (lease.pausedAt === null) return;
    const seconds = Math.round((Date.now() - lease.pausedAt) / 100) / 10;
    this.stats.forced++;
    logger.appendLine(JSON.stringify({ event: "isolation.resume_forced", job: lease.jobId, role: lease.role, paused_seconds: seconds, interactive: this.interactive.size }));
    this.resumeLease(lease, "maximum pause", true);
    lease.exemptUntil = Date.now() + isolationRules.forcedRunMs();
    lease.repauseTimer = setTimeout(() => { lease.repauseTimer = null; this.prune(); if (this.demands(lease)) this.pauseLease(lease); }, isolationRules.forcedRunMs() + 1);
  }

  /** Continues every worker now: the Stack is shutting down or exiting. */
  resumeEverything(reason = "shutdown"): void {
    if (this.tailTimer) { clearTimeout(this.tailTimer); this.tailTimer = null; }
    if (this.tailTimerOthers) { clearTimeout(this.tailTimerOthers); this.tailTimerOthers = null; }
    for (const lease of this.leases) this.resumeLease(lease, reason);
  }

  private safely(jobId: string, paused: boolean): void { try { this.observer(jobId, paused); } catch { /* the card is a nicety; the pause is the point */ } }

  private remember(jobId: string, entry: { ms: number; since: number | null }): void {
    this.pausedByJob.set(jobId, entry);
    while (this.pausedByJob.size > 100) this.pausedByJob.delete(this.pausedByJob.keys().next().value as string);
  }

  /** A job's own clock and pause flag: the progress estimate counts time the job could run, not time it waited for chat. */
  pacing(jobId: string, base: () => number = Date.now): { now: () => number; paused: () => boolean } {
    const pausedMs = (): number => { const entry = this.pausedByJob.get(jobId); return entry ? entry.ms + (entry.since === null ? 0 : Date.now() - entry.since) : 0; };
    return { now: () => base() - pausedMs(), paused: () => (this.pausedByJob.get(jobId)?.since ?? null) !== null };
  }

  /** For the suite. */
  reset(): void {
    this.resumeEverything("reset");
    for (const lease of this.leases) { if (lease.forceTimer) clearTimeout(lease.forceTimer); if (lease.repauseTimer) clearTimeout(lease.repauseTimer); }
    this.leases.clear(); this.interactive.clear(); this.pausedByJob.clear();
    if (this.tailTimer) clearTimeout(this.tailTimer);
    if (this.tailTimerOthers) clearTimeout(this.tailTimerOthers);
    this.tailTimer = null; this.tailTimerOthers = null;
    this.stats.pauses = this.stats.resumes = this.stats.forced = this.stats.pausedMs = 0;
  }
}

export const heavyGate = new HeavyGate();

/** Counts a chat or voice request for as long as `work` runs. */
export async function whileInteractive<T>(role: string, work: () => Promise<T>): Promise<T> {
  const end = heavyGate.begin(role);
  try { return await work(); } finally { end(); }
}

/** Passes a stream through and ends the request when it finishes, fails or is cancelled (the person closed the page). A null body ends it at once. */
export function endWithStream(body: ReadableStream<Uint8Array> | null, end: () => void): ReadableStream<Uint8Array> | null {
  if (!body) { end(); return body; }
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { end(); controller.close(); } else controller.enqueue(next.value);
      } catch (error) { end(); controller.error(error); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { end(); } },
  });
}

// A Stack that exits for any reason leaves no worker stopped.
process.on("exit", () => { try { heavyGate.resumeEverything("exit"); } catch { /* nothing more to do */ } });

/** The longest one pause of the coding engine named `engine` lasts. */
export function codingPauseBoundMs(engine: string | null): number {
  return engine === "splash" ? Math.min(isolationRules.codingMaxPauseMs(), isolationRules.codingSplashMaxPauseMs()) : isolationRules.codingMaxPauseMs();
}
