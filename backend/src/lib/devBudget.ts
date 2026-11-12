// DEV-BUDGET-01 (2026-11-12): development work on this computer has one budget, owned by Home's dev job launcher (scripts/jobs/job.ts in
// getmaipai/home, MAIPAI_DEV_BUDGET_GB, 24 by default). The launcher writes jobs/dev-load.json every tick while it runs a dev server:
//   { "version": 1, "ts": <epoch seconds>, "budget_gb": 24, "reserve_gb": 24, "used_gb": 2.15 }
// The budget is a reserve for ordinary development tooling (dev hubs, tests, builds). It is NOT a cap on big jobs: a picture or video job a
// development session asks for is limited only by the Stack's own admission, never by the budget. The one thing the budget does is this: the
// governor subtracts `reserve_gb` from what it can admit. `reserve_gb` equals the budget, except that it is 0 while the lease broker holds a
// heavy development lease (video, images, whole machine) in DIRECT mode (nobody on the hub): then the Stack may take that room, and the
// reserve comes back when the lease ends. In GATED mode the family is on the hub and the reserve is never released. Files without
// `reserve_gb` (older launchers) reserve the budget. The governor keeps the reserve back instead of trusting the kernel's "available" figure, which
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

export interface DevBudget { budgetBytes: number; usedBytes: number; /** What the governor subtracts when it admits: the budget, or 0 while a heavy lease holds the machine in direct mode. */ reserveBytes: number }
let override: DevBudget | null | undefined;
export function __setDevBudgetForTestsOnly(value: DevBudget | null | undefined): void { override = value; }

export const devLoadFile = (): string => process.env.MAIPAI_DEV_LOAD_FILE ?? join(process.env.MAIPAI_JOBS_DIR ?? join(homedir(), ".local", "state", "maipai", "jobs"), "dev-load.json");

/** Pure: the budget a dev-load.json text says, or zeros when it is missing, malformed or stale. */
export function parseDevLoad(text: string | null, nowMs = Date.now()): DevBudget {
  const none: DevBudget = { budgetBytes: 0, usedBytes: 0, reserveBytes: 0 };
  if (!text) return none;
  try {
    const v = JSON.parse(text) as { version?: unknown; ts?: unknown; budget_gb?: unknown; reserve_gb?: unknown; used_gb?: unknown };
    if (v.version !== 1 || typeof v.ts !== "number" || typeof v.budget_gb !== "number" || typeof v.used_gb !== "number") return none;
    if (!Number.isFinite(v.ts) || nowMs / 1000 - v.ts > DEV_LOAD_FRESH_SECONDS || v.budget_gb <= 0 || v.used_gb < 0) return none;
    const reserveGb = typeof v.reserve_gb === "number" && v.reserve_gb >= 0 ? Math.min(v.reserve_gb, v.budget_gb) : v.budget_gb;
    return { budgetBytes: Math.min(Math.round(v.budget_gb * GB), DEV_RESERVE_MAX_BYTES), usedBytes: Math.round(v.used_gb * GB), reserveBytes: Math.min(Math.round(reserveGb * GB), DEV_RESERVE_MAX_BYTES) };
  } catch { return none; }
}

let cache: { at: number; value: DevBudget } | null = null;
export function readDevBudget(nowMs = Date.now()): DevBudget {
  if (override !== undefined) return override ?? { budgetBytes: 0, usedBytes: 0, reserveBytes: 0 };
  if (process.env.MAIPAI_STACK_DEV_BUDGET === "off") return { budgetBytes: 0, usedBytes: 0, reserveBytes: 0 };
  if (cache && nowMs - cache.at < 2_000) return cache.value;
  let text: string | null = null;
  try { text = readFileSync(devLoadFile(), "utf8"); } catch { /* no launcher running */ }
  cache = { at: nowMs, value: parseDevLoad(text, nowMs) };
  return cache.value;
}

/** What the governor subtracts when it admits, on top of its working margin (the budget, or 0 during a heavy lease in direct mode). */
export const devReserveBytes = (): number => readDevBudget().reserveBytes;
