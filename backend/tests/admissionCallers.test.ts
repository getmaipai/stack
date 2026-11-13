// Round 5: every route that submits a job tags it with the caller (the shared admissionCaller helper), so a dev or test request can never pass the household's.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("no route file calls submitJob without a caller from admissionCaller(c)", () => {
  const dir = join(import.meta.dir, "..", "src", "routes");
  const bad: string[] = [];
  let calls = 0;
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".ts"))) {
    const text = readFileSync(join(dir, name), "utf8");
    for (const match of text.matchAll(/submitJob\(\{/g)) {
      calls++;
      if (!/^submitJob\(\{\s*caller\b/.test(text.slice(match.index!, match.index! + 80))) bad.push(`${name}:${text.slice(0, match.index!).split("\n").length}`);
    }
  }
  expect(calls).toBeGreaterThan(10);
  expect(bad).toEqual([]);
});

test("a job runner's own governor requests carry its job's caller", async () => {
  const { registerJobRunner, submitJob, currentJobCaller, __resetJobsForTests, waitForJob } = await import("@/lib/jobs");
  __resetJobsForTests();
  let seen = null as string | null;
  registerJobRunner("caller-probe", async () => { seen = currentJobCaller(); return {}; }, { lane: { name: "probe", cap: 4 } });
  const submitted = submitJob({ kind: "caller-probe", caller: "dev" });
  if ("refused" in submitted) throw new Error("refused");
  await waitForJob(submitted.job.id, 2_000);
  expect(seen).toBe("dev");
  expect(currentJobCaller()).toBe("household");
  __resetJobsForTests();
});
