// The Resources screen's pure helpers (admin-ui/src/resourceData.ts): the budget bar,
// the chart rows and the plain-words pressure badge. No React, no network.
import { expect, test } from "bun:test";
import { budgetSegments, chartRoles, lineRows, memoryRows, pressureWord, seriesColor } from "../../admin-ui/src/resourceData";
import type { History, Point, Summary } from "../../admin-ui/src/resourceData";

const GB = 1024 ** 3;
const point = (t: number, over: Partial<Point> = {}): Point => ({
  t, n: 1, total: 100 * GB, avail: 40 * GB, wired: 0, compressed: 0, swap: GB, pressure: 1, used: 60 * GB, used_max: 60 * GB,
  stack: 30 * GB, stack_max: 30 * GB, other: 30 * GB, procs: { "llama-server": 20 * GB, "mlx-audio": 8 * GB, ps: GB / 4 }, cpu: 10, cpu_max: 12,
  stack_cpu: 1, stack_cpu_max: 1, gpu: null, disk: null, tps: null, queue: 0, ...over,
});
const roles = [{ id: "llama-server", color_key: "series-1" }, { id: "mlx-audio", color_key: "series-2" }, { id: "ps", color_key: "series-3" }];

test("the budget bar splits memory by engine, groups tiny processes, and never passes 100 percent", () => {
  const summary: Summary = {
    sampled_at: "now", current: point(1),
    last_hour: { memory_used_peak_bytes: 0, memory_used_mean_bytes: 0, cpu_peak: null, cpu_mean: null, queue_peak: 0, samples: 1 },
    roles: roles.map((r) => ({ ...r, current_bytes: point(1).procs[r.id] ?? 0, peak_bytes: 0, mean_bytes: 0 })),
  };
  const seg = budgetSegments(summary);
  expect(seg.map((s) => s.id)).toEqual(["llama-server", "mlx-audio", "small", "other", "free"]);
  expect(seg[0]?.percent).toBeCloseTo(20);
  expect(seg.reduce((n, s) => n + s.percent, 0)).toBeLessThanOrEqual(100.0001);
  expect(budgetSegments({ ...summary, current: null })).toEqual([]);
});

test("the stacked chart keeps the big processes and folds the rest into 'other'", () => {
  const h: History = { range: "1h", step_seconds: 5, points: [point(1), point(2)], roles };
  expect(chartRoles(h).map((r) => r.id)).toEqual(["llama-server", "mlx-audio"]);
  const row = memoryRows(h)[0]!;
  expect(row["llama-server"]).toBeCloseTo(20);
  expect(row.other).toBeCloseTo(60 - 28); // used minus the two named processes
});

test("a missing reading stays a gap, and tokens per second add up across roles", () => {
  const h: History = { range: "1h", step_seconds: 5, points: [point(1, { cpu: null }), point(2, { tps: { chat: 20, helper: 5 } })], roles };
  const rows = lineRows(h);
  expect(rows[0]?.cpu).toBeNull();
  expect(rows[0]?.tps).toBeNull();
  expect(rows[1]?.tps).toBe(25);
});

test("pressure and series colors use plain words and kit tokens only", () => {
  expect(pressureWord(1).word).toBe("Comfortable");
  expect(pressureWord(2).word).toBe("Getting tight");
  expect(pressureWord(4).word).toBe("Critical");
  expect(pressureWord(undefined).word).toBe("Unknown");
  for (const k of ["series-1", "series-8", "series-9", "nonsense"]) expect(seriesColor(k)).toMatch(/^var\(--[a-z0-9-]+\)$/);
});
