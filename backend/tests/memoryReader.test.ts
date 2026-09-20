import { afterEach, expect, test } from "bun:test";
import os from "node:os";
import { __setMemoryReaderForTests, getMemoryReader } from "@/lib/memory";
import { scriptedMemoryReader } from "@/lib/memory/scripted";
import { GOVERNOR_MEMORY_DEFAULT } from "./governorMemoryDefault";

const restoreScriptedDefault = () => __setMemoryReaderForTests(scriptedMemoryReader([GOVERNOR_MEMORY_DEFAULT]));

// This test is about the real platform reader, not the suite's scripted
// default (tests/preload.ts): opt out of it, then restore the default so
// a later test file in this same process does not depend on the host.
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
  expect(reader.processFootprint(process.pid)).toBeGreaterThan(1_048_576);
});
