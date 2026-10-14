// The Stack's hardware probe is core's, bound to this product's data
// directory so free disk is measured where models actually land.
import { detectHardware as probe, primaryBudgetBytes as corePrimaryBudgetBytes } from "@maipai/core/src/hardware";
import type { HardwareInfo, CudaDevice } from "@maipai/core/src/hardware";
import { dataDir } from "@/lib/paths";

export type { HardwareInfo, CudaDevice };
/** AI sizing memory: unified memory on Apple silicon, otherwise the sum of
 * total graphics memory across supported CUDA devices. System RAM remains a
 * separate reported hardware fact. */
export function primaryBudgetBytes(hw: HardwareInfo): number {
  if (hw.isAppleSilicon) return corePrimaryBudgetBytes(hw);
  return hw.cudaDevices.reduce((total, device) => total + device.vramBytes, 0);
}
export function detectHardware(): Promise<HardwareInfo> { return probe({ diskPath: dataDir }); }
export { __resetHardwareCacheForTests } from "@maipai/core/src/hardware";
