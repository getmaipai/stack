// STACK-FIT-UI-01: each plan row says what it needs and how much room is left in plain words, from the plan's own measured peaks (never total RAM);
// a row that does not fit draws its bar past the limit.
import { expect, test } from "bun:test";
import { fitCell } from "../../admin-ui/src/fitCell";
import type { Plan, PlanRole } from "../../admin-ui/src/api";

const GB = 1_073_741_824;
const budget: Plan["budget"] = { total_bytes: 64 * GB, resident_cap_bytes: 48 * GB, resident_bytes: 40 * GB, room_bytes: 8 * GB, tight: false };
const row = (over: Partial<PlanRole>): PlanRole => ({ role: "chat", enabled: true, priority: 1, state: "resident", fit: "fits", reason: "", peak_bytes: 20 * GB, ...over });

test("a resident row says what it holds and how much memory is still free", () => {
  const cell = fitCell(row({}), budget)!;
  expect(cell.needBytes).toBe(20 * GB);
  expect(cell.headline).toBe("Needs 20.0 GB, 8.0 GB free");
  expect(cell.over).toBe(false);
});

test("an on-demand row that is bigger than the room says how far over it is, and its bar runs past the limit", () => {
  const cell = fitCell(row({ role: "image", state: "on_demand", peak_bytes: 8.9 * GB, fit: "queues" }), budget)!;
  expect(cell.headline).toBe("Needs 8.9 GB, 0.9 GB over");
  expect(cell.over).toBe(true);
  expect(cell.usedPct).toBeLessThan(cell.limitPct);
  expect(cell.endPct).toBeGreaterThan(cell.limitPct);
});

test("an on-demand row that fits says what stays free after it loads", () => {
  expect(fitCell(row({ role: "image", state: "on_demand", peak_bytes: 4.3 * GB }), budget)!.headline).toBe("Needs 4.3 GB, 3.7 GB free");
});

test("an estimate is labelled; a row with no peak or turned off has no cell", () => {
  expect(fitCell(row({ basis: "estimated" } as Partial<PlanRole>), budget)!.basis).toBe("estimated, not measured here");
  expect(fitCell(row({ peak_bytes: undefined }), budget)).toBeNull();
  expect(fitCell(row({ state: "off" }), budget)).toBeNull();
});
