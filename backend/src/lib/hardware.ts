// The Stack's hardware probe is core's, bound to this product's data
// directory so free disk is measured where models actually land.
import { detectHardware as probe } from "@maipai/core/src/hardware";
import type { HardwareInfo, CudaDevice } from "@maipai/core/src/hardware";
import { dataDir } from "@/lib/paths";

export type { HardwareInfo, CudaDevice };

const GIB = 1_073_741_824;

export type MemorySource = "unified" | "graphics" | "override" | "unknown";

/** Whether graphics memory is the system's own (Apple silicon, or any
 * system that reports shared graphics memory). */
export function hasUnifiedMemory(hw: HardwareInfo): boolean {
  return hw.isAppleSilicon || hw.unifiedMemoryGb > 0;
}

/** The memory a model can use, by the owner's sizing rule. With unified
 * memory it is system memory plus any graphics memory; without, it is
 * graphics memory only: every CUDA device's total VRAM, summed. When a
 * non-unified system reports no graphics memory the figure is unknown
 * (`bytes` 0) unless the person supplied their total VRAM, which then
 * stands in (`override`). The override never replaces a detected figure. */
export function sizingMemory(hw: HardwareInfo, overrideGb?: number | null): { bytes: number; source: MemorySource } {
  const vram = hw.cudaDevices.reduce((total, device) => total + device.vramBytes, 0);
  if (hasUnifiedMemory(hw)) {
    const systemGb = hw.unifiedMemoryGb > 0 ? hw.unifiedMemoryGb : hw.totalRamGb;
    return { bytes: systemGb * GIB + vram, source: "unified" };
  }
  if (vram > 0) return { bytes: vram, source: "graphics" };
  if (overrideGb && overrideGb > 0) return { bytes: overrideGb * GIB, source: "override" };
  return { bytes: 0, source: "unknown" };
}

/** AI sizing memory in bytes (0 when unknown); see `sizingMemory`. */
export function primaryBudgetBytes(hw: HardwareInfo): number {
  return sizingMemory(hw).bytes;
}
export function detectHardware(): Promise<HardwareInfo> { return probe({ diskPath: dataDir }); }
export { __resetHardwareCacheForTests } from "@maipai/core/src/hardware";
