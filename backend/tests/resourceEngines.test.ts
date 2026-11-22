// The Resources detail screen's backend: per-role memory in the history points, the timeline
// markers kept from the event feed, and the per-engine rows route. No real engine runs.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __setResourceHistoryForTests, aggregate, createCollector, ResourceHistory, type Point } from "@/lib/resourceHistory";
import { ResourceEvents, __setResourceEventsForTests } from "@/lib/resourceEvents";
import { __resetGovernorForTests } from "@/lib/governor";
import { getProcess, resetSupervisorForTests, scriptedProcess, setSupervisorFactoryForTests, engineProcessRows } from "@/lib/supervisor";
import { MemoryWatchdog } from "@/lib/memoryWatchdog";
import type { EventEnvelope } from "@/events";

const GB = 1024 ** 3, MIN = 60_000, DAY = 86_400_000;
let dir: string;
let clock = 1_800_000_000_000;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "resdetail-")); clock = 1_800_000_000_000; });
afterEach(() => { __setResourceHistoryForTests(null); __setResourceEventsForTests(null); setSupervisorFactoryForTests(null); resetSupervisorForTests(); __resetGovernorForTests(); rmSync(dir, { recursive: true, force: true }); });

const pt = (t: number, over: Partial<Point> = {}): Point => ({
  t, n: 1, total: 100 * GB, avail: 40 * GB, wired: 0, compressed: 0, swap: 0, pressure: 1, used: 60 * GB, used_max: 60 * GB, stack: 20 * GB, stack_max: 20 * GB, other: 40 * GB,
  procs: { "llama-server": 14 * GB }, roles: { chat: 9 * GB, tts: 2 * GB }, cpu: 10, cpu_max: 10, stack_cpu: 1, stack_cpu_max: 1, gpu: null, disk: null, tps: null, queue: 0, ...over,
});
const feed = (id: string, data: Record<string, unknown>): EventEnvelope => ({ id, data, at: new Date(clock).toISOString(), seq: 1 }) as unknown as EventEnvelope;

test("points keep memory by role, averaged by sample count, and old points without it still read", () => {
  const a = aggregate([pt(0, { roles: { chat: 10 * GB } }), pt(5000, { roles: { chat: 20 * GB, tts: 4 * GB } })], 0);
  expect(a.roles).toEqual({ chat: 15 * GB, tts: 2 * GB });
  const old = aggregate([{ ...pt(0), roles: undefined }], 0);
  expect(old.roles).toBeUndefined();
});

test("the collector asks for the role pids and records the bytes the view attributes to each role", () => {
  let asked: Array<{ role: string; pid: number }> = [];
  const collect = createCollector({
    now: () => clock, cpuTimes: () => ({ idle: 1, total: 2 }), ownCpuSeconds: () => 0, coreCount: () => 1, diskBytes: () => 0, queueDepth: () => 0,
    rolePids: () => [{ role: "chat", pid: 11 }],
    view: (pids) => { asked = pids; return { stackBytes: 5, nonStackBytes: 1, procs: [{ name: "llama-server", bytes: 5 }], roles: { chat: 5 } }; },
  });
  const p = collect({ at: clock, totalBytes: 100, availableBytes: 50, wiredBytes: 0, compressorBytes: 0, swapUsedBytes: 0, pressureLevel: 1 } as never);
  expect(asked).toEqual([{ role: "chat", pid: 11 }]);
  expect(p.roles).toEqual({ chat: 5 });
});

test("markers: loads, unloads, restarts within two minutes of a stop, one mode switch per change, problems", () => {
  const events = new ResourceEvents(join(dir, "events.ndjson"), () => clock);
  events.handle(feed("engine.state", { engine: "chat", state: "ready" }));
  clock += MIN;
  events.handle(feed("engine.state", { engine: "image", state: "installed", reason: "Unloaded after 10 minutes without a request." }));
  clock += MIN;
  events.handle(feed("engine.state", { engine: "tts", state: "stopped", reason: "Stopped by an admin" }));
  clock += 30_000;
  events.handle(feed("engine.state", { engine: "tts", state: "loading" }));
  events.handle(feed("engine.state", { engine: "stt", state: "loading" })); // a first start is not a restart
  clock += MIN;
  events.handle(feed("role.state", { role: "chat", state: "loaded", cause: "mode_change" }));
  events.handle(feed("role.state", { role: "judge", state: "loaded", cause: "mode_change" })); // same change, same moment
  clock += MIN;
  events.handle(feed("engine.state", { engine: "coding", state: "offline", reason: "The spawned engine exited unexpectedly." }));
  const all = events.query(DAY);
  expect(all.map((m) => `${m.kind}:${m.role}`)).toEqual(["loaded:chat", "unloaded:image", "unloaded:tts", "restart:tts", "mode:chat", "problem:coding"]);
  expect(all.find((m) => m.kind === "unloaded" && m.role === "image")?.text).toBe("Unloaded after 10 minutes without a request.");
  expect(all.find((m) => m.kind === "restart")?.text).toBe("The Voice out engine restarted.");
  expect(events.restarts(DAY)).toEqual({ tts: 1 });
  expect(events.query(MIN).length).toBe(2);
});

test("old markers are trimmed after 30 days and a damaged line is skipped", () => {
  const path = join(dir, "events.ndjson");
  writeFileSync(path, `${JSON.stringify({ t: clock - 31 * DAY, kind: "loaded", role: "chat", text: "old." })}\nnot json\n${JSON.stringify({ t: clock - DAY, kind: "loaded", role: "tts", text: "new." })}\n`);
  const events = new ResourceEvents(path, () => clock);
  expect(events.read().length).toBe(2);
  events.trim();
  expect(events.read().map((m) => m.role)).toEqual(["tts"]);
});

test("the events route returns markers for a range", async () => {
  const events = new ResourceEvents(join(dir, "events.ndjson"), () => clock);
  __setResourceEventsForTests(events);
  events.handle(feed("engine.state", { engine: "chat", state: "ready" }));
  const body = await (await app.request("/stack/v1/resources/events?range=1h")).json() as { range: string; events: { kind: string; role: string }[] };
  expect(body.range).toBe("1h");
  expect(body.events).toEqual([expect.objectContaining({ kind: "loaded", role: "chat" })]);
  expect((await app.request("/stack/v1/resources/events?range=2y")).status).toBe(400);
});

test("the engines route lists each role with memory, peak, restarts and the facts that explain it", async () => {
  const h = new ResourceHistory({ dir: join(dir, "history"), now: () => Date.now() });
  __setResourceHistoryForTests(h);
  const events = new ResourceEvents(join(dir, "events.ndjson"));
  __setResourceEventsForTests(events);
  events.handle(feed("engine.state", { engine: "chat", state: "stopped" }));
  events.handle(feed("engine.state", { engine: "chat", state: "loading" }));
  const now = Date.now();
  h.record(pt(now - 60_000, { roles: { chat: 12 * GB, tts: 2 * GB } }));
  h.record(pt(now - 10_000, { roles: { chat: 9 * GB, tts: 2 * GB } }));
  setSupervisorFactoryForTests(async (role) => scriptedProcess(role, { kind: "spawned" }));
  await getProcess("chat");
  expect(engineProcessRows().map((r) => r.role)).toContain("chat");
  const body = await (await app.request("/stack/v1/resources/engines")).json() as { engines: Array<Record<string, unknown>>; budget: { total_bytes: number } };
  const chat = body.engines.find((e) => e.role === "chat")!;
  const tts = body.engines.find((e) => e.role === "tts")!;
  expect(chat).toMatchObject({ label: "Chat", state: "idle", residency: "resident", memory_bytes: 9 * GB, restarts_24h: 1, tokens_per_second: null });
  expect(chat.serves).toEqual(["judge", "router"]);
  expect(chat.peak_bytes_24h).toBeGreaterThanOrEqual(9 * GB);
  expect(tts).toMatchObject({ label: "Voice out", pid: null, uptime_seconds: null, memory_bytes: 2 * GB });
  expect(body.engines[0]!.role).toBe("chat"); // biggest first
  expect(body.budget.total_bytes).toBeGreaterThan(0);
});

test("the watchdog view groups bytes by role: the role's process and everything below it", () => {
  const dog = new MemoryWatchdog({ ownPid: 500, engineRoots: [], workerEntries: [], kill: () => {}, commandOf: () => null, folderBytes: () => 0, runSweeps: () => {}, chatLoaded: () => false });
  const row = (pid: number, ppid: number, rssBytes: number, name: string) => ({ pid, ppid, rssBytes, ageSeconds: 100, name, command: name });
  (dog as unknown as { rows: unknown[] }).rows = [row(500, 1, 100, "bun"), row(600, 500, 8 * GB, "llama-server"), row(601, 600, GB, "helper"), row(700, 500, 2 * GB, "python"), row(900, 1, 5 * GB, "browser")];
  const view = dog.resourceView([{ role: "chat", pid: 600 }, { role: "tts", pid: 700 }, { role: "gone", pid: 4242 }]);
  expect(view.roles).toEqual({ chat: 9 * GB, tts: 2 * GB });
  expect(view.nonStackBytes).toBe(5 * GB);
  expect(dog.resourceView().roles).toEqual({});
});
