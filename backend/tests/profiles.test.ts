import { expect, test } from "bun:test";
import { PROFILE_TIERS, proposeProfile } from "@/profiles";
import type { RoleId } from "@/roles";
import type { HardwareInfo } from "@/lib/hardware";

function hw(overrides: Partial<HardwareInfo>): HardwareInfo {
  return {
    platform: "darwin",
    arch: "arm64",
    totalRamGb: 16,
    cpuCount: 8,
    isAppleSilicon: true,
    unifiedMemoryGb: 16,
    cudaDevices: [],
    freeDiskBytes: 100,
    osVersion: "test",
    ...overrides,
  };
}

test("a 24 GB Apple Mac is Minimal", () => {
  expect(proposeProfile(hw({ unifiedMemoryGb: 24 }))?.level).toBe("minimal");
});

test("a 32 GB Apple Mac is Moderate", () => {
  expect(proposeProfile(hw({ unifiedMemoryGb: 32 }))?.level).toBe("moderate");
});

test("a 64 GB Apple Mac is Recommended", () => {
  expect(proposeProfile(hw({ unifiedMemoryGb: 64 }))?.level).toBe("recommended");
});

test("a two-card box with 8 GB each is Minimal", () => {
  expect(proposeProfile(hw({
    isAppleSilicon: false,
    unifiedMemoryGb: 0,
    totalRamGb: 16,
    cudaDevices: [
      { index: 0, name: "test-0", vramBytes: 8 * 1_073_741_824 },
      { index: 1, name: "test-1", vramBytes: 8 * 1_073_741_824 },
    ],
  }))?.level).toBe("minimal");
});

test("a single 8 GB card is below Minimal", () => {
  expect(proposeProfile(hw({ isAppleSilicon: false, unifiedMemoryGb: 0, totalRamGb: 16,
    cudaDevices: [{ index: 0, name: "test", vramBytes: 8 * 1_073_741_824 }] }))).toBeNull();
});

test("a 12 GB card is refused", () => {
  expect(proposeProfile(hw({ isAppleSilicon: false, unifiedMemoryGb: 0, totalRamGb: 16,
    cudaDevices: [{ index: 0, name: "test", vramBytes: 12 * 1_073_741_824 }] }))).toBeNull();
});

test("an Intel Mac or PC with no supported graphics is refused", () => {
  expect(proposeProfile(hw({ platform: "darwin", arch: "x64", isAppleSilicon: false, unifiedMemoryGb: 0 }))).toBeNull();
  expect(proposeProfile(hw({ platform: "linux", arch: "x64", isAppleSilicon: false, unifiedMemoryGb: 0 }))).toBeNull();
});

test("each tier's role lists are disjoint and cover every role", () => {
  const roles: RoleId[] = ["chat", "coding", "judge", "router", "embed", "rerank", "vision", "stt", "tts", "wakeword", "image", "video", "music"];
  for (const tier of PROFILE_TIERS) {
    const all = [...tier.resident, ...tier.onDemand, ...tier.installedOnly, ...tier.notAvailable];
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(all)).toEqual(new Set(roles));
  }
});
