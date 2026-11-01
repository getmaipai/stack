// TIER-ROUTES-01: a Max video job goes through the real HTTP route, the real job queue and the real governor (only the video worker is
// scripted, and the chat swap behind Reduced is a recorder, because there is no chat engine here). It proves the tier reaches the governor,
// the Max window opens, the job record shows the tier, and the Stack itself enters Reduced chat when the window opens and leaves when it closes.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "@/app";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, admit, getGovernorStatus, getMaxWindow, getReducedNeed, reducedNeedFor, release, startGovernor, type GovernorRequest } from "@/lib/governor";
import type { MemoryReader, MemorySnapshot } from "@/lib/memory/types";
import { __resetJobsForTests, getJob } from "@/lib/jobs";
import { dataDir } from "@/lib/paths";
import { __resetMaxWindowReducedForTests, maxWindowReducedIdle, unwireMaxWindowReduced, wireMaxWindowReduced } from "@/lib/maxWindowReduced";
import { resetReducedChatForTests, setReducedChatState } from "@/lib/reducedChat";
import { __setReducedLeaseForTests } from "@/lib/reducedChatLease";
import { __resetProvenanceForTests } from "@/video/provenance";
import { registerVideoJobs } from "@/video/jobs";
import { videoGen, type VideoGenDeps, type WorkerHandle, type WorkerReply, type WorkerRequest } from "@/video/videoGen";

const GB = 1_073_741_824;
// MAX-LIVE-01: the governor reads a fake memory sampler (the real governor, queue and route are in use). `free` is what the kernel reports as available.
const sampler = { total: 72 * GB, free: 70 * GB, fail: false };
const fakeReader: MemoryReader = {
  read: (): MemorySnapshot => sampler.fail ? { totalBytes: sampler.total, availablePercent: 0, pressure: "normal", freeBytes: sampler.free, degraded: true, probeError: "the sampler is down" } : { totalBytes: sampler.total, availablePercent: (sampler.free / sampler.total) * 100, pressure: "normal", freeBytes: sampler.free, degraded: false },
  processMemoryBytes: () => null,
};
let stopGovernor: (() => void) | null = null;
let calls: string[]; let gate: Promise<void>; let open: () => void; let chatBusyReplies: number;
const okReply = (request: WorkerRequest): WorkerReply => ({ id: request.id, ok: true, width: request.width, height: request.height, frames: request.num_frames, fps: 24, seed: request.seed, ms: 10, peak_bytes: 44_000_000_000 });
const deps = (): VideoGenDeps => ({
  supported: () => true, ensureEnvironment: async () => {}, paths: () => ({ modelDir: "/models/video", tokenizerDir: "/models/tok" }),
  spawn: async (): Promise<WorkerHandle> => {
    let end!: (code: number) => void; const exited = new Promise<number>((done) => { end = done; });
    return { exited, kill: () => end(143), send: async (request) => { await gate; writeFileSync(request.output, "MP4"); writeFileSync(request.poster, "JPG"); return okReply(request); } };
  },
});
const clean = () => { videoGen.useDeps(null); __resetJobsForTests(); __resetGovernorForTests(); __resetProvenanceForTests(); rmSync(join(dataDir, "video"), { recursive: true, force: true }); rmSync(join(dataDir, "tmp", "video"), { recursive: true, force: true }); };
beforeEach(() => {
  calls = []; chatBusyReplies = 0; gate = new Promise((resolve) => { open = resolve; });
  clean(); resetReducedChatForTests();
  // 72 GB machine with 70 GB free, about 60 GB tier room: Standard holds 36 GB, a video clip needs 41 GB, so only Max (60 GB) can run it and it needs more than the Standard share.
  // Other programs hold 45 GB, so 25 GB is available: the clip (41 GB plus the 20 GB working margin) does not fit until chat gives its memory back.
  sampler.total = 72 * GB; sampler.free = 25 * GB; sampler.fail = false;
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 72 * GB, freeMemoryBytes: 25 * GB, tier: "p128" });
  stopGovernor = startGovernor({ pid: 987_654, pollMs: 20, tier: "p128", memoryReader: fakeReader });
  registerVideoJobs();
  __resetMaxWindowReducedForTests({ retryMs: 20, renewMs: 60_000 });
  __setReducedLeaseForTests({ deps: {
    enter: async () => { calls.push("enter"); if (chatBusyReplies > 0) { chatBusyReplies -= 1; return { ok: false, waiting: true }; } setReducedChatState("reduced"); sampler.free = 70 * GB; /* chat's memory is really given back */ return { ok: true, swapMs: 5 }; },
    leave: async () => { calls.push("leave"); setReducedChatState("off"); sampler.free = 25 * GB; return { ok: true, swapMs: 5 }; },
  } });
  wireMaxWindowReduced();
});
afterEach(() => { stopGovernor?.(); stopGovernor = null; unwireMaxWindowReduced(); __resetMaxWindowReducedForTests(); __setReducedLeaseForTests(null); resetReducedChatForTests(); open(); clean(); });

const post = (body: Record<string, unknown>) => app.request("/v1/videos/generations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10)); expect(check()).toBe(true); };

test("a Max video job opens the governor's window, shows its tier, and the Stack enters Reduced chat and leaves it when the window closes", async () => {
  videoGen.useDeps(deps());
  const response = await post({ prompt: "a paper boat", tier: "max", timeout_ms: 50 });
  expect(response.status).toBe(202);
  const { job } = await response.json() as { job: string };
  await until(() => getMaxWindow().state === "open");
  expect(getMaxWindow().ownerId).toBe("video-worker"); // the video job runs in the warm worker slot
  expect(getGovernorStatus().loaded.some((item) => item.tier === "max")).toBe(true);
  await until(() => calls.includes("enter"));
  await maxWindowReducedIdle();
  expect((await (await app.request("/stack/v1/memory")).json() as { reduced_chat: boolean }).reduced_chat).toBe(true);
  expect((getJob(job)!.input as { tier?: string }).tier).toBe("max");
  expect((await (await app.request(`/v1/videos/generations/${job}`)).json() as { tier: string }).tier).toBe("max");
  expect(((await (await app.request(`/stack/v1/jobs/${job}`)).json()) as { job: { input: { tier: string } } }).job.input.tier).toBe("max");
  open();
  await until(() => getJob(job)?.state === "done");
  await until(() => getMaxWindow().state === "none");
  await until(() => calls.includes("leave"));
  await maxWindowReducedIdle();
  expect(calls).toEqual(["enter", "leave"]);
  expect((await (await app.request("/stack/v1/memory")).json() as { reduced_chat: boolean }).reduced_chat).toBe(false);
});

test("a chat turn in flight makes the Stack wait and try again, then Reduced is entered once", async () => {
  chatBusyReplies = 2;
  videoGen.useDeps(deps());
  const { job } = await (await post({ prompt: "a paper boat", tier: "max", timeout_ms: 50 })).json() as { job: string };
  await until(() => calls.filter((call) => call === "enter").length === 3);
  await maxWindowReducedIdle();
  expect((await (await app.request("/stack/v1/memory")).json() as { reduced_chat: boolean }).reduced_chat).toBe(true);
  open();
  await until(() => getJob(job)?.state === "done");
  await until(() => calls.includes("leave"));
});

test("a Standard or unnamed video job never opens the window and never touches chat", async () => {
  sampler.total = 128 * GB; sampler.free = 90 * GB;
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 90 * GB, tier: "p128" });
  videoGen.useDeps(deps());
  const { job } = await (await post({ prompt: "a paper boat", timeout_ms: 50 })).json() as { job: string };
  const named = await (await post({ prompt: "a second boat", tier: "standard", timeout_ms: 50 })).json() as { job: string };
  open();
  await until(() => getJob(job)?.state === "done" && getJob(named.job)?.state === "done");
  expect(getMaxWindow().state).toBe("none");
  expect(calls).toEqual([]);
  expect((await post({ prompt: "x", tier: "turbo" })).status).toBe(400);
});

test("MAX-LIVE-01: the same Max job on an idle machine fits the real memory, so chat is never reduced even though the job is above the Standard share", async () => {
  sampler.free = 70 * GB; __setGovernorTuningForTestsOnly({ freeMemoryBytes: 70 * GB });
  videoGen.useDeps(deps());
  const { job } = await (await post({ prompt: "a paper boat", tier: "max", timeout_ms: 50 })).json() as { job: string };
  await until(() => getMaxWindow().state === "open");
  await new Promise((r) => setTimeout(r, 100)); // longer than several polls
  expect(calls).toEqual([]);
  expect(getReducedNeed().tripped).toBe(false);
  open();
  await until(() => getJob(job)?.state === "done");
  await until(() => getMaxWindow().state === "none");
  expect(calls).toEqual([]);
});

const maxRequest = (id: string, peak: number): GovernorRequest => ({ id, role: "video", class: "burst", kind: "generator", tier: "max", requestedBytes: peak, measuredPeakBytes: peak, engine: "mlx" } as GovernorRequest);

test("MAX-LIVE-01: a shortfall must be seen on two looks, and a reading that hovers at the edge does not clear it", async () => {
  stopGovernor?.(); stopGovernor = null; // looks are driven by hand here: the queue-time look is the first, each admit of the queued owner is not a look
  const need = 41 * GB; // margin 20 GB: room is free - 20 GB
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 72 * GB, freeMemoryBytes: 25 * GB, tier: "p128" });
  const request = maxRequest("video-worker", need);
  expect(reducedNeedFor(request)).toMatchObject({ basis: "live", needed: true });
  expect(reducedNeedFor(request).shortfallBytes).toBeGreaterThan(30 * GB);
  const answer = await admit(request); // look 1: short
  expect("queued" in answer).toBe(true);
  expect(getReducedNeed()).toMatchObject({ ownerId: "video-worker", looks: 1, tripped: false });
  // Free memory recovers to just above the need (inside the 1 GB band): the count is kept.
  __setGovernorTuningForTestsOnly({ freeMemoryBytes: 20 * GB + need + GB / 2 });
  expect(reducedNeedFor(request).needed).toBe(false);
  expect(getReducedNeed().looks).toBe(1);
});

test("MAX-LIVE-01: idle models that were measured count as room to give back; a ledger guess does not", async () => {
  stopGovernor?.(); stopGovernor = null;
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 45 * GB, tier: "p128" });
  const idle = await admit({ id: "image-pool", role: "image", class: "warm", kind: "jit", requestedBytes: 18 * GB, measuredPeakBytes: null, engine: "mlx" } as GovernorRequest);
  expect("queued" in idle || "refused" in idle).toBe(false);
  const request = maxRequest("video-worker", 41 * GB);
  expect(reducedNeedFor(request)).toMatchObject({ needed: true, giveBackBytes: 0 }); // 45 - 20 margin = 25 GB room; the unmeasured pool is not counted
  __setGovernorTuningForTestsOnly({ freeMemoryBytes: 45 * GB });
  if (!("queued" in idle) && !("refused" in idle)) { release({ ...idle, retainWarm: false }); }
});

test("MAX-LIVE-01: when the memory sampler fails the static Standard share decides (fallback), and a live reading takes over again", async () => {
  const request = maxRequest("video-worker", 41 * GB); // above the Standard share (60 percent of the tier room)
  await new Promise((r) => setTimeout(r, 60));
  expect(reducedNeedFor(request).basis).toBe("live");
  sampler.fail = true;
  await new Promise((r) => setTimeout(r, 80));
  const fallback = reducedNeedFor(request);
  expect(fallback.basis).toBe("static");
  expect(fallback.needed).toBe(true);
  expect(reducedNeedFor(maxRequest("small", 10 * GB))).toMatchObject({ basis: "static", needed: false });
  sampler.fail = false; sampler.free = 70 * GB;
  await new Promise((r) => setTimeout(r, 80));
  expect(reducedNeedFor(request)).toMatchObject({ basis: "live", needed: false });
});
