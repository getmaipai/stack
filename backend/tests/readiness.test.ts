import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetHealthForTests, list as listHealth } from "@/lib/health";
import { __resetReadinessForTests, latestCheck, runCheck } from "@/lib/readiness";
import { scriptedMemoryReader } from "@/lib/memory/scripted";
import { getProcess, resetSupervisorForTests, scriptedProcess, setSupervisorFactoryForTests } from "@/lib/supervisor";

beforeEach(() => { __resetHealthForTests(); __resetReadinessForTests(); setSupervisorFactoryForTests(async (role) => scriptedProcess(role)); });
afterEach(() => { setSupervisorFactoryForTests(null); resetSupervisorForTests(); });

test("a ready chat role answers the smallest real request and the run is ok", async () => {
  await getProcess("chat");
  const run = await runCheck({ roleIds: ["chat"] });
  expect(run.ok).toBe(true);
  expect(run.results).toEqual([expect.objectContaining({ role: "chat", ok: true })]);
  expect(latestCheck()?.at).toBe(run.at);
  const response = await app.request("/stack/v1/check/latest");
  expect((await response.json() as { latest: { ok: boolean } }).latest.ok).toBe(true);
});

test("a skipped role never makes the check green on its own, and a failed role becomes a health item with a fix", async () => {
  // The wake word is installed, never served, so it has no probe.
  const skippedOnly = await runCheck({ roleIds: ["wakeword"] });
  expect(skippedOnly.ok).toBe(false);
  expect(skippedOnly.results[0]).toMatchObject({ role: "wakeword", skipped: true });
  const failed = await runCheck({ roleIds: ["chat"], requestRole: async () => ({ status: 503, reason: "The engine is out of memory." }) });
  expect(failed.ok).toBe(false);
  const item = listHealth().find((candidate) => candidate.code === "check-role.chat");
  expect(item?.fix).toEqual({ label: "Free memory", action: "free_memory" });
  const passed = await runCheck({ roleIds: ["chat"], requestRole: async () => ({ status: 200 }) });
  expect(passed.ok).toBe(true);
  expect(listHealth().find((candidate) => candidate.code === "check-role.chat")).toBeUndefined();
});

test("the fit-together pass fails when critical pressure arrives while a generator runs", async () => {
  const reader = scriptedMemoryReader([
    { totalBytes: 16 * 1024 ** 3, availablePercent: 50, pressure: "normal", freeBytes: 8 * 1024 ** 3, degraded: false },
    { totalBytes: 16 * 1024 ** 3, availablePercent: 2, pressure: "critical", freeBytes: 128 * 1024 ** 2, degraded: false },
  ]);
  const run = await runCheck({ roleIds: ["chat"], requestRole: async () => ({ status: 200 }), memoryReader: reader, sampleMs: 5, fitGenerator: () => new Promise((resolve) => setTimeout(resolve, 30)) });
  expect(run.fitTogether).toMatchObject({ ok: false });
  expect(run.ok).toBe(false);
  expect(listHealth().find((candidate) => candidate.code === "check-fit-together")?.severity).toBe("critical");
});

test("nothing installed is an honest empty run, not a green one", async () => {
  const run = await runCheck({ roleIds: [] });
  expect(run.ok).toBe(false);
  expect(run.reason).toMatch(/Nothing to check/);
});
