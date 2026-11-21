import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __setResourceHistoryForTests, aggregate, chooseStep, createCollector, ResourceHistory, type Point } from "@/lib/resourceHistory";

const SEC = 1000, MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % DAY); // a day boundary
let dir: string;
let clock = T0 + 40 * DAY;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "reshist-")); clock = T0 + 40 * DAY; });
afterEach(() => { __setResourceHistoryForTests(null); rmSync(dir, { recursive: true, force: true }); });

const pt = (t: number, over: Partial<Point> = {}): Point => ({
  t, n: 1, total: 100, avail: 40, wired: 10, compressed: 5, swap: 0, pressure: 1, used: 60, used_max: 60, stack: 20, stack_max: 20, other: 40,
  procs: { chat: 15, stt: 5 }, cpu: 10, cpu_max: 10, stack_cpu: 2, stack_cpu_max: 2, gpu: null, disk: 1000, tps: null, queue: 0, ...over,
});
const make = (maxBytes?: number) => new ResourceHistory({ dir, now: () => clock, ...(maxBytes ? { maxBytes } : {}) });
const files = () => readdirSync(dir).sort();

test("aggregate averages by sample count and keeps maxima, worst pressure and null gaps", () => {
  const a = aggregate([pt(0, { used: 50, used_max: 50, cpu: 10, cpu_max: 10, pressure: 1, procs: { chat: 10 } }), pt(5000, { used: 70, used_max: 90, cpu: 30, cpu_max: 80, pressure: 4, procs: { chat: 20, tts: 6 }, gpu: null })], 0);
  expect(a.n).toBe(2);
  expect(a.used).toBe(60);
  expect(a.used_max).toBe(90);
  expect(a.cpu).toBe(20);
  expect(a.cpu_max).toBe(80);
  expect(a.pressure).toBe(4);
  expect(a.procs).toEqual({ chat: 15, tts: 3 });
  expect(a.gpu).toBeNull();
  const weighted = aggregate([pt(0, { n: 12, used: 10 }), pt(1, { n: 4, used: 50 })], 0);
  expect(weighted.used).toBe(20);
});

test("append writes newline JSON in hourly segments", () => {
  const h = make();
  clock = T0 + 40 * DAY + 5 * SEC;
  h.record(pt(clock - 5 * SEC)); h.record(pt(clock)); h.record(pt(clock + HOUR));
  expect(files().length).toBe(2);
  const text = readFileSync(join(dir, files()[0]!), "utf8");
  expect(text.endsWith("\n")).toBe(true);
  expect(text.trim().split("\n").length).toBe(2);
});

test("raw samples older than 24 h fold into 1 minute means and the raw file goes", () => {
  const h = make();
  const base = clock - 3 * DAY;
  for (let i = 0; i < 24; i++) h.record(pt(base + i * 5 * SEC, { used: 60 + i, used_max: 60 + i }));
  h.maintain();
  expect(files().every((f) => f.startsWith("min-"))).toBe(true);
  const q = h.query("7d", 60);
  const inMinute = q.points.filter((p) => p.n > 1);
  expect(inMinute.length).toBeGreaterThan(0);
  expect(q.points.reduce((s, p) => s + p.n, 0)).toBe(24);
});

test("minute segments older than 7 days fold into hours; hour segments older than 30 days are deleted", () => {
  const h = make();
  const old = clock - 10 * DAY;
  for (let i = 0; i < 120; i++) h.record(pt(old + i * MIN)); // two hours of one-minute points written as raw
  clock = old + 2 * DAY; h.maintain(); // raw to minute
  expect(files().every((f) => f.startsWith("min-"))).toBe(true);
  clock = old + 9 * DAY; h.maintain(); // minute to hour
  expect(files().every((f) => f.startsWith("hr-"))).toBe(true);
  const q = h.query("30d", "auto");
  expect(q.points.reduce((s, p) => s + p.n, 0)).toBe(120);
  clock = old + 45 * DAY; h.maintain();
  expect(files()).toEqual([]);
});

test("a new instance sees what an earlier one wrote", () => {
  const first = make();
  first.record(pt(clock - MIN)); first.record(pt(clock - 5 * SEC));
  const second = make();
  expect(second.query("1h").points.reduce((s, p) => s + p.n, 0)).toBe(2);
  expect(second.summary().current?.t).toBe(clock - 5 * SEC);
});

test("a truncated last line is skipped and the next append starts a fresh line", () => {
  const h = make();
  h.record(pt(clock - 10 * SEC));
  const file = join(dir, files()[0]!);
  appendFileSync(file, '{"t":123,"n":1,"tot');
  const again = make();
  again.record(pt(clock - 5 * SEC));
  const q = again.query("1h");
  expect(q.points.reduce((s, p) => s + p.n, 0)).toBe(2);
  expect(readFileSync(file, "utf8").split("\n").filter(Boolean).length).toBe(3);
});

test("range selection returns only points inside the range", () => {
  const h = make();
  h.record(pt(clock - 2 * HOUR)); h.record(pt(clock - 30 * MIN)); h.record(pt(clock - 10 * SEC));
  expect(h.query("1h").points.reduce((s, p) => s + p.n, 0)).toBe(2);
  expect(h.query("24h").points.reduce((s, p) => s + p.n, 0)).toBe(3);
});

test("the point cap holds on every range and the step grows to fit", () => {
  expect(chooseStep("1h")).toBe(10);
  expect(chooseStep("24h")).toBe(300);
  expect(chooseStep("7d")).toBe(1800);
  expect(chooseStep("30d")).toBe(7200);
  expect(chooseStep("1h", 5)).toBe(10);
  expect(chooseStep("1h", 60)).toBe(60);
  const h = make();
  for (let i = 0; i < 1500; i++) h.record(pt(clock - i * 5 * SEC));
  const q = h.query("24h", 5);
  expect(q.points.length).toBeLessThanOrEqual(600);
  expect(q.step_seconds).toBe(300);
});

test("the size cap drops the oldest segments and keeps the newest", () => {
  const h = make(4000);
  for (let hour = 0; hour < 6; hour++) for (let i = 0; i < 3; i++) h.record(pt(clock - (6 - hour) * HOUR + i * 5 * SEC));
  h.enforceCap();
  expect(h.totalBytes()).toBeLessThanOrEqual(4000);
  const left = files();
  expect(left.length).toBeGreaterThan(0);
  expect(left.length).toBeLessThan(6);
  const newestIdx = Math.floor((clock - HOUR) / HOUR);
  expect(left).toContain(`raw-${newestIdx}.ndjson`);
});

test("summary gives current numbers and per role peak and mean for the last hour", () => {
  const h = make();
  h.record(pt(clock - 20 * SEC, { procs: { chat: 10 }, used_max: 70, used: 70, queue: 2 }));
  h.record(pt(clock - 10 * SEC, { procs: { chat: 30 }, used_max: 50, used: 50, queue: 0 }));
  h.record(pt(clock - 2 * HOUR, { procs: { chat: 999 } }));
  const s = h.summary();
  const chat = s.roles.find((r) => r.id === "chat")!;
  expect(chat.peak_bytes).toBe(30);
  expect(chat.mean_bytes).toBe(20);
  expect(chat.current_bytes).toBe(30);
  expect(s.last_hour.memory_used_peak_bytes).toBe(70);
  expect(s.last_hour.queue_peak).toBe(2);
  expect(s.last_hour.samples).toBe(2);
});

test("the collector turns a watchdog sample into a point with CPU deltas and null GPU", () => {
  let idle = 0, total = 0, own = 0;
  const collect = createCollector({
    cpuTimes: () => ({ idle, total }), ownCpuSeconds: () => own, coreCount: () => 4,
    view: () => ({ stackBytes: 30, nonStackBytes: 50, procs: [{ name: "llama-server", bytes: 20 }, { name: "llama-server", bytes: 5 }, { name: "whisper", bytes: 5 }] }),
    diskBytes: () => 777, queueDepth: () => 3,
  });
  const sample = (at: number) => ({ at, totalBytes: 100, availableBytes: 30, freeBytes: 10, wiredBytes: 12, compressorBytes: 4, swapUsedBytes: 1, swapTotalBytes: 8, pressureLevel: 2 as const, pressure: "warn" as never, degraded: false });
  const first = collect(sample(1000));
  expect(first.cpu).toBeNull();
  expect(first.procs).toEqual({ "llama-server": 25, whisper: 5 });
  expect(first.used).toBe(70);
  expect(first.gpu).toBeNull();
  expect(first.tps).toBeNull();
  expect(first.disk).toBe(777);
  expect(first.queue).toBe(3);
  idle = 750; total = 1000; own = 2;
  const second = collect(sample(6000));
  expect(second.cpu).toBeCloseTo(25, 5);
  expect(second.stack_cpu).toBeCloseTo(10, 5);
});

test("the routes return history and summary, read only", async () => {
  const h = make();
  __setResourceHistoryForTests(h);
  h.record(pt(clock - 10 * SEC));
  const res = await app.request("/stack/v1/resources/history?range=1h&step=auto");
  expect(res.status).toBe(200);
  const body = await res.json() as { range: string; step_seconds: number; points: Point[]; roles: Array<{ id: string; color_key: string }> };
  expect(body.range).toBe("1h");
  expect(body.step_seconds).toBe(10);
  expect(body.points.length).toBe(1);
  expect(body.roles.map((r) => r.id)).toEqual(["chat", "stt"]);
  const sum = await app.request("/stack/v1/resources/summary");
  expect(sum.status).toBe(200);
  expect(((await sum.json()) as { current: { t: number } }).current.t).toBe(clock - 10 * SEC);
  expect((await app.request("/stack/v1/resources/history?range=2y")).status).toBe(400);
});
