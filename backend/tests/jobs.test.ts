import { beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetEventsForTests, eventsAfter } from "@/lib/events";
import { __resetJobsForTests, cancelJob, createJob, finishJob, getJob, jobSignal, registerJobRunner, submitJob, updateJob } from "@/lib/jobs";

beforeEach(() => { __resetJobsForTests(); __resetEventsForTests(); });

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

test("cancelling a download job aborts the signal the download was given", () => {
  const job = createJob({ kind: "engine.install", totalBytes: 10 });
  const signal = jobSignal(job.id)!;
  expect(signal.aborted).toBe(false);
  cancelJob(job.id);
  expect(signal.aborted).toBe(true);
  expect(finishJob(job.id, { ok: true })).toBeNull();
  expect(getJob(job.id)?.state).toBe("cancelled");
});
