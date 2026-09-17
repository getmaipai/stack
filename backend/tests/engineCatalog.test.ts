import { describe, expect, test } from "bun:test";
import { ENGINE_BINARIES, selectEngineBinary } from "@/lib/engineCatalog";
import type { HardwareInfo } from "@/lib/hardware";

function hw(overrides: Partial<HardwareInfo>): HardwareInfo {
  return {
    platform: "darwin",
    arch: "arm64",
    totalRamGb: 24,
    cpuCount: 8,
    isAppleSilicon: true,
    unifiedMemoryGb: 24,
    cudaDevices: [],
    freeDiskBytes: 100,
    osVersion: "test",
    ...overrides,
  };
}

describe("selectEngineBinary", () => {
  test("every pin is a real, distinct id", () => {
    const ids = ENGINE_BINARIES.map((pin) => pin.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("macOS arm64 matches the verified pin", () => {
    const result = selectEngineBinary(hw({}));
    expect(result?.id).toBe("llama-server-b10797-macos-arm64");
    expect(result?.verified).toBe(true);
  });

  test("Windows x64 without NVIDIA matches nothing", () => {
    expect(selectEngineBinary(hw({ platform: "win32", arch: "x64", isAppleSilicon: false, unifiedMemoryGb: 0 }))).toBeNull();
  });

  test("Windows x64 with NVIDIA matches the unverified CUDA pin", () => {
    const result = selectEngineBinary(hw({ platform: "win32", arch: "x64", isAppleSilicon: false, unifiedMemoryGb: 0, cudaDevices: [{ index: 0, name: "RTX 2070 Super", vramBytes: 8_000_000_000 }] }));
    expect(result?.id).toBe("llama-server-b10797-win-cuda-x64");
    expect(result?.verified).toBe(false);
  });

  test("a platform with no pinned build returns null", () => {
    expect(selectEngineBinary(hw({ platform: "linux", arch: "x64" }))).toBeNull();
  });

  test("every pin has valid checksums", () => {
    for (const pin of ENGINE_BINARIES) {
      expect(pin.archive.sha256).toMatch(/^[a-f0-9]{64}$/);
      for (const extra of pin.extraArchives ?? []) expect(extra.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
