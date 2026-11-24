import rows from "@/rows/templateRows.json";
import type { HardwareInfo } from "@/lib/hardware";
import { sizingMemory, type MemorySource } from "@/lib/hardware";
import type { RoleId } from "@/roles";

export type { RoleId } from "@/roles";

export interface ProfileTier {
  id: string;
  level: "minimal" | "moderate" | "recommended";
  label: string;
  minUnifiedGb: number;
  minVramGb: number;
  resident: RoleId[];
  onDemand: RoleId[];
  installedOnly: RoleId[];
  notAvailable: RoleId[];
  speedRange: { min: number; max: number };
}

// Rows live in rows/templateRows.json. Vision is not available on p16: measured 2026-10-06 on a 24 GB machine, it does not fit beside the 8B chat under the governor margin (docs/dev.md, "The vision role").
export const PROFILE_TIERS: ProfileTier[] = rows as unknown as ProfileTier[];

let currentBudgetPercent = 100;
export function setBudgetPercent(percent: number): void {
  if (!Number.isFinite(percent)) return;
  currentBudgetPercent = Math.min(100, Math.max(1, percent));
}
export function budgetPercent(): number { return currentBudgetPercent; }

/** Household chat pin by tier: Qwen3 8B on every tier, the highest-priority
 * chat model in the part table that is cleared for Standard (the owner removed
 * the larger chat pins on 2026-11-17). The judge shares chat through p16;
 * from p32 it has its own 4B pin and process. The coding role has its own
 * model from p64 (CODE-STACK-01 S1): Qwen3.8-27B at UD-Q4_K_M, loaded only
 * while someone is coding; p16 and p32 have no coding. */
export const PROFILE_MODEL_BINDINGS: Record<string, Partial<Record<RoleId, string>>> = {
  p16: { chat: "qwen3-8b-instruct-q4-k-m", stt: "moonshine-tiny-en-int8" },
  p32: { chat: "qwen3-8b-instruct-q4-k-m", judge: "qwen3-4b-q4-k-m", stt: "moonshine-tiny-en-int8" },
  p64: { chat: "qwen3-8b-instruct-q4-k-m", judge: "qwen3-4b-q4-k-m", coding: "qwen3.8-27b-ud-q4-k-m", stt: "parakeet-tdt-0.6b-v2-int8" },
  p128: { chat: "qwen3-8b-instruct-q4-k-m", judge: "qwen3-4b-q4-k-m", coding: "qwen3.8-27b-ud-q4-k-m", stt: "parakeet-tdt-0.6b-v2-int8" },
};

/** The tier this machine's sizing memory (see `sizingMemory`) clears, and
 * the memory it was judged on. The figure is rounded to a whole GB first,
 * so a "16 GB" card that reports 15.99 GiB is a 16 GB card. */
export function sizeMachine(hw: HardwareInfo, overrideGb?: number | null): { tier: ProfileTier | null; memoryGb: number; source: MemorySource } {
  let { bytes, source } = sizingMemory(hw, overrideGb);
  if (bytes > 0 && currentBudgetPercent < 100) bytes = Math.floor(bytes * currentBudgetPercent / 100);
  const memoryGb = Math.round((bytes / 1_073_741_824) * 10) / 10;
  const wholeGb = Math.round(memoryGb);
  const unified = source === "unified";
  for (let index = PROFILE_TIERS.length - 1; index >= 0; index -= 1) {
    const tier = PROFILE_TIERS[index];
    if (tier && wholeGb > 0 && wholeGb >= (unified ? tier.minUnifiedGb : tier.minVramGb)) return { tier, memoryGb, source };
  }
  return { tier: null, memoryGb, source };
}

export function proposeProfile(hw: HardwareInfo, overrideGb?: number | null): ProfileTier | null {
  return sizeMachine(hw, overrideGb).tier;
}
