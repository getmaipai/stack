// TIER-ROUTES-01: a Max video job goes through the real HTTP route, the real job queue and the real governor (only the video worker is
// scripted, and the chat swap behind Reduced is a recorder, because there is no chat engine here). It proves the tier reaches the governor,
// the Max window opens, the job record shows the tier, and the Stack itself enters Reduced chat when the window opens and leaves when it closes.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "@/app";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, getGovernorStatus, getMaxWindow } from "@/lib/governor";
import { __resetJobsForTests, getJob } from "@/lib/jobs";
import { dataDir } from "@/lib/paths";
import { __resetMaxWindowReducedForTests, maxWindowReducedIdle, unwireMaxWindowReduced, wireMaxWindowReduced } from "@/lib/maxWindowReduced";
import { resetReducedChatForTests, setReducedChatState } from "@/lib/reducedChat";
import { __setReducedLeaseForTests } from "@/lib/reducedChatLease";
import { __resetProvenanceForTests } from "@/video/provenance";
import { registerVideoJobs } from "@/video/jobs";
import { videoGen, type VideoGenDeps, type WorkerHandle, type WorkerReply, type WorkerRequest } from "@/video/videoGen";

const GB = 1_073_741_824;
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
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 72 * GB, freeMemoryBytes: 70 * GB, tier: "p128" });
  registerVideoJobs();
  __resetMaxWindowReducedForTests({ retryMs: 20, renewMs: 60_000 });
  __setReducedLeaseForTests({ deps: {
    enter: async () => { calls.push("enter"); if (chatBusyReplies > 0) { chatBusyReplies -= 1; return { ok: false, waiting: true }; } setReducedChatState("reduced"); return { ok: true, swapMs: 5 }; },
    leave: async () => { calls.push("leave"); setReducedChatState("off"); return { ok: true, swapMs: 5 }; },
  } });
  wireMaxWindowReduced();
});
afterEach(() => { unwireMaxWindowReduced(); __resetMaxWindowReducedForTests(); __setReducedLeaseForTests(null); resetReducedChatForTests(); open(); clean(); });

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
