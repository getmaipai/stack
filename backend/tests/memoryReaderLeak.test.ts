import { expect, test } from "bun:test";
import { getMemoryReader, __setMemoryReaderForTests } from "@/lib/memory";
import { scriptedMemoryReader } from "@/lib/memory/scripted";
import { GOVERNOR_MEMORY_DEFAULT } from "./governorMemoryDefault";

// Guard for tests/preload.ts: a test that stubs the memory reader and does
// not restore it must not reach the next test (2026-10-17: routes.test.ts
// left an empty script, and ttsEngines.test.ts then saw a fixed 8 GB host).
// The first test leaves the reader stubbed on purpose; the second must see
// the suite default again. If the preload afterEach is removed, the second
// test fails by name.

test("leak canary: this test leaves the memory reader stubbed at 8 GB", () => {
  __setMemoryReaderForTests(scriptedMemoryReader([{ totalBytes: 8 * 1_073_741_824, freeBytes: 8 * 1_073_741_824, availablePercent: 100, pressure: "normal", degraded: false }]));
  expect(getMemoryReader().read().totalBytes).toBe(8 * 1_073_741_824);
});

test("the preload restores the suite memory default after a test that left the reader stubbed", () => {
  const reading = getMemoryReader().read();
  expect(reading.totalBytes).toBe(GOVERNOR_MEMORY_DEFAULT.totalBytes);
  expect(reading.freeBytes).toBe(GOVERNOR_MEMORY_DEFAULT.freeBytes);
});
