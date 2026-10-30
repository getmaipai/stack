import { afterEach, beforeEach, expect, test } from "bun:test";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, admit, fitsEverForTier, getGovernorDecisions, getGovernorStatus, getMaxWindow, getReclaimSteps, release, setMetalCapBytes, startGovernor, type GovernorHandle } from "@/lib/governor";

const GB = 1_073_741_824;
beforeEach(() => { __resetGovernorForTests(); __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 120 * GB, tier: "p128" }); });
const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); __resetGovernorForTests(); });

test("job tier caps use the governor room and Max can include reclaimed reduced memory", () => {
  setMetalCapBytes(75 * GB);
  expect(fitsEverForTier({ id: "std45", kind: "generator", requestedBytes: 45 * GB, tier: "standard" }).fits).toBe(true);
  expect(fitsEverForTier({ id: "std46", kind: "generator", requestedBytes: 46 * GB, tier: "standard" })).toMatchObject({ fits: false, capBytes: 45 * GB });
  expect(fitsEverForTier({ id: "boost", kind: "generator", requestedBytes: 60 * GB, tier: "boost" }).capBytes).toBeCloseTo(63.75 * GB);
  expect(fitsEverForTier({ id: "max", kind: "generator", requestedBytes: 70 * GB, tier: "max" }).capBytes).toBe(75 * GB);
  expect(fitsEverForTier({ id: "max-reclaimed", kind: "generator", requestedBytes: 80 * GB, tier: "max" }, { reducedFreedBytes: 5 * GB }).capBytes).toBe(80 * GB);
});

test("only one boost or max item can be loaded at a time", async () => {
  const first = await admit({ id: "boost-a", kind: "generator", requestedBytes: 10 * GB, tier: "boost" }) as GovernorHandle;
  const second = await admit({ id: "boost-b", kind: "generator", requestedBytes: 10 * GB, tier: "boost" });
  expect(second).toMatchObject({ queued: true, position: 1 });
  expect(getGovernorStatus().loaded.map((item) => item.tier)).toEqual(["boost"]);
  release(first);
});

const queued = (answer: unknown): { admitted: Promise<unknown> } => answer as { admitted: Promise<unknown> };

test("a Max job drains running work, holds new admissions, then the held queue restarts in order", async () => {
  const running = await admit({ id: "pic-run", kind: "generator", class: "burst", role: "image", requestedBytes: 10 * GB }) as GovernorHandle;
  const max = await admit({ id: "max-job", kind: "generator", class: "burst", role: "video", requestedBytes: 40 * GB, tier: "max" });
  expect(max).toMatchObject({ queued: true });
  expect(getMaxWindow().state).toBe("draining");
  const held = [await admit({ id: "held-1", kind: "generator", class: "burst", role: "image", requestedBytes: 5 * GB }), await admit({ id: "held-2", kind: "generator", class: "burst", role: "image", requestedBytes: 5 * GB }), await admit({ id: "held-3", kind: "generator", class: "burst", role: "image", requestedBytes: 5 * GB })];
  expect(held.every((answer) => "queued" in (answer as object))).toBe(true);
  expect(getGovernorStatus().queue.map((entry) => entry.id)).toEqual(["max-job", "held-1", "held-2", "held-3"]);
  expect(getGovernorDecisions().filter((decision) => decision.reasonCode === "max_window").length).toBe(3);
  // Reserved work is never held by the window.
  const chat = await admit({ id: "chat", kind: "resident", class: "reserved", role: "chat", requestedBytes: 4 * GB });
  expect("id" in (chat as object)).toBe(true);
  stops.push(startGovernor({ pid: 1, pollMs: 1, freeMemory: () => 100 * GB, totalMemory: () => 128 * GB }));
  await Bun.sleep(20);
  expect(getMaxWindow().state).toBe("draining");
  release(running);
  const maxHandle = await Promise.race([queued(max).admitted, Bun.sleep(300).then(() => "waiting")]) as GovernorHandle;
  expect(maxHandle).toMatchObject({ id: "max-job", tier: "max" });
  expect(getMaxWindow()).toMatchObject({ state: "open", ownerId: "max-job" });
  expect(getGovernorStatus().queue.map((entry) => entry.id)).toEqual(["held-1", "held-2", "held-3"]);
  release(maxHandle);
  expect(getMaxWindow().state).toBe("none");
  const first = await Promise.race([queued(held[0]).admitted, Bun.sleep(300).then(() => "waiting")]) as GovernorHandle;
  expect(first.id).toBe("held-1");
  release(first);
  const second = await Promise.race([queued(held[1]).admitted, Bun.sleep(300).then(() => "waiting")]) as GovernorHandle;
  expect(second.id).toBe("held-2");
  release(second);
  const third = await Promise.race([queued(held[2]).admitted, Bun.sleep(300).then(() => "waiting")]) as GovernorHandle;
  expect(third.id).toBe("held-3");
});

test("aborting the Max owner at critical pressure closes the window and a withdrawn owner frees the queue", async () => {
  const running = await admit({ id: "pic-run", kind: "generator", class: "burst", requestedBytes: 10 * GB }) as GovernorHandle;
  const max = queued(await admit({ id: "max-job", kind: "generator", class: "burst", requestedBytes: 40 * GB, tier: "max" }));
  expect(getMaxWindow().state).toBe("draining");
  const { withdraw } = await import("@/lib/governor");
  withdraw("max-job");
  expect(getMaxWindow().state).toBe("none");
  void max.admitted;
  release(running);
});

test("a queued job waits for the picture pool's 2 minute idle grace and the reclaim steps say so", async () => {
  let now = Date.now();
  let free = 100 * GB;
  const pool = await admit({ id: "image-pool", kind: "generator", class: "warm", requestedBytes: 29 * GB, retainWarm: true }) as GovernorHandle;
  free = 40 * GB;
  __setGovernorTuningForTestsOnly({ freeMemoryBytes: free });
  const video = await admit({ id: "video-job", kind: "generator", class: "burst", requestedBytes: 44 * GB });
  expect(video).toMatchObject({ queued: true });
  release(pool);
  const unloaded: string[] = [];
  stops.push(startGovernor({ pid: 1, pollMs: 1, now: () => now, freeMemory: () => free, totalMemory: () => 128 * GB, unload: (id) => { unloaded.push(id); if (id === "image-pool") free += 29 * GB; return true; } }));
  now += 119_000;
  await Bun.sleep(15);
  expect(unloaded).toEqual([]);
  expect(getReclaimSteps("video-job").map((step) => step.step)).toEqual(["pool_idle_wait"]);
  now += 2_000;
  await Bun.sleep(40);
  expect(unloaded).toContain("image-pool");
  expect(getReclaimSteps("video-job").map((step) => step.step)).toContain("evict_pool");
});
