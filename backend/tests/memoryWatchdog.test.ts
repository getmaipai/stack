// The memory watchdog: the ladder with hysteresis, admission on real free
// memory, the actions at each level, job cancellation cleanup, the orphan
// reaper's exact matching, no action on programs the Stack does not own,
// the route, and one live read-only check against this computer's numbers.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, admit, getGovernorStatus, release, setAdmissionGate, startGovernor } from "@/lib/governor";
import { __resetHealthForTests, list as listHealth } from "@/lib/health";
import { __resetJobsForTests, cancelGeneratorsForMemory, getJob, registerJobRunner, submitJob, waitForJob, __setAdmissionWaitForTests } from "@/lib/jobs";
import { __setSystemSamplerForTests, parseEtime, parseProcessTable, type ProcessRow, type SystemSample, type SystemSampler } from "@/lib/memory/system";
import { __resetMemoryStateForTests, admissionVerdict, latestSample, memoryLevel, PAUSED_LOW_MEMORY, reserveBytes, setLatestSample, setMemoryLevel } from "@/lib/memoryState";
import { descendantsOf, findOrphans, MemoryWatchdog, newLadder, rawLevel, stepLadder, type WatchdogActions } from "@/lib/memoryWatchdog";
import { __resetLifecycleForTests, beginStopping } from "@/lib/lifecycle";

const GB = 1_073_741_824;
const TOTAL = 128 * GB;
const ENGINES = "/data/stack/engines";

function sample(over: Partial<SystemSample> & { swapouts?: number } = {}, at = Date.now()): SystemSample & { swapouts: number } {
  return { at, totalBytes: TOTAL, availableBytes: 60 * GB, freeBytes: 40 * GB, wiredBytes: 30 * GB, compressorBytes: GB, swapUsedBytes: 1 * GB, swapTotalBytes: 2 * GB, swapouts: 0, pressureLevel: 1, pressure: "normal", degraded: false, ...over };
}

function row(over: Partial<ProcessRow> & { pid: number }): ProcessRow {
  return { ppid: 1, rssBytes: GB, ageSeconds: 600, name: "proc", command: "proc", ...over };
}

/** A sampler the test drives: set `next` before each tick. */
function fakeSampler(rows: ProcessRow[] = []): SystemSampler & { next: SystemSample; rows: ProcessRow[]; clients: Set<number>; calls: { cwds: number[][] } } {
  const state = { next: sample(), rows, clients: new Set<number>(), calls: { cwds: [] as number[][] } };
  return {
    get next() { return state.next; }, set next(value) { state.next = value; },
    get rows() { return state.rows; }, set rows(value) { state.rows = value; },
    clients: state.clients, calls: state.calls,
    sample: () => state.next,
    processes: () => state.rows,
    cwds: (pids) => { state.calls.cwds.push(pids); return new Map(pids.map((pid) => [pid, `/work/${pid}`])); },
    hasClient: (pid) => state.clients.has(pid),
  };
}

function fakeActions(): WatchdogActions & { log: string[]; running: string[]; queued: string[]; judgeLoaded: boolean; notified: Array<Record<string, unknown>> } {
  const state = { log: [] as string[], running: [] as string[], queued: [] as string[], judgeLoaded: true, notified: [] as Array<Record<string, unknown>> };
  return Object.assign(state, {
    unloadIdleWorkers: async () => { state.log.push("unload-idle"); return []; },
    cancelQueued: () => { state.log.push("cancel-queued"); return state.queued.splice(0); },
    cancelRunning: () => { state.log.push("cancel-running"); return state.running.splice(0, 1); },
    evictRole: async () => { state.log.push("evict-judge"); const had = state.judgeLoaded; state.judgeLoaded = false; return had; },
    restartChat: async () => { state.log.push("restart-chat"); },
    notify: (data: Record<string, unknown>) => { state.notified.push(data); },
  });
}

beforeEach(() => { __resetMemoryStateForTests(); __resetGovernorForTests(); __resetJobsForTests(); __resetHealthForTests(); __resetLifecycleForTests(); });
afterEach(() => { setAdmissionGate(null); __setSystemSamplerForTests(null); __setAdmissionWaitForTests(null); __resetMemoryStateForTests(); __resetJobsForTests(); __resetGovernorForTests(); __resetLifecycleForTests(); });

// ---- the ladder ----

const reading = (over: Partial<SystemSample>, swapGrowthBytes = 0) => ({ sample: sample(over), swapGrowthBytes, reserve: reserveBytes(TOTAL) });

test("the reserve defaults to the larger of 8 GB and 8 percent of memory, never over a quarter", () => {
  expect(reserveBytes(128 * GB)).toBeCloseTo(10.24 * GB, -6);
  expect(reserveBytes(64 * GB)).toBe(8 * GB);
  expect(reserveBytes(16 * GB)).toBe(4 * GB);
});

test("raw levels: kernel level, available memory and swap growth each decide", () => {
  expect(rawLevel(reading({}))).toBe("normal");
  expect(rawLevel(reading({ pressureLevel: 2, pressure: "warn" }))).toBe("warn");
  expect(rawLevel(reading({ availableBytes: 12 * GB }))).toBe("warn");
  expect(rawLevel(reading({ availableBytes: 20 * GB }))).toBe("normal");
  expect(rawLevel(reading({ pressureLevel: 4, pressure: "critical" }))).toBe("critical");
  expect(rawLevel(reading({ availableBytes: 2 * GB }))).toBe("critical");
  expect(rawLevel(reading({}, 2 * GB))).toBe("critical");
});

test("the ladder needs two samples to rise and six clear ones to fall, one level at a time", () => {
  let ladder = newLadder();
  ladder = stepLadder(ladder, reading({ availableBytes: 12 * GB }));
  expect(ladder.level).toBe("normal");
  ladder = stepLadder(ladder, reading({ availableBytes: 12 * GB }));
  expect(ladder.level).toBe("warn");
  ladder = stepLadder(ladder, reading({ pressureLevel: 4, pressure: "critical" }));
  ladder = stepLadder(ladder, reading({ pressureLevel: 4, pressure: "critical" }));
  expect(ladder.level).toBe("critical");
  // Recovery: clear readings, five are not enough, the sixth steps down to warn.
  const clear = reading({ availableBytes: 60 * GB });
  for (let i = 0; i < 5; i += 1) ladder = stepLadder(ladder, clear);
  expect(ladder.level).toBe("critical");
  ladder = stepLadder(ladder, clear);
  expect(ladder.level).toBe("warn");
  for (let i = 0; i < 6; i += 1) ladder = stepLadder(ladder, clear);
  expect(ladder.level).toBe("normal");
});

test("a reading hovering at the warn threshold does not flap", () => {
  let ladder = stepLadder(stepLadder(newLadder(), reading({ availableBytes: 12 * GB })), reading({ availableBytes: 12 * GB }));
  expect(ladder.level).toBe("warn");
  const changes: string[] = [];
  // 14 GB is above the warn line (10.2 + 4) by a hair but inside the hysteresis band (needs 10.2 + 8 = 18.2).
  for (let i = 0; i < 40; i += 1) {
    const before = ladder.level;
    ladder = stepLadder(ladder, reading({ availableBytes: (i % 2 === 0 ? 14.5 : 13.5) * GB }));
    if (ladder.level !== before) changes.push(ladder.level);
  }
  expect(changes).toEqual([]);
  expect(ladder.level).toBe("warn");
});

// ---- admission on real free memory ----

test("admission uses the real free memory: the governor's own model says yes, the machine says no", async () => {
  // The governor believes it has 100 GB free and nothing loaded.
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: TOTAL, freeMemoryBytes: 100 * GB, tier: "p128" });
  expect(getGovernorStatus().loaded).toEqual([]);
  setLatestSample(sample({ availableBytes: 30 * GB }));
  setAdmissionGate(admissionVerdict);
  // A 44 GB clip would leave nothing; the machine has 30 GB available.
  const video = await admit({ id: "video-job", kind: "generator", requestedBytes: 44 * GB });
  expect("queued" in video).toBe(true);
  const verdict = admissionVerdict({ id: "video-job", kind: "generator" }, 44 * GB);
  expect(verdict.ok).toBe(false);
  expect(verdict.ok ? "" : verdict.reason).toContain("not enough free memory"); expect(verdict.ok ? "" : verdict.reason).not.toMatch(/\d GB/); /* a person never reads a figure */
  // A 13.5 GB picture fits: 30 - 13.5 = 16.5 GB left, above the 10.2 GB reserve.
  expect(admissionVerdict({ id: "pic", kind: "generator" }, 13.5 * GB).ok).toBe(true);
  // Residents (chat, judge) are not gated by the watchdog.
  expect(admissionVerdict({ id: "chat", kind: "resident" }, 21 * GB).ok).toBe(true);
});

test("a gated request is admitted once memory recovers", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: TOTAL, freeMemoryBytes: 100 * GB, tier: "p128" });
  setAdmissionGate(admissionVerdict);
  setLatestSample(sample({ availableBytes: 20 * GB }));
  expect(admissionVerdict({ id: "pic", kind: "generator" }, 13.5 * GB).ok).toBe(false);
  setLatestSample(sample({ availableBytes: 40 * GB }));
  const answer = await admit({ id: "pic", kind: "generator", requestedBytes: 13.5 * GB });
  expect("id" in answer).toBe(true);
  if ("id" in answer) release(answer);
});

test("at WARN or CRITICAL a new generative start waits whatever the free memory", () => {
  setLatestSample(sample({ availableBytes: 90 * GB }));
  setMemoryLevel("warn");
  const verdict = admissionVerdict({ id: "pic", kind: "generator" }, GB);
  expect(verdict.ok).toBe(false);
  expect(verdict.ok ? "" : verdict.reason).toContain("paused for a moment"); expect(verdict.ok ? "" : verdict.reason).not.toMatch(/\d GB/);
});

test("a fitting job stays queued past the old window and runs when memory frees", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: TOTAL, freeMemoryBytes: 100 * GB, tier: "p128" });
  setLatestSample(sample({ availableBytes: 15 * GB }));
  setAdmissionGate(admissionVerdict);
  let ran = false;
  registerJobRunner("image_test", async () => { ran = true; return {}; }, { generator: { role: "image", memory: () => ({ requestedBytes: 13.5 * GB }) } });
  let reading = sample({ availableBytes: 15 * GB, freeBytes: 100 * GB });
  const stop = startGovernor({ pid: -1, pollMs: 2, memoryReader: { read: () => ({ ...reading, availablePercent: 80 }), processMemoryBytes: () => null } });
  try {
    const submitted = submitJob({ kind: "image_test" });
    if ("refused" in submitted) throw new Error(submitted.reason);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(ran).toBe(false);
    expect(getJob(submitted.job.id)).toMatchObject({ state: "running", status: expect.stringContaining("Waiting for memory") });
    expect(getGovernorStatus().queue.map((entry) => entry.id)).toEqual([submitted.job.id]);
    setLatestSample(sample({ availableBytes: 40 * GB }));
    reading = sample({ availableBytes: 40 * GB, freeBytes: 100 * GB });
    const settled = await waitForJob(submitted.job.id, 3_000);
    expect(ran).toBe(true);
    expect(settled?.state).toBe("done");
    expect(getGovernorStatus().queue).toEqual([]);
  } finally { stop(); }
});

// ---- the actions ----

function watchdogWith(sampler: ReturnType<typeof fakeSampler>, actions = fakeActions(), extra: { now?: () => number; kill?: (pid: number, signal: string) => void; commandOf?: (pid: number) => string | null } = {}) {
  let clock = 1_000_000;
  const dog = new MemoryWatchdog({ sampler, actions, now: extra.now ?? (() => clock), ownPid: 500, engineRoots: [ENGINES], workerEntries: ["/data/stack/backend-src/src/index.ts"], kill: (extra.kill ?? (() => {})) as never, commandOf: extra.commandOf ?? ((pid) => sampler.rows.find((r) => r.pid === pid)?.command ?? null) });
  return { dog, advance: (ms: number) => { clock += ms; }, actions };
}

test("WARN holds queued jobs and unloads idle workers; it never cancels queued or running jobs", async () => {
  const sampler = fakeSampler();
  const { dog, actions } = watchdogWith(sampler);
  actions.queued.push("job-q"); actions.running.push("job-r");
  sampler.next = sample({ pressureLevel: 2, pressure: "warn", availableBytes: 40 * GB });
  await dog.tick(); await dog.tick();
  expect(memoryLevel()).toBe("warn");
  expect(actions.log).not.toContain("cancel-queued");
  expect(actions.queued).toEqual(["job-q"]);
  expect(actions.log).toContain("unload-idle");
  expect(actions.log).not.toContain("cancel-running");
  expect(actions.log).not.toContain("evict-judge");
  expect(listHealth().map((item) => item.code)).toContain("memory-low");
  expect(listHealth().find((item) => item.code === "memory-low")?.text).toContain("Picture and video making is paused");
});

test("CRITICAL cancels the running job first, then the judge, and restarts chat only after 60 s", async () => {
  const sampler = fakeSampler([row({ pid: 900, ppid: 400, rssBytes: 20 * GB, name: "llama-server" })]);
  const actions = fakeActions();
  actions.running.push("job-video");
  const { dog, advance } = watchdogWith(sampler, actions);
  sampler.next = sample({ pressureLevel: 4, pressure: "critical", availableBytes: 2 * GB });
  await dog.tick(); await dog.tick();
  expect(memoryLevel()).toBe("critical");
  expect(actions.log.filter((entry) => entry === "cancel-running")).toHaveLength(1);
  expect(listHealth().find((item) => item.code === "memory-critical")?.severity).toBe("critical");
  expect(actions.notified).toHaveLength(1);
  expect(actions.notified[0]?.pressure).toBe("critical");
  advance(11_000);
  await dog.tick();
  expect(actions.log).toContain("evict-judge");
  expect(actions.log).not.toContain("restart-chat");
  advance(11_000);
  await dog.tick();
  expect(actions.log).not.toContain("restart-chat");
  advance(60_000);
  await dog.tick();
  expect(actions.log.filter((entry) => entry === "restart-chat")).toHaveLength(1);
  // Cooldown: no second restart right away; and only one notification inside the rate limit.
  advance(11_000);
  await dog.tick();
  expect(actions.log.filter((entry) => entry === "restart-chat")).toHaveLength(1);
  expect(actions.notified).toHaveLength(1);
});

test("rising swapouts while chat is loaded enters WARN at once and reports paged out", async () => {
  const sampler = fakeSampler();
  const actions = fakeActions();
  const dog = new MemoryWatchdog({ sampler, actions, chatLoaded: () => true, ownPid: 500, engineRoots: [ENGINES], workerEntries: [], kill: () => {}, commandOf: () => null });
  sampler.next = sample({ swapouts: 10, availableBytes: 22 * GB });
  await dog.tick();
  sampler.next = sample({ swapouts: 11, availableBytes: 22 * GB });
  await dog.tick();
  expect(memoryLevel()).toBe("warn");
  expect(dog.report().watchdog.chat_paged_out).toBe(true);
});

test("a paged-out chat clears once swapouts stop rising", async () => {
  const sampler = fakeSampler();
  const dog = new MemoryWatchdog({ sampler, chatLoaded: () => true, ownPid: 500, engineRoots: [ENGINES], workerEntries: [], kill: () => {}, commandOf: () => null });
  sampler.next = sample({ swapouts: 10, availableBytes: 22 * GB });
  await dog.tick();
  sampler.next = sample({ swapouts: 11, availableBytes: 22 * GB });
  await dog.tick();
  expect(memoryLevel()).toBe("warn");
  for (let i = 0; i < 6; i++) await dog.tick();
  expect(memoryLevel()).toBe("normal");
  expect(dog.report().watchdog.chat_paged_out).toBe(false);
});

test("rising swapouts without chat loaded and flat swapouts do not change the level", async () => {
  const sampler = fakeSampler();
  const dog = new MemoryWatchdog({ sampler, chatLoaded: () => false, ownPid: 500, engineRoots: [ENGINES], workerEntries: [], kill: () => {}, commandOf: () => null });
  sampler.next = sample({ swapouts: 10, availableBytes: 22 * GB });
  await dog.tick();
  sampler.next = sample({ swapouts: 11, availableBytes: 22 * GB });
  await dog.tick();
  expect(memoryLevel()).toBe("normal");
  expect(dog.report().watchdog.chat_paged_out).toBe(false);

  const flat = fakeSampler();
  const flatDog = new MemoryWatchdog({ sampler: flat, chatLoaded: () => true, ownPid: 500, engineRoots: [ENGINES], workerEntries: [], kill: () => {}, commandOf: () => null });
  flat.next = sample({ swapouts: 10 });
  await flatDog.tick();
  flat.next = sample({ swapouts: 10 });
  await flatDog.tick();
  expect(memoryLevel()).toBe("normal");
  expect(flatDog.report().watchdog.chat_paged_out).toBe(false);
});

test("swap growing fast is critical even with memory available", async () => {
  const sampler = fakeSampler();
  const actions = fakeActions();
  let clock = 5_000_000;
  const dog = new MemoryWatchdog({ sampler, actions, now: () => clock, ownPid: 500, engineRoots: [ENGINES], workerEntries: [], kill: () => {}, commandOf: () => null });
  for (let i = 0; i < 4; i += 1) {
    sampler.next = sample({ at: clock, swapUsedBytes: (1 + i * 0.8) * GB });
    await dog.tick();
    clock += 5_000;
  }
  expect(memoryLevel()).toBe("critical");
});

test("recovery returns to normal, resolves the health items and lets work through again", async () => {
  const sampler = fakeSampler();
  const { dog } = watchdogWith(sampler);
  sampler.next = sample({ pressureLevel: 2, pressure: "warn" });
  await dog.tick(); await dog.tick();
  expect(listHealth().map((item) => item.code)).toContain("memory-low");
  sampler.next = sample({ availableBytes: 70 * GB });
  for (let i = 0; i < 6; i += 1) await dog.tick();
  expect(memoryLevel()).toBe("normal");
  expect(listHealth().map((item) => item.code)).not.toContain("memory-low");
});

test("with the watchdog setting off nothing is done and admission passes", async () => {
  const { updateSettings, __resetSettingsForTests } = await import("@/settings");
  updateSettings({ "stack.memory.watchdog": false });
  try {
    const sampler = fakeSampler();
    const actions = fakeActions();
    const { dog } = watchdogWith(sampler, actions);
    sampler.next = sample({ pressureLevel: 4, pressure: "critical", availableBytes: GB });
    await dog.tick(); await dog.tick(); await dog.tick();
    expect(memoryLevel()).toBe("normal");
    expect(actions.log).toEqual([]);
    setLatestSample(sample({ availableBytes: GB }));
    expect(admissionVerdict({ id: "pic", kind: "generator" }, 13 * GB).ok).toBe(true);
  } finally { __resetSettingsForTests(); }
});

// ---- job cancellation cleanup ----

test("a running generative job stopped for memory runs its cleanup, releases the governor and says why", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: TOTAL, freeMemoryBytes: 100 * GB, tier: "p128" });
  let cleaned = false;
  let started = false;
  registerJobRunner("video_test", async (_job, signal) => {
    started = true;
    try { await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); } finally { cleaned = true; }
    return {};
  }, { generator: { role: "video", memory: () => ({ requestedBytes: 4 * GB }) } });
  const submitted = submitJob({ kind: "video_test" });
  if ("refused" in submitted) throw new Error(submitted.reason);
  const queuedBehind = submitJob({ kind: "video_test" });
  if ("refused" in queuedBehind) throw new Error(queuedBehind.reason);
  await Bun.sleep(20);
  expect(started).toBe(true);
  // Queued behind the running one: cancelled before it starts.
  expect(cancelGeneratorsForMemory("queued", "Paused for memory.")).toEqual([queuedBehind.job.id]);
  expect(getJob(queuedBehind.job.id)?.status).toBe(PAUSED_LOW_MEMORY);
  const stopped = cancelGeneratorsForMemory("running", "Stopped: out of memory.");
  expect(stopped).toEqual([submitted.job.id]);
  await Bun.sleep(30);
  const job = getJob(submitted.job.id)!;
  expect(job.state).toBe("cancelled");
  expect(job.status).toBe(PAUSED_LOW_MEMORY);
  expect(job.reason).toBe("Stopped: out of memory.");
  expect(cleaned).toBe(true);
  expect(getGovernorStatus().loaded).toEqual([]);
});

// ---- no action on processes the Stack does not own ----

test("a huge program that is not the Stack's is named in the log and never signalled", async () => {
  const rows = [
    row({ pid: 500, ppid: 1, name: "maipai-stack", command: "/usr/local/maipai-home/stack/maipai-stack-darwin-arm64 serve", rssBytes: GB }),
    row({ pid: 501, ppid: 500, name: "llama-server", command: `${ENGINES}/llama-server/b1/llama-server --port 1`, rssBytes: 22 * GB }),
    row({ pid: 777, ppid: 3, name: "bun", command: "bun run src/index.ts", rssBytes: 45 * GB }),
    row({ pid: 778, ppid: 1, name: "vite", command: "node vite", rssBytes: 4 * GB }),
  ];
  const sampler = fakeSampler(rows);
  const signals: Array<[number, string]> = [];
  const { dog } = watchdogWith(sampler, fakeActions(), { kill: (pid, signal) => { signals.push([pid, signal]); } });
  sampler.next = sample({ pressureLevel: 4, pressure: "critical", availableBytes: 2 * GB });
  await dog.tick(); await dog.tick(); await dog.tick();
  expect(signals).toEqual([]);
  expect(sampler.calls.cwds.flat()).toContain(777);
  const report = dog.report();
  expect(report.top_consumers[0]).toMatchObject({ pid: 777, name: "bun", stack: false });
  expect(report.top_consumers.find((c) => c.pid === 501)?.stack).toBe(true);
});

// ---- the orphan reaper ----

const orphanRules = { engineRoots: [ENGINES], workerEntries: ["/data/stack/backend-src/src/index.ts"], protectedPids: new Set<number>([500, 501]), minAgeSeconds: 90 };

test("an orphan matches only by this Stack's exact engines path, parent launchd, age and tree", () => {
  const rows = [
    row({ pid: 10, command: `${ENGINES}/llama-server/b1/llama-server --model m.gguf` }),                     // match
    row({ pid: 11, command: `${ENGINES}/llama-server/b1/llama-server`, ageSeconds: 30 }),                      // too young
    row({ pid: 12, ppid: 600, command: `${ENGINES}/llama-server/b1/llama-server` }),                          // has a parent
    row({ pid: 501, command: `${ENGINES}/llama-server/b1/llama-server` }),                                    // in the live tree
    row({ pid: 14, command: "/data/stack/engines-evil/llama-server" }),                                       // lookalike prefix
    row({ pid: 15, command: "/Applications/Safari.app/Contents/MacOS/Safari" }),                              // unrelated
    row({ pid: 16, command: "/data/stack/backend-src/src/index.ts speech-worker --role stt" }),               // not a worker command (no bun)
    row({ pid: 17, command: "/usr/local/bin/bun /data/stack/backend-src/src/index.ts speech-worker --role stt --port 5" }), // worker orphan
    row({ pid: 18, command: "/usr/local/bin/bun /elsewhere/src/index.ts speech-worker --role stt --port 5" }), // another checkout's worker
  ];
  expect(findOrphans(rows, orphanRules).map((r) => r.pid).sort()).toEqual([10, 17]);
});

test("an orphan is stopped with SIGTERM, then SIGKILL after 15 s, and its details are logged", async () => {
  const orphan = row({ pid: 321, command: `${ENGINES}/llama-server/b1/llama-server --model muse.gguf`, rssBytes: 21 * GB });
  const sampler = fakeSampler([row({ pid: 500, ppid: 1, command: "/x/maipai-stack-darwin-arm64 serve" }), orphan]);
  const signals: Array<[number, string]> = [];
  const { dog, advance } = watchdogWith(sampler, fakeActions(), { kill: (pid, signal) => { signals.push([pid, signal]); } });
  await dog.tick();
  expect(signals).toEqual([[321, "SIGTERM"]]);
  advance(5_000);
  await dog.tick();
  expect(signals).toHaveLength(1);
  advance(11_000);
  await dog.tick();
  expect(signals).toEqual([[321, "SIGTERM"], [321, "SIGKILL"]]);
  // Gone afterwards: nothing more is sent.
  sampler.rows = [sampler.rows[0]!];
  advance(60_000);
  await dog.tick();
  expect(signals).toHaveLength(2);
});

test("an orphan with a client connected, or whose command changed, is left alone; the live Stack's children never match", async () => {
  const held = row({ pid: 322, command: `${ENGINES}/llama-server/b1/llama-server --port 18698`, rssBytes: 21 * GB });
  const child = row({ pid: 323, ppid: 500, command: `${ENGINES}/llama-server/b1/llama-server --port 1` });
  const reused = row({ pid: 324, command: `${ENGINES}/llama-server/b1/llama-server --port 2` });
  const sampler = fakeSampler([row({ pid: 500, ppid: 1, command: "/x/maipai-stack-darwin-arm64 serve" }), held, child, reused]);
  sampler.clients.add(322);
  const signals: Array<[number, string]> = [];
  const { dog } = watchdogWith(sampler, fakeActions(), { kill: (pid, signal) => { signals.push([pid, signal]); }, commandOf: (pid) => (pid === 324 ? "/usr/bin/other" : sampler.rows.find((r) => r.pid === pid)?.command ?? null) });
  await dog.tick(); await dog.tick();
  expect(signals).toEqual([]);
});

test("another live Stack's children are protected too", () => {
  const rows = [row({ pid: 700, ppid: 1, command: "/other/maipai-stack-darwin-arm64 serve" }), row({ pid: 701, ppid: 700, command: `${ENGINES}/llama-server/b1/llama-server` })];
  expect([...descendantsOf(rows, [700])].sort()).toEqual([700, 701]);
});

// ---- parsing, the route, shutdown, the live numbers ----

test("etime and the process table parse", () => {
  expect(parseEtime("05:43")).toBe(343);
  expect(parseEtime("02:03:04")).toBe(7384);
  expect(parseEtime("3-00:00:01")).toBe(259201);
  const rows = parseProcessTable("  12     1  2048   10:00 /Applications/Claude.app/Contents/MacOS/Claude Helper --type=renderer\n 13 12 1024 00:09 /usr/bin/ps -ax\n");
  expect(rows[0]).toMatchObject({ pid: 12, ppid: 1, rssBytes: 2048 * 1024, ageSeconds: 600, name: "Claude" });
  expect(rows[1]!.name).toBe("ps");
});

test("GET /stack/v1/memory returns the numbers, the level and the recent actions", async () => {
  const sampler = fakeSampler([row({ pid: 9, ppid: 1, rssBytes: 3 * GB, name: "Xcode", command: "Xcode" })]);
  const { dog } = watchdogWith(sampler);
  sampler.next = sample({ pressureLevel: 2, pressure: "warn" });
  await dog.tick(); await dog.tick();
  const mod = await import("@/lib/memoryWatchdog");
  void mod;
  const response = await app.request("/stack/v1/memory");
  expect(response.status).toBe(200);
  const body = await response.json() as { watchdog: { level: string; generation_paused: boolean; reserve_bytes: number }; memory: { available_bytes: number; swap_used_bytes: number; pressure_level: number }; recent_actions: Array<{ action: string }>; top_consumers: unknown[] };
  expect(["warn", "normal"]).toContain(body.watchdog.level);
  expect(body.memory.available_bytes).toBeGreaterThan(0);
  expect(typeof body.memory.swap_used_bytes).toBe("number");
  expect(Array.isArray(body.top_consumers)).toBe(true);
  expect(latestSample()).not.toBeNull();
});

test("GET /stack/v1/memory reports class totals, budget, margin and burst queue depth", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: TOTAL, freeMemoryBytes: 80 * GB, tier: "p128" });
  await admit({ id: "chat", kind: "resident", class: "reserved", requestedBytes: 21 * GB });
  await admit({ id: "picture-pool", kind: "jit", class: "warm", requestedBytes: 16 * GB });
  __setGovernorTuningForTestsOnly({ freeMemoryBytes: 10 * GB });
  setLatestSample(sample({ pressureLevel: 2, pressure: "warn", freeBytes: 10 * GB }));
  await admit({ id: "video-one", kind: "generator", class: "burst", requestedBytes: GB });
  await admit({ id: "video-two", kind: "generator", class: "burst", requestedBytes: GB });
  const response = await app.request("/stack/v1/memory");
  const body = await response.json() as { ledger: { reserved_bytes: number; warm_bytes: number; burst_bytes: number; budget_bytes: number; working_margin_bytes: number; free_bytes: number; queue_depth: { burst: number }; chat_paged_out: boolean } };
  expect(response.status).toBe(200);
  expect(body.ledger).toMatchObject({ reserved_bytes: 21 * GB, warm_bytes: 16 * GB, burst_bytes: 0, budget_bytes: 120 * GB, working_margin_bytes: 20 * GB, free_bytes: 10 * GB, queue_depth: { burst: 2 }, chat_paged_out: false });
});

test("while the Stack is stopping a request gets 503 stack_restarting with Retry-After", async () => {
  beginStopping();
  const response = await app.request("/stack/v1/health");
  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("5");
  expect((await response.json() as { code: string }).code).toBe("stack_restarting");
  expect((await app.request("/healthz")).status).toBe(200);
});

// A live comparison of two readings of a moving number: it is run on request (MAIPAI_LIVE_SAMPLER=1) on a quiet machine, never in the gate, where other jobs move free memory by gigabytes between the two reads.
test.skipIf(process.platform !== "darwin" || process.env.MAIPAI_LIVE_SAMPLER !== "1")("live and read only: the sampler matches vm_stat within 2 percent", async () => {
  const { getSystemSampler } = await import("@/lib/memory/system");
  const live = getSystemSampler().sample();
  const text = Bun.spawnSync(["vm_stat"], { stdout: "pipe" }).stdout.toString();
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  const pages = (label: string): number => Number(new RegExp(`${label}:\\s+(\\d+)\\.`).exec(text)?.[1]) * pageSize;
  // Two reads a few milliseconds apart on a busy machine (other jobs allocating) can differ by more than 2 percent of a small free pool: allow 2 percent or 512 MB, whichever is larger.
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.02 * Math.max(b, 1), 512 * 1048576);
  expect(near(live.freeBytes, pages("Pages free"))).toBe(true);
  expect(near(live.wiredBytes, pages("Pages wired down"))).toBe(true);
  expect(live.totalBytes).toBe(Number(Bun.spawnSync(["sysctl", "-n", "hw.memsize"]).stdout.toString().trim()));
  const swap = /total = ([\d.]+)M\s+used = ([\d.]+)M/.exec(Bun.spawnSync(["sysctl", "-n", "vm.swapusage"]).stdout.toString());
  expect(Math.abs(live.swapUsedBytes - Number(swap?.[2]) * 1048576)).toBeLessThan(64 * 1048576);
  const rows = getSystemSampler().processes();
  expect(rows.length).toBeGreaterThan(20);
  expect(rows.some((r) => r.pid === process.pid)).toBe(true);
  console.log(`live: free ${(live.freeBytes / GB).toFixed(1)} GB, available ${(live.availableBytes / GB).toFixed(1)} GB, wired ${(live.wiredBytes / GB).toFixed(1)} GB, swap ${(live.swapUsedBytes / GB).toFixed(2)} GB, pressure level ${live.pressureLevel}`);
});

test("chat paging out while tens of gigabytes are free does not pause pictures and clips", async () => {
  const sampler = fakeSampler();
  const dog = new MemoryWatchdog({ sampler, chatLoaded: () => true, ownPid: 500, engineRoots: [ENGINES], workerEntries: [], kill: () => {}, commandOf: () => null });
  sampler.next = sample({ swapouts: 10, availableBytes: 60 * GB });
  await dog.tick();
  sampler.next = sample({ swapouts: 11, availableBytes: 60 * GB });
  await dog.tick();
  expect(memoryLevel()).toBe("normal");
});
