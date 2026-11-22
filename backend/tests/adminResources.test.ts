// The Resources screen's pure helpers (admin-ui/src/resourceData.ts): the budget bar,
// the chart rows and the plain-words pressure badge. No React, no network.
import { expect, test } from "bun:test";
import { budgetSegments, chartRoles, hasRoleHistory, historyRoles, lineRows, loadRows, memoryRows, nowSegments, pressureWord, roleColor, roleHistoryRows, seriesColor, shortWhy, sortEngines, stateWord, visibleMarkers, whyLine } from "../../admin-ui/src/resourceData";
import type { EngineRow, History, Point, Summary } from "../../admin-ui/src/resourceData";

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

// ---- The detail screen (2026-11-21) ----
const size = (n: number) => `${(n / GB).toFixed(1)} GB`;
const engine = (role: string, over: Partial<EngineRow> = {}): EngineRow => ({
  role, label: role[0]!.toUpperCase() + role.slice(1), serves: [], state: "idle", engine: "llama-server", pid: 10, model_id: "m", model_bytes: 5 * GB, memory_bytes: 6 * GB, peak_bytes_24h: 7 * GB, mean_bytes_24h: 5 * GB,
  started_at: null, uptime_seconds: 60, restarts_24h: 0, restarts_7d: 0, last_used_at: null, idle_seconds: null, residency: "resident", memory_class: "reserved", keep_warm_minutes: null, idle_ttl_seconds: null, pinned: false, priority: 100,
  active_requests: 0, queue_position: null, tokens_per_second: null, ...over,
});

test("the now bar splits the computer by feature, then everything else, then free, and never passes 100 percent", () => {
  const cur = point(1, { used: 60 * GB, avail: 40 * GB });
  const seg = nowSegments(cur, [engine("tts", { memory_bytes: 2 * GB }), engine("chat", { memory_bytes: 9 * GB }), engine("video", { memory_bytes: 0, state: "queued" })], (id) => (id ? "Qwen" : null));
  expect(seg.map((s) => s.id)).toEqual(["chat", "tts", "other", "free"]);
  expect(seg[0]?.detail).toBe("Qwen");
  expect(seg[2]?.bytes).toBe(49 * GB);
  expect(seg.reduce((n, s) => n + s.percent, 0)).toBeLessThanOrEqual(100.0001);
  expect(nowSegments(null, [])).toEqual([]);
});

test("history by feature keeps the big roles, folds the rest into other, and falls back when old points have no roles", () => {
  const withRoles = (t: number): Point => point(t, { roles: { chat: 9 * GB, tts: 2 * GB, tiny: GB / 100 } });
  const h: History = { range: "1h", step_seconds: 5, points: [withRoles(1), withRoles(2)], roles, engine_roles: [{ id: "chat", color_key: "series-1" }, { id: "tts", color_key: "series-2" }, { id: "tiny", color_key: "series-3" }] };
  expect(hasRoleHistory(h)).toBe(true);
  expect(historyRoles(h)).toEqual(["chat", "tts"]);
  const row = roleHistoryRows(h, ["chat", "tts"])[0]!;
  expect(row.chat).toBeCloseTo(9);
  expect(row.other).toBeCloseTo(60 - 11);
  expect(hasRoleHistory({ ...h, points: [point(1)] })).toBe(false);
  expect(loadRows(h)[0]).toEqual({ t: 1, cpu: 10, gpu: null });
});

test("the explanation names the purpose, the model file, and why the engine stays in memory", () => {
  const chat = engine("chat", { serves: ["judge", "router"], memory_bytes: 9 * GB });
  const text = whyLine(chat, "Qwen3 8B", size);
  expect(text).toContain("Chat answers questions");
  expect(text).toContain("Qwen3 8B, a 5.0 GB file");
  expect(text).toContain("more than the file");
  expect(text).toContain("stays loaded");
  expect(text).toContain("judge and router");
  expect(whyLine(engine("image", { residency: "jit", idle_ttl_seconds: 600, memory_bytes: 5 * GB }), null, size)).toContain("unloads after 10 minutes");
  expect(whyLine(engine("helper", { residency: "jit", keep_warm_minutes: 1, memory_bytes: 5 * GB }), null, size)).toContain("ready for 1 minute after");
  expect(whyLine(engine("coding", { pinned: true }), null, size)).toContain("pinned");
  expect(whyLine(engine("video", { state: "queued" }), null, size)).toContain("waiting for enough free memory");
  expect(shortWhy(engine("tts"))).toBe("Tts turns text into speech. Stays loaded so answers start at once.");
  expect(stateWord("queued")).toBe("Queued");
});

test("the engine table sorts by any column, biggest first, and ties keep a steady order", () => {
  const rows = [engine("b", { memory_bytes: 2 * GB, uptime_seconds: 5, restarts_24h: 3, peak_bytes_24h: null }), engine("a", { memory_bytes: 2 * GB, uptime_seconds: null }), engine("c", { memory_bytes: 9 * GB, uptime_seconds: 900 })];
  expect(sortEngines(rows, "memory").map((r) => r.role)).toEqual(["c", "a", "b"]);
  expect(sortEngines(rows, "uptime").map((r) => r.role)).toEqual(["c", "b", "a"]);
  expect(sortEngines(rows, "restarts").map((r) => r.role)).toEqual(["b", "a", "c"]);
  expect(sortEngines(rows, "peak", false).map((r) => r.role)).toEqual(["b", "a", "c"]);
  expect(sortEngines(rows, "name").map((r) => r.role)).toEqual(["a", "b", "c"]);
  expect(rows.map((r) => r.role)).toEqual(["b", "a", "c"]); // the input is not reordered
});

test("feature colors are kit tokens, stable per feature, and markers outside the chart are left out", () => {
  expect(roleColor("chat")).toBe(roleColor("chat"));
  expect(roleColor("chat")).not.toBe(roleColor("coding"));
  for (const id of ["chat", "rerank", "wakeword", "brand-new-role"]) expect(roleColor(id)).toMatch(/^(var\(--[a-z0-9-]+\)|color-mix\(in oklab, .+\))$/);
  expect(roleColor("x")).not.toMatch(/#|rgb|hsl/);
  const m = (t: number) => ({ t, kind: "loaded" as const, role: "chat", text: "x" });
  expect(visibleMarkers([m(1), m(5), m(9)], 2, 8).map((x) => x.t)).toEqual([5]);
  expect(visibleMarkers([m(1), m(2), m(3)], 0, 10, 2).map((x) => x.t)).toEqual([2, 3]);
});
