// STACK-FIT-UI-01: what one plan row needs and how much room it leaves, in plain words, from the plan's own peaks (the Stack's measured
// footprints where it has them, else its estimate), never from the computer's total memory. No React, so a test can pin the words and the maths.
import type { Plan, PlanRole } from "./api";
import { bytes } from "./format";

const GB = 1_073_741_824;
const gb1 = (n: number): string => `${(Math.abs(n) / GB).toFixed(1)} GB`;

export interface FitCellData {
  needBytes: number;
  /** What is free once this row is loaded; negative when it does not fit. */
  headroomBytes: number;
  over: boolean;
  headline: string;
  basis: "measured" | "estimated, not measured here";
  /** The bar, in percent of the width: what is already loaded, where this row's need ends, and where the limit is. The bar is wider than the limit only when the row runs past it. */
  usedPct: number;
  endPct: number;
  limitPct: number;
}

/** A row's cell, or null when the row has nothing to say (turned off, unavailable, or no peak known). */
export function fitCell(role: PlanRole, budget: Plan["budget"]): FitCellData | null {
  if (role.state === "off" || role.state === "unavailable" || !role.peak_bytes) return null;
  const need = role.peak_bytes;
  // A resident row's memory is already in `resident_bytes`; an on-demand one is loaded on top of it.
  const loadsOnTop = role.state === "on_demand" || role.state === "installed";
  const headroom = loadsOnTop ? budget.room_bytes - need : budget.room_bytes;
  const cap = budget.resident_cap_bytes;
  const end = (loadsOnTop ? budget.resident_bytes + need : Math.max(budget.resident_bytes, need));
  const scale = Math.max(cap, end);
  const pct = (n: number) => Math.round((n / scale) * 1000) / 10;
  const over = headroom < 0;
  return {
    needBytes: need,
    headroomBytes: headroom,
    over,
    headline: `Needs ${bytes(need) === "unknown" ? "an unknown amount" : gb1(need)}, ${over ? `${gb1(headroom)} over` : `${gb1(headroom)} free`}`,
    basis: role.basis === "estimated" ? "estimated, not measured here" : "measured",
    usedPct: pct(budget.resident_bytes),
    endPct: pct(end),
    limitPct: pct(cap),
  };
}
