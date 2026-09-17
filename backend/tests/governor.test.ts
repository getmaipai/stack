import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  __resetGovernorForTests,
  __setGovernorTuningForTestsOnly,
  admit,
  getGovernorStatus,
  release,
  startGovernor,
  type GovernorHandle,
} from "@/lib/governor";
import { scriptedMemoryReader } from "@/lib/memory/scripted";

const GB = 1_073_741_824;
const stops: Array<() => void> = [];

beforeEach(() => {
  __resetGovernorForTests();
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 64 * GB, freeMemoryBytes: 32 * GB });
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
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
    expect(await admit({ id: `generator-${index}`, kind: "generator", requestedBytes: 50 * GB })).toEqual({ queued: true, position: index });
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
  const stop = startGovernor({ pid: 1, pollMs: 1, memoryReader: scriptedMemoryReader([{ totalBytes: 64 * GB, freeBytes: 32 * GB, availablePercent: 8, pressure: "warn" }]) });
  stops.push(stop);
  await Bun.sleep(5);
  expect(getGovernorStatus()).toMatchObject({ pressure: "warn", availablePercent: 8 });
  expect(await admit({ id: "pressure-blocked", kind: "resident", requestedBytes: GB })).toEqual({ queued: true, position: 1 });
});

test("kernel critical pressure aborts an in-flight generator", async () => {
  await admit({ id: "generator-critical", kind: "generator", requestedBytes: GB });
  const aborted: string[] = [];
  const stop = startGovernor({ pid: 1, pollMs: 1, memoryReader: scriptedMemoryReader([
    { totalBytes: 64 * GB, freeBytes: 32 * GB, availablePercent: 50, pressure: "normal" },
    { totalBytes: 64 * GB, freeBytes: GB, availablePercent: 2, pressure: "critical" },
  ]), abort: (id) => { aborted.push(id); } });
  stops.push(stop);
  await Bun.sleep(5);
  expect(getGovernorStatus().pressure).toBe("critical");
  expect(aborted).toContain("generator-critical");
});
