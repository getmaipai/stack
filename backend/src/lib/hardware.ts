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

// ---- the Apple chip generation (CODE-STACK-01 S5a) ---------------------------------
// Core's probe does not say which Apple chip a Mac has. Splash states an M3 or newer
// as its floor, so the Stack reads the brand string once:
// `sysctl -n machdep.cpu.brand_string` says "Apple M5 Max".

export interface AppleChip { name: string; /** 1 for M1, 5 for M5 Max; null when the string is not an "Apple M<number>" chip. */ generation: number | null; }

/** "Apple M5 Max" is generation 5; anything else (an Intel Mac, an unknown future name) is null. */
export function parseAppleChip(brand: string | null | undefined): AppleChip | null {
  const name = (brand ?? "").trim();
  if (!name) return null;
  const match = /^Apple M(\d+)\b/.exec(name);
  return { name, generation: match ? Number(match[1]) : null };
}

let chipCache: Promise<AppleChip | null> | null = null;
let knownChip: AppleChip | null = null;
/** The chip as the last read found it, for the code that cannot await (the install plan, the engine choice); null until the daemon's start has read it. */
export function knownAppleChip(): AppleChip | null { return knownChip; }
export function __setAppleChipForTests(chip: AppleChip | null): void { knownChip = chip; chipCache = chip ? Promise.resolve(chip) : null; }
/** The chip of this Mac, read once (a failed read is not cached, so a later call tries again). Null off macOS. */
export function detectAppleChip(): Promise<AppleChip | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  chipCache ??= (async () => {
    try {
      const child = Bun.spawn(["sysctl", "-n", "machdep.cpu.brand_string"], { stdout: "pipe", stderr: "ignore" });
      const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      return code === 0 ? parseAppleChip(out) : null;
    } catch { return null; }
  })().then((chip) => { if (chip === null) chipCache = null; else knownChip = chip; return chip; });
  return chipCache;
}
export function __resetAppleChipForTests(): void { chipCache = null; knownChip = null; }
export { __resetHardwareCacheForTests } from "@maipai/core/src/hardware";
