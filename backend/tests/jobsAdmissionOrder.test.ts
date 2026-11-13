// Round 5: the per-role admission lane. A dev or test job waiting in the governor for memory never holds the lane against a household job of the same role.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, getGovernorStatus } from "@/lib/governor";
import { __resetJobsForTests, getJob, registerJobRunner, submitJob } from "@/lib/jobs";

const GB = 1_073_741_824;
let started: string[]; let open: () => void; let gate: Promise<void>;
beforeEach(() => {
  __resetJobsForTests(); __resetGovernorForTests();
  started = []; gate = new Promise((resolve) => { open = resolve; });
  // 128 GB machine, 50 GB free and no governor poll: a 60 GB job waits for memory that never comes, a 5 GB job fits at once.
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 50 * GB, tier: "p128" });
  registerJobRunner("order-probe", async (job) => { started.push(job.id); await gate; return {}; }, { generator: { role: "video", memory: (job) => ({ requestedBytes: ((job.input as { gb: number }).gb) * GB }) } });
});
afterEach(() => { open(); __resetJobsForTests(); __resetGovernorForTests(); });
const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(10); expect(check()).toBe(true); };
const submit = (caller: "household" | "dev" | "test", gb: number) => { const result = submitJob({ caller, kind: "order-probe", input: { gb } }); if ("refused" in result) throw new Error(result.reason); return result.job.id; };

test("a dev video job waiting on memory does not block a household video job submitted after it", async () => {
  const dev = submit("dev", 60);
  await until(() => getGovernorStatus().queue.some((entry) => entry.caller === "dev"));
  const household = submit("household", 5);
  await until(() => started.includes(household));
  expect(started).toEqual([household]);
  expect(getJob(dev)).toMatchObject({ state: "queued" });
  expect(getGovernorStatus().queue.map((entry) => entry.caller)).not.toContain("household");
  // The dev job keeps its place and runs once memory is there: finish the household job and give the computer the room.
  __setGovernorTuningForTestsOnly({ freeMemoryBytes: 120 * GB });
  open();
  await until(() => getJob(household)?.state === "done");
});

test("the household job is admitted first when both wait in the lane, whichever was submitted first", async () => {
  const dev = submit("dev", 60);
  await until(() => getGovernorStatus().queue.some((entry) => entry.caller === "dev"));
  const test_ = submit("test", 60);
  const household = submit("household", 5);
  await until(() => started.includes(household));
  expect(started[0]).toBe(household);
  expect([dev, test_].map((id) => getJob(id)!.state)).toEqual(["queued", "queued"]);
  expect(getJob(dev)!.position).toBeLessThan(getJob(test_)!.position!);
});
