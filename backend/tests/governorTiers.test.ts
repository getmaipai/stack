import { afterEach, beforeEach, expect, test } from "bun:test";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, admit, fitsEverForTier, getGovernorDecisions, getGovernorStatus, getMaxWindow, getReclaimSteps, liveReducedFreedBytes, NEVER_FITS_MESSAGE, neverFitCapacityBytes, refreshMeasuredPeak, release, setMaxWindowHook, setMetalCapBytes, startGovernor, type GovernorHandle, type MaxWindowChange } from "@/lib/governor";
import { __resetMaxWindowReducedForTests, maxWindowReducedIdle, unwireMaxWindowReduced, wireMaxWindowReduced } from "@/lib/maxWindowReduced";
import { __setReducedLeaseForTests } from "@/lib/reducedChatLease";
import { resetReducedChatForTests, setReducedChatState } from "@/lib/reducedChat";

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

test("a retained warm pool is not a burst and pauseAll closes a Max window", async () => {
  const pool = await admit({ id: "image-pool", kind: "generator", class: "warm", requestedBytes: 20 * GB, retainWarm: true, tier: "boost" }) as GovernorHandle;
  release(pool);
  expect(getGovernorStatus().loaded[0]?.tier).toBeUndefined();
  const next = await admit({ id: "boost-next", kind: "generator", class: "burst", requestedBytes: 10 * GB, tier: "boost" });
  expect("queued" in (next as object)).toBe(false);
  release(next as GovernorHandle);
  const running = await admit({ id: "run", kind: "generator", class: "burst", requestedBytes: 10 * GB }) as GovernorHandle;
  await admit({ id: "max-job", kind: "generator", class: "burst", requestedBytes: 40 * GB, tier: "max" });
  expect(getMaxWindow().state).toBe("draining");
  const { pauseAll } = await import("@/lib/governor");
  await pauseAll();
  expect(getMaxWindow().state).toBe("none");
  void running;
});

// MAX-WAIT-REASON-01: the Max job's latest reclaim step says what it really waits for. Running work is "window_drain"; with nothing running and
// the computer short on free memory it is "window_wait" (it used to stay "window_drain", so the status claimed running jobs that did not exist).
test("a Max job with nothing running and too little free memory reports window_wait, not window_drain", async () => {
  let free = 30 * GB;
  __setGovernorTuningForTestsOnly({ freeMemoryBytes: free });
  const max = await admit({ id: "max-job", kind: "generator", class: "burst", role: "video", requestedBytes: 50 * GB, tier: "max" });
  expect(max).toMatchObject({ queued: true });
  expect(getReclaimSteps("max-job").map((step) => step.step)).toEqual(["window_drain"]);
  stops.push(startGovernor({ pid: 1, pollMs: 1, freeMemory: () => free, totalMemory: () => 128 * GB }));
  await Bun.sleep(30);
  expect(getReclaimSteps("max-job").at(-1)?.step).toBe("window_wait");
  free = 110 * GB;
  await Bun.sleep(40);
  expect(getMaxWindow().state).toBe("open");
  release(await queued(max).admitted as GovernorHandle);
});

test("a Max job behind running work keeps window_drain", async () => {
  const running = await admit({ id: "pic-run", kind: "generator", class: "burst", role: "image", requestedBytes: 10 * GB }) as GovernorHandle;
  await admit({ id: "max-job", kind: "generator", class: "burst", role: "video", requestedBytes: 40 * GB, tier: "max" });
  stops.push(startGovernor({ pid: 1, pollMs: 1, freeMemory: () => 100 * GB, totalMemory: () => 128 * GB }));
  await Bun.sleep(30);
  expect(getReclaimSteps("max-job").map((step) => step.step)).toEqual(["window_drain"]);
  release(running);
});

// CENTRAL-QUEUE S1/S2 (appended): the "can it ever fit" arithmetic reads the live ledger, counts each saving once, and a draining job that can never pass ends.
const loadChat = async (bytes: number): Promise<GovernorHandle> => {
  const chat = await admit({ id: "chat", role: "chat", kind: "resident", requestedBytes: bytes }) as GovernorHandle;
  refreshMeasuredPeak(chat, bytes);
  return chat;
};
const video = (id: string, extra: Record<string, unknown> = {}) => ({ id, role: "video", kind: "generator", requestedBytes: 61_500_000_000, tier: "max", ...extra }) as Parameters<typeof admit>[0];

test("Reduced is counted once, from the live ledger: chat peak minus Reduced chat, and the warm pool is not added again", async () => {
  await loadChat(39_700_000_000);
  const reduced = liveReducedFreedBytes();
  expect(reduced).toBeGreaterThanOrEqual(39_700_000_000 - 5_700_000_000);
  expect(reduced).toBeLessThan(39_700_000_000 - 5_700_000_000 + 4_000_000_000);
  const request = video("count-once");
  const withoutPool = neverFitCapacityBytes(request);
  await admit({ id: "image-pool", role: "image", kind: "jit", class: "warm", requestedBytes: 12 * GB });
  expect(neverFitCapacityBytes(request)).toBe(withoutPool);
  // The chat saving and the video window shrink are the same bytes: the cap is room plus the larger of the two, not the sum.
  const base = neverFitCapacityBytes({ ...request, tier: "standard" } as typeof request);
  const maxBase = fitsEverForTier({ ...request, caller: "dev" }).capBytes;
  expect(neverFitCapacityBytes(request) - maxBase).toBe(39_700_000_000 - 5_700_000_000);
  expect(base).toBeLessThan(maxBase);
  // An explicit reducedFreedBytes option still adds exactly that many bytes.
  const plain = fitsEverForTier({ id: "x", kind: "generator", requestedBytes: 1 * GB, tier: "max", caller: "dev" }).capBytes;
  expect(fitsEverForTier({ id: "x", kind: "generator", requestedBytes: 1 * GB, tier: "max" }, { reducedFreedBytes: 7 * GB }).capBytes - plain).toBe(7 * GB);
});

test("a Max picture-to-video job that fits only with Reduced is queued draining, not refused", async () => {
  await loadChat(39_700_000_000);
  const busy = await admit({ id: "image-running", role: "image", kind: "generator", requestedBytes: 1 * GB }) as GovernorHandle;
  const answer = await admit(video("max-live"));
  expect(answer).toMatchObject({ queued: true });
  expect(getMaxWindow()).toMatchObject({ state: "draining", ownerId: "max-live" });
  release(busy);
});

test("a dev or test job never triggers Reduced, never opens the Max window and never passes a household job", async () => {
  await loadChat(39_700_000_000);
  const changes: MaxWindowChange[] = [];
  setMaxWindowHook((change) => changes.push(change));
  __setGovernorTuningForTestsOnly({ freeMemoryBytes: 0 });
  const dev = await admit(video("dev-max", { caller: "dev" }));
  const test_ = await admit({ id: "test-image", role: "image", kind: "generator", requestedBytes: 5 * GB, caller: "test" });
  const home = await admit({ id: "home-image", role: "image", kind: "generator", requestedBytes: 5 * GB, caller: "household" });
  expect([dev, test_, home].every((answer) => "queued" in (answer as object) || "refused" in (answer as object))).toBe(true);
  expect(changes.filter((change) => change.needsReduced)).toEqual([]);
  expect(getMaxWindow().state).toBe("none");
  const order = getGovernorStatus().queue.map((entry) => [entry.id, entry.caller]);
  if (order.some(([id]) => id === "home-image")) expect(order.findIndex(([id]) => id === "home-image")).toBeLessThan(order.findIndex(([id]) => id === "test-image"));
  setMaxWindowHook(null);
});

// Round 5: a Max job that can still be helped waits; the never-fit clock runs only when nothing can help.
const wireReduced = (swap: { mode: "waiting" | "refused" | "ok"; chat?: GovernorHandle; onEnter?: () => void }) => {
  __setReducedLeaseForTests({ deps: {
    enter: async () => {
      if (swap.mode === "waiting") return { ok: false, waiting: true } as const;
      if (swap.mode === "refused") return { ok: false, reason: "Chat could not change its size just now." } as const;
      setReducedChatState("reduced"); swap.onEnter?.(); return { ok: true, swapMs: 1 } as const;
    },
    leave: async () => { setReducedChatState("off"); return { ok: true, swapMs: 1 } as const; },
  } });
  __resetMaxWindowReducedForTests({ retryMs: 5 });
  wireMaxWindowReduced();
};
const unwireReduced = () => { unwireMaxWindowReduced(); __resetMaxWindowReducedForTests(); __setReducedLeaseForTests(null); resetReducedChatForTests(); };

test("a waiting Max job behind steady household chat is not failed after 3 minutes and runs after the swap", async () => {
  const swap: { mode: "waiting" | "refused" | "ok"; onEnter?: () => void } = { mode: "waiting" };
  wireReduced(swap);
  try {
    const chat = await loadChat(39_700_000_000);
    let free = 40 * GB;
    let clock = 1_000_000;
    swap.onEnter = () => { refreshMeasuredPeak(chat, 5_700_000_000); free = 100 * GB; };
    __setGovernorTuningForTestsOnly({ freeMemoryBytes: 40 * GB });
    const answer = await admit(video("steady-chat"));
    expect(answer).toMatchObject({ queued: true });
    stops.push(startGovernor({ pid: 1, pollMs: 2, freeMemory: () => free, totalMemory: () => 128 * GB, now: () => clock }));
    for (let minute = 0; minute < 5; minute++) { clock += 60_000; await Bun.sleep(20); }
    expect(await Promise.race([queued(answer).admitted, Bun.sleep(20).then(() => "waiting")])).toBe("waiting");
    expect(getMaxWindow().state).toBe("draining");
    swap.mode = "ok";
    const handle = await Promise.race([queued(answer).admitted, Bun.sleep(1_500).then(() => "waiting")]) as GovernorHandle | string;
    expect(handle).toMatchObject({ id: "steady-chat", tier: "max" });
  } finally { unwireReduced(); }
});

test("the never-fit clock starts only when chat is Reduced or its swap failed for good, nothing is busy or pinned, and the peak still cannot pass", async () => {
  const run = async (setup: () => Promise<() => void>, expectRefused: boolean) => {
    __resetGovernorForTests(); __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 120 * GB, tier: "p128", drainNeverFitMs: 3 * 60_000 });
    const cleanup = await setup();
    let clock = 5_000_000;
    __setGovernorTuningForTestsOnly({ freeMemoryBytes: 60 * GB });
    const answer = await admit(video("never"));
    expect(answer).toMatchObject({ queued: true });
    stops.push(startGovernor({ pid: 1, pollMs: 2, freeMemory: () => 60 * GB, totalMemory: () => 128 * GB, now: () => clock, busy: (id) => busyIds.has(id) }));
    for (let minute = 0; minute < 5; minute++) { clock += 60_000; await Bun.sleep(20); }
    const result = await Promise.race([queued(answer).admitted, Bun.sleep(20).then(() => "waiting")]);
    cleanup();
    for (const stop of stops.splice(0)) stop();
    if (expectRefused) expect(result).toMatchObject({ refused: true, reason: NEVER_FITS_MESSAGE }); else expect(result).toBe("waiting");
  };
  const busyIds = new Set<string>();
  // Chat still Standard and the swap is only waiting: wait.
  await run(async () => { await loadChat(39_700_000_000); wireReduced({ mode: "waiting" }); return unwireReduced; }, false);
  // A busy chat turn holds memory: wait even though chat is Reduced size.
  await run(async () => { await loadChat(5_700_000_000); busyIds.add("chat"); return () => busyIds.clear(); }, false);
  // A pinned jit item holds memory: wait.
  await run(async () => { await loadChat(5_700_000_000); await admit({ id: "look", role: "vision", kind: "jit", class: "warm", pinned: true, requestedBytes: 6 * GB } as Parameters<typeof admit>[0]); return () => {}; }, false);
  // Swap refused for good: the clock runs and the job fails.
  await run(async () => { await loadChat(39_700_000_000); wireReduced({ mode: "refused" }); return unwireReduced; }, true);
  // Chat already Reduced, nothing busy or pinned: the clock runs and the job fails.
  await run(async () => { await loadChat(5_700_000_000); return () => {}; }, true);
  expect(NEVER_FITS_MESSAGE).not.toMatch(/\d/);
  expect(getMaxWindow().state).toBe("none");
});

test("Reduced is restored after a Max job ends: the window close sends chat back to its full model", async () => {
  const calls: string[] = [];
  __setReducedLeaseForTests({ deps: {
    enter: async () => { calls.push("enter"); setReducedChatState("reduced"); return { ok: true, swapMs: 1 }; },
    leave: async () => { calls.push("leave"); setReducedChatState("off"); return { ok: true, swapMs: 1 }; },
  } });
  __resetMaxWindowReducedForTests();
  wireMaxWindowReduced();
  try {
    await loadChat(39_700_000_000);
    __setGovernorTuningForTestsOnly({ freeMemoryBytes: 5 * GB });
    const answer = await admit(video("restore-max"));
    expect(answer).toMatchObject({ queued: true });
    stops.push(startGovernor({ pid: 1, pollMs: 5, freeMemory: () => 5 * GB, totalMemory: () => 128 * GB }));
    await Bun.sleep(100);
    await maxWindowReducedIdle();
    expect(calls).toContain("enter");
    // The owner ends (withdrawn): the window closes and chat leaves Reduced.
    const { withdraw } = await import("@/lib/governor");
    withdraw("restore-max");
    expect(getMaxWindow().state).toBe("none");
    await maxWindowReducedIdle();
    expect(calls.at(-1)).toBe("leave");
  } finally {
    unwireMaxWindowReduced(); __resetMaxWindowReducedForTests(); __setReducedLeaseForTests(null); resetReducedChatForTests();
  }
});
