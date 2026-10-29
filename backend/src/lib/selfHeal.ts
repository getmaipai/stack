// ROBUST-01: an engine that stops on its own is restarted by the Stack,
// not left for a person to find. The supervisor reports every unexpected
// exit here; this controller restarts the role with a growing wait (2 s,
// 10 s, 30 s, 2 min, 5 min), gives up after 5 failures in 30 minutes and
// leaves the Repairs item with its "Restart engine" fix and the last log
// lines, and starts counting again once a restarted engine has stayed up
// for 10 minutes. It never restarts into an install, an update or a job
// that owns the graphics processor, and it waits out low memory instead
// of thrashing against it. One restart runs at a time, so two engines
// that died together do not load together. A restart counts as healed
// only after the role answers as the model the Stack selected.
//
// Nothing here is shown by itself: the facts go to the existing Repairs
// item, the engine state the chat pause reads, and a short event record
// (GET /stack/v1/engines/self-heal) Home turns into one Notification and
// the Status page's crash counts.
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { meta } from "@/db/schema";
import { raise, resolve as resolveHealth } from "@/lib/health";
import { logger } from "@/lib/log";
import { listJobs, runningGeneratorKinds } from "@/lib/jobs";
import { lowMemoryRefusal } from "@/lib/memoryState";
import { classifyCrash, HOST_FAULT_VERDICT, isHostFault, type CrashVerdict } from "@/lib/crashClassifier";
import { getRunState } from "@/lib/governor";
import { settingValues } from "@/settings";
import { healStart, recycleRole, isStoppingAll, offlineRolesWithoutProcess, roleGeneration, roleHasProcess, roleManuallyStopped, setCrashListener, setRestartListener, type CrashReport } from "@/lib/supervisor";
import type { RoleId } from "@/roles";

export const SELF_HEAL_RULES = {
  backoffMs: [2_000, 10_000, 30_000, 120_000, 300_000],
  /** Failures (crashes and failed restarts) inside the window that open the circuit breaker. */
  maxFailures: 5,
  windowMs: 30 * 60_000,
  /** A restarted engine that stays up this long wipes its failure count. */
  healthyResetMs: 10 * 60_000,
  /** How often a restart that is held back (install, low memory) looks again. */
  gateRecheckMs: 15_000,
  /** How often a restart held back by a host fault (the Metal compiler not answering) looks again. */
  hostFaultRecheckMs: 60_000,
  /** How often the sweep looks for a role that is offline with no process. */
  sweepMs: 20_000,
} as const;
type Rules = { -readonly [K in keyof typeof SELF_HEAL_RULES]: (typeof SELF_HEAL_RULES)[K] extends readonly number[] ? number[] : number };
let rules: Rules = { ...SELF_HEAL_RULES, backoffMs: [...SELF_HEAL_RULES.backoffMs] };

/** Roles that load on a request and are evicted when idle: a crash of one
 * with nobody using it needs no restart; the next request starts it. */
const ON_DEMAND_ROLES: RoleId[] = ["vision", "coding", "image"];

export interface Clock { now(): number; after(ms: number, run: () => void): () => void; }
const realClock: Clock = {
  now: () => Date.now(),
  after(ms, run) { const timer = setTimeout(run, ms); (timer as unknown as { unref?: () => void }).unref?.(); return () => clearTimeout(timer); },
};
let clock: Clock = realClock;

export type HealEventKind = "crashed" | "healed" | "gave_up" | "requested_by_canary";
export interface HealEvent {
  /** Stable per incident (role and crash time), so Home notifies once. */
  id: string;
  kind: HealEventKind;
  at: string;
  role: RoleId;
  cause: string;
  causeKind: string;
  /** healed: seconds from the crash to a verified ready role. */
  seconds?: number;
  crashedAt?: string;
  attempts?: number;
}

interface RoleHeal {
  failures: number[];
  lastReadyAt: number | null;
  cancel: (() => void) | null;
  attempting: boolean;
  open: boolean;
  crashedAt: number | null;
  verdict: CrashVerdict | null;
  tail: string[];
  /** The generation the retry was scheduled for; a hand restart moves it. */
  generation: number;
}
const states = new Map<RoleId, RoleHeal>();
let chain: Promise<void> = Promise.resolve();
const holds = new Map<symbol, string>();

function state(role: RoleId): RoleHeal {
  let current = states.get(role);
  if (!current) { current = { failures: [], lastReadyAt: null, cancel: null, attempting: false, open: false, crashedAt: null, verdict: null, tail: [], generation: 0 }; states.set(role, current); }
  return current;
}

export function selfHealEnabled(): boolean { return settingValues()["stack.runtime.self_heal"] !== false; }

/** An installer or an update holds the heal back while it runs (a restart into a half-swapped build helps nobody). Call the returned function when it ends. */
export function holdSelfHeal(reason: string): () => void {
  const key = Symbol(reason);
  holds.set(key, reason);
  return () => { holds.delete(key); };
}

const HOLD_JOB = /\.(install|stage)$/;
/** Why a restart must wait right now, or null. Memory is checked here too: under pressure a restart would only be killed again. */
export function healBlocker(): string | null {
  if (isStoppingAll()) return "The Stack is stopping.";
  if (getRunState() !== "running") return "The Stack is paused.";
  const hold = [...holds.values()][0];
  if (hold) return `${hold} is running.`;
  const install = listJobs().find((job) => (job.state === "queued" || job.state === "running" || job.state === "stalled") && HOLD_JOB.test(job.kind));
  if (install) return `An install (${install.kind}) is running.`;
  if (runningGeneratorKinds().length > 0) return "A picture or video job is using the graphics processor.";
  const memory = lowMemoryRefusal();
  if (memory) return "The computer is low on memory.";
  return null;
}

// ---- the event record -------------------------------------------------------

const EVENTS_KEY = "self-heal.events";
const EVENTS_KEPT = 200;
function readEvents(): HealEvent[] {
  try { const row = db.select({ value: meta.value }).from(meta).where(eq(meta.key, EVENTS_KEY)).get(); const parsed = row ? JSON.parse(row.value) as HealEvent[] : []; return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
function record(event: HealEvent): void {
  const kept = [...readEvents(), event].slice(-EVENTS_KEPT);
  try { db.insert(meta).values({ key: EVENTS_KEY, value: JSON.stringify(kept) }).onConflictDoUpdate({ target: meta.key, set: { value: JSON.stringify(kept) } }).run(); } catch { /* the record is a convenience; the heal never depends on it */ }
  logger.appendLine(JSON.stringify({ event: `self-heal.${event.kind}`, role: event.role, cause: event.causeKind, seconds: event.seconds ?? null, attempts: event.attempts ?? null }));
}

export interface SelfHealSummary {
  enabled: boolean;
  /** Crashes per calendar day (UTC), newest last, for the Status page. */
  crashesByDay: Array<{ day: string; crashes: number; healed: number; gaveUp: number }>;
  events: HealEvent[];
  /** Roles whose circuit breaker is open: retrying stopped, a person decides. */
  stopped: RoleId[];
  /** Roles with a restart scheduled or running right now. */
  healing: RoleId[];
  /** Why a restart (or a canary, or a prewarm) must wait right now, or null: the same gate the restarter uses. */
  blocker: string | null;
}
export function selfHealSummary(days = 14, now = clock.now()): SelfHealSummary {
  const events = readEvents();
  const buckets = new Map<string, { day: string; crashes: number; healed: number; gaveUp: number }>();
  for (let i = days - 1; i >= 0; i--) { const day = new Date(now - i * 86_400_000).toISOString().slice(0, 10); buckets.set(day, { day, crashes: 0, healed: 0, gaveUp: 0 }); }
  for (const event of events) {
    const bucket = buckets.get(event.at.slice(0, 10));
    if (!bucket) continue;
    if (event.kind === "crashed") bucket.crashes++; else if (event.kind === "healed") bucket.healed++; else if (event.kind === "gave_up") bucket.gaveUp++;
  }
  return { enabled: selfHealEnabled(), crashesByDay: [...buckets.values()], events: events.slice(-50), stopped: [...states].filter(([, s]) => s.open).map(([role]) => role), healing: [...states].filter(([, s]) => s.cancel !== null || s.attempting).map(([role]) => role), blocker: healBlocker() };
}

// ---- the item ---------------------------------------------------------------

const itemCode = (role: RoleId): string => `engine.crashed.${role}`;
function seconds(ms: number): string { return ms >= 60_000 ? `${Math.round(ms / 60_000)} minute${ms >= 90_000 ? "s" : ""}` : `${Math.round(ms / 1000)} seconds`; }

function raiseWaiting(role: RoleId, verdict: CrashVerdict, note: string): void {
  raise({ code: itemCode(role), severity: "error", title: `The ${role} engine crashed`, text: `${verdict.cause} ${note}`, cause: verdict.cause, fix: { label: "Restart engine", action: "restart_engine" } });
}

function raiseGaveUp(role: RoleId, heal: RoleHeal, why: string): void {
  const verdict = heal.verdict ?? classifyCrash({ exitCode: null, signal: null, stderrTail: [] });
  const lines = heal.tail.slice(-20);
  const details = lines.length > 0 ? `\n\nLast log lines:\n${lines.join("\n")}` : "\n\nThe engine left no log lines.";
  raise({ code: itemCode(role), severity: "error", title: `The ${role} engine keeps stopping`, text: `${verdict.cause} ${why} ${verdict.fix} Press Restart engine once that is done.${details}`, cause: verdict.cause, fix: { label: "Restart engine", action: "restart_engine" } });
}

// ---- the controller ---------------------------------------------------------

function trim(heal: RoleHeal, now: number): void { heal.failures = heal.failures.filter((at) => now - at < rules.windowMs); }

function openCircuit(role: RoleId, heal: RoleHeal, why: string): void {
  heal.open = true;
  heal.cancel?.(); heal.cancel = null;
  raiseGaveUp(role, heal, why);
  record({ id: `${role}:${heal.crashedAt ?? clock.now()}:gave_up`, kind: "gave_up", at: new Date(clock.now()).toISOString(), role, cause: heal.verdict?.cause ?? "", causeKind: heal.verdict?.kind ?? "unknown", attempts: heal.failures.length });
}

function schedule(role: RoleId, heal: RoleHeal, delayMs: number): void {
  heal.cancel?.();
  heal.generation = roleGeneration(role);
  heal.cancel = clock.after(delayMs, () => { heal.cancel = null; void enqueue(role); });
}

/** A failure was counted: retry after the next wait, or stop. */
function afterFailure(role: RoleId, heal: RoleHeal, now: number, lastTry?: string): void {
  trim(heal, now);
  const verdict = heal.verdict ?? classifyCrash({ exitCode: null, signal: null, stderrTail: [] });
  if (heal.failures.length >= rules.maxFailures) { openCircuit(role, heal, `It stopped ${heal.failures.length} times in ${Math.round(rules.windowMs / 60_000)} minutes, so the Stack stopped restarting it.`); return; }
  const delay = rules.backoffMs[Math.min(heal.failures.length - 1, rules.backoffMs.length - 1)]!;
  raiseWaiting(role, verdict, `${lastTry ? `The last restart did not work: ${lastTry.replace(/\.$/, "")}. ` : ""}The Stack is restarting it (try ${heal.failures.length} of ${rules.maxFailures - 1}, in ${seconds(delay)}).`);
  schedule(role, heal, delay);
}

/** The supervisor's report of an engine that exited on its own. */
export function onEngineCrash(report: CrashReport): void {
  if (!selfHealEnabled()) return;
  const heal = state(report.role);
  const now = clock.now();
  record({ id: `${report.role}:${now}`, kind: "crashed", at: new Date(now).toISOString(), role: report.role, cause: report.verdict.cause, causeKind: report.verdict.kind });
  // An on-demand engine nobody was using restarts with its next request.
  if (ON_DEMAND_ROLES.includes(report.role) && !report.wasBusy) return;
  if (heal.lastReadyAt !== null && now - heal.lastReadyAt >= rules.healthyResetMs) { heal.failures = []; heal.open = false; }
  heal.crashedAt ??= now;
  heal.verdict = report.verdict;
  heal.tail = report.stderrTail;
  if (report.verdict.kind === "host_fault") { waitForHost(report.role, heal, report.verdict); return; }
  heal.failures.push(now);
  if (heal.open) return;
  if (!report.verdict.retryHelps) { openCircuit(report.role, heal, "Starting it again would fail the same way."); return; }
  afterFailure(report.role, heal, now);
}

/** The host, not the engine, is at fault: no failure is counted and the circuit stays closed; the restart waits and tries again. */
function waitForHost(role: RoleId, heal: RoleHeal, verdict: CrashVerdict): void {
  if (heal.open) return;
  raiseWaiting(role, verdict, `The Stack waits for it and tries again every ${seconds(rules.hostFaultRecheckMs)}.`);
  schedule(role, heal, rules.hostFaultRecheckMs);
}

function enqueue(role: RoleId): Promise<void> {
  chain = chain.then(() => attempt(role)).catch(() => {});
  return chain;
}

async function attempt(role: RoleId): Promise<void> {
  const heal = state(role);
  if (heal.open || !selfHealEnabled()) return;
  // Anything that moved the role since this retry was scheduled makes it moot.
  if (roleHasProcess(role) || roleManuallyStopped(role) || roleGeneration(role) !== heal.generation) { heal.crashedAt = null; if (roleHasProcess(role)) resolveHealth(itemCode(role)); return; }
  const blocked = healBlocker();
  if (blocked) {
    if (isStoppingAll()) return;
    const verdict = heal.verdict ?? classifyCrash({ exitCode: null, signal: null, stderrTail: [] });
    raiseWaiting(role, verdict, `The Stack will restart it when it can: ${blocked.replace(/\.$/, "")}.`);
    schedule(role, heal, rules.gateRecheckMs);
    return;
  }
  heal.attempting = true;
  const crashedAt = heal.crashedAt ?? clock.now();
  try {
    const result = await healStart(role);
    const now = clock.now();
    if (result.ok) {
      heal.lastReadyAt = now;
      heal.crashedAt = null;
      resolveHealth(itemCode(role));
      record({ id: `${role}:${crashedAt}:healed`, kind: "healed", at: new Date(now).toISOString(), role, cause: heal.verdict?.cause ?? "", causeKind: heal.verdict?.kind ?? "unknown", seconds: Math.max(0, Math.round((now - crashedAt) / 1000)), crashedAt: new Date(crashedAt).toISOString(), attempts: heal.failures.length });
      return;
    }
    if (isHostFault(result.reason)) {
      heal.verdict = HOST_FAULT_VERDICT;
      if (roleGeneration(role) === heal.generation) waitForHost(role, heal, heal.verdict);
      return;
    }
    heal.failures.push(now);
    heal.tail = [...heal.tail, `Restart check failed: ${result.reason}`].slice(-20);
    if (roleGeneration(role) !== heal.generation) return;
    afterFailure(role, heal, now, result.reason);
  } finally { heal.attempting = false; }
}

/** A health canary asks for one engine restart (it answered wrongly or not at all while the process lives).
 * The request goes through the same gate, backoff and circuit breaker as a crash: it counts as a failure,
 * waits for installs and low memory, and is refused (accepted false) when the circuit is open or self-heal is off. */
export async function requestEngineRestart(role: RoleId, reason: string): Promise<{ accepted: boolean; why: string | null }> {
  if (!selfHealEnabled()) return { accepted: false, why: "Self-heal is turned off." };
  const heal = state(role);
  if (heal.open) return { accepted: false, why: "The engine stopped too often and the Stack stopped restarting it; use Restart engine in Repairs." };
  if (heal.cancel || heal.attempting) return { accepted: false, why: "A restart of this engine is already pending." };
  const text = reason.replace(/\s+/g, " ").trim().slice(0, 200);
  const verdict: CrashVerdict = { kind: "unknown", cause: text || "A health check failed.", fix: "The Stack restarts it; the check that failed is named above.", retryHelps: true };
  record({ id: `${role}:${clock.now()}:canary`, kind: "requested_by_canary", at: new Date(clock.now()).toISOString(), role, cause: verdict.cause, causeKind: "canary" });
  logger.appendLine(JSON.stringify({ event: "engine.restart_requested_by_canary", role, reason: verdict.cause }));
  await recycleRole(role, "canary-request");
  onEngineCrash({ role, kind: "spawned", engine: null, modelId: null, exitCode: null, signal: null, stderrTail: [verdict.cause], ranMs: 0, wasBusy: false, verdict });
  return { accepted: true, why: null };
}

/** A person (or a setting) restarted the role by hand: the failures and the pending retry are forgotten. */
function onManualRestart(role: RoleId): void {
  const heal = states.get(role);
  if (!heal) return;
  heal.cancel?.(); heal.cancel = null;
  heal.failures = []; heal.open = false; heal.crashedAt = null; heal.lastReadyAt = null;
}

/** The startup self-check and the periodic sweep: a role that is offline
 * with no engine process and nobody retrying it (the state a crash leaves
 * when chat is paused and no request comes) gets the same treatment as a
 * crash the supervisor reported. */
export function sweepOffline(): RoleId[] {
  if (!selfHealEnabled() || isStoppingAll()) return [];
  const kicked: RoleId[] = [];
  for (const role of offlineRolesWithoutProcess()) {
    if (ON_DEMAND_ROLES.includes(role)) continue;
    const heal = state(role);
    if (heal.open || heal.cancel || heal.attempting) continue;
    kicked.push(role);
    onEngineCrash({ role, kind: "spawned", engine: null, modelId: null, exitCode: null, signal: null, stderrTail: [], ranMs: 0, wasBusy: false, verdict: { ...classifyCrash({ exitCode: null, signal: null, stderrTail: [] }), cause: "The engine was offline with no process running." } });
  }
  return kicked;
}

let stopSweep: (() => void) | null = null;
/** Starts the controller: the crash and restart hooks, a first look at
 * startup, and the sweep. Returns the stop. */
export function startSelfHeal(): () => void {
  setCrashListener(onEngineCrash);
  setRestartListener(onManualRestart);
  const loop = (): void => { sweepOffline(); stopSweep = clock.after(rules.sweepMs, loop); };
  stopSweep = clock.after(5_000, loop);
  return () => { stopSelfHeal(); };
}
export function stopSelfHeal(): void {
  setCrashListener(null);
  setRestartListener(null);
  stopSweep?.(); stopSweep = null;
  for (const heal of states.values()) { heal.cancel?.(); heal.cancel = null; }
}

// ---- tests ------------------------------------------------------------------

export function __setSelfHealForTests(options: { clock?: Clock; rules?: Partial<Rules> } | null): void {
  clock = options?.clock ?? realClock;
  rules = { ...SELF_HEAL_RULES, backoffMs: [...SELF_HEAL_RULES.backoffMs], ...(options?.rules ?? {}) } as Rules;
}
export function __resetSelfHealForTests(): void {
  stopSelfHeal();
  states.clear(); holds.clear(); chain = Promise.resolve();
  try { db.delete(meta).where(eq(meta.key, EVENTS_KEY)).run(); } catch { /* no database yet */ }
}
/** Resolves when the restart in flight (if any) has finished. */
export function __settledForTests(): Promise<void> { return chain; }
