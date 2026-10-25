import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  __resetGovernorForTests,
  __setGovernorTuningForTestsOnly,
  admit,
  getGovernorStatus,
  getGovernorDecisions,
  fitsEver,
  roomAfterEviction,
  setGovernorMemorySettings,
  setMetalCapBytes,
  defaultModelBudgetBytes,
  release,
  refreshMeasuredPeak,
  startGovernor,
  withdraw,
  touch,
  type GovernorHandle,
} from "@/lib/governor";
import { scriptedMemoryReader } from "@/lib/memory/scripted";
import { availableBytesFromVmStatistics } from "@/lib/memory/darwin";
import type { MemoryPressure } from "@/lib/memory";
import { EVENT_2026_10_06, PAGE_BYTES, vmStatistics } from "./fixtures/vmStatistics";
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

test("fitsEver refuses only a peak that cannot fit after reserved memory and margin", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 64 * GB, freeMemoryBytes: 64 * GB, tier: "p64" });
  await admit({ id: "chat", kind: "resident", class: "reserved", requestedBytes: 28 * GB, measuredPeakBytes: 28 * GB });
  const video = { id: "video", kind: "generator" as const, class: "burst" as const, requestedBytes: 33 * GB };
  expect(fitsEver(video)).toBe(false);
  expect(await admit(video)).toMatchObject({ refused: true, reason: "This video needs about 33.0 GB of memory and this computer has 24.0 GB for pictures and videos after chat. Try a shorter clip, or ask an admin to turn video off for this computer." });
  const picture = { id: "picture", kind: "generator" as const, class: "warm" as const, requestedBytes: 20 * GB };
  expect(fitsEver(picture)).toBe(true);
  __setGovernorTuningForTestsOnly({ freeMemoryBytes: 10 * GB });
  expect(await admit(picture)).toMatchObject({ queued: true });
});

test("Q8 admits a picture in the 4 GiB flex band and returns it on release", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 39 * GB, tier: "p128" });
  const picture = { id: "picture", role: "image", kind: "generator" as const, class: "warm" as const, requestedBytes: 20 * GB };

  const result = await admit(picture);
  expect(result).toMatchObject({ id: "picture", class: "warm" });
  expect(getGovernorStatus().freeMemoryBytes - picture.requestedBytes).toBeGreaterThanOrEqual(16 * GB);
  release(result as GovernorHandle);
  expect(getGovernorStatus().loaded).toHaveLength(0);
});

test("Q8 does not admit a video in the flex band", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 39 * GB, tier: "p128" });
  expect(await admit({ id: "video", role: "video", kind: "generator", class: "burst", requestedBytes: 20 * GB })).toMatchObject({ queued: true, position: 1 });
});

test("Q8 allows one borrower and admits the next picture after release", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 39 * GB, tier: "p128" });
  const first = await admit({ id: "picture-one", role: "image", kind: "generator", class: "warm", requestedBytes: 20 * GB }) as GovernorHandle;
  const second = await admit({ id: "picture-two", role: "image", kind: "generator", class: "warm", requestedBytes: 20 * GB });
  expect(second).toMatchObject({ queued: true, position: 1 });
  release(first);
  const next = (second as { admitted: Promise<unknown> }).admitted;
  expect(await next).toMatchObject({ id: "picture-two" });
});

test("Q8 never holds back a reserved request while the band is borrowed", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 39 * GB, tier: "p128" });
  const picture = await admit({ id: "picture-borrower", role: "image", kind: "generator", class: "warm", requestedBytes: 20 * GB }) as GovernorHandle;
  const resident = await admit({ id: "resident-waiting", kind: "resident", class: "reserved", requestedBytes: GB });
  expect(resident).toMatchObject({ id: "resident-waiting" });
  release(picture);
});

test("Q8 does not use the flex band at warn or critical pressure", async () => {
  for (const pressure of ["warn", "critical"] as const) {
    __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 39 * GB, tier: "p128" });
    const stop = startGovernor({ pid: 1, pollMs: 1, memoryReader: scriptedMemoryReader([
      { totalBytes: 128 * GB, freeBytes: 39 * GB, availablePercent: 25, pressure, degraded: false },
    ]) });
    stops.push(stop);
    await Bun.sleep(5);
    expect(getGovernorStatus().pressure).toBe(pressure);
    expect(await admit({ id: `picture-${pressure}`, role: "image", kind: "generator", class: "warm", requestedBytes: 20 * GB })).toMatchObject({ queued: true });
    stop();
    await Bun.sleep(5);
    __resetGovernorForTests();
  }
});

test("Q8 never lets a picture flex admission leave less than 16 GiB free", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 35 * GB, tier: "p128" });
  expect(await admit({ id: "picture-floor", role: "image", kind: "generator", class: "warm", requestedBytes: 20 * GB })).toMatchObject({ queued: true });
});

test("Q8 release after a failed picture returns the band", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 39 * GB, tier: "p128" });
  const failedPicture = await admit({ id: "picture-failed", role: "image", kind: "generator", class: "warm", requestedBytes: 20 * GB }) as GovernorHandle;
  const waitingPicture = await admit({ id: "picture-waiting", role: "image", kind: "generator", class: "warm", requestedBytes: 20 * GB });
  expect(waitingPicture).toMatchObject({ queued: true });
  release(failedPicture);
  expect(await (waitingPicture as { admitted: Promise<unknown> }).admitted).toMatchObject({ id: "picture-waiting" });
});

test("a fitting queued request stays queued beyond ten minutes and admits when memory frees", async () => {
  let now = Date.parse("2026-10-25T12:00:00.000Z");
  let free = 10 * GB;
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 64 * GB, freeMemoryBytes: free, tier: "p16" });
  const queued = await admit({ id: "picture", kind: "generator", class: "warm", requestedBytes: 20 * GB });
  expect(queued).toMatchObject({ queued: true, position: 1 });
  const stop = startGovernor({ pid: 1, pollMs: 1, now: () => now, freeMemory: () => free, totalMemory: () => 64 * GB });
  stops.push(stop);
  now += 10 * 60_000;
  await Bun.sleep(10);
  expect(getGovernorStatus().queue).toMatchObject([{ id: "picture", position: 1 }]);
  free = 40 * GB;
  now += 1_000;
  const admitted = (queued as { admitted: Promise<unknown> }).admitted;
  const result = await Promise.race([admitted, Bun.sleep(100).then(() => "still waiting")]);
  expect(result).toMatchObject({ id: "picture" });
});

test("roomAfterEviction orders idle warm models and protects reserved and busy entries", async () => {
  let now = Date.now();
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 100 * GB, tier: "p128" });
  await admit({ id: "chat", kind: "resident", class: "reserved", requestedBytes: 10 * GB });
  await admit({ id: "picture-pool", kind: "jit", class: "warm", requestedBytes: 15 * GB });
  await admit({ id: "edit-model", kind: "jit", class: "warm", requestedBytes: 10 * GB });
  await admit({ id: "video", kind: "generator", class: "burst", requestedBytes: 12 * GB });
  touch("picture-pool");
  touch("edit-model");
  const stop = startGovernor({ pid: 1, pollMs: 1, now: () => now, busy: (id) => id === "video", unload: () => true });
  stops.push(stop);
  now += 2 * 60_000 + 1_000;
  const room = roomAfterEviction({ id: "video-next", kind: "generator", class: "burst", requestedBytes: 20 * GB }, (id) => id === "video", now);
  expect(room.evictionOrder).toEqual(["edit-model", "picture-pool"]);
  expect(room.evictionOrder).not.toContain("chat");
  expect(room.evictionOrder).not.toContain("video");
});

test("the image pool admission becomes one warm governor item and is reused for a larger edit", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 100 * GB, tier: "p128" });
  const create = await admit({ id: "image-pool", kind: "generator", class: "warm", requestedBytes: 15 * GB, measuredPeakBytes: 15 * GB, retainWarm: true }) as GovernorHandle;
  refreshMeasuredPeak(create, 14 * GB);
  release(create);
  expect(getGovernorStatus().loaded).toMatchObject([{ id: "image-pool", kind: "jit", class: "warm", peakBytes: 14 * GB, measured: true }]);

  const edit = await admit({ id: "image-pool", kind: "generator", class: "warm", requestedBytes: 29 * GB, retainWarm: true }) as GovernorHandle;
  expect(edit.token).toBe(create.token);
  expect(getGovernorStatus().loaded).toHaveLength(1);
  expect(getGovernorStatus().loaded[0]).toMatchObject({ id: "image-pool", kind: "generator", peakBytes: 29 * GB });
  release(edit);
  expect(getGovernorStatus().loaded).toHaveLength(1);
});

test("an image edit reserves the full pool when it fits and stays at one-model size when it does not", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 90 * GB, tier: "p128" });
  const full = await admit({ id: "image-pool", kind: "generator", class: "warm", requestedBytes: 18 * GB, measuredPeakBytes: 18 * GB, poolPeakBytes: 29_000_000_000, retainWarm: true }) as GovernorHandle;
  expect(getGovernorStatus().loaded[0]).toMatchObject({ peakBytes: 29_000_000_000 });
  release(full);

  __resetGovernorForTests();
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 40 * GB, tier: "p128" });
  const fallback = await admit({ id: "image-pool", kind: "generator", class: "warm", requestedBytes: 18 * GB, measuredPeakBytes: 18 * GB, poolPeakBytes: 29_000_000_000, retainWarm: true }) as GovernorHandle;
  expect(getGovernorStatus().loaded[0]).toMatchObject({ peakBytes: 18 * GB, measured: true });
  release(fallback);
});

test("an idle image pool unloads through the governor after its warm window and a busy pool is protected", async () => {
  let now = Date.now();
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 100 * GB, tier: "p128" });
  const handle = await admit({ id: "image-pool", kind: "generator", class: "warm", requestedBytes: 15 * GB, retainWarm: true }) as GovernorHandle;
  release(handle);
  let busy = true;
  const unloaded: string[] = [];
  const stop = startGovernor({ pid: 1, pollMs: 1, now: () => now, busy: (id) => id === "image-pool" && busy, unload: (id) => { unloaded.push(id); return true; } });
  stops.push(stop);
  now += 11 * 60_000;
  await Bun.sleep(10);
  expect(unloaded).not.toContain("image-pool");
  busy = false;
  await Bun.sleep(50);
  expect(unloaded).toContain("image-pool");
  await Bun.sleep(5);
  expect(getGovernorStatus().loaded).toEqual([]);
});

test("a burst video waits for the warm grace, unloads the idle image pool, then is admitted", async () => {
  let now = Date.now();
  let free = 100 * GB;
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: free, tier: "p128" });
  const pool = await admit({ id: "image-pool", kind: "generator", class: "warm", requestedBytes: 29 * GB, retainWarm: true }) as GovernorHandle;
  free = 40 * GB;
  __setGovernorTuningForTestsOnly({ freeMemoryBytes: free });
  const video = await admit({ id: "video-job", kind: "generator", class: "burst", requestedBytes: 44 * GB });
  expect(video).toMatchObject({ queued: true });
  expect(roomAfterEviction({ id: "video-next", kind: "generator", class: "burst", requestedBytes: 44 * GB }, () => false, now + 3 * 60_000).evictionOrder).not.toContain("image-pool");
  release(pool);
  expect(getGovernorStatus().loaded).toMatchObject([{ id: "image-pool", kind: "jit", class: "warm" }]);
  const unloaded: string[] = [];
  const stop = startGovernor({ pid: 1, pollMs: 1, now: () => now, freeMemory: () => free, totalMemory: () => 128 * GB, unload: (id) => { unloaded.push(id); if (id === "image-pool") free += 29 * GB; return true; } });
  stops.push(stop);
  await Bun.sleep(10);
  expect(unloaded).not.toContain("image-pool");
  now += 2 * 60_000 + 5_000;
  expect(roomAfterEviction({ id: "video-next", kind: "generator", class: "burst", requestedBytes: 44 * GB }, () => false, now).evictionOrder).toContain("image-pool");
  await Bun.sleep(30);
  expect(unloaded).toContain("image-pool");
  const result = await Promise.race([(video as { admitted: Promise<unknown> }).admitted, Bun.sleep(200).then(() => "waiting")]);
  expect(result).toMatchObject({ id: "video-job", kind: "generator" });
  expect(unloaded).toContain("image-pool");
});

test("p16 admits chat, voice, speech and embed with realistic 13 GiB starting free memory", async () => {
  const memory = 24 * GB;
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: memory, freeMemoryBytes: 13 * GB, tier: "p16" });
  const requests = [
    { id: "chat", kind: "resident" as const, requestedBytes: 5_027_783_488, modelFileBytes: 5_027_783_488, engine: "llama-server" },
    { id: "tts", kind: "resident" as const, requestedBytes: 828_868_000, measuredPeakBytes: 828_868_000 },
    { id: "stt", kind: "resident" as const, requestedBytes: 239_387_872, measuredPeakBytes: 239_387_872 },
    { id: "embed", kind: "resident" as const, requestedBytes: 84_106_624, modelFileBytes: 84_106_624, engine: "llama-server" },
  ];
  // 13 - 6.54 = 6.46; - 0.83 = 5.63; - 0.24 = 5.39; - 0.11 = 5.28 GiB, each above the 4 GiB p16 margin.
  for (const request of requests) expect("id" in await admit(request)).toBe(true);
  const status = getGovernorStatus();
  expect(status.capBytes).toBe(16 * GB);
  expect(status.loaded.map(({ id }) => id)).toEqual(["chat", "tts", "stt", "embed"]);
  expect(status.loaded.reduce((sum, item) => sum + item.peakBytes, 0)).toBeLessThan(status.capBytes);
});

test("with 11 GiB free p16 admits chat and defers a separate judge at the 4 GiB margin", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 24 * GB, freeMemoryBytes: 11 * GB, tier: "p16" });
  const chat = { id: "chat", kind: "resident" as const, requestedBytes: 5_027_783_488, modelFileBytes: 5_027_783_488, engine: "llama-server" };
  const judge = { id: "judge", kind: "resident" as const, requestedBytes: 3_760_000_000, measuredPeakBytes: 3_760_000_000 };
  expect("id" in await admit(chat)).toBe(true);
  // Model the machine's free-memory report after chat's 6.54 GiB peak loaded: 11 - 6.54 = about 4.46 GiB remains.
  __setGovernorTuningForTestsOnly({ freeMemoryBytes: 4.46 * GB });
  expect(await admit(judge)).toMatchObject({ queued: true, position: 1 });
  expect(getGovernorDecisions().find((decision) => decision.model === "judge")?.reason).toBe("The current memory budget cannot admit the request.");
  expect(getGovernorStatus().loaded.map(({ id }) => id)).toEqual(["chat"]);
});

test("p32 realistic free memory admits chat and its separate judge", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 48 * GB, freeMemoryBytes: 32 * GB, tier: "p32" });
  const chat = { id: "chat", kind: "resident" as const, requestedBytes: 5_027_783_488, modelFileBytes: 5_027_783_488, engine: "llama-server" };
  const judge = { id: "judge", kind: "resident" as const, requestedBytes: 2_497_280_256, modelFileBytes: 2_497_280_256, engine: "llama-server" };
  expect("id" in await admit(chat)).toBe(true);
  expect("id" in await admit(judge)).toBe(true);
  expect(getGovernorStatus().loaded.map(({ id }) => id)).toEqual(["chat", "judge"]);
});

test("peak headroom is added to every base while only the measured base stays measured", async () => {
  const { peakFor } = await import("@/lib/governor");
  const headroom = GB;
  expect(peakFor({ id: "m", kind: "resident", requestedBytes: 5, measuredPeakBytes: 9, headroomBytes: headroom })).toEqual({ bytes: 9 + headroom, measured: true });
  expect(peakFor({ id: "d", kind: "resident", requestedBytes: 5, dryRunPeakBytes: 8, headroomBytes: headroom })).toEqual({ bytes: 8 + headroom, measured: false });
  expect(peakFor({ id: "f", kind: "resident", requestedBytes: 5, modelFileBytes: 10 * GB, engine: "llama-server", headroomBytes: headroom })).toEqual({ bytes: Math.ceil(10 * GB * 1.3) + headroom, measured: false });
  expect(peakFor({ id: "r", kind: "resident", requestedBytes: 5, headroomBytes: headroom })).toEqual({ bytes: 5 + headroom, measured: false });
});

test("the process watcher includes headroom in its measured resident baseline", async () => {
  const base = GB;
  const headroom = GB;
  const admission = await admit({ id: "resident-headroom", kind: "resident", requestedBytes: base, measuredPeakBytes: base, headroomBytes: headroom, pid: 42 }) as GovernorHandle;
  refreshMeasuredPeak(admission, base);
  // 1.3 x (base + headroom) + 0.5 GB is above this reading; without the
  // headroom, 1.3 x base + 0.5 GB would be below it.
  __setGovernorTuningForTestsOnly({ pollMs: 1, processSustainedPolls: 2 });
  let restarts = 0;
  const stop = startGovernor({ pid: 42, freeMemory: () => 32 * GB, totalMemory: () => 64 * GB, processMemory: async () => 2.2 * GB, restart: () => { restarts++; } });
  stops.push(stop);
  await Bun.sleep(15);
  expect(restarts).toBe(0);
});

test("a successful post-load measurement refreshes the active admission baseline", async () => {
  const stale = 3_379_206_840;
  const latest = 11_500_000_000;
  const admission = await admit({ id: "resident-chat", kind: "resident", requestedBytes: stale, measuredPeakBytes: stale, pid: 42 });
  expect("id" in admission).toBe(true);
  if (!("id" in admission)) throw new Error("expected an admission");
  refreshMeasuredPeak(admission, latest);
  expect(getGovernorStatus().loaded[0]).toMatchObject({ id: "resident-chat", peakBytes: latest, measured: true });
  __setGovernorTuningForTestsOnly({ pollMs: 1, processSustainedPolls: 2 });
  let restarts = 0;
  const stop = startGovernor({ pid: 42, freeMemory: () => 32 * GB, totalMemory: () => 64 * GB, processMemory: async () => latest, restart: () => { restarts++; } });
  stops.push(stop);
  await Bun.sleep(15);
  expect(restarts).toBe(0);
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
  refreshMeasuredPeak(await admit({ id: "resident-chat", kind: "resident", requestedBytes: GB, measuredPeakBytes: GB, pid: 42 }) as GovernorHandle, GB);
  __setGovernorTuningForTestsOnly({ pollMs: 1, processSustainedPolls: 2 });
  let restarts = 0;
  const stop = startGovernor({ pid: 42, freeMemory: () => 32 * GB, totalMemory: () => 64 * GB, processMemory: async () => 2 * GB, restart: () => { restarts++; } });
  stops.push(stop);
  await Bun.sleep(15);
  expect(restarts).toBeGreaterThan(0);
});

test("rule 4 exposes a cap and refuses a request that can never fit", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 16 * GB, freeMemoryBytes: 16 * GB });
  const admitted = await admit({ id: "large", kind: "resident", requestedBytes: 7 * GB });
  expect("id" in admitted).toBe(true);
  expect(getGovernorStatus().capBytes).toBe(8 * GB);
  expect(await admit({ id: "too-large", kind: "resident", requestedBytes: 2 * GB })).toMatchObject({ refused: true, reason: expect.stringContaining("2.0 GB") });
});

test("Metal cap lowers the 128 GiB budget and admission ceiling", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 128 * GB });
  setMetalCapBytes(96 * GB);
  expect(getGovernorStatus().capBytes).toBe(96 * GB);
  expect(defaultModelBudgetBytes()).toBe(96 * GB);
  expect(await admit({ id: "over-metal", kind: "resident", requestedBytes: 100 * GB })).toMatchObject({ refused: true, reason: expect.stringContaining("100.0 GB") });
});

test("null Metal cap preserves the OS-margin budget, and smaller OS margin wins", () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 128 * GB });
  setMetalCapBytes(null);
  expect(getGovernorStatus().capBytes).toBe(120 * GB);
  expect(defaultModelBudgetBytes()).toBe(120 * GB);
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 24 * GB, freeMemoryBytes: 24 * GB });
  setMetalCapBytes(18186 * 1_048_576);
  expect(getGovernorStatus().capBytes).toBe(16 * GB);
});

test("a live model budget setting refuses a request that can never fit", async () => {
  setGovernorMemorySettings({ modelBudgetBytes: 2 * GB });
  expect(await admit({ id: "too-large", kind: "resident", requestedBytes: 3 * GB })).toMatchObject({ refused: true });
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
  // The reading stays degraded until the test says so: a fixed script of
  // three degraded polls at 1 ms could pass between two 5 ms looks on a
  // loaded machine, which made this test fail about 1 run in 6.
  let probeFails = false;
  const good = scriptedMemoryReader([{ totalBytes: 64 * GB, freeBytes: 32 * GB, availablePercent: 50, pressure: "normal", degraded: false }]);
  const failing = scriptedMemoryReader([{ totalBytes: 64 * GB, freeBytes: 32 * GB, availablePercent: 50, pressure: "normal", degraded: false }, { probeError: "The kernel's ledger was unreachable." }]);
  failing.read();
  const stop = startGovernor({ pid: 1, pollMs: 1, memoryReader: { read: () => probeFails ? failing.read() : good.read(), processMemoryBytes: () => null } });
  await Bun.sleep(5);
  probeFails = true;
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
  probeFails = false;
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

test("a request queued by the working margin alone is admitted once free memory clears it, with no pressure or floor crossing", async () => {
  // The 2026-10-04 incident: 0.5 GB refused with 7.8 GB free and normal pressure.
  // Free dipped under peak + margin (4 GB on p16) while an engine loaded, never
  // under the low-water floor, so no edge fired and the request waited out its deadline.
  const reading = (freeGb: number) => ({ totalBytes: 24 * GB, freeBytes: freeGb * GB, availablePercent: 30, pressure: "normal" as const, degraded: false });
  const stop = startGovernor({ pid: 1, pollMs: 100, tier: "p16", memoryReader: scriptedMemoryReader([reading(4.3), reading(4.3), reading(7.8)]) });
  stops.push(stop);
  await Bun.sleep(10);
  const queued = await admit({ id: "margin-only", kind: "resident", requestedBytes: Math.round(0.5 * GB) });
  expect(queued).toMatchObject({ queued: true, position: 1 });
  const admitted = await Promise.race([(queued as { admitted: Promise<unknown> }).admitted, Bun.sleep(1_500).then(() => "stuck")]);
  expect(admitted).toMatchObject({ id: "margin-only", kind: "resident" });
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

test("a release during a degraded read keeps the head queued with its promise pending, and the next good read admits it", async () => {
  await admit({ id: "busy", kind: "generator", requestedBytes: GB });
  const first = await admit({ id: "first", kind: "resident", requestedBytes: GB }) as GovernorHandle;
  const queued = await admit({ id: "queued", kind: "generator", requestedBytes: 2 * GB });
  expect(queued).toMatchObject({ queued: true, position: 1 });
  const stop = startGovernor({ pid: 1, pollMs: 1, memoryReader: scriptedMemoryReader([
    { totalBytes: 64 * GB, freeBytes: 8 * GB, availablePercent: 12, pressure: "warn", degraded: false },
    { probeError: "The kernel's ledger was unreachable." },
    { probeError: "The kernel's ledger was unreachable." },
    { probeError: "The kernel's ledger was unreachable." },
    { totalBytes: 64 * GB, freeBytes: 32 * GB, availablePercent: 50, pressure: "normal", degraded: false },
    { totalBytes: 64 * GB, freeBytes: 32 * GB, availablePercent: 50, pressure: "normal", degraded: false },
    { totalBytes: 64 * GB, freeBytes: 32 * GB, availablePercent: 50, pressure: "normal", degraded: false },
    { totalBytes: 64 * GB, freeBytes: 32 * GB, availablePercent: 50, pressure: "normal", degraded: false },
    { totalBytes: 64 * GB, freeBytes: 32 * GB, availablePercent: 50, pressure: "normal", degraded: false },
  ]) });
  stops.push(stop);
  let degradedStatus = getGovernorStatus();
  for (let index = 0; index < 20 && !degradedStatus.memoryReadingDegraded; index++) {
    await Bun.sleep(5);
    degradedStatus = getGovernorStatus();
  }
  expect(degradedStatus.memoryReadingDegraded).toBe(true);
  release(first);
  expect(getGovernorStatus().queue).toMatchObject([{ id: "queued", position: 1 }]);
  expect(getGovernorStatus().loaded).toMatchObject([{ id: "busy", kind: "generator" }]);
  release({ id: "busy", kind: "generator", requestedBytes: GB });
  const settled = (queued as { admitted: Promise<unknown> }).admitted;
  const result = await settled;
  expect(result).toMatchObject({ id: "queued", kind: "generator" });
  expect(getGovernorStatus().queue).toHaveLength(0);
  expect(getGovernorStatus().loaded).toMatchObject([{ id: "queued", kind: "generator" }]);
});

// STACK-PROCMEM-01: the live 8B chat (Qwen3-8B Q4_K_M, context 40,960)
// was recorded at 3,379,206,840 bytes, the macOS footprint alone, while
// about 7.9 GB was resident with the weights the engine maps; the watch
// restarted it twice on ordinary use (2026-10-06, 13:00:43 and 13:05:40 UTC).
const RECORDED_FOOTPRINT = 3_379_206_840;
const RESIDENT_WITH_WEIGHTS = 7_900_000_000;

test("a stale 3.38 GB stored figure never restarts a chat engine holding 7.9 GB", async () => {
  await admit({ id: "chat", kind: "resident", requestedBytes: 5_027_783_488, measuredPeakBytes: RECORDED_FOOTPRINT, pid: 42 });
  __setGovernorTuningForTestsOnly({ pollMs: 1, processSustainedPolls: 2 });
  let restarts = 0;
  const stop = startGovernor({ pid: 42, freeMemory: () => 32 * GB, totalMemory: () => 64 * GB, processMemory: async () => RESIDENT_WITH_WEIGHTS, restart: () => { restarts++; } });
  stops.push(stop);
  await Bun.sleep(15);
  expect(restarts).toBe(0);
});

test("after its post-load reading of 7.9 GB, a healthy chat is kept and a runaway past 1.3 x plus 0.5 GB is restarted", async () => {
  const admission = await admit({ id: "chat", kind: "resident", requestedBytes: 5_027_783_488, measuredPeakBytes: RECORDED_FOOTPRINT, pid: 42 }) as GovernorHandle;
  refreshMeasuredPeak(admission, RESIDENT_WITH_WEIGHTS);
  expect(getGovernorStatus().loaded[0]).toMatchObject({ id: "chat", peakBytes: RESIDENT_WITH_WEIGHTS, measured: true });
  __setGovernorTuningForTestsOnly({ pollMs: 1, processSustainedPolls: 2 });
  let reading = 8_485_470_208; // the same engine an hour later, cache filling
  let restarts = 0;
  const stop = startGovernor({ pid: 42, freeMemory: () => 32 * GB, totalMemory: () => 64 * GB, processMemory: async () => reading, restart: () => { restarts++; } });
  stops.push(stop);
  await Bun.sleep(15);
  expect(restarts).toBe(0);
  reading = Math.ceil(RESIDENT_WITH_WEIGHTS * 1.3 + 500_000_000) + 1;
  for (let index = 0; index < 40 && restarts === 0; index++) await Bun.sleep(5);
  expect(restarts).toBeGreaterThan(0);
});

test("the measured peak follows this run upward and is handed back to be stored", async () => {
  const admission = await admit({ id: "chat", kind: "resident", requestedBytes: 5_027_783_488, measuredPeakBytes: RECORDED_FOOTPRINT, pid: 42 }) as GovernorHandle;
  refreshMeasuredPeak(admission, RESIDENT_WITH_WEIGHTS);
  __setGovernorTuningForTestsOnly({ pollMs: 1 });
  const stored: number[] = [];
  let reading = RESIDENT_WITH_WEIGHTS + 10_000_000; // under the 64 MiB step: not written
  const stop = startGovernor({ pid: 42, freeMemory: () => 32 * GB, totalMemory: () => 64 * GB, processMemory: async () => reading, onPeak: (_id, bytes) => { stored.push(bytes); } });
  stops.push(stop);
  await Bun.sleep(10);
  expect(stored).toEqual([]);
  expect(getGovernorStatus().loaded[0]?.peakBytes).toBe(RESIDENT_WITH_WEIGHTS + 10_000_000);
  reading = 8_485_470_208;
  for (let index = 0; index < 40 && stored.length === 0; index++) await Bun.sleep(5);
  expect(stored).toEqual([8_485_470_208]);
  expect(getGovernorStatus().loaded[0]?.peakBytes).toBe(8_485_470_208);
  // A lower reading later never lowers this run's peak.
  reading = RESIDENT_WITH_WEIGHTS;
  await Bun.sleep(10);
  expect(getGovernorStatus().loaded[0]?.peakBytes).toBe(8_485_470_208);
});

test("a runaway restart waits while the engine serves a request, unless pressure is critical", async () => {
  const admission = await admit({ id: "chat", kind: "resident", requestedBytes: GB, measuredPeakBytes: GB, pid: 42 }) as GovernorHandle;
  refreshMeasuredPeak(admission, GB);
  __setGovernorTuningForTestsOnly({ pollMs: 1, processSustainedPolls: 2 });
  let busy = true;
  let restarts = 0;
  const stop = startGovernor({ pid: 42, freeMemory: () => 32 * GB, totalMemory: () => 64 * GB, processMemory: async () => 4 * GB, busy: () => busy, restart: () => { restarts++; } });
  stops.push(stop);
  await Bun.sleep(15);
  expect(restarts).toBe(0);
  busy = false;
  for (let index = 0; index < 40 && restarts === 0; index++) await Bun.sleep(5);
  expect(restarts).toBeGreaterThan(0);
});

test("a runaway under critical kernel pressure is restarted even mid-request", async () => {
  const admission = await admit({ id: "chat", kind: "resident", requestedBytes: GB, measuredPeakBytes: GB, pid: 42 }) as GovernorHandle;
  refreshMeasuredPeak(admission, GB);
  __setGovernorTuningForTestsOnly({ pollMs: 1, processSustainedPolls: 2 });
  let restarts = 0;
  const stop = startGovernor({ pid: 42, processMemory: async () => 4 * GB, busy: () => true, restart: () => { restarts++; }, memoryReader: scriptedMemoryReader([{ totalBytes: 64 * GB, freeBytes: 32 * GB, availablePercent: 50, pressure: "critical", degraded: false }]) });
  stops.push(stop);
  for (let index = 0; index < 40 && restarts === 0; index++) await Bun.sleep(5);
  expect(restarts).toBeGreaterThan(0);
});

test("a peak that cannot be stored keeps the watch running", async () => {
  const admission = await admit({ id: "chat", kind: "resident", requestedBytes: GB, measuredPeakBytes: GB, pid: 42 }) as GovernorHandle;
  refreshMeasuredPeak(admission, GB);
  __setGovernorTuningForTestsOnly({ pollMs: 1, processSustainedPolls: 2 });
  let reading = 1.2 * GB;
  let restarts = 0;
  let locked = true;
  const stored: number[] = [];
  const stop = startGovernor({ pid: 42, freeMemory: () => 32 * GB, totalMemory: () => 64 * GB, processMemory: async () => reading, onPeak: (_id, bytes) => { if (locked) throw new Error("database is locked"); stored.push(bytes); }, restart: () => { restarts++; } });
  stops.push(stop);
  await Bun.sleep(10);
  // The peak levelled off while the store was locked: it is written once
  // the store is back, not only after a further rise.
  locked = false;
  for (let index = 0; index < 40 && stored.length === 0; index++) await Bun.sleep(5);
  expect(stored[0]).toBe(1.2 * GB);
  reading = 4 * GB;
  for (let index = 0; index < 40 && restarts === 0; index++) await Bun.sleep(5);
  expect(restarts).toBeGreaterThan(0);
});

// The 2026-10-06 event on the p16 laptop: the honest 8B chat figure
// (STACK-PROCMEM-01) against the machine's memory as the reader reads it.
const HONEST_CHAT_BYTES = 8_436_858_360;
const P16_TOTAL_BYTES = 25_769_803_776;
const eventReading = (pressure: MemoryPressure) => ({ totalBytes: P16_TOTAL_BYTES, freeBytes: availableBytesFromVmStatistics(vmStatistics(EVENT_2026_10_06), PAGE_BYTES), availablePercent: 69, pressure, degraded: false });
const honestChat = { id: "chat", kind: "resident" as const, requestedBytes: 5_027_783_488, modelFileBytes: 5_027_783_488, measuredPeakBytes: HONEST_CHAT_BYTES, engine: "llama-server" };

test("the honest 8.4 GB chat is admitted on p16 when the file cache counts as available and pressure is normal", async () => {
  // Before the fix the reader said 8,800,010,240 B (8.2 GiB) and the chat
  // queued: "needs about 7.9 GB with 8.2 GB free".
  const stop = startGovernor({ pid: 1, pollMs: 1, tier: "p16", memoryReader: scriptedMemoryReader([eventReading("normal")]) });
  stops.push(stop);
  await Bun.sleep(5);
  expect(getGovernorStatus()).toMatchObject({ pressure: "normal", freeMemoryBytes: 16_449_994_752, marginBytes: 4 * GB });
  expect(await admit(honestChat)).toMatchObject({ id: "chat", requestedBytes: HONEST_CHAT_BYTES });
});

test("the same reclaimable memory never admits the chat into kernel warn or critical pressure", async () => {
  for (const pressure of ["warn", "critical"] as const) {
    __resetGovernorForTests();
    const stop = startGovernor({ pid: 1, pollMs: 1, tier: "p16", memoryReader: scriptedMemoryReader([eventReading(pressure)]) });
    stops.push(stop);
    await Bun.sleep(5);
    expect(getGovernorStatus()).toMatchObject({ pressure, freeMemoryBytes: 16_449_994_752 });
    expect(await admit(honestChat)).toMatchObject({ queued: true, position: 1 });
    expect(getGovernorDecisions().find((decision) => decision.model === "chat")?.reason).toBe(`Memory pressure is ${pressure}.`);
    expect(getGovernorStatus().loaded).toHaveLength(0);
    stop();
    await Bun.sleep(5);
  }
});

test("the old free-plus-inactive figure from the event still refuses the honest chat at the p16 margin", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: P16_TOTAL_BYTES, freeMemoryBytes: 8_800_010_240, tier: "p16" });
  expect(await admit(honestChat)).toMatchObject({ queued: true, position: 1 });
});
