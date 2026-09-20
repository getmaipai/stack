// The one wait on the governor (STACK-13b): a request the governor
// queues is admitted when a release comes, a wait that times out gives
// up and its late admission is released by the watcher, a peak the cap
// cannot hold is refused with both numbers, and a wait on nothing
// loaded nudges the governor when memory frees.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { __setAdmissionTuningForTests, governorPeak, waitForAdmission, waitingReason } from "@/lib/admission";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, admit, getGovernorStatus, release, type GovernorHandle } from "@/lib/governor";
import { __resetHealthForTests } from "@/lib/health";

const GB = 1_073_741_824;
beforeEach(() => { __resetHealthForTests(); __resetGovernorForTests(); __setAdmissionTuningForTests({ kickMs: 100 }); __setGovernorTuningForTestsOnly({ totalMemoryBytes: 32 * GB, freeMemoryBytes: 24 * GB, tier: "p32" }); });
afterEach(() => { __resetGovernorForTests(); __setAdmissionTuningForTests(); });

test("the peak mirrors the governor: measured, else the file times the engine's multiplier, else the request", () => {
  expect(governorPeak({ id: "a", kind: "resident", requestedBytes: 5, measuredPeakBytes: 9 })).toBe(9);
  expect(governorPeak({ id: "a", kind: "resident", requestedBytes: 5, modelFileBytes: 10 * GB, engine: "llama-server" })).toBe(13 * GB);
  expect(governorPeak({ id: "a", kind: "resident", requestedBytes: 5 })).toBe(5);
});

test("a queued start is admitted when the holder releases, and a start that times out withdraws: no late admission, no phantom", async () => {
  const holder = await admit({ id: "chat", kind: "resident", requestedBytes: 12 * GB }) as GovernorHandle;
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 32 * GB, freeMemoryBytes: 10 * GB, tier: "p32" });
  const positions: number[] = [];
  const waiting = waitForAdmission({ id: "image", kind: "resident", requestedBytes: 5 * GB }, { stillWanted: () => true, onPosition: (position) => positions.push(position) });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(positions[0]).toBe(1);
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 32 * GB, freeMemoryBytes: 24 * GB, tier: "p32" });
  release(holder);
  const handle = await waiting;
  expect(handle?.id).toBe("image");
  release(handle!);
  // A second start gives up after its deadline: it withdraws from the
  // governor's queue, so no late admission ever happens and a later
  // release of the holder admits nothing on its behalf.
  const holder2 = await admit({ id: "chat", kind: "resident", requestedBytes: 12 * GB }) as GovernorHandle;
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 32 * GB, freeMemoryBytes: 10 * GB, tier: "p32" });
  let gaveUp = false;
  const late = await waitForAdmission({ id: "image", kind: "resident", requestedBytes: 5 * GB }, { stillWanted: () => true, timeoutMs: 300, onGaveUp: () => { gaveUp = true; } });
  expect(late).toBeNull();
  expect(gaveUp).toBe(true);
  expect(getGovernorStatus().queue.length).toBe(0);
  expect(getGovernorStatus().loaded.map((item) => item.id)).toEqual(["chat"]);
  expect(waitingReason("image", { id: "image", kind: "resident", requestedBytes: 5 * GB })).toMatch(/needs about 5\.0 GB with 10\.0 GB free/);
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 32 * GB, freeMemoryBytes: 24 * GB, tier: "p32" });
  release(holder2);
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(getGovernorStatus().loaded.length).toBe(0);
  expect(getGovernorStatus().queue.length).toBe(0);
});

test("a peak over the cap is refused at once with both numbers", async () => {
  await expect(waitForAdmission({ id: "image", kind: "resident", requestedBytes: 40 * GB }, { stillWanted: () => true })).rejects.toThrow(/needs about 40\.0 GB; the memory budget for models is 24\.0 GB/);
});

test("a retried wait on the same id takes over the old watcher: the retry gets the admission, never a rejection", async () => {
  const holder = await admit({ id: "chat", kind: "resident", requestedBytes: 12 * GB }) as GovernorHandle;
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 32 * GB, freeMemoryBytes: 10 * GB, tier: "p32" });
  const first = await waitForAdmission({ id: "image", kind: "resident", requestedBytes: 5 * GB }, { stillWanted: () => true, timeoutMs: 200 });
  expect(first).toBeNull();
  // The retry, while the old watcher still polls the same id.
  const retry = waitForAdmission({ id: "image", kind: "resident", requestedBytes: 5 * GB }, { stillWanted: () => true });
  await new Promise((resolve) => setTimeout(resolve, 120));
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 32 * GB, freeMemoryBytes: 24 * GB, tier: "p32" });
  release(holder);
  const handle = await retry;
  expect(handle?.id).toBe("image");
  await new Promise((resolve) => setTimeout(resolve, 400));
  // The engine still holds its admission; the old watcher took nothing.
  expect(getGovernorStatus().loaded.map((item) => item.id)).toEqual(["image"]);
  release(handle!);
});

test("no kick while the memory reading is degraded: the head stays queued instead of being refused and dropped", async () => {
  const { startGovernor } = await import("@/lib/governor");
  const { scriptedMemoryReader } = await import("@/lib/memory/scripted");
  const holder = await admit({ id: "chat", kind: "resident", requestedBytes: 12 * GB }) as GovernorHandle;
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 32 * GB, freeMemoryBytes: 10 * GB, tier: "p32" });
  const waiting = waitForAdmission({ id: "image", kind: "resident", requestedBytes: 5 * GB }, { stillWanted: () => true, timeoutMs: 900 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const stop = startGovernor({ pid: 1, pollMs: 1, memoryReader: scriptedMemoryReader(Array.from({ length: 400 }, () => ({ probeError: "The kernel's ledger was unreachable." }))) } as never);
  for (let index = 0; index < 50 && !getGovernorStatus().memoryReadingDegraded; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(getGovernorStatus().memoryReadingDegraded).toBe(true);
  // Several kick intervals pass; the request is still queued, never refused.
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(getGovernorStatus().queue.map((item) => item.id)).toEqual(["image"]);
  stop();
  const result = await waiting;
  expect(result).toBeNull();
  release(holder);
});
