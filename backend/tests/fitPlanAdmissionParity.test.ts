import { afterEach, beforeEach, expect, test } from "bun:test";
import { buildFitPlan, type GgufEstimate } from "@/lib/fitPlan";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, admit, getGovernorStatus } from "@/lib/governor";

const GB = 1024 ** 3;
const estimate: GgufEstimate = { architecture: "qwen3", expertCount: 0, name: "parity", contextTokens: 4096, fullOffloaded: true, ramUmaBytes: 0, ramNonumaBytes: GB, vramUmaBytes: 0, vramNonumaBytes: GB };

beforeEach(() => {
  __resetGovernorForTests();
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 32 * GB, freeMemoryBytes: 24 * GB, tier: "p32" });
});
afterEach(() => __resetGovernorForTests());

test("capacity no is never admitted, and yes is admitted with ample free memory", async () => {
  const other = await admit({ id: "stt", kind: "resident", requestedBytes: GB, measuredPeakBytes: GB });
  expect("id" in other).toBe(true);
  const status = getGovernorStatus();
  const plan = buildFitPlan({
    modelId: "parity", contextTokens: 4096, kvCacheType: "f16", estimate,
    unifiedMemory: true, deviceBudgetsBytes: [], capBytes: status.capBytes,
    workingMarginBytes: status.marginBytes,
    loaded: status.loaded.map((item) => ({ role: item.id, kind: item.kind, peakBytes: item.peakBytes, measured: item.measured })),
    asOf: "2026-09-30", tool: { name: "test", version: "test" },
  });
  expect(plan.verdict).toBe("yes");
  const admitted = await admit({ id: "chat", kind: "resident", requestedBytes: plan.roles[0]!.peak.high! });
  expect("id" in admitted).toBe(true);

  __resetGovernorForTests();
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 32 * GB, freeMemoryBytes: 100 * GB, tier: "p32" });
  const cap = getGovernorStatus().capBytes;
  const planPeak = estimate.vramNonumaBytes + estimate.ramUmaBytes;
  const resident = await admit({ id: "stt", kind: "resident", requestedBytes: cap - planPeak + 1, measuredPeakBytes: cap - planPeak + 1 });
  expect("id" in resident).toBe(true);
  const capacity = getGovernorStatus();
  const capacityPlan = buildFitPlan({
    modelId: "parity", contextTokens: 4096, kvCacheType: "f16", estimate,
    unifiedMemory: true, deviceBudgetsBytes: [], capBytes: capacity.capBytes,
    workingMarginBytes: capacity.marginBytes,
    loaded: capacity.loaded.map((item) => ({ role: item.id, kind: item.kind, peakBytes: item.peakBytes, measured: item.measured })),
    asOf: "2026-09-30", tool: { name: "test", version: "test" },
  });
  expect(capacityPlan.verdict).toBe("no");
  const queued = await admit({ id: "chat", kind: "resident", requestedBytes: capacityPlan.roles[0]!.peak.high! });
  expect(queued).toMatchObject({ queued: true });
});
