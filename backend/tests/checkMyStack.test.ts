import { afterEach, expect, test } from "bun:test";
import { __resetHealthForTests, list as listHealth } from "@/lib/health";
import { runCheck, runFitTogetherCheck, runNightlyCheck, shouldRunNightly } from "@/lib/checkMyStack";

afterEach(() => __resetHealthForTests());

test("a failing scripted role raises its named fix and a passing rerun resolves it", async () => {
  const failed = await runCheck({ roleIds: ["chat"], requestRole: async () => ({ status: 503, reason: "Engine is offline" }) });
  expect(failed.ok).toBe(false);
  expect(listHealth()[0]).toMatchObject({ code: "check-role.chat", fix: { label: "Restart engine", action: "restart_engine" } });
  const passed = await runCheck({ roleIds: ["chat"], requestRole: async () => ({ status: 200 }) });
  expect(passed.ok).toBe(true);
  expect(listHealth()).toEqual([]);
});

test("the fit-together check fails when pressure reaches critical", async () => {
  let reads = 0;
  const result = await runFitTogetherCheck({ sampleMs: 1, memoryReader: { read: () => ({ totalBytes: 100, freeBytes: 50, availablePercent: 50, pressure: reads++ > 0 ? "critical" : "normal" }), processFootprint: () => null }, fitGenerator: async () => { await new Promise((resolve) => setTimeout(resolve, 8)); } });
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("Critical memory pressure");
});

test("nightly checks skip while the person is active", async () => {
  expect(shouldRunNightly(true)).toBe(false);
  expect(await runNightlyCheck(true)).toEqual({ skipped: true, reason: "Skipped because the person has been active in the last five minutes." });
  expect(await runNightlyCheck(undefined, {}, { secondsSinceInput: () => 299 })).toEqual({ skipped: true, reason: "Skipped because the person has been active in the last five minutes." });
  expect(shouldRunNightly(false)).toBe(true);
});
