// MEDIA-STACK-01: the idle lane's rules, FileTube's heavyGate ported as tests.
// One job at a time, first in first out; a cap on the waiting queue; a
// cancelled queued job leaves; a cancelled running job frees the lane at once
// whatever its runner does with the abort; a crashed, rejected or hung runner
// never holds the lane; a failure can carry a structured result.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { __resetJobsForTests, cancelJob, getJob, JobFailure, laneStatus, registerJobRunner, submitJob, waitForJob, type Job } from "@/lib/jobs";

beforeEach(() => { __resetJobsForTests(); });
afterEach(() => { __resetJobsForTests(); });

const submit = (kind: string, input: Record<string, unknown> = {}): Job => { const result = submitJob({ kind, input }); if ("refused" in result) throw new Error(result.reason); return result.job; };
const gate = (): { promise: Promise<void>; open: () => void } => { let open = () => {}; const promise = new Promise<void>((resolve) => { open = resolve; }); return { promise, open }; };

test("jobs run one at a time in submission order", async () => {
  const order: string[] = []; let running = 0; let peak = 0;
  registerJobRunner("t.fifo", async (job) => { running += 1; peak = Math.max(peak, running); order.push(String(job.input?.n)); await Bun.sleep(5); running -= 1; return { n: job.input?.n }; }, { lane: { name: "t", cap: 10 } });
  const jobs = [1, 2, 3, 4].map((n) => submit("t.fifo", { n }));
  // The first starts at once (no position); the others wait with positions 1, 2, 3.
  expect(jobs.map((job) => job.position)).toEqual([null, 1, 2, 3]);
  for (const job of jobs) await waitForJob(job.id, 2000);
  expect(order).toEqual(["1", "2", "3", "4"]);
  expect(peak).toBe(1);
  expect(jobs.map((job) => getJob(job.id)?.state)).toEqual(["done", "done", "done", "done"]);
});

test("the waiting queue has a cap, and a refusal says so and leaves the queue alone", async () => {
  const hold = gate();
  registerJobRunner("t.cap", async () => { await hold.promise; return {}; }, { lane: { name: "t", cap: 2 } });
  submit("t.cap"); // running
  submit("t.cap"); submit("t.cap"); // two waiting = cap
  const refused = submitJob({ kind: "t.cap" });
  expect("refused" in refused && refused.code).toBe("queue_full");
  expect("refused" in refused && refused.reason).toContain("full");
  expect(laneStatus("t")).toEqual({ queued: 2, running: expect.any(String) });
  hold.open();
});

test("a cancelled queued job leaves the queue, the others move up, and it never runs", async () => {
  const hold = gate(); const ran: string[] = [];
  registerJobRunner("t.cq", async (job) => { ran.push(String(job.input?.n)); await hold.promise; return {}; }, { lane: { name: "t", cap: 10 } });
  const first = submit("t.cq", { n: 1 }); const second = submit("t.cq", { n: 2 }); const third = submit("t.cq", { n: 3 });
  expect(cancelJob(second.id)?.state).toBe("cancelled");
  expect(getJob(third.id)?.position).toBe(1);
  hold.open();
  await waitForJob(first.id, 2000); await waitForJob(third.id, 2000);
  expect(ran).toEqual(["1", "3"]);
  expect(getJob(second.id)?.state).toBe("cancelled");
});

test("a cancelled running job frees the lane at once, even when its runner ignores the abort", async () => {
  const forever = gate(); const started: string[] = [];
  registerJobRunner("t.stubborn", async (job) => { started.push(String(job.input?.n)); if (job.input?.n === 1) await forever.promise; return { n: job.input?.n }; }, { lane: { name: "t", cap: 10 } });
  const stuck = submit("t.stubborn", { n: 1 }); const next = submit("t.stubborn", { n: 2 });
  await Bun.sleep(5);
  expect(getJob(stuck.id)?.state).toBe("running");
  expect(getJob(next.id)?.state).toBe("queued");
  cancelJob(stuck.id);
  const done = await waitForJob(next.id, 2000);
  expect(done?.state).toBe("done");
  expect(started).toEqual(["1", "2"]);
  // The stuck runner finishing much later changes nothing about its cancelled job.
  forever.open(); await Bun.sleep(10);
  expect(getJob(stuck.id)?.state).toBe("cancelled");
});

test("a cancelled running job's runner sees the abort signal", async () => {
  let aborted = false;
  registerJobRunner("t.signal", (_job, signal) => new Promise((_, reject) => { signal.addEventListener("abort", () => { aborted = true; reject(new Error("stopped")); }); }), { lane: { name: "t", cap: 10 } });
  const job = submit("t.signal");
  await Bun.sleep(5);
  cancelJob(job.id);
  await Bun.sleep(5);
  expect(aborted).toBe(true);
  expect(getJob(job.id)?.state).toBe("cancelled");
});

test("a runner that throws, rejects or throws before its first await does not block the next job", async () => {
  registerJobRunner("t.crash", (job) => {
    if (job.input?.how === "sync") throw new Error("sync boom");
    if (job.input?.how === "reject") return Promise.reject(new Error("async boom"));
    return Promise.resolve({ ok: true });
  }, { lane: { name: "t", cap: 10 } });
  const a = submit("t.crash", { how: "sync" }); const b = submit("t.crash", { how: "reject" }); const c = submit("t.crash", { how: "fine" });
  await waitForJob(c.id, 2000);
  expect(getJob(a.id)).toMatchObject({ state: "failed", reason: "sync boom" });
  expect(getJob(b.id)).toMatchObject({ state: "failed", reason: "async boom" });
  expect(getJob(c.id)?.state).toBe("done");
  expect(laneStatus("t")).toEqual({ queued: 0, running: null });
});

test("a runner that never settles is stopped by its deadline and the lane moves on", async () => {
  let signalled = false;
  registerJobRunner("t.hang", async (job, signal) => { if (job.input?.hang) { signal.addEventListener("abort", () => { signalled = true; }); await new Promise(() => {}); } return { ok: true }; }, { lane: { name: "t", cap: 10, deadlineMs: () => 40 } });
  const hung = submit("t.hang", { hang: true }); const after = submit("t.hang");
  const finished = await waitForJob(after.id, 2000);
  expect(finished?.state).toBe("done");
  expect(getJob(hung.id)).toMatchObject({ state: "failed" });
  expect(getJob(hung.id)?.reason).toContain("took longer");
  expect(signalled).toBe(true);
});

test("a failure keeps the structured result its runner attached", async () => {
  registerJobRunner("t.fail", async () => { throw new JobFailure("The site said no.", { failure: { code: "rate_limited" } }); }, { lane: { name: "t", cap: 10 } });
  const job = submit("t.fail");
  const done = await waitForJob(job.id, 2000);
  expect(done).toMatchObject({ state: "failed", reason: "The site said no.", result: { failure: { code: "rate_limited" } } });
});

test("a precheck refusal never reaches the queue and carries its code and status", () => {
  registerJobRunner("t.pre", async () => ({}), { lane: { name: "t", cap: 10, precheck: (input) => input.bad ? { reason: "Nope.", code: "bad_input", status: 422 } : null } });
  const refused = submitJob({ kind: "t.pre", input: { bad: true } });
  expect(refused).toMatchObject({ refused: true, code: "bad_input", status: 422, reason: "Nope." });
  expect(laneStatus("t").queued).toBe(0);
});

test("two lanes do not block each other", async () => {
  const hold = gate();
  registerJobRunner("t.a", async () => { await hold.promise; return {}; }, { lane: { name: "a", cap: 5 } });
  registerJobRunner("t.b", async () => ({ b: true }), { lane: { name: "b", cap: 5 } });
  submit("t.a");
  const b = submit("t.b");
  expect((await waitForJob(b.id, 2000))?.state).toBe("done");
  hold.open();
});
