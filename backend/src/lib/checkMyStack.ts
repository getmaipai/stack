import { desc } from "drizzle-orm";
import { db } from "@/db";
import { checkRuns } from "@/db/schema";
import { emit } from "@/lib/events";
import { raise, resolve as resolveHealth } from "@/lib/health";
import { getMemoryReader } from "@/lib/memory";
import { completeChat, getChatEngineStatus } from "@/lib/supervisor";
import { ROLE_IDS, ROLES, type RoleId } from "@/roles";
import { resolveRole } from "@/lib/router";
import type { MemoryReader } from "@/lib/memory/types";
import { getActivityReader, hasRecentActivity, type ActivityReader } from "@/lib/activity";

export const NIGHTLY_CHECK_JOB_KIND = "nightly-check";
let runningCheck: { runId: string; startedAt: string } | null = null;
const CHECK_PROMPT = "Reply with the word OK";

export interface CheckRoleResult {
  role: RoleId;
  ok: boolean;
  ms: number;
  reason: string | null;
  loadMs: number | null;
  skipped?: boolean;
}

export interface FitTogetherResult {
  ok: boolean;
  reason: string | null;
}

export interface CheckRun {
  at: string;
  ok: boolean;
  results: CheckRoleResult[];
  fitTogether: FitTogetherResult;
  reason: string | null;
}

export interface CheckOptions {
  roleIds?: RoleId[];
  checkId?: string;
  requestRole?: (role: RoleId) => Promise<{ status: number; reason?: string; loadMs?: number | null }>;
  fitGenerator?: () => Promise<void>;
  memoryReader?: MemoryReader;
  sampleMs?: number;
}

function reasonFor(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") return body.error;
  return fallback;
}

function fixFor(role: RoleId, reason: string): { label: string; action: string } {
  if (reason.toLowerCase().includes("memory")) return { label: "Free memory", action: "free_memory" };
  if (ROLES[role].wire === "chat") return { label: "Restart engine", action: "restart_engine" };
  return { label: "Reinstall model", action: "reinstall_model" };
}

async function checkRole(role: RoleId, options: CheckOptions): Promise<CheckRoleResult> {
  const started = performance.now();
  if (options.requestRole) {
    try {
      const response = await options.requestRole(role);
      const result = { role, ok: response.status >= 200 && response.status < 300, ms: Math.round(performance.now() - started), reason: response.reason ?? null, loadMs: response.loadMs ?? null };
      if (result.ok) resolveHealth(`check-role.${role}`);
      else raise({ code: `check-role.${role}`, severity: "warning", title: `${role} needs attention`, text: result.reason ?? `${role} did not answer the Stack check.`, cause: result.reason ?? "The role smoke test failed.", fix: fixFor(role, result.reason ?? "") });
      return result;
    } catch (error) {
      const reason = error instanceof Error ? error.message : `${role} did not answer the Stack check.`;
      raise({ code: `check-role.${role}`, severity: "warning", title: `${role} needs attention`, text: reason, cause: "The role smoke test threw an error.", fix: fixFor(role, reason) });
      return { role, ok: false, ms: Math.round(performance.now() - started), reason, loadMs: null };
    }
  }
  if (ROLES[role].wire !== "chat") {
    const reason = `Skipped: no ${ROLES[role].wire} engine is ready for ${role}.`;
    resolveHealth(`check-role.${role}`);
    return { role, ok: false, skipped: true, ms: Math.round(performance.now() - started), reason, loadMs: null };
  }
  try {
    const response = await completeChat(role, { model: role, messages: [{ role: "user", content: CHECK_PROMPT }], max_tokens: 8, chat_template_kwargs: { enable_thinking: false } });
    const ok = response.status >= 200 && response.status < 300;
    const reason = ok ? null : reasonFor(response.body, `${role} returned HTTP ${response.status}.`);
    const result = { role, ok, ms: Math.round(performance.now() - started), reason, loadMs: getChatEngineStatus().postLoadCheck?.loadMs ?? null };
    if (ok) resolveHealth(`check-role.${role}`);
    else raise({ code: `check-role.${role}`, severity: "warning", title: `${role} needs attention`, text: reason ?? "The role smoke test failed.", cause: "The role smoke test returned an error.", fix: fixFor(role, reason ?? "") });
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : `${role} did not answer the Stack check.`;
    raise({ code: `check-role.${role}`, severity: "warning", title: `${role} needs attention`, text: reason, cause: "The role smoke test could not complete.", fix: fixFor(role, reason) });
    return { role, ok: false, ms: Math.round(performance.now() - started), reason, loadMs: null };
  }
}

export async function runFitTogetherCheck(options: Pick<CheckOptions, "fitGenerator" | "memoryReader" | "sampleMs"> = {}): Promise<FitTogetherResult> {
  if (!options.fitGenerator) return { ok: true, reason: null };
  const reader = options.memoryReader ?? getMemoryReader();
  let critical = reader.read().pressure === "critical";
  const timer = setInterval(() => { if (reader.read().pressure === "critical") critical = true; }, options.sampleMs ?? 250);
  try {
    await options.fitGenerator();
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "The fit-together generator failed." };
  } finally {
    clearInterval(timer);
  }
  return critical ? { ok: false, reason: "Critical memory pressure arrived while a generator was running." } : { ok: true, reason: null };
}

export async function runCheck(options: CheckOptions = {}): Promise<CheckRun> {
  const roleIds = options.roleIds ?? ROLE_IDS.filter((role) => ["installed", "ready"].includes(resolveRole(role).state));
  const checkId = options.checkId ?? crypto.randomUUID();
  if (runningCheck !== null) return { at: new Date().toISOString(), ok: false, results: [], fitTogether: { ok: false, reason: "A check is already running." }, reason: "A check is already running." };
  runningCheck = { runId: checkId, startedAt: new Date().toISOString() };
  try {
    const results: CheckRoleResult[] = [];
  for (const role of roleIds) {
    emit({ id: "check.progress", data: { role, state: "running" } });
    const result = await checkRole(role, options);
    results.push(result);
    emit({ id: "check.progress", data: { role, state: result.ok ? "passed" : result.skipped ? "skipped" : "failed", ms: result.ms } });
  }
  const fitTogether = await runFitTogetherCheck({
    fitGenerator: options.fitGenerator ?? (!options.requestRole && roleIds.includes("chat") ? async () => {
      const response = await completeChat("chat", { model: "chat", messages: [{ role: "user", content: CHECK_PROMPT }], max_tokens: 8, chat_template_kwargs: { enable_thinking: false } });
      if (response.status < 200 || response.status >= 300) throw new Error(`The generator returned HTTP ${response.status}.`);
    } : undefined),
    memoryReader: options.memoryReader,
    sampleMs: options.sampleMs,
  });
  if (fitTogether.ok) resolveHealth("check-fit-together");
  else raise({ code: "check-fit-together", severity: "critical", title: "The Stack did not fit together", text: fitTogether.reason ?? "The resident set could not run a generator safely.", cause: "The fit-together check reached a failing condition.", fix: { label: "Free memory", action: "free_memory" } });
  const at = new Date().toISOString();
  const reason = roleIds.length === 0 ? "Nothing to check: no ability is installed." : null;
  const ok = roleIds.length > 0 && results.every((result) => result.ok || result.skipped) && fitTogether.ok;
  db.insert(checkRuns).values({ at, ok: ok ? 1 : 0, results: JSON.stringify(results), fitTogetherOk: fitTogether.ok ? 1 : 0, fitTogetherReason: fitTogether.reason }).run();
  emit({ id: "check.done", data: { ok, roleCount: results.length, fitTogetherOk: fitTogether.ok } });
  return { at, ok, results, fitTogether, reason };
  } finally {
    runningCheck = null;
  }
}

export function runningCheckState(): { runId: string; startedAt: string } | null {
  return runningCheck;
}

export function __resetChecksForTests(): void {
  runningCheck = null;
}

export function latestCheck(): CheckRun | null {
  const row = db.select().from(checkRuns).orderBy(desc(checkRuns.at)).limit(1).get();
  if (!row) return null;
  const results = JSON.parse(row.results) as CheckRoleResult[];
  return { at: row.at, ok: row.ok === 1, results, fitTogether: { ok: row.fitTogetherOk === 1, reason: row.fitTogetherReason }, reason: results.length === 0 && row.ok === 0 ? "Nothing to check: no ability is installed." : null };
}

export function shouldRunNightly(active: boolean): boolean { return !active; }

export async function runNightlyCheck(active: boolean | undefined, options: CheckOptions = {}, activityReader: ActivityReader = getActivityReader()): Promise<CheckRun | { skipped: true; reason: string }> {
  const recent = active ?? hasRecentActivity(activityReader);
  if (!shouldRunNightly(recent)) return { skipped: true, reason: "Skipped because the person has been active in the last five minutes." };
  return runCheck(options);
}
