import { afterEach, expect, test } from "bun:test";
import os from "node:os";
import { getMemoryReader, __setMemoryReaderForTests } from "@/lib/memory";
import { scriptedMemoryReader } from "@/lib/memory/scripted";
import type { MemorySnapshot } from "@/lib/memory/types";

const restoreScriptedDefault = () => __setMemoryReaderForTests(scriptedMemoryReader([{ totalBytes: 128 * 1_073_741_824, freeBytes: 64 * 1_073_741_824, availablePercent: 50, pressure: "normal", degraded: false }]));

// This file exercises the real platform reader (not the suite's scripted
// default in tests/preload.ts), so every test that opts out restores it
// afterward; a later test file in this same process must not depend on the
// host.
afterEach(restoreScriptedDefault);

test("the Darwin reader agrees with the kernel on total memory and own footprint", () => {
  if (process.platform !== "darwin") return;
  __setMemoryReaderForTests(null);
  const reader = getMemoryReader();
  const reading = reader.read();
  expect(reading.totalBytes).toBe(os.totalmem());
  expect(reading.availablePercent).toBeGreaterThanOrEqual(0);
  expect(reading.availablePercent).toBeLessThanOrEqual(100);
  expect(reading.freeBytes).toBeGreaterThan(0);
  expect(reading.degraded).toBe(false);
  expect(reader.processFootprint(process.pid)).toBeGreaterThan(1_048_576);
});

test("a scripted reader repeats a degraded reading until the next good one", () => {
  const good: MemorySnapshot = { totalBytes: 32 * 1_073_741_824, availablePercent: 40, pressure: "normal", freeBytes: 12 * 1_073_741_824, degraded: false };
  const reader = scriptedMemoryReader([good, { probeError: "The probe failed on purpose." }, { probeError: "The probe failed on purpose." }, good]);
  expect(reader.read()).toMatchObject({ freeBytes: good.freeBytes, degraded: false });
  expect(reader.read()).toMatchObject({ freeBytes: good.freeBytes, degraded: true, probeError: "The probe failed on purpose." });
  expect(reader.read()).toMatchObject({ freeBytes: good.freeBytes, degraded: true, probeError: "The probe failed on purpose." });
  expect(reader.read()).toMatchObject({ freeBytes: good.freeBytes, degraded: false });
});

test("a degraded reading before any success reports all memory free, never zero", () => {
  const reader = scriptedMemoryReader([{ probeError: "The probe failed before anything was read." }]);
  const reading = reader.read();
  expect(reading.degraded).toBe(true);
  expect(reading.freeBytes).toBe(os.totalmem());
  expect(reading.totalBytes).toBe(os.totalmem());
  expect(reading.probeError).toBe("The probe failed before anything was read.");
});
