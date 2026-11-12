// DEV-BUDGET-01 (2026-11-12): development work on this computer has one budget, owned by Home's dev job launcher (scripts/jobs/job.ts in
// getmaipai/home, MAIPAI_DEV_BUDGET_GB, 24 by default). The launcher writes jobs/dev-load.json every tick while it runs a dev server:
//   { "version": 1, "ts": <epoch seconds>, "budget_gb": 24, "used_gb": 2.15 }
// The governor reads it here and keeps the whole budget back from admissions, instead of trusting the kernel's "available" figure, which
// counts idle development pages as reclaimable (2026-11-12: it admitted a 61.5 GB video job beside four dev hubs, the kernel swapped, and
// the chat judge was evicted 12 times). No file, a stale file (the launcher writes about every 2 s; older than a minute means no dev
// server runs), or an unreadable one means no reserve. The 20 GB working margin is never lowered; this is added to it. Bytes only.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const GB = 1_073_741_824;
export const DEV_LOAD_FRESH_SECONDS = 60;
/** The most the Stack will ever keep back for development, whatever the file says. */
export const DEV_RESERVE_MAX_BYTES = 48 * GB;

export interface DevBudget { budgetBytes: number; usedBytes: number }
let override: DevBudget | null | undefined;
export function __setDevBudgetForTestsOnly(value: DevBudget | null | undefined): void { override = value; }

export const devLoadFile = (): string => process.env.MAIPAI_DEV_LOAD_FILE ?? join(process.env.MAIPAI_JOBS_DIR ?? join(homedir(), ".local", "state", "maipai", "jobs"), "dev-load.json");

/** Pure: the budget a dev-load.json text says, or zeros when it is missing, malformed or stale. */
export function parseDevLoad(text: string | null, nowMs = Date.now()): DevBudget {
  const none: DevBudget = { budgetBytes: 0, usedBytes: 0 };
  if (!text) return none;
  try {
    const v = JSON.parse(text) as { version?: unknown; ts?: unknown; budget_gb?: unknown; used_gb?: unknown };
    if (v.version !== 1 || typeof v.ts !== "number" || typeof v.budget_gb !== "number" || typeof v.used_gb !== "number") return none;
    if (!Number.isFinite(v.ts) || nowMs / 1000 - v.ts > DEV_LOAD_FRESH_SECONDS || v.budget_gb <= 0 || v.used_gb < 0) return none;
    return { budgetBytes: Math.min(Math.round(v.budget_gb * GB), DEV_RESERVE_MAX_BYTES), usedBytes: Math.round(v.used_gb * GB) };
  } catch { return none; }
}

let cache: { at: number; value: DevBudget } | null = null;
export function readDevBudget(nowMs = Date.now()): DevBudget {
  if (override !== undefined) return override ?? { budgetBytes: 0, usedBytes: 0 };
  if (process.env.MAIPAI_STACK_DEV_BUDGET === "off") return { budgetBytes: 0, usedBytes: 0 };
  if (cache && nowMs - cache.at < 2_000) return cache.value;
  let text: string | null = null;
  try { text = readFileSync(devLoadFile(), "utf8"); } catch { /* no launcher running */ }
  cache = { at: nowMs, value: parseDevLoad(text, nowMs) };
  return cache.value;
}

/** What the governor keeps back for development on top of its working margin. */
export const devReserveBytes = (): number => readDevBudget().budgetBytes;
