import { expect, test } from "bun:test";
import { PROFILE_TIERS, proposeProfile, type RoleId } from "@/profiles";
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

test("proposes each Apple Silicon tier at its threshold", () => {
  expect(proposeProfile(hw({ unifiedMemoryGb: 16 }))?.id).toBe("p16");
  expect(proposeProfile(hw({ unifiedMemoryGb: 32 }))?.id).toBe("p32");
  expect(proposeProfile(hw({ unifiedMemoryGb: 64 }))?.id).toBe("p64");
  expect(proposeProfile(hw({ unifiedMemoryGb: 128 }))?.id).toBe("p128");
});

test("proposes CUDA tiers from free VRAM", () => {
  const cuda = (freeGb: number): HardwareInfo => hw({
    isAppleSilicon: false,
    unifiedMemoryGb: 0,
    cudaDevices: [{ index: 0, name: "test", vramBytes: freeGb * 1_073_741_824 }],
  });
  expect(proposeProfile(cuda(8))?.id).toBe("p16");
  expect(proposeProfile(cuda(24))?.id).toBe("p64");
});

test("does not propose a profile for CPU-only hardware", () => {
  expect(proposeProfile(hw({ isAppleSilicon: false }))).toBeNull();
});

test("each tier's role lists are disjoint and cover every role", () => {
  const roles: RoleId[] = ["chat", "coding", "judge", "router", "embed", "rerank", "vision", "stt", "tts", "wakeword", "image", "video", "music"];
  for (const tier of PROFILE_TIERS) {
    const all = [...tier.resident, ...tier.onDemand, ...tier.notAvailable];
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(all)).toEqual(new Set(roles));
  }
});
