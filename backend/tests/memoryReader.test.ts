import { afterEach, expect, test } from "bun:test";
import os from "node:os";
import { getMemoryReader, __setMemoryReaderForTests } from "@/lib/memory";
import { scriptedMemoryReader } from "@/lib/memory/scripted";
import { processMemoryFromRusage } from "@/lib/memory/darwin";
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
  expect(reader.processMemoryBytes(process.pid)).toBeGreaterThan(1_048_576);
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

test("macOS process memory counts the weights llama-server maps, not the footprint alone", () => {
  // The live 8B chat engine (Qwen3-8B Q4_K_M, context 40,960) on
  // 2026-10-06, one proc_pid_rusage read: the footprint the governor
  // recorded misses the 4.7 GiB GGUF the engine maps.
  expect(processMemoryFromRusage({ residentBytes: 8_382_824_448, footprintBytes: 3_495_172_816 })).toBe(8_382_824_448);
  // Pages the kernel compressed leave the resident size but stay in the
  // footprint: the larger figure is still the process's cost.
  expect(processMemoryFromRusage({ residentBytes: 1_000_000_000, footprintBytes: 2_500_000_000 })).toBe(2_500_000_000);
  expect(processMemoryFromRusage({ residentBytes: 0, footprintBytes: 0 })).toBeNull();
});

test("the Darwin reader's process memory is at least the process's own resident set", () => {
  if (process.platform !== "darwin") return;
  __setMemoryReaderForTests(null);
  const out = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(process.pid)]).stdout.toString().trim();
  const psBytes = Number(out) * 1024;
  const measured = getMemoryReader().processMemoryBytes(process.pid)!;
  // ps and the probe are two reads a moment apart; a quarter of slack
  // covers this test process's own allocation between them.
  expect(measured).toBeGreaterThan(psBytes * 0.75);
});
