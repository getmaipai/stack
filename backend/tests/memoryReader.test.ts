import { expect, test } from "bun:test";
import os from "node:os";
import { getMemoryReader } from "@/lib/memory";

test("the Darwin reader agrees with the kernel on total memory and own footprint", () => {
  if (process.platform !== "darwin") return;
  const reader = getMemoryReader();
  const reading = reader.read();
  expect(reading.totalBytes).toBe(os.totalmem());
  expect(reading.availablePercent).toBeGreaterThanOrEqual(0);
  expect(reading.availablePercent).toBeLessThanOrEqual(100);
  expect(reading.freeBytes).toBeGreaterThan(0);
  expect(reader.processFootprint(process.pid)).toBeGreaterThan(1_048_576);
});
