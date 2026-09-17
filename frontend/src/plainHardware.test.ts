import { expect, test } from "bun:test";
import { plainHardware } from "@/lib/plainHardware";

test("describes Apple silicon hardware in a person's words", () => {
  expect(plainHardware({ platform: "darwin", arch: "arm64", totalRamGb: 24, cpuCount: 10, isAppleSilicon: true, unifiedMemoryGb: 24, cudaDevices: [], freeDiskBytes: 153 * 1_073_741_824, osVersion: "24.6.0" })).toBe("Apple silicon Mac, 24 GB of memory, 153 GB free");
});

test("maps non-Apple platforms without exposing probe fields", () => {
  expect(plainHardware({ platform: "linux", arch: "x64", totalRamGb: 32, cpuCount: 8, isAppleSilicon: false, unifiedMemoryGb: 0, cudaDevices: [], freeDiskBytes: 42 * 1_073_741_824, osVersion: "6.8" })).toBe("Linux computer, 32 GB of memory, 42 GB free");
});
