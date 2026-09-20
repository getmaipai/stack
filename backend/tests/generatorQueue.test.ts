// STACK-13a: generator jobs through the queue and the governor, driven
// by a scripted sidecar. One render in flight per role; a second one
// queues with its position; the governor's own queue is waited on and
// its refusal fails the job with the reason; cancel works while queued
// and while running, and releases the admission; the images route is
// the job API with a wait and answers in OpenAI's shape.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { eventsAfter } from "@/lib/events";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, admit, getGovernorStatus, release, startGovernor, type GovernorHandle } from "@/lib/governor";
import { scriptedMemoryReader } from "@/lib/memory/scripted";
import type { MemorySnapshot } from "@/lib/memory/types";
import { __resetHealthForTests } from "@/lib/health";
import { __resetJobsForTests, cancelJob, getJob, registerJobRunner, submitJob, waitForJob, type Job } from "@/lib/jobs";
import { clearModelsForTests, upsertModel } from "@/lib/modelStore";
import { resetSupervisorForTests, scriptedProcess, setSupervisorFactoryForTests } from "@/lib/supervisor";

const GB = 1_073_741_824;
const stops: Array<() => void> = [];
beforeEach(() => { __resetHealthForTests(); __resetJobsForTests(); __resetGovernorForTests(); __setGovernorTuningForTestsOnly({ totalMemoryBytes: 32 * GB, freeMemoryBytes: 24 * GB, tier: "p32" }); clearModelsForTests(); });
afterEach(async () => { for (const stop of stops.splice(0)) stop(); await Bun.sleep(5); __resetJobsForTests(); __resetGovernorForTests(); clearModelsForTests(); setSupervisorFactoryForTests(null); resetSupervisorForTests(); });

/** An image model on the store and a scripted engine, so the images
 * route sees a bound role with an engine and reaches the queue. */
function imageRoleBound(): void {
  upsertModel({ id: "image-test", roles: ["image"], source: "catalog", provenance: {}, revision: "r", sha256: "d".repeat(64), licence: "CreativeML-OpenRAIL-M", verifiedAt: new Date().toISOString(), modelPath: "/tmp/never/image.safetensors" });
  setSupervisorFactoryForTests(async (role) => scriptedProcess(role));
}

/** The scripted sidecar: renders in four steps of `stepMs`, honours the
 * abort signal, returns one image. */
function scriptedSidecar(options: { stepMs?: number; requestedBytes?: number } = {}): { started: string[]; finished: string[] } {
  const started: string[] = [];
  const finished: string[] = [];
  registerJobRunner("image", async (job, signal, progress) => {
    started.push(job.id);
    for (let step = 1; step <= 4; step += 1) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, options.stepMs ?? 10);
        signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
      });
      progress({ percent: step * 25, status: `step ${step} of 4` });
    }
    finished.push(job.id);
    return { images: [{ b64_json: "iVBORw0KGgo=", revised_prompt: String(job.input?.prompt ?? "") }] };
  }, { generator: { role: "image", memory: () => ({ requestedBytes: options.requestedBytes ?? 2 * GB, engine: "comfyui" }) } });
  return { started, finished };
}

function submit(prompt: string): Job {
  const result = submitJob({ kind: "image", input: { prompt } });
  if ("refused" in result) throw new Error(result.reason);
  return result.job;
}

test("a scripted render is queued, admitted, reports progress on the feed, finishes with its image, and releases the governor", async () => {
  const sidecar = scriptedSidecar();
  const job = submit("a lighthouse");
  // Admitted at once on an idle governor: the record is already running
  // by the time submit returns; the feed still shows it queued first.
  expect(["queued", "running"]).toContain(job.state);
  const done = await waitForJob(job.id, 2_000);
  expect(done).toMatchObject({ state: "done", percent: 100, result: { images: [{ b64_json: "iVBORw0KGgo=", revised_prompt: "a lighthouse" }] } });
  expect(sidecar.finished).toEqual([job.id]);
  const statuses = eventsAfter(0).filter((event) => event.id === "job.progress" && (event.data as { job: string }).job === job.id).map((event) => (event.data as { status: string }).status);
  expect(statuses[0]).toBe("queued");
  expect(statuses).toContain("waiting for memory");
  expect(statuses).toContain("step 4 of 4");
  expect(getGovernorStatus().loaded.find((item) => item.id === job.id)).toBeUndefined();
});

test("a second render queues behind the first with its position and runs after it: one in flight per role", async () => {
  const sidecar = scriptedSidecar({ stepMs: 20 });
  const first = submit("one");
  const second = submit("two");
  const third = submit("three");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(getJob(first.id)?.state).toBe("running");
  expect(getJob(second.id)).toMatchObject({ state: "queued", position: 1 });
  expect(getJob(third.id)).toMatchObject({ state: "queued", position: 2 });
  expect(sidecar.started).toEqual([first.id]);
  await waitForJob(third.id, 3_000);
  expect(sidecar.finished).toEqual([first.id, second.id, third.id]);
  expect(getJob(second.id)?.position).toBeNull();
});

test("a render the budget can never hold is refused with the numbers, not left waiting", async () => {
  scriptedSidecar({ requestedBytes: 64 * GB });
  const job = submit("too big");
  const failed = await waitForJob(job.id, 1_000);
  expect(failed?.state).toBe("failed");
  expect(failed?.reason).toMatch(/needs about 64\.0 GB; the memory budget for models is/);
});

test("while the governor holds another generator, the job waits in the governor's queue and runs when that one releases", async () => {
  const sidecar = scriptedSidecar();
  const other = await admit({ id: "another-generator", kind: "generator", requestedBytes: 1 * GB }) as GovernorHandle;
  expect("id" in other).toBe(true);
  const job = submit("after the other");
  await new Promise((resolve) => setTimeout(resolve, 350));
  expect(getJob(job.id)).toMatchObject({ state: "running", status: "waiting for memory (1 ahead)" });
  expect(sidecar.started).toEqual([]);
  release(other);
  const done = await waitForJob(job.id, 3_000);
  expect(done?.state).toBe("done");
  expect(getGovernorStatus().loaded.length).toBe(0);
});

test("cancel removes a queued render and renumbers the rest, and aborts a running one and frees the governor for the next", async () => {
  const sidecar = scriptedSidecar({ stepMs: 30 });
  const first = submit("one");
  const second = submit("two");
  const third = submit("three");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(cancelJob(second.id)?.state).toBe("cancelled");
  expect(getJob(third.id)?.position).toBe(1);
  expect(cancelJob(first.id)?.state).toBe("cancelled");
  const done = await waitForJob(third.id, 3_000);
  expect(done?.state).toBe("done");
  expect(sidecar.finished).toEqual([third.id]);
  expect(getGovernorStatus().loaded.length).toBe(0);
  const cancelled = await (await app.request(`/stack/v1/jobs/${first.id}`)).json() as { job: Job };
  expect(cancelled.job).toMatchObject({ state: "cancelled", reason: "Cancelled by Home." });
});

test("POST /v1/images/generations waits for the render and answers in OpenAI's image shape; past its deadline it answers 202 with the job id", async () => {
  imageRoleBound();
  scriptedSidecar({ stepMs: 10 });
  const response = await app.request("/v1/images/generations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "image", prompt: "a lighthouse" }) });
  expect(response.status).toBe(200);
  const body = await response.json() as { created: number; job: string; data: Array<{ b64_json: string; revised_prompt?: string }> };
  expect(body.data).toEqual([{ b64_json: "iVBORw0KGgo=", revised_prompt: "a lighthouse" }]);
  expect(response.headers.get("x-maipai-engine")).toBe("none");
  __resetJobsForTests();
  scriptedSidecar({ stepMs: 200 });
  const slow = await app.request("/v1/images/generations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "image", prompt: "slow", timeout_ms: 50 }) });
  expect(slow.status).toBe(202);
  const pending = await slow.json() as { job: string; data: unknown[] };
  expect(pending.data).toEqual([]);
  expect(getJob(pending.job)?.state).toBe("running");
  const done = await waitForJob(pending.job, 3_000);
  expect(done?.state).toBe("done");
});

test("with no image model or no engine installed the images route is an honest 503, and a submit with no runner is refused with the reason", async () => {
  const response = await app.request("/v1/images/generations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "image", prompt: "x" }) });
  expect(response.status).toBe(503);
  __resetJobsForTests();
  const result = submitJob({ kind: "image" });
  expect(result).toMatchObject({ refused: true, reason: expect.stringContaining("No engine on this machine can run image jobs") });
});

test("the refusal mirrors the governor's own peak: a model file times the engine's multiplier, not the requested bytes", async () => {
  registerJobRunner("image", async () => ({ images: [] }), { generator: { role: "image", memory: () => ({ requestedBytes: 1 * GB, modelFileBytes: 20 * GB, engine: "comfyui" }) } });
  const job = submit("multiplied");
  const failed = await waitForJob(job.id, 1_000);
  // 20 GB times the default 1.3 is 26 GB, over the 24 GB cap of a 32 GB machine.
  expect(failed).toMatchObject({ state: "failed", reason: expect.stringContaining("needs about 26.0 GB") });
});

test("cancelling a render that waits in the governor's queue frees the role at once, and its late admission is released, not run", async () => {
  const sidecar = scriptedSidecar();
  const other = await admit({ id: "another-generator", kind: "generator", requestedBytes: 1 * GB }) as GovernorHandle;
  const waiting = submit("will be cancelled");
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(getJob(waiting.id)?.status).toMatch(/waiting for memory/);
  expect(cancelJob(waiting.id)?.state).toBe("cancelled");
  const next = submit("the next one");
  await new Promise((resolve) => setTimeout(resolve, 300));
  // The role moved on: the next job is the one now waiting, not stuck behind the cancelled one.
  expect(getJob(next.id)?.state).toBe("running");
  release(other);
  const done = await waitForJob(next.id, 4_000);
  expect(done?.state).toBe("done");
  expect(sidecar.started).toEqual([next.id]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(getGovernorStatus().loaded.length).toBe(0);
  expect(getGovernorStatus().queue.length).toBe(0);
});

test("a render queued for memory with nothing loaded runs once memory frees: the governor's own poll re-admits", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 32 * GB, freeMemoryBytes: 2 * GB, tier: "p32" });
  const sidecar = scriptedSidecar({ requestedBytes: 2 * GB });
  const warn: MemorySnapshot = { totalBytes: 32 * GB, freeBytes: 2 * GB, availablePercent: 6, pressure: "warn", degraded: false };
  const stop = startGovernor({ pid: 1, pollMs: 50, memoryReader: scriptedMemoryReader([
    warn, warn, warn, warn, warn, warn, warn, warn, warn, warn,
    { totalBytes: 32 * GB, freeBytes: 24 * GB, availablePercent: 75, pressure: "normal", degraded: false },
  ]) });
  stops.push(stop);
  await Bun.sleep(10);
  const job = submit("when memory frees");
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(getJob(job.id)).toMatchObject({ state: "running", status: "waiting for memory (1 ahead)" });
  expect(sidecar.started).toEqual([]);
  const done = await waitForJob(job.id, 4_000);
  expect(done?.state).toBe("done");
  expect(getGovernorStatus().queue.length).toBe(0);
});

test("a queued render moving up is told on the feed", async () => {
  scriptedSidecar({ stepMs: 30 });
  const first = submit("one");
  const second = submit("two");
  const third = submit("three");
  await new Promise((resolve) => setTimeout(resolve, 20));
  cancelJob(second.id);
  const positions = eventsAfter(0).filter((event) => event.id === "job.progress" && (event.data as { job: string }).job === third.id).map((event) => (event.data as { position: number | null }).position);
  expect(positions).toEqual([2, 1]);
  expect(getJob(third.id)?.position).toBe(1);
  cancelJob(first.id);
  await waitForJob(third.id, 3_000);
});

test("a cancelled render's phantom is withdrawn so the live render behind it runs when memory frees", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 32 * GB, freeMemoryBytes: 2 * GB, tier: "p32" });
  const sidecar = scriptedSidecar({ requestedBytes: 2 * GB });
  const warn: MemorySnapshot = { totalBytes: 32 * GB, freeBytes: 2 * GB, availablePercent: 6, pressure: "warn", degraded: false };
  const stop = startGovernor({ pid: 1, pollMs: 50, memoryReader: scriptedMemoryReader([
    warn, warn, warn, warn, warn, warn, warn, warn, warn, warn, warn, warn, warn, warn,
    { totalBytes: 32 * GB, freeBytes: 24 * GB, availablePercent: 75, pressure: "normal", degraded: false },
  ]) });
  stops.push(stop);
  await Bun.sleep(10);
  const cancelled = submit("cancelled while waiting");
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(getJob(cancelled.id)?.status).toMatch(/waiting for memory/);
  cancelJob(cancelled.id);
  const live = submit("the live one");
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(getJob(live.id)?.state).toBe("running");
  const done = await waitForJob(live.id, 5_000);
  expect(done?.state).toBe("done");
  expect(sidecar.started).toEqual([live.id]);
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(getGovernorStatus().loaded.length).toBe(0);
  expect(getGovernorStatus().queue.length).toBe(0);
});

test("a pause while a render waits fails it with the pause as the reason", async () => {
  const { pauseAll, resumeAll } = await import("@/lib/governor");
  scriptedSidecar();
  const other = await admit({ id: "another-generator", kind: "generator", requestedBytes: 1 * GB }) as GovernorHandle;
  const job = submit("paused away");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await pauseAll();
  const failed = await waitForJob(job.id, 2_000);
  expect(failed).toMatchObject({ state: "failed", reason: "The Stack is paused." });
  resumeAll();
  release(other);
});

test("a cancelled wait alone never raises a warning for a job nobody waits on", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 32 * GB, freeMemoryBytes: 2 * GB, tier: "p32" });
  scriptedSidecar({ requestedBytes: 2 * GB });
  const job = submit("cancelled and alone");
  await new Promise((resolve) => setTimeout(resolve, 300));
  cancelJob(job.id);
  const before = (await import("@/lib/governor")).getGovernorDecisions().length;
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect((await import("@/lib/governor")).getGovernorDecisions().length).toBe(before);
  const { list } = await import("@/lib/health");
  expect(list().find((item) => item.code === "admission-refused-repeatedly")).toBeUndefined();
});
