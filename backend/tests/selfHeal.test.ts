// ROBUST-01: the Stack restarts an engine that stops on its own. Hermetic:
// a scripted engine factory and a manual clock; no launchctl, no real
// port, no real engine, no waiting.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { classifyCrash } from "@/lib/crashClassifier";
import { __resetEventsForTests } from "@/lib/events";
import { __resetHealthForTests, list as listHealth } from "@/lib/health";
import { __resetJobsForTests, createJob, finishJob } from "@/lib/jobs";
import { __resetMemoryStateForTests, setMemoryLevel } from "@/lib/memoryState";
import { __resetSelfHealForTests, __setSelfHealForTests, __settledForTests, holdSelfHeal, onEngineCrash, selfHealSummary, startSelfHeal, sweepOffline, type Clock } from "@/lib/selfHeal";
import { getProcess, getRoleStatus, reportEngineExit, resetSupervisorForTests, restartRole, scriptedProcess, setSupervisorFactoryForTests, type EngineExit, type RoleProcess } from "@/lib/supervisor";
import type { RoleId } from "@/roles";

interface Timer { at: number; run: () => void; cancelled: boolean }
let t = 0;
let timers: Timer[] = [];
const clock: Clock = {
  now: () => t,
  after(ms, run) { const timer = { at: t + ms, run, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
};
const pending = (): Timer[] => timers.filter((timer) => !timer.cancelled).sort((a, b) => a.at - b.at);
/** Runs the next scheduled timer (moving the clock to it) and waits for the restart it starts. */
async function fire(): Promise<number> {
  const next = pending()[0];
  if (!next) throw new Error("nothing is scheduled");
  const delay = next.at - t;
  timers = timers.filter((timer) => timer !== next);
  t = next.at;
  next.run();
  await __settledForTests();
  return delay;
}
const exit = (over: Partial<EngineExit> = {}): EngineExit => ({ exitCode: 1, signal: null, stderrTail: ["boom"], ranMs: 1000, ...over });

let starts: RoleId[] = [];
let live = 0, maxLive = 0;
let badProbe = false;
async function crash(role: RoleId, over: Partial<EngineExit> = {}): Promise<RoleProcess> {
  const processRecord = await getProcess(role);
  expect(reportEngineExit(role, processRecord, exit(over))).toBe(true);
  return processRecord;
}

beforeEach(() => {
  t = 1_000_000; timers = []; starts = []; live = 0; maxLive = 0; badProbe = false;
  __resetEventsForTests(); __resetHealthForTests(); __resetJobsForTests(); __resetMemoryStateForTests();
  setSupervisorFactoryForTests(async (role) => {
    starts.push(role); live++; maxLive = Math.max(maxLive, live);
    await new Promise((resolve) => setTimeout(resolve, 1));
    live--;
    const base = scriptedProcess(role);
    return badProbe ? { ...base, client: { ...base.client, request: async () => ({ status: 500, body: {} }) } } : base;
  });
  __resetSelfHealForTests();
  __setSelfHealForTests({ clock });
  startSelfHeal(); timers = []; // the sweep's own timer is not under test here
});
afterEach(() => { __resetSelfHealForTests(); __setSelfHealForTests(null); setSupervisorFactoryForTests(null); resetSupervisorForTests(); __resetMemoryStateForTests(); __resetJobsForTests(); });

const crashItem = (role: RoleId) => listHealth().find((item) => item.code === `engine.crashed.${role}`);

test("a crash restarts the engine after 2 seconds, verifies it, clears the item and records the heal", async () => {
  await crash("chat");
  expect(getRoleStatus("chat").state).toBe("offline");
  expect(crashItem("chat")?.text).toContain("restarting it");
  expect(await fire()).toBe(2_000);
  expect(starts).toEqual(["chat", "chat"]);
  expect(getRoleStatus("chat").state).toBe("ready");
  expect(crashItem("chat")).toBeUndefined();
  const summary = selfHealSummary();
  expect(summary.events.map((event) => event.kind)).toEqual(["crashed", "healed"]);
  expect(summary.events[1]).toMatchObject({ role: "chat", seconds: 2 });
  expect(summary.crashesByDay.at(-1)).toMatchObject({ crashes: 1, healed: 1, gaveUp: 0 });
});

test("repeated crashes back off 2 s, 10 s, 30 s, 2 min, then the circuit opens with the last log lines and the Restart fix", async () => {
  const delays: number[] = [];
  const lines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`);
  for (let i = 0; i < 4; i++) {
    await crash("chat", { stderrTail: lines });
    delays.push(await fire());
  }
  expect(delays).toEqual([2_000, 10_000, 30_000, 120_000]);
  await crash("chat", { stderrTail: lines });
  expect(pending()).toHaveLength(0);
  const item = crashItem("chat")!;
  expect(item.title).toContain("keeps stopping");
  expect(item.fix).toMatchObject({ label: "Restart engine", action: "restart_engine" });
  expect(item.text).toContain("line 25");
  expect(item.text).not.toContain("line 5\n");
  expect(item.text.split("Last log lines:\n")[1]!.split("\n")).toHaveLength(20);
  expect(selfHealSummary().stopped).toEqual(["chat"]);
  expect(selfHealSummary().crashesByDay.at(-1)!.gaveUp).toBe(1);
  // A later crash does not schedule anything while the circuit is open.
  await crash("chat").catch(() => {});
});

test("a hand restart closes the circuit and forgets the failures", async () => {
  for (let i = 0; i < 4; i++) { await crash("chat"); await fire(); }
  await crash("chat");
  expect(selfHealSummary().stopped).toEqual(["chat"]);
  await restartRole("chat");
  expect(selfHealSummary().stopped).toEqual([]);
  await crash("chat");
  expect(await fire()).toBe(2_000);
});

test("10 minutes healthy resets the count: the next crash waits 2 s again", async () => {
  await crash("chat"); expect(await fire()).toBe(2_000);
  await crash("chat"); expect(await fire()).toBe(10_000);
  t += 10 * 60_000 + 1;
  await crash("chat");
  expect(await fire()).toBe(2_000);
});

test("failures outside the 30 minute window do not count toward the breaker", async () => {
  for (let i = 0; i < 3; i++) { await crash("chat"); await fire(); t += 11 * 60_000; }
  await crash("chat");
  expect(selfHealSummary().stopped).toEqual([]);
});

test("nothing restarts while an install job runs, then it restarts without counting a failure", async () => {
  const job = createJob({ kind: "model.install", status: "downloading" });
  await crash("chat");
  const startsBefore = starts.length;
  expect(await fire()).toBe(2_000);
  expect(starts.length).toBe(startsBefore);
  expect(crashItem("chat")?.text).toContain("install");
  expect(pending()).toHaveLength(1);
  expect(await fire()).toBe(15_000);
  expect(starts.length).toBe(startsBefore);
  finishJob(job.id, { ok: true });
  await fire();
  expect(starts.length).toBe(startsBefore + 1);
  expect(getRoleStatus("chat").state).toBe("ready");
});

test("an engine update holds the restart until it ends", async () => {
  const end = holdSelfHeal("The llama-server update");
  await crash("chat");
  await fire();
  expect(starts).toEqual(["chat"]);
  end();
  await fire();
  expect(starts).toEqual(["chat", "chat"]);
});

test("low memory: the restart waits and does not thrash; it goes when memory recovers", async () => {
  setMemoryLevel("critical");
  await crash("chat", { exitCode: null, signal: "SIGKILL", stderrTail: [] });
  expect(crashItem("chat")?.cause).toContain("ran out of memory");
  for (let i = 0; i < 5; i++) await fire();
  expect(starts).toEqual(["chat"]);
  expect(crashItem("chat")?.text).toContain("low on memory");
  expect(selfHealSummary().stopped).toEqual([]);
  setMemoryLevel("normal");
  await fire();
  expect(starts).toEqual(["chat", "chat"]);
  expect(getRoleStatus("chat").state).toBe("ready");
});

test("a restarted engine that fails the identity or one-token check is not called ready and counts as a failure", async () => {
  await crash("chat");
  badProbe = true;
  await fire();
  expect(getRoleStatus("chat").state).toBe("offline");
  expect(crashItem("chat")?.text).toContain("one-token");
  expect(selfHealSummary().events.map((event) => event.kind)).not.toContain("healed");
  expect(await fire()).toBe(10_000);
  badProbe = false;
  expect(getRoleStatus("chat").state).toBe("offline");
  await fire();
});

test("a cause a retry cannot fix opens the circuit at once", async () => {
  await crash("chat", { stderrTail: ["error: failed to open model file: No such file or directory"] });
  expect(pending()).toHaveLength(0);
  expect(crashItem("chat")?.text).toContain("Reinstall");
  expect(selfHealSummary().stopped).toEqual(["chat"]);
});

test("two engines that died together restart one at a time", async () => {
  await crash("chat"); await crash("embed");
  expect(pending()).toHaveLength(2);
  const [a, b] = pending();
  timers = timers.filter((timer) => timer !== a && timer !== b);
  t = Math.max(a!.at, b!.at); a!.run(); b!.run();
  await __settledForTests();
  expect(maxLive).toBe(1);
  expect(getRoleStatus("chat").state).toBe("ready");
  expect(getRoleStatus("embed").state).toBe("ready");
});

test("an idle on-demand engine (picture) that dies is left for its next request; a busy one restarts", async () => {
  await crash("image");
  expect(pending()).toHaveLength(0);
  const busy = await getProcess("image");
  busy.activeRequests = 1;
  reportEngineExit("image", busy, exit());
  expect(pending()).toHaveLength(1);
});

test("a stop by hand or a retire is not a crash", async () => {
  const processRecord = await getProcess("chat");
  processRecord.retired = true;
  expect(reportEngineExit("chat", processRecord, exit())).toBe(false);
  expect(pending()).toHaveLength(0);
});

test("regression 2026-10-17: a role offline with no process and no request coming is found and restarted", async () => {
  // The crash happened while no listener heard it (or a request path marked it offline): nothing was scheduled.
  const processRecord = await getProcess("chat");
  const { stopSelfHeal } = await import("@/lib/selfHeal");
  stopSelfHeal();
  reportEngineExit("chat", processRecord, exit());
  expect(pending()).toHaveLength(0);
  expect(getRoleStatus("chat").state).toBe("offline");
  startSelfHeal(); timers = [];
  expect(sweepOffline()).toEqual(["chat"]);
  expect(sweepOffline()).toEqual([]);
  await fire();
  expect(getRoleStatus("chat").state).toBe("ready");
  expect(crashItem("chat")).toBeUndefined();
});

test("crash causes read in plain words", () => {
  const v = (over: Parameters<typeof classifyCrash>[0]) => classifyCrash(over);
  expect(v({ exitCode: 1, signal: null, stderrTail: ["ggml_metal: failed to allocate buffer, out of memory"] }).kind).toBe("out_of_memory");
  expect(v({ exitCode: null, signal: "SIGKILL", stderrTail: [], memoryLevel: "critical" }).kind).toBe("out_of_memory");
  expect(v({ exitCode: 137, signal: null, stderrTail: [], memoryLevel: "normal" }).kind).toBe("killed");
  expect(v({ exitCode: 1, signal: null, stderrTail: ["bind: Address already in use"] }).kind).toBe("port_in_use");
  expect(v({ exitCode: 1, signal: null, stderrTail: ["unable to load model: No such file or directory"] })).toMatchObject({ kind: "missing_file", retryHelps: false });
  expect(v({ exitCode: 2, signal: null, stderrTail: ["error: unknown argument: --frobnicate"] })).toMatchObject({ kind: "bad_config", retryHelps: false });
  expect(v({ exitCode: 3, signal: null, stderrTail: [] })).toMatchObject({ kind: "unknown", cause: expect.stringContaining("exit code 3") });
});

test("a canary's restart request recycles a live engine, counts as one failure, never resets the breaker, and is refused when the circuit is open", async () => {
  const { requestEngineRestart } = await import("@/lib/selfHeal");
  await getProcess("chat");
  expect(await requestEngineRestart("chat", "chat_hello got no answer")).toEqual({ accepted: true, why: null });
  expect(getRoleStatus("chat").state).toBe("loading");
  expect(selfHealSummary().events.map((e) => e.kind)).toContain("requested_by_canary");
  expect(selfHealSummary().crashesByDay.at(-1)!.gaveUp).toBe(0);
  expect((await requestEngineRestart("chat", "again")).accepted).toBe(false);
  expect(await fire()).toBe(2_000);
  expect(getRoleStatus("chat").state).toBe("ready");
  for (let i = 0; i < 3; i++) { await crash("chat"); await fire(); }
  await crash("chat");
  expect(await requestEngineRestart("chat", "x")).toMatchObject({ accepted: false });
});
