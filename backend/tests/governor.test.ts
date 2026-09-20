import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  __resetGovernorForTests,
  __setGovernorTuningForTestsOnly,
  admit,
  getGovernorStatus,
  getGovernorDecisions,
  setGovernorMemorySettings,
  release,
  startGovernor,
  withdraw,
  type GovernorHandle,
} from "@/lib/governor";
import { scriptedMemoryReader } from "@/lib/memory/scripted";
import { __resetHealthForTests, list as listHealth } from "@/lib/health";

const GB = 1_073_741_824;
const stops: Array<() => void> = [];

beforeEach(() => {
  __resetGovernorForTests();
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 64 * GB, freeMemoryBytes: 32 * GB });
  __resetHealthForTests();
});

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  // stop() only cancels the poller's NEXT scheduled tick; a tick already
  // in flight when stop() runs (pollMs: 1 below means there often is one)
  // finishes on its own and overwrites pressure/availablePercent when it
  // does. A beat here lets that straggler land before the reset, so the
  // reset is always the last word rather than something a later test (or
  // a later file, since Bun runs the whole suite in one process) inherits.
  await Bun.sleep(5);
  __resetGovernorForTests();
});

test("rule 1 grants an admission and reports an estimated peak", async () => {
  const result = await admit({ id: "resident-chat", kind: "resident", requestedBytes: GB, modelFileBytes: GB, engine: "llama-server" });
  expect("id" in result).toBe(true);
  expect(getGovernorStatus().loaded[0]).toMatchObject({ id: "resident-chat", peakBytes: Math.ceil(GB * 1.3), measured: false });
});

test("rule 2 queues work with a position and refuses after four entries", async () => {
  await admit({ id: "generator-0", kind: "generator", requestedBytes: GB });
  for (let index = 1; index <= 4; index++) {
    expect(await admit({ id: `generator-${index}`, kind: "generator", requestedBytes: 50 * GB })).toMatchObject({ queued: true, position: index });
  }
  expect(await admit({ id: "generator-5", kind: "generator", requestedBytes: 50 * GB })).toEqual({ refused: true, reason: "The governor queue is full." });
});

test("rule 3 evicts an idle JIT model", async () => {
  await admit({ id: "jit-idle", kind: "jit", requestedBytes: GB });
  const stop = startGovernor({ pid: 1, pollMs: 1, now: () => Date.now() + 601_000, unload: () => {} });
  stops.push(stop);
  await Bun.sleep(10);
  expect(getGovernorStatus().loaded).toHaveLength(0);
});

test("rule 3 pressure unloads the least recently used unpinned JIT model", async () => {
  await admit({ id: "jit-old", kind: "jit", requestedBytes: GB });
  await Bun.sleep(2);
  await admit({ id: "jit-new", kind: "jit", requestedBytes: GB });
  __setGovernorTuningForTestsOnly({ pollMs: 1, freeMemoryBytes: 0 });
  const unloaded: string[] = [];
  const stop = startGovernor({ pid: 1, freeMemory: () => 0, totalMemory: () => 64 * GB, unload: (id) => { unloaded.push(id); } });
  stops.push(stop);
  await Bun.sleep(15);
  expect(unloaded).toContain("jit-old");
});

test("rule 3 keeps pinned models during pressure", async () => {
  await admit({ id: "jit-pinned", kind: "jit", requestedBytes: GB, pinned: true });
  __setGovernorTuningForTestsOnly({ pollMs: 1, freeMemoryBytes: 0 });
  const stop = startGovernor({ pid: 1, freeMemory: () => 0, totalMemory: () => 64 * GB, unload: () => { throw new Error("pinned model unloaded"); } });
  stops.push(stop);
  await Bun.sleep(15);
  expect(getGovernorStatus().loaded[0]?.pinned).toBe(true);
});

test("rule 3 restarts a resident model after sustained RSS overage", async () => {
  await admit({ id: "resident-chat", kind: "resident", requestedBytes: GB, measuredPeakBytes: GB, pid: 42 });
  __setGovernorTuningForTestsOnly({ pollMs: 1, processSustainedPolls: 2 });
  let restarts = 0;
  const stop = startGovernor({ pid: 42, freeMemory: () => 32 * GB, totalMemory: () => 64 * GB, processMemory: async () => 2 * GB, restart: () => { restarts++; } });
  stops.push(stop);
  await Bun.sleep(15);
  expect(restarts).toBeGreaterThan(0);
});

test("rule 4 exposes a cap and refuses an admission over it", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 16 * GB, freeMemoryBytes: 16 * GB });
  const admitted = await admit({ id: "large", kind: "resident", requestedBytes: 7 * GB });
  expect("id" in admitted).toBe(true);
  expect(getGovernorStatus().capBytes).toBe(8 * GB);
  expect(await admit({ id: "too-large", kind: "resident", requestedBytes: 2 * GB })).toMatchObject({ queued: true });
});

test("a live model budget setting changes admission and records refusal", async () => {
  setGovernorMemorySettings({ modelBudgetBytes: 2 * GB });
  expect(await admit({ id: "too-large", kind: "resident", requestedBytes: 3 * GB })).toMatchObject({ queued: true });
  for (let index = 0; index < 4; index++) await admit({ id: `queued-${index}`, kind: "resident", requestedBytes: 3 * GB });
  expect(await admit({ id: "refused", kind: "resident", requestedBytes: 3 * GB })).toMatchObject({ refused: true });
  expect(getGovernorDecisions().some((item) => item.decision === "Refused" && item.model === "refused")).toBe(true);
});

test("rule 5 extends JIT idle time but never a generator", async () => {
  await admit({ id: "jit-kept", kind: "jit", requestedBytes: GB, keepAliveSeconds: 1_000 });
  await admit({ id: "generator", kind: "generator", requestedBytes: GB, keepAliveSeconds: 1_000 });
  const status = getGovernorStatus();
  expect(status.loaded.find((item) => item.id === "jit-kept")?.idleTtlSeconds).toBe(600);
  expect(status.loaded.find((item) => item.id === "generator")?.idleTtlSeconds).toBe(600);
});

test("release advances the queue", async () => {
  const first = await admit({ id: "first", kind: "generator", requestedBytes: GB }) as GovernorHandle;
  await admit({ id: "queued", kind: "generator", requestedBytes: GB });
  release(first);
  await Bun.sleep(0);
  expect(getGovernorStatus().queue).toHaveLength(0);
});

test("kernel warn pressure pauses admission and reports the available percent", async () => {
  const stop = startGovernor({ pid: 1, pollMs: 1, memoryReader: scriptedMemoryReader([    { totalBytes: 64 * GB, freeBytes: 32 * GB, availablePercent: 8, pressure: "warn", degraded: false }]) });
  stops.push(stop);
  await Bun.sleep(5);
  expect(getGovernorStatus()).toMatchObject({ pressure: "warn", availablePercent: 8 });
  expect(await admit({ id: "pressure-blocked", kind: "resident", requestedBytes: GB })).toMatchObject({ queued: true, position: 1 });
});

test("kernel critical pressure aborts an in-flight generator", async () => {
  await admit({ id: "generator-critical", kind: "generator", requestedBytes: GB });
  const aborted: string[] = [];
  const stop = startGovernor({ pid: 1, pollMs: 1, memoryReader: scriptedMemoryReader([
    { totalBytes: 64 * GB, freeBytes: 32 * GB, availablePercent: 50, pressure: "normal", degraded: false },
    { totalBytes: 64 * GB, freeBytes: GB, availablePercent: 2, pressure: "critical", degraded: false },
  ]), abort: (id) => { aborted.push(id); } });
  stops.push(stop);
  await Bun.sleep(5);
  expect(getGovernorStatus().pressure).toBe("critical");
  expect(aborted).toContain("generator-critical");
});

test("a degraded reading changes no state, flags the status, refuses new work, and recovers", async () => {
  await Bun.sleep(10);
  await admit({ id: "resident-kept", kind: "resident", requestedBytes: GB, modelFileBytes: GB, engine: "llama-server" });
  const stop = startGovernor({ pid: 1, pollMs: 1, memoryReader: scriptedMemoryReader([
    { totalBytes: 64 * GB, freeBytes: 32 * GB, availablePercent: 50, pressure: "normal", degraded: false },
    { probeError: "The kernel's ledger was unreachable." },
    { probeError: "The kernel's ledger was unreachable." },
    { probeError: "The kernel's ledger was unreachable." },
    { totalBytes: 64 * GB, freeBytes: 32 * GB, availablePercent: 50, pressure: "normal", degraded: false },
  ]) });
  stops.push(stop);
  let degradedStatus = getGovernorStatus();
  for (let index = 0; index < 20 && !degradedStatus.memoryReadingDegraded; index++) {
    await Bun.sleep(5);
    degradedStatus = getGovernorStatus();
  }
  const degraded = degradedStatus;
  expect(degraded.memoryReadingDegraded).toBe(true);
  expect(degraded.freeMemoryBytes).toBe(32 * GB);
  expect(degraded.pressure).toBe("normal");
  expect(await admit({ id: "new-load", kind: "resident", requestedBytes: GB })).toEqual({ refused: true, reason: "The memory reading is unavailable." });
  expect(getGovernorStatus().loaded).toHaveLength(1);
  const item = listHealth().find((entry) => entry.code === "memory-reading-unavailable");
  expect(item?.severity).toBe("warning");
  expect(item?.title).toBe("This computer's memory cannot be read right now");
  expect(item?.text).toBe("The Stack keeps what is running but will not start anything new until the reading is back.");
  expect(item?.cause).toBe("The memory probe failed: The kernel's ledger was unreachable.");
  expect(item?.fix).toEqual({ label: "Check again", action: "free_memory" });
  let recoveredStatus = getGovernorStatus();
  for (let index = 0; index < 20 && recoveredStatus.memoryReadingDegraded; index++) {
    await Bun.sleep(5);
    recoveredStatus = getGovernorStatus();
  }
  expect(recoveredStatus.memoryReadingDegraded).toBe(false);
  expect(listHealth().find((entry) => entry.code === "memory-reading-unavailable")).toBeUndefined();
  expect("id" in (await admit({ id: "after-recovery", kind: "resident", requestedBytes: GB }))).toBe(true);
});

test("a queued request is admitted when the memory reading clears, without any release", async () => {
  const stop = startGovernor({ pid: 1, pollMs: 100, memoryReader: scriptedMemoryReader([
    { totalBytes: 64 * GB, freeBytes: 8 * GB, availablePercent: 12, pressure: "warn", degraded: false },
    { totalBytes: 64 * GB, freeBytes: 8 * GB, availablePercent: 12, pressure: "warn", degraded: false },
    { totalBytes: 64 * GB, freeBytes: 48 * GB, availablePercent: 75, pressure: "normal", degraded: false },
  ]) });
  stops.push(stop);
  await Bun.sleep(10);
  expect(getGovernorStatus().pressure).toBe("warn");
  const queued = await admit({ id: "drain-me", kind: "resident", requestedBytes: 2 * GB });
  expect(queued).toMatchObject({ queued: true, position: 1 });
  const admitted = await (queued as { admitted: Promise<unknown> }).admitted;
  expect(admitted).toMatchObject({ id: "drain-me", kind: "resident" });
  expect(getGovernorStatus().queue).toHaveLength(0);
});

test("a queued request is admitted when free memory rises over the low-water floor, without any release", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 64 * GB, freeMemoryBytes: 32 * GB });
  const stop = startGovernor({ pid: 1, pollMs: 100, memoryReader: scriptedMemoryReader([
    { totalBytes: 64 * GB, freeBytes: 4 * GB, availablePercent: 6, pressure: "normal", degraded: false },
    { totalBytes: 64 * GB, freeBytes: 4 * GB, availablePercent: 6, pressure: "normal", degraded: false },
    { totalBytes: 64 * GB, freeBytes: 4 * GB, availablePercent: 6, pressure: "normal", degraded: false },
    { totalBytes: 64 * GB, freeBytes: 30 * GB, availablePercent: 47, pressure: "normal", degraded: false },
  ]) });
  stops.push(stop);
  await Bun.sleep(10);
  expect(getGovernorStatus().freeMemoryBytes).toBe(4 * GB);
  const queued = await admit({ id: "floor-drain", kind: "resident", requestedBytes: 2 * GB });
  expect(queued).toMatchObject({ queued: true, position: 1 });
  const admitted = await (queued as { admitted: Promise<unknown> }).admitted;
  expect(admitted).toMatchObject({ id: "floor-drain", kind: "resident" });
});

test("a poll with no memory change does not touch the queue", async () => {
  const stop = startGovernor({ pid: 1, pollMs: 100, memoryReader: scriptedMemoryReader([
    { totalBytes: 64 * GB, freeBytes: 8 * GB, availablePercent: 12, pressure: "warn", degraded: false },
    { totalBytes: 64 * GB, freeBytes: 8 * GB, availablePercent: 12, pressure: "warn", degraded: false },
  ]) });
  stops.push(stop);
  await Bun.sleep(10);
  expect(getGovernorStatus().pressure).toBe("warn");
  const queued = await admit({ id: "stays-queued", kind: "resident", requestedBytes: 2 * GB });
  expect(queued).toMatchObject({ queued: true, position: 1 });
  await Bun.sleep(200);
  expect(getGovernorStatus().queue).toMatchObject([{ id: "stays-queued", position: 1 }]);
});

test("withdraw settles the queued promise as refused and promotes the next request to head", async () => {
  const stop = startGovernor({ pid: 1, pollMs: 25, memoryReader: scriptedMemoryReader([
    { totalBytes: 64 * GB, freeBytes: 8 * GB, availablePercent: 12, pressure: "warn", degraded: false },
  ]) });
  stops.push(stop);
  await Bun.sleep(5);
  const first = await admit({ id: "withdrawn-first", kind: "resident", requestedBytes: 2 * GB });
  expect(first).toMatchObject({ queued: true, position: 1 });
  const second = await admit({ id: "behind", kind: "resident", requestedBytes: 2 * GB });
  expect(second).toMatchObject({ queued: true, position: 2 });
  withdraw("withdrawn-first");
  const settled = await (first as { admitted: Promise<unknown> }).admitted;
  expect(settled).toEqual({ refused: true, reason: "Withdrawn." });
  expect(getGovernorStatus().queue).toMatchObject([{ id: "behind", position: 1 }]);
});

test("admission-refused-repeatedly still raises after three refusals of the same request", async () => {
  const stop = startGovernor({ pid: 1, pollMs: 25, memoryReader: scriptedMemoryReader([
    { totalBytes: 64 * GB, freeBytes: 8 * GB, availablePercent: 12, pressure: "warn", degraded: false },
  ]) });
  stops.push(stop);
  await Bun.sleep(5);
  await admit({ id: "refuse-me", kind: "resident", requestedBytes: 2 * GB });
  await admit({ id: "refuse-me", kind: "resident", requestedBytes: 2 * GB });
  const third = await admit({ id: "refuse-me", kind: "resident", requestedBytes: 2 * GB });
  expect(third).toMatchObject({ queued: true, position: 1 });
  expect(listHealth().find((entry) => entry.code === "admission-refused-repeatedly")).toMatchObject({ severity: "warning", title: "Work is waiting for memory" });
});
