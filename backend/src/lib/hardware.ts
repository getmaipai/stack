// The Stack's hardware probe is core's, bound to this product's data
// directory so free disk is measured where models actually land.
import { detectHardware as probe, primaryBudgetBytes } from "@maipai/core/src/hardware";
import type { HardwareInfo, CudaDevice } from "@maipai/core/src/hardware";
import { dataDir } from "@/lib/paths";

export type { HardwareInfo, CudaDevice };
export { primaryBudgetBytes };
export function detectHardware(): Promise<HardwareInfo> { return probe({ diskPath: dataDir }); }
export { __resetHardwareCacheForTests } from "@maipai/core/src/hardware";
