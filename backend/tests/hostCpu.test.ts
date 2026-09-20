import { afterEach, expect, test } from "bun:test";
import { __resetHostCpuForTests, __setHostCpuReaderForTests, hostCpuPercent } from "@/lib/hostCpu";

afterEach(() => {
  __resetHostCpuForTests();
});

test("the first reading has no earlier snapshot to take a delta against, so it is null", () => {
  __setHostCpuReaderForTests(() => ({ idle: 1000, total: 2000 }));
  expect(hostCpuPercent()).toBe(null);
});

test("two scripted snapshots give the expected host-wide percent", () => {
  let snapshot = { idle: 8000, total: 10000 };
  __setHostCpuReaderForTests(() => snapshot);
  expect(hostCpuPercent()).toBe(null);
  // Over the next tick, 500 of 1000 new total ticks were idle: 50% busy.
  snapshot = { idle: 8500, total: 11000 };
  expect(hostCpuPercent()).toBe(50);
});

test("a non-positive total delta is null, never a fabricated reading", () => {
  let snapshot = { idle: 1000, total: 1000 };
  __setHostCpuReaderForTests(() => snapshot);
  hostCpuPercent();
  snapshot = { idle: 1000, total: 900 };
  expect(hostCpuPercent()).toBe(null);
});
