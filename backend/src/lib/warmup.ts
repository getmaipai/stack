// Keep-warm (STACK-WARM-01): after the daemon starts, after a model or
// engine install, and whenever Home asks, load the roles a first chat
// needs and send each one a one-token request, so the person's first
// message meets a loaded model with its Metal kernels already compiled.
// The cold costs measured on a 128 GB Mac Studio: chat 17 s, embed 14 s
// and judge 15 s on their first load (weights read from disk plus the
// fit dry run); a load with the file already cached takes 4 s.
//
// A role is warmed only when its model is installed and the whole warm
// set fits the model budget with the tier's working margin left over;
// a role that does not fit stays on-demand (loaded by its first request,
// as before). The warm set is also what the idle unload leaves alone
// (the `stack.runtime.keep_warm` setting, off when on battery).
import { GovernorRules, defaultModelBudgetBytes, getGovernorStatus, type GovernorTier } from "@/lib/governor";
import { logger } from "@/lib/log";
import { currentMachineTier, getProcess, processRoleFor, requestRole, selectedModel } from "@/lib/supervisor";
import type { RoleId } from "@/roles";
import { settingValues } from "@/settings";

/** Most important first: a role later in the list is dropped first when
 * the machine cannot hold them all. */
export const WARM_ORDER: RoleId[] = ["chat", "embed", "judge", "stt", "tts"];
const FOOTPRINT_FACTOR = 1.3;

export type WarmRoleState = "pending" | "warming" | "warm" | "skipped" | "failed";
export interface WarmRoleReport { role: RoleId; state: WarmRoleState; reason: string | null; ms: number | null }
export interface WarmupStatus {
  state: "idle" | "warming" | "ready";
  startedAt: string | null;
  finishedAt: string | null;
  trigger: string | null;
  roles: WarmRoleReport[];
}

export interface WarmCandidate { role: RoleId; bytes: number }

/** Which candidates fit, in order: each is kept while the running total
 * stays within the budget less the tier's working margin. `residentBytes`
 * is what is already loaded and not itself a candidate. */
export function planWarmSet(candidates: WarmCandidate[], budgetBytes: number, marginBytes: number, residentBytes = 0): { warm: RoleId[]; skipped: Array<{ role: RoleId; reason: string }> } {
  const room = budgetBytes - marginBytes - residentBytes;
  const warm: RoleId[] = [];
  const skipped: Array<{ role: RoleId; reason: string }> = [];
  let used = 0;
  for (const candidate of candidates) {
    if (used + candidate.bytes <= room) { warm.push(candidate.role); used += candidate.bytes; }
    else skipped.push({ role: candidate.role, reason: "It would not fit in memory beside the others with the computer's working room left over, so it loads when first used." });
  }
  return { warm, skipped };
}

export function keepWarmEnabled(): boolean { return settingValues()["stack.runtime.keep_warm"] !== false; }

let status: WarmupStatus = { state: "idle", startedAt: null, finishedAt: null, trigger: null, roles: [] };
let running: Promise<WarmupStatus> | null = null;
let rerun: string | null = null;
/** The process roles the last warm-up brought up; the idle unload spares them. */
let warmed = new Set<RoleId>();

export function warmupStatus(): WarmupStatus { return { ...status, roles: status.roles.map((row) => ({ ...row })) }; }
export function warmedRoles(): RoleId[] { return [...warmed]; }

function candidatesNow(): WarmCandidate[] {
  const out: WarmCandidate[] = [];
  const seen = new Set<RoleId>();
  for (const role of WARM_ORDER) {
    const owner = processRoleFor(role);
    if (seen.has(owner)) continue;
    const model = selectedModel(owner);
    if (!model?.modelPath) continue;
    seen.add(owner);
    out.push({ role, bytes: Math.ceil(model.measuredFootprintBytes ?? (model.sizeBytes ?? 0) * FOOTPRINT_FACTOR) });
  }
  return out;
}

/** The one-token request that primes the engine's kernels, per role. */
async function prime(role: RoleId): Promise<void> {
  if (role === "chat" || role === "judge") await requestRole(role, "/v1/chat/completions", { model: role, messages: [{ role: "user", content: "Hi" }], max_tokens: 1, temperature: 0 });
  else if (role === "embed") await requestRole(role, "/v1/embeddings", { model: role, input: "Hi" });
}

function setRole(role: RoleId, patch: Partial<WarmRoleReport>): void {
  status = { ...status, roles: status.roles.map((row) => (row.role === role ? { ...row, ...patch } : row)) };
}

async function run(trigger: string): Promise<WarmupStatus> {
  const tier: GovernorTier = currentMachineTier() ?? getGovernorStatus().tier;
  const loaded = getGovernorStatus().loaded;
  const candidates = candidatesNow();
  const residentBytes = loaded.filter((item) => candidates.every((c) => processRoleFor(c.role) !== item.id)).reduce((sum, item) => sum + item.peakBytes, 0);
  const plan = planWarmSet(candidates, defaultModelBudgetBytes(), GovernorRules.tiers[tier].workingMarginBytes, residentBytes);
  status = {
    state: "warming", startedAt: new Date().toISOString(), finishedAt: null, trigger,
    roles: candidates.map((c) => {
      const skip = plan.skipped.find((s) => s.role === c.role);
      return { role: c.role, state: skip ? "skipped" as const : "pending" as const, reason: skip?.reason ?? null, ms: null };
    }),
  };
  for (const role of plan.warm) {
    const began = Date.now();
    setRole(role, { state: "warming" });
    try {
      await getProcess(role);
      await prime(role);
      warmed.add(processRoleFor(role));
      setRole(role, { state: "warm", ms: Date.now() - began });
    } catch (error) {
      setRole(role, { state: "failed", reason: (error as Error).message, ms: Date.now() - began });
    }
  }
  status = { ...status, state: "ready", finishedAt: new Date().toISOString() };
  logger.appendLine(JSON.stringify({ event: "warmup.done", trigger, roles: status.roles.map(({ role, state, ms }) => ({ role, state, ms })) }));
  return warmupStatus();
}

/** Warm the machine now. A call while a warm-up runs joins it. With the
 * setting off it only records that nothing was warmed. */
export function warmUp(trigger = "request"): Promise<WarmupStatus> {
  if (!keepWarmEnabled()) return Promise.resolve(warmupStatus());
  // A trigger during a run (a second model finished installing) reruns
  // once at the end, so the candidates are read again.
  if (running) { rerun = trigger; return running; }
  running = (async () => {
    let result = await run(trigger);
    while (rerun) { const next = rerun; rerun = null; result = await run(next); }
    return result;
  })().finally(() => { running = null; });
  return running;
}

export function __resetWarmupForTests(): void {
  status = { state: "idle", startedAt: null, finishedAt: null, trigger: null, roles: [] };
  running = null;
  rerun = null;
  warmed = new Set();
}
