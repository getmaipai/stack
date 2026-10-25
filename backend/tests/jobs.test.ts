import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetEventsForTests, eventsAfter } from "@/lib/events";
import { __resetJobsForTests, __setAdmissionWaitForTests, __setJobQueueTimingForTests, cancelJob, createJob, finishJob, getJob, jobSignal, registerJobRunner, submitJob, updateJob, waitForJob } from "@/lib/jobs";
import { heavyGate } from "@/lib/heavyGate";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, admit, release, type GovernorHandle } from "@/lib/governor";
import { __resetMemoryStateForTests, memoryLevel, setMemoryLevel } from "@/lib/memoryState";

const GB = 1_073_741_824;

beforeEach(() => { __resetJobsForTests(); __resetEventsForTests(); __resetGovernorForTests(); __setGovernorTuningForTestsOnly({ totalMemoryBytes: 64 * GB, freeMemoryBytes: 32 * GB, tier: "p64" }); __resetMemoryStateForTests(); heavyGate.reset(); });
afterEach(() => { __setJobQueueTimingForTests(null); __setAdmissionWaitForTests(null); heavyGate.reset(); });

test("a queued generator waits for interactive work and its four second tail", async () => {
  let now = 0;
  const sleepers: Array<() => void> = [];
  __setJobQueueTimingForTests({ now: () => now, sleep: (ms) => new Promise((resolve) => sleepers.push(() => { now += ms; resolve(); })) });
  let started = false;
  registerJobRunner("image", async () => { started = true; return {}; }, { generator: { role: "image", memory: () => ({ requestedBytes: 1 }) } });
  const end = heavyGate.begin("chat");
  const submitted = submitJob({ kind: "image", role: "image" });
  if ("refused" in submitted) throw new Error(submitted.reason);
  await Promise.resolve();
  expect(getJob(submitted.job.id)?.state).toBe("queued");
  end();
  const advance = async (ms: number) => {
    while (now < ms) {
      await Promise.resolve();
      const next = sleepers.shift();
      if (!next) return;
      next();
      await Promise.resolve(); await Promise.resolve();
    }
  };
  await advance(3999);
  expect(started).toBe(false);
  expect(getJob(submitted.job.id)?.state).toBe("queued");
  await advance(4100);
  await waitForJob(submitted.job.id, 200);
  expect(started).toBe(true);
  expect(getJob(submitted.job.id)?.state).toBe("done");
});

test("a queued generator stays queued at WARN and starts when memory returns to normal", async () => {
  let now = 0;
  const sleepers: Array<() => void> = [];
  __setJobQueueTimingForTests({ now: () => now, sleep: (ms) => new Promise((resolve) => sleepers.push(() => { now += ms; resolve(); })) });
  let started = false;
  registerJobRunner("image", async () => { started = true; return {}; }, { generator: { role: "image", memory: () => ({ requestedBytes: 1 }) } });
  setMemoryLevel("warn");
  const submitted = submitJob({ kind: "image", role: "image" });
  if ("refused" in submitted) throw new Error(submitted.reason);
  await Promise.resolve();
  expect(getJob(submitted.job.id)?.state).toBe("queued");
  expect(started).toBe(false);
  setMemoryLevel("normal");
  for (let i = 0; i < 161 && !started; i += 1) {
    await Promise.resolve();
    sleepers.shift()?.();
    await Promise.resolve(); await Promise.resolve();
  }
  await waitForJob(submitted.job.id, 200);
  expect(getJob(submitted.job.id)?.state).toBe("done");
  expect(started).toBe(true);
});

test("a fitting job stays queued past the configured admission wait and runs when memory frees", async () => {
  __setAdmissionWaitForTests(20);
  const holder = await admit({ id: "other-work", kind: "generator", class: "burst", requestedBytes: GB }) as GovernorHandle;
  let ran = false;
  registerJobRunner("waiting-picture", async () => { ran = true; return {}; }, { generator: { role: "image", memory: () => ({ requestedBytes: GB }) } });
  const submitted = submitJob({ kind: "waiting-picture" });
  if ("refused" in submitted) throw new Error(submitted.reason);
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(getJob(submitted.job.id)).toMatchObject({ state: "running", status: expect.stringContaining("waiting for memory") });
  expect(getJob(submitted.job.id)?.status).not.toBe("no_memory");
  release(holder);
  for (let index = 0; index < 20 && !ran; index++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(ran).toBe(true);
  expect(getJob(submitted.job.id)).toMatchObject({ state: "done" });
});

test("a kind with no runner is refused with a reason, not left queued", async () => {
  const result = submitJob({ kind: "image", role: "image" });
  expect(result).toMatchObject({ refused: true, reason: expect.stringContaining("image") });
  const response = await app.request("/stack/v1/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "image" }) });
  expect(response.status).toBe(503);
});

test("a registered runner reports progress on the feed and its result is fetched by id", async () => {
  registerJobRunner("image", async (_job, _signal, progress) => { progress({ percent: 50, status: "drawing" }); return { url: "file:///out.png" }; });
  const result = submitJob({ kind: "image", role: "image", input: { prompt: "a cat" } });
  if ("refused" in result) throw new Error("expected a job");
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(getJob(result.job.id)).toMatchObject({ state: "done", percent: 100, result: { url: "file:///out.png" } });
  const ids = eventsAfter(0).map((event) => event.id);
  expect(ids).toContain("job.progress");
  expect(ids).toContain("job.done");
  const response = await app.request(`/stack/v1/jobs/${result.job.id}`);
  expect((await response.json() as { job: { state: string } }).job.state).toBe("done");
});

test("cancel aborts a running job and a cancelled job stays cancelled", async () => {
  registerJobRunner("video", (_job, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))));
  const result = submitJob({ kind: "video" });
  if ("refused" in result) throw new Error("expected a job");
  expect(cancelJob(result.job.id)?.state).toBe("cancelled");
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(getJob(result.job.id)?.state).toBe("cancelled");
});

test("a download job created by another module reports bytes and finishes", () => {
  const job = createJob({ kind: "model.install", totalBytes: 100, status: "downloading" });
  updateJob(job.id, { completedBytes: 50 });
  expect(getJob(job.id)?.percent).toBe(50);
  finishJob(job.id, { ok: false, reason: "checksum mismatch" });
  expect(getJob(job.id)).toMatchObject({ state: "failed", reason: "checksum mismatch" });
});

test("download speed, files and stalled state are on the jobs API and feed; stalled jobs resume and can be cancelled", async () => {
  const job = createJob({ kind: "model.install", totalBytes: 100, status: "downloading", items: [{ id: "weights", label: "model.gguf", completedBytes: 0, totalBytes: 100, state: "queued" }] });
  const stalled = updateJob(job.id, { completedBytes: 50, bytesPerSecond: 10_000, items: [{ id: "weights", label: "model.gguf", completedBytes: 50, totalBytes: 100, state: "stalled" }], state: "stalled", status: "connection interrupted" });
  expect(stalled).toMatchObject({ state: "stalled", bytesPerSecond: 10_000, items: [{ state: "stalled", completedBytes: 50 }] });
  const api = await app.request(`/stack/v1/jobs/${job.id}`);
  expect((await api.json() as { job: unknown }).job).toMatchObject({ state: "stalled", bytesPerSecond: 10_000, items: [{ id: "weights" }] });
  const progress = eventsAfter(0).find((event) => event.id === "job.progress" && (event.data as { state: string }).state === "stalled");
  expect(progress?.data).toMatchObject({ bytesPerSecond: 10_000, items: [{ state: "stalled", completedBytes: 50 }] });
  expect(updateJob(job.id, { completedBytes: 60, state: "running", status: "downloading" })?.state).toBe("running");
  expect(cancelJob(job.id)?.state).toBe("cancelled");
});

test("cancelling a download job aborts the signal the download was given", () => {
  const job = createJob({ kind: "engine.install", totalBytes: 10 });
  const signal = jobSignal(job.id)!;
  expect(signal.aborted).toBe(false);
  cancelJob(job.id);
  expect(signal.aborted).toBe(true);
  expect(finishJob(job.id, { ok: true })).toBeNull();
  expect(getJob(job.id)?.state).toBe("cancelled");
});
