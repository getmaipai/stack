// The Home mode transaction. Runtime operations are injected so the same
// ordering and rollback rules can be exercised without starting engines.
import { db } from "@/db";
import { meta } from "@/db/schema";
import { eq } from "drizzle-orm";
import { logHomeModeEvent, type StackHomeModeLogReason } from "@/lib/log";

export type HomeMode = "normal" | "coding";
export type HomeModeState = "stable" | "switching" | "failed";
export type HomeModeFailure = StackHomeModeLogReason;
export interface HomeModeChecks { engine: boolean; pieces: boolean; hardware: boolean; memory: boolean; bench: boolean }
export interface HomeModeMemory { plan_bytes: number; budget_bytes: number }
export interface HomeModeView {
  mode: HomeMode; target: HomeMode; state: HomeModeState; reason: string | null;
  available: boolean; checks: HomeModeChecks; self_test: { passed_at: string | null; stale: boolean };
  memory: HomeModeMemory;
}
export interface HomeModeRuntime {
  inspect(): Omit<HomeModeView, "mode" | "target" | "state" | "self_test">;
  stopResidents(): Promise<void>;
  startHeavy(): Promise<void>;
  stopHeavy(): Promise<void>;
  startResidents(): Promise<void>;
  checkHeavy(): Promise<void>;
  bind(mode: HomeMode): void;
  transition(): void;
  persistMode(mode: HomeMode): void;
  pins(): string;
  /** True while a picture, video or song job holds memory; the large model cannot load beside it. */
  generating?(): boolean;
}
export class HomeModeError extends Error {
  readonly reason: string;
  readonly status = 409;
  constructor(reason: string) { super(reason); this.name = "HomeModeError"; this.reason = reason; }
}

const SELF_TEST_KEY = "coding.home_mode.self_test";
const FAILURE_KEY = "coding.home_mode.failure";
let mode: HomeMode = "normal";
let target: HomeMode = "normal";
let state: HomeModeState = "stable";
let reason: string | null = null;
let running = false;
let runtime: HomeModeRuntime | null = null;
let pinsAtSelfTest: string | null = null;
let passedAt: string | null = null;

function readPassed(): void {
  const row = db.select({ value: meta.value }).from(meta).where(eq(meta.key, SELF_TEST_KEY)).get()?.value;
  if (!row) { passedAt = null; pinsAtSelfTest = null; return; }
  try { const value = JSON.parse(row) as { passedAt?: string; pins?: string }; passedAt = value.passedAt ?? null; pinsAtSelfTest = value.pins ?? null; }
  catch { passedAt = null; pinsAtSelfTest = null; }
}
function savePassed(at: string, pins: string): void {
  passedAt = at; pinsAtSelfTest = pins;
  db.insert(meta).values({ key: SELF_TEST_KEY, value: JSON.stringify({ passedAt: at, pins }) }).onConflictDoUpdate({ target: meta.key, set: { value: JSON.stringify({ passedAt: at, pins }) } }).run();
}
function clearPassed(): void { passedAt = null; pinsAtSelfTest = null; db.delete(meta).where(eq(meta.key, SELF_TEST_KEY)).run(); }
function saveFailure(value: string | null): void {
  if (value === null) db.delete(meta).where(eq(meta.key, FAILURE_KEY)).run();
  else db.insert(meta).values({ key: FAILURE_KEY, value: value }).onConflictDoUpdate({ target: meta.key, set: { value } }).run();
}
function log(event: "home_mode_switch_started" | "home_mode_switch_done" | "home_mode_switch_failed" | "home_mode_self_test", detail: { reason?: HomeModeFailure } = {}): void { logHomeModeEvent(event, detail.reason); }

export function configureHomeMode(adapter: HomeModeRuntime): void { runtime = adapter; readPassed(); }
export function initializeHomeMode(initial: HomeMode): void {
  mode = initial; target = initial;
  const storedFailure = db.select({ value: meta.value }).from(meta).where(eq(meta.key, FAILURE_KEY)).get()?.value ?? null;
  reason = initial === "normal" ? storedFailure : null; state = reason ? "failed" : "stable";
}
export function currentHomeMode(): HomeMode { return mode; }
export function homeModeTarget(): HomeMode { return target; }
export function homeModeEnteringCoding(): boolean { return target === "coding" && state === "switching"; }
export function homeModeLeavingCoding(): boolean { return target === "normal" && state === "switching"; }
export function homeModeSwitching(): boolean { return running; }
export function homeModeFailure(reasonText: string, category: HomeModeFailure = "start_failed"): void {
  mode = "normal"; target = "normal"; state = "failed"; reason = reasonText;
  saveFailure(reasonText);
  runtime?.bind("normal"); log("home_mode_switch_failed", { reason: category });
}
export function homeModePinsChanged(): void { clearPassed(); }

export function homeModeView(): HomeModeView {
  if (!runtime) throw new Error("Home mode has not been initialized.");
  const inspected = runtime.inspect();
  const stale = passedAt !== null && (Date.now() - Date.parse(passedAt) > 7 * 24 * 60 * 60 * 1000 || pinsAtSelfTest !== runtime.pins());
  if (passedAt !== null && pinsAtSelfTest !== runtime.pins()) clearPassed();
  return { ...inspected, mode, target, state, reason: reason ?? inspected.reason, self_test: { passed_at: passedAt, stale: passedAt === null ? false : stale } };
}

export async function switchHomeMode(next: HomeMode): Promise<void> {
  if (!runtime) throw new HomeModeError("Home mode is not available yet.");
  if (running) throw new HomeModeError("A Home mode change is already running.");
  const availability = runtime.inspect();
  if (next === "coding" && !availability.available) throw new HomeModeError("reason" in availability ? String((availability as { reason?: string }).reason) : "The large coding mode is not available on this computer.");
  if (next === mode) throw new HomeModeError(`Home is already in ${mode} mode.`);
  if (next === "coding" && runtime.generating?.()) throw new HomeModeError("A picture, video or song is still being made. Wait for it to finish, then switch to Coding mode.");
  running = true; target = next; state = "switching"; reason = null;
  log("home_mode_switch_started");
  let phase: "stop" | "start" | "check" = "stop";
  try {
    runtime.transition();
    if (next === "coding") {
      await runtime.stopResidents();
      phase = "start";
      await runtime.startHeavy();
      phase = "check";
      await runtime.checkHeavy();
      mode = "coding"; target = "coding"; state = "stable";
      runtime.bind("coding");
      runtime.persistMode("coding"); saveFailure(null); log("home_mode_switch_done");
    } else {
      await runtime.stopHeavy();
      phase = "start";
      await runtime.startResidents();
      mode = "normal"; target = "normal"; state = "stable";
      runtime.bind("normal");
      runtime.persistMode("normal"); saveFailure(null); log("home_mode_switch_done");
    }
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    try {
      if (next === "coding") { await runtime.stopHeavy(); await runtime.startResidents(); }
      else { await runtime.stopResidents(); await runtime.startHeavy(); await runtime.checkHeavy(); }
      mode = next === "coding" ? "normal" : "coding";
      target = mode; state = "failed"; reason = failure;
      runtime.bind(mode);
      runtime.persistMode(mode); saveFailure(failure); log("home_mode_switch_failed", { reason: phase === "check" ? "check_failed" : phase === "stop" ? "stop_failed" : "start_failed" });
    } catch {
      mode = "normal"; target = "normal"; state = "failed"; reason = `${failure} The automatic recovery also failed.`;
      runtime.bind("normal"); runtime.persistMode("normal"); saveFailure(reason); log("home_mode_switch_failed", { reason: "rollback_failed" });
    }
    throw new HomeModeError(failure);
  } finally { running = false; }
}

export async function selfTest(): Promise<{ accepted: boolean; reason?: string }> {
  log("home_mode_self_test");
  if (!runtime) { reason = "Home mode is not available yet."; return { accepted: false, reason }; }
  if (running) { reason = "A Home mode change is already running."; return { accepted: false, reason }; }
  if (mode === "coding") {
    try { await runtime.checkHeavy(); savePassed(new Date().toISOString(), runtime.pins()); reason = null; return { accepted: true }; }
    catch (error) { reason = error instanceof Error ? error.message : String(error); return { accepted: false, reason }; }
  }
  try { await switchHomeMode("coding"); await switchHomeMode("normal"); savePassed(new Date().toISOString(), runtime.pins()); reason = null; return { accepted: true }; }
  catch (error) { reason = error instanceof Error ? error.message : String(error); return { accepted: false, reason }; }
}
