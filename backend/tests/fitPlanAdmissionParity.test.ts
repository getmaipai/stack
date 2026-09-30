import { afterEach, beforeEach, expect, test } from "bun:test";
import { buildFitPlan, type GgufEstimate } from "@/lib/fitPlan";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, admit, getGovernorStatus } from "@/lib/governor";

const GB = 1024 ** 3;
const estimate: GgufEstimate = { architecture: "qwen3", name: "parity", contextTokens: 4096, fullOffloaded: true, ramUmaBytes: 0, ramNonumaBytes: GB, vramUmaBytes: 0, vramNonumaBytes: GB };

beforeEach(() => {
  __resetGovernorForTests();
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 32 * GB, freeMemoryBytes: 24 * GB, tier: "p32" });
});
afterEach(() => __resetGovernorForTests());

test("fit plan and governor agree with the same available-memory inputs", async () => {
  for (const scenario of [{ free: 16 * GB, expected: "yes" }, { free: 8 * GB, expected: "no" }] as const) {
    __resetGovernorForTests();
    __setGovernorTuningForTestsOnly({ totalMemoryBytes: 32 * GB, freeMemoryBytes: 24 * GB, tier: "p32" });
    const other = await admit({ id: "stt", kind: "resident", requestedBytes: GB, measuredPeakBytes: GB });
    expect("id" in other).toBe(true);
    __setGovernorTuningForTestsOnly({ freeMemoryBytes: scenario.free });
    const status = getGovernorStatus();
    const plan = buildFitPlan({
      modelId: "parity", contextTokens: 4096, kvCacheType: "f16", estimate,
      unifiedMemory: true, deviceBudgetsBytes: [], capBytes: status.capBytes,
      workingMarginBytes: status.marginBytes, freeMemoryBytes: status.freeMemoryBytes,
      loaded: status.loaded.map((item) => ({ role: item.id, kind: item.kind, peakBytes: item.peakBytes, measured: item.measured })),
      asOf: "2026-09-30", tool: { name: "test", version: "test" },
    });
    expect(plan.verdict).toBe(scenario.expected);
    const admission = await admit({ id: "chat", kind: "resident", requestedBytes: plan.roles[0]!.peak.high! });
    if (plan.verdict === "yes") expect("id" in admission).toBe(true);
    else expect(admission).toMatchObject({ queued: true });
    __resetGovernorForTests();
  }
});
