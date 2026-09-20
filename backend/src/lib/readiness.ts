// The readiness check: every installed role gets the smallest real
// request for its wire through the supervisor, then one fit-together
// pass runs a generator while sampling kernel pressure. Failures become
// health items with the smallest useful fix; passing reruns resolve them.
// Home schedules it and calls it; the last run is kept in `meta`.
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { meta } from "@/db/schema";
import { raise, resolve as resolveHealth } from "@/lib/health";
import { getMemoryReader } from "@/lib/memory";
import type { MemoryReader } from "@/lib/memory/types";
import { probeReplyOk, probeRequest, requestRole, getRoleStatus, SPAWNABLE_ROLES } from "@/lib/supervisor";
import { resolveRoleState } from "@/lib/router";
import { ROLE_IDS, ROLES, type RoleId } from "@/roles";

const LATEST_KEY = "readiness.latest";

export interface CheckRoleResult { role: RoleId; ok: boolean; ms: number; reason: string | null; loadMs: number | null; skipped?: boolean; }
export interface FitTogetherResult { ok: boolean; reason: string | null; }
export interface CheckRun { at: string; ok: boolean; results: CheckRoleResult[]; fitTogether: FitTogetherResult; reason: string | null; }
export interface CheckOptions {
  roleIds?: RoleId[];
  requestRole?: (role: RoleId) => Promise<{ status: number; reason?: string; loadMs?: number | null }>;
  fitGenerator?: () => Promise<void>;
  memoryReader?: MemoryReader;
  sampleMs?: number;
}

let running: { startedAt: string } | null = null;

function fixFor(role: RoleId, reason: string): { label: string; action: string } {
  if (reason.toLowerCase().includes("memory")) return { label: "Free memory", action: "free_memory" };
  if (ROLES[role].wire === "chat" || ROLES[role].wire === "embeddings") return { label: "Restart engine", action: "restart_engine" };
  return { label: "Reinstall model", action: "reinstall_model" };
}

async function checkRole(role: RoleId, options: CheckOptions): Promise<CheckRoleResult> {
  const started = performance.now();
  const record = (ok: boolean, reason: string | null, loadMs: number | null, cause: string): CheckRoleResult => {
    if (ok) resolveHealth(`check-role.${role}`);
    else raise({ code: `check-role.${role}`, severity: "warning", title: `${ROLES[role].label} needs attention`, text: reason ?? `${role} did not answer the readiness check.`, cause, fix: fixFor(role, reason ?? "") });
    return { role, ok, ms: Math.round(performance.now() - started), reason, loadMs };
  };
  try {
    if (options.requestRole) {
      const response = await options.requestRole(role);
      return record(response.status >= 200 && response.status < 300, response.reason ?? null, response.loadMs ?? null, response.reason ?? "The role probe failed.");
    }
    const wire = ROLES[role].wire;
    if (wire !== "chat" && wire !== "embeddings") {
      resolveHealth(`check-role.${role}`);
      return { role, ok: false, skipped: true, ms: Math.round(performance.now() - started), reason: `Skipped: no ${wire} engine is ready for ${role}.`, loadMs: null };
    }
    const probe = probeRequest(role);
    const reply = await requestRole(role, probe.path, probe.body);
    const ok = probeReplyOk(role, reply);
    const body = reply.body as { error?: unknown };
    const reason = ok ? null : typeof body?.error === "string" ? body.error : `${role} returned HTTP ${reply.status}.`;
    return record(ok, reason, getRoleStatus(role).postLoadCheck?.loadMs ?? null, "The role probe returned an error.");
  } catch (error) {
    const reason = error instanceof Error ? error.message : `${role} did not answer the readiness check.`;
    return record(false, reason, null, "The role probe could not complete.");
  }
}

export async function runFitTogetherCheck(options: Pick<CheckOptions, "fitGenerator" | "memoryReader" | "sampleMs"> = {}): Promise<FitTogetherResult> {
  if (!options.fitGenerator) return { ok: true, reason: null };
  const reader = options.memoryReader ?? getMemoryReader();
  let critical = reader.read().pressure === "critical";
  const timer = setInterval(() => { if (reader.read().pressure === "critical") critical = true; }, options.sampleMs ?? 250);
  try { await options.fitGenerator(); }
  catch (error) { return { ok: false, reason: error instanceof Error ? error.message : "The fit-together generator failed." }; }
  finally { clearInterval(timer); }
  return critical ? { ok: false, reason: "Critical memory pressure arrived while a generator was running." } : { ok: true, reason: null };
}

// A role Home stopped on purpose is not probed: the person chose that
// state, and a "needs attention" item for it would be a false alarm.
function installedRoles(): RoleId[] {
  return ROLE_IDS.filter((role) => ["installed", "loaded", "ready"].includes(resolveRoleState(role).state) && getRoleStatus(role).state !== "stopped");
}

export async function runCheck(options: CheckOptions = {}): Promise<CheckRun> {
  if (running) return { at: new Date().toISOString(), ok: false, results: [], fitTogether: { ok: false, reason: "A check is already running." }, reason: "A check is already running." };
  running = { startedAt: new Date().toISOString() };
  try {
    const roleIds = options.roleIds ?? installedRoles();
    const results: CheckRoleResult[] = [];
    for (const role of roleIds) results.push(await checkRole(role, options));
    const fitTogether = await runFitTogetherCheck({
      fitGenerator: options.fitGenerator ?? (!options.requestRole && roleIds.includes("chat") && SPAWNABLE_ROLES.includes("chat") ? async () => {
        const probe = probeRequest("chat");
        const reply = await requestRole("chat", probe.path, probe.body);
        if (!probeReplyOk("chat", reply)) throw new Error(`The generator returned HTTP ${reply.status}.`);
      } : undefined),
      memoryReader: options.memoryReader,
      sampleMs: options.sampleMs,
    });
    if (fitTogether.ok) resolveHealth("check-fit-together");
    else raise({ code: "check-fit-together", severity: "critical", title: "The Stack did not fit together", text: fitTogether.reason ?? "The resident set could not run a generator safely.", cause: "The fit-together check reached a failing condition.", fix: { label: "Free memory", action: "free_memory" } });
    const at = new Date().toISOString();
    const reason = roleIds.length === 0 ? "Nothing to check: no role is installed." : null;
    // A skipped role never makes the whole check green on its own: the
    // run is ok only when at least one role really answered.
    const ok = results.some((result) => result.ok) && results.every((result) => result.ok || result.skipped) && fitTogether.ok;
    const run: CheckRun = { at, ok, results, fitTogether, reason };
    db.insert(meta).values({ key: LATEST_KEY, value: JSON.stringify(run) }).onConflictDoUpdate({ target: meta.key, set: { value: JSON.stringify(run) } }).run();
    return run;
  } finally {
    running = null;
  }
}

export function runningCheck(): { startedAt: string } | null { return running; }

export function latestCheck(): CheckRun | null {
  const row = db.select({ value: meta.value }).from(meta).where(eq(meta.key, LATEST_KEY)).get();
  if (!row) return null;
  try { return JSON.parse(row.value) as CheckRun; } catch { return null; }
}

export function __resetReadinessForTests(): void {
  running = null;
  db.delete(meta).where(eq(meta.key, LATEST_KEY)).run();
}
